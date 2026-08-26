"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { apiFetch } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/admin/confirm-dialog";
import {
  AdminEmpty,
  AdminHeader,
  AdminMetric,
  AdminPanel,
  Check as CheckBox,
  Chip,
  IconButton,
  Meter,
  SearchField,
  Segment,
  Skeleton,
} from "@/components/admin/admin-ui";
import { notify } from "@/lib/system/notify-store";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import {
  Share2,
  Search,
  Trash2,
  Loader2,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  Link2,
  Eye,
  CircleSlash,
} from "lucide-react";

type ShareRow = {
  id: string;
  token: string;
  shareUrl: string;
  permission: string;
  expiresAt: string | null;
  accessCount: number;
  maxAccessCount: number | null;
  lastAccessedAt: string | null;
  createdAt: string;
  fileId: string;
  fileName: string;
  fileMime: string;
  fileSize: number;
  ownerId: string;
  ownerUsername: string;
  status: "active" | "expired";
};

const STATUS_OPTIONS = [
  { value: "all" as const, label: "All" },
  { value: "active" as const, label: "Active" },
  { value: "expired" as const, label: "Expired" },
];

export default function AdminSharesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [status, setStatus] = useState<"all" | "active" | "expired">("all");
  const [ownerSearch, setOwnerSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revoking, setRevoking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const { data: shares, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["admin-shares", status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      const res = await apiFetch<{ shares: ShareRow[] }>(`/api/admin/shares?${params}`);
      return res.data?.shares ?? [];
    },
  });

  // Memoised so the summary below does not recompute on every keystroke of an
  // unrelated state change.
  const rows = useMemo(() => shares ?? [], [shares]);

  const filtered = useMemo(() => {
    const q = ownerSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (s) =>
        s.ownerUsername.toLowerCase().includes(q) ||
        s.fileName.toLowerCase().includes(q) ||
        s.token.toLowerCase().includes(q)
    );
  }, [rows, ownerSearch]);

  const summary = useMemo(() => {
    let active = 0;
    let expired = 0;
    let opens = 0;
    for (const s of rows) {
      if (s.status === "active") active += 1;
      else expired += 1;
      opens += s.accessCount;
    }
    return { active, expired, opens };
  }, [rows]);

  const allSelected = filtered.length > 0 && selected.size === filtered.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(filtered.map((s) => s.id)));
  }

  function revokeSelected() {
    if (selected.size === 0) return;
    confirm.open(
      {
        title: `Revoke ${selected.size} share link${selected.size !== 1 ? "s" : ""}?`,
        message: "Anyone holding these links will immediately lose access. This cannot be undone.",
        confirmLabel: "Revoke links",
        danger: true,
      },
      async () => {
        setRevoking(true);
        try {
          const res = await apiFetch("/api/admin/shares", {
            method: "DELETE",
            body: JSON.stringify({ ids: Array.from(selected) }),
          });
          if (!res.success) {
            notify({ title: res.error ?? "Failed to revoke shares", tone: "error" });
            return;
          }
          notify({ title: `${selected.size} share link(s) revoked`, tone: "success" });
          setSelected(new Set());
          queryClient.invalidateQueries({ queryKey: ["admin-shares"] });
        } catch {
          notify({ title: "Connection failed", tone: "error" });
        } finally {
          setRevoking(false);
        }
      }
    );
  }

  async function copyUrl(url: string, id: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-5">
      <AdminHeader
        icon={Share2}
        kicker="Shares"
        title="Share links"
        lede="Every public link across every account, newest first. Select the ones that should stop working and revoke them in one pass."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric icon={Link2} label="Links" value={rows.length} tone="accent" hint="In this view" />
        <AdminMetric icon={Check} label="Active" value={summary.active} tone="success" hint="Reachable right now" />
        <AdminMetric
          icon={CircleSlash}
          label="Expired"
          value={summary.expired}
          tone="muted"
          hint="Already refusing access"
        />
        <AdminMetric icon={Eye} label="Opens" value={summary.opens} tone="info" hint="Total across all links" />
      </div>

      {/* One bar for both jobs: filtering when nothing is selected, bulk actions
          when something is. It never changes height, so the table below stays put. */}
      <div className="adm-toolbar" data-active={selected.size > 0}>
        {selected.size > 0 ? (
          <>
            <CheckBox
              checked
              indeterminate={!allSelected}
              onChange={() => setSelected(new Set())}
              label="Clear selection"
            />
            <span className="text-[0.8rem] font-medium">
              <span className="adm-num">{selected.size}</span> selected
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" disabled={revoking} onClick={revokeSelected}>
                {revoking ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                )}
                Revoke {selected.size}
              </Button>
            </div>
          </>
        ) : (
          <>
            <SearchField
              icon={Search}
              value={ownerSearch}
              onChange={setOwnerSearch}
              label="Search shares"
              placeholder="Owner, file name, or token…"
            />
            <Segment value={status} onChange={setStatus} options={STATUS_OPTIONS} label="Share status" />
          </>
        )}
      </div>

      <AdminPanel
        icon={Share2}
        title={`${filtered.length} share${filtered.length !== 1 ? "s" : ""}`}
        sub={ownerSearch.trim() ? `Matching “${ownerSearch.trim()}”` : undefined}
        flush
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-11 w-full" rows={6} />
          </div>
        ) : filtered.length === 0 ? (
          <AdminEmpty
            icon={Link2}
            title={rows.length === 0 ? "No share links" : "Nothing matches that filter"}
            body={
              rows.length === 0
                ? "When a user shares a file by link it appears here, along with how many times it has been opened."
                : "Try a different owner, file name, or token — or widen the status filter."
            }
          />
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th style={{ width: "2.5rem" }}>
                    <CheckBox
                      checked={allSelected}
                      indeterminate={selected.size > 0}
                      onChange={toggleAll}
                      label={allSelected ? "Deselect all shares" : "Select all shares"}
                    />
                  </th>
                  <th>File</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Opens</th>
                  <th>Created</th>
                  <th style={{ width: "5.5rem" }}>Link</th>
                </tr>
              </thead>
              <tbody>{filtered.map((s) => renderRow(s))}</tbody>
            </table>
          </div>
        )}
      </AdminPanel>

      {confirm.element}
    </div>
  );

  function renderRow(s: ShareRow) {
    const capped = s.maxAccessCount != null && s.maxAccessCount > 0;
    return (
      <tr key={s.id} data-selected={selected.has(s.id)}>
        <td>
          <CheckBox
            checked={selected.has(s.id)}
            onChange={() => toggle(s.id)}
            label={`Select share for ${s.fileName}`}
          />
        </td>
        <td>
          <div className="max-w-[16rem] truncate font-medium">{s.fileName}</div>
          <div className="adm-sub">
            {formatBytes(s.fileSize)} · {s.permission}
          </div>
        </td>
        <td>
          <Link
            href={`/admin/users/${s.ownerId}`}
            className="font-medium text-accent hover:underline"
          >
            {s.ownerUsername}
          </Link>
        </td>
        <td>
          <Chip tone={s.status === "active" ? "success" : "muted"}>
            {s.status === "active" ? "Active" : "Expired"}
          </Chip>
          {s.expiresAt && <div className="adm-sub mt-1">Expires {formatDate(s.expiresAt)}</div>}
        </td>
        <td>
          <span className="adm-num">
            {s.accessCount}
            {capped ? ` / ${s.maxAccessCount}` : ""}
          </span>
          {capped && (
            <Meter
              className="mt-1.5 w-16"
              value={s.accessCount / (s.maxAccessCount as number)}
              tone={s.accessCount >= (s.maxAccessCount as number) ? "danger" : "accent"}
            />
          )}
        </td>
        <td className="whitespace-nowrap">
          <span className="adm-sub">{formatDate(s.createdAt)}</span>
        </td>
        <td>
          <div className="flex items-center gap-1">
            <IconButton
              icon={copied === s.id ? Check : Copy}
              tone={copied === s.id ? "success" : undefined}
              label={copied === s.id ? "Link copied" : "Copy share link"}
              onClick={() => void copyUrl(s.shareUrl, s.id)}
            />
            <a
              href={s.shareUrl}
              target="_blank"
              rel="noreferrer"
              className="adm-iconbtn"
              aria-label={`Open share link for ${s.fileName} in a new tab`}
              title="Open link"
            >
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        </td>
      </tr>
    );
  }
}
