"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { apiFetch } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { useConfirm } from "@/components/admin/confirm-dialog";
import { UserSecurityPanel } from "@/components/admin/user-security-panel";
import { useAdminEvents } from "@/hooks/use-admin-events";
import { notify } from "@/lib/system/notify-store";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import {
  UserPlus,
  Ban,
  Trash2,
  LogIn,
  Loader2,
  Search,
  Shield,
  User,
  Eye,
  Edit,
  Save,
  X,
  Users,
  Radio,
  MailWarning,
  CheckCircle2,
  Send,
  ArrowUpDown,
} from "lucide-react";

/** A user counts as "online" if a live session was active within this window. */
const ONLINE_WINDOW_MS = 3 * 60 * 1000;

type Verification = "active" | "unverified" | "suspended";

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  phone?: string | null;
  role: string;
  status: string;
  suspendReason?: string | null;
  mustChangePassword?: boolean;
  totpEnabled?: boolean;
  quotaBytes: number;
  usedBytes: number;
  bandwidthQuotaBytes?: number;
  bandwidthUsedBytes?: number;
  createdAt: string;
  updatedAt?: string;
  activeSessions: number;
  lastActiveAt: string | null;
  online: boolean;
  verification: Verification;
}

interface UsersStats {
  total: number;
  online: number;
  active: number;
  unverified: number;
  suspended: number;
}

type Filter = "all" | "online" | "unverified" | "suspended";
type SortBy = "online" | "recent" | "storage" | "name";

