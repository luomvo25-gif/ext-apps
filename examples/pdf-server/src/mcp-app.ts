/**
 * PDF Viewer MCP App
 *
 * Interactive PDF viewer with single-page display.
 * - Fixed height (no auto-resize)
 * - Text selection via PDF.js TextLayer
 * - Page navigation, zoom
 */
import {
  App,
  type McpUiHostContext,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/spec.types.js";
import * as pdfjsLib from "pdfjs-dist";
import { AnnotationLayer, AnnotationMode, TextLayer } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import {
  type PdfAnnotationDef,
  type Rect,
  type RectangleAnnotation,
  type CircleAnnotation,
  type LineAnnotation,
  type StampAnnotation,
  type ImageAnnotation,
  type NoteAnnotation,
  type FreetextAnnotation,
  serializeDiff,
  deserializeDiff,
  mergeAnnotations,
  computeDiff,
  isDiffEmpty,
  buildAnnotatedPdfBytes,
  importPdfjsAnnotation,
  uint8ArrayToBase64,
  convertFromModelCoords,
  convertToModelCoords,
} from "./pdf-annotations.js";
import "./global.css";
import "./mcp-app.css";

const MAX_MODEL_CONTEXT_LENGTH = 15000;
// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).href;

// PDF Standard-14 fonts from CDN (requires unpkg.com in CSP connectDomains).
// Pinned to the bundled pdfjs-dist version so font glyph indices match.
const STANDARD_FONT_DATA_URL = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/standard_fonts/`;

const log = {
  info: console.log.bind(console, "[PDF-VIEWER]"),
  error: console.error.bind(console, "[PDF-VIEWER]"),
};

/**
 * Resolve an ImageAnnotation to a src string safe for `<img src>`.
 * Returns the parsed-and-reserialized URL (`URL.href`) rather than the
 * raw input so CodeQL's taint tracker recognises the sanitisation barrier
 * (js/xss, js/client-side-unvalidated-url-redirection). Blocks
 * `javascript:` / `vbscript:` etc. The server normally resolves
 * imageUrl → imageData before enqueueing; the imageUrl branch here is
 * defense-in-depth for the server-side fetch-failure fallback.
 */
function safeImageSrc(def: {
  imageData?: string;
  mimeType?: string;
  imageUrl?: string;
}): string | undefined {
  if (def.imageData) {
    return `data:${def.mimeType || "image/png"};base64,${def.imageData}`;
  }
  if (!def.imageUrl) return undefined;
  try {
    const parsed = new URL(def.imageUrl, document.baseURI);
    if (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "data:" ||
      parsed.protocol === "blob:"
    ) {
      return parsed.href;
    }
  } catch {
    // fall through
  }
  return undefined;
}

// State
let pdfDocument: pdfjsLib.PDFDocumentProxy | null = null;
let currentPage = 1;
let totalPages = 0;
let scale = 1.0;
let pdfUrl = "";
let pdfTitle: string | undefined;
let viewUUID: string | undefined;
let interactEnabled = false;
/** Server-reported writability of the underlying file (fs.access W_OK). */
let fileWritable = false;
let currentRenderTask: { cancel: () => void } | null = null;

// Annotation types imported from ./pdf-annotations.ts

interface TrackedAnnotation {
  def: PdfAnnotationDef;
  elements: HTMLElement[];
}

// Annotation state
const annotationMap = new Map<string, TrackedAnnotation>();
const formFieldValues = new Map<string, string | boolean>();
/** Cache loaded HTMLImageElement instances by annotation ID for canvas painting. */
const imageCache = new Map<string, HTMLImageElement>();

/** Annotations imported from the PDF file (baseline for diff computation). */
let pdfBaselineAnnotations: PdfAnnotationDef[] = [];
/** Form field values stored in the PDF file itself (baseline for diff computation). */
const pdfBaselineFormValues = new Map<string, string | boolean>();

// Dirty flag — tracks unsaved local changes
let isDirty = false;
/** Whether we're currently restoring annotations (suppress dirty flag). */
let isRestoring = false;
/** Once the save button is shown, it stays visible (possibly disabled) until reload. */
let saveBtnEverShown = false;
/** True between save_pdf call and resolution; suppresses file_changed handling. */
let saveInProgress = false;
/** mtime returned by our most recent successful save_pdf. Compare against
 *  incoming file_changed.mtimeMs to suppress our own write's echo. */
let lastSavedMtime: number | null = null;
/** Incremented on every reload. Fetches/preloads from an older generation are
 *  discarded — prevents stale rangeCache entries and stale page renders. */
let loadGeneration = 0;

// Selection & interaction state
const selectedAnnotationIds = new Set<string>();
let focusedFieldName: string | null = null;

// Undo/Redo
interface EditEntry {
  type: "update" | "add" | "remove";
  id: string;
  before: PdfAnnotationDef | null;
  after: PdfAnnotationDef | null;
}
const undoStack: EditEntry[] = [];
const redoStack: EditEntry[] = [];

// PDF.js form field name → annotation IDs mapping (for annotationStorage)
const fieldNameToIds = new Map<string, string[]>();
// Radio widget annotation ID → its export value (buttonValue). pdf.js
// creates <input type=radio> without setting .value, so target.value
// defaults to "on"; this map lets the input listener report the real value.
const radioButtonValues = new Map<string, string>();
// PDF.js form field name → page number mapping
const fieldNameToPage = new Map<string, number>();
// PDF.js form field name → human-readable label (from PDF TU / alternativeText)
const fieldNameToLabel = new Map<string, string>();
// PDF.js form field name → intrinsic order index (page, then top-to-bottom Y position)
const fieldNameToOrder = new Map<string, number>();
// Cached result of doc.getFieldObjects() — needed for AnnotationLayer reset button support
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedFieldObjects: Record<string, any[]> | null = null;

// DOM Elements
const mainEl = document.querySelector(".main") as HTMLElement;
const loadingEl = document.getElementById("loading")!;
const loadingTextEl = document.getElementById("loading-text")!;
const errorEl = document.getElementById("error")!;
const errorMessageEl = document.getElementById("error-message")!;
const viewerEl = document.getElementById("viewer")!;
const canvasContainerEl = document.querySelector(".canvas-container")!;
const canvasEl = document.getElementById("pdf-canvas") as HTMLCanvasElement;
const textLayerEl = document.getElementById("text-layer")!;
const titleEl = document.getElementById("pdf-title")!;
const pageInputEl = document.getElementById("page-input") as HTMLInputElement;
const totalPagesEl = document.getElementById("total-pages")!;
const prevBtn = document.getElementById("prev-btn") as HTMLButtonElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const zoomOutBtn = document.getElementById("zoom-out-btn") as HTMLButtonElement;
const zoomInBtn = document.getElementById("zoom-in-btn") as HTMLButtonElement;
const zoomLevelEl = document.getElementById("zoom-level")!;
const fullscreenBtn = document.getElementById(
  "fullscreen-btn",
) as HTMLButtonElement;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
searchBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>`;
const searchBarEl = document.getElementById("search-bar")!;
const searchInputEl = document.getElementById(
  "search-input",
) as HTMLInputElement;
const searchMatchCountEl = document.getElementById("search-match-count")!;
const searchPrevBtn = document.getElementById(
  "search-prev-btn",
) as HTMLButtonElement;
const searchNextBtn = document.getElementById(
  "search-next-btn",
) as HTMLButtonElement;
const searchCloseBtn = document.getElementById(
  "search-close-btn",
) as HTMLButtonElement;
const highlightLayerEl = document.getElementById("highlight-layer")!;
const annotationLayerEl = document.getElementById("annotation-layer")!;
const formLayerEl = document.getElementById("form-layer") as HTMLDivElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const downloadBtn = document.getElementById(
  "download-btn",
) as HTMLButtonElement;
const confirmDialogEl = document.getElementById(
  "confirm-dialog",
) as HTMLDivElement;
const confirmTitleEl = document.getElementById("confirm-title")!;
const confirmBodyEl = document.getElementById("confirm-body")!;
const confirmDetailEl = document.getElementById("confirm-detail")!;
const confirmButtonsEl = document.getElementById("confirm-buttons")!;

// Annotation Panel DOM Elements
const annotationsPanelEl = document.getElementById("annotation-panel")!;
const annotationsPanelListEl = document.getElementById(
  "annotation-panel-list",
)!;
const annotationsPanelCountEl = document.getElementById(
  "annotation-panel-count",
)!;
const annotationsPanelCloseBtn = document.getElementById(
  "annotation-panel-close",
) as HTMLButtonElement;
const annotationsPanelResetBtn = document.getElementById(
  "annotation-panel-reset",
) as HTMLButtonElement;
const annotationsPanelClearAllBtn = document.getElementById(
  "annotation-panel-clear-all",
) as HTMLButtonElement;
const annotationsBtn = document.getElementById(
  "annotations-btn",
) as HTMLButtonElement;
const annotationsBadgeEl = document.getElementById(
  "annotations-badge",
) as HTMLElement;

// Annotation panel state
let annotationPanelOpen = false;
/** null = user hasn't manually toggled; true/false = manual preference */
let annotationPanelUserPref: boolean | null = null;

// Search state
interface SearchMatch {
  pageNum: number;
  index: number;
  length: number;
}

let searchOpen = false;
let searchQuery = "";
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const pageTextCache = new Map<number, string>();
const pageTextItemsCache = new Map<number, string[]>();
let allMatches: SearchMatch[] = [];
let currentMatchIndex = -1;

// Preload state — goToPage sets preloadPaused=true, renderPage's finally resets it.
// The preloader's while(preloadPaused) loop yields so interactive loads always win.
let preloadPaused = false;
let pagesLoaded = 0;
let preloadErrors: Array<{ page: number; err: unknown }> = [];
const loadingIndicatorEl = document.getElementById("loading-indicator")!;
const loadingIndicatorArc = loadingIndicatorEl.querySelector(
  ".loading-indicator-arc",
) as SVGCircleElement;

// Track current display mode
let currentDisplayMode: "inline" | "fullscreen" = "inline";

// Whether the user has manually zoomed (disables auto fit-to-width)
let userHasZoomed = false;

/**
 * Compute a scale that fits the PDF page width to the available container width.
 * Returns null if the container isn't visible or the page width is unavailable.
 */
async function computeFitToWidthScale(): Promise<number | null> {
  if (!pdfDocument) return null;

  try {
    const page = await pdfDocument.getPage(currentPage);
    const naturalViewport = page.getViewport({ scale: 1.0 });
    const pageWidth = naturalViewport.width;

    const container = canvasContainerEl as HTMLElement;
    const containerStyle = getComputedStyle(container);
    const paddingLeft = parseFloat(containerStyle.paddingLeft);
    const paddingRight = parseFloat(containerStyle.paddingRight);
    const availableWidth = container.clientWidth - paddingLeft - paddingRight;

    if (availableWidth <= 0 || pageWidth <= 0) return null;
    if (availableWidth >= pageWidth) return null; // Already fits

    return availableWidth / pageWidth;
  } catch {
    return null;
  }
}

/**
 * Request the host to resize the app to fit the current PDF page.
 * Only applies in inline mode - fullscreen mode uses scrolling.
 */
function requestFitToContent() {
  if (currentDisplayMode === "fullscreen") {
    return; // Fullscreen uses scrolling
  }

  const canvasHeight = canvasEl.height;
  if (canvasHeight <= 0) {
    return; // No content yet
  }

  // Get actual element dimensions
  const canvasContainerEl = document.querySelector(
    ".canvas-container",
  ) as HTMLElement;
  const pageWrapperEl = document.querySelector(".page-wrapper") as HTMLElement;
  const toolbarEl = document.querySelector(".toolbar") as HTMLElement;

  if (!canvasContainerEl || !toolbarEl || !pageWrapperEl) {
    return;
  }

  // Get computed styles
  const containerStyle = getComputedStyle(canvasContainerEl);
  const paddingTop = parseFloat(containerStyle.paddingTop);
  const paddingBottom = parseFloat(containerStyle.paddingBottom);

  // Calculate required height:
  // toolbar + padding-top + page-wrapper height + padding-bottom + buffer
  // Note: search bar is absolutely positioned over the document area, so excluded
  const toolbarHeight = toolbarEl.offsetHeight;
  const pageWrapperHeight = pageWrapperEl.offsetHeight;
  const BUFFER = 10; // Buffer for sub-pixel rounding and browser quirks
  const totalHeight =
    toolbarHeight + paddingTop + pageWrapperHeight + paddingBottom + BUFFER;

  // In inline mode (this function early-returns for fullscreen) the side panel is hidden
  const totalWidth = pageWrapperEl.offsetWidth + BUFFER;

  app.sendSizeChanged({ width: totalWidth, height: totalHeight });
}

// --- Search Functions ---

function performSearch(query: string) {
  allMatches = [];
  currentMatchIndex = -1;
  searchQuery = query;

  if (!query) {
    updateSearchUI();
    clearHighlights();
    return;
  }

  const lowerQuery = query.toLowerCase();
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageText = pageTextCache.get(pageNum);
    if (!pageText) continue;
    const lowerText = pageText.toLowerCase();
    let startIdx = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerQuery, startIdx);
      if (idx === -1) break;
      allMatches.push({ pageNum, index: idx, length: query.length });
      startIdx = idx + 1;
    }
  }

  // Set current match to first match on or after current page
  if (allMatches.length > 0) {
    const idx = allMatches.findIndex((m) => m.pageNum >= currentPage);
    currentMatchIndex = idx >= 0 ? idx : 0;
  }

  updateSearchUI();
  renderHighlights();

  // Navigate to match page if needed
  if (allMatches.length > 0 && currentMatchIndex >= 0) {
    const match = allMatches[currentMatchIndex];
    if (match.pageNum !== currentPage) {
      goToPage(match.pageNum);
    }
  }

  // Update model context with search results
  updatePageContext();
}

/**
 * Silent search: populate matches and report via model context
 * without opening the search bar or rendering highlights.
 */
function performSilentSearch(query: string) {
  allMatches = [];
  currentMatchIndex = -1;
  searchQuery = query;

  if (!query) {
    updatePageContext();
    return;
  }

  const lowerQuery = query.toLowerCase();
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageText = pageTextCache.get(pageNum);
    if (!pageText) continue;
    const lowerText = pageText.toLowerCase();
    let startIdx = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerQuery, startIdx);
      if (idx === -1) break;
      allMatches.push({ pageNum, index: idx, length: query.length });
      startIdx = idx + 1;
    }
  }

  if (allMatches.length > 0) {
    const idx = allMatches.findIndex((m) => m.pageNum >= currentPage);
    currentMatchIndex = idx >= 0 ? idx : 0;
  }

  log.info(`Silent search "${query}": ${allMatches.length} matches`);
  updatePageContext();
}

