import { logError } from "@/logger";
import { TFile } from "obsidian";
import { createLangChainTool } from "../createLangChainTool";
import { FORK_AUTO_PDF_CURRENT_PAGE } from "../forkConfig";
import { getOutline, getPageText, looksScanned, openPdf, PdfDocHandle } from "./pdfDocument";
import { z } from "zod";

/** Cap how many pages a single read returns, to keep context bounded. */
const MAX_PAGES_PER_READ = 25;
/** Cap total characters returned by a single read. */
const MAX_CHARS_PER_READ = 40000;
/** Default number of search hits to return. */
const DEFAULT_SEARCH_RESULTS = 10;
/** Characters of context around a search match. */
const SNIPPET_RADIUS = 160;

/** Opened-document cache keyed by path + mtime + size (invalidated on edit). */
const docCache = new Map<string, PdfDocHandle>();
/** Per-page extracted-text cache keyed by docKey:pageNumber. */
const pageTextCache = new Map<string, string>();

/**
 * Resolve a PDF reference to a TFile. Accepts a vault-relative path, a bare
 * name, or a wikilink; falls back to the active PDF when no path is given.
 */
function resolvePdfFile(path?: string): TFile {
  if (path && path.trim()) {
    const cleaned = path.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
    const direct = app.vault.getAbstractFileByPath(cleaned);
    if (direct instanceof TFile) return direct;
    if (!cleaned.toLowerCase().endsWith(".pdf")) {
      const withExt = app.vault.getAbstractFileByPath(`${cleaned}.pdf`);
      if (withExt instanceof TFile) return withExt;
    }
    const linked = app.metadataCache.getFirstLinkpathDest(cleaned, "");
    if (linked instanceof TFile) return linked;
    throw new Error(`PDF not found: ${path}`);
  }
  const active = app.workspace.getActiveFile();
  if (active && active.extension === "pdf") return active;
  throw new Error("No PDF specified and no PDF is currently open. Provide a 'path'.");
}

/** Build the cache key for a file's current revision. */
function docKey(file: TFile): string {
  return `${file.path}#${file.stat.mtime}#${file.stat.size}`;
}

/** Open (or reuse a cached) pdf.js document for the given file. */
async function getDoc(file: TFile): Promise<{ handle: PdfDocHandle; key: string }> {
  const key = docKey(file);
  const cached = docCache.get(key);
  if (cached) return { handle: cached, key };
  const bytes = await app.vault.readBinary(file);
  const handle = await openPdf(bytes);
  docCache.set(key, handle);
  return { handle, key };
}

/** Get a page's text, using the per-page cache. */
async function cachedPageText(
  handle: PdfDocHandle,
  key: string,
  pageNumber: number
): Promise<string> {
  const ck = `${key}:${pageNumber}`;
  const hit = pageTextCache.get(ck);
  if (hit !== undefined) return hit;
  const text = await getPageText(handle, pageNumber);
  pageTextCache.set(ck, text);
  return text;
}

/** Parse a pages spec like "12-15", "3,7,9", "5", or "all" into page numbers. */
function parsePagesSpec(spec: string, numPages: number): number[] {
  const s = spec.trim().toLowerCase();
  if (s === "all") return Array.from({ length: numPages }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of s.split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = parseInt(range[1], 10);
      let b = parseInt(range[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) pages.add(i);
    } else if (/^\d+$/.test(t)) {
      pages.add(parseInt(t, 10));
    }
  }
  return [...pages].filter((p) => p >= 1 && p <= numPages).sort((a, b) => a - b);
}

/**
 * pdf_info — page count, whether the PDF has an embedded table of contents, and a
 * sampled scanned-vs-text assessment. The model should call this first to orient.
 */
