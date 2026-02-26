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

/**
 * Compute a bounding box from a center point and radius in km.
 */
function bboxFromCenter(
  lat: number,
  lon: number,
  radiusKm: number,
): BoundingBox {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return {
    west: lon - lonDelta,
    south: lat - latDelta,
    east: lon + lonDelta,
    north: lat + latDelta,
  };
}

// =============================================================================
// Annotation Types & Tracking
// =============================================================================

/** Discriminated union for all annotation types (mirrors server-side AnnotationDef) */
type AnnotationDef =
  | {
      type: "marker";
      id: string;
      latitude: number;
      longitude: number;
      label?: string;
      color?: string;
    }
  | {
      type: "route";
      id: string;
      points: { latitude: number; longitude: number }[];
      label?: string;
      color?: string;
      width?: number;
      dashed?: boolean;
    }
  | {
      type: "area";
      id: string;
      points: { latitude: number; longitude: number }[];
      label?: string;
      color?: string;
      fillColor?: string;
    }
  | {
      type: "circle";
      id: string;
      latitude: number;
      longitude: number;
      radiusKm: number;
      label?: string;
      color?: string;
      fillColor?: string;
    };

/** Partial updates — id + type required, everything else optional */
type AnnotationUpdate =
  | {
      type: "marker";
      id: string;
      latitude?: number;
      longitude?: number;
      label?: string;
      color?: string;
    }
  | {
      type: "route";
      id: string;
      points?: { latitude: number; longitude: number }[];
      label?: string;
      color?: string;
      width?: number;
      dashed?: boolean;
    }
  | {
      type: "area";
      id: string;
      points?: { latitude: number; longitude: number }[];
      label?: string;
      color?: string;
      fillColor?: string;
    }
  | {
      type: "circle";
      id: string;
      latitude?: number;
      longitude?: number;
      radiusKm?: number;
      label?: string;
      color?: string;
      fillColor?: string;
    };

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
  | { type: "add"; annotations: AnnotationDef[] }
  | { type: "update"; annotations: AnnotationUpdate[] }
  | { type: "remove"; ids: string[] };

/** Tracked annotation with its Cesium entities */
interface TrackedAnnotation {
  def: AnnotationDef;
  /** All Cesium entities owned by this annotation (point, polyline, polygon, label, etc.) */
  entities: any[];
}

/** All annotations on the map, keyed by id */
const annotationMap = new Map<string, TrackedAnnotation>();

/** Get all annotations as a flat array */
function allAnnotations(): TrackedAnnotation[] {
  return Array.from(annotationMap.values());
}

// =============================================================================
// Cesium Rendering Helpers
// =============================================================================

/**
 * Parse a CSS color string to a Cesium Color
 */
function parseCesiumColor(cssColor: string, fallback?: string): any {
  try {
    return Cesium.Color.fromCssColorString(cssColor);
  } catch {
    try {
      if (fallback) return Cesium.Color.fromCssColorString(fallback);
    } catch {
      /* ignore */
    }
    return Cesium.Color.RED;
  }
}

/**
 * Render a label as a canvas image with rounded-rect background.
 * Returns a data URL suitable for Cesium billboard.image.
 */
function renderLabelImage(text: string): string {
  const dpr = window.devicePixelRatio || 1;
  const fontSize = Math.round(13 * dpr);
  const font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const padX = Math.round(8 * dpr);
  const padY = Math.round(5 * dpr);
  const radius = Math.round(5 * dpr);

  // Measure text
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const metrics = measure.measureText(text);
  const textW = Math.ceil(metrics.width);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fontSize * 0.8);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || fontSize * 0.2);
  const textH = ascent + descent;

  const w = textW + padX * 2;
  const h = textH + padY * 2;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  // Rounded rect background
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, radius);
  ctx.fillStyle = "rgba(30, 30, 30, 0.78)";
  ctx.fill();

  // Text — use alphabetic baseline with computed ascent for precise centering
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.fillText(text, padX, padY + ascent);

  return canvas.toDataURL("image/png");
}

/**
 * Create a label billboard entity at a given position
 */