function renderHighlights() {
  clearHighlights();
  if (!searchQuery || allMatches.length === 0) return;

  const spans = Array.from(
    textLayerEl.querySelectorAll("span"),
  ) as HTMLElement[];
  if (spans.length === 0) return;

  const pageMatches = allMatches.filter((m) => m.pageNum === currentPage);
  if (pageMatches.length === 0) return;

  const lowerQuery = searchQuery.toLowerCase();
  const lowerQueryLen = lowerQuery.length;

  // Position highlight divs over matching text using Range API.
  const wrapperEl = textLayerEl.parentElement!;
  const wrapperRect = wrapperEl.getBoundingClientRect();

  let domMatchOrdinal = 0;

  for (const span of spans) {
    const text = span.textContent || "";
    if (text.length === 0) continue;
    const lowerText = text.toLowerCase();
    if (!lowerText.includes(lowerQuery)) continue;

    // Find all match positions within this span
    const matchPositions: number[] = [];
    let pos = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerQuery, pos);
      if (idx === -1) break;
      matchPositions.push(idx);
      pos = idx + 1;
    }
    if (matchPositions.length === 0) continue;

    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;

    for (const idx of matchPositions) {
      const isCurrentMatch =
        domMatchOrdinal < pageMatches.length &&
        allMatches.indexOf(pageMatches[domMatchOrdinal]) === currentMatchIndex;

      try {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, Math.min(idx + lowerQueryLen, text.length));
        const rects = range.getClientRects();

        for (let ri = 0; ri < rects.length; ri++) {
          const r = rects[ri];
          const div = document.createElement("div");
          div.className =
            "search-highlight" + (isCurrentMatch ? " current" : "");
          div.style.position = "absolute";
          div.style.left = `${r.left - wrapperRect.left}px`;
          div.style.top = `${r.top - wrapperRect.top}px`;
          div.style.width = `${r.width}px`;
          div.style.height = `${r.height}px`;
          highlightLayerEl.appendChild(div);
        }
      } catch {
        // Range errors can happen with stale text nodes
      }

      domMatchOrdinal++;
    }
  }

  // Scroll current highlight into view only if not already visible
  const currentHL = highlightLayerEl.querySelector(
    ".search-highlight.current",
  ) as HTMLElement;
  if (currentHL) {
    const scrollParent =
      currentDisplayMode === "fullscreen"
        ? document.querySelector(".canvas-container")
        : null;
    if (scrollParent) {
      const sr = scrollParent.getBoundingClientRect();
      const hr = currentHL.getBoundingClientRect();
      if (hr.top < sr.top || hr.bottom > sr.bottom) {
        currentHL.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } else {
      // Inline mode: check visibility in viewport
      const hr = currentHL.getBoundingClientRect();
      if (hr.top < 0 || hr.bottom > window.innerHeight) {
        currentHL.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }
}

function clearHighlights() {
  highlightLayerEl.innerHTML = "";
}

function updateSearchUI() {
  const hasQuery = searchQuery.length > 0;
  const stillLoading = totalPages > 0 && pagesLoaded < totalPages;
  const suffix = stillLoading ? " (loading\u2026)" : "";
  if (allMatches.length === 0) {
    searchMatchCountEl.textContent = hasQuery ? `No matches${suffix}` : "";
  } else {
    searchMatchCountEl.textContent = `${currentMatchIndex + 1} of ${allMatches.length}${suffix}`;
  }
  searchPrevBtn.disabled = allMatches.length === 0;
  searchNextBtn.disabled = allMatches.length === 0;
  // Hide nav controls when there's no query
  const vis = hasQuery ? "" : "none";
  searchMatchCountEl.style.display = vis;
  searchPrevBtn.style.display = vis;
  searchNextBtn.style.display = vis;
}

function openSearch() {
  if (searchOpen) {
    searchInputEl.focus();
    searchInputEl.select();
    return;
  }
  searchOpen = true;
  searchBarEl.style.display = "flex";
  updateSearchUI();
  searchInputEl.focus();
  if (
    annotationPanelOpen &&
    annotationsPanelEl.classList.contains("floating")
  ) {
    applyFloatingPanelPosition();
  }
  // Text extraction is handled by the background preloader
}

function closeSearch() {
  if (!searchOpen) return;
  searchOpen = false;
  searchBarEl.style.display = "none";
  if (
    annotationPanelOpen &&
    annotationsPanelEl.classList.contains("floating")
  ) {
    applyFloatingPanelPosition();
  }
  searchQuery = "";
  searchInputEl.value = "";
  allMatches = [];
  currentMatchIndex = -1;
  clearHighlights();
  updateSearchUI();
}

function toggleSearch() {
  if (searchOpen) {
    closeSearch();
  } else {
    openSearch();
  }
}

function goToNextMatch() {
  if (allMatches.length === 0) return;
  currentMatchIndex = (currentMatchIndex + 1) % allMatches.length;
  const match = allMatches[currentMatchIndex];
  updateSearchUI();
  if (match.pageNum !== currentPage) {
    goToPage(match.pageNum);
  } else {
    renderHighlights();
  }
}

function goToPrevMatch() {
  if (allMatches.length === 0) return;
  currentMatchIndex =
    (currentMatchIndex - 1 + allMatches.length) % allMatches.length;
  const match = allMatches[currentMatchIndex];
  updateSearchUI();
  if (match.pageNum !== currentPage) {
    goToPage(match.pageNum);
  } else {
    renderHighlights();
  }
}

// Create app instance
// autoResize disabled - app fills its container, doesn't request size changes
const app = new App(
  { name: "PDF Viewer", version: "1.0.0" },
  {},
  { autoResize: false },
);

// UI State functions
function showLoading(text: string) {
  loadingTextEl.textContent = text;
  loadingEl.style.display = "flex";
  errorEl.style.display = "none";
  viewerEl.style.display = "none";
}

function showError(message: string) {
  errorMessageEl.textContent = message;
  loadingEl.style.display = "none";
  errorEl.style.display = "block";
  viewerEl.style.display = "none";
}

function showViewer() {
  loadingEl.style.display = "none";
  errorEl.style.display = "none";
  viewerEl.style.display = "flex";
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmButton {
  label: string;
  primary?: boolean;
}

let activeConfirmResolve: ((i: number) => void) | null = null;

/**
 * In-app confirmation overlay. Resolves to the clicked button index, the
 * cancel index on Escape, or `-1` if pre-empted by another dialog. Callers
 * should treat anything but the expected button index as "cancel".
 *
 * Button ordering follows the host's native convention: Cancel first,
 * primary action last.
 *
 * @param detail Optional monospace string shown in a bordered box (e.g.
 *   a filename), matching the host's native dialog style.
 */
function showConfirmDialog(
  title: string,
  body: string,
  buttons: ConfirmButton[],
  detail?: string,
): Promise<number> {
  // Pre-empt any open dialog: resolve it as cancelled
  if (activeConfirmResolve) {
    activeConfirmResolve(-1);
    activeConfirmResolve = null;
  }

  // Escape → first non-primary button (native Cancel-first ordering)
  const nonPrimary = buttons.findIndex((b) => !b.primary);
  const escIndex = nonPrimary >= 0 ? nonPrimary : buttons.length - 1;

  confirmTitleEl.textContent = title;
  confirmBodyEl.textContent = body;
  confirmDetailEl.textContent = detail ?? "";
  confirmButtonsEl.innerHTML = "";
  confirmDialogEl.style.display = "flex";

  return new Promise<number>((resolve) => {
    activeConfirmResolve = resolve;

    const done = (i: number): void => {
      if (activeConfirmResolve !== resolve) return; // already pre-empted
      activeConfirmResolve = null;
      confirmDialogEl.style.display = "none";
      document.removeEventListener("keydown", onKey, true);
      resolve(i);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(escIndex);
      }
    };
    document.addEventListener("keydown", onKey, true);

    buttons.forEach((btn, i) => {
      const el = document.createElement("button");
      el.textContent = btn.label;
      el.className = btn.primary
        ? "confirm-btn confirm-btn-primary"
        : "confirm-btn";
      el.addEventListener("click", () => done(i));
      confirmButtonsEl.appendChild(el);
      if (btn.primary) setTimeout(() => el.focus(), 0);
    });
  });
}

function setDirty(dirty: boolean): void {
  if (isDirty === dirty) return;
  isDirty = dirty;
  updateTitleDisplay();
  updateSaveBtn();
}

function updateSaveBtn(): void {
  if (!fileWritable) {
    saveBtn.style.display = "none";
    return;
  }
  if (isDirty) {
    saveBtn.style.display = "";
    saveBtn.disabled = false;
    saveBtnEverShown = true;
  } else if (saveBtnEverShown) {
    saveBtn.style.display = "";
    saveBtn.disabled = true;
  } else {
    saveBtn.style.display = "none";
  }
}

function updateTitleDisplay(): void {
  const display = pdfTitle || pdfUrl;
  titleEl.textContent = (isDirty ? "* " : "") + display;
  titleEl.title = pdfUrl;
}

/**
 * Debug overlay: fixed-position bubble, bottom-left. Pretty-printed JSON
 * dump of whatever the server stuffed into `_meta._debug`. Tooltips inside
 * sandboxed iframes are unreliable; this survives the cross-origin barrier
 * and shows up in screenshots.
 */
function showDebugBubble(debug: unknown): void {
  const bubble = document.createElement("div");
  const base =
    "position:fixed;bottom:8px;left:8px;z-index:99999;" +
    "background:rgba(20,20,30,0.92);color:#cfe;padding:8px 12px;" +
    "font:11px/1.4 monospace;border-radius:6px;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.4);white-space:pre;cursor:pointer;" +
    "transition:max-width 0.15s ease;";
  // Collapsed: clip to 60vw. Hover: expand to fit full paths (up to ~96vw),
  // scrollable both axes in case the JSON is tall.
  const collapsed =
    base +
    "max-width:60vw;max-height:40vh;overflow:hidden;text-overflow:ellipsis;";
  const expanded =
    base + "max-width:calc(100vw - 32px);max-height:80vh;overflow:auto;";
  bubble.style.cssText = collapsed;
  // Latch expanded on click so hover-collapse doesn't fight text selection.
  let pinned = false;
  bubble.onmouseenter = () => {
    bubble.style.cssText = expanded;
  };
  bubble.onmouseleave = () => {
    if (!pinned) bubble.style.cssText = collapsed;
  };
  bubble.onclick = () => {
    pinned = true;
    bubble.style.cssText = expanded;
  };
  bubble.ondblclick = () => bubble.remove();
  bubble.title = "Click: pin open • Double-click: dismiss";
  bubble.textContent = "🐞 " + JSON.stringify(debug, null, 2);
  document.body.appendChild(bubble);
}

function updateControls() {
  // Show URL with CSS ellipsis, full URL as tooltip, clickable to open
  updateTitleDisplay();
  titleEl.style.textDecoration = "underline";
  titleEl.style.cursor = "pointer";
  titleEl.onclick = () => app.openLink({ url: pdfUrl });
  pageInputEl.value = String(currentPage);
  pageInputEl.max = String(totalPages);
  totalPagesEl.textContent = `of ${totalPages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
  zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
}

/**
 * Format page text with optional selection, truncating intelligently.
 * - Centers window around selection when truncating
 * - Adds <truncated-content/> markers where text is elided
 * - If selection itself is too long, truncates inside: <pdf-selection><truncated-content/>...<truncated-content/></pdf-selection>
 */
function formatPageContent(
  text: string,
  maxLength: number,
  selection?: { start: number; end: number },
): string {
  const T = "<truncated-content/>";

  // No truncation needed
  if (text.length <= maxLength) {
    if (!selection) return text;
    return (
      text.slice(0, selection.start) +
      `<pdf-selection>${text.slice(selection.start, selection.end)}</pdf-selection>` +
      text.slice(selection.end)
    );
  }

  // Truncation needed, no selection - just truncate end
  if (!selection) {
    return text.slice(0, maxLength) + "\n" + T;
  }

  // Calculate budgets
  const selLen = selection.end - selection.start;
  const overhead = "<pdf-selection></pdf-selection>".length + T.length * 2 + 4;
  const contextBudget = maxLength - overhead;

  // Selection too long - truncate inside the selection tags
  if (selLen > contextBudget) {
    const keepLen = Math.max(100, contextBudget);
    const halfKeep = Math.floor(keepLen / 2);
    const selStart = text.slice(selection.start, selection.start + halfKeep);
    const selEnd = text.slice(selection.end - halfKeep, selection.end);
    return (
      T + `<pdf-selection>${T}${selStart}...${selEnd}${T}</pdf-selection>` + T
    );
  }

  // Selection fits - center it with context
  const remainingBudget = contextBudget - selLen;
  const beforeBudget = Math.floor(remainingBudget / 2);
  const afterBudget = remainingBudget - beforeBudget;

  const windowStart = Math.max(0, selection.start - beforeBudget);
  const windowEnd = Math.min(text.length, selection.end + afterBudget);

  const adjStart = selection.start - windowStart;
  const adjEnd = selection.end - windowStart;
  const windowText = text.slice(windowStart, windowEnd);

  return (
    (windowStart > 0 ? T + "\n" : "") +
    windowText.slice(0, adjStart) +
    `<pdf-selection>${windowText.slice(adjStart, adjEnd)}</pdf-selection>` +
    windowText.slice(adjEnd) +
    (windowEnd < text.length ? "\n" + T : "")
  );
}

/**
 * Find selection position in page text using fuzzy matching.
 * TextLayer spans may lack spaces between them, so we try both exact and spaceless match.
 */
function findSelectionInText(
  pageText: string,
  selectedText: string,
): { start: number; end: number } | undefined {
  if (!selectedText || selectedText.length <= 2) return undefined;

  // Try exact match
  let start = pageText.indexOf(selectedText);
  if (start >= 0) {
    return { start, end: start + selectedText.length };
  }

  // Try spaceless match (TextLayer spans may not have spaces)
  const noSpaceSel = selectedText.replace(/\s+/g, "");
  const noSpaceText = pageText.replace(/\s+/g, "");
  const noSpaceStart = noSpaceText.indexOf(noSpaceSel);
  if (noSpaceStart >= 0) {
    // Map back to approximate position in original
    start = Math.floor((noSpaceStart / noSpaceText.length) * pageText.length);
    return { start, end: start + selectedText.length };
  }

  return undefined;
}

/**
 * Format search results with excerpts for model context.
 * Limits to first 20 matches to avoid overwhelming the context.
 */
function formatSearchResults(): string {
  const MAX_RESULTS = 20;
  const EXCERPT_RADIUS = 40; // characters around the match

  const lines: string[] = [];
  const totalMatchCount = allMatches.length;
  const currentIdx = currentMatchIndex >= 0 ? currentMatchIndex : -1;

  lines.push(
    `\nSearch: "${searchQuery}" (${totalMatchCount} match${totalMatchCount !== 1 ? "es" : ""} across ${new Set(allMatches.map((m) => m.pageNum)).size} page${new Set(allMatches.map((m) => m.pageNum)).size !== 1 ? "s" : ""})`,
  );

  const displayed = allMatches.slice(0, MAX_RESULTS);
  for (let i = 0; i < displayed.length; i++) {
    const match = displayed[i];
    const pageText = pageTextCache.get(match.pageNum) || "";
    const start = Math.max(0, match.index - EXCERPT_RADIUS);
    const end = Math.min(
      pageText.length,
      match.index + match.length + EXCERPT_RADIUS,
    );
    const before = pageText.slice(start, match.index).replace(/\n/g, " ");
    const matched = pageText.slice(match.index, match.index + match.length);
    const after = pageText
      .slice(match.index + match.length, end)
      .replace(/\n/g, " ");
    const prefix = start > 0 ? "..." : "";
    const suffix = end < pageText.length ? "..." : "";
    const current = i === currentIdx ? " (current)" : "";
    lines.push(
      `  [${i}] p.${match.pageNum}, offset ${match.index}${current}: ${prefix}${before}«${matched}»${after}${suffix}`,
    );
  }
  if (totalMatchCount > MAX_RESULTS) {
    lines.push(`  ... and ${totalMatchCount - MAX_RESULTS} more matches`);
  }

  return lines.join("\n");
}

// Extract text from current page and update model context
async function updatePageContext() {
  if (!pdfDocument) return;

  try {
    const page = await pdfDocument.getPage(currentPage);
    const textContent = await page.getTextContent();
    const pageText = (textContent.items as Array<{ str?: string }>)
      .map((item) => item.str || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    // Find selection position
    const sel = window.getSelection();
    const selectedText = sel?.toString().replace(/\s+/g, " ").trim();
    const selection = selectedText
      ? findSelectionInText(pageText, selectedText)
      : undefined;

    if (selection) {
      log.info(
        "Selection found:",
        selectedText?.slice(0, 30),
        "at",
        selection.start,
      );
    }

    // Format content with selection markers and truncation
    const content = formatPageContent(
      pageText,
      MAX_MODEL_CONTEXT_LENGTH,
      selection,
    );

    // Get page dimensions in PDF points for model context
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidthPt = Math.round(viewport.width);
    const pageHeightPt = Math.round(viewport.height);

    // Build context with tool ID for multi-tool disambiguation
    const toolId = app.getHostContext()?.toolInfo?.id;
    const header = [
      `PDF viewer${toolId ? ` (${toolId})` : ""}`,
      viewUUID ? `viewUUID: ${viewUUID}` : null,
      pdfTitle ? `"${pdfTitle}"` : pdfUrl,
      `Current Page: ${currentPage}/${totalPages}`,
      `Page size: ${pageWidthPt}×${pageHeightPt}pt (coordinates: origin at top-left, Y increases downward)`,
    ]
      .filter(Boolean)
      .join(" | ");

    // Include search status if active
    let searchSection = "";
    if (searchOpen && searchQuery && allMatches.length > 0) {
      searchSection = formatSearchResults();
    } else if (searchOpen && searchQuery) {
      searchSection = `\nSearch: "${searchQuery}" (no matches found)`;
    }

    // Include annotation details if any exist
    let annotationSection = "";
    if (annotationMap.size > 0) {
      const onThisPage = [...annotationMap.values()].filter(
        (t) => t.def.page === currentPage,
      );
      annotationSection = `\nAnnotations: ${onThisPage.length} on this page, ${annotationMap.size} total`;
      if (formFieldValues.size > 0) {
        annotationSection += ` | ${formFieldValues.size} form field(s) filled`;
      }
      // List annotations on current page with their coordinates (in model space)
      if (onThisPage.length > 0) {
        annotationSection +=
          "\nAnnotations on this page (visible in screenshot):";
        for (const t of onThisPage) {
          const d = convertToModelCoords(t.def, pageHeightPt);
          const selected = selectedAnnotationIds.has(d.id) ? " (SELECTED)" : "";
          if ("rects" in d && d.rects.length > 0) {
            const r = d.rects[0];
            annotationSection += `\n  [${d.id}] ${d.type} at (${Math.round(r.x)},${Math.round(r.y)}) ${Math.round(r.width)}x${Math.round(r.height)}${selected}`;
          } else if ("x" in d && "y" in d) {
            annotationSection += `\n  [${d.id}] ${d.type} at (${Math.round(d.x)},${Math.round(d.y)})${selected}`;
          }
        }
      }
    }

    // Include focused field or selected annotation info
    let focusSection = "";
    if (selectedAnnotationIds.size > 0) {
      const ids = [...selectedAnnotationIds];
      const descs = ids.map((selId) => {
        const tracked = annotationMap.get(selId);
        if (!tracked) return selId;
        return `[${selId}] (${tracked.def.type})`;
      });
      focusSection = `\nSelected: ${descs.join(", ")}`;
    }
    if (focusedFieldName) {
      const label = getFormFieldLabel(focusedFieldName);
      const value = formFieldValues.get(focusedFieldName);
      focusSection += `\nFocused field: "${label}" (name="${focusedFieldName}")`;
      if (value !== undefined) {
        focusSection += ` = ${JSON.stringify(value)}`;
      }
    }

    const contextText = `${header}${searchSection}${annotationSection}${focusSection}\n\nPage content:\n${content}`;

    // Build content array with text and optional screenshot
    const contentBlocks: ContentBlock[] = [{ type: "text", text: contextText }];

    // Add screenshot if host supports image content
    if (app.getHostCapabilities()?.updateModelContext?.image) {
      try {
        // Render offscreen with ENABLE_STORAGE so filled form fields are visible
        const base64Data = await renderPageOffscreen(currentPage);
        if (base64Data) {
          contentBlocks.push({
            type: "image",
            data: base64Data,
            mimeType: "image/jpeg",
          });
          log.info("Added screenshot to model context");
        }
      } catch (err) {
        log.info("Failed to capture screenshot:", err);
      }
    }

    app.updateModelContext({ content: contentBlocks });
  } catch (err) {
    log.error("Error updating context:", err);
  }
}

// =============================================================================
// Annotation Rendering
// =============================================================================

/**
 * Convert PDF coordinates (bottom-left origin) to screen coordinates
 * relative to the page wrapper. PDF.js viewport handles rotation and scale.
 */
function pdfRectToScreen(
  rect: Rect,
  viewport: { width: number; height: number; scale: number },
): { left: number; top: number; width: number; height: number } {
  const s = viewport.scale;
  // PDF origin is bottom-left, screen origin is top-left
  const left = rect.x * s;
  const top = viewport.height - (rect.y + rect.height) * s;
  const width = rect.width * s;
  const height = rect.height * s;
  return { left, top, width, height };
}

function pdfPointToScreen(
  x: number,
  y: number,
  viewport: { width: number; height: number; scale: number },
): { left: number; top: number } {
  const s = viewport.scale;
  return { left: x * s, top: viewport.height - y * s };
}

/** Convert a screen-space delta (pixels) to a PDF-space delta. */
function screenToPdfDelta(dx: number, dy: number): { dx: number; dy: number } {
  return { dx: dx / scale, dy: -dy / scale };
}

// =============================================================================
// Undo / Redo
// =============================================================================

function pushEdit(entry: EditEntry): void {
  undoStack.push(entry);
  redoStack.length = 0;
}

function undo(): void {
  const entry = undoStack.pop();
  if (!entry) return;
  redoStack.push(entry);
  applyEdit(entry, true);
}

function redo(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  undoStack.push(entry);
  applyEdit(entry, false);
}

function applyEdit(entry: EditEntry, reverse: boolean): void {
  const state = reverse ? entry.before : entry.after;
  if (entry.type === "add") {
    if (reverse) {
      removeAnnotation(entry.id, true);
    } else {
      addAnnotation(state!, true);
    }
  } else if (entry.type === "remove") {
    if (reverse) {
      addAnnotation(state!, true);
    } else {
      removeAnnotation(entry.id, true);
    }
  } else {
    if (state) {
      const tracked = annotationMap.get(entry.id);
      if (tracked) {
        tracked.def = { ...state };
      } else {
        annotationMap.set(entry.id, { def: { ...state }, elements: [] });
      }
    }
    renderAnnotationsForPage(currentPage);
    renderAnnotationPanel();
  }
  persistAnnotations();
}

// =============================================================================
// Selection
// =============================================================================

/**
 * Select annotation(s). Pass null to deselect all.
 * If additive is true, toggle the given id without clearing existing selection.
 */
function selectAnnotation(id: string | null, additive = false): void {
  if (!additive) {
    // Clear all existing selection visuals
    for (const prevId of selectedAnnotationIds) {
      const tracked = annotationMap.get(prevId);
      if (tracked) {
        for (const el of tracked.elements) {
          el.classList.remove("annotation-selected");
        }
      }
    }
    // Remove handles
    for (const h of annotationLayerEl.querySelectorAll(
      ".annotation-handle, .annotation-handle-rotate",
    )) {
      h.remove();
    }
    selectedAnnotationIds.clear();
  }

  if (id) {
    if (additive && selectedAnnotationIds.has(id)) {
      // Toggle off
      selectedAnnotationIds.delete(id);
      const tracked = annotationMap.get(id);
      if (tracked) {
        for (const el of tracked.elements) {
          el.classList.remove("annotation-selected");
        }
      }
    } else {
      selectedAnnotationIds.add(id);
    }
  }

  // Apply selection visuals + handles on all selected
  // Only show handles when exactly one annotation is selected
  for (const selId of selectedAnnotationIds) {
    const tracked = annotationMap.get(selId);
    if (tracked) {
      for (const el of tracked.elements) {
        el.classList.add("annotation-selected");
      }
      if (selectedAnnotationIds.size === 1) {
        showHandles(tracked);
      }
    }
  }

  // Auto-expand the accordion section for the selected annotation's page
  if (id) {
    const tracked = annotationMap.get(id);
    if (tracked) {
      openAccordionSection = `page-${tracked.def.page}`;
    }
  }

  // Sync sidebar
  syncSidebarSelection();
  // Auto-dock floating panel away from selected annotation
  if (
    selectedAnnotationIds.size > 0 &&
    annotationsPanelEl.classList.contains("floating") &&
    annotationPanelOpen
  ) {
    autoDockPanel();
  }
  // Update model context with selection info
  updatePageContext();
}

function syncSidebarSelection(): void {
  for (const card of annotationsPanelListEl.querySelectorAll(
    ".annotation-card",
  )) {
    const cardId = (card as HTMLElement).dataset.annotationId;
    card.classList.toggle(
      "selected",
      !!cardId && selectedAnnotationIds.has(cardId),
    );
  }
}

/** Types that support resize handles (need width/height). */
const RESIZABLE_TYPES = new Set<string>(["rectangle", "circle", "image"]);
/** Types that support rotation. */
const ROTATABLE_TYPES = new Set<string>(["rectangle", "stamp", "image"]);

function showHandles(tracked: TrackedAnnotation): void {
  const def = tracked.def;
  if (tracked.elements.length === 0) return;
  if (!RESIZABLE_TYPES.has(def.type) && !ROTATABLE_TYPES.has(def.type)) return;

  const el = tracked.elements[0];

  // Resize handles (corners) for types with width/height
  if (RESIZABLE_TYPES.has(def.type) && "width" in def && "height" in def) {
    for (const corner of ["nw", "ne", "sw", "se"] as const) {
      const handle = document.createElement("div");
      handle.className = `annotation-handle ${corner}`;
      handle.dataset.corner = corner;
      const isImagePreserve =
        def.type === "image" &&
        ((def as ImageAnnotation).aspect ?? "preserve") === "preserve";
      handle.title = isImagePreserve
        ? "Drag to resize (Shift for free resize)"
        : "Drag to resize (Shift to keep proportions)";
      setupResizeHandle(handle, tracked, corner);
      el.appendChild(handle);
    }
  }

  // Rotate handle for rotatable types
  if (ROTATABLE_TYPES.has(def.type)) {
    const handle = document.createElement("div");
    handle.className = "annotation-handle-rotate";
    handle.title = "Drag to rotate";
    setupRotateHandle(handle, tracked);
    el.appendChild(handle);
  }
}

// =============================================================================
// Drag (move)
// =============================================================================

const DRAGGABLE_TYPES = new Set<string>([
  "rectangle",
  "circle",
  "line",
  "freetext",
  "stamp",
  "note",
  "image",
]);

function setupAnnotationInteraction(
  el: HTMLElement,
  tracked: TrackedAnnotation,
): void {
  // Click to select (Shift+click for additive multi-select)
  el.addEventListener("mousedown", (e) => {
    // Ignore if clicking on a handle
    if (
      (e.target as HTMLElement).classList.contains("annotation-handle") ||
      (e.target as HTMLElement).classList.contains("annotation-handle-rotate")
    ) {
      return;
    }
    e.stopPropagation();
    selectAnnotation(tracked.def.id, e.shiftKey);

    // Start drag for draggable types (only single-select)
    if (DRAGGABLE_TYPES.has(tracked.def.type) && !e.shiftKey) {
      startDrag(e, tracked);
    }
  });

  // Double-click to send message to modify annotation (same as sidebar card)
  el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    selectAnnotation(tracked.def.id);
    const label = getAnnotationLabel(tracked.def);
    const previewText = getAnnotationPreview(tracked.def);
    const desc = previewText ? `${label}: ${previewText}` : label;
    app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `update ${desc}: ` }],
    });
  });
}

function startDrag(e: MouseEvent, tracked: TrackedAnnotation): void {
  const def = tracked.def;
  const startX = e.clientX;
  const startY = e.clientY;
  const beforeDef = { ...def } as PdfAnnotationDef;
  let moved = false;

  // Store original element positions
  const originalPositions = tracked.elements.map((el) => ({
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
  }));

  document.body.style.cursor = "grabbing";
  for (const el of tracked.elements) {
    el.classList.add("annotation-dragging");
  }

  const onMouseMove = (ev: MouseEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    // Move elements directly for smooth feedback
    for (let i = 0; i < tracked.elements.length; i++) {
      tracked.elements[i].style.left = `${originalPositions[i].left + dx}px`;
      tracked.elements[i].style.top = `${originalPositions[i].top + dy}px`;
    }
  };

  const onMouseUp = (ev: MouseEvent) => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    for (const el of tracked.elements) {
      el.classList.remove("annotation-dragging");
    }

    if (!moved) return;

    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const pdfDelta = screenToPdfDelta(dx, dy);

    // Apply move to def
    applyMoveToDef(
      tracked.def as PdfAnnotationDef & { x: number; y: number },
      pdfDelta.dx,
      pdfDelta.dy,
    );

    const afterDef = { ...tracked.def } as PdfAnnotationDef;
    pushEdit({
      type: "update",
      id: def.id,
      before: beforeDef,
      after: afterDef,
    });
    persistAnnotations();
    // Re-render to get correct positions
    renderAnnotationsForPage(currentPage);
    // Re-select to show handles
    selectAnnotation(def.id);
  };

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function applyMoveToDef(
  def: PdfAnnotationDef & { x?: number; y?: number },
  dx: number,
  dy: number,
): void {
  if (def.type === "line") {
    def.x1 += dx;
    def.y1 += dy;
    def.x2 += dx;
    def.y2 += dy;
  } else if ("x" in def && "y" in def) {
    def.x! += dx;
    def.y! += dy;
  }
}

// =============================================================================
// Resize (rectangle, circle, image)
// =============================================================================

function setupResizeHandle(
  handle: HTMLElement,
  tracked: TrackedAnnotation,
  corner: "nw" | "ne" | "sw" | "se",
): void {
  handle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();

    const def = tracked.def as
      | RectangleAnnotation
      | CircleAnnotation
      | ImageAnnotation;
    const beforeDef = { ...def };
    const startX = e.clientX;
    const startY = e.clientY;
    const aspectRatio = beforeDef.height / beforeDef.width;

    const onMouseMove = (ev: MouseEvent) => {
      const dxScreen = ev.clientX - startX;
      const dyScreen = ev.clientY - startY;
      const pdfD = screenToPdfDelta(dxScreen, dyScreen);

      // Reset to before state then apply delta
      let newX = beforeDef.x;
      let newY = beforeDef.y;
      let newW = beforeDef.width;
      let newH = beforeDef.height;

      // In PDF coords: x goes right, y goes up
      if (corner.includes("w")) {
        newX += pdfD.dx;
        newW -= pdfD.dx;
      } else {
        newW += pdfD.dx;
      }
      if (corner.includes("s")) {
        newY += pdfD.dy;
        newH -= pdfD.dy;
      } else {
        newH += pdfD.dy;
      }

      // Constrain aspect ratio:
      // - For images: preserve by default (Shift to ignore), unless aspect="ignore"
      // - For other shapes: Shift to preserve
      const isImage = def.type === "image";
      const imageAspect = isImage
        ? ((def as ImageAnnotation).aspect ?? "preserve")
        : undefined;
      const constrainAspect = isImage
        ? imageAspect === "preserve"
          ? !ev.shiftKey // preserve by default, Shift to free-resize
          : ev.shiftKey // ignore by default, Shift to constrain
        : ev.shiftKey; // non-image: Shift to constrain

      if (constrainAspect) {
        // Use the wider dimension to drive the other
        const candidateH = newW * aspectRatio;
        newH = candidateH;
        // Adjust origin for corners that anchor at bottom/left
        if (corner.includes("s")) {
          newY = beforeDef.y + beforeDef.height - newH;
        }
        if (corner.includes("w")) {
          // width changed by resize, x was already adjusted above
        }
      }

      // Enforce minimum size
      if (newW < 5) {
        newW = 5;
      }
      if (newH < 5) {
        newH = 5;
      }

      def.x = newX;
      def.y = newY;
      def.width = newW;
      def.height = newH;

      // Re-render for live feedback
      renderAnnotationsForPage(currentPage);
      selectAnnotation(def.id);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      const afterDef = { ...def };
      pushEdit({
        type: "update",
        id: def.id,
        before: beforeDef,
        after: afterDef,
      });
      persistAnnotations();
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

// =============================================================================
// Rotate (stamp, rectangle)
// =============================================================================

function setupRotateHandle(
  handle: HTMLElement,
  tracked: TrackedAnnotation,
): void {
  handle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();

    const def = tracked.def as
      | StampAnnotation
      | RectangleAnnotation
      | ImageAnnotation;
    const beforeDef = { ...def };
    const el = tracked.elements[0];
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const onMouseMove = (ev: MouseEvent) => {
      const angle = Math.atan2(ev.clientY - centerY, ev.clientX - centerX);
      // Convert to degrees, offset so 0 = pointing up
      let degrees = (angle * 180) / Math.PI + 90;
      // Normalize
      if (degrees < 0) degrees += 360;
      if (degrees > 360) degrees -= 360;
      // Snap to 15-degree increments when close
      const snapped = Math.round(degrees / 15) * 15;
      if (Math.abs(degrees - snapped) < 3) degrees = snapped;

      def.rotation = Math.round(degrees);
      renderAnnotationsForPage(currentPage);
      selectAnnotation(def.id);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      const afterDef = { ...def };
      pushEdit({
        type: "update",
        id: def.id,
        before: beforeDef,
        after: afterDef,
      });
      persistAnnotations();
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

/**
 * Paint annotations for a page onto a 2D canvas context.
 * Used to include annotations in screenshots sent to the model.
 */
function paintAnnotationsOnCanvas(
  ctx: CanvasRenderingContext2D,
  pageNum: number,
  viewport: { width: number; height: number; scale: number },
): void {
  for (const tracked of annotationMap.values()) {
    const def = tracked.def;
    if (def.page !== pageNum) continue;

    const color = getAnnotationColor(def);

    switch (def.type) {
      case "highlight":
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = def.color || "rgba(255, 255, 0, 1)";
        for (const rect of def.rects) {
          const s = pdfRectToScreen(rect, viewport);
          ctx.fillRect(s.left, s.top, s.width, s.height);
        }
        ctx.restore();
        break;

      case "underline":
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        for (const rect of def.rects) {
          const s = pdfRectToScreen(rect, viewport);
          ctx.beginPath();
          ctx.moveTo(s.left, s.top + s.height);
          ctx.lineTo(s.left + s.width, s.top + s.height);
          ctx.stroke();
        }
        ctx.restore();
        break;

      case "strikethrough":
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        for (const rect of def.rects) {
          const s = pdfRectToScreen(rect, viewport);
          const midY = s.top + s.height / 2;
          ctx.beginPath();
          ctx.moveTo(s.left, midY);
          ctx.lineTo(s.left + s.width, midY);
          ctx.stroke();
        }
        ctx.restore();
        break;

      case "note": {
        const pos = pdfPointToScreen(def.x, def.y, viewport);
        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(pos.left, pos.top - 16, 16, 16);
        ctx.restore();
        break;
      }

      case "rectangle": {
        const s = pdfRectToScreen(
          { x: def.x, y: def.y, width: def.width, height: def.height },
          viewport,
        );
        ctx.save();
        if (def.rotation) {
          const cx = s.left + s.width / 2;
          const cy = s.top + s.height / 2;
          ctx.translate(cx, cy);
          ctx.rotate((def.rotation * Math.PI) / 180);
          ctx.translate(-cx, -cy);
        }
        if (def.fillColor) {
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = def.fillColor;
          ctx.fillRect(s.left, s.top, s.width, s.height);
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(s.left, s.top, s.width, s.height);
        ctx.restore();
        break;
      }

      case "freetext": {
        const pos = pdfPointToScreen(def.x, def.y, viewport);
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = `${(def.fontSize || 12) * viewport.scale}px Helvetica, Arial, sans-serif`;
        ctx.fillText(def.content, pos.left, pos.top);
        ctx.restore();
        break;
      }

      case "stamp": {
        const pos = pdfPointToScreen(def.x, def.y, viewport);
        ctx.save();
        ctx.translate(pos.left, pos.top);
        if (def.rotation) ctx.rotate((def.rotation * Math.PI) / 180);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.6;
        ctx.font = `bold ${24 * viewport.scale}px Helvetica, Arial, sans-serif`;
        const metrics = ctx.measureText(def.label);
        const pad = 8 * viewport.scale;
        ctx.strokeRect(
          -pad,
          -24 * viewport.scale - pad,
          metrics.width + pad * 2,
          24 * viewport.scale + pad * 2,
        );
        ctx.fillText(def.label, 0, 0);
        ctx.restore();
        break;
      }

      case "circle": {
        const s = pdfRectToScreen(
          { x: def.x, y: def.y, width: def.width, height: def.height },
          viewport,
        );
        ctx.save();
        if (def.fillColor) {
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = def.fillColor;
          ctx.beginPath();
          ctx.ellipse(
            s.left + s.width / 2,
            s.top + s.height / 2,
            s.width / 2,
            s.height / 2,
            0,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(
          s.left + s.width / 2,
          s.top + s.height / 2,
          s.width / 2,
          s.height / 2,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        ctx.restore();
        break;
      }

      case "line": {
        const p1 = pdfPointToScreen(def.x1, def.y1, viewport);
        const p2 = pdfPointToScreen(def.x2, def.y2, viewport);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p1.left, p1.top);
        ctx.lineTo(p2.left, p2.top);
        ctx.stroke();
        ctx.restore();
        break;
      }

      case "image": {
        const s = pdfRectToScreen(
          { x: def.x, y: def.y, width: def.width, height: def.height },
          viewport,
        );
        // Try to draw from cache
        const cachedImg = imageCache.get(def.id);
        if (cachedImg) {
          ctx.save();
          if (def.rotation) {
            const cx = s.left + s.width / 2;
            const cy = s.top + s.height / 2;
            ctx.translate(cx, cy);
            ctx.rotate((def.rotation * Math.PI) / 180);
            ctx.translate(-cx, -cy);
          }
          ctx.drawImage(cachedImg, s.left, s.top, s.width, s.height);
          ctx.restore();
        } else {
          // Load image asynchronously into cache for next paint
          const src = safeImageSrc(def);
          if (src) {
            const img = new Image();
            img.onload = () => {
              imageCache.set(def.id, img);
            };
            img.src = src;
          }
          // Draw placeholder border
          ctx.save();
          ctx.strokeStyle = "#999";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(s.left, s.top, s.width, s.height);
          ctx.restore();
        }
        break;
      }
    }
  }
}

function renderAnnotationsForPage(pageNum: number): void {
  // Clear existing annotation elements
  annotationLayerEl.innerHTML = "";

  // Remove tracked element refs for all annotations
  for (const tracked of annotationMap.values()) {
    tracked.elements = [];
  }

  if (!pdfDocument) return;

  // Get viewport for coordinate conversion
  const vp = {
    width: parseFloat(annotationLayerEl.style.width) || 0,
    height: parseFloat(annotationLayerEl.style.height) || 0,
    scale,
  };
  if (vp.width === 0 || vp.height === 0) return;

  for (const tracked of annotationMap.values()) {
    const def = tracked.def;
    if (def.page !== pageNum) continue;

    const elements = renderAnnotation(def, vp);
    tracked.elements = elements;
    for (const el of elements) {
      // Set up selection + drag/resize/rotate interactions
      setupAnnotationInteraction(el, tracked);
      annotationLayerEl.appendChild(el);
    }
    // Restore selection state after re-render
    if (selectedAnnotationIds.has(def.id)) {
      for (const el of elements) {
        el.classList.add("annotation-selected");
      }
      if (selectedAnnotationIds.size === 1) {
        showHandles(tracked);
      }
    }
  }

  // Refresh panel to update current-page highlighting
  renderAnnotationPanel();
}

function renderAnnotation(
  def: PdfAnnotationDef,
  viewport: { width: number; height: number; scale: number },
): HTMLElement[] {
  switch (def.type) {
    case "highlight":
      return renderRectsAnnotation(
        def.rects,
        "annotation-highlight",
        viewport,
        def.color ? { background: def.color } : {},
      );
    case "underline":
      return renderRectsAnnotation(
        def.rects,
        "annotation-underline",
        viewport,
        def.color ? { borderBottomColor: def.color } : {},
      );
    case "strikethrough":
      return renderRectsAnnotation(
        def.rects,
        "annotation-strikethrough",
        viewport,
        {},
        def.color,
      );
    case "note":
      return [renderNoteAnnotation(def, viewport)];
    case "rectangle":
      return [renderRectangleAnnotation(def, viewport)];
    case "freetext":
      return [renderFreetextAnnotation(def, viewport)];
    case "stamp":
      return [renderStampAnnotation(def, viewport)];
    case "circle":
      return [renderCircleAnnotation(def, viewport)];
    case "line":
      return [renderLineAnnotation(def, viewport)];
    case "image":
      return [renderImageAnnotation(def, viewport)];
  }
}

function renderRectsAnnotation(
  rects: Rect[],
  className: string,
  viewport: { width: number; height: number; scale: number },
  extraStyles: Record<string, string>,
  strikeColor?: string,
): HTMLElement[] {
  return rects.map((rect) => {
    const screen = pdfRectToScreen(rect, viewport);
    const el = document.createElement("div");
    el.className = className;
    el.style.left = `${screen.left}px`;
    el.style.top = `${screen.top}px`;
    el.style.width = `${screen.width}px`;
    el.style.height = `${screen.height}px`;
    for (const [k, v] of Object.entries(extraStyles)) {
      (el.style as unknown as Record<string, string>)[k] = v;
    }
    if (strikeColor) {
      // Set color for the ::after pseudo-element via CSS custom property
      el.style.setProperty("--strike-color", strikeColor);
      el.querySelector("::after"); // no-op, style via CSS instead
      // Actually use inline style on a child element for the line
      const line = document.createElement("div");
      line.style.position = "absolute";
      line.style.left = "0";
      line.style.right = "0";
      line.style.top = "50%";
      line.style.borderTop = `2px solid ${strikeColor}`;
      el.appendChild(line);
    }
    return el;
  });
}

function renderNoteAnnotation(
  def: NoteAnnotation,
  viewport: { width: number; height: number; scale: number },
): HTMLElement {
  const pos = pdfPointToScreen(def.x, def.y, viewport);
  const el = document.createElement("div");
  el.className = "annotation-note";
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top - 20}px`; // offset up so note icon is at the point
  if (def.color) el.style.color = def.color;

  const tooltip = document.createElement("div");
  tooltip.className = "annotation-tooltip";
  tooltip.textContent = def.content;
  el.appendChild(tooltip);

  return el;
}

function renderRectangleAnnotation(
  def: RectangleAnnotation,
  viewport: { width: number; height: number; scale: number },
): HTMLElement {
  const screen = pdfRectToScreen(
    { x: def.x, y: def.y, width: def.width, height: def.height },
    viewport,
  );
  const el = document.createElement("div");
  el.className = "annotation-rectangle";
  el.style.left = `${screen.left}px`;
  el.style.top = `${screen.top}px`;
  el.style.width = `${screen.width}px`;
  el.style.height = `${screen.height}px`;
  if (def.color) el.style.borderColor = def.color;
  if (def.fillColor) el.style.backgroundColor = def.fillColor;
  if (def.rotation) {
    el.style.transform = `rotate(${def.rotation}deg)`;
    el.style.transformOrigin = "center center";
  }
  return el;
}

function renderFreetextAnnotation(
  def: FreetextAnnotation,
  viewport: { width: number; height: number; scale: number },
): HTMLElement {
  const pos = pdfPointToScreen(def.x, def.y, viewport);
  const el = document.createElement("div");
  el.className = "annotation-freetext";
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
  el.style.fontSize = `${(def.fontSize || 12) * viewport.scale}px`;
  if (def.color) el.style.color = def.color;
  el.textContent = def.content;
  return el;
}

function renderStampAnnotation(
  def: StampAnnotation,
  viewport: { width: number; height: number; scale: number },
): HTMLElement {
  const pos = pdfPointToScreen(def.x, def.y, viewport);
  const el = document.createElement("div");
  el.className = "annotation-stamp";
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
  el.style.fontSize = `${24 * viewport.scale}px`;
  if (def.color) el.style.color = def.color;
  if (def.rotation) {
    el.style.transform = `rotate(${def.rotation}deg)`;
    el.style.transformOrigin = "center center";
  }
  el.textContent = def.label;
  return el;
}

function renderCircleAnnotation(
  def: CircleAnnotation,
  viewport: { width: number; height: number; scale: number },
): HTMLElement {
  const screen = pdfRectToScreen(
    { x: def.x, y: def.y, width: def.width, height: def.height },
    viewport,
  );
  const el = document.createElement("div");
  el.className = "annotation-circle";
  el.style.left = `${screen.left}px`;
  el.style.top = `${screen.top}px`;
  el.style.width = `${screen.width}px`;
  el.style.height = `${screen.height}px`;
  if (def.color) el.style.borderColor = def.color;
  if (def.fillColor) el.style.backgroundColor = def.fillColor;
  return el;
}

function renderLineAnnotation(
  def: LineAnnotation,
  viewport: { width: number; height: number; scale: number },
): HTMLElement {
  const p1 = pdfPointToScreen(def.x1, def.y1, viewport);
  const p2 = pdfPointToScreen(def.x2, def.y2, viewport);
  const dx = p2.left - p1.left;
  const dy = p2.top - p1.top;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);

  const el = document.createElement("div");
  el.className = "annotation-line";
  el.style.left = `${p1.left}px`;
  el.style.top = `${p1.top}px`;
  el.style.width = `${length}px`;
  el.style.transform = `rotate(${angle}rad)`;
  el.style.transformOrigin = "0 0";
  if (def.color) el.style.borderColor = def.color;
  return el;
}

function renderImageAnnotation(
  def: ImageAnnotation,
  viewport: { width: number; height: number; scale: number },
): HTMLElement {
  const screen = pdfRectToScreen(
    { x: def.x, y: def.y, width: def.width, height: def.height },
    viewport,
  );
  const el = document.createElement("div");
  el.className = "annotation-image";
  el.style.left = `${screen.left}px`;
  el.style.top = `${screen.top}px`;
  el.style.width = `${screen.width}px`;
  el.style.height = `${screen.height}px`;
  if (def.rotation) {
    el.style.transform = `rotate(${def.rotation}deg)`;
    el.style.transformOrigin = "center center";
  }

  const imgSrc = safeImageSrc(def);
  if (imgSrc) {
    const img = document.createElement("img");
    img.src = imgSrc;
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.display = "block";
    img.style.pointerEvents = "none";
    img.draggable = false;
    el.appendChild(img);
  }
  return el;
}

// =============================================================================
// Annotation CRUD
// =============================================================================

function addAnnotation(def: PdfAnnotationDef, skipUndo = false): void {
  // Remove existing if same id (without pushing to undo)
  removeAnnotation(def.id, true);
  annotationMap.set(def.id, { def, elements: [] });
  if (!skipUndo) {
    pushEdit({ type: "add", id: def.id, before: null, after: { ...def } });
  }
  // Re-render if on current page
  if (def.page === currentPage) {
    renderAnnotationsForPage(currentPage);
  }
  updateAnnotationsBadge();
  renderAnnotationPanel();
}

function updateAnnotation(
  update: Partial<PdfAnnotationDef> & { id: string; type: string },
  skipUndo = false,
): void {
  const tracked = annotationMap.get(update.id);
  if (!tracked) return;

  const before = { ...tracked.def } as PdfAnnotationDef;

  // Merge partial update into existing def
  const merged = { ...tracked.def, ...update } as PdfAnnotationDef;
  tracked.def = merged;

  if (!skipUndo) {
    pushEdit({ type: "update", id: update.id, before, after: { ...merged } });
  }

  // Re-render if on current page
  if (merged.page === currentPage) {
    renderAnnotationsForPage(currentPage);
  }
  renderAnnotationPanel();
}

function removeAnnotation(id: string, skipUndo = false): void {
  const tracked = annotationMap.get(id);
  if (!tracked) return;
  if (!skipUndo) {
    pushEdit({ type: "remove", id, before: { ...tracked.def }, after: null });
  }
  for (const el of tracked.elements) el.remove();
  annotationMap.delete(id);
  selectedAnnotationIds.delete(id);
  updateAnnotationsBadge();
  renderAnnotationPanel();
}

// =============================================================================
// Annotation Panel
// =============================================================================

/** Get inset margins for the floating panel (safe area + padding). */
function getFloatingPanelInsets(): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const insets = { top: 4, right: 4, bottom: 4, left: 4 };
  const ctx = app.getHostContext();
  if (ctx?.safeAreaInsets) {
    insets.top += ctx.safeAreaInsets.top;
    insets.right += ctx.safeAreaInsets.right;
    insets.bottom += ctx.safeAreaInsets.bottom;
    insets.left += ctx.safeAreaInsets.left;
  }
  return insets;
}

