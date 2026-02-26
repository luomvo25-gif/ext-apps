/**
 * CesiumJS Map MCP Server
 *
 * Provides tools for:
 * - geocode: Search for places using OpenStreetMap Nominatim
 * - show-map: Display an interactive 3D globe at a given location
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from "@modelcontextprotocol/ext-apps/server";
import { randomUUID } from "crypto";

// Works both from source (server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;
const RESOURCE_URI = "ui://cesium-map/mcp-app.html";

// =============================================================================
// Command Queue (shared across stateless server instances)
// =============================================================================

/** Commands expire after this many ms if never polled */
const COMMAND_TTL_MS = 60_000; // 60 seconds

/** Periodic sweep interval to drop stale queues */
const SWEEP_INTERVAL_MS = 30_000; // 30 seconds

/** Fixed batch window: when commands are present, wait this long before returning to let more accumulate */
const POLL_BATCH_WAIT_MS = 200;

export type MapCommand =
  | {
      type: "navigate";
      west: number;
      south: number;
      east: number;
      north: number;
      label?: string;
      fly?: boolean;
    }
  | {
      type: "add_marker";
      latitude: number;
      longitude: number;
      label?: string;
      color?: string;
    };

interface QueueEntry {
  commands: MapCommand[];
  /** Timestamp of the most recent enqueue or dequeue */
  lastActivity: number;
}

const commandQueues = new Map<string, QueueEntry>();

function pruneStaleQueues(): void {
  const now = Date.now();
  for (const [uuid, entry] of commandQueues) {
    if (now - entry.lastActivity > COMMAND_TTL_MS) {
      commandQueues.delete(uuid);
    }
  }
}

// Periodic sweep so abandoned queues don't leak
setInterval(pruneStaleQueues, SWEEP_INTERVAL_MS).unref();

function enqueueCommand(viewUUID: string, command: MapCommand): void {
  let entry = commandQueues.get(viewUUID);
  if (!entry) {
    entry = { commands: [], lastActivity: Date.now() };
    commandQueues.set(viewUUID, entry);
  }
  entry.commands.push(command);
  entry.lastActivity = Date.now();
}

function dequeueCommands(viewUUID: string): MapCommand[] {
  const entry = commandQueues.get(viewUUID);
  if (!entry) return [];
  const commands = entry.commands;
  commandQueues.delete(viewUUID);
  return commands;
}

// Nominatim API response type
interface NominatimResult {
  place_id: number;
  licence: string;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  boundingbox: [string, string, string, string]; // [south, north, west, east]
  class: string;
  type: string;
  importance: number;
}

// Rate limiting for Nominatim (1 request per second per their usage policy)
let lastNominatimRequest = 0;
const NOMINATIM_RATE_LIMIT_MS = 1100; // 1.1 seconds to be safe

/**
 * Query Nominatim geocoding API with rate limiting
 */
