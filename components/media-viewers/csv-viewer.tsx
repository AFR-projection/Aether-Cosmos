"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./viewer-chrome";

interface CsvViewerProps {
  src: string;
  fileName: string;
}

const MAX_ROWS = 500;
const MAX_BYTES = 2_000_000;

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (ch === "\r") i++;
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function CsvViewer({ src, fileName }: CsvViewerProps) {
  const [rows, setRows] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [totalRows, setTotalRows] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const delimiter = fileName.endsWith(".tsv") ? "\t" : ",";

  useEffect(() => {
    let cancelled = false;
    fetch(src, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        const slice = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
        const parsed = parseDelimited(slice, delimiter);
        setTotalRows(parsed.length);
        setTruncated(text.length > MAX_BYTES || parsed.length > MAX_ROWS);
        setRows(parsed.slice(0, MAX_ROWS));
        setError(null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("This spreadsheet could not be loaded.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [src, delimiter, attempt]);

  const colCount = useMemo(() => Math.max(...rows.map((r) => r.length), 0), [rows]);
  const headers = rows[0] ?? [];

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(rows.map((r) => r.join("\t")).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the table stays selectable */
    }
  }, [rows]);

  if (loading) return <ViewerLoading label="Loading table…" />;

  if (error) {
    return (
      <ViewerMessage
        icon={Table2}
        tone="danger"
        title="Preview unavailable"
        hint={error}
        onRetry={() => {
          setLoading(true);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <ViewerMessage
        icon={Table2}
        title="No rows to show"
        hint="Every row in this file is empty."
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <ViewerBar
        icon={Table2}
        fileName={fileName}
        tone="success"
        meta={
          <span className="flex shrink-0 items-center gap-1.5">
            <Badge tone="neutral">
              {totalRows.toLocaleString()} rows · {colCount} cols
            </Badge>
            {truncated && (
              <Badge tone="warning">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                First {MAX_ROWS} rows
              </Badge>
            )}
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={copied ? "Copied to clipboard" : "Copy table as tab-separated text"}
          onClick={() => void handleCopy()}
        >
          {copied ? (
            <Check className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </ViewerBar>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">
            {fileName} — {totalRows} rows, {colCount} columns
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
                  className="max-w-[200px] truncate border-b border-border/40 px-3 py-2 text-left font-medium text-foreground"
                >
                  {headers[i] || `Column ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1).map((row, ri) => (
              <tr
                key={ri}
                className={cn("transition-colors hover:bg-accent/5", ri % 2 === 1 && "bg-muted/20")}
              >
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
                    title={row[ci] ?? ""}
                  >
                    {row[ci] ?? ""}
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
