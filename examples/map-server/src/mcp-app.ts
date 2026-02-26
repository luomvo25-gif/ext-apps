/**
 * CesiumJS Globe MCP App
 *
 * Displays a 3D globe using CesiumJS with OpenStreetMap tiles.
 * Receives initial bounding box from the show-map tool and exposes
 * a navigate-to tool for the host to control navigation.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import type { ContentBlock } from "@modelcontextprotocol/sdk/spec.types.js";

// TypeScript declaration for Cesium loaded from CDN
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare let Cesium: any;

const CESIUM_VERSION = "1.123";
const CESIUM_BASE_URL = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium`;

const MAX_MODEL_CONTEXT_UPDATE_IMAGE_DIMENSION = 768; // Max width/height for screenshots in pixels for updateModelContext

/**
 * Dynamically load CesiumJS from CDN
 * This is necessary because external <script src=""> tags don't work in srcdoc iframes
 */
async function loadCesium(): Promise<void> {
  // Check if already loaded
  if (typeof Cesium !== "undefined") {
    return;
  }

  // Load CSS first
  const cssLink = document.createElement("link");
  cssLink.rel = "stylesheet";
  cssLink.href = `${CESIUM_BASE_URL}/Widgets/widgets.css`;
  document.head.appendChild(cssLink);

  // Load JS
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${CESIUM_BASE_URL}/Cesium.js`;
    script.onload = () => {
      // Set CESIUM_BASE_URL for asset loading
      (window as any).CESIUM_BASE_URL = CESIUM_BASE_URL;
      resolve();
    };
    script.onerror = () =>
      reject(new Error("Failed to load CesiumJS from CDN"));
    document.head.appendChild(script);
  });
}

const log = {
  info: console.log.bind(console, "[APP]"),
  warn: console.warn.bind(console, "[APP]"),
  error: console.error.bind(console, "[APP]"),
};

interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

// CesiumJS viewer instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let viewer: any = null;

// Debounce timer for reverse geocoding
let reverseGeocodeTimer: ReturnType<typeof setTimeout> | null = null;

// Debounce timer for persisting view state
let persistViewTimer: ReturnType<typeof setTimeout> | null = null;

// Track whether tool input has been received (to know if we should restore persisted state)
let hasReceivedToolInput = false;

let viewUUID: string | undefined = undefined;

/**
 * Persisted camera state for localStorage
 */
interface PersistedCameraState {
  longitude: number; // degrees
  latitude: number; // degrees
  height: number; // meters
  heading: number; // radians
  pitch: number; // radians
  roll: number; // radians
}

/**
 * Get current camera state for persistence
 */
function getCameraState(cesiumViewer: any): PersistedCameraState | null {
  try {
    const camera = cesiumViewer.camera;
    const cartographic = camera.positionCartographic;
    return {
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      height: cartographic.height,
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    };
  } catch (e) {
    log.warn("Failed to get camera state:", e);
    return null;
  }
}

/**
 * Save current view state to localStorage (debounced)
 */
function schedulePersistViewState(cesiumViewer: any): void {
  if (persistViewTimer) {
    clearTimeout(persistViewTimer);
  }
  persistViewTimer = setTimeout(() => {
    persistViewState(cesiumViewer);
  }, 500); // 500ms debounce
}

/**
 * Persist current view state to localStorage
 */
function persistViewState(cesiumViewer: any): void {
  if (!viewUUID) {
    log.info("No storage key available, skipping view persistence");
    return;
  }

  const state = getCameraState(cesiumViewer);
  if (!state) return;

  try {
    const value = JSON.stringify(state);
    localStorage.setItem(viewUUID, value);
    log.info("Persisted view state:", viewUUID, value);
  } catch (e) {
    log.warn("Failed to persist view state:", e);
  }
}

/**
 * Load persisted view state from localStorage
 */
function loadPersistedViewState(): PersistedCameraState | null {
  if (!viewUUID) return null;

  try {
    const stored = localStorage.getItem(viewUUID);
    if (!stored) {
      console.info("No persisted view state found");
      return null;
    }

    const state = JSON.parse(stored) as PersistedCameraState;
    // Basic validation
    if (
      typeof state.longitude !== "number" ||
      typeof state.latitude !== "number" ||
      typeof state.height !== "number"
    ) {
      log.warn("Invalid persisted view state, ignoring");
      return null;
    }
    log.info("Loaded persisted view state:", state);
    return state;
  } catch (e) {
    log.warn("Failed to load persisted view state:", e);
    return null;
  }
}

/**
 * Restore camera to persisted state
 */
function restorePersistedView(cesiumViewer: any): boolean {
  const state = loadPersistedViewState();
  if (!state) return false;

  try {
    log.info(
      "Restoring persisted view:",
      state.latitude.toFixed(2),
      state.longitude.toFixed(2),
    );
    cesiumViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        state.longitude,
        state.latitude,
        state.height,
      ),
      orientation: {
        heading: state.heading,
        pitch: state.pitch,
        roll: state.roll,
      },
    });
    return true;
  } catch (e) {
    log.warn("Failed to restore persisted view:", e);
    return false;
  }
}

/**
 * Get the center point of the current camera view
 */
function getCameraCenter(
  cesiumViewer: any,
): { lat: number; lon: number } | null {
  try {
    const cartographic = cesiumViewer.camera.positionCartographic;
    return {
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      lon: Cesium.Math.toDegrees(cartographic.longitude),
    };
  } catch {
    return null;
  }
}

/**
 * Get the visible extent (bounding box) of the current camera view
 * Returns null if the view doesn't intersect the ellipsoid (e.g., looking at sky)
 */
function getVisibleExtent(cesiumViewer: any): BoundingBox | null {
  try {
    const rect = cesiumViewer.camera.computeViewRectangle();
    if (!rect) return null;
    return {
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north),
    };
  } catch {
    return null;
  }
}

/**
 * Calculate approximate map scale dimensions in kilometers
 */
function getScaleDimensions(extent: BoundingBox): {
  widthKm: number;
  heightKm: number;
} {
  // Approximate conversion: 1 degree latitude ≈ 111 km
  // Longitude varies by latitude, use midpoint latitude for approximation
  const midLat = (extent.north + extent.south) / 2;
  const latRad = (midLat * Math.PI) / 180;

  const heightDeg = Math.abs(extent.north - extent.south);
  const widthDeg = Math.abs(extent.east - extent.west);

  // Handle wrap-around at 180/-180 longitude
  const adjustedWidthDeg = widthDeg > 180 ? 360 - widthDeg : widthDeg;

  const heightKm = heightDeg * 111;
  const widthKm = adjustedWidthDeg * 111 * Math.cos(latRad);

  return { widthKm, heightKm };
}

/**
 * Debounced location update using multi-point reverse geocoding.
 * Samples multiple points in the visible extent to discover places.
 *
 * Updates model context with structured YAML frontmatter (similar to pdf-server).
 */
function scheduleLocationUpdate(cesiumViewer: any): void {
  if (reverseGeocodeTimer) {
    clearTimeout(reverseGeocodeTimer);
  }
  // Debounce to 1.5 seconds before starting geocoding
  reverseGeocodeTimer = setTimeout(async () => {
    const center = getCameraCenter(cesiumViewer);
    const extent = getVisibleExtent(cesiumViewer);

    if (!extent || !center) {
      log.info("No visible extent or center (camera looking at sky?)");
      return;
    }

    const { widthKm, heightKm } = getScaleDimensions(extent);

    // Update the model's context with the current map location and screenshot.
    const text =
      `The map view of ${app.getHostContext()?.toolInfo?.id} is now ${widthKm.toFixed(1)}km wide × ${heightKm.toFixed(1)}km tall, ` +
      `centered on lat. / long. [${center.lat.toFixed(4)}, ${center.lon.toFixed(4)}]`;

    // Build content array with text and optional screenshot
    const content: ContentBlock[] = [{ type: "text", text }];

    // Add screenshot if host supports image content
    if (app.getHostCapabilities()?.updateModelContext?.image) {
      try {
        // Scale down to reduce token usage (tokens depend on dimensions)
        const sourceCanvas = cesiumViewer.canvas;
        const scale = Math.min(
          1,
          MAX_MODEL_CONTEXT_UPDATE_IMAGE_DIMENSION /
            Math.max(sourceCanvas.width, sourceCanvas.height),
        );
        const targetWidth = Math.round(sourceCanvas.width * scale);
        const targetHeight = Math.round(sourceCanvas.height * scale);

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = targetWidth;
        tempCanvas.height = targetHeight;
        const ctx = tempCanvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
          const dataUrl = tempCanvas.toDataURL("image/png");
          const base64Data = dataUrl.split(",")[1];
          if (base64Data) {
            content.push({
              type: "image",
              data: base64Data,
              mimeType: "image/png",
            });
            log.info(
              `Added screenshot to model context (${targetWidth}x${targetHeight})`,
            );
          }
        }
      } catch (err) {
        log.warn("Failed to capture screenshot:", err);
      }
    }

    app.updateModelContext({ content });
  }, 1500);
}

/**
 * Initialize CesiumJS with OpenStreetMap imagery (no Ion token required)
 * Based on: https://gist.github.com/banesullivan/e3cc15a3e2e865d5ab8bae6719733752
 */
async function initCesium(): Promise<any> {
  log.info("Starting CesiumJS initialization...");
  log.info("Window location:", window.location.href);
  log.info("Document origin:", document.location.origin);

  // Disable Cesium Ion completely - we use open tile sources
  Cesium.Ion.defaultAccessToken = undefined;
  log.info("Ion disabled");

  // Set default camera view rectangle (required when Ion is disabled)
  Cesium.Camera.DEFAULT_VIEW_RECTANGLE = Cesium.Rectangle.fromDegrees(
    -130,
    20,
    -60,
    55, // USA bounding box
  );
  log.info("Default view rectangle set");

  // Create viewer first with NO base layer, then add OSM imagery
  const cesiumViewer = new Cesium.Viewer("cesiumContainer", {
    // Start with no base layer - we'll add OSM manually
    baseLayer: false,
    // Disable Ion-dependent features
    geocoder: false,
    baseLayerPicker: false,
    // Simplify UI - hide all controls
    animation: false,
    timeline: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    // Disable terrain (requires Ion)
    terrainProvider: undefined,
    // WebGL context options for sandboxed iframe rendering
    contextOptions: {
      webgl: {
        preserveDrawingBuffer: true,
        alpha: true,
      },
    },
    // Use full device pixel ratio for sharp rendering on high-DPI displays
    useBrowserRecommendedResolution: false,
  });
  log.info("Viewer created");

  // Ensure the globe is visible
  cesiumViewer.scene.globe.show = true;
  cesiumViewer.scene.globe.enableLighting = false;
  cesiumViewer.scene.globe.baseColor = Cesium.Color.DARKSLATEGRAY;
  // Disable request render mode - helps with initial rendering
  cesiumViewer.scene.requestRenderMode = false;

  // Fix pixelated rendering on high-DPI displays
  // CesiumJS sets image-rendering: pixelated by default which looks bad on scaled displays
  // Setting to "auto" allows the browser to apply smooth interpolation
  cesiumViewer.canvas.style.imageRendering = "auto";
  // Note: DO NOT set resolutionScale = devicePixelRatio here!
  // When useBrowserRecommendedResolution: false, Cesium already uses devicePixelRatio.
  // Setting resolutionScale = devicePixelRatio would double the scaling (e.g., 2x2=4x on Retina)
  // which causes blurriness when scaled back down. Leave resolutionScale at default (1.0).

  // Disable FXAA anti-aliasing which can cause blurriness on high-DPI displays
  cesiumViewer.scene.postProcessStages.fxaa.enabled = false;

  log.info("Globe configured");

  // Create and add map imagery layer
  // Use standard OSM tiles - they render sharply with Cesium's settings
  log.info("Creating OpenStreetMap imagery provider...");
  try {
    // Use standard OpenStreetMap tile server
    // While these are 256x256 tiles, Cesium handles the rendering well
    // with useBrowserRecommendedResolution: false
    const osmProvider = new Cesium.UrlTemplateImageryProvider({
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      minimumLevel: 0,
      maximumLevel: 19,
      credit: new Cesium.Credit(
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        true,
      ),
    });
    log.info("OSM provider created (256x256 tiles)");

    // Log any imagery provider errors
    osmProvider.errorEvent.addEventListener((error: any) => {
      log.error("OSM imagery provider error:", error);
    });

    // Wait for provider to be ready
    if (osmProvider.ready !== undefined && !osmProvider.ready) {
      log.info("Waiting for OSM provider to be ready...");
      await osmProvider.readyPromise;
      log.info("OSM provider ready");
    }

    // Add the imagery layer to the viewer
    cesiumViewer.imageryLayers.addImageryProvider(osmProvider);
    log.info(
      "OSM imagery layer added, layer count:",
      cesiumViewer.imageryLayers.length,
    );

    // Log tile load events for debugging
    cesiumViewer.scene.globe.tileLoadProgressEvent.addEventListener(
      (queueLength: number) => {
        if (queueLength > 0) {
          log.info("Tiles loading, queue length:", queueLength);
        }
      },
    );

    // Force a render
    cesiumViewer.scene.requestRender();
    log.info("Render requested");
  } catch (error) {
    log.error("Failed to create OSM provider:", error);
  }

  // Fly to default USA view - using Rectangle is most reliable
  log.info("Flying to USA rectangle...");
  cesiumViewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    duration: 0,
  });

  // Force a few initial renders to ensure the globe is visible
  // This helps with sandboxed iframe contexts where initial rendering may be delayed
  let renderCount = 0;
  const initialRenderLoop = () => {
    cesiumViewer.render();
    cesiumViewer.scene.requestRender();
    renderCount++;
    if (renderCount < 20) {
      setTimeout(initialRenderLoop, 50);
    } else {
      log.info("Initial rendering complete");
    }
  };
  initialRenderLoop();

  log.info("Camera positioned, initial rendering started");

  // Set up camera move end listener for reverse geocoding and view persistence
  cesiumViewer.camera.moveEnd.addEventListener(() => {
    scheduleLocationUpdate(cesiumViewer);
    schedulePersistViewState(cesiumViewer);
  });
  log.info("Camera move listener registered");

  return cesiumViewer;
}

/**
 * Calculate camera destination for a bounding box
 */
function calculateDestination(bbox: BoundingBox): {
  destination: any;
  centerLon: number;
  centerLat: number;
  height: number;
} {
  const centerLon = (bbox.west + bbox.east) / 2;
  const centerLat = (bbox.south + bbox.north) / 2;

  const lonSpan = Math.abs(bbox.east - bbox.west);
  const latSpan = Math.abs(bbox.north - bbox.south);
  const maxSpan = Math.max(lonSpan, latSpan);

  // Height in meters - larger bbox = higher altitude
  // Minimum 100km for small areas, scale up for larger areas
  const height = Math.max(100000, maxSpan * 111000 * 5);
  const actualHeight = Math.max(height, 500000);

  const destination = Cesium.Cartesian3.fromDegrees(
    centerLon,
    centerLat,
    actualHeight,
  );

  return { destination, centerLon, centerLat, height: actualHeight };
}

/**
 * Position camera instantly to view a bounding box (no animation)
 */
function setViewToBoundingBox(cesiumViewer: any, bbox: BoundingBox): void {
  const { destination, centerLon, centerLat, height } =
    calculateDestination(bbox);

  log.info("setView destination:", centerLon, centerLat, "height:", height);

  cesiumViewer.camera.setView({
    destination,
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90), // Look straight down
      roll: 0,
    },
  });

  log.info(
    "setView complete, camera height:",
    cesiumViewer.camera.positionCartographic.height,
  );
}

/**
 * Wait for globe tiles to finish loading
 */
function waitForTilesLoaded(cesiumViewer: any): Promise<void> {
  return new Promise((resolve) => {
    // Check if already loaded
    if (cesiumViewer.scene.globe.tilesLoaded) {
      log.info("Tiles already loaded");
      resolve();
      return;
    }

    log.info("Waiting for tiles to load...");
    const removeListener =
      cesiumViewer.scene.globe.tileLoadProgressEvent.addEventListener(
        (queueLength: number) => {
          log.info("Tile queue:", queueLength);
          if (queueLength === 0 && cesiumViewer.scene.globe.tilesLoaded) {
            log.info("All tiles loaded");
            removeListener();
            resolve();
          }
        },
      );

    // Timeout after 10 seconds to prevent infinite wait
    setTimeout(() => {
      log.warn("Tile loading timeout, proceeding anyway");
      removeListener();
      resolve();
    }, 10000);
  });
}

/**
 * Hide the loading indicator
 */
function hideLoading(): void {
  const loadingEl = document.getElementById("loading");
  if (loadingEl) {
    loadingEl.style.display = "none";
  }
}

// Preferred height for inline mode (px)
const PREFERRED_INLINE_HEIGHT = 400;

// Current display mode
let currentDisplayMode: "inline" | "fullscreen" | "pip" = "inline";

// Create App instance with tool capabilities
// autoResize: false - we manually send size since map fills its container
const app = new App(
  { name: "CesiumJS Globe", version: "1.0.0" },
  { tools: { listChanged: true } },
  { autoResize: false },
);

/**
 * Update fullscreen button visibility and icon based on current state
 */
function updateFullscreenButton(): void {
  const btn = document.getElementById("fullscreen-btn");
  const expandIcon = document.getElementById("expand-icon");
  const compressIcon = document.getElementById("compress-icon");
  if (!btn || !expandIcon || !compressIcon) return;

  // Check if fullscreen is available from host
  const context = app.getHostContext();
  const availableModes = context?.availableDisplayModes ?? ["inline"];
  const canFullscreen = availableModes.includes("fullscreen");

  // Show button only if fullscreen is available
  btn.style.display = canFullscreen ? "flex" : "none";

  // Toggle icons based on current mode
  const isFullscreen = currentDisplayMode === "fullscreen";
  expandIcon.style.display = isFullscreen ? "none" : "block";
  compressIcon.style.display = isFullscreen ? "block" : "none";
  btn.title = isFullscreen ? "Exit fullscreen" : "Enter fullscreen";
}

/**
 * Request display mode change from host
 */
async function toggleFullscreen(): Promise<void> {
  const targetMode =
    currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
  log.info("Requesting display mode:", targetMode);

  try {
    const result = await app.requestDisplayMode({ mode: targetMode });
    log.info("Display mode result:", result.mode);
    // Note: actual mode change will come via onhostcontextchanged
  } catch (error) {
    log.error("Failed to change display mode:", error);
  }
}

/**
 * Handle keyboard shortcuts for fullscreen control
 * - Escape: Exit fullscreen (when in fullscreen mode)
 * - Ctrl/Cmd+Enter: Toggle fullscreen
 */
function handleFullscreenKeyboard(event: KeyboardEvent): void {
  // Escape to exit fullscreen
  if (event.key === "Escape" && currentDisplayMode === "fullscreen") {
    event.preventDefault();
    toggleFullscreen();
    return;
  }

  // Ctrl+Enter (Windows/Linux) or Cmd+Enter (Mac) to toggle fullscreen
  if (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey
  ) {
    event.preventDefault();
    toggleFullscreen();
  }
}

/**
 * Handle display mode changes - resize Cesium and update UI
 */
function handleDisplayModeChange(
  newMode: "inline" | "fullscreen" | "pip",
): void {
  if (newMode === currentDisplayMode) return;

  log.info("Display mode changed:", currentDisplayMode, "->", newMode);
  currentDisplayMode = newMode;

  // Update button state
  updateFullscreenButton();

  // Tell Cesium to resize to new container dimensions
  if (viewer) {
    // Small delay to let the host finish resizing
    setTimeout(() => {
      viewer.resize();
      viewer.scene.requestRender();
      log.info("Cesium resized for", newMode, "mode");
    }, 100);
  }
}

// Register handlers BEFORE connecting
app.onteardown = async () => {
  log.info("App is being torn down");
  stopPolling();
  if (viewer) {
    viewer.destroy();
    viewer = null;
  }
  return {};
};

app.onerror = log.error;

// Listen for host context changes (display mode, theme, etc.)
app.onhostcontextchanged = (params) => {
  log.info("Host context changed:", params);

  if (params.displayMode) {
    handleDisplayModeChange(
      params.displayMode as "inline" | "fullscreen" | "pip",
    );
  }

  // Update button if available modes changed
  if (params.availableDisplayModes) {
    updateFullscreenButton();
  }
};

// Handle initial tool input (bounding box from show-map tool)
app.ontoolinput = async (params) => {
  log.info("Received tool input:", params);
  const args = params.arguments as
    | {
        boundingBox?: BoundingBox;
        west?: number;
        south?: number;
        east?: number;
        north?: number;
        label?: string;
      }
    | undefined;

  if (args && viewer) {
    // Handle both nested boundingBox and flat format
    let bbox: BoundingBox | null = null;

    if (args.boundingBox) {
      bbox = args.boundingBox;
    } else if (
      args.west !== undefined &&
      args.south !== undefined &&
      args.east !== undefined &&
      args.north !== undefined
    ) {
      bbox = {
        west: args.west,
        south: args.south,
        east: args.east,
        north: args.north,
      };
    }

    if (bbox) {
      // Mark that we received explicit tool input (overrides persisted state)
      hasReceivedToolInput = true;
      log.info("Positioning camera to bbox:", bbox);

      // Position camera instantly (no animation)
      setViewToBoundingBox(viewer, bbox);

      // Wait for tiles to load at this location
      await waitForTilesLoaded(viewer);

      // Now hide loading indicator
      hideLoading();

      log.info(
        "Camera positioned, tiles loaded. Height:",
        viewer.camera.positionCartographic.height,
      );
    }
  }
};

// =============================================================================
// Command Queue Polling
// =============================================================================

interface MarkerDef {
  latitude: number;
  longitude: number;
  label?: string;
  color?: string;
}

interface TrackedMarker extends MarkerDef {
  id: string;
  entity: any; // Cesium.Entity
}

type MapCommand =
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
      type: "add_markers";
      markers: (MarkerDef & { id: string })[];
    }
  | {
      type: "update_markers";
      markers: {
        id: string;
        latitude?: number;
        longitude?: number;
        label?: string;
        color?: string;
      }[];
    }
  | {
      type: "remove_markers";
      ids: string[];
    };

/** All markers added to the map, keyed by id */
const markerMap = new Map<string, TrackedMarker>();

/** Get markers as a flat array (for export) */
function allMarkers(): TrackedMarker[] {
  return Array.from(markerMap.values());
}

/**
 * Fly camera to a bounding box with animation
 */
function flyToBoundingBox(
  cesiumViewer: any,
  bbox: BoundingBox,
  duration: number = 2,
): Promise<void> {
  return new Promise((resolve) => {
    const { destination } = calculateDestination(bbox);
    cesiumViewer.camera.flyTo({
      destination,
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
      duration,
      complete: resolve,
      cancel: resolve,
    });
  });
}

/**
 * Build Cesium label options for a marker
 */
function buildLabelOptions(text: string): any {
  return {
    text,
    font: "bold 14px sans-serif",
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    outlineWidth: 3,
    outlineColor: Cesium.Color.BLACK,
    fillColor: Cesium.Color.WHITE,
    showBackground: true,
    backgroundColor: new Cesium.Color(0, 0, 0, 0.65),
    backgroundPadding: new Cesium.Cartesian2(6, 4),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    pixelOffset: new Cesium.Cartesian2(0, -16),
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}

/**
 * Parse a CSS color string to a Cesium Color
 */
function parseCesiumColor(cssColor: string): any {
  try {
    return Cesium.Color.fromCssColorString(cssColor);
  } catch {
    return Cesium.Color.RED;
  }
}

/**
 * Add a marker/pin entity to the globe and track it
 */
function addMarker(
  cesiumViewer: any,
  id: string,
  lat: number,
  lon: number,
  label?: string,
  color?: string,
): void {
  const position = Cesium.Cartesian3.fromDegrees(lon, lat);
  const cesiumColor = parseCesiumColor(color || "red");

  const entityOptions: any = {
    position,
    point: {
      pixelSize: 12,
      color: cesiumColor,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
  };

  if (label) {
    entityOptions.label = buildLabelOptions(label);
  }

  const entity = cesiumViewer.entities.add(entityOptions);
  markerMap.set(id, {
    id,
    latitude: lat,
    longitude: lon,
    label,
    color,
    entity,
  });
  updateCopyButton();
  log.info("Added marker", id, "at", lat, lon, label || "");
}

/**
 * Update an existing marker's properties
 */
function updateMarker(
  id: string,
  updates: {
    latitude?: number;
    longitude?: number;
    label?: string;
    color?: string;
  },
): void {
  const tracked = markerMap.get(id);
  if (!tracked) {
    log.warn("updateMarker: unknown id", id);
    return;
  }
  const entity = tracked.entity;

  if (updates.latitude != null || updates.longitude != null) {
    const lat = updates.latitude ?? tracked.latitude;
    const lon = updates.longitude ?? tracked.longitude;
    entity.position = Cesium.Cartesian3.fromDegrees(lon, lat);
    tracked.latitude = lat;
    tracked.longitude = lon;
  }

  if (updates.color != null) {
    entity.point.color = parseCesiumColor(updates.color);
    tracked.color = updates.color;
  }

  if (updates.label !== undefined) {
    if (updates.label) {
      entity.label = buildLabelOptions(updates.label);
    } else {
      entity.label = undefined;
    }
    tracked.label = updates.label || undefined;
  }

  updateCopyButton();
  log.info("Updated marker", id, updates);
}

/**
 * Remove a marker from the globe
 */
function removeMarker(cesiumViewer: any, id: string): void {
  const tracked = markerMap.get(id);
  if (!tracked) {
    log.warn("removeMarker: unknown id", id);
    return;
  }
  cesiumViewer.entities.remove(tracked.entity);
  markerMap.delete(id);
  updateCopyButton();
  log.info("Removed marker", id);
}

/**
 * Process a batch of commands from the server queue
 */
async function processCommands(commands: MapCommand[]): Promise<void> {
  if (!viewer || commands.length === 0) return;

  for (const cmd of commands) {
    log.info("Processing command:", cmd.type, cmd);
    switch (cmd.type) {
      case "navigate": {
        const bbox: BoundingBox = {
          west: cmd.west,
          south: cmd.south,
          east: cmd.east,
          north: cmd.north,
        };
        if (cmd.fly === false) {
          setViewToBoundingBox(viewer, bbox);
        } else {
          await flyToBoundingBox(viewer, bbox);
        }
        break;
      }
      case "add_markers": {
        for (const m of cmd.markers) {
          addMarker(viewer, m.id, m.latitude, m.longitude, m.label, m.color);
        }
        break;
      }
      case "update_markers": {
        for (const m of cmd.markers) {
          updateMarker(m.id, m);
        }
        break;
      }
      case "remove_markers": {
        for (const id of cmd.ids) {
          removeMarker(viewer, id);
        }
        break;
      }
    }
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start polling for commands from the server queue
 */
function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!viewUUID) return;
    try {
      const result = await app.callServerTool({
        name: "poll_map_commands",
        arguments: { viewUUID },
      });
      const commands =
        (result.structuredContent as { commands?: MapCommand[] })?.commands ||
        [];
      if (commands.length > 0) {
        log.info(`Received ${commands.length} command(s)`);
        await processCommands(commands);
      }
    } catch (err) {
      log.warn("Poll error:", err);
    }
  }, 300);
}

/**
 * Stop polling for commands
 */
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// =============================================================================
// Copy / Export Markers
// =============================================================================

/**
 * Format markers as a Markdown table
 */
function markersToMarkdown(markers: TrackedMarker[]): string {
  const lines = [
    "| # | Label | Latitude | Longitude | Color |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    lines.push(
      `| ${i + 1} | ${m.label || ""} | ${m.latitude.toFixed(6)} | ${m.longitude.toFixed(6)} | ${m.color || "red"} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Format markers as GeoJSON FeatureCollection
 */
function markersToGeoJSON(markers: TrackedMarker[]): string {
  const features = markers.map((m, i) => ({
    type: "Feature" as const,
    properties: {
      name: m.label || `Marker ${i + 1}`,
      "marker-color": m.color || "red",
    },
    geometry: {
      type: "Point" as const,
      coordinates: [m.longitude, m.latitude],
    },
  }));
  return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
}

/**
 * Copy markers to clipboard in multiple formats (Markdown + GeoJSON)
 */
async function copyMarkers(): Promise<void> {
  const markers = allMarkers();
  if (markers.length === 0) return;

  const md = markersToMarkdown(markers);
  const geojson = markersToGeoJSON(markers);
  const btn = document.getElementById("copy-btn");

  try {
    // Multi-mime clipboard: text/plain gets Markdown, application/geo+json gets GeoJSON
    // Browsers only support a subset of MIME types in ClipboardItem, so we use text/plain for
    // the markdown table and text/html for a code block with GeoJSON
    const htmlContent = `<table>\n<tr><th>#</th><th>Label</th><th>Lat</th><th>Lon</th><th>Color</th></tr>\n${markers
      .map(
        (m, i) =>
          `<tr><td>${i + 1}</td><td>${m.label || ""}</td><td>${m.latitude.toFixed(6)}</td><td>${m.longitude.toFixed(6)}</td><td>${m.color || "red"}</td></tr>`,
      )
      .join(
        "\n",
      )}\n</table>\n<details><summary>GeoJSON</summary><pre><code>${geojson.replace(/</g, "&lt;")}</code></pre></details>`;

    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([`${md}\n\n\`\`\`geojson\n${geojson}\n\`\`\``], {
          type: "text/plain",
        }),
        "text/html": new Blob([htmlContent], { type: "text/html" }),
      }),
    ]);

    if (btn) {
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1200);
    }
    log.info(`Copied ${markers.length} marker(s) to clipboard`);
  } catch (e) {
    // Fallback: plain text only
    try {
      await navigator.clipboard.writeText(
        `${md}\n\n\`\`\`geojson\n${geojson}\n\`\`\``,
      );
      if (btn) {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1200);
      }
    } catch (e2) {
      log.error("Failed to copy markers:", e2);
    }
  }
}

