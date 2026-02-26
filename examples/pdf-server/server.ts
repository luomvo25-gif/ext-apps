/**
 * PDF MCP Server
 *
 * An MCP server that displays PDFs in an interactive viewer.
 * Supports local files and remote HTTPS URLs.
 *
 * Tools:
 * - list_pdfs: List available PDFs
 * - display_pdf: Show interactive PDF viewer
 * - read_pdf_bytes: Stream PDF data in chunks (used by viewer)
 */

import { randomUUID } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import {
  RootsListChangedNotificationSchema,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
// Use the legacy build to avoid DOMMatrix dependency in Node.js
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PrimitiveSchemaDefinition,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// =============================================================================
// Configuration
// =============================================================================

export const DEFAULT_PDF = "https://arxiv.org/pdf/1706.03762"; // Attention Is All You Need
export const MAX_CHUNK_BYTES = 512 * 1024; // 512KB max per request
export const RESOURCE_URI = "ui://pdf-viewer/mcp-app.html";

/** Inactivity timeout: clear cache entry if not accessed for this long */
export const CACHE_INACTIVITY_TIMEOUT_MS = 10_000; // 10 seconds

/** Max lifetime: clear cache entry after this time regardless of access */
export const CACHE_MAX_LIFETIME_MS = 60_000; // 60 seconds

/** Max size for cached PDFs (defensive limit to prevent memory exhaustion) */
export const CACHE_MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

/** Allowed local file paths (populated from CLI args) */
export const allowedLocalFiles = new Set<string>();

/** Allowed local directories (populated from MCP roots) */
export const allowedLocalDirs = new Set<string>();

// Works both from source (server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

// =============================================================================
// Command Queue (shared across stateless server instances)
// =============================================================================

/** Commands expire after this many ms if never polled */
const COMMAND_TTL_MS = 60_000; // 60 seconds

/** Periodic sweep interval to drop stale queues */
const SWEEP_INTERVAL_MS = 30_000; // 30 seconds

/** Fixed batch window: when commands are present, wait this long before returning to let more accumulate */
const POLL_BATCH_WAIT_MS = 200;
const LONG_POLL_TIMEOUT_MS = 30_000; // Max time to hold a long-poll request open

// =============================================================================
// Annotation Types
// =============================================================================

/** Rectangle in PDF coordinate space (bottom-left origin, in PDF points) */
const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const StampLabel = z.enum([
  "APPROVED",
  "DRAFT",
  "CONFIDENTIAL",
  "FINAL",
  "VOID",
  "REJECTED",
]);

const AnnotationBase = z.object({
  id: z.string(),
  page: z.number().min(1),
});

const HighlightAnnotation = AnnotationBase.extend({
  type: z.literal("highlight"),
  rects: z.array(RectSchema).min(1),
  color: z.string().optional(),
  content: z.string().optional(),
});

const UnderlineAnnotation = AnnotationBase.extend({
  type: z.literal("underline"),
  rects: z.array(RectSchema).min(1),
  color: z.string().optional(),
});

const StrikethroughAnnotation = AnnotationBase.extend({
  type: z.literal("strikethrough"),
  rects: z.array(RectSchema).min(1),
  color: z.string().optional(),
});

const NoteAnnotation = AnnotationBase.extend({
  type: z.literal("note"),
  x: z.number(),
  y: z.number(),
  content: z.string(),
  color: z.string().optional(),
});

const RectangleAnnotation = AnnotationBase.extend({
  type: z.literal("rectangle"),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  color: z.string().optional(),
  fillColor: z.string().optional(),
});

const FreetextAnnotation = AnnotationBase.extend({
  type: z.literal("freetext"),
  x: z.number(),
  y: z.number(),
  content: z.string(),
  fontSize: z.number().optional(),
  color: z.string().optional(),
});

const StampAnnotation = AnnotationBase.extend({
  type: z.literal("stamp"),
  x: z.number(),
  y: z.number(),
  label: StampLabel,
  color: z.string().optional(),
  rotation: z.number().optional(),
});

const PdfAnnotationDef = z.discriminatedUnion("type", [
  HighlightAnnotation,
  UnderlineAnnotation,
  StrikethroughAnnotation,
  NoteAnnotation,
  RectangleAnnotation,
  FreetextAnnotation,
  StampAnnotation,
]);

/** Partial annotation update — id + type required, rest optional */
const PdfAnnotationUpdate = z.union([
  HighlightAnnotation.partial().required({ id: true, type: true }),
  UnderlineAnnotation.partial().required({ id: true, type: true }),
  StrikethroughAnnotation.partial().required({ id: true, type: true }),
  NoteAnnotation.partial().required({ id: true, type: true }),
  RectangleAnnotation.partial().required({ id: true, type: true }),
  FreetextAnnotation.partial().required({ id: true, type: true }),
  StampAnnotation.partial().required({ id: true, type: true }),
]);

const FormField = z.object({
  name: z.string(),
  value: z.union([z.string(), z.boolean()]),
});

const PageInterval = z.object({
  start: z.number().min(1).optional(),
  end: z.number().min(1).optional(),
});

// =============================================================================
// Command Queue (shared across stateless server instances)
// =============================================================================

export type PdfCommand =
  | { type: "navigate"; page: number }
  | { type: "search"; query: string }
  | { type: "find"; query: string }
  | { type: "search_navigate"; matchIndex: number }
  | { type: "zoom"; scale: number }
  | {
      type: "add_annotations";
      annotations: z.infer<typeof PdfAnnotationDef>[];
    }
  | {
      type: "update_annotations";
      annotations: z.infer<typeof PdfAnnotationUpdate>[];
    }
  | { type: "remove_annotations"; ids: string[] }
  | {
      type: "highlight_text";
      id: string;
      query: string;
      page?: number;
      color?: string;
      content?: string;
    }
  | {
      type: "fill_form";
      fields: z.infer<typeof FormField>[];
    }
  | {
      type: "get_pages";
      requestId: string;
      intervals: Array<{ start?: number; end?: number }>;
      getText: boolean;
      getScreenshots: boolean;
    };

// =============================================================================
// Pending get_pages Requests (request-response bridge via client)
// =============================================================================

const GET_PAGES_TIMEOUT_MS = 60_000; // 60s — rendering many pages can be slow

interface PageDataEntry {
  page: number;
  text?: string;
  image?: string; // base64 PNG
}

interface PendingPageRequest {
  resolve: (data: PageDataEntry[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingPageRequests = new Map<string, PendingPageRequest>();

/** Wait for the client to render and submit page data for a given request. */
function waitForPageData(requestId: string): Promise<PageDataEntry[]> {
  return new Promise<PageDataEntry[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPageRequests.delete(requestId);
      reject(new Error("Timeout waiting for page data from viewer"));
    }, GET_PAGES_TIMEOUT_MS);
    pendingPageRequests.set(requestId, { resolve, reject, timer });
  });
}

interface QueueEntry {
  commands: PdfCommand[];
  /** Timestamp of the most recent enqueue or dequeue */
  lastActivity: number;
}

const commandQueues = new Map<string, QueueEntry>();

/** Waiters for long-poll: resolve callback wakes up a blocked poll_pdf_commands */
const pollWaiters = new Map<string, () => void>();

/** Valid form field names per viewer UUID (populated during display_pdf) */
const viewFieldNames = new Map<string, Set<string>>();

function pruneStaleQueues(): void {
  const now = Date.now();
  for (const [uuid, entry] of commandQueues) {
    if (now - entry.lastActivity > COMMAND_TTL_MS) {
      commandQueues.delete(uuid);
      viewFieldNames.delete(uuid);
    }
  }
  // Clean up empty queues with no active pollers
  for (const [uuid, entry] of commandQueues) {
    if (entry.commands.length === 0 && !pollWaiters.has(uuid)) {
      commandQueues.delete(uuid);
    }
  }
}

// Periodic sweep so abandoned queues don't leak
setInterval(pruneStaleQueues, SWEEP_INTERVAL_MS).unref();

function enqueueCommand(viewUUID: string, command: PdfCommand): void {
  let entry = commandQueues.get(viewUUID);
  if (!entry) {
    entry = { commands: [], lastActivity: Date.now() };
    commandQueues.set(viewUUID, entry);
  }
  entry.commands.push(command);
  entry.lastActivity = Date.now();

  // Wake up any long-polling request waiting for this viewUUID
  const waiter = pollWaiters.get(viewUUID);
  if (waiter) {
    pollWaiters.delete(viewUUID);
    waiter();
  }
}

function dequeueCommands(viewUUID: string): PdfCommand[] {
  const entry = commandQueues.get(viewUUID);
  if (!entry) return [];
  const commands = entry.commands;
  commandQueues.delete(viewUUID);
  return commands;
}

// =============================================================================
// URL Validation & Normalization
// =============================================================================

export function isFileUrl(url: string): boolean {
  return url.startsWith("file://") || url.startsWith("computer://");
}

export function isArxivUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "arxiv.org" || parsed.hostname === "www.arxiv.org"
    );
  } catch {
    return false;
  }
}

