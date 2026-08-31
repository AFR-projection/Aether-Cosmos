"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Eye, EyeOff, Check, Loader2, Copy } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { useRouter } from "next/navigation";
import {
  validatePasswordStrength,
  getPasswordStrengthColor,
  PASSWORD_MIN_LENGTH,
} from "@/shared/lib/security/password-policy";
import {
  apiErrorMessage,
  passwordStrengthKey,
  useFormat,
  useT,
  type Translator,
} from "@/shared/lib/i18n";

/**
 * Account security sections (change password + TOTP 2FA), shared between the
 * user Settings page and the master's admin panel so both use the exact same
 * flow instead of duplicating it.
 */

/**
 * The password policy, rendered from the dictionary rather than from
 * `getPasswordPolicyRules()` so the list reads in the viewer's language. The
 * English values are copied from that helper verbatim; it stays the source for
 * server responses and tests.
 */
function passwordRules(t: Translator): string[] {
  return [
    t("auth.passwordRule.minLength", { min: PASSWORD_MIN_LENGTH }),
    t("auth.passwordRule.mix"),
    t("auth.passwordRule.notCommon"),
  ];
}

export function PasswordSection() {
  const t = useT();
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
      if (!res.success) throw new Error(apiErrorMessage(res, t, "settings.password.failed"));
      return res.data!;
    },
    onSuccess: (data) => {
      // Our own sentence, not `data.message`: the route already decided between
      // the two outcomes and says so in `staySignedIn`, so the wording can follow
      // the viewer's language instead of arriving as English prose.
      setMessage({
        type: "success",
        text: t(data.staySignedIn ? "settings.password.updated" : "settings.password.updatedSignOut"),
      });
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
      // The validator's own sentences, which are English and carry no codes to key
      // off. The rule list above already states the same requirements in the
      // viewer's language; translating the validator is a backlog item.
      setMessage({ type: "error", text: strength.errors.join(", ") });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: t("auth.changePassword.mismatch") });
      return;
    }

    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <ul className="space-y-1 rounded-xl border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
        {passwordRules(t).map((rule) => (
          <li key={rule}>• {rule}</li>
        ))}
      </ul>
      <div className="space-y-3">
        <div className="relative">
          <Input
            type={showCurrent ? "text" : "password"}
            placeholder={t("settings.password.current")}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="pr-10"
            required
          />
          <button
            type="button"
            onClick={() => setShowCurrent(!showCurrent)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            aria-label={t(
              showCurrent ? "settings.password.hideCurrent" : "settings.password.showCurrent"
            )}
          >
            {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div className="relative">
          <Input
            type={showNew ? "text" : "password"}
            placeholder={t("auth.changePassword.new")}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="pr-10"
            required
            minLength={PASSWORD_MIN_LENGTH}
          />
          <button
            type="button"
            onClick={() => setShowNew(!showNew)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            aria-label={t(showNew ? "settings.password.hideNew" : "settings.password.showNew")}
          >
            {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div className="relative">
          <Input
            type={showConfirm ? "text" : "password"}
            placeholder={t("auth.changePassword.confirm")}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="pr-10"
            required
            minLength={PASSWORD_MIN_LENGTH}
          />
          <button
            type="button"
            onClick={() => setShowConfirm(!showConfirm)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            aria-label={t(
              showConfirm ? "settings.password.hideConfirm" : "settings.password.showConfirm"
            )}
          >
            {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {strength && (
        <p className={cn("text-xs font-medium", getPasswordStrengthColor(strength.score))}>
          {t("common.passwordStrength.summary", {
            level: t(passwordStrengthKey(strength.score)),
          })}
        </p>
      )}

      {message && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "rounded-lg px-4 py-2 text-sm",
            message.type === "success" ? "bg-emerald-500/10 text-emerald-400" : "bg-danger/10 text-danger-ink"
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
        {t("settings.password.submit")}
      </Button>
    </form>
  );
}

export function TwoFactorSection({ enabled: initiallyEnabled }: { enabled: boolean }) {
  const t = useT();
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
        setError(apiErrorMessage(res, t, "settings.twoFactor.startFailed"));
        return;
      }
      setSetup(res.data);
      setRecoveryCodes(null);
    } catch {
      setError(t("errors.connectionFailed"));
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
        setError(apiErrorMessage(res, t, "auth.authenticator.invalid"));
        return;
      }
      setRecoveryCodes(res.data.recoveryCodes);
      setEnabled(true);
      setSetup(null);
      setCode("");
      queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch {
      setError(t("errors.connectionFailed"));
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
        setError(apiErrorMessage(res, t, "settings.twoFactor.disableFailed"));
        return;
      }
      setEnabled(false);
      setPassword("");
      setCode("");
      queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch {
      setError(t("errors.connectionFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("settings.statusLabel")}{" "}
        <span className={enabled ? "text-emerald-500 font-medium" : "font-medium"}>
          {t(enabled ? "settings.twoFactor.enabled" : "settings.twoFactor.disabled")}
        </span>
      </p>

      {recoveryCodes && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-2">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            {t("settings.twoFactor.recoveryNotice")}
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
          {t("settings.twoFactor.setUp")}
        </Button>
      )}

      {setup && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("settings.twoFactor.setupHint")}</p>
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 p-3 font-mono text-sm break-all">
            {setup.secret}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={t("settings.twoFactor.copySecret")}
              onClick={() => navigator.clipboard.writeText(setup.secret)}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <a
            href={setup.otpauthUrl}
            className="block text-xs text-accent-ink hover:underline break-all"
          >
            {t("settings.twoFactor.openLink")}
          </a>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("settings.twoFactor.codePlaceholder")}
            className="font-mono tracking-widest"
          />
          <Button onClick={confirmSetup} disabled={loading || code.length < 6}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {t("settings.twoFactor.confirmEnable")}
          </Button>
        </div>
      )}

      {enabled && (
        <div className="space-y-3 border-t border-border/40 pt-4">
          <p className="text-sm font-medium">{t("settings.twoFactor.disable")}</p>
          <Input
            type="password"
            placeholder={t("settings.accountPassword")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Input
            placeholder={t("settings.twoFactor.currentCode")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="font-mono"
          />
          <Button variant="destructive" onClick={disable} disabled={loading || !password}>
            {t("settings.twoFactor.disable")}
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
  /** Already resolved by the caller — each field names a different code. */
  placeholder: string;
  autoFocus?: boolean;
}) {
  const t = useT();
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
        aria-label={t(reveal ? "settings.stepCode.hideCode" : "settings.stepCode.showCode")}
      >
        {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

export function StepCodeSection() {
  const t = useT();
  const { formatDate } = useFormat();
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
        length: number | null;
        updatedAt: string | null;
        mustChange: boolean;
        required: boolean;
      }>("/api/auth/step-code");
      if (!res.success) throw new Error(apiErrorMessage(res, t, "settings.stepCode.loadFailed"));
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
      if (!res.success) throw new Error(apiErrorMessage(res, t, "settings.stepCode.saveFailed"));
      // Which of the two outcomes it was, decided here rather than read back from
      // `res.data.message`: the route branches on exactly this, and saying it
      // ourselves keeps the confirmation in the viewer's language.
      return { existed: !!status?.enabled };
    },
    onSuccess: ({ existed }) => {
      setMessage({
        type: "success",
        text: t(existed ? "settings.stepCode.updated" : "settings.stepCode.saved"),
      });
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
      if (!res.success) throw new Error(apiErrorMessage(res, t, "settings.stepCode.removeFailed"));
      return res.data!;
    },
    onSuccess: () => {
      setMessage({ type: "success", text: t("settings.stepCode.removed") });
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
      setMessage({ type: "error", text: t("auth.setup.mismatch") });
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
        <span className="text-muted-foreground">{t("settings.statusLabel")}</span>
        <span className={cn("font-medium", status?.enabled ? "text-emerald-500" : "")}>
          {t(status?.enabled ? "settings.stepCode.active" : "settings.notSet")}
        </span>
        {status?.enabled && !!status.length && (
          // Stated here because the sign-in numpad now draws exactly this many
          // slots — the two screens should agree on the number.
          <span className="rounded-md bg-muted/40 px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {t("settings.stepCode.digitCount", { count: status.length })}
          </span>
        )}
        {status?.required && (
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            {t("settings.stepCode.requiredByAdmin")}
          </span>
        )}
        {status?.mustChange && (
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            {t("settings.stepCode.mustChange")}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t("settings.stepCode.hint")}</p>

      {status?.updatedAt && (
        <p className="text-xs text-muted-foreground/70">
          {t("settings.stepCode.lastChanged", { date: formatDate(status.updatedAt) })}
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
              : "bg-danger/10 text-danger-ink"
          )}
        >
          {message.type === "success" && <Check className="mb-0.5 mr-1.5 inline h-3.5 w-3.5" />}
          {message.text}
        </motion.div>
      )}

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { setMode("edit"); setMessage(null); }}>
            {t(status?.enabled ? "settings.stepCode.change" : "settings.stepCode.set")}
          </Button>
          {status?.enabled && !status.required && (
            <Button
              variant="ghost"
              onClick={() => { setMode("remove"); setMessage(null); }}
            >
              {t("common.remove")}
            </Button>
          )}
        </div>
      )}

      {mode === "edit" && (
        <form onSubmit={handleSave} className="space-y-3">
          <ul className="space-y-1 rounded-xl border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
            {/* The policy as the enrolment screen states it, rather than the English
                `rules` array the status route returns — same requirements, in the
                viewer's language, and impossible for the two screens to disagree. */}
            {[
              t("auth.setup.ruleDigits", { min: STEP_CODE_MIN, max: STEP_CODE_MAX }),
              t("auth.setup.ruleAvoid"),
            ].map((rule) => (
              <li key={rule}>• {rule}</li>
            ))}
          </ul>

          <Input
            type="password"
            placeholder={t("settings.accountPassword")}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {status?.enabled && (
            <CodeInput
              value={currentCode}
              onChange={setCurrentCode}
              placeholder={t("settings.stepCode.currentCode")}
            />
          )}
          <CodeInput
            value={newCode}
            onChange={setNewCode}
            placeholder={t("settings.stepCode.newCodePlaceholder", {
              min: STEP_CODE_MIN,
              max: STEP_CODE_MAX,
            })}
          />
          <CodeInput
            value={confirmCode}
            onChange={setConfirmCode}
            placeholder={t("settings.stepCode.confirmCode")}
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
              {t(status?.enabled ? "settings.stepCode.update" : "settings.stepCode.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      )}

      {mode === "remove" && (
        <div className="space-y-3 rounded-xl border border-danger/25 bg-danger/[0.04] p-4">
          <p className="text-sm font-medium text-danger-ink">
            {t("settings.stepCode.removeTitle")}
          </p>
          <p className="text-xs text-muted-foreground">{t("settings.stepCode.removeNote")}</p>
          <Input
            type="password"
            placeholder={t("settings.accountPassword")}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <CodeInput
            value={currentCode}
            onChange={setCurrentCode}
            placeholder={t("settings.stepCode.currentCode")}
          />
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={() => { setMessage(null); removeMutation.mutate(); }}
              disabled={pending || !password || currentCode.length < STEP_CODE_MIN}
            >
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("settings.stepCode.removeSubmit")}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={pending}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
