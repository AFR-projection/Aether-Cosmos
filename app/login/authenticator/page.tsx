"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, KeyRound, Loader2, RotateCcw, ShieldCheck, Smartphone } from "lucide-react";
import { apiFetch } from "@/shared/api/client";
import { AuthError, AuthShell } from "@auth/presentation/components/auth-shell";
import { apiErrorMessage, useT } from "@/shared/lib/i18n";

interface LoginResponse {
  user?: { role?: string };
  mustChangePassword?: boolean;
  newDevice?: boolean;
}

export default function AuthenticatorPage() {
  const router = useRouter();
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const t = useT();

  useEffect(() => {
    const token = sessionStorage.getItem("auth_pending_token");
    if (!token) {
      router.replace("/login");
      return;
    }
    const setupFrame = window.setTimeout(() => setPendingToken(token), 0);
    return () => window.clearTimeout(setupFrame);
  }, [router]);

  useEffect(() => {
    if (!useRecovery) {
      window.setTimeout(() => inputRefs.current[0]?.focus(), 100);
    }
  }, [useRecovery]);

  function handleDigitChange(index: number, value: string) {
    if (loading || !/^\d*$/.test(value)) return;
    const nextValue = value.slice(-1);
    const nextDigits = [...digits];
    nextDigits[index] = nextValue;
    setDigits(nextDigits);
    if (error) setError("");
    if (nextValue && index < 5) inputRefs.current[index + 1]?.focus();
    if (nextDigits.every((digit) => digit !== "")) void submitCode(nextDigits.join(""));
  }

  function handleDigitKeyDown(index: number, event: React.KeyboardEvent) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    if (event.key === "ArrowLeft" && index > 0) inputRefs.current[index - 1]?.focus();
    if (event.key === "ArrowRight" && index < 5) inputRefs.current[index + 1]?.focus();
  }

  function handleDigitPaste(event: React.ClipboardEvent) {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted || loading) return;
    const nextDigits = ["", "", "", "", "", ""];
    for (let i = 0; i < 6; i += 1) nextDigits[i] = pasted[i] ?? "";
    setDigits(nextDigits);
    if (error) setError("");
    inputRefs.current[Math.min(pasted.length, 5)]?.focus();
    if (pasted.length === 6) void submitCode(pasted);
  }

  async function submitCode(code?: string) {
    if (!pendingToken || loading) return;
    const totpCode = code ?? digits.join("");
    if (!useRecovery && totpCode.length < 6) return;
    if (useRecovery && !recoveryCode.trim()) return;

    setError("");
    setLoading(true);

    try {
      const body = useRecovery
        ? { pendingToken, recoveryCode: recoveryCode.trim() }
        : { pendingToken, totpCode };
      const res = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!res.success) {
        setShake(true);
        window.setTimeout(() => setShake(false), 500);
        setError(apiErrorMessage(res, t, "auth.authenticator.invalid"));
        if (!useRecovery) {
          setDigits(["", "", "", "", "", ""]);
          window.setTimeout(() => inputRefs.current[0]?.focus(), 50);
        }
        // Keyed off the stable code, not the message text: the staged token is
        // gone, so the only way forward is a fresh sign-in.
        if (res.code === "2FA_EXPIRED") {
          window.setTimeout(() => router.replace("/login"), 1200);
        }
        return;
      }

      const data = res.data;
      sessionStorage.removeItem("auth_pending_token");

      if (data?.newDevice) {
        try {
          sessionStorage.setItem("new_login_notice", "1");
        } catch {
          // The notice is optional and never blocks a successful login.
        }
      }
      if (data?.mustChangePassword) {
        router.push("/change-password");
        router.refresh();
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      const home = data?.user?.role === "master" ? "/admin" : "/dashboard";
      router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : home);
      router.refresh();
    } catch {
      setError(t("errors.network"));
    } finally {
      setLoading(false);
    }
  }

  function switchMode() {
    setUseRecovery((current) => !current);
    setDigits(["", "", "", "", "", ""]);
    setRecoveryCode("");
    setError("");
  }

  if (!pendingToken) return null;

  return (
    <AuthShell
      step="authenticator"
      icon={useRecovery ? <KeyRound /> : <Smartphone />}
      title={useRecovery ? t("auth.authenticator.recoveryTitle") : t("auth.stepAuthenticator")}
      description={
        useRecovery
          ? t("auth.authenticator.recoveryDescription")
          : t("auth.authenticator.description")
      }
      visualKicker={t("auth.authenticator.visualKicker")}
      visualTitle={
        <>
          {t("auth.authenticator.visualTitleTop")}
          <br />
          <em>{t("auth.authenticator.visualTitleEm")}</em>
        </>
      }
      visualDescription={t("auth.authenticator.visualDescription")}
    >
      <AnimatePresence mode="wait">
        {!useRecovery ? (
          <motion.div
            key="authenticator-code"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
            transition={{ duration: 0.22 }}
          >
            <div
              className={shake ? "auth-otp-grid auth-otp-grid--error" : "auth-otp-grid"}
              role="group"
              aria-label={t("auth.authenticator.gridLabel")}
              onPaste={handleDigitPaste}
            >
              {digits.map((digit, index) => (
                <input
                  key={index}
                  ref={(element) => { inputRefs.current[index] = element; }}
                  type="text"
                  inputMode="numeric"
                  autoComplete={index === 0 ? "one-time-code" : "off"}
                  maxLength={1}
                  value={digit}
                  onChange={(event) => handleDigitChange(index, event.target.value)}
                  onKeyDown={(event) => handleDigitKeyDown(index, event)}
                  disabled={loading}
                  aria-label={t("auth.authenticator.digitLabel", { index: index + 1 })}
                  aria-invalid={Boolean(error)}
                  className={[
                    "auth-otp-input",
                    digit ? "auth-otp-input--filled" : "",
                    error ? "auth-otp-input--error" : "",
                  ].join(" ")}
                />
              ))}
            </div>

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-3"
                >
                  <AuthError id="authenticator-error">{error}</AuthError>
                </motion.div>
              )}
            </AnimatePresence>

            <button
              type="button"
              onClick={() => void submitCode()}
              disabled={loading || digits.join("").length < 6}
              className="auth-primary-button auth-code-submit"
              aria-busy={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  <span>{t("auth.authenticator.submitting")}</span>
                </>
              ) : (
                <>
                  <ShieldCheck aria-hidden="true" />
                  <span>{t("auth.authenticator.submit")}</span>
                </>
              )}
            </button>
          </motion.div>
        ) : (
          <motion.form
            key="recovery-code"
            onSubmit={(event) => { event.preventDefault(); void submitCode(); }}
            className="auth-form"
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.22 }}
          >
            <div className="auth-field">
              <label htmlFor="recovery-code" className="auth-label">
                <span>{t("auth.authenticator.backupLabel")}</span>
                <span className="auth-label__hint">{t("auth.authenticator.backupHint")}</span>
              </label>
              <input
                id="recovery-code"
                className="auth-recovery-input"
                value={recoveryCode}
                onChange={(event) => { setRecoveryCode(event.target.value); if (error) setError(""); }}
                placeholder={t("auth.authenticator.backupPlaceholder")}
                autoComplete="off"
                autoFocus
                spellCheck={false}
                disabled={loading}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "authenticator-recovery-error" : undefined}
              />
            </div>

            {error && <AuthError id="authenticator-recovery-error">{error}</AuthError>}

            <button type="submit" disabled={loading || !recoveryCode.trim()} className="auth-primary-button" aria-busy={loading}>
              {loading ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  <span>{t("auth.authenticator.verifying")}</span>
                </>
              ) : (
                <>
                  <ShieldCheck aria-hidden="true" />
                  <span>{t("auth.authenticator.useRecovery")}</span>
                </>
              )}
            </button>
          </motion.form>
        )}
      </AnimatePresence>

      <div className="auth-secondary-actions">
        <button type="button" onClick={switchMode} className="auth-text-button">
          <RotateCcw aria-hidden="true" />
          {useRecovery
            ? t("auth.authenticator.useAuthenticator")
            : t("auth.authenticator.useRecovery")}
        </button>
        <button type="button" onClick={() => router.push("/login")} className="auth-text-button">
          <ArrowLeft aria-hidden="true" />
          {t("auth.authenticator.startOver")}
        </button>
      </div>
    </AuthShell>
  );
}
