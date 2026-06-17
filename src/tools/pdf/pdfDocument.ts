import { logError } from "@/logger";

/**
 * Minimal structural types for the slice of pdf.js we use. We rely on
 * Obsidian's already-bundled pdf.js (exposed as a global) rather than bundling a
 * second copy — that avoids the pdf.js web-worker setup a standalone build needs.
 */
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfTextContent {
  items: PdfTextItem[];
}
interface PdfPageProxy {
  getTextContent(): Promise<PdfTextContent>;
}
interface PdfOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: PdfOutlineItem[];
}
interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  getOutline(): Promise<PdfOutlineItem[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}
interface PdfjsLib {
  getDocument(src: { data: ArrayBuffer }): { promise: Promise<PdfDocumentProxy> };
}

/** A single entry in a PDF's table of contents, resolved to a page number. */
export interface PdfOutlineEntry {
  title: string;
  page: number | null;
  level: number;
}

/** A lightweight handle around an opened pdf.js document. */
export interface PdfDocHandle {
  numPages: number;
  doc: PdfDocumentProxy;
}

/**
 * Get Obsidian's bundled pdf.js library from the renderer global. Obsidian loads
 * it for its built-in PDF viewer; reusing it keeps the plugin small and sidesteps
 * worker configuration. Throws a user-actionable error if it isn't loaded yet.
 */
function getPdfjs(): PdfjsLib {
  const w = activeWindow as unknown as { pdfjsLib?: PdfjsLib };
  const main = window as unknown as { pdfjsLib?: PdfjsLib };
  const lib = w?.pdfjsLib ?? main?.pdfjsLib;
  if (!lib || typeof lib.getDocument !== "function") {
    throw new Error(
      "Obsidian's PDF engine isn't available yet. Open any PDF in Obsidian once, then retry."
    );
  }
  return lib;
}

/**
 * Open a PDF from its raw bytes. The returned handle exposes page count and the
 * underlying pdf.js document for text extraction.
 */
export async function openPdf(bytes: ArrayBuffer): Promise<PdfDocHandle> {
  const pdfjs = getPdfjs();
  // pdf.js transfers/detaches the buffer; pass a copy so the caller's bytes survive.
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  return { numPages: doc.numPages, doc };
}

/**
 * Extract the text of a single page (1-indexed). Inserts newlines at pdf.js
 * end-of-line markers so the text keeps a rough line structure.
 */
export async function getPageText(handle: PdfDocHandle, pageNumber: number): Promise<string> {
  const page = await handle.doc.getPage(pageNumber);
  const content = await page.getTextContent();
  let out = "";
  for (const item of content.items) {
    out += item.str ?? "";
    out += item.hasEOL ? "\n" : " ";
  }
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Heuristic: a page with almost no extractable text is likely scanned (image-only)
 * and should be read via vision (render to image) rather than text extraction.
 */
export function looksScanned(pageText: string): boolean {
  return pageText.replace(/\s/g, "").length < 10;
}

/**
 * Resolve a pdf.js outline destination to a 1-indexed page number, or null if it
 * cannot be resolved.
 */
async function resolveDestPage(
  handle: PdfDocHandle,
  dest: string | unknown[] | null
): Promise<number | null> {
  try {
    let resolved: unknown[] | null = null;
    if (typeof dest === "string") {
      resolved = await handle.doc.getDestination(dest);
    } else if (Array.isArray(dest)) {
      resolved = dest;
    }
    if (!resolved || resolved.length === 0) return null;
    const pageIndex = await handle.doc.getPageIndex(resolved[0]);
    return pageIndex + 1;
  } catch (err) {
    logError("[pdfDocument] Failed to resolve outline destination", err);
    return null;
  }
}

/**
 * Read the PDF's table of contents (outline / bookmarks) as a flat list with
 * resolved page numbers and nesting levels. Returns an empty array if the PDF has
 * no embedded outline.
 */
export async function getOutline(handle: PdfDocHandle): Promise<PdfOutlineEntry[]> {
  const raw = await handle.doc.getOutline();
  if (!raw || raw.length === 0) return [];

  const flat: PdfOutlineEntry[] = [];
  const walk = async (items: PdfOutlineItem[], level: number): Promise<void> => {
    for (const item of items) {
      flat.push({
        title: item.title,
        page: await resolveDestPage(handle, item.dest),
        level,
      });
      if (item.items && item.items.length > 0) {
        await walk(item.items, level + 1);
      }
    }
  };
  await walk(raw, 0);
  return flat;
}