async function geocodeWithNominatim(query: string): Promise<NominatimResult[]> {
  // Respect rate limit
  const now = Date.now();
  const timeSinceLastRequest = now - lastNominatimRequest;
  if (timeSinceLastRequest < NOMINATIM_RATE_LIMIT_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, NOMINATIM_RATE_LIMIT_MS - timeSinceLastRequest),
    );
  }
  lastNominatimRequest = Date.now();

  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "5",
  });

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    {
      headers: {
        "User-Agent":
          "MCP-CesiumMap-Example/1.0 (https://github.com/modelcontextprotocol)",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Nominatim API error: ${response.status} ${response.statusText}`,
    );
  }

  return response.json() as Promise<NominatimResult[]>;
}

/**
 * Creates a new MCP server instance with tools and resources registered.
 * Each HTTP session needs its own server instance because McpServer only supports one transport.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "CesiumJS Map Server",
    version: "1.0.0",
  });

  // CSP configuration for external tile sources
  const cspMeta = {
    ui: {
      csp: {
        // Allow fetching tiles from OSM (tiles + geocoding) and Cesium assets
        connectDomains: [
          "https://*.openstreetmap.org", // OSM tiles + Nominatim geocoding
          "https://cesium.com",
          "https://*.cesium.com",
        ],
        // Allow loading tile images, scripts, and Cesium CDN resources
        resourceDomains: [
          "https://*.openstreetmap.org", // OSM map tiles (covers tile.openstreetmap.org)
          "https://cesium.com",
          "https://*.cesium.com",
        ],
      },
    },
  };

  // Register the CesiumJS map resource with CSP for external tile sources
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      );
      return {
        contents: [
          // CSP metadata on the content item takes precedence over listing-level _meta
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: cspMeta,
          },
        ],
      };
    },
  );

  // show-map tool - displays the CesiumJS globe
  // Default bounding box: London area
  registerAppTool(
    server,
    "show-map",
    {
      title: "Show Map",
      description:
        "Display an interactive world map zoomed to a specific bounding box. Use the GeoCode tool to find the bounding box of a location.",
      inputSchema: {
        west: z
          .number()
          .optional()
          .default(-0.5)
          .describe("Western longitude (-180 to 180)"),
        south: z
          .number()
          .optional()
          .default(51.3)
          .describe("Southern latitude (-90 to 90)"),
        east: z
          .number()
          .optional()
          .default(0.3)
          .describe("Eastern longitude (-180 to 180)"),
        north: z
          .number()
          .optional()
          .default(51.7)
          .describe("Northern latitude (-90 to 90)"),
        label: z
          .string()
          .optional()
          .describe("Optional label to display on the map"),
      },
      _meta: { [RESOURCE_URI_META_KEY]: RESOURCE_URI },
    },
    async ({ west, south, east, north, label }): Promise<CallToolResult> => {
      const uuid = randomUUID();
      return {
        content: [
          {
            type: "text",
            text: `Displaying globe (viewUUID: ${uuid}) at: W:${west.toFixed(4)}, S:${south.toFixed(4)}, E:${east.toFixed(4)}, N:${north.toFixed(4)}${label ? ` (${label})` : ""}. Use the interact tool with this viewUUID to navigate, add markers, etc.`,
          },
        ],
        _meta: {
          viewUUID: uuid,
        },
      };
    },
  );

  // interact tool - send actions to an existing map view
  server.registerTool(
    "interact",
    {
      title: "Interact with Map",
      description: `Send an action to an existing map view. Actions are queued and batched.

Actions:
- navigate: Fly/jump to a bounding box. Requires \`west\`, \`south\`, \`east\`, \`north\`. Optional: \`fly\` (default true), \`label\`.
- add_marker: Add a pin. Requires \`latitude\`, \`longitude\`. Optional: \`label\`, \`color\` (CSS color, default red).`,
      inputSchema: {
        viewUUID: z
          .string()
          .describe("The viewUUID of the map (from show-map result)"),
        action: z
          .enum(["navigate", "add_marker"])
          .describe("Action to perform"),
        west: z
          .number()
          .optional()
          .describe("Western longitude, -180 to 180 (for navigate)"),
        south: z
          .number()
          .optional()
          .describe("Southern latitude, -90 to 90 (for navigate)"),
        east: z
          .number()
          .optional()
          .describe("Eastern longitude, -180 to 180 (for navigate)"),
        north: z
          .number()
          .optional()
          .describe("Northern latitude, -90 to 90 (for navigate)"),
        fly: z
          .boolean()
          .optional()
          .default(true)
          .describe("Animate camera flight (for navigate, default true)"),
        latitude: z
          .number()
          .optional()
          .describe("Latitude, -90 to 90 (for add_marker)"),
        longitude: z
          .number()
          .optional()
          .describe("Longitude, -180 to 180 (for add_marker)"),
        label: z
          .string()
          .optional()
          .describe("Label text (for navigate or add_marker)"),
        color: z
          .string()
          .optional()
          .describe(
            'Marker color as CSS color, e.g. "red", "#ff0000" (for add_marker)',
          ),
      },
    },
    async ({
      viewUUID: uuid,
      action,
      west,
      south,
      east,
      north,
      fly,
      latitude,
      longitude,
      label,
      color,
    }): Promise<CallToolResult> => {
      let description: string;
      switch (action) {
        case "navigate":
          if (west == null || south == null || east == null || north == null)
            return {
              content: [
                {
                  type: "text",
                  text: "navigate requires `west`, `south`, `east`, `north`",
                },
              ],
              isError: true,
            };
          enqueueCommand(uuid, {
            type: "navigate",
            west,
            south,
            east,
            north,
            label,
            fly,
          });
          description = `navigate to W:${west.toFixed(4)}, S:${south.toFixed(4)}, E:${east.toFixed(4)}, N:${north.toFixed(4)}${label ? ` (${label})` : ""}`;
          break;
        case "add_marker":
          if (latitude == null || longitude == null)
            return {
              content: [
                {
                  type: "text",
                  text: "add_marker requires `latitude`, `longitude`",
                },
              ],
              isError: true,
            };
          enqueueCommand(uuid, {
            type: "add_marker",
            latitude,
            longitude,
            label,
            color,
          });
          description = `marker at ${latitude.toFixed(4)}, ${longitude.toFixed(4)}${label ? ` (${label})` : ""}`;
          break;
        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            isError: true,
          };
      }
      return {
        content: [{ type: "text", text: `Queued: ${description}` }],
      };
    },
  );

  // poll_map_commands - app-only tool for polling pending commands
  registerAppTool(
    server,
    "poll_map_commands",
    {
      title: "Poll Map Commands",
      description: "Poll for pending commands for a map view",
      inputSchema: {
        viewUUID: z.string().describe("The viewUUID of the map"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ viewUUID: uuid }): Promise<CallToolResult> => {
      // If commands are queued, wait a fixed window to let more accumulate
      if (commandQueues.has(uuid)) {
        await new Promise((r) => setTimeout(r, POLL_BATCH_WAIT_MS));
      }
      const commands = dequeueCommands(uuid);
      return {
        content: [{ type: "text", text: `${commands.length} command(s)` }],
        structuredContent: { commands },
      };
    },
  );

  // geocode tool - searches for places using Nominatim (no UI)
  server.registerTool(
    "geocode",
    {
      title: "Geocode",
      description:
        "Search for places using OpenStreetMap. Returns coordinates and bounding boxes for up to 5 matches.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Place name or address to search for (e.g., 'Paris', 'Golden Gate Bridge', '1600 Pennsylvania Ave')",
          ),
      },
    },
    async ({ query }): Promise<CallToolResult> => {
      try {
        const results = await geocodeWithNominatim(query);

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: `No results found for "${query}"` },
            ],
          };
        }

        const formattedResults = results.map((r) => ({
          displayName: r.display_name,
          lat: parseFloat(r.lat),
          lon: parseFloat(r.lon),
          boundingBox: {
            south: parseFloat(r.boundingbox[0]),
            north: parseFloat(r.boundingbox[1]),
            west: parseFloat(r.boundingbox[2]),
            east: parseFloat(r.boundingbox[3]),
          },
          type: r.type,
          importance: r.importance,
        }));

        const textContent = formattedResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.displayName}\n   Coordinates: ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}\n   Bounding box: W:${r.boundingBox.west.toFixed(4)}, S:${r.boundingBox.south.toFixed(4)}, E:${r.boundingBox.east.toFixed(4)}, N:${r.boundingBox.north.toFixed(4)}`,
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text: textContent }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Geocoding error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