/** Position the floating panel based on its anchored corner. */
function applyFloatingPanelPosition(): void {
  const el = annotationsPanelEl;
  // Reset all position props
  el.style.top = "";
  el.style.bottom = "";
  el.style.left = "";
  el.style.right = "";

  const insets = getFloatingPanelInsets();

  // When search bar is visible and panel is anchored top-right, offset below it
  const searchBarExtra =
    searchOpen && floatingPanelCorner === "top-right"
      ? searchBarEl.offsetHeight + 2
      : 0;

  const isRight = floatingPanelCorner.includes("right");
  const isBottom = floatingPanelCorner.includes("bottom");

  if (isBottom) {
    el.style.bottom = `${insets.bottom}px`;
  } else {
    el.style.top = `${insets.top + searchBarExtra}px`;
  }
  if (isRight) {
    el.style.right = `${insets.right}px`;
  } else {
    el.style.left = `${insets.left}px`;
  }

  // Update resize handle position based on anchorage
  updateResizeHandlePosition();
}

/** Position the resize handle on the correct edge based on panel anchorage. */
function updateResizeHandlePosition(): void {
  const resizeHandle = document.getElementById("annotation-panel-resize");
  if (!resizeHandle) return;
  const isRight = floatingPanelCorner.includes("right");
  if (isRight) {
    // Panel is on the right → resize handle on the left edge
    resizeHandle.style.left = "-3px";
    resizeHandle.style.right = "";
  } else {
    // Panel is on the left → resize handle on the right edge
    resizeHandle.style.left = "";
    resizeHandle.style.right = "-3px";
  }
}

