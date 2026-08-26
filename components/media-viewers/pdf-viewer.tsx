"use client";

import { FileText, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadViewerSource } from "@/lib/download/download-actions";
import { ViewerBar, ViewerDownloadButton } from "./viewer-chrome";

interface PdfViewerProps {
  fileId: string;
  previewUrl?: string;
  fileName?: string;
}

export function PdfViewer({ fileId, previewUrl, fileName }: PdfViewerProps) {
  const src = previewUrl ?? `/api/files/${fileId}/preview`;
  const name = fileName ?? "document.pdf";

  return (
    <div className="flex h-full flex-col bg-viewer-stage">
      <ViewerBar icon={FileText} fileName={name} tone="danger">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open in a new tab"
          onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </Button>
        <ViewerDownloadButton onDownload={() => downloadViewerSource(src, fileId, name)} />
      </ViewerBar>
      <iframe
        src={`${src}#toolbar=1&navpanes=0&view=FitH`}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        title={`PDF preview of ${name}`}
      />
    </div>
  );
}
