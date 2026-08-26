"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, Table2 } from "lucide-react";
import { usePreviewSource } from "@/hooks/use-preview-source";
import { Badge } from "@/components/ui/badge";
import { downloadViewerSource } from "@/lib/download/download-actions";
import { cn } from "@/lib/utils";
import {
  ViewerBar,
  ViewerDownloadButton,
  ViewerLoading,
  ViewerMessage,
} from "./viewer-chrome";

interface SpreadsheetViewerProps {
  src: string;
  fileName: string;
  fileId: string;
}

const MAX_ROWS = 1000;
const MAX_COLS = 50;

export function SpreadsheetViewer({ src, fileName, fileId }: SpreadsheetViewerProps) {
  const { arrayBuffer, loading, error } = usePreviewSource(src);
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!arrayBuffer) return;
    try {
      const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
      setWorkbook(wb);
      setActiveSheet(0);
      setParseError(null);
    } catch {
      setParseError("This spreadsheet format is not supported, or the file is damaged.");
      setWorkbook(null);
    }
  }, [arrayBuffer]);

  const sheetName = workbook?.SheetNames[activeSheet] ?? "";
  const grid = useMemo(() => {
    if (!workbook || !sheetName) return { rows: [] as string[][], truncated: false };
    const ws = workbook.Sheets[sheetName];
    const raw: string[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: "",
      raw: false,
    }) as string[][];

    const truncated = raw.length > MAX_ROWS || raw.some((r) => r.length > MAX_COLS);
    const rows = raw.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS));
    return { rows, truncated };
  }, [workbook, sheetName]);

  const colCount = useMemo(
    () => Math.max(...grid.rows.map((r) => r.length), 0),
    [grid.rows]
  );

  const handleDownload = useCallback(
    () => downloadViewerSource(src, fileId, fileName),
    [src, fileId, fileName]
  );

  if (loading) return <ViewerLoading label="Loading spreadsheet…" />;

  const message = error ?? parseError;
  if (message) {
    return (
      <ViewerMessage
        icon={Table2}
        tone="danger"
        title="Preview unavailable"
        hint={message}
        onDownload={handleDownload}
      />
    );
  }

  if (!workbook || grid.rows.length === 0) {
    return (
      <ViewerMessage
        icon={Table2}
        title="Nothing to show"
        hint={
          workbook
            ? `The sheet "${sheetName}" has no rows.`
            : "This workbook contains no readable sheets."
        }
        onDownload={handleDownload}
      />
    );
  }

  const headers = grid.rows[0] ?? [];

  return (
    <div className="flex h-full flex-col bg-surface">
      <ViewerBar
        icon={Table2}
        fileName={fileName}
        tone="success"
        meta={
          grid.truncated ? (
            <Badge tone="warning">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              First {MAX_ROWS} rows
            </Badge>
          ) : undefined
        }
      >
        <ViewerDownloadButton onDownload={handleDownload} />
      </ViewerBar>

      {workbook.SheetNames.length > 1 && (
        <div
          role="tablist"
          aria-label="Sheets"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/40 px-3 py-1.5"
        >
          {workbook.SheetNames.map((name, i) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={i === activeSheet}
              onClick={() => setActiveSheet(i)}
              className={cn(
                "min-h-8 whitespace-nowrap rounded-lg px-2.5 text-xs font-medium transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                i === activeSheet
                  ? "bg-accent text-white"
                  : "bg-surface text-muted-foreground hover:text-foreground"
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-max border-collapse text-xs">
          <caption className="sr-only">
            {fileName} — sheet {sheetName}, {grid.rows.length} rows, {colCount} columns
          </caption>
          <thead className="sticky top-0 z-10 bg-surface-elevated/95 backdrop-blur-sm">
            <tr>
              <th
                scope="col"
                className="w-10 border-b border-border/40 px-2 py-2 text-left font-normal text-muted-foreground"
              >
                #
              </th>
              {Array.from({ length: colCount }).map((_, i) => (
                <th
                  key={i}
                  scope="col"
                  className="max-w-[220px] truncate whitespace-nowrap border-b border-border/40 px-3 py-2 text-left font-medium text-foreground"
                >
                  {headers[i] || XLSX.utils.encode_col(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.slice(1).map((row, ri) => (
              <tr key={ri} className={cn("hover:bg-accent/5", ri % 2 === 1 && "bg-muted/20")}>
                <th
                  scope="row"
                  className="border-b border-border/20 px-2 py-1.5 text-left font-mono font-normal text-muted-foreground"
                >
                  {ri + 1}
                </th>
                {Array.from({ length: colCount }).map((_, ci) => (
                  <td
                    key={ci}
                    className="max-w-[240px] truncate whitespace-nowrap border-b border-border/20 px-3 py-1.5 text-foreground"
                    title={String(row[ci] ?? "")}
                  >
                    {String(row[ci] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
