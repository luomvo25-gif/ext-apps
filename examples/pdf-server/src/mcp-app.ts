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
import { AnnotationLayer, TextLayer } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import { PDFDocument, rgb, StandardFonts, degrees } from "pdf-lib";
import "./global.css";
import "./mcp-app.css";

const MAX_MODEL_CONTEXT_LENGTH = 15000;
const MAX_MODEL_CONTEXT_UPDATE_IMAGE_DIMENSION = 768; // Max screenshot dimension
// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).href;

const log = {
  info: console.log.bind(console, "[PDF-VIEWER]"),
  error: console.error.bind(console, "[PDF-VIEWER]"),
};

// State
let pdfDocument: pdfjsLib.PDFDocumentProxy | null = null;
let currentPage = 1;
let totalPages = 0;
let scale = 1.0;
let pdfUrl = "";
let pdfTitle: string | undefined;
let viewUUID: string | undefined;
let currentRenderTask: { cancel: () => void } | null = null;

// =============================================================================
// Annotation Types (mirrors server schemas)
// =============================================================================

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type StampLabel =
  | "APPROVED"
  | "DRAFT"
  | "CONFIDENTIAL"
  | "FINAL"
  | "VOID"
  | "REJECTED";

interface AnnotationBase {
  id: string;
  page: number;
}

interface HighlightAnnotation extends AnnotationBase {
  type: "highlight";
  rects: Rect[];
  color?: string;
  content?: string;
}

interface UnderlineAnnotation extends AnnotationBase {
  type: "underline";
  rects: Rect[];
  color?: string;
}

interface StrikethroughAnnotation extends AnnotationBase {
  type: "strikethrough";
  rects: Rect[];
  color?: string;
}

interface NoteAnnotation extends AnnotationBase {
  type: "note";
  x: number;
  y: number;
  content: string;
  color?: string;
}

interface RectangleAnnotation extends AnnotationBase {
  type: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  fillColor?: string;
}

interface FreetextAnnotation extends AnnotationBase {
  type: "freetext";
  x: number;
  y: number;
  content: string;
  fontSize?: number;
  color?: string;
}

interface StampAnnotation extends AnnotationBase {
  type: "stamp";
  x: number;
  y: number;
  label: StampLabel;
  color?: string;
  rotation?: number;
}

type PdfAnnotationDef =
  | HighlightAnnotation
  | UnderlineAnnotation
  | StrikethroughAnnotation
  | NoteAnnotation
  | RectangleAnnotation
  | FreetextAnnotation
  | StampAnnotation;

interface TrackedAnnotation {
  def: PdfAnnotationDef;
  elements: HTMLElement[];
}

// Annotation state
const annotationMap = new Map<string, TrackedAnnotation>();
const formFieldValues = new Map<string, string | boolean>();

// PDF.js form field name → annotation IDs mapping (for annotationStorage)
const fieldNameToIds = new Map<string, string[]>();
// PDF.js form field name → page number mapping (for strip counter)
const fieldNameToPage = new Map<string, number>();
// PDF.js form field name → human-readable label (from PDF TU / alternativeText)
const fieldNameToLabel = new Map<string, string>();

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
const downloadBtn = document.getElementById(
  "download-btn",
) as HTMLButtonElement;

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
const annotationsPanelClearAllBtn = document.getElementById(
  "annotation-panel-clear-all",
) as HTMLButtonElement;
const annotationsBtn = document.getElementById(
  "annotations-btn",
) as HTMLButtonElement;
const annotationsBadgeEl = document.getElementById(
  "annotations-badge",
) as HTMLElement;

// Annotation Strip DOM Elements (inline mode)
const stripEl = document.getElementById("annotation-strip")!;
const stripItemEl = document.getElementById("strip-item")!;
const stripCounterEl = document.getElementById("strip-counter")!;
const stripPrevBtn = document.getElementById("strip-prev") as HTMLButtonElement;
const stripNextBtn = document.getElementById("strip-next") as HTMLButtonElement;
const stripDeleteBtn = document.getElementById(
  "strip-delete",
) as HTMLButtonElement;
const stripClearAllBtn = document.getElementById(
  "strip-clear-all",
) as HTMLButtonElement;

// Annotation strip state
interface StripItem {
  kind: "annotation" | "formField";
  page: number;
  id: string; // annotation id or field name
  label: string; // type or field name
  preview: string; // content preview or value
  color: string; // swatch color
}
let stripIndex = 0;
let stripItems: StripItem[] = [];

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
  // toolbar + padding-top + page-wrapper height + padding-bottom + strip + buffer
  // Note: search bar is absolutely positioned over the document area, so excluded
  const toolbarHeight = toolbarEl.offsetHeight;
  const pageWrapperHeight = pageWrapperEl.offsetHeight;
  const stripHeight =
    stripEl.style.display !== "none" ? stripEl.offsetHeight : 0;
  const BUFFER = 10; // Buffer for sub-pixel rounding and browser quirks
  const totalHeight =
    toolbarHeight +
    paddingTop +
    pageWrapperHeight +
    paddingBottom +
    stripHeight +
    BUFFER;

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
  // Text extraction is handled by the background preloader
}