export const pdfInfoTool = createLangChainTool({
  name: "pdf_info",
  description:
    "Get a PDF's page count, table-of-contents availability, and whether it looks scanned. " +
    "Call this first when working with a PDF, before reading or searching it.",
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe("Vault path/name of the PDF. Omit to use the currently open PDF."),
  }),
  func: async ({ path }) => {
    const file = resolvePdfFile(path);
    const { handle, key } = await getDoc(file);
    const outline = await getOutline(handle);

    // Sample a few pages rather than scanning all (cheap for huge PDFs).
    const samples = [...new Set([1, Math.ceil(handle.numPages / 2), handle.numPages])].filter(
      (p) => p >= 1 && p <= handle.numPages
    );
    let scannedSamples = 0;
    for (const p of samples) {
      if (looksScanned(await cachedPageText(handle, key, p))) scannedSamples++;
    }
    const appearsScanned = scannedSamples === samples.length;

    return {
      path: file.path,
      pageCount: handle.numPages,
      hasTableOfContents: outline.length > 0,
      tocEntryCount: outline.length,
      appearsScanned,
      guidance: appearsScanned
        ? "Sampled pages have little extractable text — this PDF is likely scanned. Text tools will be poor; use the page image (render/snip) with a vision model instead."
        : "Use pdf_toc to see structure, pdf_search to locate content, and pdf_read_pages to read specific pages.",
    };
  },
});

/**
 * pdf_toc — the PDF's embedded outline (bookmarks) with resolved page numbers, so
 * the model can navigate to the right section without reading everything.
 */
export const pdfTocTool = createLangChainTool({
  name: "pdf_toc",
  description:
    "Get a PDF's table of contents (outline/bookmarks) with page numbers. " +
    "Use it to find which pages to read for a topic.",
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe("Vault path/name of the PDF. Omit to use the currently open PDF."),
  }),
  func: async ({ path }) => {
    const file = resolvePdfFile(path);
    const { handle } = await getDoc(file);
    const outline = await getOutline(handle);
    if (outline.length === 0) {
      return {
        path: file.path,
        entries: [],
        note: "This PDF has no embedded table of contents. Use pdf_search to locate content.",
      };
    }
    return {
      path: file.path,
      entries: outline.map((e) => ({ title: e.title, page: e.page, level: e.level })),
    };
  },
});

/**
 * pdf_search — locate query terms across the PDF, returning matching page numbers
 * with snippets so the model can then read only the relevant pages.
 */
export const pdfSearchTool = createLangChainTool({
  name: "pdf_search",
  description:
    "Search a PDF's text for a query and return matching page numbers with snippets. " +
    "Use it to find where a topic is discussed, then read those pages with pdf_read_pages.",
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe("Vault path/name of the PDF. Omit to use the currently open PDF."),
    query: z.string().min(1).describe("Words or phrase to find in the PDF."),
    maxResults: z
      .number()
      .optional()
      .describe(`Max matching pages to return (default ${DEFAULT_SEARCH_RESULTS}).`),
  }),
  func: async ({ path, query, maxResults }) => {
    const file = resolvePdfFile(path);
    const { handle, key } = await getDoc(file);
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    const hits: { page: number; score: number; snippet: string }[] = [];
    for (let p = 1; p <= handle.numPages; p++) {
      const text = await cachedPageText(handle, key, p);
      const lower = text.toLowerCase();
      let score = 0;
      let firstIdx = -1;
      for (const term of terms) {
        let idx = lower.indexOf(term);
        if (idx === -1) continue;
        if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
        while (idx !== -1) {
          score++;
          idx = lower.indexOf(term, idx + term.length);
        }
      }
      if (score > 0 && firstIdx !== -1) {
        const start = Math.max(0, firstIdx - SNIPPET_RADIUS);
        const end = Math.min(text.length, firstIdx + SNIPPET_RADIUS);
        const snippet =
          (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
        hits.push({ page: p, score, snippet });
      }
    }

    hits.sort((a, b) => b.score - a.score || a.page - b.page);
    const limit = maxResults && maxResults > 0 ? maxResults : DEFAULT_SEARCH_RESULTS;
    const top = hits.slice(0, limit);

    return {
      path: file.path,
      query,
      totalMatchingPages: hits.length,
      results: top,
      note:
        hits.length === 0
          ? "No matches. The PDF may be scanned (no text layer) — try reading/rendering pages as images."
          : hits.length > top.length
            ? `Showing top ${top.length} of ${hits.length} matching pages.`
            : undefined,
    };
  },
});

/**
 * pdf_read_pages — extract the text of specific pages. Bounded by page and
 * character caps so reading from a large PDF never floods the context.
 */
