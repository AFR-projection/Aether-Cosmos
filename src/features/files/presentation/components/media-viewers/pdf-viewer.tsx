"use client";

import { FileText, ExternalLink } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { downloadViewerSource } from "@files/application/commands/download-actions";
import { useT } from "@/shared/lib/i18n";
import { ViewerBar, ViewerDownloadButton } from "./viewer-chrome";

interface PdfViewerProps {
  fileId: string;
  previewUrl?: string;
  fileName?: string;
}

export function PdfViewer({ fileId, previewUrl, fileName }: PdfViewerProps) {
  const t = useT();
  const src = previewUrl ?? `/api/files/${fileId}/preview`;
  const name = fileName ?? "document.pdf";

  return (
    <div className="flex h-full flex-col bg-viewer-stage">
      <ViewerBar icon={FileText} fileName={name} tone="danger">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("files.viewer.pdf.openNewTab")}
          onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </Button>
        <ViewerDownloadButton onDownload={() => downloadViewerSource(src, fileId, name)} />
      </ViewerBar>
      <iframe
        src={`${src}#toolbar=1&navpanes=0&view=FitH`}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        title={t("files.viewer.pdf.frameTitle", { name })}
      />
    </div>
  );
}
