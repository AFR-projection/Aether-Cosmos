"use client";

import { useCallback, useEffect, useState } from "react";
import mammoth from "mammoth";
import DOMPurify from "isomorphic-dompurify";
import { FileText } from "lucide-react";
import { usePreviewSource } from "@/hooks/use-preview-source";
import { downloadViewerSource } from "@/lib/download/download-actions";
import {
  ViewerBar,
  ViewerDownloadButton,
  ViewerLoading,
  ViewerMessage,
} from "./viewer-chrome";

interface DocxViewerProps {
  src: string;
  fileName: string;
  fileId: string;
}

export function DocxViewer({ src, fileName, fileId }: DocxViewerProps) {
  const { arrayBuffer, loading, error } = usePreviewSource(src);
  const [html, setHtml] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!arrayBuffer) return;
    let cancelled = false;

    mammoth
      .convertToHtml({ arrayBuffer }, { includeDefaultStyleMap: true })
      .then((result) => {
        if (cancelled) return;
        setHtml(DOMPurify.sanitize(result.value));
        setParseError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setParseError("This document could not be read.");
        setHtml(null);
      });

    return () => {
      cancelled = true;
    };
  }, [arrayBuffer, attempt]);

  const handleDownload = useCallback(
    () => downloadViewerSource(src, fileId, fileName),
    [src, fileId, fileName]
  );

  if (loading) return <ViewerLoading label="Loading document…" />;

  const message = error ?? parseError;
  if (message) {
    return (
      <ViewerMessage
        icon={FileText}
        tone="danger"
        title="Preview unavailable"
        hint={`${message} Only .docx is supported — older .doc files need converting first.`}
        onRetry={() => setAttempt((n) => n + 1)}
        onDownload={handleDownload}
      />
    );
  }

  if (html === null) return <ViewerLoading label="Converting document…" />;

  if (html.trim() === "") {
    return (
      <ViewerMessage
        icon={FileText}
        title="Nothing to show"
        hint="This document has no text content — download it to open in Word."
        onDownload={handleDownload}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <ViewerBar icon={FileText} fileName={fileName} tone="info">
        <ViewerDownloadButton onDownload={handleDownload} />
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-auto">
        <article
          className="prose prose-sm mx-auto max-w-3xl px-8 py-10 dark:prose-invert prose-headings:font-semibold prose-p:leading-relaxed prose-table:border-collapse prose-td:border prose-td:border-border/30 prose-td:px-2 prose-td:py-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