export const pdfReadPagesTool = createLangChainTool({
  name: "pdf_read_pages",
  description:
    "Read the text of specific PDF pages. Specify pages as a range ('12-15'), list ('3,7,9'), " +
    "single page ('5'), or 'all'. Reads are capped; request only the pages you need.",
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe("Vault path/name of the PDF. Omit to use the currently open PDF."),
    pages: z.string().min(1).describe("Pages to read: '12-15', '3,7,9', '5', or 'all'."),
  }),
  func: async ({ path, pages }) => {
    const file = resolvePdfFile(path);
    const { handle, key } = await getDoc(file);

    const requested = parsePagesSpec(pages, handle.numPages);
    if (requested.length === 0) {
      return {
        path: file.path,
        error: `No valid pages in "${pages}" (PDF has ${handle.numPages} pages).`,
      };
    }

    const capped = requested.slice(0, MAX_PAGES_PER_READ);
    const out: { page: number; text: string; scanned?: boolean }[] = [];
    let totalChars = 0;
    let charCapped = false;
    for (const p of capped) {
      let text = await cachedPageText(handle, key, p);
      if (totalChars + text.length > MAX_CHARS_PER_READ) {
        text = text.slice(0, Math.max(0, MAX_CHARS_PER_READ - totalChars));
        charCapped = true;
      }
      totalChars += text.length;
      out.push({ page: p, text, scanned: looksScanned(text) || undefined });
      if (charCapped) break;
    }

    const notes: string[] = [];
    if (requested.length > capped.length)
      notes.push(`Requested ${requested.length} pages; capped to ${MAX_PAGES_PER_READ}.`);
    if (charCapped) notes.push(`Output truncated at ${MAX_CHARS_PER_READ} characters.`);
    if (out.some((o) => o.scanned))
      notes.push("Some pages have little/no text (likely scanned) — read them as images instead.");

    return {
      path: file.path,
      pageCount: handle.numPages,
      pages: out,
      note: notes.length > 0 ? notes.join(" ") : undefined,
    };
  },
});

/**
 * Clear cached PDF documents and page text. Call when freeing memory; caches also
 * self-invalidate when a file's mtime/size changes.
 */
export function clearPdfToolCaches(): void {
  docCache.clear();
  pageTextCache.clear();
}

/** Max characters of the current PDF page to inline into auto-context. */
const ACTIVE_PDF_PAGE_MAX_CHARS = 8000;

/** Minimal XML escaping for inlined page text. */
function escapeXmlMinimal(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Read the current (visible) page number of the open PDF view showing `file`.
 * Uses Obsidian's internal PDF viewer state, so it's defensive about shape.
 */
function getActivePdfCurrentPage(file: TFile): number | null {
  for (const leaf of app.workspace.getLeavesOfType("pdf")) {
    const view = leaf.view as unknown as {
      file?: { path?: string };
      viewer?: { child?: { pdfViewer?: { currentPageNumber?: number } } };
    };
    if (view?.file?.path === file.path) {
      const n = view?.viewer?.child?.pdfViewer?.currentPageNumber;
      if (typeof n === "number" && n >= 1) return n;
    }
  }
  return null;
}

/**
 * Build an auto-context block for the current page of the active PDF, extracted
 * locally (no pdf4llm). Returns "" when disabled, not a PDF, the page is unknown,
 * or the page has no extractable text (e.g. scanned — read it as an image instead).
 */
export async function buildActivePdfPageContextBlock(
  includeActiveNote: boolean,
  activeFile: TFile | null
): Promise<string> {
  if (!FORK_AUTO_PDF_CURRENT_PAGE || !includeActiveNote) return "";
  if (!activeFile || activeFile.extension !== "pdf") return "";
  const page = getActivePdfCurrentPage(activeFile);
  if (!page) return "";
  try {
    const { handle, key } = await getDoc(activeFile);
    if (page > handle.numPages) return "";
    const text = (await cachedPageText(handle, key, page)).trim();
    if (text.length === 0) return ""; // scanned / no text layer
    const capped =
      text.length > ACTIVE_PDF_PAGE_MAX_CHARS
        ? text.slice(0, ACTIVE_PDF_PAGE_MAX_CHARS) + "\n…[truncated]"
        : text;
    return (
      `\n\n<active_pdf_page>\n<path>${activeFile.path}</path>\n<page>${page}</page>\n` +
      `<total_pages>${handle.numPages}</total_pages>\n<content>\n${escapeXmlMinimal(capped)}\n</content>\n</active_pdf_page>`
    );
  } catch (err) {
    logError("[pdfTools] Failed to build active PDF page context", err);
    return "";
  }
}
