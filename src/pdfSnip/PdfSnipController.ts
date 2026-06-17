import { logError } from "@/logger";
import { App, Notice, View, WorkspaceLeaf } from "obsidian";

/** Obsidian's built-in PDF view registers under this view type. */
const PDF_VIEW_TYPE = "pdf";

/** Minimum drag size (in CSS px) below which a snip is treated as a cancel. */
const MIN_SNIP_SIZE = 5;

/** A rectangle in viewport (client) coordinates. */
interface SnipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Build a normalized client-coordinate rectangle from two drag points.
 */
function rectFromPoints(x1: number, y1: number, x2: number, y2: number): SnipRect {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Adds a "Snip region to Copilot" action to Obsidian PDF views. When invoked,
 * the user drags a rectangle over the rendered page(s); the selected region is
 * cropped from the underlying pdf.js canvas into a PNG and handed to a callback
 * (which delivers it to the chat as image context). Works on scanned PDFs since
 * it captures pixels, not text.
 */
export class PdfSnipController {
  private decorated = new WeakSet<View>();
  private addedActions: HTMLElement[] = [];
  private activeCleanup: (() => void) | null = null;

  /**
   * @param app Obsidian app handle (workspace access).
   * @param onImageReady Called with the cropped PNG when a snip completes.
   */
  constructor(
    private readonly app: App,
    private readonly onImageReady: (file: File) => void | Promise<void>
  ) {}

  /**
   * Decorate every currently-open PDF view with the snip action. Idempotent —
   * a view is only decorated once (tracked via WeakSet). Safe to call on every
   * active-leaf-change / layout-change.
   */
  decoratePdfViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE)) {
      this.decorateLeaf(leaf);
    }
  }

  /**
   * Add the snip action to a single leaf's view if not already decorated.
   */
  private decorateLeaf(leaf: WorkspaceLeaf): void {
    const view = leaf.view;
    if (!view || this.decorated.has(view)) return;

    // addAction lives on ItemView; the PDF view extends it but leaf.view is
    // typed as the View base class, so reach for it defensively.
    const decorable = view as unknown as {
      addAction?: (icon: string, title: string, cb: () => void) => HTMLElement;
    };
    if (typeof decorable.addAction !== "function") return;

    const actionEl = decorable.addAction("scissors", "Snip region to Copilot", () => {
      this.startSnip(view);
    });
    if (actionEl) this.addedActions.push(actionEl);
    this.decorated.add(view);
  }

  /**
   * Begin an interactive region-select over the given PDF view. Overlays a
   * crosshair layer; the drag rectangle is cropped on pointerup. Escape cancels.
   */
  private startSnip(view: View): void {
    const containerEl = view.containerEl;
    if (!containerEl) return;

    // The scrollable page area; fall back to the whole view if the class moves
    // between Obsidian versions.
    const viewerEl = containerEl.querySelector<HTMLElement>(".pdf-viewer-container") ?? containerEl;
    const doc = containerEl.doc;
    const win = containerEl.win;

    // Tear down any in-flight snip before starting a new one.
    this.activeCleanup?.();

    const vRect = viewerEl.getBoundingClientRect();

    const overlay = doc.createElement("div");
    overlay.className = "copilot-pdf-snip-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      left: `${vRect.left}px`,
      top: `${vRect.top}px`,
      width: `${vRect.width}px`,
      height: `${vRect.height}px`,
      zIndex: "var(--layer-modal, 9999)",
      cursor: "crosshair",
      background: "rgba(0, 0, 0, 0.04)",
    });

    const selBox = doc.createElement("div");
    Object.assign(selBox.style, {
      position: "absolute",
      border: "2px solid var(--interactive-accent)",
      background: "rgba(255, 255, 255, 0.12)",
      display: "none",
      pointerEvents: "none",
    });
    overlay.appendChild(selBox);
    doc.body.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    const cleanup = () => {
      overlay.remove();
      doc.removeEventListener("keydown", onKey, true);
      this.activeCleanup = null;
    };
    this.activeCleanup = cleanup;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
      }
    };
    doc.addEventListener("keydown", onKey, true);

    const updateSelBox = (cx: number, cy: number) => {
      selBox.style.left = `${Math.min(startX, cx) - vRect.left}px`;
      selBox.style.top = `${Math.min(startY, cy) - vRect.top}px`;
      selBox.style.width = `${Math.abs(cx - startX)}px`;
      selBox.style.height = `${Math.abs(cy - startY)}px`;
    };

    overlay.addEventListener("pointerdown", (e: PointerEvent) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      overlay.setPointerCapture(e.pointerId);
      selBox.show();
      updateSelBox(e.clientX, e.clientY);
    });

    overlay.addEventListener("pointermove", (e: PointerEvent) => {
      if (dragging) updateSelBox(e.clientX, e.clientY);
    });

    overlay.addEventListener("pointerup", (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      const rect = rectFromPoints(startX, startY, e.clientX, e.clientY);
      cleanup();

      // Tiny drags are treated as a click / cancel.
      if (rect.width < MIN_SNIP_SIZE || rect.height < MIN_SNIP_SIZE) return;

      void this.finishSnip(viewerEl, rect, win);
    });
  }

  /**
   * Crop the finalized selection and hand the resulting PNG to the consumer.
   */
  private async finishSnip(viewerEl: HTMLElement, rect: SnipRect, win: Window): Promise<void> {
    try {
      const blob = await this.cropSelection(viewerEl, rect, win);
      if (!blob) {
        new Notice("Nothing to snip in that region.");
        return;
      }
      const file = new File([blob], `pdf-snip-${Date.now()}.png`, { type: "image/png" });
      await this.onImageReady(file);
    } catch (err) {
      logError("[PdfSnip] Failed to crop PDF region", err);
      new Notice("Failed to snip PDF region.");
    }
  }

  /**
   * Collect the rendered page canvases inside the viewer, preferring the
   * page-level canvases (excludes the toolbar/thumbnail sidebar).
   */
  private collectPageCanvases(viewerEl: HTMLElement): HTMLCanvasElement[] {
    let nodes = viewerEl.querySelectorAll<HTMLCanvasElement>(".page canvas");
    if (nodes.length === 0)
      nodes = viewerEl.querySelectorAll<HTMLCanvasElement>(".canvasWrapper canvas");
    if (nodes.length === 0) nodes = viewerEl.querySelectorAll<HTMLCanvasElement>("canvas");
    return Array.from(nodes);
  }

  /**
   * Crop the client-coordinate selection rectangle out of whichever rendered
   * page canvases it overlaps, compositing into a single PNG at device-pixel
   * resolution. Returns null if the selection covers no rendered canvas.
   */
  private async cropSelection(
    viewerEl: HTMLElement,
    rect: SnipRect,
    win: Window
  ): Promise<Blob | null> {
    const dpr = win.devicePixelRatio || 1;
    const outW = Math.max(1, Math.round(rect.width * dpr));
    const outH = Math.max(1, Math.round(rect.height * dpr));

    const out = viewerEl.doc.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    if (!ctx) return null;

    // White matte so transparent PDF regions don't render black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);

    let drewAny = false;
    for (const canvas of this.collectPageCanvases(viewerEl)) {
      const cRect = canvas.getBoundingClientRect();
      if (cRect.width === 0 || cRect.height === 0) continue;

      // Intersection of the selection and this canvas, in client coords.
      const ix = Math.max(rect.left, cRect.left);
      const iy = Math.max(rect.top, cRect.top);
      const ax = Math.min(rect.right, cRect.right);
      const ay = Math.min(rect.bottom, cRect.bottom);
      const iw = ax - ix;
      const ih = ay - iy;
      if (iw <= 0 || ih <= 0) continue;

      // Map the intersection from on-screen CSS px to the canvas's intrinsic
      // pixel resolution (pdf.js renders at higher-than-CSS resolution).
      const scaleX = canvas.width / cRect.width;
      const scaleY = canvas.height / cRect.height;
      const sx = (ix - cRect.left) * scaleX;
      const sy = (iy - cRect.top) * scaleY;
      const sw = iw * scaleX;
      const sh = ih * scaleY;

      // Destination position within the output, relative to the selection.
      const dx = (ix - rect.left) * dpr;
      const dy = (iy - rect.top) * dpr;
      const dw = iw * dpr;
      const dh = ih * dpr;

      try {
        ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
        drewAny = true;
      } catch (err) {
        logError("[PdfSnip] drawImage failed for a page canvas", err);
      }
    }

    if (!drewAny) return null;
    return await new Promise<Blob | null>((resolve) => out.toBlob((b) => resolve(b), "image/png"));
  }

  /**
   * Remove any active overlay and the action buttons added to PDF views.
   * Called on plugin unload.
   */
  dispose(): void {
    this.activeCleanup?.();
    for (const el of this.addedActions) el.remove();
    this.addedActions = [];
  }
}