/** Auto-dock the floating panel to the opposite side if it overlaps selected annotations. */
function autoDockPanel(): void {
  const panelRect = annotationsPanelEl.getBoundingClientRect();
  let overlaps = false;
  for (const selId of selectedAnnotationIds) {
    const tracked = annotationMap.get(selId);
    if (!tracked) continue;
    for (const el of tracked.elements) {
      const elRect = el.getBoundingClientRect();
      // Check overlap
      if (
        panelRect.left < elRect.right &&
        panelRect.right > elRect.left &&
        panelRect.top < elRect.bottom &&
        panelRect.bottom > elRect.top
      ) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) break;
  }
  if (overlaps) {
    // Swap left ↔ right
    if (floatingPanelCorner.includes("right")) {
      floatingPanelCorner = floatingPanelCorner.replace(
        "right",
        "left",
      ) as PanelCorner;
    } else {
      floatingPanelCorner = floatingPanelCorner.replace(
        "left",
        "right",
      ) as PanelCorner;
    }
    applyFloatingPanelPosition();
  }
}

function setAnnotationPanelOpen(open: boolean): void {
  annotationPanelOpen = open;
  annotationsBtn.classList.toggle("active", open);
  updateAnnotationsBadge();

  // Always use floating panel (both inline and fullscreen)
  annotationsPanelEl.classList.toggle("floating", true);
  annotationsPanelEl.style.display = open ? "" : "none";
  if (open) {
    applyFloatingPanelPosition();
    renderAnnotationPanel();
  }
  requestFitToContent();
}

function toggleAnnotationPanel(): void {
  annotationPanelUserPref = !annotationPanelOpen;
  try {
    localStorage.setItem(
      "pdf-annotation-panel",
      annotationPanelUserPref ? "open" : "closed",
    );
  } catch {
    /* ignore */
  }
  setAnnotationPanelOpen(annotationPanelUserPref);
}

/**
 * Derived state of a form field relative to the PDF baseline.
 * Not stored — computed on demand by comparing formFieldValues to
 * pdfBaselineFormValues.
 */
type FieldState =
  | "unchanged" // current === baseline (came from the PDF, untouched)
  | "modified" //  baseline exists but current differs
  | "cleared" //   baseline exists but current is absent/empty
  | "added"; //    no baseline — user-filled or fill_form

function fieldState(name: string): FieldState {
  const cur = formFieldValues.get(name);
  const base = pdfBaselineFormValues.get(name);
  if (base === undefined) return "added";
  if (cur === undefined || cur === "" || cur === false) return "cleared";
  return cur === base ? "unchanged" : "modified";
}

/** All field names that should appear in the panel: current ∪ baseline.
 *  Cleared baseline fields remain visible (crossed out) so they can be
 *  reverted individually. */
function panelFieldNames(): Set<string> {
  return new Set([...formFieldValues.keys(), ...pdfBaselineFormValues.keys()]);
}

/** Total count of annotations + form fields for the sidebar badge.
 *  Uses the union so cleared baseline items still contribute. */
function sidebarItemCount(): number {
  return annotationMap.size + panelFieldNames().size;
}

function updateAnnotationsBadge(): void {
  const count = sidebarItemCount();
  if (count > 0 && !annotationPanelOpen) {
    annotationsBadgeEl.textContent = String(count);
    annotationsBadgeEl.style.display = "";
  } else {
    annotationsBadgeEl.style.display = "none";
  }
  // Show/hide the toolbar button based on whether items exist
  annotationsBtn.style.display = count > 0 ? "" : "none";
  // Auto-close panel when all items are gone
  if (count === 0 && annotationPanelOpen) {
    setAnnotationPanelOpen(false);
  }
}

/** Human-readable label for an annotation type (used in sidebar). */
function getAnnotationLabel(def: PdfAnnotationDef): string {
  switch (def.type) {
    case "highlight":
      return def.content ? "Highlight" : "Highlight";
    case "underline":
      return "Underline";
    case "strikethrough":
      return "Strikethrough";
    case "note":
      return "Note";
    case "freetext":
      return "Text";
    case "rectangle":
      return "Rectangle";
    case "stamp":
      return `Stamp: ${def.label}`;
    case "circle":
      return "Circle";
    case "line":
      return "Line";
    case "image":
      return "Image";
  }
}

/** Preview text for an annotation (shown after the label). */
function getAnnotationPreview(def: PdfAnnotationDef): string {
  switch (def.type) {
    case "note":
    case "freetext":
      return def.content || "";
    case "highlight":
      return def.content || "";
    case "stamp":
      return "";
    case "image":
      return "";
    default:
      return "";
  }
}

function getAnnotationColor(def: PdfAnnotationDef): string {
  if ("color" in def && def.color) return def.color;
  switch (def.type) {
    case "highlight":
      return "rgba(255, 255, 0, 0.7)";
    case "underline":
      return "#ff0000";
    case "strikethrough":
      return "#ff0000";
    case "note":
      return "#f5a623";
    case "rectangle":
      return "#0066cc";
    case "freetext":
      return "#333";
    case "stamp":
      return "#cc0000";
    case "circle":
      return "#0066cc";
    case "line":
      return "#333";
    case "image":
      return "#999";
  }
}

/** Return a human-readable label for a form field name. */
function getFormFieldLabel(name: string): string {
  // Prefer the PDF's TU (alternativeText) if available
  const alt = fieldNameToLabel.get(name);
  if (alt) return alt;
  // If the name looks mechanical (contains brackets, dots, or is all-caps with underscores),
  // just show "Field" as a generic fallback
  if (/[[\]().]/.test(name) || /^[A-Z0-9_]+$/.test(name)) {
    return "Field";
  }
  return name;
}

function getAnnotationY(def: PdfAnnotationDef): number {
  if ("y" in def && typeof def.y === "number") return def.y;
  if ("rects" in def && def.rects.length > 0) return def.rects[0].y;
  return 0;
}

/** Track which accordion section is open (e.g. "page-3" or "formFields"). null = all collapsed. */
let openAccordionSection: string | null = null;
/** Whether the user has ever interacted with accordion sections (prevents auto-open after explicit collapse). */
let accordionUserInteracted = false;

/** Which corner the floating panel is anchored to. */
type PanelCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left";
let floatingPanelCorner: PanelCorner = "top-right";

function renderAnnotationPanel(): void {
  if (!annotationPanelOpen) return;

  annotationsPanelCountEl.textContent = String(sidebarItemCount());
  annotationsPanelResetBtn.disabled = !isDirty;
  annotationsPanelClearAllBtn.disabled = sidebarItemCount() === 0;

  // Group annotations by page, sorted by Y position within each page
  const byPage = new Map<number, TrackedAnnotation[]>();
  for (const tracked of annotationMap.values()) {
    const page = tracked.def.page;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(tracked);
  }

  // Group form fields by page — iterate the UNION so cleared baseline
  // fields remain visible (crossed out) with a per-item revert button.
  const fieldsByPage = new Map<number, string[]>();
  for (const name of panelFieldNames()) {
    const page = fieldNameToPage.get(name) ?? 1;
    if (!fieldsByPage.has(page)) fieldsByPage.set(page, []);
    fieldsByPage.get(page)!.push(name);
  }
  // Sort fields by their intrinsic document order within each page
  for (const names of fieldsByPage.values()) {
    names.sort(
      (a, b) => (fieldNameToOrder.get(a) ?? 0) - (fieldNameToOrder.get(b) ?? 0),
    );
  }

  // Collect all pages that have annotations or form fields
  const allPages = new Set([...byPage.keys(), ...fieldsByPage.keys()]);
  const sortedPages = [...allPages].sort((a, b) => a - b);

  // Sort annotations within each page by Y position (descending = top-first in PDF coords)
  for (const annotations of byPage.values()) {
    annotations.sort((a, b) => getAnnotationY(b.def) - getAnnotationY(a.def));
  }

  annotationsPanelListEl.innerHTML = "";

  // Auto-open section for current page only on first render (before user interaction)
  if (openAccordionSection === null && !accordionUserInteracted) {
    if (allPages.has(currentPage)) {
      openAccordionSection = `page-${currentPage}`;
    } else if (sortedPages.length > 0) {
      openAccordionSection = `page-${sortedPages[0]}`;
    }
  }

  for (const pageNum of sortedPages) {
    const sectionKey = `page-${pageNum}`;
    const isOpen = openAccordionSection === sectionKey;
    const annotations = byPage.get(pageNum) ?? [];
    const fields = fieldsByPage.get(pageNum) ?? [];
    const itemCount = annotations.length + fields.length;

    appendAccordionSection(
      `Page ${pageNum} (${itemCount})`,
      sectionKey,
      isOpen,
      pageNum === currentPage,
      (body) => {
        // Form fields first
        for (const name of fields) {
          body.appendChild(createFormFieldCard(name));
        }
        // Then annotations
        for (const tracked of annotations) {
          body.appendChild(createAnnotationCard(tracked));
        }
      },
    );
  }
}

function appendAccordionSection(
  title: string,
  sectionKey: string,
  isOpen: boolean,
  isCurrent: boolean,
  populateBody: (body: HTMLElement) => void,
): void {
  const header = document.createElement("div");
  header.className =
    "annotation-section-header" +
    (isCurrent ? " current-page" : "") +
    (isOpen ? " open" : "");

  const titleSpan = document.createElement("span");
  titleSpan.textContent = title;
  header.appendChild(titleSpan);

  const chevron = document.createElement("span");
  chevron.className = "annotation-section-chevron";
  chevron.textContent = isOpen ? "▼" : "▶";
  header.appendChild(chevron);

  header.addEventListener("click", () => {
    accordionUserInteracted = true;
    const opening = openAccordionSection !== sectionKey;
    openAccordionSection = opening ? sectionKey : null;
    renderAnnotationPanel();
    // Navigate to the page when expanding a page section
    if (opening) {
      const pageMatch = sectionKey.match(/^page-(\d+)$/);
      if (pageMatch) {
        goToPage(Number(pageMatch[1]));
      }
    }
  });

  annotationsPanelListEl.appendChild(header);

  const body = document.createElement("div");
  body.className = "annotation-section-body" + (isOpen ? " open" : "");
  if (isOpen) {
    populateBody(body);
  }
  annotationsPanelListEl.appendChild(body);
}

function createAnnotationCard(tracked: TrackedAnnotation): HTMLElement {
  const def = tracked.def;
  const card = document.createElement("div");
  card.className =
    "annotation-card" + (selectedAnnotationIds.has(def.id) ? " selected" : "");
  card.dataset.annotationId = def.id;

  const row = document.createElement("div");
  row.className = "annotation-card-row";

  // Color swatch
  const swatch = document.createElement("div");
  swatch.className = "annotation-card-swatch";
  swatch.style.background = getAnnotationColor(def);
  row.appendChild(swatch);

  // Type label
  const typeLabel = document.createElement("span");
  typeLabel.className = "annotation-card-type";
  typeLabel.textContent = getAnnotationLabel(def);
  row.appendChild(typeLabel);

  // Preview text
  const preview = getAnnotationPreview(def);
  if (preview) {
    const previewEl = document.createElement("span");
    previewEl.className = "annotation-card-preview";
    previewEl.textContent = preview;
    row.appendChild(previewEl);
  }

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "annotation-card-delete";
  deleteBtn.title = "Delete annotation";
  deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 3h8M4.5 3V2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L9 3"/></svg>`;
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeAnnotation(def.id);
    persistAnnotations();
  });
  row.appendChild(deleteBtn);

  // Expand chevron (only for annotations with content)
  const hasContent = "content" in def && def.content;
  if (hasContent) {
    const expand = document.createElement("span");
    expand.className = "annotation-card-expand";
    expand.textContent = "▼";
    row.appendChild(expand);
  }

  card.appendChild(row);

  // Expandable content area
  if (hasContent) {
    const contentEl = document.createElement("div");
    contentEl.className = "annotation-card-content";
    contentEl.textContent = (def as { content: string }).content;
    card.appendChild(contentEl);
  }

  // Click handler: select + expand/collapse + navigate to page + pulse annotation
  card.addEventListener("click", () => {
    if (hasContent) {
      card.classList.toggle("expanded");
    }
    if (def.page !== currentPage) {
      goToPage(def.page);
      setTimeout(() => {
        selectAnnotation(def.id);
        pulseAnnotation(def.id);
      }, 300);
    } else {
      selectAnnotation(def.id);
      pulseAnnotation(def.id);
      if (tracked.elements.length > 0) {
        tracked.elements[0].scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    }
  });

  // Hover handler: pulse annotation on PDF
  card.addEventListener("mouseenter", () => {
    if (def.page === currentPage) {
      pulseAnnotation(def.id);
    }
  });

  // Double-click handler: send message to modify annotation
  card.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    // Select this annotation + update model context before sending message
    selectAnnotation(def.id);
    const label = getAnnotationLabel(def);
    const previewText = getAnnotationPreview(def);
    const desc = previewText ? `${label}: ${previewText}` : label;
    app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: `update ${desc}: `,
        },
      ],
    });
  });

  return card;
}

const TRASH_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 3h8M4.5 3V2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L9 3"/></svg>`;
const REVERT_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6a4 4 0 1 1 1.2 2.85"/><path d="M2 9V6h3"/></svg>`;

/** Revert one field to its PDF-stored baseline value. */
function revertFieldToBaseline(name: string): void {
  const base = pdfBaselineFormValues.get(name);
  if (base === undefined) return;
  formFieldValues.set(name, base);
  // Remove our storage override → widget falls back to PDF's /V = baseline
  if (pdfDocument) {
    const ids = fieldNameToIds.get(name);
    if (ids) for (const id of ids) pdfDocument.annotationStorage.remove(id);
  }
}