/**
 * Show/hide the copy button based on marker count
 */
function updateCopyButton(): void {
  const btn = document.getElementById("copy-btn");
  if (!btn) return;
  const count = markerMap.size;
  btn.style.display = count > 0 ? "flex" : "none";
  btn.title = `Copy ${count} marker(s) as Markdown + GeoJSON`;
}

// Handle tool result - extract viewUUID, restore persisted view, start polling
app.ontoolresult = async (result) => {
  viewUUID = result._meta?.viewUUID ? String(result._meta.viewUUID) : undefined;
  log.info("Tool result received, viewUUID:", viewUUID);

  // Now that we have viewUUID, try to restore persisted view
  // This overrides the tool input position if a saved state exists
  if (viewer && viewUUID) {
    const restored = restorePersistedView(viewer);
    if (restored) {
      log.info("Restored persisted view from tool result handler");
      await waitForTilesLoaded(viewer);
      hideLoading();
    }
  }

  // Start polling for commands now that we have viewUUID
  if (viewUUID) {
    startPolling();
  }
};

// Initialize Cesium and connect to host
async function initialize() {
  try {
    log.info("Loading CesiumJS from CDN...");
    await loadCesium();
    log.info("CesiumJS loaded successfully");

    viewer = await initCesium();
    log.info("CesiumJS initialized");

    // Connect to host (must happen before we can receive notifications)
    await app.connect();
    log.info("Connected to host");

    // Get initial display mode from host context
    const context = app.getHostContext();
    if (context?.displayMode) {
      currentDisplayMode = context.displayMode as
        | "inline"
        | "fullscreen"
        | "pip";
    }
    log.info("Initial display mode:", currentDisplayMode);

    // Tell host our preferred size for inline mode
    if (currentDisplayMode === "inline") {
      app.sendSizeChanged({ height: PREFERRED_INLINE_HEIGHT });
      log.info("Sent initial size:", PREFERRED_INLINE_HEIGHT);
    }

    // Set up fullscreen button
    updateFullscreenButton();
    const fullscreenBtn = document.getElementById("fullscreen-btn");
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener("click", toggleFullscreen);
    }

    // Set up keyboard shortcuts for fullscreen (Escape to exit, Ctrl/Cmd+Enter to toggle)
    document.addEventListener("keydown", handleFullscreenKeyboard);

    // Set up copy button
    const copyBtn = document.getElementById("copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", copyMarkers);
    }
    updateCopyButton();

    // Wait a bit for tool input, then try restoring persisted view or show default
    setTimeout(async () => {
      const loadingEl = document.getElementById("loading");
      if (
        loadingEl &&
        loadingEl.style.display !== "none" &&
        !hasReceivedToolInput
      ) {
        // No explicit tool input - try to restore persisted view
        const restored = restorePersistedView(viewer!);
        if (restored) {
          log.info("Restored persisted view, waiting for tiles...");
        } else {
          log.info("No persisted view, using default view...");
        }
        await waitForTilesLoaded(viewer!);
        hideLoading();
      }
    }, 500);
  } catch (error) {
    log.error("Failed to initialize:", error);
    const loadingEl = document.getElementById("loading");
    if (loadingEl) {
      loadingEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
      loadingEl.style.background = "rgba(200, 0, 0, 0.8)";
    }
  }
}

// Start initialization
initialize();
