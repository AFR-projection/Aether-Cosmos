"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { apiFetch } from "@/lib/api/client";
import { cn, formatDate } from "@/lib/utils";
import {
  Mail,
  Check,
  X,
  ArrowLeft,
  Loader2,
  Eye,
  Pencil,
  FolderOpen,
  Users,
  Clock,
  FolderClosed,
  Folder,
  Bell,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState, useRef, useEffect } from "react";
import { EmptyState } from "@/components/ui/empty-state";

interface Invitation {
  id: string;
  folderId: string;
  folderName: string;
  role: "view" | "edit";
  invitedByUsername: string;
  createdAt: string;
}

interface SharedEntry {
  memberId: string;
  role: "view" | "edit";
  sharedAt: string;
  folderId: string;
  folderName: string;
  folderCreatedAt: string;
  ownerId: string;
  ownerUsername: string;
}

export default function SharedWithMePage() {
  const queryClient = useQueryClient();
  const [invitationsOpen, setInvitationsOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const invitationsQuery = useQuery({
    queryKey: ["invitations"],
    queryFn: async () => {
      const res = await apiFetch<{ invitations: Invitation[] }>("/api/invitations");
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load");
      return res.data;
    },
  });

  const sharedQuery = useQuery({
    queryKey: ["shared-with-me"],
    queryFn: async () => {
      const res = await apiFetch<{ shared: SharedEntry[] }>("/api/shared-with-me");
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load");
      return res.data;
    },
  });

  const respondMutation = useMutation({
    mutationFn: async ({ invitationId, action }: { invitationId: string; action: "accept" | "reject" }) => {
      const res = await apiFetch("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ invitationId, action }),
      });
      if (!res.success) throw new Error(res.error ?? "Failed to respond");
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
    },
  });

  // Close popup when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        popupRef.current &&
        buttonRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setInvitationsOpen(false);
      }
    }
    if (invitationsOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [invitationsOpen]);

  const invitations = invitationsQuery.data?.invitations ?? [];
  const shared = sharedQuery.data?.shared ?? [];
  const pendingCount = invitations.length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/10">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Back Button */}
        <a
          href="/files"
          className="group mb-6 inline-flex items-center gap-2 rounded-xl border border-border/50 bg-card/60 px-4 py-2 text-sm font-medium text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:border-accent/40 hover:bg-accent/5 hover:text-foreground hover:shadow-md"
        >
          <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
          Back to My Files
        </a>

        {/* Hero Header */}
        <header className="mb-10">
          <div className="flex items-start justify-between gap-6">
            <div className="flex-1">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-accent/10 px-4 py-1.5 ring-1 ring-accent/20">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                <span className="text-xs font-semibold uppercase tracking-wider text-accent">
                  Collaboration Hub
                </span>
              </div>
              <h1 className="mb-3 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
                Shared with me
              </h1>
              <p className="max-w-2xl text-base text-muted-foreground">
                Access folders shared by your team. Accept invitations and collaborate seamlessly.
              </p>
            </div>

            {/* Invitations Trigger Button */}
            <div className="relative">
              <button
                ref={buttonRef}
                onClick={() => setInvitationsOpen(!invitationsOpen)}
                className={cn(
                  "group relative flex items-center gap-3 rounded-2xl border px-5 py-3 shadow-lg backdrop-blur-sm transition-all duration-200",
                  invitationsOpen
                    ? "border-accent/40 bg-accent/10 shadow-accent/10"
                    : "border-border/60 bg-card/90 hover:border-accent/30 hover:bg-accent/5 hover:shadow-xl"
                )}
              >
                <div className="relative">
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl transition-all",
                    invitationsOpen
                      ? "bg-accent/20 ring-2 ring-accent/30"
                      : "bg-accent/10 group-hover:bg-accent/15"
                  )}>
                    <Mail className="h-5 w-5 text-accent" />
                  </div>
                  {pendingCount > 0 && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-red-500 to-red-600 text-[11px] font-bold text-white shadow-lg ring-2 ring-background"
                    >
                      {pendingCount > 9 ? "9+" : pendingCount}
                    </motion.span>
                  )}
                </div>
                <div className="hidden text-left sm:block">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Invitations
                  </div>
                  <div className="text-sm font-bold text-foreground">
                    {pendingCount === 0 ? "All caught up" : `${pendingCount} pending`}
                  </div>
                </div>
              </button>

              {/* Invitations Popup */}
              <AnimatePresence>
                {invitationsOpen && (
                  <>
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
                      onClick={() => setInvitationsOpen(false)}
                    />
                    <motion.div
                      ref={popupRef}
                      initial={{ opacity: 0, y: -12, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -12, scale: 0.95 }}
                      transition={{ type: "spring", duration: 0.3, bounce: 0.2 }}
                      className="absolute right-0 top-full z-50 mt-3 w-[440px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border border-border/60 bg-card shadow-2xl"
                    >
                      {/* Popup Header */}
                      <div className="relative overflow-hidden border-b border-border/40 bg-gradient-to-br from-accent/5 to-transparent px-6 py-5">
                        <div className="relative z-10 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 ring-1 ring-accent/20">
                              <Mail className="h-5 w-5 text-accent" />
                            </div>
                            <div>
                              <h3 className="text-base font-bold text-foreground">Folder Invitations</h3>
                              <p className="text-xs text-muted-foreground">Review and respond</p>
                            </div>
                          </div>
                          {pendingCount > 0 && (
                            <span className="rounded-xl bg-accent/15 px-3 py-1 text-sm font-bold text-accent ring-1 ring-accent/20">
                              {pendingCount}
                            </span>
                          )}
                        </div>
                        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />
                      </div>

                      {/* Popup Content */}
                      <div className="max-h-[520px] overflow-y-auto">
                        {invitationsQuery.isLoading ? (
                          <div className="flex items-center justify-center py-16">
                            <Loader2 className="h-6 w-6 animate-spin text-accent" />
                          </div>
                        ) : invitations.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-muted/50 to-muted/20 ring-1 ring-border/40">
                              <Bell className="h-9 w-9 text-muted-foreground/30" />
                            </div>
                            <p className="mb-1 text-sm font-semibold text-foreground/80">All caught up!</p>
                            <p className="text-xs text-muted-foreground">No pending invitations right now.</p>
                          </div>
                        ) : (
                          <div className="space-y-3 p-4">
                            {invitations.map((inv, i) => (
                              <motion.div
                                key={inv.id}
                                initial={{ opacity: 0, x: -12 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: i * 0.05 }}
                                className="group relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-surface to-surface-hover/30 p-4 shadow-sm transition-all hover:border-accent/30 hover:shadow-md"
                              >
                                <div className="mb-4 flex items-start gap-3">
                                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 ring-1 ring-accent/20">
                                    <FolderClosed className="h-6 w-6 text-accent" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <h4 className="mb-1 truncate text-sm font-bold text-foreground">
                                      {inv.folderName}
                                    </h4>
                                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                      <span className="flex items-center gap-1">
                                        <UserPlus className="h-3 w-3" />
                                        <span className="font-medium text-foreground/70">{inv.invitedByUsername}</span>
                                      </span>
                                      <span>•</span>
                                      <span className="flex items-center gap-1">
                                        <Clock className="h-3 w-3" />
                                        {formatDate(inv.createdAt, "short")}
                                      </span>
                                    </div>
                                  </div>
                                  <span
                                    className={cn(
                                      "flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ring-1",
                                      inv.role === "edit"
                                        ? "bg-accent/15 text-accent ring-accent/30"
                                        : "bg-muted/80 text-muted-foreground ring-border/40"
                                    )}
                                  >
                                    {inv.role === "edit" ? (
                                      <><Pencil className="h-3 w-3" /> Edit</>
                                    ) : (
                                      <><Eye className="h-3 w-3" /> View</>
                                    )}
                                  </span>
                                </div>
                                <div className="flex gap-2">
                                  <Button
                                    onClick={() => respondMutation.mutate({ invitationId: inv.id, action: "accept" })}
                                    disabled={respondMutation.isPending}
                                    className="flex-1 h-9 gap-2 rounded-xl font-semibold shadow-sm"
                                  >
                                    <Check className="h-4 w-4" />
                                    Accept
                                  </Button>
                                  <Button
                                    variant="outline"
                                    onClick={() => respondMutation.mutate({ invitationId: inv.id, action: "reject" })}
                                    disabled={respondMutation.isPending}
                                    className="flex-1 h-9 gap-2 rounded-xl font-semibold"
                                  >
                                    <X className="h-4 w-4" />
                                    Decline
                                  </Button>
                                </div>
                              </motion.div>
                            ))}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        {/* Shared Folders Grid */}
        {sharedQuery.isLoading ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <div className="text-center">
              <Loader2 className="mx-auto mb-4 h-8 w-8 animate-spin text-accent" />
              <p className="text-sm text-muted-foreground">Loading shared folders...</p>
            </div>
          </div>
        ) : shared.length === 0 ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-muted/50 to-muted/20 ring-1 ring-border/40">
                <FolderOpen className="h-12 w-12 text-muted-foreground/30" />
              </div>
              <h3 className="mb-2 text-lg font-bold text-foreground/80">No shared folders yet</h3>
              <p className="text-sm text-muted-foreground">
                Accept invitations to see shared folders here.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shared.map((item, i) => (
              <motion.a
                key={item.memberId}
                href={`/shared-with-me/${item.folderId}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.3 }}
                className={cn(
                  "group relative block overflow-hidden rounded-3xl border border-border/60 bg-card p-6 shadow-lg transition-all duration-300 hover:border-accent/40 hover:shadow-2xl hover:shadow-accent/5 hover:-translate-y-1"
                )}
              >
                {/* Decorative gradient */}
                <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-accent/10 to-transparent opacity-0 blur-3xl transition-opacity group-hover:opacity-100" />

                <div className="relative">
                  <div className="mb-5 flex items-start gap-4">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 shadow-md ring-1 ring-accent/20 transition-all group-hover:scale-110 group-hover:shadow-lg group-hover:shadow-accent/20">
                      <Folder className="h-7 w-7 text-accent" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="mb-2 truncate text-base font-bold text-foreground transition-colors group-hover:text-accent">
                        {item.folderName}
                      </h3>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ring-1",
                          item.role === "edit"
                            ? "bg-accent/15 text-accent ring-accent/30"
                            : "bg-muted/80 text-muted-foreground ring-border/40"
                        )}
                      >
                        {item.role === "edit" ? (
                          <><Pencil className="h-3 w-3" /> Can Edit</>
                        ) : (
                          <><Eye className="h-3 w-3" /> View Only</>
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2.5 text-xs">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Users className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        <span className="text-foreground/50">Owner:</span>{" "}
                        <span className="font-semibold text-foreground/80">{item.ownerUsername}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Clock className="h-3.5 w-3.5 shrink-0" />
                      <span>Shared {formatDate(item.sharedAt, "short")}</span>
                    </div>
                  </div>
                </div>
              </motion.a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
