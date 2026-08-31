"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { apiFetch } from "@/shared/api/client";
import { Button } from "@/ui/primitives/button";
import { useConfirm } from "@admin/presentation/components/confirm-dialog";
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
} from "@admin/presentation/components/admin-ui";
import { notify } from "@/shared/lib/system/notify-store";
import { useFormat, useT } from "@/shared/lib/i18n";
import { cn } from "@/shared/lib/utils";
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

const STATUS_VALUES = ["all", "active", "expired"] as const;

export default function AdminSharesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const t = useT();
  const { formatBytes, formatDate } = useFormat();
  const [status, setStatus] = useState<"all" | "active" | "expired">("all");
  const [ownerSearch, setOwnerSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revoking, setRevoking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Built here rather than at module scope: the labels are translated, and `t`
  // only exists inside the component.
  const statusOptions = useMemo(
    () =>
      STATUS_VALUES.map((value) => ({
        value,
        label: t(
          value === "all"
            ? "admin.shares.statusAll"
            : value === "active"
              ? "admin.shares.statusActive"
              : "admin.shares.statusExpired"
        ),
      })),
    [t]
  );

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
        title: t("admin.shares.revokeTitle", { count: selected.size }),
        message: t("admin.shares.revokeMessage"),
        confirmLabel: t("admin.shares.revokeConfirm"),
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
            notify({ title: res.error ?? t("admin.shares.revokeFailed"), tone: "error" });
            return;
          }
          notify({
            title: t("admin.shares.revoked", { count: selected.size }),
            tone: "success",
          });
          setSelected(new Set());
          queryClient.invalidateQueries({ queryKey: ["admin-shares"] });
        } catch {
          notify({ title: t("errors.connectionFailed"), tone: "error" });
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
        kicker={t("admin.shares.kicker")}
        title={t("admin.shares.title")}
        lede={t("admin.shares.lede")}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} aria-hidden="true" />
            {t("common.refresh")}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={Link2}
          label={t("admin.shares.metricLinks")}
          value={rows.length}
          tone="accent"
          hint={t("admin.shares.metricLinksHint")}
        />
        <AdminMetric
          icon={Check}
          label={t("admin.shares.statusActive")}
          value={summary.active}
          tone="success"
          hint={t("admin.shares.metricActiveHint")}
        />
        <AdminMetric
          icon={CircleSlash}
          label={t("admin.shares.statusExpired")}
          value={summary.expired}
          tone="muted"
          hint={t("admin.shares.metricExpiredHint")}
        />
        <AdminMetric
          icon={Eye}
          label={t("admin.shares.opens")}
          value={summary.opens}
          tone="info"
          hint={t("admin.shares.metricOpensHint")}
        />
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
              label={t("admin.ui.clearSelection")}
            />
            <span className="text-[0.8rem] font-medium">
              {t("common.selectedCount", { count: selected.size })}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                {t("common.cancel")}
              </Button>
              <Button variant="destructive" size="sm" disabled={revoking} onClick={revokeSelected}>
                {revoking ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                )}
                {t("admin.shares.revokeCount", { count: selected.size })}
              </Button>
            </div>
          </>
        ) : (
          <>
            <SearchField
              icon={Search}
              value={ownerSearch}
              onChange={setOwnerSearch}
              label={t("admin.shares.searchLabel")}
              placeholder={t("admin.shares.searchPlaceholder")}
            />
            <Segment
              value={status}
              onChange={setStatus}
              options={statusOptions}
              label={t("admin.shares.statusFilterLabel")}
            />
          </>
        )}
      </div>

      <AdminPanel
        icon={Share2}
        title={t("admin.shares.panelTitle", { count: filtered.length })}
        sub={
          ownerSearch.trim()
            ? t("admin.ui.matching", { query: ownerSearch.trim() })
            : undefined
        }
        flush
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-11 w-full" rows={6} />
          </div>
        ) : filtered.length === 0 ? (
          <AdminEmpty
            icon={Link2}
            title={
              rows.length === 0
                ? t("admin.shares.emptyTitle")
                : t("admin.shares.noMatchTitle")
            }
            body={
              rows.length === 0 ? t("admin.shares.emptyBody") : t("admin.shares.noMatchBody")
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
                      label={
                        allSelected
                          ? t("admin.shares.deselectAll")
                          : t("admin.shares.selectAll")
                      }
                    />
                  </th>
                  <th>{t("admin.shares.colFile")}</th>
                  <th>{t("admin.shares.colOwner")}</th>
                  <th>{t("admin.shares.colStatus")}</th>
                  <th>{t("admin.shares.opens")}</th>
                  <th>{t("admin.shares.colCreated")}</th>
                  <th style={{ width: "5.5rem" }}>{t("admin.shares.colLink")}</th>
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
            label={t("admin.shares.selectOne", { name: s.fileName })}
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
            className="font-medium text-accent-ink hover:underline"
          >
            {s.ownerUsername}
          </Link>
        </td>
        <td>
          <Chip tone={s.status === "active" ? "success" : "muted"}>
            {s.status === "active"
              ? t("admin.shares.statusActive")
              : t("admin.shares.statusExpired")}
          </Chip>
          {s.expiresAt && (
            <div className="adm-sub mt-1">
              {t("admin.shares.expires", { date: formatDate(s.expiresAt) })}
            </div>
          )}
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
              label={copied === s.id ? t("admin.shares.linkCopied") : t("admin.shares.copyLink")}
              onClick={() => void copyUrl(s.shareUrl, s.id)}
            />
            <a
              href={s.shareUrl}
              target="_blank"
              rel="noreferrer"
              className="adm-iconbtn"
              aria-label={t("admin.shares.openLinkFor", { name: s.fileName })}
              title={t("admin.shares.openLink")}
            >
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        </td>
      </tr>
    );
  }
}
