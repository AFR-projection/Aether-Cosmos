"use client";

import { useEffect, useMemo, useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import { useT } from "@/shared/lib/i18n";
import { ViewerLoading } from "./viewer-chrome";

interface SvgViewerProps {
  src: string;
  fileName: string;
}

/**
 * Inlines the SVG (sanitized) so it scales crisply and can inherit page zoom.
 * If the text fetch fails we still fall back to the browser's own image
 * decoding rather than showing an error for a file it can probably display.
 */
export function SvgViewer({ src, fileName }: SvgViewerProps) {
  const t = useT();
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(src, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        setSvgContent(text);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  const sanitized = useMemo(
    () => (svgContent ? DOMPurify.sanitize(svgContent) : ""),
    [svgContent]
  );

  if (loading) return <ViewerLoading label={t("files.preview.loading.svg")} />;

  if (error || !svgContent) {
    return (
      <div className="checkerboard flex h-full items-center justify-center p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={fileName} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  return (
    <div className="checkerboard flex h-full items-center justify-center p-6">
      <div
        role="img"
        aria-label={fileName}
        className="max-h-full max-w-full [&>svg]:h-auto [&>svg]:max-h-full [&>svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    </div>
  );
}