export default function AdminUsersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const live = useAdminEvents(["admin-users"]);

  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState({
    username: "",
    email: "",
    password: "",
    quotaGB: 10,
    mustChangePassword: false,
    bandwidthQuotaGB: 0,
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("online");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [form, setForm] = useState({ username: "", email: "", password: "", quotaGB: 10 });
  const [formError, setFormError] = useState("");
  const [formLoading, setFormLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Load default quota from admin settings
  useEffect(() => {
    apiFetch<{ defaultQuotaGB: number }>("/api/admin/settings").then((res) => {
      if (res.success && res.data?.defaultQuotaGB) {
        setForm((f) => ({ ...f, quotaGB: res.data!.defaultQuotaGB }));
      }
    });
  }, []);

  // 1s tick kept as `now` state so nothing calls Date.now() during render, while
  // presence dots + "last seen"/"updated" still stay live between fetches. Stays
  // 0 for the first second — isOnline falls back to the server's fresh snapshot.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const res = await apiFetch<{ users: AdminUser[]; stats: UsersStats; serverTime: number }>(
        "/api/admin/users"
      );
      return {
        users: res.data?.users ?? [],
        serverTime: res.data?.serverTime ?? Date.now(),
        clientFetchedAt: Date.now(),
      };
    },
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  const users = data?.users ?? [];
  // Skew between server + this browser, captured at fetch — presence is judged
  // against the server clock so a wrong local clock can't fake online/offline.
  const offset = data ? data.serverTime - data.clientFetchedAt : 0;

  // Until the tick effect seeds `now`, fall back to the server's snapshot flag so
  // the first paint isn't wrong.
  const isOnline = (u: AdminUser) =>
    now === 0
      ? u.online
      : !!u.lastActiveAt && now + offset - new Date(u.lastActiveAt).getTime() < ONLINE_WINDOW_MS;

  let onlineCount = 0;
  let unverifiedCount = 0;
  let suspendedCount = 0;
  for (const u of users) {
    if (isOnline(u)) onlineCount++;
    if (u.verification === "unverified") unverifiedCount++;
    else if (u.verification === "suspended") suspendedCount++;
  }
  const counts = {
    total: users.length,
    online: onlineCount,
    unverified: unverifiedCount,
    suspended: suspendedCount,
  };

  const q = searchTerm.toLowerCase();
  const filtered = users
    .filter(
      (u) => u.username.toLowerCase().includes(q) || (u.email && u.email.toLowerCase().includes(q))
    )
    .filter((u) => {
      if (filter === "online") return isOnline(u);
      if (filter === "unverified") return u.verification === "unverified";
      if (filter === "suspended") return u.verification === "suspended";
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "recent") return +new Date(b.createdAt) - +new Date(a.createdAt);
      if (sortBy === "storage") return b.usedBytes - a.usedBytes;
      if (sortBy === "name") return a.username.localeCompare(b.username);
      // online-first (default)
      const ao = isOnline(a) ? 1 : 0;
      const bo = isOnline(b) ? 1 : 0;
      if (ao !== bo) return bo - ao;
      const al = a.lastActiveAt ? +new Date(a.lastActiveAt) : 0;
      const bl = b.lastActiveAt ? +new Date(b.lastActiveAt) : 0;
      if (al !== bl) return bl - al;
      return +new Date(b.createdAt) - +new Date(a.createdAt);
    });

  const selectableIds = filtered.filter((u) => u.role !== "master").map((u) => u.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function ok(msg: string) {
    notify({ title: msg, tone: "success" });
  }
  function fail(msg: string) {
    notify({ title: msg, tone: "error" });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      if (selectableIds.every((id) => prev.has(id))) return new Set();
      return new Set(selectableIds);
    });
  }

  async function createUser() {
    setFormError("");
    setFormLoading(true);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: form.username,
          email: form.email || undefined,
          password: form.password,
          quotaBytes: form.quotaGB * 1073741824,
        }),
      });
      if (!res.success) {
        setFormError(res.error ?? "Failed to create user");
        return;
      }
      setShowCreate(false);
      setForm({ username: "", email: "", password: "", quotaGB: 10 });
      ok("User created successfully");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      setFormError("Connection failed");
    } finally {
      setFormLoading(false);
    }
  }

  async function suspendUser(id: string, status: "active" | "suspended", reason?: string) {
    setActionLoading(id);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({
          id,
          status,
          suspendReason: status === "suspended" ? reason || "Suspended by administrator" : null,
        }),
      });
      if (!res.success) {
        fail(res.error ?? "Failed to update status");
        return;
      }
      ok(`User ${status === "suspended" ? "suspended" : "activated"}`);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function deleteUser(id: string) {
    setActionLoading(id);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "DELETE",
        body: JSON.stringify({ id, deleteData: true }),
      });
      if (!res.success) {
        fail(res.error ?? "Failed to delete user");
        return;
      }
      ok("User deleted");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }

  /** Force-activate a pending (unverified) account without waiting for the OTP. */
  async function verifyNow(user: AdminUser) {
    setActionLoading(user.id);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({ id: user.id, status: "active" }),
      });
      if (!res.success) {
        fail(res.error ?? "Failed to verify user");
        return;
      }
      ok(`${user.username} verified & activated`);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }

  /** Re-send the OTP email to a pending account (reuses the public resend flow). */
  async function resendCode(user: AdminUser) {
    if (!user.email) {
      fail("This user has no email on file");
      return;
    }
    setActionLoading(user.id);
    try {
      const res = await apiFetch("/api/auth/resend-otp", {
        method: "POST",
        body: JSON.stringify({ email: user.email }),
      });
      if (!res.success) {
        fail(res.error ?? "Failed to resend code");
        return;
      }
      ok(`Verification code resent to ${user.email}`);
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }

  function runBulk(kind: "activate" | "suspend" | "delete") {
    const ids = [...selected].filter((id) => selectableIds.includes(id));
    if (ids.length === 0) return;
    const verb = kind === "activate" ? "Activate" : kind === "suspend" ? "Suspend" : "Delete";
    confirm.open(
      {
        title: `${verb} ${ids.length} user${ids.length > 1 ? "s" : ""}?`,
        message:
          kind === "delete"
            ? "This permanently deletes the selected users and all their files. This cannot be undone."
            : kind === "suspend"
              ? "The selected users will be signed out and blocked from logging in until reactivated."
              : "The selected users will be activated (and any pending accounts verified).",
        confirmLabel: verb,
        danger: kind !== "activate",
      },
      async () => {
        setBulkBusy(true);
        let done = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            const res =
              kind === "delete"
                ? await apiFetch("/api/admin/users", {
                    method: "DELETE",
                    body: JSON.stringify({ id, deleteData: true }),
                  })
                : await apiFetch("/api/admin/users", {
                    method: "PATCH",
                    body: JSON.stringify({
                      id,
                      status: kind === "suspend" ? "suspended" : "active",
                      ...(kind === "suspend"
                        ? { suspendReason: "Bulk suspended by administrator" }
                        : {}),
                    }),
                  });
            if (res.success) done++;
            else failed++;
          } catch {
            failed++;
          }
        }
        setBulkBusy(false);
        setSelected(new Set());
        if (failed === 0) ok(`${done} user${done > 1 ? "s" : ""} ${kind}d`);
        else fail(`${done} succeeded, ${failed} failed`);
        queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      }
    );
  }

  function toggleSuspend(user: AdminUser) {
    if (user.status === "active") {
      confirm.open(
        {
          title: `Suspend ${user.username}?`,
          message: "The user will be signed out and blocked from logging in until reactivated.",
          confirmLabel: "Suspend user",
          danger: true,
          reason: {
            label: "Reason (shown to the user on login)",
            placeholder: "Policy violation",
            defaultValue: "Policy violation",
          },
        },
        (reason) => suspendUser(user.id, "suspended", reason)
      );
    } else {
      void suspendUser(user.id, "active");
    }
  }

  function confirmDelete(user: AdminUser) {
    confirm.open(
      {
        title: `Delete ${user.username}?`,
        message: "This permanently deletes the user and all their files. This cannot be undone.",
        confirmLabel: "Delete permanently",
        danger: true,
      },
      () => deleteUser(user.id)
    );
  }

  function startEdit(user: AdminUser) {
    setEditingUser(user);
    setEditForm({
      username: user.username,
      email: user.email ?? "",
      password: "",
      quotaGB: Math.round(user.quotaBytes / 1073741824),
      mustChangePassword: !!user.mustChangePassword,
      bandwidthQuotaGB: Math.round((user.bandwidthQuotaBytes ?? 0) / 1073741824),
    });
  }

  async function saveEditUser() {
    if (!editingUser) return;
    setActionLoading(editingUser.id);
    try {
      const body: Record<string, unknown> = {
        id: editingUser.id,
        username: editForm.username || undefined,
        email: editForm.email.trim() || null,
        quotaBytes: editForm.quotaGB * 1073741824,
        mustChangePassword: editForm.mustChangePassword,
        bandwidthQuotaBytes: editForm.bandwidthQuotaGB * 1073741824,
      };
      if (editForm.password) body.password = editForm.password;
      const res = await apiFetch("/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (!res.success) {
        fail(res.error ?? "Failed to update user");
        return;
      }
      ok("User updated successfully");
      setEditingUser(null);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function impersonate(id: string) {
    setActionLoading(id);
    try {
      const res = await apiFetch("/api/auth/impersonate", {
        method: "POST",
        body: JSON.stringify({ userId: id }),
      });
      if (!res.success) {
        fail(res.error ?? "Failed to impersonate");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }

  const updatedAgo = dataUpdatedAt ? Math.max(0, Math.round((now - dataUpdatedAt) / 1000)) : 0;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="User Management"
        subtitle="Create, edit, suspend, and impersonate platform users"
        actions={
          <div className="flex items-center gap-3">
            <LiveIndicator status={live} updatedAgo={updatedAgo} />
            <Button
              onClick={() => {
                setShowCreate(!showCreate);
                setFormError("");
              }}
              className="gap-1.5"
            >
              <UserPlus className="h-4 w-4" /> Add User
            </Button>
          </div>
        }
      />

      {/* Stat tiles — clickable filters */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={<Users className="h-4 w-4" />}
          label="Total users"
          value={counts.total}
          tone="neutral"
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <StatTile
          icon={<Radio className="h-4 w-4" />}
          label="Online now"
          value={counts.online}
          tone="emerald"
          active={filter === "online"}
          onClick={() => setFilter("online")}
        />
        <StatTile
          icon={<MailWarning className="h-4 w-4" />}
          label="Unverified"
          value={counts.unverified}
          tone="amber"
          active={filter === "unverified"}
          onClick={() => setFilter("unverified")}
        />
        <StatTile
          icon={<Ban className="h-4 w-4" />}
          label="Suspended"
          value={counts.suspended}
          tone="red"
          active={filter === "suspended"}
          onClick={() => setFilter("suspended")}
        />
      </div>

      {/* Toolbar: search + sort */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            placeholder="Search users..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
        <div className="relative">
          <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="h-10 rounded-xl border border-border/60 bg-surface pl-9 pr-8 text-sm text-foreground focus-visible:outline-none focus-visible:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/15"
          >
            <option value="online">Online first</option>
            <option value="recent">Newest</option>
            <option value="storage">Storage used</option>
            <option value="name">Name (A–Z)</option>
          </select>
        </div>
        {filter !== "all" && (
          <button
            type="button"
            onClick={() => setFilter("all")}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear filter
          </button>
        )}
      </div>

      {/* Create User Form */}
      {showCreate && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-accent" />
                Create New User
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Input
                  placeholder="Username"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
                <Input
                  placeholder="Email (optional)"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
                <Input
                  type="password"
                  placeholder="Password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                <Input
                  type="number"
                  placeholder="Quota (GB)"
                  value={form.quotaGB}
                  onChange={(e) => setForm({ ...form, quotaGB: parseInt(e.target.value) || 10 })}
                />
              </div>
              {formError && <p className="mt-3 text-sm text-red-500">{formError}</p>}
              <Button onClick={createUser} disabled={formLoading} className="mt-4">
                {formLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : (
                  <Shield className="h-4 w-4 mr-1.5" />
                )}
                Create User
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3"
        >
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => runBulk("activate")}>
            {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
            Activate
          </Button>
          <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => runBulk("suspend")}>
            <Ban className="h-3.5 w-3.5 mr-1" /> Suspend
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={bulkBusy}
            onClick={() => runBulk("delete")}
            className="text-danger hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </motion.div>
      )}

      {/* Users Table */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 skeleton rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-border/50 bg-surface overflow-hidden">
          {/* Table Header */}
          <div className="hidden md:grid grid-cols-[36px_1fr_130px_180px_110px_150px] items-center border-b border-border/40 bg-muted/30 px-4 py-3 text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider">
            <input
              type="checkbox"
              className="rounded"
              checked={allSelected}
              onChange={toggleSelectAll}
              aria-label="Select all"
            />
            <span>User</span>
            <span>Status</span>
            <span>Presence</span>
            <span>Storage</span>
            <span className="text-right">Actions</span>
          </div>

          {filtered.map((user, idx) => {
            const isBusy = actionLoading === user.id;
            const online = isOnline(user);
            const selectable = user.role !== "master";
            return (
              <motion.div
                key={user.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(idx * 0.02, 0.3) }}
                className={cn(
                  "md:grid md:grid-cols-[36px_1fr_130px_180px_110px_150px] items-center gap-3 px-4 py-4 border-b border-border/30 last:border-0 hover:bg-accent/5 transition-colors",
                  selected.has(user.id) && "bg-accent/5"
                )}
              >
                {/* Select checkbox (desktop) */}
                <div className="hidden md:block">
                  {selectable && (
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={selected.has(user.id)}
                      onChange={() => toggleSelect(user.id)}
                      aria-label={`Select ${user.username}`}
                    />
                  )}
                </div>

                {/* Mobile card layout */}
                <div className="md:hidden space-y-2 mb-3">
                  <div className="flex items-center gap-3">
                    {selectable && (
                      <input
                        type="checkbox"
                        className="rounded"
                        checked={selected.has(user.id)}
                        onChange={() => toggleSelect(user.id)}
                        aria-label={`Select ${user.username}`}
                      />
                    )}
                    <Avatar online={online} />
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{user.username}</p>
                      <p className="text-xs text-muted-foreground truncate">{user.email ?? "—"}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded bg-muted px-2 py-0.5 font-medium uppercase">{user.role}</span>
                    <VerificationBadge verification={user.verification} />
                    <PresenceText online={online} lastActiveAt={user.lastActiveAt} sessions={user.activeSessions} />
                    <span>
                      {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}
                    </span>
                    <span>{formatDate(user.createdAt, "short")}</span>
                  </div>
                </div>

                {/* Desktop: User */}
                <div className="hidden md:flex items-center gap-3 min-w-0">
                  <Avatar online={online} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate flex items-center gap-1.5">
                      {user.username}
                      {user.totpEnabled && (
                        <span className="rounded bg-accent/10 px-1 py-0.5 text-[9px] font-bold uppercase text-accent">
                          2FA
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">{user.email ?? "—"}</p>
                  </div>
                </div>

                {/* Desktop: Status */}
                <div className="hidden md:block">
                  <VerificationBadge verification={user.verification} />
                </div>

                {/* Desktop: Presence */}
                <div className="hidden md:block">
                  <PresenceCell online={online} lastActiveAt={user.lastActiveAt} sessions={user.activeSessions} />
                </div>

                {/* Desktop: Storage */}
                <span className="hidden md:inline font-mono text-xs text-muted-foreground">
                  {formatBytes(user.usedBytes)}
                </span>

                {/* Actions */}
                <div className="flex justify-end gap-1">
                  {user.verification === "unverified" && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-emerald-500 hover:bg-emerald-500/10"
                        title="Verify & activate now"
                        disabled={isBusy}
                        onClick={() => verifyNow(user)}
                      >
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      </Button>
                      {user.email && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-info hover:bg-info/10"
                          title="Resend verification code"
                          disabled={isBusy}
                          onClick={() => resendCode(user)}
                        >
                          <Send className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-info hover:bg-info/10"
                    title="View Details"
                    onClick={() => router.push(`/admin/users/${user.id}`)}
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-accent hover:bg-accent/10"
                    title="Edit User"
                    onClick={() => startEdit(user)}
                  >
                    <Edit className="h-3.5 w-3.5" />
                  </Button>
                  {user.role !== "master" && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-accent hover:bg-accent/10"
                        title="Impersonate"
                        disabled={isBusy}
                        onClick={() => impersonate(user.id)}
                      >
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-warning hover:bg-warning/10"
                        title="Suspend/Activate"
                        disabled={isBusy}
                        onClick={() => toggleSuspend(user)}
                      >
                        <Ban className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-danger hover:bg-danger/10"
                        title="Delete"
                        disabled={isBusy}
                        onClick={() => confirmDelete(user)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </motion.div>
            );
          })}

          {filtered.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              {searchTerm || filter !== "all" ? "No users match your filter" : "No users found"}
            </div>
          )}
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div className="scrim fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-lg rounded-2xl border border-border/50 bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border/40 px-6 py-4">
              <h2 className="text-lg font-semibold">Edit User: {editingUser.username}</h2>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditingUser(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-4 p-6">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground/80">Username</label>
                <Input
                  value={editForm.username}
                  onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                  placeholder="Username"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground/80">Email</label>
                <Input
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  placeholder="Email (optional)"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground/80">
                  New Password (leave blank to keep current)
                </label>
                <Input
                  type="password"
                  value={editForm.password}
                  onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                  placeholder="New password"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground/80">Quota (GB)</label>
                <Input
                  type="number"
                  value={editForm.quotaGB}
                  onChange={(e) => setEditForm({ ...editForm, quotaGB: parseInt(e.target.value) || 10 })}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground/80">
                  Bandwidth quota / month (GB, 0 = unlimited)
                </label>
                <Input
                  type="number"
                  min={0}
                  value={editForm.bandwidthQuotaGB}
                  onChange={(e) =>
                    setEditForm({ ...editForm, bandwidthQuotaGB: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editForm.mustChangePassword}
                  onChange={(e) => setEditForm({ ...editForm, mustChangePassword: e.target.checked })}
                  className="rounded"
                />
                Force password reset on next login
              </label>

              <div className="border-t border-border/40 pt-4">
                <p className="mb-3 text-sm font-semibold">Login security</p>
                <UserSecurityPanel userId={editingUser.id} />
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setEditingUser(null)}>
                  Cancel
                </Button>
                <Button onClick={saveEditUser} disabled={actionLoading === editingUser.id}>
                  {actionLoading === editingUser.id ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <Save className="h-4 w-4 mr-1.5" />
                  )}
                  Save Changes
                </Button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {confirm.element}
    </div>
  );
}

function Avatar({ online }: { online: boolean }) {
  return (
    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10">
      <User className="h-4 w-4 text-accent" />
      <span
        className={cn(
          "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface",
          online ? "bg-emerald-500" : "bg-muted-foreground/40"
        )}
      />
    </div>
  );
}

function PresenceCell({
  online,
  lastActiveAt,
  sessions,
}: {
  online: boolean;
  lastActiveAt: string | null;
  sessions: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-xs font-medium">
        {online ? (
          <>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">Online</span>
          </>
        ) : (
          <>
            <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
            <span className="text-muted-foreground">
              {lastActiveAt
                ? `${formatDistanceToNow(new Date(lastActiveAt), { addSuffix: true })}`
                : "Never signed in"}
            </span>
          </>
        )}
      </span>
      {sessions > 0 && (
        <span className="text-[11px] text-muted-foreground/70">
          {sessions} device{sessions > 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}

/** Compact inline presence for the mobile card. */
function PresenceText({
  online,
  lastActiveAt,
  sessions,
}: {
  online: boolean;
  lastActiveAt: string | null;
  sessions: number;
}) {
  if (online) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Online{sessions > 0 ? ` · ${sessions}d` : ""}
      </span>
    );
  }
  return (
    <span>{lastActiveAt ? formatDistanceToNow(new Date(lastActiveAt), { addSuffix: true }) : "Never"}</span>
  );
}

function VerificationBadge({ verification }: { verification: Verification }) {
  const map = {
    active: {
      label: "Active",
      cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      dot: "bg-emerald-500",
    },
    unverified: {
      label: "Unverified",
      cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      dot: "bg-amber-500",
    },
    suspended: {
      label: "Suspended",
      cls: "bg-red-500/10 text-red-600 dark:text-red-400",
      dot: "bg-red-500",
    },
  }[verification];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        map.cls
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", map.dot)} />
      {map.label}
    </span>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: "neutral" | "emerald" | "amber" | "red";
  active: boolean;
  onClick: () => void;
}) {
  const toneCls = {
    neutral: "text-foreground",
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-2xl border bg-surface px-4 py-3 text-left transition-all hover:border-accent/40",
        active ? "border-accent/60 ring-2 ring-accent/15" : "border-border/50"
      )}
    >
      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/50", toneCls)}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className={cn("text-xl font-bold leading-none", toneCls)}>{value}</p>
        <p className="mt-1 text-xs text-muted-foreground truncate">{label}</p>
      </div>
    </button>
  );
}

function LiveIndicator({
  status,
  updatedAgo,
}: {
  status: "connecting" | "live" | "reconnecting" | "offline";
  updatedAgo: number;
}) {
  const live = status === "live";
  const label =
    status === "live"
      ? "Live"
      : status === "connecting"
        ? "Connecting…"
        : status === "reconnecting"
          ? "Reconnecting…"
          : "Offline";
  return (
    <span
      className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-surface px-2.5 py-1 text-xs text-muted-foreground"
      title={`Realtime ${label}${live ? ` · updated ${updatedAgo}s ago` : ""}`}
    >
      <span className="relative flex h-2 w-2">
        {live && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            live ? "bg-emerald-500" : status === "offline" ? "bg-muted-foreground/40" : "bg-amber-500"
          )}
        />
      </span>
      <span className="font-medium">{label}</span>
      {live && <span className="text-muted-foreground/60">· {updatedAgo}s</span>}
    </span>
  );
}