function createFormFieldCard(name: string): HTMLElement {
  const state = fieldState(name);
  const value = formFieldValues.get(name);
  const baseValue = pdfBaselineFormValues.get(name);

  const card = document.createElement("div");
  card.className = "annotation-card";
  if (state === "cleared") card.classList.add("annotation-card-cleared");

  const row = document.createElement("div");
  row.className = "annotation-card-row";

  // Swatch: solid blue normally; crossed-out for cleared baseline fields
  const swatch = document.createElement("div");
  swatch.className = "annotation-card-swatch";
  if (state === "cleared") {
    swatch.classList.add("annotation-card-swatch-cleared");
    swatch.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" stroke="#4a90d9" stroke-width="1.5" stroke-linecap="round"><path d="M2 2l6 6M8 2L2 8"/></svg>`;
  } else {
    swatch.style.background = "#4a90d9";
  }
  // Subtle modified marker
  if (state === "modified") swatch.title = "Modified from file";
  row.appendChild(swatch);

  // Field label
  const nameEl = document.createElement("span");
  nameEl.className = "annotation-card-type";
  nameEl.textContent = getFormFieldLabel(name);
  row.appendChild(nameEl);

  // Value preview: show current, or struck-out baseline when cleared
  const shown = state === "cleared" ? baseValue : value;
  const displayValue =
    typeof shown === "boolean" ? (shown ? "checked" : "unchecked") : shown;
  if (displayValue) {
    const valueEl = document.createElement("span");
    valueEl.className = "annotation-card-preview";
    valueEl.textContent = displayValue;
    row.appendChild(valueEl);
  }

  // Action button: revert for modified/cleared baseline fields, trash otherwise
  const isRevertable = state === "modified" || state === "cleared";
  const actionBtn = document.createElement("button");
  actionBtn.className = "annotation-card-delete";
  actionBtn.title = isRevertable
    ? "Revert to value stored in file"
    : "Clear field";
  actionBtn.innerHTML = isRevertable ? REVERT_SVG : TRASH_SVG;
  actionBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isRevertable) {
      revertFieldToBaseline(name);
    } else {
      formFieldValues.delete(name);
      clearFieldInStorage(name);
    }
    updateAnnotationsBadge();
    renderAnnotationPanel();
    renderPage();
    persistAnnotations();
  });
  row.appendChild(actionBtn);

  // Click handler: navigate to page and focus form input
  card.addEventListener("click", () => {
    const fieldPage = fieldNameToPage.get(name) ?? 1;
    // Auto-expand the page's accordion section
    openAccordionSection = `page-${fieldPage}`;
    const focusField = () => {
      const input = formLayerEl.querySelector(
        `[name="${CSS.escape(name)}"]`,
      ) as HTMLElement | null;
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    if (fieldPage !== currentPage) {
      goToPage(fieldPage);
      setTimeout(focusField, 300);
    } else {
      focusField();
    }
  });

  // Double-click handler: send message to fill field
  card.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    // Focus field + update model context before sending message
    focusedFieldName = name;
    updatePageContext();
    const fieldLabel = getFormFieldLabel(name);
    app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: `update ${fieldLabel}: `,
        },
      ],
    });
  });

  card.appendChild(row);
  return card;
}

function pulseAnnotation(id: string): void {
  const tracked = annotationMap.get(id);
  if (!tracked) return;
  for (const el of tracked.elements) {
    el.classList.remove("annotation-pulse");
    // Force reflow to restart animation
    void el.offsetWidth;
    el.classList.add("annotation-pulse");
    el.addEventListener(
      "animationend",
      () => {
        el.classList.remove("annotation-pulse");
      },
      { once: true },
    );
  }
}

function initAnnotationPanel(): void {
  // Restore user preference
  try {
    const pref = localStorage.getItem("pdf-annotation-panel");
    if (pref === "open") annotationPanelUserPref = true;
    else if (pref === "closed") annotationPanelUserPref = false;
  } catch {
    /* ignore */
  }

  // Restore saved panel width
  try {
    const savedWidth = localStorage.getItem("pdf-annotation-panel-width");
    if (savedWidth) {
      const w = parseInt(savedWidth, 10);
      if (w >= 120) {
        annotationsPanelEl.style.width = `${w}px`;
      }
    }
  } catch {
    /* ignore */
  }

  // Resize handle — direction-aware based on anchorage
  const resizeHandle = document.getElementById("annotation-panel-resize")!;
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    resizeHandle.classList.add("dragging");
    const startX = e.clientX;
    const startWidth = annotationsPanelEl.offsetWidth;
    const isRight = floatingPanelCorner.includes("right");

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      // If panel is on the right, dragging left (negative dx) increases width
      // If panel is on the left, dragging right (positive dx) increases width
      const newWidth = Math.max(120, startWidth + (isRight ? -dx : dx));
      annotationsPanelEl.style.width = `${newWidth}px`;
    };
    const onMouseUp = () => {
      resizeHandle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      try {
        localStorage.setItem(
          "pdf-annotation-panel-width",
          String(annotationsPanelEl.offsetWidth),
        );
      } catch {
        /* ignore */
      }
      requestFitToContent();
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  // Floating panel drag-to-reposition
  const panelHeader = annotationsPanelEl.querySelector(
    ".annotation-panel-header",
  ) as HTMLElement;
  if (panelHeader) {
    panelHeader.addEventListener("mousedown", (e) => {
      if (!annotationsPanelEl.classList.contains("floating")) return;
      // Ignore clicks on buttons within header
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const container = annotationsPanelEl.parentElement!;
      const containerRect = container.getBoundingClientRect();
      let moved = false;

      // Temporarily position absolutely during drag
      const panelRect = annotationsPanelEl.getBoundingClientRect();
      let curLeft = panelRect.left - containerRect.left;
      let curTop = panelRect.top - containerRect.top;

      // Switch to left/top positioning for free drag
      annotationsPanelEl.style.right = "";
      annotationsPanelEl.style.bottom = "";
      annotationsPanelEl.style.left = `${curLeft}px`;
      annotationsPanelEl.style.top = `${curTop}px`;
      annotationsPanelEl.style.transition = "none";
      annotationsPanelEl.classList.add("dragging");

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        const newLeft = Math.max(
          0,
          Math.min(
            curLeft + dx,
            containerRect.width - annotationsPanelEl.offsetWidth,
          ),
        );
        const newTop = Math.max(
          0,
          Math.min(
            curTop + dy,
            containerRect.height - annotationsPanelEl.offsetHeight,
          ),
        );
        annotationsPanelEl.style.left = `${newLeft}px`;
        annotationsPanelEl.style.top = `${newTop}px`;
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        annotationsPanelEl.classList.remove("dragging");
        annotationsPanelEl.style.transition = "";

        if (!moved) return;

        // Snap to nearest corner (magnetic anchor)
        const finalRect = annotationsPanelEl.getBoundingClientRect();
        const cx = finalRect.left + finalRect.width / 2 - containerRect.left;
        const cy = finalRect.top + finalRect.height / 2 - containerRect.top;
        const midX = containerRect.width / 2;
        const midY = containerRect.height / 2;

        const isRight = cx > midX;
        const isBottom = cy > midY;
        floatingPanelCorner = isBottom
          ? isRight
            ? "bottom-right"
            : "bottom-left"
          : isRight
            ? "top-right"
            : "top-left";

        applyFloatingPanelPosition();
        try {
          localStorage.setItem("pdf-panel-corner", floatingPanelCorner);
        } catch {
          /* ignore */
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  // Restore saved corner
  try {
    const saved = localStorage.getItem("pdf-panel-corner");
    if (
      saved &&
      ["top-right", "top-left", "bottom-right", "bottom-left"].includes(saved)
    ) {
      floatingPanelCorner = saved as PanelCorner;
    }
  } catch {
    /* ignore */
  }

  // Toggle button
  annotationsBtn.addEventListener("click", toggleAnnotationPanel);
  annotationsPanelCloseBtn.addEventListener("click", toggleAnnotationPanel);
  annotationsPanelResetBtn.addEventListener("click", resetToBaseline);
  annotationsPanelClearAllBtn.addEventListener("click", clearAllItems);

  updateAnnotationsBadge();
}

/** Remove the DOM elements backing every annotation and clear the map. */
function clearAnnotationMap(): void {
  for (const [, tracked] of annotationMap) {
    for (const el of tracked.elements) el.remove();
  }
  annotationMap.clear();
}

/**
 * Push a field's defaultValue (/DV) into annotationStorage so the widget
 * renders cleared. annotationStorage.remove() only drops our override —
 * the widget reverts to the PDF's /V (the stored value), not /DV.
 *
 * Widget IDs come from page.getAnnotations(); field metadata (types,
 * defaultValue) comes from getFieldObjects(). We match them by field name.
 */
function clearFieldInStorage(name: string): void {
  if (!pdfDocument) return;
  const ids = fieldNameToIds.get(name);
  if (!ids) return;
  const storage = pdfDocument.annotationStorage;
  const meta = cachedFieldObjects?.[name];
  // defaultValue is per-field, not per-widget — take from first non-parent entry
  const dv =
    meta?.find((f) => f.defaultValue != null)?.defaultValue ??
    meta?.[0]?.defaultValue ??
    "";
  const type = meta?.find((f) => f.type)?.type;
  const clearValue =
    type === "checkbox" || type === "radiobutton" ? (dv ?? "Off") : (dv ?? "");
  for (const id of ids) storage.setValue(id, { value: clearValue });
}

/**
 * Revert to what's in the PDF file: restore baseline annotations, restore
 * baseline form values, discard all user edits. Result: diff is empty, clean.
 *
 * Form fields: remove ALL storage overrides — every field reverts to the
 * PDF's /V (which IS baseline). We can't skip baseline-named fields: if the
 * user edited one, our override is in storage under that name, and skipping
 * it leaves the widget showing the stale edit.
 */
function resetToBaseline(): void {
  clearAnnotationMap();
  for (const def of pdfBaselineAnnotations) {
    annotationMap.set(def.id, { def: { ...def }, elements: [] });
  }

  if (pdfDocument) {
    const storage = pdfDocument.annotationStorage;
    for (const name of new Set([
      ...formFieldValues.keys(),
      ...pdfBaselineFormValues.keys(),
    ])) {
      const ids = fieldNameToIds.get(name);
      if (ids) for (const id of ids) storage.remove(id);
    }
  }
  formFieldValues.clear();
  for (const [name, value] of pdfBaselineFormValues) {
    formFieldValues.set(name, value);
  }

  undoStack.length = 0;
  redoStack.length = 0;
  selectedAnnotationIds.clear();

  updateAnnotationsBadge();
  persistAnnotations(); // diff is now empty → setDirty(false)
  renderPage();
  renderAnnotationPanel();
}

/**
 * Remove everything, including annotations and form values that came from
 * the PDF file. Result: diff is non-empty (baseline items are "removed"),
 * dirty — saving writes a stripped PDF.
 *
 * Form fields: annotationStorage.remove() only drops our override, so the
 * widget reverts to the PDF's stored /V. To actually CLEAR we must push
 * each field's defaultValue (/DV) — which is what the PDF's own Reset
 * button would do.
 *
 * Note: baseline annotations are still baked into the canvas appearance
 * stream — we can only remove them from our overlay and the panel. Saving
 * will omit them from the output (getAnnotatedPdfBytes skips baseline).
 */
function clearAllItems(): void {
  clearAnnotationMap();

  for (const name of new Set([
    ...formFieldValues.keys(),
    ...pdfBaselineFormValues.keys(),
  ])) {
    clearFieldInStorage(name);
  }
  formFieldValues.clear();

  undoStack.length = 0;
  redoStack.length = 0;
  selectedAnnotationIds.clear();

  updateAnnotationsBadge();
  persistAnnotations();
  renderPage();
  renderAnnotationPanel();
}

// =============================================================================
// highlight_text Command
// =============================================================================

function handleHighlightText(cmd: {
  id: string;
  query: string;
  page?: number;
  color?: string;
  content?: string;
}): void {
  const pagesToSearch: number[] = [];
  if (cmd.page) {
    pagesToSearch.push(cmd.page);
  } else {
    // Search all pages that have cached text
    for (const [pageNum, text] of pageTextCache) {
      if (text.toLowerCase().includes(cmd.query.toLowerCase())) {
        pagesToSearch.push(pageNum);
      }
    }
  }

  let annotationIndex = 0;
  for (const pageNum of pagesToSearch) {
    // Find text positions using the text layer DOM if on current page,
    // otherwise create approximate rects from text cache positions
    const rects = findTextRects(cmd.query, pageNum);
    if (rects.length > 0) {
      const id =
        pagesToSearch.length > 1
          ? `${cmd.id}_p${pageNum}_${annotationIndex++}`
          : cmd.id;
      addAnnotation({
        type: "highlight",
        id,
        page: pageNum,
        rects,
        color: cmd.color,
        content: cmd.content,
      });
    }
  }
}

/**
 * Find text in a page and return PDF-coordinate rects.
 * Uses the TextLayer DOM when the page is currently rendered,
 * otherwise falls back to approximate character-based positioning.
 */
function findTextRects(query: string, pageNum: number): Rect[] {
  if (pageNum !== currentPage) {
    // For non-current pages, create approximate rects from page dimensions
    // The text will be properly positioned when the user navigates to that page
    return findTextRectsFromCache(query, pageNum);
  }

  // Use text layer DOM for current page
  const spans = Array.from(
    textLayerEl.querySelectorAll("span"),
  ) as HTMLElement[];
  if (spans.length === 0) return findTextRectsFromCache(query, pageNum);

  const lowerQuery = query.toLowerCase();
  const rects: Rect[] = [];
  const wrapperEl = textLayerEl.parentElement!;
  const wrapperRect = wrapperEl.getBoundingClientRect();

  for (const span of spans) {
    const text = span.textContent || "";
    if (text.length === 0) continue;
    const lowerText = text.toLowerCase();

    let pos = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerQuery, pos);
      if (idx === -1) break;
      pos = idx + 1;

      const textNode = span.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;

      try {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, Math.min(idx + lowerQuery.length, text.length));
        const clientRects = range.getClientRects();

        for (let ri = 0; ri < clientRects.length; ri++) {
          const r = clientRects[ri];
          // Convert screen coords back to PDF coords
          const screenLeft = r.left - wrapperRect.left;
          const screenTop = r.top - wrapperRect.top;
          const pdfX = screenLeft / scale;
          const pdfHeight = r.height / scale;
          const pdfWidth = r.width / scale;
          const pageHeight = parseFloat(annotationLayerEl.style.height) / scale;
          const pdfY = pageHeight - (screenTop + r.height) / scale;
          rects.push({
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
          });
        }
      } catch {
        // Range API errors with stale nodes
      }
    }
  }

  return rects;
}

function findTextRectsFromCache(query: string, pageNum: number): Rect[] {
  const text = pageTextCache.get(pageNum);
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return [];

  // Approximate: place a highlight rect in the middle of the page
  // This will be re-computed accurately when the user visits the page
  return [{ x: 72, y: 400, width: 200, height: 14 }];
}

// =============================================================================
// get_pages — Offscreen rendering for model analysis
// =============================================================================

const MAX_GET_PAGES = 20;
const SCREENSHOT_MAX_DIM = 768; // Max pixel dimension for screenshots

/**
 * Expand intervals into a sorted deduplicated list of page numbers,
 * clamped to [1, totalPages].
 */
function expandIntervals(
  intervals: Array<{ start?: number; end?: number }>,
): number[] {
  const pages = new Set<number>();
  for (const iv of intervals) {
    const s = Math.max(1, iv.start ?? 1);
    const e = Math.min(totalPages, iv.end ?? totalPages);
    for (let p = s; p <= e; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Render a single page to an offscreen canvas and return base64 JPEG.
 * Does not affect the visible canvas or text layer.
 */
async function renderPageOffscreen(pageNum: number): Promise<string> {
  if (!pdfDocument) throw new Error("No PDF loaded");
  const page = await pdfDocument.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1.0 });

  // Scale down to fit within SCREENSHOT_MAX_DIM
  const maxDim = Math.max(baseViewport.width, baseViewport.height);
  const renderScale =
    maxDim > SCREENSHOT_MAX_DIM ? SCREENSHOT_MAX_DIM / maxDim : 1.0;
  const viewport = page.getViewport({ scale: renderScale });

  const canvas = document.createElement("canvas");
  const dpr = 1; // No retina scaling for model screenshots
  canvas.width = viewport.width * dpr;
  canvas.height = viewport.height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  // Render with ENABLE_STORAGE so filled form fields appear on the canvas
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (page.render as any)({
    canvasContext: ctx,
    viewport,
    annotationMode: AnnotationMode.ENABLE_STORAGE,
    annotationStorage: pdfDocument.annotationStorage,
  }).promise;

  // Paint annotations on top so the model can see them
  paintAnnotationsOnCanvas(ctx, pageNum, {
    width: viewport.width,
    height: viewport.height,
    scale: renderScale,
  });

  // Extract base64 JPEG (much smaller than PNG, well within body limits)
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return dataUrl.split(",")[1];
}

async function handleGetPages(cmd: {
  requestId: string;
  intervals: Array<{ start?: number; end?: number }>;
  getText: boolean;
  getScreenshots: boolean;
}): Promise<void> {
  const allPages = expandIntervals(cmd.intervals);
  const pages = allPages.slice(0, MAX_GET_PAGES);

  log.info(
    `get_pages: ${pages.length} pages (${pages[0]}..${pages[pages.length - 1]}), text=${cmd.getText}, screenshots=${cmd.getScreenshots}`,
  );

  const results: Array<{
    page: number;
    text?: string;
    image?: string;
  }> = [];

  for (const pageNum of pages) {
    const entry: { page: number; text?: string; image?: string } = {
      page: pageNum,
    };

    if (cmd.getText) {
      // Use cached text if available, otherwise extract on the fly
      let text = pageTextCache.get(pageNum);
      if (text == null && pdfDocument) {
        try {
          const pg = await pdfDocument.getPage(pageNum);
          const tc = await pg.getTextContent();
          text = (tc.items as Array<{ str?: string }>)
            .map((item) => item.str || "")
            .join(" ");
          pageTextCache.set(pageNum, text);
        } catch (err) {
          log.error(
            `get_pages: text extraction failed for page ${pageNum}:`,
            err,
          );
          text = "";
        }
      }
      entry.text = text ?? "";
    }

    if (cmd.getScreenshots) {
      try {
        entry.image = await renderPageOffscreen(pageNum);
      } catch (err) {
        log.error(`get_pages: screenshot failed for page ${pageNum}:`, err);
      }
    }

    results.push(entry);
  }

  // Submit results back to server
  try {
    await app.callServerTool({
      name: "submit_page_data",
      arguments: { requestId: cmd.requestId, pages: results },
    });
    log.info(
      `get_pages: submitted ${results.length} page(s) for ${cmd.requestId}`,
    );
  } catch (err) {
    log.error("get_pages: failed to submit results:", err);
  }
}

// =============================================================================
// Annotation Persistence
// =============================================================================

/** Storage key for annotations — uses toolInfo.id (available early) with viewUUID fallback */
function annotationStorageKey(): string | null {
  const toolId = app.getHostContext()?.toolInfo?.id;
  if (toolId) return `pdf-annot:${toolId}`;
  if (viewUUID) return `${viewUUID}:annotations`;
  return null;
}

/**
 * Import annotations from the loaded PDF to establish the baseline.
 * These are the annotations that exist in the PDF file itself.
 */
async function loadBaselineAnnotations(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<void> {
  pdfBaselineAnnotations = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    try {
      const page = await doc.getPage(pageNum);
      const annotations = await page.getAnnotations();
      for (let i = 0; i < annotations.length; i++) {
        const ann = annotations[i];
        const def = importPdfjsAnnotation(ann, pageNum, i);
        if (def) {
          pdfBaselineAnnotations.push(def);
          // Add to annotationMap if not already present (from localStorage restore)
          if (!annotationMap.has(def.id)) {
            annotationMap.set(def.id, { def, elements: [] });
          }
        }
      }
    } catch {
      // Skip pages that fail to load annotations
    }
  }
  log.info(
    `Loaded ${pdfBaselineAnnotations.length} baseline annotations from PDF`,
  );
}

function persistAnnotations(): void {
  // Compute diff relative to PDF baseline
  const currentAnnotations: PdfAnnotationDef[] = [];
  for (const tracked of annotationMap.values()) {
    currentAnnotations.push(tracked.def);
  }
  const diff = computeDiff(
    pdfBaselineAnnotations,
    currentAnnotations,
    formFieldValues,
    pdfBaselineFormValues,
  );

  // Dirty tracks whether there are unsaved changes. Undoing back to baseline
  // yields an empty diff → clean again → save button disables.
  if (!isRestoring) setDirty(!isDiffEmpty(diff));

  const key = annotationStorageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, serializeDiff(diff));
  } catch {
    // localStorage may be full or unavailable
  }
}

