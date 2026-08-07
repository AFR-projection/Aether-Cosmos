"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Eye, EyeOff, Check, Loader2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import {
  validatePasswordStrength,
  getPasswordStrengthLabel,
  getPasswordStrengthColor,
  getPasswordPolicyRules,
} from "@/lib/security/password-policy";

/**
 * Account security sections (change password + TOTP 2FA), shared between the
 * user Settings page and the master's admin panel so both use the exact same
 * flow instead of duplicating it.
 */

export function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const router = useRouter();
  const strength = newPassword ? validatePasswordStrength(newPassword) : null;

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ message: string; staySignedIn?: boolean }>("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.success) throw new Error(res.error ?? "Failed to change password");
      return res.data!;
    },
    onSuccess: (data) => {
      setMessage({ type: "success", text: data.message });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      if (!data.staySignedIn) {
        setTimeout(() => {
          router.push("/login");
        }, 3000);
      }
    },
    onError: (err: Error) => {
      setMessage({ type: "error", text: err.message });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    if (strength && !strength.valid) {
      setMessage({ type: "error", text: strength.errors.join(", ") });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: "Passwords do not match" });
      return;
    }

    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <ul className="space-y-1 rounded-xl border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
        {getPasswordPolicyRules().map((rule) => (
          <li key={rule}>• {rule}</li>
        ))}
      </ul>
      <div className="space-y-3">
        <div className="relative">
          <Input
            type={showCurrent ? "text" : "password"}
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="pr-10"
            required
          />
          <button
            type="button"
            onClick={() => setShowCurrent(!showCurrent)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            aria-label={showCurrent ? "Hide current password" : "Show current password"}
          >
            {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div className="relative">
          <Input
            type={showNew ? "text" : "password"}
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="pr-10"
            required
            minLength={10}
          />
          <button
            type="button"
            onClick={() => setShowNew(!showNew)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            aria-label={showNew ? "Hide new password" : "Show new password"}
          >
            {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div className="relative">
          <Input
            type={showConfirm ? "text" : "password"}
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="pr-10"
            required
            minLength={10}
          />
          <button
            type="button"
            onClick={() => setShowConfirm(!showConfirm)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            aria-label={showConfirm ? "Hide confirm password" : "Show confirm password"}
          >
            {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {strength && (
        <p className={cn("text-xs font-medium", getPasswordStrengthColor(strength.score))}>
          Strength: {getPasswordStrengthLabel(strength.score)}
        </p>
      )}

      {message && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "rounded-lg px-4 py-2 text-sm",
            message.type === "success" ? "bg-emerald-500/10 text-emerald-400" : "bg-danger/10 text-danger"
          )}
        >
          {message.type === "success" && <Check className="mb-0.5 mr-1.5 inline h-3.5 w-3.5" />}
          {message.text}
        </motion.div>
      )}

      <Button
        type="submit"
        disabled={mutation.isPending || !currentPassword || !newPassword || !confirmPassword}
        className="w-full"
      >
        {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Change Password
      </Button>
    </form>
  );
}

export function TwoFactorSection({ enabled: initiallyEnabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function startSetup() {
    setError("");
    setLoading(true);
    try {
      const res = await apiFetch<{ secret: string; otpauthUrl: string }>("/api/auth/2fa", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!res.success || !res.data) {
        setError(res.error ?? "Failed to start setup");
        return;
      }
      setSetup(res.data);
      setRecoveryCodes(null);
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  async function confirmSetup() {
    setError("");
    setLoading(true);
    try {
      const res = await apiFetch<{ recoveryCodes: string[] }>("/api/auth/2fa", {
        method: "PUT",
        body: JSON.stringify({ code }),
      });
      if (!res.success || !res.data) {
        setError(res.error ?? "Invalid code");
        return;
      }
      setRecoveryCodes(res.data.recoveryCodes);
      setEnabled(true);
      setSetup(null);
      setCode("");
      queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  async function disable() {
    setError("");
    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/2fa", {
        method: "DELETE",
        body: JSON.stringify({ password, code: code || undefined }),
      });
      if (!res.success) {
        setError(res.error ?? "Failed to disable");
        return;
      }
      setEnabled(false);
      setPassword("");
      setCode("");
      queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Status:{" "}
        <span className={enabled ? "text-emerald-500 font-medium" : "font-medium"}>
          {enabled ? "Enabled" : "Disabled"}
        </span>
      </p>

      {recoveryCodes && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-2">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            Save these recovery codes now — they won&apos;t be shown again.
          </p>
          <div className="grid grid-cols-2 gap-1 font-mono text-xs">
            {recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </div>
      )}

      {!enabled && !setup && (
        <Button onClick={startSetup} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Set up authenticator
        </Button>
      )}

      {setup && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Add this account in Google Authenticator / Authy using the secret below, then enter a code.
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 p-3 font-mono text-sm break-all">
            {setup.secret}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => navigator.clipboard.writeText(setup.secret)}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <a
            href={setup.otpauthUrl}
            className="block text-xs text-accent hover:underline break-all"
          >
            Open otpauth link
          </a>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            className="font-mono tracking-widest"
          />
          <Button onClick={confirmSetup} disabled={loading || code.length < 6}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Confirm & enable
          </Button>
        </div>
      )}

      {enabled && (
        <div className="space-y-3 border-t border-border/40 pt-4">
          <p className="text-sm font-medium">Disable 2FA</p>
          <Input
            type="password"
            placeholder="Account password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Input
            placeholder="Current authenticator code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="font-mono"
          />
          <Button variant="destructive" onClick={disable} disabled={loading || !password}>
            Disable 2FA
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}

// ─── 2-Step Code ──────────────────────────────────────────────────────────────

const STEP_CODE_MIN = 6;
const STEP_CODE_MAX = 10;

/** Digits-only field for entering a 2-Step Code, with a reveal toggle. */
function CodeInput({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative">
      <Input
        type={reveal ? "text" : "password"}
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        maxLength={STEP_CODE_MAX}
        // Strip non-digits on the way in so the field can never hold a value
        // the server will reject.
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        className="pr-10 font-mono tracking-[0.3em]"
      />
      <button
        type="button"
        onClick={() => setReveal(!reveal)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
        aria-label={reveal ? "Hide code" : "Show code"}
      >
        {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

export function StepCodeSection() {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [currentCode, setCurrentCode] = useState("");
  const [newCode, setNewCode] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [mode, setMode] = useState<"idle" | "edit" | "remove">("idle");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(
    null
  );

  const statusQuery = useQuery({
    queryKey: ["step-code"],
    queryFn: async () => {
      const res = await apiFetch<{
        enabled: boolean;
        updatedAt: string | null;
        mustChange: boolean;
        required: boolean;
        rules: string[];
      }>("/api/auth/step-code");
      if (!res.success) throw new Error(res.error ?? "Failed to load status");
      return res.data!;
    },
  });

  function reset() {
    setPassword("");
    setCurrentCode("");
    setNewCode("");
    setConfirmCode("");
    setMode("idle");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ message: string }>("/api/auth/step-code", {
        method: "PUT",
        body: JSON.stringify({
          password,
          currentCode: status?.enabled ? currentCode : undefined,
          newCode,
        }),
      });
      if (!res.success) throw new Error(res.error ?? "Failed to save code");
      return res.data!;
    },
    onSuccess: (data) => {
      setMessage({ type: "success", text: data.message });
      reset();
      statusQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (err: Error) => setMessage({ type: "error", text: err.message }),
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<{ message: string }>("/api/auth/step-code", {
        method: "DELETE",
        body: JSON.stringify({ password, currentCode }),
      });
      if (!res.success) throw new Error(res.error ?? "Failed to remove code");
      return res.data!;
    },
    onSuccess: (data) => {
      setMessage({ type: "success", text: data.message });
      reset();
      statusQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (err: Error) => setMessage({ type: "error", text: err.message }),
  });

  const status = statusQuery.data;
  const pending = saveMutation.isPending || removeMutation.isPending;

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (newCode !== confirmCode) {
      setMessage({ type: "error", text: "Codes do not match" });
      return;
    }
    saveMutation.mutate();
  }

  if (statusQuery.isLoading) {
    return <div className="h-20 skeleton rounded-xl" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Status:</span>
        <span className={cn("font-medium", status?.enabled ? "text-emerald-500" : "")}>
          {status?.enabled ? "Active" : "Not set"}
        </span>
        {status?.required && (
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            Required by admin
          </span>
        )}
        {status?.mustChange && (
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            Must be changed
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Entered on a numpad after your password, before your authenticator code.
      </p>

      {status?.updatedAt && (
        <p className="text-xs text-muted-foreground/70">
          Last changed {new Date(status.updatedAt).toLocaleDateString()}
        </p>
      )}

      {message && (
        <motion.div
          role="alert"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "rounded-lg px-4 py-2 text-sm",
            message.type === "success"
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-danger/10 text-danger"
          )}
        >
          {message.type === "success" && <Check className="mb-0.5 mr-1.5 inline h-3.5 w-3.5" />}
          {message.text}
        </motion.div>
      )}

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { setMode("edit"); setMessage(null); }}>
            {status?.enabled ? "Change 2-Step Code" : "Set 2-Step Code"}
          </Button>
          {status?.enabled && !status.required && (
            <Button
              variant="ghost"
              onClick={() => { setMode("remove"); setMessage(null); }}
            >
              Remove
            </Button>
          )}
        </div>
      )}

      {mode === "edit" && (
        <form onSubmit={handleSave} className="space-y-3">
          <ul className="space-y-1 rounded-xl border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
            {(status?.rules ?? []).map((rule) => (
              <li key={rule}>• {rule}</li>
            ))}
          </ul>

          <Input
            type="password"
            placeholder="Account password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {status?.enabled && (
            <CodeInput
              value={currentCode}
              onChange={setCurrentCode}
              placeholder="Current 2-Step Code"
            />
          )}
          <CodeInput
            value={newCode}
            onChange={setNewCode}
            placeholder={`New code (${STEP_CODE_MIN}-${STEP_CODE_MAX} digits)`}
          />
          <CodeInput
            value={confirmCode}
            onChange={setConfirmCode}
            placeholder="Confirm new code"
          />

          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                pending ||
                !password ||
                newCode.length < STEP_CODE_MIN ||
                !confirmCode ||
                (status?.enabled && !currentCode)
              }
            >
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {status?.enabled ? "Update code" : "Set code"}
            </Button>
            <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {mode === "remove" && (
        <div className="space-y-3 rounded-xl border border-danger/25 bg-danger/[0.04] p-4">
          <p className="text-sm font-medium text-danger">Remove your 2-Step Code?</p>
          <p className="text-xs text-muted-foreground">
            Sign-in will drop back to password and authenticator only.
          </p>
          <Input
            type="password"
            placeholder="Account password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <CodeInput
            value={currentCode}
            onChange={setCurrentCode}
            placeholder="Current 2-Step Code"
          />
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={() => { setMessage(null); removeMutation.mutate(); }}
              disabled={pending || !password || currentCode.length < STEP_CODE_MIN}
            >
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Remove code
            </Button>
            <Button variant="ghost" onClick={reset} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