function createLabelEntity(
  cesiumViewer: any,
  position: any,
  text: string,
  verticalOffset: number = -12,
): any {
  const dpr = window.devicePixelRatio || 1;
  return cesiumViewer.entities.add({
    position,
    billboard: {
      image: renderLabelImage(text),
      scale: 1 / dpr,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, verticalOffset),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

/**
 * Compute the midpoint of a points array (for route label placement)
 */
function midpoint(points: { latitude: number; longitude: number }[]): {
  latitude: number;
  longitude: number;
} {
  if (points.length === 0) return { latitude: 0, longitude: 0 };
  const mid = points[Math.floor(points.length / 2)];
  return { latitude: mid.latitude, longitude: mid.longitude };
}

/**
 * Compute the centroid of a points array (for area label placement)
 */
function centroid(points: { latitude: number; longitude: number }[]): {
  latitude: number;
  longitude: number;
} {
  if (points.length === 0) return { latitude: 0, longitude: 0 };
  let lat = 0,
    lon = 0;
  for (const p of points) {
    lat += p.latitude;
    lon += p.longitude;
  }
  return { latitude: lat / points.length, longitude: lon / points.length };
}

/**
 * Convert a points array to a flat Cesium positions array [lon, lat, lon, lat, ...]
 */
function pointsToDegreesArray(
  points: { latitude: number; longitude: number }[],
): number[] {
  const arr: number[] = [];
  for (const p of points) {
    arr.push(p.longitude, p.latitude);
  }
  return arr;
}

// =============================================================================
// Annotation CRUD
// =============================================================================

/**
 * Add a new annotation to the map
 */
function addAnnotation(cesiumViewer: any, def: AnnotationDef): void {
  // Remove existing annotation with same id (idempotent upsert)
  if (annotationMap.has(def.id)) {
    removeAnnotation(cesiumViewer, def.id);
  }

  const entities: any[] = [];

  switch (def.type) {
    case "marker": {
      const position = Cesium.Cartesian3.fromDegrees(
        def.longitude,
        def.latitude,
      );
      const cesiumColor = parseCesiumColor(def.color || "red");

      // Point entity (the colored dot)
      entities.push(
        cesiumViewer.entities.add({
          position,
          point: {
            pixelSize: 12,
            color: cesiumColor,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );

      // Label entity (separate so it doesn't conflict with point rendering)
      if (def.label) {
        entities.push(createLabelEntity(cesiumViewer, position, def.label));
      }
      break;
    }

    case "route": {
      if (def.points.length < 2) {
        log.warn("Route needs at least 2 points, got", def.points.length);
        break;
      }
      const positions = Cesium.Cartesian3.fromDegreesArray(
        pointsToDegreesArray(def.points),
      );
      const cesiumColor = parseCesiumColor(def.color || "blue");

      // Build material (dashed or solid)
      const material = def.dashed
        ? new Cesium.PolylineDashMaterialProperty({
            color: cesiumColor,
            dashLength: 16,
          })
        : cesiumColor;

      entities.push(
        cesiumViewer.entities.add({
          polyline: {
            positions,
            width: def.width ?? 3,
            material,
            clampToGround: true,
          },
        }),
      );

      if (def.label) {
        const mid = midpoint(def.points);
        const labelPos = Cesium.Cartesian3.fromDegrees(
          mid.longitude,
          mid.latitude,
        );
        entities.push(createLabelEntity(cesiumViewer, labelPos, def.label, 0));
      }
      break;
    }

    case "area": {
      if (def.points.length < 3) {
        log.warn("Area needs at least 3 points, got", def.points.length);
        break;
      }
      const positions = Cesium.Cartesian3.fromDegreesArray(
        pointsToDegreesArray(def.points),
      );
      const outlineColor = parseCesiumColor(def.color || "blue");
      const fillColor = def.fillColor
        ? parseCesiumColor(def.fillColor)
        : outlineColor.withAlpha(0.2);

      entities.push(
        cesiumViewer.entities.add({
          polygon: {
            hierarchy: positions,
            material: fillColor,
            outline: true,
            outlineColor,
            outlineWidth: 2,
          },
        }),
      );

      if (def.label) {
        const c = centroid(def.points);
        const labelPos = Cesium.Cartesian3.fromDegrees(c.longitude, c.latitude);
        entities.push(createLabelEntity(cesiumViewer, labelPos, def.label, 0));
      }
      break;
    }

    case "circle": {
      const position = Cesium.Cartesian3.fromDegrees(
        def.longitude,
        def.latitude,
      );
      const outlineColor = parseCesiumColor(def.color || "blue");
      const fillColor = def.fillColor
        ? parseCesiumColor(def.fillColor)
        : outlineColor.withAlpha(0.15);

      entities.push(
        cesiumViewer.entities.add({
          position,
          ellipse: {
            semiMajorAxis: def.radiusKm * 1000,
            semiMinorAxis: def.radiusKm * 1000,
            material: fillColor,
            outline: true,
            outlineColor,
            outlineWidth: 2,
          },
        }),
      );

      if (def.label) {
        entities.push(createLabelEntity(cesiumViewer, position, def.label, 0));
      }
      break;
    }
  }

  annotationMap.set(def.id, { def, entities });
  updateCopyButton();
  log.info("Added annotation", def.type, def.id);
}

/**
 * Update an existing annotation by removing and re-adding with merged fields
 */
function updateAnnotation(cesiumViewer: any, update: AnnotationUpdate): void {
  const tracked = annotationMap.get(update.id);
  if (!tracked) {
    log.warn("updateAnnotation: unknown id", update.id);
    return;
  }

  // Merge update into existing def
  const merged = { ...tracked.def, ...update } as AnnotationDef;

  // Remove old and re-add with merged def
  removeAnnotation(cesiumViewer, update.id);
  addAnnotation(cesiumViewer, merged);
  log.info("Updated annotation", update.type, update.id);
}

/**
 * Remove an annotation from the map
 */
function removeAnnotation(cesiumViewer: any, id: string): void {
  const tracked = annotationMap.get(id);
  if (!tracked) {
    log.warn("removeAnnotation: unknown id", id);
    return;
  }
  for (const entity of tracked.entities) {
    cesiumViewer.entities.remove(entity);
  }
  annotationMap.delete(id);
  updateCopyButton();
  log.info("Removed annotation", id);
}

// =============================================================================
// Persistence
// =============================================================================

/** Persist current annotations to localStorage */
function persistAnnotations(): void {
  if (!viewUUID) return;
  try {
    const data = allAnnotations().map((t) => t.def);
    localStorage.setItem(`${viewUUID}:annotations`, JSON.stringify(data));
  } catch (e) {
    log.warn("Failed to persist annotations:", e);
  }
}

/** Load persisted annotations from localStorage and add them to the map */
function restorePersistedAnnotations(cesiumViewer: any): void {
  if (!viewUUID) return;
  try {
    const stored = localStorage.getItem(`${viewUUID}:annotations`);
    if (!stored) return;
    const data = JSON.parse(stored) as AnnotationDef[];
    if (!Array.isArray(data) || data.length === 0) return;
    for (const ann of data) {
      if (!annotationMap.has(ann.id)) {
        addAnnotation(cesiumViewer, ann);
      }
    }
    log.info("Restored", data.length, "persisted annotation(s)");
  } catch (e) {
    log.warn("Failed to restore annotations:", e);
  }
}

// =============================================================================
// Command Queue Polling
// =============================================================================

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
      case "add": {
        for (const ann of cmd.annotations) {
          addAnnotation(viewer, ann);
        }
        break;
      }
      case "update": {
        for (const ann of cmd.annotations) {
          updateAnnotation(viewer, ann);
        }
        break;
      }
      case "remove": {
        for (const id of cmd.ids) {
          removeAnnotation(viewer, id);
        }
        break;
      }
    }
  }
  // Persist once after the entire batch
  persistAnnotations();
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
// Copy / Export Annotations
// =============================================================================

/**
 * Format annotations as a Markdown table
 */
function annotationsToMarkdown(annotations: TrackedAnnotation[]): string {
  const lines = [
    "| # | Type | ID | Label | Details | Color |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (let i = 0; i < annotations.length; i++) {
    const d = annotations[i].def;
    let details = "";
    switch (d.type) {
      case "marker":
        details = `${d.latitude.toFixed(6)}, ${d.longitude.toFixed(6)}`;
        break;
      case "route":
        details = `${d.points.length} waypoints`;
        break;
      case "area":
        details = `${d.points.length} vertices`;
        break;
      case "circle":
        details = `${d.latitude.toFixed(6)}, ${d.longitude.toFixed(6)} r=${d.radiusKm}km`;
        break;
    }
    lines.push(
      `| ${i + 1} | ${d.type} | ${d.id} | ${d.label || ""} | ${details} | ${d.color || (d.type === "marker" ? "red" : "blue")} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Format annotations as GeoJSON FeatureCollection
 */
function annotationsToGeoJSON(annotations: TrackedAnnotation[]): string {
  const features = annotations.map((t) => {
    const d = t.def;
    const props: Record<string, unknown> = {
      name: d.label || d.id,
      annotationType: d.type,
      color: d.color,
    };

    switch (d.type) {
      case "marker":
        return {
          type: "Feature" as const,
          properties: { ...props, "marker-color": d.color || "red" },
          geometry: {
            type: "Point" as const,
            coordinates: [d.longitude, d.latitude],
          },
        };
      case "route":
        return {
          type: "Feature" as const,
          properties: { ...props, width: d.width, dashed: d.dashed },
          geometry: {
            type: "LineString" as const,
            coordinates: d.points.map((p) => [p.longitude, p.latitude]),
          },
        };
      case "area":
        return {
          type: "Feature" as const,
          properties: { ...props, fillColor: d.fillColor },
          geometry: {
            type: "Polygon" as const,
            coordinates: [
              [
                ...d.points.map((p) => [p.longitude, p.latitude]),
                [d.points[0].longitude, d.points[0].latitude], // close ring
              ],
            ],
          },
        };
      case "circle":
        return {
          type: "Feature" as const,
          properties: {
            ...props,
            radiusKm: d.radiusKm,
            fillColor: d.fillColor,
          },
          geometry: {
            type: "Point" as const,
            coordinates: [d.longitude, d.latitude],
          },
        };
    }
  });
  return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
}

/**
 * Copy annotations to clipboard in multiple formats (Markdown + GeoJSON)
 */
async function copyAnnotations(): Promise<void> {
  const annotations = allAnnotations();
  if (annotations.length === 0) return;

  const md = annotationsToMarkdown(annotations);
  const geojson = annotationsToGeoJSON(annotations);
  const btn = document.getElementById("copy-btn");

  try {
    // Multi-mime clipboard: text/plain gets Markdown, text/html gets table + GeoJSON
    const htmlContent = `<table>\n<tr><th>#</th><th>Type</th><th>ID</th><th>Label</th><th>Details</th><th>Color</th></tr>\n${annotations
      .map((t, i) => {
        const d = t.def;
        let details = "";
        switch (d.type) {
          case "marker":
            details = `${d.latitude.toFixed(6)}, ${d.longitude.toFixed(6)}`;
            break;
          case "route":
            details = `${d.points.length} waypoints`;
            break;
          case "area":
            details = `${d.points.length} vertices`;
            break;
          case "circle":
            details = `${d.latitude.toFixed(6)}, ${d.longitude.toFixed(6)} r=${d.radiusKm}km`;
            break;
        }
        return `<tr><td>${i + 1}</td><td>${d.type}</td><td>${d.id}</td><td>${d.label || ""}</td><td>${details}</td><td>${d.color || (d.type === "marker" ? "red" : "blue")}</td></tr>`;
      })
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
    log.info(`Copied ${annotations.length} annotation(s) to clipboard`);
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
      log.error("Failed to copy annotations:", e2);
    }
  }
}

/**
 * Show/hide the copy button based on annotation count
 */
function updateCopyButton(): void {
  const btn = document.getElementById("copy-btn");
  if (!btn) return;
  const count = annotationMap.size;
  btn.style.display = count > 0 ? "flex" : "none";
  btn.title = `Copy ${count} annotation(s) as Markdown + GeoJSON`;
}

// =============================================================================
// Tool Input Handlers
// =============================================================================

// Track whether we've already positioned the camera from streaming
let hasPositionedFromPartial = false;

// Handle streaming tool input (progressive annotation rendering)
app.ontoolinputpartial = (params) => {
  if (!viewer) return;
  const args = params.arguments as
    | {
        west?: number;
        south?: number;
        east?: number;
        north?: number;
        latitude?: number;
        longitude?: number;
        radiusKm?: number;
        annotations?: AnnotationDef[];
      }
    | undefined;
  if (!args) return;

  // Position camera as soon as bbox/center fields are available (once)
  if (!hasPositionedFromPartial) {
    let bbox: BoundingBox | null = null;
    if (
      args.west != null &&
      args.south != null &&
      args.east != null &&
      args.north != null
    ) {
      bbox = {
        west: args.west,
        south: args.south,
        east: args.east,
        north: args.north,
      };
    } else if (args.latitude != null && args.longitude != null) {
      bbox = bboxFromCenter(args.latitude, args.longitude, args.radiusKm ?? 50);
    }
    if (bbox) {
      hasPositionedFromPartial = true;
      hasReceivedToolInput = true;
      setViewToBoundingBox(viewer, bbox);
      hideLoading();
      log.info("Positioned camera from streaming partial");
    }
  }

  // Process annotations (all but last which may be truncated)
  if (!args.annotations || args.annotations.length === 0) return;
  const safe = args.annotations.slice(0, -1);
  for (const ann of safe) {
    if (!ann.id || !ann.type) continue;
    // Validate required fields per type to avoid creating broken entities
    if (
      ann.type === "marker" &&
      (ann.latitude == null || ann.longitude == null)
    )
      continue;
    if (
      ann.type === "circle" &&
      (ann.latitude == null || ann.longitude == null || ann.radiusKm == null)
    )
      continue;
    if (
      (ann.type === "route" || ann.type === "area") &&
      (!ann.points || ann.points.length === 0)
    )
      continue;
    // Idempotent upsert: addAnnotation already handles existing IDs
    addAnnotation(viewer, ann);
  }
};

// Handle initial tool input (bounding box or center+radius from show-map tool)
app.ontoolinput = async (params) => {
  log.info("Received tool input:", params);
  const args = params.arguments as
    | {
        boundingBox?: BoundingBox;
        west?: number;
        south?: number;
        east?: number;
        north?: number;
        latitude?: number;
        longitude?: number;
        radiusKm?: number;
        label?: string;
        annotations?: AnnotationDef[];
      }
    | undefined;

  if (args && viewer) {
    // Resolve bounding box
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
    } else if (args.latitude !== undefined && args.longitude !== undefined) {
      bbox = bboxFromCenter(args.latitude, args.longitude, args.radiusKm ?? 50);
    }

    // Only position camera if we haven't already (from streaming partial).
    // If the user panned/zoomed during streaming, don't override their view.
    if (bbox && !hasPositionedFromPartial) {
      hasReceivedToolInput = true;
      log.info("Positioning camera to bbox:", bbox);
      setViewToBoundingBox(viewer, bbox);
    }

    // Add annotations immediately (before waiting for tiles so they appear ASAP)
    if (args.annotations && args.annotations.length > 0) {
      for (const ann of args.annotations) {
        addAnnotation(viewer, ann);
      }
      log.info(
        "Added",
        args.annotations.length,
        "initial annotation(s) from tool input",
      );
    }

    if (bbox && !hasPositionedFromPartial) {
      await waitForTilesLoaded(viewer);
      hideLoading();
      log.info(
        "Camera positioned, tiles loaded. Height:",
        viewer.camera.positionCartographic.height,
      );
    }
  }
};

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

  // Restore persisted annotations first, then add any new initial ones
  if (viewer && viewUUID) {
    restorePersistedAnnotations(viewer);
  }

  // Add initial annotations from _meta (if any — skips duplicates via annotationMap)
  const initialAnnotations = result._meta?.initialAnnotations as
    | AnnotationDef[]
    | undefined;
  if (viewer && initialAnnotations && initialAnnotations.length > 0) {
    for (const ann of initialAnnotations) {
      if (!annotationMap.has(ann.id)) {
        addAnnotation(viewer, ann);
      }
    }
    log.info(
      "Added",
      initialAnnotations.length,
      "initial annotation(s) from tool result",
    );
  }

  // Ensure all current annotations are persisted (initial annotations from ontoolinput
  // were added before viewUUID was set, so persistAnnotations() was a no-op then)
  if (viewUUID && annotationMap.size > 0) {
    persistAnnotations();
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
      copyBtn.addEventListener("click", copyAnnotations);
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