function restoreAnnotations(): void {
  const key = annotationStorageKey();
  if (!key) return;
  isRestoring = true;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;

    // Try new diff-based format first
    const diff = deserializeDiff(raw);

    // Merge baseline + diff
    const merged = mergeAnnotations(pdfBaselineAnnotations, diff);
    for (const def of merged) {
      if (!annotationMap.has(def.id)) {
        annotationMap.set(def.id, { def, elements: [] });
      }
    }

    // Restore form fields
    for (const [k, v] of Object.entries(diff.formFields)) {
      formFieldValues.set(k, v);
    }

    // If we have user changes (diff is not empty), mark dirty
    if (
      diff.added.length > 0 ||
      diff.removed.length > 0 ||
      Object.keys(diff.formFields).length > 0
    ) {
      setDirty(true);
    }
    log.info(
      `Restored ${annotationMap.size} annotations (${diff.added.length} added, ${diff.removed.length} removed), ${formFieldValues.size} form fields`,
    );
  } catch {
    // Parse error or unavailable
  } finally {
    isRestoring = false;
  }
}

// =============================================================================
// PDF.js Form Field Name → ID Mapping
// =============================================================================

/**
 * Normalise a raw form field value into our string|boolean model.
 * Returns null for empty/unfilled/button values so they don't clutter the
 * panel or count as baseline.
 *
 * `type` is from getFieldObjects() (which knows field types); `raw` is
 * preferably from page.getAnnotations().fieldValue (which is what the
 * widget actually renders). A PDF can have the field-dict /V out of sync
 * with the widget — AnnotationLayer trusts the widget, so we must too.
 */
function normaliseFieldValue(
  type: string | undefined,
  raw: unknown,
): string | boolean | null {
  if (type === "button") return null;
  // Checkbox/radio: fieldValue is the export string (e.g. "Yes"), "Off" = unset
  if (type === "checkbox") {
    return raw != null && raw !== "" && raw !== "Off" ? true : null;
  }
  if (type === "radiobutton") {
    return raw != null && raw !== "" && raw !== "Off" ? String(raw) : null;
  }
  // Text/choice: fieldValue may be a string or an array of selections
  if (Array.isArray(raw)) {
    const joined = raw.filter(Boolean).join(", ");
    return joined || null;
  }
  if (raw == null || raw === "") return null;
  return String(raw);
}

/**
 * Build mapping from field names (used by fill_form) to widget annotation IDs
 * (used by annotationStorage).
 *
 * CRITICAL: getFieldObjects() returns field-dictionary IDs (the /T tree),
 * but annotationStorage is keyed by WIDGET annotation IDs (what
 * page.getAnnotations() returns). The two differ for PDFs where fields and
 * their widget /Kids are separate objects. Using the wrong key makes all
 * storage writes silently miss.
 */
async function buildFieldNameMap(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<void> {
  fieldNameToIds.clear();
  radioButtonValues.clear();
  fieldNameToPage.clear();
  fieldNameToLabel.clear();
  fieldNameToOrder.clear();
  cachedFieldObjects = null;
  pdfBaselineFormValues.clear();

  // getFieldObjects() gives us types, current values (/V), and defaults (/DV).
  // We DON'T use its .id — that's the field dict ref, not the widget annot ref.
  try {
    cachedFieldObjects =
      ((await doc.getFieldObjects()) as Record<string, any[]> | null) ?? null;
  } catch {
    // getFieldObjects may fail on some PDFs
  }

  // Scan every page's widget annotations to collect the CORRECT storage keys,
  // plus labels, pages, positions, AND fieldValue (what the widget renders
  // — which can differ from getFieldObjects().value if the PDF is internally
  // inconsistent, e.g. after a pdf-lib setText silently failed).
  const fieldPositions: Array<{ name: string; page: number; y: number }> = [];
  const widgetFieldValues = new Map<string, unknown>();
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    let annotations;
    try {
      const page = await doc.getPage(pageNum);
      annotations = await page.getAnnotations();
    } catch {
      continue;
    }
    for (const ann of annotations) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = ann as any;
      if (!a.fieldName || !a.id) continue;

      // Widget annotation ID — this is what annotationStorage keys by
      const ids = fieldNameToIds.get(a.fieldName) ?? [];
      ids.push(a.id);
      fieldNameToIds.set(a.fieldName, ids);

      // Radio buttons: pdf.js creates <input type=radio> WITHOUT setting
      // .value, so reading target.value gives the HTML default "on".
      // Remember each widget's export value so the input listener can
      // report it instead.
      if (a.radioButton && a.buttonValue != null) {
        radioButtonValues.set(a.id, String(a.buttonValue));
      }

      if (!fieldNameToPage.has(a.fieldName)) {
        fieldNameToPage.set(a.fieldName, pageNum);
      }
      if (a.alternativeText) {
        fieldNameToLabel.set(a.fieldName, a.alternativeText);
      }
      if (a.rect) {
        fieldPositions.push({ name: a.fieldName, page: pageNum, y: a.rect[3] });
      }
      // Capture the value the widget will actually render. First widget wins
      // (radio groups share the field's /V so they all match anyway).
      if (!widgetFieldValues.has(a.fieldName) && a.fieldValue !== undefined) {
        widgetFieldValues.set(a.fieldName, a.fieldValue);
      }
    }
  }

  // Ordering: page ascending, then Y descending (top-to-bottom on page)
  fieldPositions.sort((a, b) => a.page - b.page || b.y - a.y);
  const seen = new Set<string>();
  let idx = 0;
  for (const fp of fieldPositions) {
    if (!seen.has(fp.name)) {
      seen.add(fp.name);
      fieldNameToOrder.set(fp.name, idx++);
    }
  }

  // Import baseline values AND remap cachedFieldObjects to widget IDs.
  //
  // Baseline: prefer the widget's fieldValue (what AnnotationLayer renders)
  // over getFieldObjects().value. A PDF can have the field-dict /V out of
  // sync with the widget — if we import the field-dict value, the panel
  // disagrees with what's on screen.
  //
  // Remap: pdf.js _bindResetFormAction (the PDF's in-document Reset button)
  // iterates this structure, using .id to key storage and find DOM elements
  // via [data-element-id=...]. Both use WIDGET ids. pdf-lib's save splits
  // merged field+widget objects, so we rebuild with widget ids.
  if (cachedFieldObjects) {
    const remapped: Record<string, any[]> = {};
    for (const [name, fieldArr] of Object.entries(cachedFieldObjects)) {
      const widgetIds = fieldNameToIds.get(name);
      if (!widgetIds) continue; // no widget → not rendered anyway

      // Type comes from getFieldObjects (widget annot data doesn't have it).
      // Value comes from the widget annotation (fall back to field-dict if
      // the widget didn't expose one).
      const type = fieldArr.find((f) => f.type)?.type;
      const raw = widgetFieldValues.has(name)
        ? widgetFieldValues.get(name)
        : fieldArr.find((f) => f.value != null)?.value;
      const v = normaliseFieldValue(type, raw);
      if (v !== null) {
        pdfBaselineFormValues.set(name, v);
        // Seed current state from baseline so the panel shows it. A
        // restored localStorage diff (applied in restoreAnnotations) will
        // overwrite specific fields the user changed.
        if (!formFieldValues.has(name)) formFieldValues.set(name, v);
      }

      // Skip parent entries with no concrete id (radio groups: the /T tree
      // has a parent with the export value, plus one child per widget).
      const concrete = fieldArr.filter((f) => f.id && f.type);
      remapped[name] = widgetIds.map((wid, i) => ({
        ...(concrete[i] ?? concrete[0] ?? fieldArr[0]),
        id: wid,
      }));
    }
    cachedFieldObjects = remapped;
  }

  log.info(`Built field name map: ${fieldNameToIds.size} fields`);
}

/** Sync formFieldValues into pdfDocument.annotationStorage so AnnotationLayer renders pre-filled values.
 *  Skips values that match the PDF's baseline — those are already in storage
 *  in pdf.js's native format (which may differ from our string/bool repr,
 *  e.g. checkbox stores "Yes" not `true`). Overwriting with our normalised
 *  form can break the Reset button's ability to restore defaults. */
function syncFormValuesToStorage(): void {
  if (!pdfDocument || fieldNameToIds.size === 0) return;
  const storage = pdfDocument.annotationStorage;
  for (const [name, value] of formFieldValues) {
    if (pdfBaselineFormValues.get(name) === value) continue;
    const ids = fieldNameToIds.get(name);
    if (ids) {
      for (const id of ids) {
        storage.setValue(id, {
          value: typeof value === "boolean" ? value : String(value),
        });
      }
    }
  }
}

// =============================================================================
// PDF Save / Download with Annotations
// =============================================================================

/** Build annotated PDF bytes from the current state. */
async function getAnnotatedPdfBytes(): Promise<Uint8Array> {
  if (!pdfDocument) throw new Error("No PDF loaded");
  const fullBytes = await pdfDocument.getData();

  // Only export user-added annotations; baseline ones are already in the PDF
  const annotations: PdfAnnotationDef[] = [];
  const baselineIds = new Set(pdfBaselineAnnotations.map((a) => a.id));
  for (const tracked of annotationMap.values()) {
    if (!baselineIds.has(tracked.def.id)) {
      annotations.push(tracked.def);
    }
  }

  return buildAnnotatedPdfBytes(
    fullBytes as Uint8Array,
    annotations,
    formFieldValues,
  );
}

async function savePdf(): Promise<void> {
  if (!pdfDocument || !isDirty || saveInProgress) return;

  const fileName =
    pdfUrl
      .replace(/^(file|computer):\/\//, "")
      .split(/[/\\]/)
      .pop() || pdfUrl;
  const choice = await showConfirmDialog(
    "Save PDF",
    "Overwrite this file with your annotations and form edits?",
    [{ label: "Cancel" }, { label: "Save", primary: true }],
    fileName,
  );
  if (choice !== 1) return;

  saveInProgress = true;
  saveBtn.disabled = true;
  saveBtn.title = "Saving...";

  try {
    const pdfBytes = await getAnnotatedPdfBytes();
    const base64 = uint8ArrayToBase64(pdfBytes);

    const result = await app.callServerTool({
      name: "save_pdf",
      arguments: { url: pdfUrl, data: base64 },
    });

    if (result.isError) {
      log.error("Save failed:", result.content);
      saveBtn.disabled = false; // let user retry
    } else {
      log.info("PDF saved");
      // Record mtime so we recognize our own write in file_changed
      const sc = result.structuredContent as { mtimeMs?: number } | undefined;
      lastSavedMtime = sc?.mtimeMs ?? null;

      // Rebase: the file on disk now contains our annotations + form values.
      // Update the baseline so future diffs are relative to what was saved.
      pdfBaselineAnnotations = [...annotationMap.values()].map((t) => ({
        ...t.def,
      }));
      pdfBaselineFormValues.clear();
      for (const [k, v] of formFieldValues) pdfBaselineFormValues.set(k, v);

      setDirty(false); // → updateSaveBtn() disables button
      const key = annotationStorageKey();
      if (key) {
        try {
          localStorage.removeItem(key);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    log.error("Save failed:", err);
    saveBtn.disabled = false;
  } finally {
    saveInProgress = false;
    saveBtn.title = "Save to file (overwrites original)";
  }
}

async function downloadAnnotatedPdf(): Promise<void> {
  if (!pdfDocument) return;
  downloadBtn.disabled = true;
  downloadBtn.title = "Preparing download...";

  try {
    const pdfBytes = await getAnnotatedPdfBytes();

    const hasEdits = annotationMap.size > 0 || formFieldValues.size > 0;
    const baseName = (pdfTitle || "document").replace(/\.pdf$/i, "");
    const fileName = hasEdits ? `${baseName} - edited.pdf` : `${baseName}.pdf`;

    const base64 = uint8ArrayToBase64(pdfBytes);

    if (app.getHostCapabilities()?.downloadFile) {
      const { isError } = await app.downloadFile({
        contents: [
          {
            type: "resource",
            resource: {
              uri: `file:///${fileName}`,
              mimeType: "application/pdf",
              blob: base64,
            },
          },
        ],
      });
      if (isError) {
        log.info("Download was cancelled or denied by host");
      }
    } else {
      // Fallback: create blob URL and trigger download
      const blob = new Blob([pdfBytes.buffer as ArrayBuffer], {
        type: "application/pdf",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    log.error("Download error:", err);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.title = "Download PDF";
  }
}

// Render state - prevents concurrent renders
let isRendering = false;
let pendingPage: number | null = null;

// Render current page with text layer for selection
async function renderPage() {
  if (!pdfDocument) return;

  // If already rendering, queue this page for later
  if (isRendering) {
    pendingPage = currentPage;
    // Cancel current render to speed up
    if (currentRenderTask) {
      currentRenderTask.cancel();
    }
    return;
  }

  isRendering = true;
  pendingPage = null;

  try {
    const pageToRender = currentPage;
    const page = await pdfDocument.getPage(pageToRender);
    const viewport = page.getViewport({ scale });

    // Account for retina displays
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvasEl.getContext("2d")!;

    // Set canvas size in pixels (scaled for retina)
    canvasEl.width = viewport.width * dpr;
    canvasEl.height = viewport.height * dpr;

    // Set display size in CSS pixels
    canvasEl.style.width = `${viewport.width}px`;
    canvasEl.style.height = `${viewport.height}px`;

    // Scale context for retina
    ctx.scale(dpr, dpr);

    // Clear and setup text layer
    textLayerEl.innerHTML = "";
    textLayerEl.style.width = `${viewport.width}px`;
    textLayerEl.style.height = `${viewport.height}px`;
    // Set --scale-factor so CSS font-size/transform rules work correctly.
    textLayerEl.style.setProperty("--scale-factor", `${scale}`);

    // Render canvas - track the task so we can cancel it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderTask = (page.render as any)({
      canvasContext: ctx,
      viewport,
    });
    currentRenderTask = renderTask;

    try {
      await renderTask.promise;
    } catch (renderErr) {
      // Ignore RenderingCancelledException - it's expected when we cancel
      if (
        renderErr instanceof Error &&
        renderErr.name === "RenderingCancelledException"
      ) {
        log.info("Render cancelled");
        return;
      }
      throw renderErr;
    } finally {
      currentRenderTask = null;
    }

    // Only continue if this is still the page we want
    if (pageToRender !== currentPage) {
      return;
    }

    // Render text layer for selection
    const textContent = await page.getTextContent();
    const textLayer = new TextLayer({
      textContentSource: textContent,
      container: textLayerEl,
      viewport,
    });
    await textLayer.render();

    // Cache page text items if not already cached
    if (!pageTextItemsCache.has(pageToRender)) {
      const items = (textContent.items as Array<{ str?: string }>).map(
        (item) => item.str || "",
      );
      pageTextItemsCache.set(pageToRender, items);
      pageTextCache.set(pageToRender, items.join(""));
    }

    // Size overlay layers to match canvas
    highlightLayerEl.style.width = `${viewport.width}px`;
    highlightLayerEl.style.height = `${viewport.height}px`;
    annotationLayerEl.style.width = `${viewport.width}px`;
    annotationLayerEl.style.height = `${viewport.height}px`;

    // Render PDF.js AnnotationLayer for interactive form widgets
    formLayerEl.innerHTML = "";
    formLayerEl.style.width = `${viewport.width}px`;
    formLayerEl.style.height = `${viewport.height}px`;
    // Set CSS custom properties so AnnotationLayer font-size rules work correctly
    formLayerEl.style.setProperty("--scale-factor", `${scale}`);
    formLayerEl.style.setProperty("--total-scale-factor", `${scale}`);
    try {
      const annotations = await page.getAnnotations();
      if (annotations.length > 0) {
        const linkService = {
          getDestinationHash: () => "#",
          getAnchorUrl: () => "#",
          addLinkAttributes: () => {},
          isPageVisible: () => true,
          isPageCached: () => true,
          externalLinkEnabled: true,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const annotationLayer = new AnnotationLayer({
          div: formLayerEl,
          page,
          viewport,
          annotationStorage: pdfDocument.annotationStorage,
          linkService,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          structTreeLayer: null,
          commentManager: null,
        } as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await annotationLayer.render({
          annotations,
          div: formLayerEl,
          page,
          viewport,
          renderForms: true,
          linkService,
          annotationStorage: pdfDocument.annotationStorage,
          fieldObjects: cachedFieldObjects,
        } as any);

        // Fix combo reset: pdf.js's resetform handler sets all
        // option.selected = (option.value === defaultFieldValue), and
        // defaultFieldValue is typically null — nothing matches. On a
        // non-multiple <select>, the browser immediately normalizes the
        // all-deselected state by auto-selecting the first option, so the
        // combo shows "New York" instead of blank.
        //
        // We can't check state AFTER pdf.js's handler (normalisation has
        // already happened), so we capture whether the select was blank
        // BEFORE the event. If reset maps to no option, restore blankness.
        for (const sel of formLayerEl.querySelectorAll<HTMLSelectElement>(
          "select:not([size])",
        )) {
          // data-default: exportValue the PDF's reset maps to ("" if none)
          const defaultExport =
            [...sel.options].find((o) => o.defaultSelected && o.value !== " ")
              ?.value ?? "";
          sel.addEventListener("resetform", () => {
            // pdf.js's handler has already run (registered first). If the
            // PDF's defaultFieldValue matched a real option, that option
            // is now selected and we're done. Otherwise, all were
            // deselected and the browser picked option[0].
            if (defaultExport && sel.value === defaultExport) return;
            // Re-insert a hidden blank and select it
            for (const o of sel.querySelectorAll('option[value=" "]')) {
              o.remove();
            }
            const blank = document.createElement("option");
            blank.value = " ";
            blank.hidden = true;
            sel.prepend(blank);
            sel.selectedIndex = 0;
            const removeBlank = () => {
              blank.remove();
              sel.removeEventListener("input", removeBlank);
            };
            sel.addEventListener("input", removeBlank);
          });
        }

        // Fix listbox font sizes: the default AnnotationLayer CSS uses
        // a fixed 9px * scale-factor which can overflow when many options
        // share a small PDF rect. Shrink font to fit.
        for (const sel of formLayerEl.querySelectorAll<HTMLSelectElement>(
          "select[size]",
        )) {
          const size = sel.size || sel.options.length;
          if (size > 1) {
            const maxFontPx = sel.clientHeight / size - 2; // 2px for padding
            if (maxFontPx > 0) {
              sel.style.fontSize = `${maxFontPx}px`;
            }
          }
        }
      }
    } catch (formErr) {
      log.info("Form layer render skipped:", formErr);
    }

    // Re-render search highlights if search is active
    if (searchOpen && searchQuery) {
      renderHighlights();
    }

    // Re-render annotations for current page
    renderAnnotationsForPage(pageToRender);

    updateControls();
    updatePageContext();

    // Request host to resize app to fit content (inline mode only)
    requestFitToContent();
  } catch (err) {
    log.error("Error rendering page:", err);
    showError(`Failed to render page ${currentPage}`);
  } finally {
    preloadPaused = false;
    isRendering = false;

    // If there's a pending page, render it now
    if (pendingPage !== null && pendingPage !== currentPage) {
      currentPage = pendingPage;
      renderPage();
    } else if (pendingPage === currentPage) {
      // Re-render the same page (e.g., after zoom change during render)
      renderPage();
    }
  }
}

function saveCurrentPage() {
  log.info("saveCurrentPage: key=", viewUUID, "page=", currentPage);
  if (viewUUID) {
    try {
      localStorage.setItem(viewUUID, String(currentPage));
      log.info("saveCurrentPage: saved successfully");
    } catch (err) {
      log.error("saveCurrentPage: error", err);
    }
  }
}

function loadSavedPage(): number | null {
  log.info("loadSavedPage: key=", viewUUID);
  if (!viewUUID) return null;
  try {
    const saved = localStorage.getItem(viewUUID);
    log.info("loadSavedPage: saved value=", saved);
    if (saved) {
      const page = parseInt(saved, 10);
      if (!isNaN(page) && page >= 1) {
        log.info("loadSavedPage: returning page=", page);
        return page;
      }
    }
  } catch (err) {
    log.error("loadSavedPage: error", err);
  }
  log.info("loadSavedPage: returning null");
  return null;
}

// Navigation
function goToPage(page: number) {
  const targetPage = Math.max(1, Math.min(page, totalPages));
  if (targetPage !== currentPage) {
    selectAnnotation(null);
    preloadPaused = true;
    currentPage = targetPage;
    saveCurrentPage();
    renderPage();
  }
  pageInputEl.value = String(currentPage);
}

function prevPage() {
  goToPage(currentPage - 1);
}

function nextPage() {
  goToPage(currentPage + 1);
}

function scrollSelectionIntoView(): void {
  if (selectedAnnotationIds.size === 0) return;
  // Use the first selected annotation's element
  for (const id of selectedAnnotationIds) {
    const tracked = annotationMap.get(id);
    if (tracked && tracked.elements.length > 0) {
      tracked.elements[0].scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      break;
    }
  }
}

function zoomIn() {
  userHasZoomed = true;
  scale = Math.min(scale + 0.25, 3.0);
  renderPage().then(scrollSelectionIntoView);
}

function zoomOut() {
  userHasZoomed = true;
  scale = Math.max(scale - 0.25, 0.5);
  renderPage().then(scrollSelectionIntoView);
}

function resetZoom() {
  userHasZoomed = false;
  scale = 1.0;
  renderPage().then(scrollSelectionIntoView);
}

async function toggleFullscreen() {
  const ctx = app.getHostContext();
  if (!ctx?.availableDisplayModes?.includes("fullscreen")) {
    log.info("Fullscreen not available");
    return;
  }

  const newMode = currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
  log.info("Requesting display mode:", newMode);

  try {
    const result = await app.requestDisplayMode({ mode: newMode });
    log.info("Display mode result:", result);
    currentDisplayMode = result.mode as "inline" | "fullscreen";
    updateFullscreenButton();
  } catch (err) {
    log.error("Failed to change display mode:", err);
  }
}

function updateFullscreenButton() {
  const isFs = currentDisplayMode === "fullscreen";
  const expandIcon = fullscreenBtn.querySelector(".expand-icon") as HTMLElement;
  const collapseIcon = fullscreenBtn.querySelector(
    ".collapse-icon",
  ) as HTMLElement;
  if (expandIcon) expandIcon.style.display = isFs ? "none" : "";
  if (collapseIcon) collapseIcon.style.display = isFs ? "" : "none";
  fullscreenBtn.title = isFs
    ? "Exit fullscreen (Esc)"
    : "Toggle fullscreen (⌘Enter)";
}

// Event listeners
prevBtn.addEventListener("click", prevPage);
nextBtn.addEventListener("click", nextPage);
zoomOutBtn.addEventListener("click", zoomOut);
zoomInBtn.addEventListener("click", zoomIn);
searchBtn.addEventListener("click", toggleSearch);
searchCloseBtn.addEventListener("click", closeSearch);
searchPrevBtn.addEventListener("click", goToPrevMatch);
searchNextBtn.addEventListener("click", goToNextMatch);
fullscreenBtn.addEventListener("click", toggleFullscreen);
downloadBtn.addEventListener("click", downloadAnnotatedPdf);
saveBtn.addEventListener("click", savePdf);

// Sync user form input back to formFieldValues for persistence
formLayerEl.addEventListener("input", (e) => {
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  const fieldName = target.name;
  if (!fieldName) return;
  let value: string | boolean;
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    value = target.checked;
  } else if (target instanceof HTMLInputElement && target.type === "radio") {
    // pdf.js doesn't set .value on radio inputs → target.value defaults to
    // "on". Use the widget's export value (buttonValue) so the panel and
    // baseline agree on the same representation.
    if (!target.checked) return; // unchecking siblings — ignore
    const wid = target.getAttribute("data-element-id");
    value = (wid && radioButtonValues.get(wid)) ?? target.value;
  } else {
    value = target.value;
  }
  formFieldValues.set(fieldName, value);
  updateAnnotationsBadge();
  renderAnnotationPanel();
  persistAnnotations();
});

// Track form field focus: deselect annotations + sync model context
formLayerEl.addEventListener(
  "focusin",
  (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const fieldName = target.name;
    if (!fieldName) return;
    // Focusing a form field deselects any selected annotations
    if (selectedAnnotationIds.size > 0) {
      selectAnnotation(null);
    }
    focusedFieldName = fieldName;
    updatePageContext();
  },
  true,
);

// Handle form reset: PDF.js dispatches "resetform" on each field element
formLayerEl.addEventListener(
  "resetform",
  (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const fieldName = target?.name;
    if (fieldName && formFieldValues.has(fieldName)) {
      formFieldValues.delete(fieldName);
    }
    // Debounce the UI update since resetform fires per-element
    if (!resetFormDebounceTimer) {
      resetFormDebounceTimer = setTimeout(() => {
        resetFormDebounceTimer = null;
        updateAnnotationsBadge();
        renderAnnotationPanel();
        persistAnnotations();
      }, 50);
    }
  },
  true,
);
let resetFormDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Clear focused field on blur
formLayerEl.addEventListener(
  "focusout",
  () => {
    if (focusedFieldName) {
      focusedFieldName = null;
      updatePageContext();
    }
  },
  true,
);

initAnnotationPanel();

// Search input events
searchInputEl.addEventListener("input", () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    performSearch(searchInputEl.value);
  }, 300);
});

searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) {
      goToPrevMatch();
    } else {
      goToNextMatch();
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});

pageInputEl.addEventListener("change", () => {
  const page = parseInt(pageInputEl.value, 10);
  if (!isNaN(page)) {
    goToPage(page);
  } else {
    pageInputEl.value = String(currentPage);
  }
});

pageInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    pageInputEl.blur();
  }
});

