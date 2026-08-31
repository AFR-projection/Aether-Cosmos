"use client";

import { useCallback, useEffect, useState } from "react";
import mammoth from "mammoth";
import DOMPurify from "isomorphic-dompurify";
import { FileText } from "lucide-react";
import { usePreviewSource } from "@files/presentation/hooks/use-preview-source";
import { downloadViewerSource } from "@files/application/commands/download-actions";
import { useT } from "@/shared/lib/i18n";
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
  const t = useT();
  const { arrayBuffer, loading, error } = usePreviewSource(src);
  const [html, setHtml] = useState<string | null>(null);
  /* A flag rather than a sentence: mammoth fails once, but the reader may change
     language afterwards, and the words are chosen below. */
  const [parseFailed, setParseFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!arrayBuffer) return;
    let cancelled = false;

    mammoth
      .convertToHtml({ arrayBuffer }, { includeDefaultStyleMap: true })
      .then((result) => {
        if (cancelled) return;
        setHtml(DOMPurify.sanitize(result.value));
        setParseFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setParseFailed(true);
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

  if (loading) return <ViewerLoading label={t("files.preview.loading.document")} />;

  const reason = error ?? (parseFailed ? t("files.viewer.docx.failed") : null);
  if (reason) {
    return (
      <ViewerMessage
        icon={FileText}
        tone="danger"
        title={t("files.viewer.unavailable")}
        hint={t("files.viewer.docx.hint", { reason })}
        onRetry={() => setAttempt((n) => n + 1)}
        onDownload={handleDownload}
      />
    );
  }

  if (html === null) return <ViewerLoading label={t("files.viewer.docx.converting")} />;

  if (html.trim() === "") {
    return (
      <ViewerMessage
        icon={FileText}
        title={t("files.viewer.nothingToShow")}
        hint={t("files.viewer.docx.empty")}
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
