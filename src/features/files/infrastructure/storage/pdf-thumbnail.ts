import { createCanvas } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_RENDER_EDGE = 1200;
const MAX_EMBEDDED_IMAGE_PIXELS = 16_000_000;
const nodeRequire = createRequire(import.meta.url);
const pdfPackageRoot = path.dirname(nodeRequire.resolve("pdfjs-dist/package.json"));
const standardFontDataUrl = pathToFileURL(
  path.join(pdfPackageRoot, "standard_fonts") + path.sep
).href;

/** Render a PDF's first page into a bounded PNG buffer for thumbnailing. */
export async function renderPdfFirstPage(source: Uint8Array): Promise<Buffer> {
  const { getDocument, VerbosityLevel } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(source),
    stopAtErrors: true,
    maxImageSize: MAX_EMBEDDED_IMAGE_PIXELS,
    canvasMaxAreaInBytes: MAX_RENDER_EDGE * MAX_RENDER_EDGE * 4,
    standardFontDataUrl,
    useWasm: false,
    verbosity: VerbosityLevel.ERRORS,
  });

  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) throw new Error("PDF has no pages");

    const page = await document.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const longestEdge = Math.max(natural.width, natural.height);
    const scale = Math.min(2, MAX_RENDER_EDGE / Math.max(1, longestEdge));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      background: "#ffffff",
    }).promise;
    page.cleanup();

    return canvas.toBuffer("image/png");
  } finally {
    await loadingTask.destroy();
  }
}