// Mousedown on text layer directly deselects annotations (catches cases where
// annotation mousedown stopPropagation prevents bubbling to canvasContainerEl)
textLayerEl.addEventListener("mousedown", () => {
  if (selectedAnnotationIds.size > 0) selectAnnotation(null);
  if (focusedFieldName) {
    focusedFieldName = null;
    updatePageContext();
  }
});

// Click on empty area / text layer to deselect annotations and blur fields
canvasContainerEl.addEventListener("mousedown", (e) => {
  const target = e.target as HTMLElement;
  // Deselect if clicking on container, canvas, page wrapper, or text layer content
  if (
    target === canvasContainerEl ||
    target === canvasEl ||
    target.classList?.contains("page-wrapper") ||
    target.closest(".text-layer")
  ) {
    if (selectedAnnotationIds.size > 0) {
      selectAnnotation(null);
    }
    if (focusedFieldName) {
      focusedFieldName = null;
      updatePageContext();
    }
  }
});

// Keyboard navigation
document.addEventListener("keydown", (e) => {
  // Delete/Backspace to delete selected annotations
  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    selectedAnnotationIds.size > 0
  ) {
    // Don't delete if user is typing in an input
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement ||
      document.activeElement instanceof HTMLSelectElement
    ) {
      return;
    }
    e.preventDefault();
    const ids = [...selectedAnnotationIds];
    selectAnnotation(null);
    for (const id of ids) {
      removeAnnotation(id);
    }
    persistAnnotations();
    return;
  }

  // Ctrl/Cmd+Z: undo, Ctrl/Cmd+Shift+Z: redo
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    // Don't intercept when typing in inputs
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
    ) {
      return;
    }
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else {
      undo();
    }
    return;
  }

  // Ctrl/Cmd+C: copy selected annotations
  if ((e.ctrlKey || e.metaKey) && e.key === "c" && !e.shiftKey) {
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (selectedAnnotationIds.size > 0) {
      e.preventDefault();
      copySelectedAnnotations();
    }
    return;
  }

  // Ctrl/Cmd+X: cut selected annotations (copy + delete)
  if ((e.ctrlKey || e.metaKey) && e.key === "x" && !e.shiftKey) {
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (selectedAnnotationIds.size > 0) {
      e.preventDefault();
      copySelectedAnnotations().then((copied) => {
        if (copied) {
          const ids = [...selectedAnnotationIds];
          selectAnnotation(null);
          for (const id of ids) {
            removeAnnotation(id);
          }
          persistAnnotations();
        }
      });
    }
    return;
  }

  // Ctrl/Cmd+S: save (for local files)
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    if (fileWritable && isDirty) {
      savePdf();
    }
    return;
  }

  // Ctrl/Cmd+Enter: toggle fullscreen
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    toggleFullscreen();
    return;
  }

  // Ctrl/Cmd+F: open our search if closed; if already focused, pass through to browser find
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    if (!searchOpen) {
      e.preventDefault();
      openSearch();
    } else if (document.activeElement === searchInputEl) {
      // Already focused — close ours and let browser find open
      closeSearch();
    } else {
      // Open but not focused — re-focus our search
      e.preventDefault();
      searchInputEl.focus();
      searchInputEl.select();
    }
    return;
  }

  // Don't handle nav shortcuts when an input element is focused
  if (document.activeElement === searchInputEl) return;
  if (document.activeElement === pageInputEl) return;
  if (
    document.activeElement instanceof HTMLInputElement ||
    document.activeElement instanceof HTMLTextAreaElement ||
    document.activeElement instanceof HTMLSelectElement
  )
    return;

  // Ctrl/Cmd+0 to reset zoom
  if ((e.ctrlKey || e.metaKey) && e.key === "0") {
    resetZoom();
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case "Escape":
      if (selectedAnnotationIds.size > 0) {
        selectAnnotation(null);
        e.preventDefault();
      } else if (searchOpen) {
        closeSearch();
        e.preventDefault();
      } else if (currentDisplayMode === "fullscreen") {
        toggleFullscreen();
        e.preventDefault();
      }
      break;
    case "ArrowLeft":
    case "PageUp":
      prevPage();
      e.preventDefault();
      break;
    case "ArrowRight":
    case "PageDown":
    case " ":
      nextPage();
      e.preventDefault();
      break;
    case "+":
    case "=":
      zoomIn();
      e.preventDefault();
      break;
    case "-":
      zoomOut();
      e.preventDefault();
      break;
  }
});

// Update context when text selection changes (debounced)
let selectionUpdateTimeout: ReturnType<typeof setTimeout> | null = null;
document.addEventListener("selectionchange", () => {
  if (selectionUpdateTimeout) clearTimeout(selectionUpdateTimeout);
  selectionUpdateTimeout = setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (text) {
      // Any text selection deselects annotations and blurs fields
      if (selectedAnnotationIds.size > 0) selectAnnotation(null);
      if (focusedFieldName) {
        focusedFieldName = null;
      }
    }
    if (text && text.length > 2) {
      log.info("Selection changed:", text.slice(0, 50));
      updatePageContext();
    }
  }, 300);
});

// Horizontal scroll/swipe to change pages (disabled when zoomed)
let horizontalScrollAccumulator = 0;
const SCROLL_THRESHOLD = 50;

canvasContainerEl.addEventListener(
  "wheel",
  (event) => {
    const e = event as WheelEvent;

    // Only intercept horizontal scroll, let vertical scroll through
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;

    // When zoomed, let natural panning happen (no page changes)
    if (scale > 1.0) return;

    // At 100% zoom, handle page navigation
    e.preventDefault();
    horizontalScrollAccumulator += e.deltaX;
    if (horizontalScrollAccumulator > SCROLL_THRESHOLD) {
      nextPage();
      horizontalScrollAccumulator = 0;
    } else if (horizontalScrollAccumulator < -SCROLL_THRESHOLD) {
      prevPage();
      horizontalScrollAccumulator = 0;
    }
  },
  { passive: false },
);

// Parse tool result
function parseToolResult(result: CallToolResult): {
  url: string;
  title?: string;
  pageCount: number;
  initialPage: number;
  totalBytes: number;
} | null {
  return result.structuredContent as {
    url: string;
    title?: string;
    pageCount: number;
    initialPage: number;
    totalBytes: number;
  } | null;
}

// Chunked binary loading types
interface PdfBytesChunk {
  url: string;
  bytes: string;
  offset: number;
  byteCount: number;
  totalBytes: number;
  hasMore: boolean;
}

// Range request caching — avoid duplicate fetches for the same range
type RangeResult = { bytes: Uint8Array; totalBytes: number };
const rangeCache = new Map<string, RangeResult>();
const inflightRequests = new Map<string, Promise<RangeResult>>();

// Max bytes per server request (must match server's MAX_CHUNK_BYTES)
const MAX_CHUNK_BYTES = 512 * 1024;

/**
 * Fetch a single chunk from the server (up to MAX_CHUNK_BYTES).
 * Deduplicates concurrent requests for the same range via inflightRequests.
 */
async function fetchChunk(
  url: string,
  begin: number,
  end: number,
): Promise<RangeResult> {
  const gen = loadGeneration; // capture before any await
  const cacheKey = `${url}:${begin}-${end}`;
  const cached = rangeCache.get(cacheKey);
  if (cached) return cached;

  // Deduplicate: reuse in-flight request for the same range
  const inflight = inflightRequests.get(cacheKey);
  if (inflight) return inflight;

  const request = (async (): Promise<RangeResult> => {
    try {
      const result = await app.callServerTool({
        name: "read_pdf_bytes",
        arguments: { url, offset: begin, byteCount: end - begin },
      });

      if (result.isError) {
        const errorText =
          result.content?.map((c) => ("text" in c ? c.text : "")).join(" ") ||
          "";
        throw new Error(`Tool error: ${errorText}`);
      }

      if (!result.structuredContent) {
        throw new Error("No structuredContent in tool response");
      }

      const chunk = result.structuredContent as unknown as PdfBytesChunk;
      const binaryString = atob(chunk.bytes);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // PDF was reloaded while this fetch was in flight — don't poison the
      // cache with bytes from the old generation's offsets.
      if (gen !== loadGeneration) {
        throw new Error("Fetch cancelled — PDF was reloaded");
      }

      const entry: RangeResult = { bytes, totalBytes: chunk.totalBytes };
      rangeCache.set(cacheKey, entry);
      return entry;
    } finally {
      inflightRequests.delete(cacheKey);
    }
  })();

  inflightRequests.set(cacheKey, request);
  return request;
}

/**
 * Fetch a byte range from the PDF, splitting into parallel sub-requests
 * if the range exceeds MAX_CHUNK_BYTES.
 */
async function fetchRange(
  url: string,
  begin: number,
  end: number,
): Promise<RangeResult> {
  const size = end - begin;

  // Single chunk — no splitting needed
  if (size <= MAX_CHUNK_BYTES) {
    return fetchChunk(url, begin, end);
  }

  // Split into parallel sub-requests
  const chunks: Array<{ begin: number; end: number }> = [];
  for (let offset = begin; offset < end; offset += MAX_CHUNK_BYTES) {
    chunks.push({
      begin: offset,
      end: Math.min(offset + MAX_CHUNK_BYTES, end),
    });
  }
  log.info(
    `Splitting range ${begin}-${end} (${(size / 1024) | 0} KB) into ${chunks.length} parallel chunks`,
  );

  const results = await Promise.all(
    chunks.map((c) => fetchChunk(url, c.begin, c.end)),
  );

  // Reassemble into a single buffer
  const totalLen = results.reduce((sum, r) => sum + r.bytes.length, 0);
  const combined = new Uint8Array(totalLen);
  let pos = 0;
  for (const r of results) {
    combined.set(r.bytes, pos);
    pos += r.bytes.length;
  }

  const entry = { bytes: combined, totalBytes: results[0].totalBytes };
  rangeCache.set(`${url}:${begin}-${end}`, entry);
  return entry;
}

/**
 * Reload the current PDF from disk, discarding all in-memory edits and caches.
 * Preserves currentPage (clamped). Does not stop/restart the poll loop.
 */