export function normalizeArxivUrl(url: string): string {
  // Convert arxiv abstract URLs to PDF URLs
  // https://arxiv.org/abs/1706.03762 -> https://arxiv.org/pdf/1706.03762
  return url.replace("/abs/", "/pdf/").replace(/\.pdf$/, "");
}

export function fileUrlToPath(fileUrl: string): string {
  // Support both file:// and computer:// (used by some clients for local files)
  return decodeURIComponent(fileUrl.replace(/^(?:file|computer):\/\//, ""));
}

export function pathToFileUrl(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  return `file://${encodeURIComponent(absolutePath).replace(/%2F/g, "/")}`;
}

/**
 * Check if `dir` is an ancestor of `filePath` using path.relative,
 * which is more robust than string prefix matching (handles normalization).
 */
export function isAncestorDir(dir: string, filePath: string): boolean {
  const rel = path.relative(dir, filePath);
  // Must be non-empty (not the dir itself when checking files),
  // must not start with ".." (escaping), and must not be absolute (different root).
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Check if `url` looks like an absolute local file path (not a URL scheme).
 * Handles Unix paths (/...), home-relative (~), and Windows drive letters (C:\...).
 */
function isLocalPath(url: string): boolean {
  return (
    url.startsWith("/") || url.startsWith("~") || /^[A-Za-z]:[/\\]/.test(url)
  );
}

export function validateUrl(url: string): {
  valid: boolean;
  error?: string;
} {
  if (isFileUrl(url) || isLocalPath(url)) {
    // fileUrlToPath already decodes percent-encoding; for bare paths,
    // decode here in case the client sends %20 for spaces etc.
    const filePath = isFileUrl(url)
      ? fileUrlToPath(url)
      : decodeURIComponent(url);
    const resolved = path.resolve(filePath);

    // Check exact match (CLI args / roots)
    if (allowedLocalFiles.has(resolved)) {
      if (!fs.existsSync(resolved)) {
        return { valid: false, error: `File not found: ${resolved}` };
      }
      return { valid: true };
    }

    // Check directory match (MCP roots / CLI dirs).
    // Try both the raw path and its realpath (resolves symlinks).
    let realResolved: string | undefined;
    try {
      realResolved = fs.realpathSync(resolved);
    } catch {
      // File may not exist yet at this path
    }
    if (
      [...allowedLocalDirs].some((dir) => {
        let realDir: string | undefined;
        try {
          realDir = fs.realpathSync(dir);
        } catch {
          // Dir may not exist
        }
        return (
          isAncestorDir(dir, resolved) ||
          (realResolved != null && isAncestorDir(dir, realResolved)) ||
          (realDir != null && isAncestorDir(realDir, resolved)) ||
          (realDir != null &&
            realResolved != null &&
            isAncestorDir(realDir, realResolved))
        );
      })
    ) {
      if (!fs.existsSync(resolved)) {
        return { valid: false, error: `File not found: ${resolved}` };
      }
      return { valid: true };
    }

    console.error(
      `[pdf-server] Local file not in allowed list: ${resolved}\n  Allowed dirs: ${[...allowedLocalDirs].join(", ")}`,
    );
    return {
      valid: false,
      error: `Local file not in allowed list: ${resolved}\nAllowed directories: ${[...allowedLocalDirs].join(", ")}`,
    };
  }

  // Remote URL - require HTTPS
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return { valid: false, error: `Only HTTPS URLs are allowed: ${url}` };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: `Invalid URL: ${url}` };
  }
}

// =============================================================================
// Session-Local PDF Cache
// =============================================================================

/**
 * Cache entry for remote PDFs from servers that don't support Range requests.
 * Tracks both inactivity and max lifetime for automatic cleanup.
 */
interface CacheEntry {
  /** The cached PDF data */
  data: Uint8Array;
  /** Timestamp when entry was created (for max lifetime) */
  createdAt: number;
  /** Timer that fires after CACHE_INACTIVITY_TIMEOUT_MS of no access */
  inactivityTimer: ReturnType<typeof setTimeout>;
  /** Timer that fires after CACHE_MAX_LIFETIME_MS from creation */
  maxLifetimeTimer: ReturnType<typeof setTimeout>;
}

/**
 * Session-local PDF cache utilities.
 * Each call to createPdfCache() creates an independent cache instance.
 */
export interface PdfCache {
  /** Read a range of bytes from a PDF, using cache for servers without Range support */
  readPdfRange(
    url: string,
    offset: number,
    byteCount: number,
  ): Promise<{ data: Uint8Array; totalBytes: number }>;
  /** Get current number of cached entries */
  getCacheSize(): number;
  /** Clear all cached entries and their timers */
  clearCache(): void;
}

/**
 * Creates a session-local PDF cache with automatic timeout-based cleanup.
 *
 * When a remote server returns HTTP 200 (full body) instead of 206 (partial),
 * the full response is cached so subsequent chunk requests don't re-download.
 *
 * Entries are automatically cleared after:
 * - CACHE_INACTIVITY_TIMEOUT_MS of no access (resets on each access)
 * - CACHE_MAX_LIFETIME_MS from creation (absolute timeout)
 */
export function createPdfCache(): PdfCache {
  const cache = new Map<string, CacheEntry>();

  /** Delete a cache entry and clear its timers */
  function deleteCacheEntry(url: string): void {
    const entry = cache.get(url);
    if (entry) {
      clearTimeout(entry.inactivityTimer);
      clearTimeout(entry.maxLifetimeTimer);
      cache.delete(url);
    }
  }

  /** Get cached data and refresh the inactivity timer */
  function getCacheEntry(url: string): Uint8Array | undefined {
    const entry = cache.get(url);
    if (!entry) return undefined;

    // Refresh inactivity timer on access
    clearTimeout(entry.inactivityTimer);
    entry.inactivityTimer = setTimeout(() => {
      deleteCacheEntry(url);
    }, CACHE_INACTIVITY_TIMEOUT_MS);

    return entry.data;
  }

  /** Add data to cache with both inactivity and max lifetime timers */
  function setCacheEntry(url: string, data: Uint8Array): void {
    // Clear any existing entry first
    deleteCacheEntry(url);

    const entry: CacheEntry = {
      data,
      createdAt: Date.now(),
      inactivityTimer: setTimeout(() => {
        deleteCacheEntry(url);
      }, CACHE_INACTIVITY_TIMEOUT_MS),
      maxLifetimeTimer: setTimeout(() => {
        deleteCacheEntry(url);
      }, CACHE_MAX_LIFETIME_MS),
    };

    cache.set(url, entry);
  }

  /** Slice a cached or freshly-fetched full body to the requested range. */
  function sliceToChunk(
    fullData: Uint8Array,
    offset: number,
    clampedByteCount: number,
  ): { data: Uint8Array; totalBytes: number } {
    const totalBytes = fullData.length;
    const start = Math.min(offset, totalBytes);
    const end = Math.min(start + clampedByteCount, totalBytes);
    return { data: fullData.slice(start, end), totalBytes };
  }

  async function readPdfRange(
    url: string,
    offset: number,
    byteCount: number,
  ): Promise<{ data: Uint8Array; totalBytes: number }> {
    const normalized = isArxivUrl(url) ? normalizeArxivUrl(url) : url;
    const clampedByteCount = Math.min(byteCount, MAX_CHUNK_BYTES);

    if (isFileUrl(normalized) || isLocalPath(normalized)) {
      const filePath = isFileUrl(normalized)
        ? fileUrlToPath(normalized)
        : decodeURIComponent(normalized);
      const stats = await fs.promises.stat(filePath);
      const totalBytes = stats.size;

      // Clamp to file bounds
      const start = Math.min(offset, totalBytes);
      const end = Math.min(start + clampedByteCount, totalBytes);

      if (start >= totalBytes) {
        return { data: new Uint8Array(0), totalBytes };
      }

      // Read range from local file
      const buffer = Buffer.alloc(end - start);
      const fd = await fs.promises.open(filePath, "r");
      try {
        await fd.read(buffer, 0, end - start, start);
      } finally {
        await fd.close();
      }

      return { data: new Uint8Array(buffer), totalBytes };
    }

    // Serve from cache if we previously downloaded the full body
    const cached = getCacheEntry(normalized);
    if (cached) {
      return sliceToChunk(cached, offset, clampedByteCount);
    }

    // Remote URL - try Range request, fall back to full GET if not supported
    let response = await fetch(normalized, {
      headers: {
        Range: `bytes=${offset}-${offset + clampedByteCount - 1}`,
      },
    });

    // If server doesn't support Range (501, 416, etc.), fall back to plain GET
    if (!response.ok && response.status !== 206) {
      response = await fetch(normalized);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch PDF: ${response.status} ${response.statusText}`,
        );
      }
    }

    // HTTP 200 means the server ignored our Range header and sent the full body.
    // Cache it so subsequent chunk requests don't re-download, then slice.
    if (response.status === 200) {
      // Check Content-Length header first as a preliminary size check
      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const declaredSize = parseInt(contentLength, 10);
        if (declaredSize > CACHE_MAX_PDF_SIZE_BYTES) {
          throw new Error(
            `PDF too large to cache: ${declaredSize} bytes exceeds ${CACHE_MAX_PDF_SIZE_BYTES} byte limit`,
          );
        }
      }

      const fullData = new Uint8Array(await response.arrayBuffer());

      // Check actual size (may differ from Content-Length)
      if (fullData.length > CACHE_MAX_PDF_SIZE_BYTES) {
        throw new Error(
          `PDF too large to cache: ${fullData.length} bytes exceeds ${CACHE_MAX_PDF_SIZE_BYTES} byte limit`,
        );
      }

      setCacheEntry(normalized, fullData);
      return sliceToChunk(fullData, offset, clampedByteCount);
    }

    // HTTP 206 Partial Content — parse total size from Content-Range header
    const contentRange = response.headers.get("content-range");
    let totalBytes = 0;
    if (contentRange) {
      const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
      if (match) {
        totalBytes = parseInt(match[1], 10);
      }
    }

    const data = new Uint8Array(await response.arrayBuffer());
    return { data, totalBytes };
  }

  return {
    readPdfRange,
    getCacheSize: () => cache.size,
    clearCache: () => {
      for (const url of [...cache.keys()]) {
        deleteCacheEntry(url);
      }
    },
  };
}

// =============================================================================
// MCP Roots
// =============================================================================

/**
 * Query the client for roots and update allowedLocalDirs with any file:// roots
 * that point to existing directories.
 */
async function refreshRoots(server: Server): Promise<void> {
  if (!server.getClientCapabilities()?.roots) return;

  try {
    const { roots } = await server.listRoots();
    allowedLocalDirs.clear();
    for (const root of roots) {
      if (isFileUrl(root.uri)) {
        const dir = fileUrlToPath(root.uri);
        const resolved = path.resolve(dir);
        try {
          const s = fs.statSync(resolved);
          if (s.isFile()) {
            console.error(
              `[pdf-server] Root is a file, not a directory (skipped): ${resolved}`,
            );
            allowedLocalFiles.add(resolved);
          } else if (s.isDirectory()) {
            allowedLocalDirs.add(resolved);
            console.error(`[pdf-server] Root directory allowed: ${resolved}`);
          }
        } catch {
          // stat failed — skip non-existent roots
        }
      }
    }
  } catch (err) {
    console.error(
      `[pdf-server] Failed to list roots: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// =============================================================================
// PDF Form Field Extraction
// =============================================================================

/**
 * Extract form fields from a PDF and build an elicitation schema.
 * Returns null if the PDF has no form fields.
 */
/** Shape of field objects returned by pdfjs-dist's getFieldObjects(). */
interface PdfJsFieldObject {
  type: string;
  name: string;
  editable: boolean;
  exportValues?: string;
  items?: Array<{ exportValue: string; displayValue: string }>;
}

async function extractFormSchema(
  url: string,
  readRange: (
    url: string,
    offset: number,
    byteCount: number,
  ) => Promise<{ data: Uint8Array; totalBytes: number }>,
): Promise<{
  type: "object";
  properties: Record<string, PrimitiveSchemaDefinition>;
  required?: string[];
} | null> {
  // Read full PDF bytes
  const { totalBytes } = await readRange(url, 0, 1);
  const { data } = await readRange(url, 0, totalBytes);

  const loadingTask = getDocument({ data });
  const pdfDoc = await loadingTask.promise;

  let fieldObjects: Record<string, PdfJsFieldObject[]> | null;
  try {
    fieldObjects = (await pdfDoc.getFieldObjects()) as Record<
      string,
      PdfJsFieldObject[]
    > | null;
  } catch {
    pdfDoc.destroy();
    return null;
  }
  if (!fieldObjects || Object.keys(fieldObjects).length === 0) {
    pdfDoc.destroy();
    return null;
  }

  const properties: Record<string, PrimitiveSchemaDefinition> = {};
  for (const [name, fields] of Object.entries(fieldObjects)) {
    const field = fields[0]; // first widget determines the type
    if (!field.editable) continue;

    switch (field.type) {
      case "text":
        properties[name] = { type: "string", title: name };
        break;
      case "checkbox":
        properties[name] = { type: "boolean", title: name };
        break;
      case "radiobutton": {
        const options = fields
          .map((f) => f.exportValues)
          .filter((v): v is string => !!v && v !== "Off");
        properties[name] =
          options.length > 0
            ? { type: "string", title: name, enum: options }
            : { type: "string", title: name };
        break;
      }
      case "combobox":
      case "listbox": {
        const items = field.items?.map((i) => i.exportValue).filter(Boolean);
        properties[name] =
          items && items.length > 0
            ? { type: "string", title: name, enum: items }
            : { type: "string", title: name };
        break;
      }
      // Skip "button" (push buttons) and unknown types
    }
  }

  // Collect alternativeText labels from per-page annotations
  // (getFieldObjects doesn't include them)
  const fieldLabels = new Map<string, string>();
  try {
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const annotations = await page.getAnnotations();
      for (const ann of annotations) {
        if (ann.fieldName && ann.alternativeText) {
          fieldLabels.set(ann.fieldName, ann.alternativeText);
        }
      }
    }
  } catch {
    // ignore
  }

  // Use labels as titles where available
  for (const [name, prop] of Object.entries(properties)) {
    const label = fieldLabels.get(name);
    if (label) {
      prop.title = label;
    }
  }

  // If any editable field has a mechanical name (no human-readable label),
  // elicitation would be confusing — return null to skip it.
  const hasMechanicalNames = Object.keys(properties).some((name) => {
    if (fieldLabels.has(name)) return false;
    return /[[\]().]/.test(name) || /^[A-Z0-9_]+$/.test(name);
  });

  pdfDoc.destroy();
  if (Object.keys(properties).length === 0) return null;
  if (hasMechanicalNames) return null;

  return { type: "object", properties };
}

// =============================================================================
// MCP Server Factory
// =============================================================================

export function createServer(): McpServer {
  const server = new McpServer({ name: "PDF Server", version: "2.0.0" });

  // Fetch roots on initialization and subscribe to changes
  server.server.oninitialized = () => {
    refreshRoots(server.server);
  };
  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      await refreshRoots(server.server);
    },
  );

  // Create session-local cache (isolated per server instance)
  const { readPdfRange } = createPdfCache();

  // Tool: list_pdfs - List available PDFs
  server.tool(
    "list_pdfs",
    "List available PDFs that can be displayed",
    {},
    async (): Promise<CallToolResult> => {
      const pdfs: Array<{ url: string; type: "local" | "remote" }> = [];

      // Add local files
      for (const filePath of allowedLocalFiles) {
        pdfs.push({ url: pathToFileUrl(filePath), type: "local" });
      }

      // Build text
      const parts: string[] = [];
      if (pdfs.length > 0) {
        parts.push(
          `Available PDFs:\n${pdfs.map((p) => `- ${p.url} (${p.type})`).join("\n")}`,
        );
      }
      if (allowedLocalDirs.size > 0) {
        parts.push(
          `Allowed local directories (from client roots):\n${[...allowedLocalDirs].map((d) => `- ${d}`).join("\n")}\nAny PDF file under these directories can be displayed.`,
        );
      }
      parts.push(
        `Any remote PDF accessible via HTTPS can also be loaded dynamically.`,
      );

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        structuredContent: {
          localFiles: pdfs.filter((p) => p.type === "local").map((p) => p.url),
          allowedDirectories: [...allowedLocalDirs],
        },
      };
    },
  );

  // Tool: read_pdf_bytes (app-only) - Range request for chunks
  registerAppTool(
    server,
    "read_pdf_bytes",
    {
      title: "Read PDF Bytes",
      description: "Read a range of bytes from a PDF (max 512KB per request)",
      inputSchema: {
        url: z.string().describe("PDF URL or local file path"),
        offset: z.number().min(0).default(0).describe("Byte offset"),
        byteCount: z
          .number()
          .min(1)
          .max(MAX_CHUNK_BYTES)
          .default(MAX_CHUNK_BYTES)
          .describe("Bytes to read"),
      },
      outputSchema: z.object({
        url: z.string(),
        bytes: z.string().describe("Base64 encoded bytes"),
        offset: z.number(),
        byteCount: z.number(),
        totalBytes: z.number(),
        hasMore: z.boolean(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ url, offset, byteCount }): Promise<CallToolResult> => {
      const validation = validateUrl(url);
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: validation.error! }],
          isError: true,
        };
      }

      try {
        const normalized = isArxivUrl(url) ? normalizeArxivUrl(url) : url;
        const { data, totalBytes } = await readPdfRange(
          normalized,
          offset,
          byteCount,
        );

        // Base64 encode for JSON transport
        const bytes = Buffer.from(data).toString("base64");
        const hasMore = offset + data.length < totalBytes;

        return {
          content: [
            {
              type: "text",
              text: `${data.length} bytes at ${offset}/${totalBytes}`,
            },
          ],
          structuredContent: {
            url: normalized,
            bytes,
            offset,
            byteCount: data.length,
            totalBytes,
            hasMore,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool: display_pdf - Show interactive viewer
  registerAppTool(
    server,
    "display_pdf",
    {
      title: "Display PDF",
      description: `Display an interactive PDF viewer for reading, annotating, and filling out PDF documents.

Use this tool when the user wants to view, read, annotate, or fill out a PDF.

**CRITICAL — DO NOT call display_pdf again on an already-displayed PDF.** Use the \`interact\` tool with the viewUUID from the result instead. Calling display_pdf again discards the existing viewer and all its state.

Returns a viewUUID in structuredContent. Use it with \`interact\` for follow-up actions:
- navigate, search, find, search_navigate, zoom
- add_annotations, update_annotations, remove_annotations, highlight_text
- fill_form (fill PDF form fields)
- get_text, get_screenshot (extract content)

Accepts local files (use list_pdfs), client MCP root directories, or any HTTPS URL.
Set \`elicit_form_inputs\` to true to prompt the user to fill form fields before display.`,
      inputSchema: {
        url: z
          .string()
          .default(DEFAULT_PDF)
          .describe("PDF URL or local file path"),
        page: z.number().min(1).default(1).describe("Initial page"),
        elicit_form_inputs: z
          .boolean()
          .default(false)
          .describe(
            "If true and the PDF has form fields, prompt the user to fill them before displaying",
          ),
      },
      outputSchema: z.object({
        viewUUID: z
          .string()
          .describe("UUID for this viewer instance — pass to interact tool"),
        url: z.string(),
        initialPage: z.number(),
        totalBytes: z.number(),
        formFieldValues: z
          .record(z.string(), z.union([z.string(), z.boolean()]))
          .optional()
          .describe("Form field values filled by the user via elicitation"),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ url, page, elicit_form_inputs }): Promise<CallToolResult> => {
      const normalized = isArxivUrl(url) ? normalizeArxivUrl(url) : url;
      const validation = validateUrl(normalized);

      if (!validation.valid) {
        return {
          content: [{ type: "text", text: validation.error! }],
          isError: true,
        };
      }

      // Probe file size so the client can set up range transport without an extra fetch
      const { totalBytes } = await readPdfRange(normalized, 0, 1);
      const uuid = randomUUID();
      // Extract form field schema (used for elicitation and field name validation)
      let formSchema: Awaited<ReturnType<typeof extractFormSchema>> = null;
      try {
        formSchema = await extractFormSchema(normalized, readPdfRange);
      } catch {
        // Non-fatal — PDF may not have form fields
      }
      if (formSchema) {
        viewFieldNames.set(uuid, new Set(Object.keys(formSchema.properties)));
      }

      // Elicit form field values if requested and client supports it
      let formFieldValues: Record<string, string | boolean> | undefined;
      let elicitResult: ElicitResult | undefined;
      if (elicit_form_inputs && formSchema) {
        const clientCaps = server.server.getClientCapabilities();
        if (clientCaps?.elicitation?.form) {
          try {
            elicitResult = await server.server.elicitInput({
              message: `Please fill in the PDF form fields for "${normalized.split("/").pop() || normalized}":`,
              requestedSchema: formSchema,
            });
            if (elicitResult.action === "accept" && elicitResult.content) {
              formFieldValues = {};
              for (const [k, v] of Object.entries(elicitResult.content)) {
                if (typeof v === "string" || typeof v === "boolean") {
                  formFieldValues[k] = v;
                }
              }
              // Queue fill_form command so the viewer picks it up
              enqueueCommand(uuid, {
                type: "fill_form",
                fields: Object.entries(formFieldValues).map(
                  ([name, value]) => ({ name, value }),
                ),
              });
            }
          } catch (err) {
            // Elicitation failed — continue without form values
            console.error("[pdf-server] Form elicitation failed:", err);
          }
        }
      }

      const contentParts: Array<{ type: "text"; text: string }> = [
        {
          type: "text",
          text: `Displaying PDF: ${normalized} (viewUUID: ${uuid})`,
        },
      ];

      if (formFieldValues && Object.keys(formFieldValues).length > 0) {
        const fieldSummary = Object.entries(formFieldValues)
          .map(
            ([name, value]) =>
              `  ${name}: ${typeof value === "boolean" ? (value ? "checked" : "unchecked") : value}`,
          )
          .join("\n");
        contentParts.push({
          type: "text",
          text: `\nUser-provided form field values:\n${fieldSummary}`,
        });
      } else if (
        elicit_form_inputs &&
        elicitResult &&
        elicitResult.action !== "accept"
      ) {
        contentParts.push({
          type: "text",
          text: `\nForm elicitation was ${elicitResult.action}d by the user.`,
        });
      }

      // Include available form field names so the model knows what fill_form accepts
      const fieldNames = viewFieldNames.get(uuid);
      if (fieldNames && fieldNames.size > 0) {
        contentParts.push({
          type: "text",
          text: `\nForm fields available for fill_form: ${[...fieldNames].join(", ")}`,
        });
      }

      return {
        content: contentParts,
        structuredContent: {
          viewUUID: uuid,
          url: normalized,
          initialPage: page,
          totalBytes,
          ...(formFieldValues ? { formFieldValues } : {}),
        },
        _meta: {
          viewUUID: uuid,
        },
      };
    },
  );

  // Schema for a single interact command (used in commands array)
  const InteractCommandSchema = z.object({
    action: z
      .enum([
        "navigate",
        "search",
        "find",
        "search_navigate",
        "zoom",
        "add_annotations",
        "update_annotations",
        "remove_annotations",
        "highlight_text",
        "fill_form",
        "get_text",
        "get_screenshot",
      ])
      .describe("Action to perform"),
    page: z
      .number()
      .min(1)
      .optional()
      .describe(
        "Page number (for navigate, highlight_text, get_screenshot, get_text)",
      ),
    query: z
      .string()
      .optional()
      .describe("Search text (for search / find / highlight_text)"),
    matchIndex: z
      .number()
      .min(0)
      .optional()
      .describe("Match index (for search_navigate)"),
    scale: z
      .number()
      .min(0.5)
      .max(3.0)
      .optional()
      .describe("Zoom scale, 1.0 = 100% (for zoom)"),
    annotations: z
      .array(z.record(z.string(), z.any()))
      .optional()
      .describe(
        "Annotation objects (see types in description). Each needs: id, type, page. For update_annotations only id+type are required.",
      ),
    ids: z
      .array(z.string())
      .optional()
      .describe("Annotation IDs (for remove_annotations)"),
    color: z
      .string()
      .optional()
      .describe("Color override (for highlight_text)"),
    content: z
      .string()
      .optional()
      .describe("Tooltip/note content (for highlight_text)"),
    fields: z
      .array(FormField)
      .optional()
      .describe(
        "Form fields to fill (for fill_form): { name, value } where value is string or boolean",
      ),
    intervals: z
      .array(PageInterval)
      .optional()
      .describe(
        "Page ranges for get_text. Each has optional start/end. [{start:1,end:5}], [{}] = all pages. Max 20 pages.",
      ),
  });

  type InteractCommand = z.infer<typeof InteractCommandSchema>;
  type ContentPart =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

  /** Process a single interact command. Returns content parts and an isError flag. */
  async function processInteractCommand(
    uuid: string,
    cmd: InteractCommand,
  ): Promise<{ content: ContentPart[]; isError?: boolean }> {
    const {
      action,
      page,
      query,
      matchIndex,
      scale,
      annotations,
      ids,
      color,
      content,
      fields,
      intervals,
    } = cmd;

    let description: string;
    switch (action) {
      case "navigate":
        if (page == null)
          return {
            content: [{ type: "text", text: "navigate requires `page`" }],
            isError: true,
          };
        enqueueCommand(uuid, { type: "navigate", page });
        description = `navigate to page ${page}`;
        break;
      case "search":
        if (!query)
          return {
            content: [{ type: "text", text: "search requires `query`" }],
            isError: true,
          };
        enqueueCommand(uuid, { type: "search", query });
        description = `search for "${query}"`;
        break;
      case "find":
        if (!query)
          return {
            content: [{ type: "text", text: "find requires `query`" }],
            isError: true,
          };
        enqueueCommand(uuid, { type: "find", query });
        description = `find "${query}" (silent)`;
        break;
      case "search_navigate":
        if (matchIndex == null)
          return {
            content: [
              {
                type: "text",
                text: "search_navigate requires `matchIndex`",
              },
            ],
            isError: true,
          };
        enqueueCommand(uuid, { type: "search_navigate", matchIndex });
        description = `go to match #${matchIndex}`;
        break;
      case "zoom":
        if (scale == null)
          return {
            content: [{ type: "text", text: "zoom requires `scale`" }],
            isError: true,
          };
        enqueueCommand(uuid, { type: "zoom", scale });
        description = `zoom to ${Math.round(scale * 100)}%`;
        break;
      case "add_annotations":
        if (!annotations || annotations.length === 0)
          return {
            content: [
              {
                type: "text",
                text: "add_annotations requires `annotations` array",
              },
            ],
            isError: true,
          };
        enqueueCommand(uuid, {
          type: "add_annotations",
          annotations: annotations as z.infer<typeof PdfAnnotationDef>[],
        });
        description = `add ${annotations.length} annotation(s)`;
        break;
      case "update_annotations":
        if (!annotations || annotations.length === 0)
          return {
            content: [
              {
                type: "text",
                text: "update_annotations requires `annotations` array",
              },
            ],
            isError: true,
          };
        enqueueCommand(uuid, {
          type: "update_annotations",
          annotations: annotations as z.infer<typeof PdfAnnotationUpdate>[],
        });
        description = `update ${annotations.length} annotation(s)`;
        break;
      case "remove_annotations":
        if (!ids || ids.length === 0)
          return {
            content: [
              {
                type: "text",
                text: "remove_annotations requires `ids` array",
              },
            ],
            isError: true,
          };
        enqueueCommand(uuid, { type: "remove_annotations", ids });
        description = `remove ${ids.length} annotation(s)`;
        break;
      case "highlight_text": {
        if (!query)
          return {
            content: [
              { type: "text", text: "highlight_text requires `query`" },
            ],
            isError: true,
          };
        const id = `ht_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        enqueueCommand(uuid, {
          type: "highlight_text",
          id,
          query,
          page,
          color,
          content,
        });
        description = `highlight text "${query}"${page ? ` on page ${page}` : ""}`;
        break;
      }
      case "fill_form": {
        if (!fields || fields.length === 0)
          return {
            content: [
              { type: "text", text: "fill_form requires `fields` array" },
            ],
            isError: true,
          };
        const knownFields = viewFieldNames.get(uuid);
        const validFields: typeof fields = [];
        const unknownNames: string[] = [];
        for (const f of fields) {
          if (knownFields && !knownFields.has(f.name)) {
            unknownNames.push(f.name);
          } else {
            validFields.push(f);
          }
        }
        if (validFields.length > 0) {
          enqueueCommand(uuid, { type: "fill_form", fields: validFields });
        }
        const parts: string[] = [];
        if (validFields.length > 0) {
          parts.push(
            `Filled ${validFields.length} field(s): ${validFields.map((f) => f.name).join(", ")}`,
          );
        }
        if (unknownNames.length > 0) {
          parts.push(`Unknown field(s) skipped: ${unknownNames.join(", ")}`);
        }
        if (knownFields && knownFields.size > 0) {
          parts.push(`Valid field names: ${[...knownFields].join(", ")}`);
        }
        description = parts.join(". ");
        if (unknownNames.length > 0 && validFields.length === 0) {
          return {
            content: [{ type: "text", text: description }],
            isError: true,
          };
        }
        break;
      }
      case "get_text": {
        const resolvedIntervals =
          intervals ?? (page ? [{ start: page, end: page }] : [{}]);

        const requestId = randomUUID();

        enqueueCommand(uuid, {
          type: "get_pages",
          requestId,
          intervals: resolvedIntervals,
          getText: true,
          getScreenshots: false,
        });

        let pageData: PageDataEntry[];
        try {
          pageData = await waitForPageData(requestId);
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }

        const textParts: ContentPart[] = [];
        for (const entry of pageData) {
          if (entry.text != null) {
            textParts.push({
              type: "text",
              text: `--- Page ${entry.page} ---\n${entry.text}`,
            });
          }
        }
        if (textParts.length === 0) {
          textParts.push({ type: "text", text: "No text content returned" });
        }
        return { content: textParts };
      }
      case "get_screenshot": {
        if (page == null)
          return {
            content: [{ type: "text", text: "get_screenshot requires `page`" }],
            isError: true,
          };

        const requestId = randomUUID();

        enqueueCommand(uuid, {
          type: "get_pages",
          requestId,
          intervals: [{ start: page, end: page }],
          getText: false,
          getScreenshots: true,
        });

        let pageData: PageDataEntry[];
        try {
          pageData = await waitForPageData(requestId);
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }

        const entry = pageData[0];
        if (entry?.image) {
          return {
            content: [
              {
                type: "image",
                data: entry.image,
                mimeType: "image/jpeg",
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: "No screenshot returned" }],
          isError: true,
        };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown action: ${action}` }],
          isError: true,
        };
    }
    return {
      content: [{ type: "text", text: `Queued: ${description}` }],
    };
  }

  // Tool: interact - Interact with an existing PDF viewer
  server.registerTool(
    "interact",
    {
      title: "Interact with PDF",
      description: `Interact with a PDF viewer: annotate, navigate, search, extract text/screenshots, fill forms.
IMPORTANT: viewUUID must be the exact UUID returned by display_pdf (e.g. "a1b2c3d4-..."). Do NOT use arbitrary strings.

**BATCHING**: Send multiple commands in one call via \`commands\` array. Commands run sequentially. TIP: End with \`get_screenshot\` to verify your changes.

**ANNOTATION** — add_annotations with array of annotation objects. Each needs: id (unique string), type, page (1-indexed).

**COORDINATE SYSTEM**: PDF points (1pt = 1/72in), origin at BOTTOM-LEFT. X→right, Y→up.
- Page size in model context (e.g. "612×792pt"). US Letter: top≈y=750, mid≈y=400, bottom≈y=50, left≈x=72, right≈x=540.

Annotation types:
• highlight: rects:[{x,y,width,height}], color?, content? • underline: rects:[{x,y,w,h}], color?
• strikethrough: rects:[{x,y,w,h}], color? • note: x, y, content, color?
• rectangle: x, y, width, height, color?, fillColor? • freetext: x, y, content, fontSize?, color?
• stamp: x, y, label (APPROVED|DRAFT|CONFIDENTIAL|FINAL|VOID|REJECTED), color?, rotation?

TIP: For text annotations, prefer highlight_text (auto-finds text) over manual rects.

Example — add annotations then screenshot to verify:
\`\`\`json
{"viewUUID":"…","commands":[
  {"action":"add_annotations","annotations":[
    {"id":"h1","type":"highlight","page":1,"rects":[{"x":72,"y":700,"width":200,"height":12}]},
    {"id":"s1","type":"stamp","page":1,"x":300,"y":400,"label":"APPROVED"}
  ]},
  {"action":"get_screenshot","page":1}
]}
\`\`\`

• highlight_text: auto-find and highlight text (query, page?, color?, content?)
• update_annotations: partial update (id+type required) • remove_annotations: remove by ids

**NAVIGATION**: navigate (page), search (query), find (query, silent), search_navigate (matchIndex), zoom (scale 0.5–3.0)

**TEXT/SCREENSHOTS**:
• get_text: extract text from pages. Optional \`page\` for single page, or \`intervals\` for ranges [{start?,end?}]. Max 20 pages.
• get_screenshot: capture a single page as PNG image. Requires \`page\`.

**FORMS** — fill_form: fill fields with \`fields\` array of {name, value}.`,
      inputSchema: {
        viewUUID: z
          .string()
          .describe("The viewUUID of the PDF viewer (from display_pdf result)"),
        // Single-command mode (backwards-compatible)
        action: z
          .enum([
            "navigate",
            "search",
            "find",
            "search_navigate",
            "zoom",
            "add_annotations",
            "update_annotations",
            "remove_annotations",
            "highlight_text",
            "fill_form",
            "get_text",
            "get_screenshot",
          ])
          .optional()
          .describe(
            "Action to perform (for single command). Use `commands` array for batching.",
          ),
        page: z
          .number()
          .min(1)
          .optional()
          .describe(
            "Page number (for navigate, highlight_text, get_screenshot, get_text)",
          ),
        query: z
          .string()
          .optional()
          .describe("Search text (for search / find / highlight_text)"),
        matchIndex: z
          .number()
          .min(0)
          .optional()
          .describe("Match index (for search_navigate)"),
        scale: z
          .number()
          .min(0.5)
          .max(3.0)
          .optional()
          .describe("Zoom scale, 1.0 = 100% (for zoom)"),
        annotations: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe(
            "Annotation objects (see types in description). Each needs: id, type, page. For update_annotations only id+type are required.",
          ),
        ids: z
          .array(z.string())
          .optional()
          .describe("Annotation IDs (for remove_annotations)"),
        color: z
          .string()
          .optional()
          .describe("Color override (for highlight_text)"),
        content: z
          .string()
          .optional()
          .describe("Tooltip/note content (for highlight_text)"),
        fields: z
          .array(FormField)
          .optional()
          .describe(
            "Form fields to fill (for fill_form): { name, value } where value is string or boolean",
          ),
        intervals: z
          .array(PageInterval)
          .optional()
          .describe(
            "Page ranges for get_text. Each has optional start/end. [{start:1,end:5}], [{}] = all pages. Max 20 pages.",
          ),
        // Batch mode
        commands: z
          .array(InteractCommandSchema)
          .optional()
          .describe(
            "Array of commands to execute sequentially. More efficient than separate calls. Tip: end with get_pages+getScreenshots to verify changes.",
          ),
      },
    },
    async ({
      viewUUID: uuid,
      action,
      page,
      query,
      matchIndex,
      scale,
      annotations,
      ids,
      color,
      content,
      fields,
      intervals,
      commands,
    }): Promise<CallToolResult> => {
      // Build the list of commands to process
      const commandList: InteractCommand[] = commands
        ? commands
        : action
          ? [
              {
                action,
                page,
                query,
                matchIndex,
                scale,
                annotations,
                ids,
                color,
                content,
                fields,
                intervals,
              },
            ]
          : [];

      if (commandList.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No action or commands specified. Provide either `action` (single command) or `commands` (batch).",
            },
          ],
          isError: true,
        };
      }

      // Process commands sequentially, collecting all content parts
      const allContent: ContentPart[] = [];
      let hasError = false;

      for (let i = 0; i < commandList.length; i++) {
        const result = await processInteractCommand(uuid, commandList[i]);
        if (result.isError) {
          hasError = true;
        }
        allContent.push(...result.content);
        if (hasError) break; // Stop on first error
      }

      return {
        content: allContent,
        ...(hasError ? { isError: true } : {}),
      };
    },
  );

  // Tool: submit_page_data (app-only) - Client submits rendered page data
  registerAppTool(
    server,
    "submit_page_data",
    {
      title: "Submit Page Data",
      description:
        "Submit rendered page data for a get_pages request (used by viewer)",
      inputSchema: {
        requestId: z
          .string()
          .describe("The request ID from the get_pages command"),
        pages: z
          .array(
            z.object({
              page: z.number(),
              text: z.string().optional(),
              image: z.string().optional().describe("Base64 PNG image data"),
            }),
          )
          .describe("Page data entries"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ requestId, pages }): Promise<CallToolResult> => {
      const pending = pendingPageRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingPageRequests.delete(requestId);
        pending.resolve(pages);
        return {
          content: [
            { type: "text", text: `Submitted ${pages.length} page(s)` },
          ],
        };
      }
      return {
        content: [
          { type: "text", text: `No pending request for ${requestId}` },
        ],
        isError: true,
      };
    },
  );

  // Tool: poll_pdf_commands (app-only) - Poll for pending commands
  registerAppTool(
    server,
    "poll_pdf_commands",
    {
      title: "Poll PDF Commands",
      description: "Poll for pending commands for a PDF viewer",
      inputSchema: {
        viewUUID: z.string().describe("The viewUUID of the PDF viewer"),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ viewUUID: uuid }): Promise<CallToolResult> => {
      // If commands are already queued, wait briefly to let more accumulate
      if (commandQueues.has(uuid)) {
        await new Promise((r) => setTimeout(r, POLL_BATCH_WAIT_MS));
      } else {
        // Long-poll: wait for commands to arrive or timeout
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            pollWaiters.delete(uuid);
            resolve();
          }, LONG_POLL_TIMEOUT_MS);
          // Cancel any existing waiter for this uuid
          const prev = pollWaiters.get(uuid);
          if (prev) prev();
          pollWaiters.set(uuid, () => {
            clearTimeout(timer);
            resolve();
          });
        });
        // After waking, wait briefly for batching
        if (commandQueues.has(uuid)) {
          await new Promise((r) => setTimeout(r, POLL_BATCH_WAIT_MS));
        }
      }
      const commands = dequeueCommands(uuid);
      return {
        content: [{ type: "text", text: `${commands.length} command(s)` }],
        structuredContent: { commands },
      };
    },
  );

  // Resource: UI HTML
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.promises.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      );
      return {
        contents: [
          { uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html },
        ],
      };
    },
  );

  return server;
}
