"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { KeyRound, Loader2, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import {
  validatePasswordStrength,
  getPasswordStrengthLabel,
  getPasswordStrengthColor,
  getPasswordPolicyRules,
} from "@/lib/security/password-policy";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/app-version";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const strength = newPassword ? validatePasswordStrength(newPassword) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (strength && !strength.valid) {
      setError(strength.errors.join(", "));
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<{ staySignedIn?: boolean }>("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({
          currentPassword: currentPassword || undefined,
          newPassword,
          forceReset: true,
        }),
      });
      if (!res.success) {
        setError(res.error ?? "Failed to update password");
        return;
      }
      router.push(res.data?.staySignedIn ? "/dashboard" : "/login");
      router.refresh();
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-2xl border border-border/60 bg-surface/80 p-8 shadow-xl backdrop-blur-xl"
      >
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent-ink">
            <KeyRound className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold">Change your password</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            An administrator requires you to set a new password before continuing.
          </p>
        </div>

        <ul className="mb-5 space-y-1 rounded-xl border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
          {getPasswordPolicyRules().map((rule) => (
            <li key={rule}>• {rule}</li>
          ))}
        </ul>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Current password (if known)</label>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              className="h-11"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">New password</label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              className="h-11"
            />
            {strength && (
              <p className={cn("mt-1.5 text-xs font-medium", getPasswordStrengthColor(strength.score))}>
                Strength: {getPasswordStrengthLabel(strength.score)}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Confirm new password</label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              className="h-11"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>
          )}

          <Button type="submit" className="h-11 w-full" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update password"}
          </Button>
        </form>

        <p className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Cloud className="h-3.5 w-3.5" /> {APP_NAME}
        </p>
      </motion.div>
    </div>
  );
}