async function reloadPdf(): Promise<void> {
  log.info("Reloading PDF from disk");
  showLoading("Reloading...");

  // Invalidate all in-flight fetches and the preloader
  loadGeneration++;

  // Drop byte cache — file contents changed, everything is stale.
  // In-flight requests will check loadGeneration before re-populating.
  rangeCache.clear();
  inflightRequests.clear();

  // Cancel active render and destroy the old document
  currentRenderTask?.cancel();
  currentRenderTask = null;
  const oldDoc = pdfDocument;
  pdfDocument = null;
  await oldDoc?.destroy().catch(() => {});

  // Clear per-document edit/display state
  for (const [, t] of annotationMap) for (const el of t.elements) el.remove();
  annotationMap.clear();
  formFieldValues.clear();
  imageCache.clear();
  selectedAnnotationIds.clear();
  undoStack.length = 0;
  redoStack.length = 0;
  pdfBaselineAnnotations = [];
  pdfBaselineFormValues.clear();
  pageTextCache.clear();
  pageTextItemsCache.clear();
  allMatches = [];
  currentMatchIndex = -1;
  focusedFieldName = null;
  fieldNameToIds.clear();
  radioButtonValues.clear();
  fieldNameToLabel.clear();
  fieldNameToOrder.clear();
  cachedFieldObjects = null;

  // Drop persisted localStorage diff — disk is now the source of truth
  const key = annotationStorageKey();
  if (key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  // Reset save-button state machine
  saveBtnEverShown = false;
  lastSavedMtime = null;
  isDirty = false;
  updateTitleDisplay();
  updateSaveBtn();

  // Reset preload indicators
  pagesLoaded = 0;
  preloadErrors = [];
  loadingIndicatorEl.classList.remove("error");
  loadingIndicatorEl.style.display = "none";

  try {
    const { document, totalBytes } = await loadPdfProgressively(pdfUrl);
    pdfDocument = document;
    totalPages = document.numPages;
    currentPage = Math.max(1, Math.min(currentPage, totalPages));
    log.info("PDF reloaded:", totalPages, "pages,", totalBytes, "bytes");

    showViewer();
    await loadBaselineAnnotations(document);
    await buildFieldNameMap(document);
    syncFormValuesToStorage();
    updateAnnotationsBadge();
    renderAnnotationPanel();
    renderPage();
    startPreloading();
  } catch (err) {
    log.error("Reload failed:", err);
    showError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Load PDF progressively using PDFDataRangeTransport.
 * PDF.js will request ranges as needed to render pages.
 */
async function loadPdfProgressively(urlToLoad: string): Promise<{
  document: pdfjsLib.PDFDocumentProxy;
  totalBytes: number;
}> {
  class AppRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      fetchRange(urlToLoad, begin, end)
        .then((result) => {
          this.onDataRange(begin, result.bytes);
        })
        .catch((err: unknown) => {
          log.error(`Error fetching range ${begin}-${end}:`, err);
        });
    }
  }

  // Probe current file size via a live read_pdf_bytes call. Don't trust the
  // totalBytes from the display_pdf result: that's baked into conversation
  // history, so if the user saved the PDF (annotations/form fields) and
  // reloaded the conversation, the host replays a stale value. A mismatch
  // makes pdf.js fail every chunk with an opaque "Bad end offset: N".
  const { totalBytes: fileTotalBytes } = await fetchChunk(urlToLoad, 0, 1);
  if (!Number.isInteger(fileTotalBytes) || fileTotalBytes <= 0) {
    throw new Error(`Invalid totalBytes (${fileTotalBytes}) from server`);
  }
  log.info(`PDF file size: ${(fileTotalBytes / 1024) | 0} KB`);

  // Create transport with total file size, no initial data — PDF.js will request what it needs
  const transport = new AppRangeTransport(fileTotalBytes, null);

  const loadingTask = pdfjsLib.getDocument({
    range: transport,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });

  try {
    const document = await loadingTask.promise;
    log.info(
      `PDF document ready, ${document.numPages} pages, ${fileTotalBytes} bytes`,
    );
    return { document, totalBytes: fileTotalBytes };
  } catch (err: unknown) {
    log.error("Error loading PDF document:", err);
    throw err;
  }
}

// --- Loading indicator ---

const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 8; // ~50.27

function updateLoadingIndicator() {
  if (totalPages <= 0) return;
  const pct = pagesLoaded / totalPages;
  const offset = CIRCLE_CIRCUMFERENCE * (1 - pct);
  loadingIndicatorArc.style.strokeDashoffset = String(offset);
  loadingIndicatorEl.style.display = "inline-flex";
  loadingIndicatorEl.title = `${pagesLoaded}/${totalPages} pages loaded`;
  if (preloadErrors.length > 0) {
    loadingIndicatorEl.classList.add("error");
    const failedPages = preloadErrors.map((e) => e.page).join(", ");
    loadingIndicatorEl.title += ` (errors on pages: ${failedPages})`;
  }
}

function finalizeLoadingIndicator() {
  updateLoadingIndicator();
  if (preloadErrors.length > 0) return; // Keep visible with error state
  setTimeout(() => {
    loadingIndicatorEl.style.opacity = "0";
    setTimeout(() => {
      loadingIndicatorEl.style.display = "none";
      loadingIndicatorEl.style.opacity = "";
    }, 300);
  }, 500);
}

// --- Background preloader ---

let preloadSearchTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a debounced search refresh while preloading */
function scheduleSearchRefresh() {
  if (!searchOpen || !searchQuery) return;
  if (preloadSearchTimer) return; // already scheduled
  preloadSearchTimer = setTimeout(() => {
    preloadSearchTimer = null;
    if (searchOpen && searchQuery) performSearch(searchQuery);
  }, 500);
}

async function startPreloading() {
  if (!pdfDocument) return;
  const gen = loadGeneration;
  log.info("Starting background preload of", totalPages, "pages");
  for (let i = 1; i <= totalPages; i++) {
    if (gen !== loadGeneration) {
      log.info("Preload aborted — PDF reloaded");
      return;
    }
    if (pageTextCache.has(i)) {
      pagesLoaded++;
      updateLoadingIndicator();
      continue;
    }

    // Yield to interactive navigation
    while (preloadPaused) await new Promise((r) => setTimeout(r, 50));

    try {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      const items = (textContent.items as Array<{ str?: string }>).map(
        (item) => item.str || "",
      );
      pageTextItemsCache.set(i, items);
      pageTextCache.set(i, items.join(""));
      pagesLoaded++;
      updateLoadingIndicator();
      scheduleSearchRefresh();
    } catch (err) {
      preloadErrors.push({ page: i, err });
      log.error("Preload error page", i, err);
      updateLoadingIndicator();
    }
  }
  log.info("Background preload complete:", pagesLoaded, "pages loaded");
  finalizeLoadingIndicator();
  // Final search update
  if (searchOpen && searchQuery) performSearch(searchQuery);
}

// Handle tool result
app.ontoolresult = async (result: CallToolResult) => {
  log.info("Received tool result:", result);

  const parsed = parseToolResult(result);
  if (!parsed) {
    showError("Invalid tool result");
    return;
  }

  pdfUrl = parsed.url;
  pdfTitle = parsed.title;
  // Note: pageCount may not be accurate until document loads
  totalPages = parsed.pageCount || 1;
  viewUUID = result._meta?.viewUUID ? String(result._meta.viewUUID) : undefined;
  interactEnabled = result._meta?.interactEnabled === true;
  fileWritable = result._meta?.writable === true;
  // TODO remove — debug: dump writability inputs so we can eyeball the mismatch
  if (result._meta?._debug !== undefined) showDebugBubble(result._meta._debug);

  // Restore saved page or use initial page
  const savedPage = loadSavedPage();
  currentPage =
    savedPage && savedPage <= parsed.pageCount ? savedPage : parsed.initialPage;

  log.info("URL:", pdfUrl, "Starting at page:", currentPage);

  showLoading("Loading PDF...");

  try {
    // Use progressive loading - document available as soon as initial data arrives
    const { document, totalBytes } = await loadPdfProgressively(pdfUrl);
    pdfDocument = document;
    totalPages = document.numPages;

    log.info("PDF loaded, pages:", totalPages, "bytes:", totalBytes);

    // Reset preload state for new PDF
    pagesLoaded = 0;
    preloadErrors = [];
    pageTextCache.clear();
    pageTextItemsCache.clear();
    loadingIndicatorEl.classList.remove("error");
    loadingIndicatorEl.style.opacity = "";
    loadingIndicatorEl.style.display = "none";

    showViewer();
    // TODO: Re-enable capability check when host downloadFile is fixed:
    downloadBtn.style.display = app.getHostCapabilities()?.downloadFile
      ? ""
      : "none";
    // downloadBtn.style.display = "";
    // Save button visibility driven by setDirty()/updateSaveBtn();
    // restoreAnnotations() above may have already shown it via setDirty(true).
    updateSaveBtn();

    // Import annotations from the PDF to establish baseline
    await loadBaselineAnnotations(document);
    // Restore any persisted user diff
    restoreAnnotations();

    // Build field name → annotation ID mapping for form filling
    await buildFieldNameMap(document);
    // Pre-populate annotationStorage from restored formFieldValues
    syncFormValuesToStorage();

    updateAnnotationsBadge();

    // Compute fit-to-width scale for narrow containers (e.g. mobile)
    const fitScale = await computeFitToWidthScale();
    if (fitScale !== null) {
      scale = fitScale;
      log.info("Fit-to-width scale:", scale);
    }

    renderPage();
    // Start background preloading of all pages for text extraction
    startPreloading();

    // Start polling for commands now that we have viewUUID
    if (viewUUID && interactEnabled) {
      startPolling();
    } else {
      log.info("Interact disabled on server — skipping poll_pdf_commands loop");
    }
  } catch (err) {
    log.error("Error loading PDF:", err);
    showError(err instanceof Error ? err.message : String(err));
  }
};

app.onerror = (err: unknown) => {
  log.error("App error:", err);
  showError(err instanceof Error ? err.message : String(err));
};

// =============================================================================
// Command Queue Polling
// =============================================================================

type PdfCommand =
  | { type: "navigate"; page: number }
  | { type: "search"; query: string }
  | { type: "find"; query: string }
  | { type: "search_navigate"; matchIndex: number }
  | { type: "zoom"; scale: number }
  | { type: "add_annotations"; annotations: PdfAnnotationDef[] }
  | {
      type: "update_annotations";
      annotations: Array<
        Partial<PdfAnnotationDef> & { id: string; type: string }
      >;
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
      fields: Array<{ name: string; value: string | boolean }>;
    }
  | {
      type: "get_pages";
      requestId: string;
      intervals: Array<{ start?: number; end?: number }>;
      getText: boolean;
      getScreenshots: boolean;
    }
  | { type: "file_changed"; mtimeMs: number };

/** Get page height in PDF points (for coordinate conversion). */
async function getPageHeight(pageNum: number): Promise<number> {
  if (!pdfDocument) return 792; // US Letter fallback
  const page = await pdfDocument.getPage(pageNum);
  return page.getViewport({ scale: 1.0 }).height;
}

/**
 * Process a batch of commands from the server queue
 */
async function processCommands(commands: PdfCommand[]): Promise<void> {
  if (commands.length === 0) return;

  for (const cmd of commands) {
    log.info("Processing command:", cmd.type, cmd);
    switch (cmd.type) {
      case "navigate":
        if (cmd.page >= 1 && cmd.page <= totalPages) {
          goToPage(cmd.page);
        }
        break;
      case "search":
        openSearch();
        searchInputEl.value = cmd.query;
        performSearch(cmd.query);
        break;
      case "find":
        performSilentSearch(cmd.query);
        break;
      case "search_navigate":
        if (
          allMatches.length > 0 &&
          cmd.matchIndex >= 0 &&
          cmd.matchIndex < allMatches.length
        ) {
          currentMatchIndex = cmd.matchIndex;
          const match = allMatches[cmd.matchIndex];
          if (match.pageNum !== currentPage) {
            goToPage(match.pageNum);
          }
          renderHighlights();
          updateSearchUI();
          updatePageContext();
        }
        break;
      case "zoom":
        if (cmd.scale >= 0.5 && cmd.scale <= 3.0) {
          scale = cmd.scale;
          renderPage();
        }
        break;
      case "add_annotations":
        for (const def of cmd.annotations) {
          const pageHeight = await getPageHeight(def.page);
          addAnnotation(convertFromModelCoords(def, pageHeight));
        }
        break;
      case "update_annotations":
        for (const update of cmd.annotations) {
          const existing = annotationMap.get(update.id);
          if (!existing) continue;
          const pageHeight = await getPageHeight(existing.def.page);
          // Merge partial update into existing def, convert the merged result,
          // then extract only the fields that were in the original update
          const merged = { ...existing.def, ...update } as PdfAnnotationDef;
          const converted = convertFromModelCoords(merged, pageHeight);
          const convertedUpdate = { ...update } as Record<string, unknown> &
            typeof update;
          for (const key of Object.keys(update)) {
            convertedUpdate[key] = (
              converted as unknown as Record<string, unknown>
            )[key];
          }
          updateAnnotation(
            convertedUpdate as Partial<PdfAnnotationDef> & {
              id: string;
              type: string;
            },
          );
        }
        break;
      case "remove_annotations":
        for (const id of cmd.ids) {
          removeAnnotation(id);
        }
        // Re-render annotation layer since elements were removed
        renderAnnotationsForPage(currentPage);
        break;
      case "highlight_text":
        handleHighlightText(cmd);
        break;
      case "fill_form":
        for (const field of cmd.fields) {
          formFieldValues.set(field.name, field.value);
          // Set in PDF.js annotation storage and update DOM elements directly
          if (pdfDocument) {
            const ids = fieldNameToIds.get(field.name);
            if (ids) {
              for (const id of ids) {
                pdfDocument.annotationStorage.setValue(id, {
                  value:
                    typeof field.value === "boolean"
                      ? field.value
                      : String(field.value),
                });
                // Update the live DOM element if it exists on the current page
                const el = formLayerEl.querySelector(
                  `[data-element-id="${id}"]`,
                ) as
                  | HTMLInputElement
                  | HTMLSelectElement
                  | HTMLTextAreaElement
                  | null;
                if (el) {
                  if (
                    el instanceof HTMLInputElement &&
                    el.type === "checkbox"
                  ) {
                    el.checked = !!field.value;
                  } else if (el instanceof HTMLSelectElement) {
                    el.value = String(field.value);
                  } else {
                    el.value = String(field.value);
                  }
                }
              }
            } else {
              log.info(
                `fill_form: no annotation IDs for field "${field.name}"`,
              );
            }
          }
        }
        // Re-render to show updated form values (handles fields on other pages)
        renderPage();
        // Update sidebar badge and panel to reflect new form field values
        updateAnnotationsBadge();
        renderAnnotationPanel();
        break;
      case "get_pages":
        // Await so the next poll doesn't start until submit_page_data has
        // been SENT. The host (Claude Desktop/Nest) serializes iframe→server
        // tool calls — if we re-poll immediately, submit_page_data queues
        // behind the 30s long-poll and interact times out. Awaiting costs a
        // few seconds of poll gap, but interact is blocked in waitForPageData
        // anyway so no commands are lost.
        try {
          await handleGetPages(cmd);
        } catch (err) {
          log.error("get_pages failed — submitting empty result:", err);
          await app
            .callServerTool({
              name: "submit_page_data",
              arguments: { requestId: cmd.requestId, pages: [] },
            })
            .catch(() => {});
        }
        break;
      case "file_changed": {
        // Skip our own save_pdf echo: either save is still in flight, or the
        // event's mtime matches what save_pdf just returned.
        if (saveInProgress) {
          log.info("file_changed: save in progress, ignoring");
          break;
        }
        if (
          lastSavedMtime !== null &&
          Math.abs(cmd.mtimeMs - lastSavedMtime) < 1
        ) {
          log.info("file_changed: matches our last save, ignoring");
          lastSavedMtime = null; // one-shot
          break;
        }

        if (!isDirty) {
          await reloadPdf();
        } else {
          const choice = await showConfirmDialog(
            "File changed on disk",
            "The PDF was modified outside this viewer, but you have unsaved " +
              "edits. Keeping your edits may cause rendering errors when " +
              "scrolling to pages that haven't loaded yet.",
            [
              { label: "Discard & reload" },
              { label: "Keep my edits", primary: true },
            ],
          );
          if (choice === 0) {
            await reloadPdf();
          }
        }
        break;
      }
    }
  }

  // Persist after processing batch — but only if anything mutated.
  // get_pages / file_changed are read-only; writing localStorage and
  // recomputing the diff for them is wasted work.
  if (
    commands.some((c) => c.type !== "get_pages" && c.type !== "file_changed")
  ) {
    persistAnnotations();
  }
}

let polling = false;

function startPolling(): void {
  if (polling) return;
  polling = true;
  pollLoop();
}

async function pollLoop(): Promise<void> {
  while (polling && viewUUID) {
    try {
      const result = await app.callServerTool({
        name: "poll_pdf_commands",
        arguments: { viewUUID },
      });
      if (result.isError) {
        // Tool not found or server rejected — stop polling entirely rather
        // than spin on a non-recoverable error result (which doesn't throw).
        log.error("poll_pdf_commands error — stopping poll loop:", result);
        polling = false;
        return;
      }
      const commands =
        (result.structuredContent as { commands?: PdfCommand[] })?.commands ||
        [];
      if (commands.length > 0) {
        log.info(`Received ${commands.length} command(s)`);
        await processCommands(commands);
      }
    } catch (err) {
      log.error("Poll error:", err);
      // Back off on error to avoid tight error loops
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function stopPolling(): void {
  polling = false;
}

function handleHostContextChanged(ctx: McpUiHostContext) {
  log.info("Host context changed:", ctx);

  // Apply theme from host
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }

  // Apply host CSS variables
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }

  // Apply safe area insets — set CSS custom properties for use in both
  // inline mode (padding on .main) and fullscreen mode (padding on .toolbar)
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    mainEl.style.setProperty("--safe-top", `${top}px`);
    mainEl.style.setProperty("--safe-right", `${right}px`);
    mainEl.style.setProperty("--safe-bottom", `${bottom}px`);
    mainEl.style.setProperty("--safe-left", `${left}px`);
    mainEl.style.paddingTop = `${top}px`;
    mainEl.style.paddingRight = `${right}px`;
    mainEl.style.paddingBottom = `${bottom}px`;
    mainEl.style.paddingLeft = `${left}px`;
  }

  // Recompute fit-to-width when container dimensions change
  if (ctx.containerDimensions && pdfDocument && !userHasZoomed) {
    log.info("Container dimensions changed:", ctx.containerDimensions);
    computeFitToWidthScale().then((fitScale) => {
      if (fitScale !== null && Math.abs(fitScale - scale) > 0.01) {
        scale = fitScale;
        log.info("Recomputed fit-to-width scale:", scale);
        renderPage();
      }
    });
  }

  // Handle display mode changes
  if (ctx.displayMode) {
    const wasFullscreen = currentDisplayMode === "fullscreen";
    currentDisplayMode = ctx.displayMode as "inline" | "fullscreen";
    const isFullscreen = currentDisplayMode === "fullscreen";
    mainEl.classList.toggle("fullscreen", isFullscreen);
    log.info(isFullscreen ? "Fullscreen mode enabled" : "Inline mode");
    // Re-apply panel layout for new display mode
    if (annotationPanelOpen) {
      setAnnotationPanelOpen(true);
    }
    // When exiting fullscreen, request resize to fit content
    if (wasFullscreen && !isFullscreen && pdfDocument) {
      requestFitToContent();
    }
    updateFullscreenButton();
  }
}

app.onteardown = async () => {
  log.info("App is being torn down");
  stopPolling();
  return {};
};

app.onhostcontextchanged = handleHostContextChanged;

// Connect to host
app.connect().then(() => {
  log.info("Connected to host");
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
  // Restore annotations early using toolInfo.id (available before tool result)
  restoreAnnotations();
  updateAnnotationsBadge();
});

// =============================================================================
// Image from File (shared by drag-drop and paste)
// =============================================================================

/**
 * Create an image annotation from a File/Blob at the given screen position.
 * If no position is given, places the image at the center of the current page.
 */
function addImageFromFile(
  file: File | Blob,
  screenX?: number,
  screenY?: number,
): void {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    const base64 = dataUrl.split(",")[1];
    const mimeType =
      file.type || (base64.startsWith("/9j/") ? "image/jpeg" : "image/png");

    const img = new Image();
    img.onload = () => {
      const maxWidth = 200; // PDF points
      const aspectRatio = img.naturalHeight / img.naturalWidth;
      const width = Math.min(img.naturalWidth, maxWidth);
      const height = width * aspectRatio;

      // Convert screen position to PDF internal coords, or default to page center
      let pdfX: number;
      let pdfInternalY: number;
      if (screenX != null && screenY != null) {
        pdfX = screenX / scale;
        pdfInternalY = (containerHtmlEl.clientHeight - screenY) / scale;
      } else {
        // Center on the visible page area
        const pageW = containerHtmlEl.clientWidth / scale;
        const pageH = containerHtmlEl.clientHeight / scale;
        pdfX = pageW / 2 - width / 2;
        pdfInternalY = pageH / 2 + height / 2;
      }

      const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const def: ImageAnnotation = {
        type: "image",
        id,
        page: currentPage,
        x: pdfX,
        y: pdfInternalY,
        width,
        height,
        imageData: base64,
        mimeType,
      };

      // Downscale if base64 data is too large (> ~300KB)
      if (base64.length > 400_000) {
        const canvas = document.createElement("canvas");
        const maxDim = 800;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        const quality = mimeType === "image/jpeg" ? 0.7 : undefined;
        const downscaledUrl = canvas.toDataURL(mimeType, quality);
        def.imageData = downscaledUrl.split(",")[1];
      }

      addAnnotation(def);
      selectAnnotation(def.id);
      persistAnnotations();
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

// =============================================================================
// Image Drag & Drop
// =============================================================================

const containerHtmlEl = canvasContainerEl as HTMLElement;
containerHtmlEl.addEventListener("dragover", (e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

containerHtmlEl.addEventListener("drop", async (e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  if (!e.dataTransfer?.files.length) return;

  const containerRect = containerHtmlEl.getBoundingClientRect();
  const dropX = e.clientX - containerRect.left;
  const dropY = e.clientY - containerRect.top;

  for (const file of e.dataTransfer.files) {
    if (!file.type.startsWith("image/")) continue;
    addImageFromFile(file, dropX, dropY);
  }
});

// =============================================================================
// Clipboard: Copy / Cut / Paste
// =============================================================================

/** Clipboard format identifier so we can recognize our own data on paste. */
const CLIPBOARD_FORMAT = "pdf-annotations/v1";

/** Copy selected annotations to clipboard as JSON. Returns true if anything was copied. */
async function copySelectedAnnotations(): Promise<boolean> {
  if (selectedAnnotationIds.size === 0) return false;
  const defs: PdfAnnotationDef[] = [];
  for (const id of selectedAnnotationIds) {
    const tracked = annotationMap.get(id);
    if (tracked) defs.push({ ...tracked.def });
  }
  if (defs.length === 0) return false;

  const payload = JSON.stringify({
    format: CLIPBOARD_FORMAT,
    annotations: defs,
  });
  try {
    await navigator.clipboard.writeText(payload);
    return true;
  } catch {
    return false;
  }
}

/** Try to parse clipboard text as our annotation format. */
function parseAnnotationClipboard(text: string): PdfAnnotationDef[] | null {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed?.format === CLIPBOARD_FORMAT &&
      Array.isArray(parsed.annotations)
    ) {
      return parsed.annotations;
    }
  } catch {
    // Not our format
  }
  return null;
}

/** Paste annotations or images from clipboard. */
function handlePaste(e: ClipboardEvent): void {
  // Don't intercept paste in inputs
  if (
    document.activeElement instanceof HTMLInputElement ||
    document.activeElement instanceof HTMLTextAreaElement ||
    document.activeElement instanceof HTMLSelectElement
  ) {
    return;
  }

  const clipboardData = e.clipboardData;
  if (!clipboardData) return;

  // Check for image files first
  for (const item of clipboardData.items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) addImageFromFile(file);
      return;
    }
  }

  // Check for text that might be our annotation format
  const text = clipboardData.getData("text/plain");
  if (!text) return;

  const annotations = parseAnnotationClipboard(text);
  if (!annotations || annotations.length === 0) return;

  e.preventDefault();

  // Paste with new IDs and a slight offset so they don't overlap originals
  const offset = 10; // PDF points
  selectAnnotation(null);
  for (const def of annotations) {
    def.id = `paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    def.page = currentPage;
    if ("x" in def && typeof def.x === "number") def.x += offset;
    if ("y" in def && typeof def.y === "number") def.y += offset;
    if ("rects" in def && Array.isArray(def.rects)) {
      for (const r of def.rects) {
        r.x += offset;
        r.y += offset;
      }
    }
    addAnnotation(def);
    selectAnnotation(def.id, true);
  }
  persistAnnotations();
}

document.addEventListener("paste", handlePaste);