function closeSearch() {
  if (!searchOpen) return;
  searchOpen = false;
  searchBarEl.style.display = "none";
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

function updateControls() {
  // Show URL with CSS ellipsis, full URL as tooltip, clickable to open
  titleEl.textContent = pdfUrl;
  titleEl.title = pdfUrl;
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
      pdfTitle ? `"${pdfTitle}"` : pdfUrl,
      `Current Page: ${currentPage}/${totalPages}`,
      `Page size: ${pageWidthPt}×${pageHeightPt}pt (coordinates: origin at bottom-left, Y increases upward)`,
    ].join(" | ");

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
      // List annotations on current page with their coordinates
      if (onThisPage.length > 0) {
        annotationSection +=
          "\nAnnotations on this page (visible in screenshot):";
        for (const t of onThisPage) {
          const d = t.def;
          if ("rects" in d && d.rects.length > 0) {
            const r = d.rects[0];
            annotationSection += `\n  [${d.id}] ${d.type} at (${r.x},${r.y}) ${r.width}x${r.height}`;
          } else if ("x" in d && "y" in d) {
            annotationSection += `\n  [${d.id}] ${d.type} at (${d.x},${d.y})`;
          }
        }
      }
    }

    const contextText = `${header}${searchSection}${annotationSection}\n\nPage content:\n${content}`;

    // Build content array with text and optional screenshot
    const contentBlocks: ContentBlock[] = [{ type: "text", text: contextText }];

    // Add screenshot if host supports image content
    if (app.getHostCapabilities()?.updateModelContext?.image) {
      try {
        // Scale down to reduce token usage (tokens depend on dimensions)
        const sourceCanvas = canvasEl;
        const screenshotScale = Math.min(
          1,
          MAX_MODEL_CONTEXT_UPDATE_IMAGE_DIMENSION /
            Math.max(sourceCanvas.width, sourceCanvas.height),
        );
        const targetWidth = Math.round(sourceCanvas.width * screenshotScale);
        const targetHeight = Math.round(sourceCanvas.height * screenshotScale);

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = targetWidth;
        tempCanvas.height = targetHeight;
        const ctx = tempCanvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
          // Paint annotations on top so the model can see them
          const dpr = window.devicePixelRatio || 1;
          const screenshotVp = {
            width: targetWidth,
            height: targetHeight,
            scale: scale * screenshotScale * dpr,
          };
          paintAnnotationsOnCanvas(ctx, currentPage, screenshotVp);
          const dataUrl = tempCanvas.toDataURL("image/png");
          const base64Data = dataUrl.split(",")[1];
          if (base64Data) {
            contentBlocks.push({
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
      // Bidirectional link: clicking annotation on PDF highlights its card in the panel
      if (el.classList.contains("annotation-note")) {
        el.addEventListener("click", () => highlightAnnotationCard(def.id));
      }
      annotationLayerEl.appendChild(el);
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
    el.style.transform = `rotate(${-def.rotation}deg)`;
    el.style.transformOrigin = "left bottom";
  }
  el.textContent = def.label;
  return el;
}

// =============================================================================
// Annotation CRUD
// =============================================================================

function addAnnotation(def: PdfAnnotationDef): void {
  // Remove existing if same id
  removeAnnotation(def.id);
  annotationMap.set(def.id, { def, elements: [] });
  // Re-render if on current page
  if (def.page === currentPage) {
    renderAnnotationsForPage(currentPage);
  }
  autoShowAnnotationPanel();
  updateAnnotationsBadge();
  renderAnnotationPanel();
}

function updateAnnotation(
  update: Partial<PdfAnnotationDef> & { id: string; type: string },
): void {
  const tracked = annotationMap.get(update.id);
  if (!tracked) return;

  // Merge partial update into existing def
  const merged = { ...tracked.def, ...update } as PdfAnnotationDef;
  tracked.def = merged;

  // Re-render if on current page
  if (merged.page === currentPage) {
    renderAnnotationsForPage(currentPage);
  }
  renderAnnotationPanel();
}

function removeAnnotation(id: string): void {
  const tracked = annotationMap.get(id);
  if (!tracked) return;
  for (const el of tracked.elements) el.remove();
  annotationMap.delete(id);
  updateAnnotationsBadge();
  renderAnnotationPanel();
}

// =============================================================================
// Annotation Panel
// =============================================================================

function setAnnotationPanelOpen(open: boolean): void {
  annotationPanelOpen = open;
  annotationsBtn.classList.toggle("active", open);
  updateAnnotationsBadge();

  if (currentDisplayMode === "inline") {
    // Inline mode: use strip below toolbar, never show side panel
    annotationsPanelEl.style.display = "none";
    if (open) {
      renderStrip();
    } else {
      stripEl.style.display = "none";
      updateSearchBarOffset();
    }
  } else {
    // Fullscreen mode: use side panel, never show strip
    stripEl.style.display = "none";
    updateSearchBarOffset();
    annotationsPanelEl.style.display = open ? "" : "none";
    if (open) {
      renderAnnotationPanel();
    }
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

function autoShowAnnotationPanel(): void {
  // Only auto-show if user hasn't explicitly closed it
  if (annotationPanelUserPref === false) return;
  if (!annotationPanelOpen && sidebarItemCount() > 0) {
    setAnnotationPanelOpen(true);
  }
}

/** Total count of annotations + filled form fields for the sidebar badge. */
function sidebarItemCount(): number {
  return annotationMap.size + formFieldValues.size;
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
  // Auto-close panel/strip when all items are gone
  if (count === 0 && annotationPanelOpen) {
    setAnnotationPanelOpen(false);
  }
}

function getAnnotationPreview(def: PdfAnnotationDef): string {
  switch (def.type) {
    case "note":
    case "freetext":
      return def.content || "";
    case "highlight":
      return def.content || "Highlight";
    case "underline":
      return "Underline";
    case "strikethrough":
      return "Strikethrough";
    case "rectangle":
      return "Rectangle";
    case "stamp":
      return def.label;
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

// =============================================================================
// Annotation Strip (inline mode compact bottom bar)
// =============================================================================

function buildStripItems(): StripItem[] {
  const items: StripItem[] = [];

  // Annotations grouped by page
  const byPage = new Map<number, TrackedAnnotation[]>();
  for (const tracked of annotationMap.values()) {
    const page = tracked.def.page;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(tracked);
  }
  const sortedPages = [...byPage.keys()].sort((a, b) => a - b);
  for (const pageNum of sortedPages) {
    const annotations = byPage.get(pageNum)!;
    annotations.sort((a, b) => getAnnotationY(b.def) - getAnnotationY(a.def));
    for (const tracked of annotations) {
      items.push({
        kind: "annotation",
        page: pageNum,
        id: tracked.def.id,
        label: tracked.def.type,
        preview: getAnnotationPreview(tracked.def),
        color: getAnnotationColor(tracked.def),
      });
    }
  }

  // Form fields grouped by page
  const formByPage = new Map<number, Array<[string, string | boolean]>>();
  for (const [name, value] of formFieldValues) {
    const page = fieldNameToPage.get(name) ?? 1;
    if (!formByPage.has(page)) formByPage.set(page, []);
    formByPage.get(page)!.push([name, value]);
  }
  const formPages = [...formByPage.keys()].sort((a, b) => a - b);
  for (const pageNum of formPages) {
    for (const [name, value] of formByPage.get(pageNum)!) {
      items.push({
        kind: "formField",
        page: pageNum,
        id: name,
        label: getFormFieldLabel(name),
        preview:
          typeof value === "boolean"
            ? value
              ? "checked"
              : "unchecked"
            : value,
        color: "#4a90d9",
      });
    }
  }

  return items;
}

function updateSearchBarOffset(): void {
  // Search bar is absolutely positioned; adjust its top to account for strip
  const stripHeight =
    stripEl.style.display !== "none" ? stripEl.offsetHeight : 0;
  searchBarEl.style.top = `${47 + stripHeight}px`;
}

function renderStrip(): void {
  stripItems = buildStripItems();
  if (stripItems.length === 0) {
    stripEl.style.display = "none";
    updateSearchBarOffset();
    requestFitToContent();
    return;
  }

  stripEl.style.display = "";
  stripIndex = Math.min(stripIndex, stripItems.length - 1);
  if (stripIndex < 0) stripIndex = 0;
  const item = stripItems[stripIndex];

  // Render item content
  stripItemEl.innerHTML = "";
  const swatch = document.createElement("div");
  swatch.className = "annotation-card-swatch";
  swatch.style.background = item.color;
  stripItemEl.appendChild(swatch);

  const label = document.createElement("span");
  label.className = "annotation-card-type";
  label.textContent = item.label;
  stripItemEl.appendChild(label);

  if (item.preview) {
    const preview = document.createElement("span");
    preview.className = "annotation-card-preview";
    preview.textContent = item.preview;
    stripItemEl.appendChild(preview);
  }

  // Counter: "3 of 7 · Page 2"
  stripCounterEl.textContent = `${stripIndex + 1} of ${stripItems.length} · Page ${item.page}`;

  // Enable/disable arrows
  stripPrevBtn.disabled = stripIndex <= 0;
  stripNextBtn.disabled = stripIndex >= stripItems.length - 1;

  updateSearchBarOffset();
  requestFitToContent();
}

function renderAnnotationPanel(): void {
  if (!annotationPanelOpen) return;
  // In inline mode, delegate to the compact strip
  if (currentDisplayMode === "inline") {
    renderStrip();
    return;
  }

  annotationsPanelCountEl.textContent = String(sidebarItemCount());

  // Group annotations by page, sorted by Y position within each page
  const byPage = new Map<number, TrackedAnnotation[]>();
  for (const tracked of annotationMap.values()) {
    const page = tracked.def.page;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(tracked);
  }

  // Sort pages
  const sortedPages = [...byPage.keys()].sort((a, b) => a - b);

  // Sort annotations within each page by Y position (descending = top-first in PDF coords)
  for (const annotations of byPage.values()) {
    annotations.sort((a, b) => getAnnotationY(b.def) - getAnnotationY(a.def));
  }

  annotationsPanelListEl.innerHTML = "";

  for (const pageNum of sortedPages) {
    // Page group header
    const header = document.createElement("div");
    header.className =
      "annotation-page-group" +
      (pageNum === currentPage ? " current-page" : "");
    header.textContent = `Page ${pageNum}`;
    annotationsPanelListEl.appendChild(header);

    for (const tracked of byPage.get(pageNum)!) {
      const def = tracked.def;
      const card = document.createElement("div");
      card.className = "annotation-card";
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
      typeLabel.textContent = def.type;
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

      // Click handler: expand/collapse + navigate to page + pulse annotation
      card.addEventListener("click", () => {
        if (hasContent) {
          card.classList.toggle("expanded");
        }
        // Navigate to page if needed
        if (def.page !== currentPage) {
          goToPage(def.page);
          // Wait for render then pulse
          setTimeout(() => pulseAnnotation(def.id), 300);
        } else {
          pulseAnnotation(def.id);
        }
      });

      // Hover handler: pulse annotation on PDF
      card.addEventListener("mouseenter", () => {
        if (def.page === currentPage) {
          pulseAnnotation(def.id);
        }
      });

      annotationsPanelListEl.appendChild(card);
    }
  }

  // Form fields section
  if (formFieldValues.size > 0) {
    const header = document.createElement("div");
    header.className = "annotation-page-group";
    header.textContent = "Form Fields";
    annotationsPanelListEl.appendChild(header);

    for (const [name, value] of formFieldValues) {
      const card = document.createElement("div");
      card.className = "annotation-card";

      const row = document.createElement("div");
      row.className = "annotation-card-row";

      // Color swatch (blue for form fields)
      const swatch = document.createElement("div");
      swatch.className = "annotation-card-swatch";
      swatch.style.background = "#4a90d9";
      row.appendChild(swatch);

      // Field label
      const label = getFormFieldLabel(name);
      const nameEl = document.createElement("span");
      nameEl.className = "annotation-card-type";
      nameEl.textContent = label;
      row.appendChild(nameEl);

      // Field value preview
      const displayValue =
        typeof value === "boolean" ? (value ? "checked" : "unchecked") : value;
      if (displayValue) {
        const valueEl = document.createElement("span");
        valueEl.className = "annotation-card-preview";
        valueEl.textContent = displayValue;
        row.appendChild(valueEl);
      }

      // Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "annotation-card-delete";
      deleteBtn.title = "Clear field";
      deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 3h8M4.5 3V2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M5 5.5v3M7 5.5v3M3 3l.5 7a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L9 3"/></svg>`;
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        formFieldValues.delete(name);
        // Clear from annotation storage
        if (pdfDocument) {
          const ids = fieldNameToIds.get(name);
          if (ids) {
            for (const id of ids) {
              pdfDocument.annotationStorage.remove(id);
            }
          }
        }
        updateAnnotationsBadge();
        renderAnnotationPanel();
        renderPage();
        persistAnnotations();
      });
      row.appendChild(deleteBtn);

      card.appendChild(row);
      annotationsPanelListEl.appendChild(card);
    }
  }
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

function highlightAnnotationCard(id: string): void {
  // Open panel if closed
  if (!annotationPanelOpen) {
    // Only auto-open if user hasn't explicitly closed
    if (annotationPanelUserPref !== false) {
      setAnnotationPanelOpen(true);
    } else {
      return;
    }
  }

  // Clear existing highlights
  for (const card of annotationsPanelListEl.querySelectorAll(
    ".annotation-card.highlighted",
  )) {
    card.classList.remove("highlighted");
  }

  // Find and highlight the card
  const card = annotationsPanelListEl.querySelector(
    `[data-annotation-id="${id}"]`,
  ) as HTMLElement | null;
  if (card) {
    card.classList.add("highlighted");
    card.classList.add("expanded");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    // Remove highlight after a delay
    setTimeout(() => card.classList.remove("highlighted"), 2000);
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
      if (w >= 150) {
        annotationsPanelEl.style.width = `${w}px`;
      }
    }
  } catch {
    /* ignore */
  }

  // Resize handle
  const resizeHandle = document.getElementById("annotation-panel-resize")!;
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    resizeHandle.classList.add("dragging");
    const startX = e.clientX;
    const startWidth = annotationsPanelEl.offsetWidth;

    const onMouseMove = (ev: MouseEvent) => {
      // Panel is on the right, so dragging left increases width
      const newWidth = Math.max(150, startWidth + (startX - ev.clientX));
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

  // Toggle button
  annotationsBtn.addEventListener("click", toggleAnnotationPanel);
  annotationsPanelCloseBtn.addEventListener("click", toggleAnnotationPanel);
  annotationsPanelClearAllBtn.addEventListener("click", clearAllItems);

  // Strip navigation
  stripPrevBtn.addEventListener("click", () => {
    if (stripIndex > 0) {
      stripIndex--;
      renderStrip();
      navigateToStripItem(stripItems[stripIndex]);
    }
  });
  stripNextBtn.addEventListener("click", () => {
    if (stripIndex < stripItems.length - 1) {
      stripIndex++;
      renderStrip();
      navigateToStripItem(stripItems[stripIndex]);
    }
  });
  stripItemEl.addEventListener("click", () => {
    if (stripItems.length > 0) {
      navigateToStripItem(stripItems[stripIndex]);
    }
  });
  stripDeleteBtn.addEventListener("click", () => {
    if (stripItems.length === 0) return;
    const item = stripItems[stripIndex];
    deleteStripItem(item);
  });
  stripClearAllBtn.addEventListener("click", () => {
    clearAllItems();
  });

  updateAnnotationsBadge();
}

function navigateToStripItem(item: StripItem): void {
  if (item.page !== currentPage) {
    goToPage(item.page);
    if (item.kind === "annotation") {
      setTimeout(() => pulseAnnotation(item.id), 300);
    }
  } else if (item.kind === "annotation") {
    pulseAnnotation(item.id);
  }
}

function deleteStripItem(item: StripItem): void {
  if (item.kind === "annotation") {
    removeAnnotation(item.id);
  } else {
    formFieldValues.delete(item.id);
    if (pdfDocument) {
      const ids = fieldNameToIds.get(item.id);
      if (ids) {
        for (const id of ids) {
          pdfDocument.annotationStorage.remove(id);
        }
      }
    }
    updateAnnotationsBadge();
    renderPage();
  }
  persistAnnotations();
  if (annotationPanelOpen) {
    if (currentDisplayMode === "inline") {
      renderStrip();
    } else {
      renderAnnotationPanel();
    }
  }
}

function clearAllItems(): void {
  // Clear all annotations
  for (const [, tracked] of annotationMap) {
    for (const el of tracked.elements) el.remove();
  }
  annotationMap.clear();

  // Clear all form field values
  if (pdfDocument) {
    for (const [name] of formFieldValues) {
      const ids = fieldNameToIds.get(name);
      if (ids) {
        for (const id of ids) {
          pdfDocument.annotationStorage.remove(id);
        }
      }
    }
  }
  formFieldValues.clear();

  updateAnnotationsBadge();
  persistAnnotations();
  renderPage();
  if (currentDisplayMode === "inline") {
    renderStrip();
  } else {
    renderAnnotationPanel();
  }
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
 * Render a single page to an offscreen canvas and return base64 PNG.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (page.render as any)({ canvasContext: ctx, viewport }).promise;

  // Paint annotations on top so the model can see them
  paintAnnotationsOnCanvas(ctx, pageNum, {
    width: viewport.width,
    height: viewport.height,
    scale: renderScale,
  });

  // Extract base64 (strip data URL prefix)
  const dataUrl = canvas.toDataURL("image/png");
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

function persistAnnotations(): void {
  const key = annotationStorageKey();
  if (!key) return;
  try {
    const data: PdfAnnotationDef[] = [];
    for (const tracked of annotationMap.values()) {
      data.push(tracked.def);
    }
    const formData: Record<string, string | boolean> = {};
    for (const [k, v] of formFieldValues) {
      formData[k] = v;
    }
    localStorage.setItem(
      key,
      JSON.stringify({ annotations: data, formFields: formData }),
    );
  } catch {
    // localStorage may be full or unavailable
  }
}

function restoreAnnotations(): void {
  const key = annotationStorageKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      annotations?: PdfAnnotationDef[];
      formFields?: Record<string, string | boolean>;
    };
    if (parsed.annotations) {
      for (const def of parsed.annotations) {
        annotationMap.set(def.id, { def, elements: [] });
      }
    }
    if (parsed.formFields) {
      for (const [k, v] of Object.entries(parsed.formFields)) {
        formFieldValues.set(k, v);
      }
    }
    log.info(
      `Restored ${annotationMap.size} annotations, ${formFieldValues.size} form fields`,
    );
  } catch {
    // Parse error or unavailable
  }
}

// =============================================================================
// PDF.js Form Field Name → ID Mapping
// =============================================================================

/** Build mapping from field names (used by fill_form) to annotation IDs (used by annotationStorage). */
async function buildFieldNameMap(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<void> {
  fieldNameToIds.clear();
  fieldNameToPage.clear();
  fieldNameToLabel.clear();
  try {
    const fieldObjects = await doc.getFieldObjects();
    if (fieldObjects) {
      for (const [name, fields] of Object.entries(fieldObjects)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fieldArr = fields as any[];
        fieldNameToIds.set(
          name,
          fieldArr.map((f) => f.id),
        );
        const firstField = fieldArr[0];
        // Store page number (0-based in PDF.js field objects → 1-based for us)
        if (firstField && typeof firstField.page === "number") {
          fieldNameToPage.set(name, firstField.page + 1);
        }
      }
    }
  } catch {
    // getFieldObjects may fail on some PDFs — fall back to no mapping
  }

  // Collect human-readable labels (alternativeText / TU) from per-page annotations,
  // since getFieldObjects() doesn't include alternativeText.
  if (fieldNameToIds.size > 0) {
    const pagesToScan = new Set(fieldNameToPage.values());
    // If no pages known, scan all
    if (pagesToScan.size === 0) {
      for (let i = 1; i <= doc.numPages; i++) pagesToScan.add(i);
    }
    try {
      for (const pageNum of pagesToScan) {
        const page = await doc.getPage(pageNum);
        const annotations = await page.getAnnotations();
        for (const ann of annotations) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const a = ann as any;
          if (a.fieldName && a.alternativeText) {
            fieldNameToLabel.set(a.fieldName, a.alternativeText);
          }
        }
      }
    } catch {
      // Annotation iteration may fail on some PDFs
    }
  }
  log.info(`Built field name map: ${fieldNameToIds.size} fields`);
}

/** Sync formFieldValues into pdfDocument.annotationStorage so AnnotationLayer renders pre-filled values. */
function syncFormValuesToStorage(): void {
  if (!pdfDocument || fieldNameToIds.size === 0) return;
  const storage = pdfDocument.annotationStorage;
  for (const [name, value] of formFieldValues) {
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
// PDF Download with Annotations
// =============================================================================

function cssColorToRgb(
  color: string,
): { r: number; g: number; b: number } | null {
  // Parse hex colors
  const hex = color.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    };
  }
  // Parse rgb/rgba
  const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1]) / 255,
      g: parseInt(rgbMatch[2]) / 255,
      b: parseInt(rgbMatch[3]) / 255,
    };
  }
  return null;
}

async function downloadAnnotatedPdf(): Promise<void> {
  if (!pdfDocument) return;
  downloadBtn.disabled = true;
  downloadBtn.title = "Preparing download...";

  try {
    // Fetch full PDF bytes
    const totalBytes =
      parseInt(canvasEl.dataset.totalBytes || "0", 10) ||
      (await fetchRange(pdfUrl, 0, 1)).totalBytes;

    const { bytes: fullBytes } = await fetchRange(pdfUrl, 0, totalBytes);

    // Load with pdf-lib
    const pdfDoc = await PDFDocument.load(fullBytes, {
      ignoreEncryption: true,
    });
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pages = pdfDoc.getPages();

    // Embed annotations
    for (const tracked of annotationMap.values()) {
      const def = tracked.def;
      const pageIdx = def.page - 1;
      if (pageIdx < 0 || pageIdx >= pages.length) continue;
      const page = pages[pageIdx];

      switch (def.type) {
        case "highlight": {
          const c = cssColorToRgb(def.color || "#ffff00") || {
            r: 1,
            g: 1,
            b: 0,
          };
          for (const rect of def.rects) {
            page.drawRectangle({
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              color: rgb(c.r, c.g, c.b),
              opacity: 0.35,
            });
          }
          break;
        }
        case "underline": {
          const c = cssColorToRgb(def.color || "#ff0000") || {
            r: 1,
            g: 0,
            b: 0,
          };
          for (const rect of def.rects) {
            page.drawLine({
              start: { x: rect.x, y: rect.y },
              end: { x: rect.x + rect.width, y: rect.y },
              thickness: 1.5,
              color: rgb(c.r, c.g, c.b),
            });
          }
          break;
        }
        case "strikethrough": {
          const c = cssColorToRgb(def.color || "#ff0000") || {
            r: 1,
            g: 0,
            b: 0,
          };
          for (const rect of def.rects) {
            const midY = rect.y + rect.height / 2;
            page.drawLine({
              start: { x: rect.x, y: midY },
              end: { x: rect.x + rect.width, y: midY },
              thickness: 1.5,
              color: rgb(c.r, c.g, c.b),
            });
          }
          break;
        }
        case "note": {
          const c = cssColorToRgb(def.color || "#ff9900") || {
            r: 1,
            g: 0.6,
            b: 0,
          };
          // Draw a small note indicator and the content text
          page.drawSquare({
            x: def.x,
            y: def.y - 10,
            size: 10,
            color: rgb(c.r, c.g, c.b),
            opacity: 0.8,
          });
          if (def.content) {
            page.drawText(def.content, {
              x: def.x + 14,
              y: def.y - 10,
              size: 9,
              font,
              color: rgb(c.r, c.g, c.b),
            });
          }
          break;
        }
        case "rectangle": {
          const borderColor = cssColorToRgb(def.color || "#0066cc") || {
            r: 0,
            g: 0.4,
            b: 0.8,
          };
          page.drawRectangle({
            x: def.x,
            y: def.y,
            width: def.width,
            height: def.height,
            borderColor: rgb(borderColor.r, borderColor.g, borderColor.b),
            borderWidth: 2,
            color: def.fillColor
              ? (() => {
                  const fc = cssColorToRgb(def.fillColor);
                  return fc ? rgb(fc.r, fc.g, fc.b) : undefined;
                })()
              : undefined,
            opacity: def.fillColor ? 0.3 : undefined,
          });
          break;
        }
        case "freetext": {
          const c = cssColorToRgb(def.color || "#000000") || {
            r: 0,
            g: 0,
            b: 0,
          };
          page.drawText(def.content, {
            x: def.x,
            y: def.y,
            size: def.fontSize || 12,
            font,
            color: rgb(c.r, c.g, c.b),
          });
          break;
        }
        case "stamp": {
          const c = cssColorToRgb(def.color || "#cc0000") || {
            r: 0.8,
            g: 0,
            b: 0,
          };
          const stampColor = rgb(c.r, c.g, c.b);
          const fontSize = 24;
          const textWidth = boldFont.widthOfTextAtSize(def.label, fontSize);
          const padding = 8;
          const rectW = textWidth + padding * 2;
          const rectH = fontSize + padding * 2;
          const rotation = def.rotation ? degrees(def.rotation) : undefined;

          page.drawRectangle({
            x: def.x,
            y: def.y - rectH,
            width: rectW,
            height: rectH,
            borderColor: stampColor,
            borderWidth: 3,
            opacity: 0.6,
            rotate: rotation,
          });
          page.drawText(def.label, {
            x: def.x + padding,
            y: def.y - fontSize - padding + 4,
            size: fontSize,
            font: boldFont,
            color: stampColor,
            opacity: 0.6,
            rotate: rotation,
          });
          break;
        }
      }
    }

    // Apply form fills
    if (formFieldValues.size > 0) {
      try {
        const form = pdfDoc.getForm();
        for (const [name, value] of formFieldValues) {
          try {
            if (typeof value === "boolean") {
              const checkbox = form.getCheckBox(name);
              if (value) checkbox.check();
              else checkbox.uncheck();
            } else {
              const textField = form.getTextField(name);
              textField.setText(value);
            }
          } catch {
            // Field not found or wrong type — skip
          }
        }
      } catch {
        // Form not available — skip
      }
    }

    const pdfBytes = await pdfDoc.save();

    // Use app.downloadFile if host supports it, otherwise fall back to <a> tag
    const hasAnnotations = annotationMap.size > 0;
    const baseName = (pdfTitle || "document").replace(/\.pdf$/i, "");
    const fileName = hasAnnotations
      ? `${baseName}_annotated.pdf`
      : `${baseName}.pdf`;

    // Convert to base64
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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
        } as any);

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

function zoomIn() {
  scale = Math.min(scale + 0.25, 3.0);
  renderPage();
}

function zoomOut() {
  scale = Math.max(scale - 0.25, 0.5);
  renderPage();
}

function resetZoom() {
  scale = 1.0;
  renderPage();
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
  fullscreenBtn.textContent = currentDisplayMode === "fullscreen" ? "⛶" : "⛶";
  fullscreenBtn.title =
    currentDisplayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
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

// Sync user form input back to formFieldValues for persistence
formLayerEl.addEventListener("input", (e) => {
  const target = e.target as HTMLInputElement | HTMLSelectElement;
  const fieldName = target.name;
  if (!fieldName) return;
  const value =
    target instanceof HTMLInputElement && target.type === "checkbox"
      ? target.checked
      : target.value;
  formFieldValues.set(fieldName, value);
  updateAnnotationsBadge();
  if (currentDisplayMode === "inline" && annotationPanelOpen) {
    renderStrip();
  } else {
    renderAnnotationPanel();
  }
  persistAnnotations();
});

// Track form field focus to sync the strip
formLayerEl.addEventListener(
  "focusin",
  (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const fieldName = target.name;
    if (!fieldName || currentDisplayMode !== "inline" || !annotationPanelOpen)
      return;
    // Find the strip item index for this field
    const idx = stripItems.findIndex(
      (item) => item.kind === "formField" && item.id === fieldName,
    );
    if (idx >= 0 && idx !== stripIndex) {
      stripIndex = idx;
      renderStrip();
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

// Keyboard navigation
document.addEventListener("keydown", (e) => {
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
      if (searchOpen) {
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
 * Load PDF progressively using PDFDataRangeTransport.
 * PDF.js will request ranges as needed to render pages.
 */
async function loadPdfProgressively(
  urlToLoad: string,
  fileSizeBytes: number,
): Promise<{
  document: pdfjsLib.PDFDocumentProxy;
  totalBytes: number;
}> {
  const fileTotalBytes = fileSizeBytes;
  log.info(`PDF file size: ${(fileTotalBytes / 1024) | 0} KB`);

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

  // Create transport with total file size, no initial data — PDF.js will request what it needs
  const transport = new AppRangeTransport(fileTotalBytes, null);

  const loadingTask = pdfjsLib.getDocument({ range: transport });

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
  log.info("Starting background preload of", totalPages, "pages");
  for (let i = 1; i <= totalPages; i++) {
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

  // Restore saved page or use initial page
  const savedPage = loadSavedPage();
  currentPage =
    savedPage && savedPage <= parsed.pageCount ? savedPage : parsed.initialPage;

  log.info("URL:", pdfUrl, "Starting at page:", currentPage);

  showLoading("Loading PDF...");

  try {
    // Use progressive loading - document available as soon as initial data arrives
    const { document, totalBytes } = await loadPdfProgressively(
      pdfUrl,
      parsed.totalBytes,
    );
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
    // downloadBtn.style.display = app.getHostCapabilities()?.downloadFile ? "" : "none";
    downloadBtn.style.display = "";
    // Restore any persisted annotations
    restoreAnnotations();

    // Build field name → annotation ID mapping for form filling
    await buildFieldNameMap(document);
    // Pre-populate annotationStorage from restored formFieldValues
    syncFormValuesToStorage();

    autoShowAnnotationPanel();
    updateAnnotationsBadge();
    renderPage();
    // Start background preloading of all pages for text extraction
    startPreloading();

    // Start polling for commands now that we have viewUUID
    if (viewUUID) {
      startPolling();
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
    };

/**
 * Process a batch of commands from the server queue
 */
function processCommands(commands: PdfCommand[]): void {
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
          addAnnotation(def);
        }
        break;
      case "update_annotations":
        for (const update of cmd.annotations) {
          updateAnnotation(update);
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
        break;
      case "get_pages":
        // Handle async — don't block other commands
        handleGetPages(cmd);
        break;
    }
  }

  // Persist after processing batch
  persistAnnotations();
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
      const commands =
        (result.structuredContent as { commands?: PdfCommand[] })?.commands ||
        [];
      if (commands.length > 0) {
        log.info(`Received ${commands.length} command(s)`);
        processCommands(commands);
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

  // Apply safe area insets
  if (ctx.safeAreaInsets) {
    mainEl.style.paddingTop = `${ctx.safeAreaInsets.top}px`;
    mainEl.style.paddingRight = `${ctx.safeAreaInsets.right}px`;
    mainEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    mainEl.style.paddingLeft = `${ctx.safeAreaInsets.left}px`;
  }

  // Log containerDimensions for debugging
  if (ctx.containerDimensions) {
    log.info("Container dimensions:", ctx.containerDimensions);
  }

  // Handle display mode changes
  if (ctx.displayMode) {
    const wasFullscreen = currentDisplayMode === "fullscreen";
    currentDisplayMode = ctx.displayMode as "inline" | "fullscreen";
    const isFullscreen = currentDisplayMode === "fullscreen";
    mainEl.classList.toggle("fullscreen", isFullscreen);
    log.info(isFullscreen ? "Fullscreen mode enabled" : "Inline mode");
    // Switch between strip (inline) and side panel (fullscreen)
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
  autoShowAnnotationPanel();
  updateAnnotationsBadge();
});
