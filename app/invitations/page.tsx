"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { apiFetch } from "@/lib/api/client";
import { cn, formatDate } from "@/lib/utils";
import { Mail, Check, X, Loader2, Eye, Pencil, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Invitation {
  id: string;
  folderId: string;
  folderName: string;
  role: "view" | "edit";
  invitedByUsername: string;
  createdAt: string;
}

interface ApiResponse {
  invitations: Invitation[];
}

export default function InvitationsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["invitations"],
    queryFn: async () => {
      const res = await apiFetch<ApiResponse>("/api/invitations");
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

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <Mail className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Could not load invitations.</p>
        <button
          onClick={() => void refetch()}
          disabled={isFetching}
          className="text-sm text-accent underline underline-offset-2 hover:opacity-80"
        >
          Try again
        </button>
      </div>
    );
  }

  const invitations = data?.invitations ?? [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10">
            <Mail className="h-4 w-4 text-accent" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Folder Invitations</h1>
        </div>
        <p className="text-sm text-muted-foreground ml-12">
          Pending invitations from other users.
        </p>
      </header>

      {invitations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-border/40 bg-gradient-to-br from-surface to-muted/30">
            <Mail className="h-9 w-9 text-muted-foreground/20" />
          </div>
          <div>
            <p className="font-medium text-foreground/80">No pending invitations</p>
            <p className="mt-1 text-sm text-muted-foreground">
              When someone invites you to a folder, it will appear here.
            </p>
          </div>
        </div>
      ) : (
        <ul className="grid gap-3">
          {invitations.map((inv, i) => (
            <motion.li
              key={inv.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04, duration: 0.22 }}
            >
              <div
                className={cn(
                  "flex items-start gap-4 rounded-2xl border border-border/50 p-4",
                  "bg-surface"
                )}
              >
                <div className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/20 to-accent/5">
                  <FolderOpen className="h-6 w-6 text-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2 mb-1">
                    <p className="font-medium text-foreground/90">
                      {inv.folderName}
                    </p>
                    <span
                      className={cn(
                        "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold",
                        inv.role === "edit"
                          ? "bg-accent/10 text-accent"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {inv.role === "edit" ? (
                        <><Pencil className="h-3 w-3" /> Edit</>
                      ) : (
                        <><Eye className="h-3 w-3" /> View</>
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Invited by <span className="font-medium">{inv.invitedByUsername}</span> · {formatDate(inv.createdAt, "short")}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => respondMutation.mutate({ invitationId: inv.id, action: "accept" })}
                      disabled={respondMutation.isPending}
                      className="h-8 gap-1.5 px-3"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => respondMutation.mutate({ invitationId: inv.id, action: "reject" })}
                      disabled={respondMutation.isPending}
                      className="h-8 gap-1.5 px-3 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                      Decline
                    </Button>
                  </div>
                </div>
              </div>
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}
