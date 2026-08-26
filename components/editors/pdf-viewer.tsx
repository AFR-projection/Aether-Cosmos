"use client";

import { Document, Page, pdfjs } from "react-pdf";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

/* NOTE: nothing imports this component — the PDF surface the app actually shows is
   components/media-viewers/pdf-viewer.tsx, which embeds the browser's own viewer in an
   iframe and needs no worker. This paged renderer is kept as the canvas-based
   alternative; `react-pdf` is in package.json only for it. */

/* Explicit https rather than the protocol-relative "//unpkg.com" this used to use: the
   scheme is not something a viewer should inherit from the page. The worker still comes
   from a third-party CDN, so it will not load offline and pins this app to whatever
   unpkg serves for the version — bundling `pdfjs-dist/build/pdf.worker.min.mjs` locally
   is the fix if this component is ever wired up. */
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PdfViewerProps {
  fileId: string;
  previewUrl?: string;
}

export function PdfViewer({ fileId, previewUrl }: PdfViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fileSource = previewUrl ?? `/api/download/${fileId}`;

  /* The page used to render at a hardcoded 500px, which overflowed every phone
     sideways. It now follows the stage, minus the border and a little breathing room. */
  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setWidth(Math.max(240, Math.floor(box.width) - 16));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </Button>
        {/* Announced, not just drawn: the page number is the only feedback the arrows give. */}
        <span
          role="status"
          aria-live="polite"
          className="text-sm tabular-nums text-muted-foreground"
        >
          Page {page} of {numPages || "?"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next page"
          disabled={page >= numPages}
          onClick={() => setPage((p) => (numPages ? Math.min(numPages, p + 1) : p))}
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </Button>
      </div>
      <div
        ref={stageRef}
        className="flex justify-center overflow-auto rounded-lg border border-border"
      >
        <Document
          file={fileSource}
          onLoadSuccess={({ numPages: n }) => {
            setNumPages(n);
            // A shorter document than the one before it would otherwise leave the
            // viewer parked on a page that no longer exists.
            setPage((p) => Math.min(p, n) || 1);
          }}
          loading={
            <p className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Loading PDF…
            </p>
          }
          error={
            <p className="p-8 text-sm text-danger" role="alert">
              Couldn&apos;t load this PDF.
            </p>
          }
        >
          {/* Held back until the stage has been measured: react-pdf treats a width of 0
              as a real request and renders nothing readable. */}
          {width > 0 && <Page pageNumber={page} width={width} />}
        </Document>
      </div>
    </div>
  );
}
