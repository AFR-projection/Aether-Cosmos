"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { init } from "pptx-preview";
import { Presentation } from "lucide-react";
import { usePreviewSource } from "@/hooks/use-preview-source";
import { downloadViewerSource } from "@/lib/download/download-actions";
import {
  ViewerBar,
  ViewerDownloadButton,
  ViewerLoading,
  ViewerMessage,
} from "./viewer-chrome";

interface PptxViewerProps {
  src: string;
  fileName: string;
  fileId: string;
}

export function PptxViewer({ src, fileName, fileId }: PptxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { arrayBuffer, loading, error } = usePreviewSource(src);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  // Bumped by "Try again" so the render effect re-runs without reloading the page.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!arrayBuffer || !el) return;

    let cancelled = false;
    setRendering(true);
    setRenderError(null);
    el.innerHTML = "";

    const fail = () => {
      if (cancelled) return;
      setRenderError("This presentation could not be rendered in the browser.");
      setRendering(false);
    };

    try {
      const width = containerRef.current?.clientWidth ?? 960;
      const previewer = init(el, {
        width: Math.min(Math.max(width - 32, 320), 960),
        height: Math.round(Math.min(Math.max(width - 32, 320), 960) * 9 / 16),
      });
      previewer
        .preview(arrayBuffer)
        .then(() => {
          if (!cancelled) setRendering(false);
        })
        .catch(fail);
    } catch {
      fail();
    }

    return () => {
      cancelled = true;
      el.innerHTML = "";
    };
  }, [arrayBuffer, attempt]);

  const handleDownload = useCallback(
    () => downloadViewerSource(src, fileId, fileName),
    [src, fileId, fileName]
  );

  const message = error ?? renderError;

  // The slide host stays mounted at all times: pptx-preview writes straight into
  // this node, and unmounting it while rendering left the render in a detached
  // element — a permanently blank viewer. States are layered over it instead.
  return (
    <div ref={containerRef} className="relative flex h-full flex-col bg-viewer-stage">
      <ViewerBar icon={Presentation} fileName={fileName} tone="warning">
        <ViewerDownloadButton onDownload={handleDownload} />
      </ViewerBar>

      <div className="relative min-h-0 flex-1 overflow-auto">
        <div className="flex justify-center px-4 py-6">
          <div ref={wrapperRef} className="pptx-preview-root" />
        </div>

        {(loading || rendering) && (
          <div className="absolute inset-0 bg-viewer-stage">
            <ViewerLoading label={loading ? "Loading presentation…" : "Rendering slides…"} />
          </div>
        )}

        {message && !loading && !rendering && (
          <div className="absolute inset-0 bg-viewer-stage">
            <ViewerMessage
              icon={Presentation}
              tone="warning"
              title="Preview unavailable"
              hint={message}
              onRetry={() => setAttempt((n) => n + 1)}
              onDownload={handleDownload}
            />
          </div>
        )}
      </div>
    </div>
  );
}
