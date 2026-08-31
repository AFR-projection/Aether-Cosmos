"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, UserRound } from "lucide-react";
import { apiFetch } from "@/shared/api/client";
import { APP_NAME } from "@/shared/lib/app-version";
import { useSecurityAlertFromStorage } from "@auth/presentation/components/security-alert";
import { AuthError, AuthHint, AuthShell } from "@auth/presentation/components/auth-shell";
import { apiErrorMessage, createTranslator, getLocale, useT } from "@/shared/lib/i18n";

interface LoginResponse {
  user?: { role?: string };
  requiresStepCode?: boolean;
  stepCodeEnrollment?: boolean;
  /** Digit count of this account's 2-Step Code; null when it is not recorded. */
  stepCodeLength?: number | null;
  stepToken?: string;
  requires2fa?: boolean;
  pendingToken?: string;
  mustChangePassword?: boolean;
  newDevice?: boolean;
  message?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const { alert: securityAlert, dismiss: dismissSecurityAlert } =
    useSecurityAlertFromStorage();
  const t = useT();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("registration") === "disabled") {
      // Runs once on mount, so it reads the live locale instead of depending on `t`.
      const translate = createTranslator(getLocale());
      window.setTimeout(() => setError(translate("auth.login.registrationDisabled")), 0);
    }
    apiFetch<{ enabled: boolean }>("/api/auth/register").then((res) => {
      if (res.success && res.data?.enabled) setRegistrationEnabled(true);
    });
    sessionStorage.removeItem("auth_step_token");
    sessionStorage.removeItem("auth_step_enrollment");
    sessionStorage.removeItem("auth_step_length");
    sessionStorage.removeItem("auth_pending_token");
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password }),
      });

      if (!res.success) {
        setError(apiErrorMessage(res, t, "auth.login.failed"));
        return;
      }

      const data = res.data;

      if (data?.requiresStepCode && data.stepToken) {
        sessionStorage.setItem("auth_step_token", data.stepToken);
        sessionStorage.setItem("auth_step_enrollment", data.stepCodeEnrollment ? "1" : "0");
        // The numpad on the next screen draws this many slots. Absent for an
        // account whose length was never recorded, which keeps the flexible pad.
        if (typeof data.stepCodeLength === "number") {
          sessionStorage.setItem("auth_step_length", String(data.stepCodeLength));
        } else {
          sessionStorage.removeItem("auth_step_length");
        }
        router.push(data.stepCodeEnrollment ? "/login/step-code/setup" : "/login/step-code");
        return;
      }

      if (data?.requires2fa && data.pendingToken) {
        sessionStorage.setItem("auth_pending_token", data.pendingToken);
        router.push("/login/authenticator");
        return;
      }

      if (data?.newDevice) {
        try { sessionStorage.setItem("new_login_notice", "1"); } catch { /* ok */ }
      }

      if (data?.mustChangePassword) {
        router.push("/change-password");
        router.refresh();
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      const home = data?.user?.role === "master" ? "/admin" : "/dashboard";
      const dest = next && next.startsWith("/") && !next.startsWith("//") ? next : home;
      router.push(dest);
      router.refresh();
    } catch {
      setError(t("errors.network"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      step="password"
      icon={<KeyRound />}
      title={t("auth.login.title")}
      description={t("auth.login.description")}
      visualKicker={t("auth.login.visualKicker")}
      visualTitle={
        <>
          {t("auth.login.visualTitleTop")}
          <br />
          <em>{t("auth.login.visualTitleEm")}</em>
        </>
      }
      visualDescription={t("auth.login.visualDescription")}
      securityAlert={securityAlert}
      onDismissSecurityAlert={dismissSecurityAlert}
      footer={
        <span>
          <span className="auth-main__footer-dot" aria-hidden="true" />
          {t("auth.login.footer")}
        </span>
      }
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <form onSubmit={handleSubmit} className="auth-form" aria-describedby={error ? "login-error" : undefined}>
          <div className="auth-field">
            <label htmlFor="identifier" className="auth-label">
              <span>{t("auth.login.identifier")}</span>
              <span className="auth-label__hint">{t("auth.required")}</span>
            </label>
            <div className="auth-control">
              <UserRound aria-hidden="true" />
              <input
                id="identifier"
                className="auth-input"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={t("auth.emailPlaceholder")}
                autoComplete="username"
                autoCapitalize="none"
                required
              />
            </div>
          </div>

          <div className="auth-field">
            <label htmlFor="password" className="auth-label">
              <span>{t("auth.passwordLabel")}</span>
              <span className="auth-label__hint">{t("auth.required")}</span>
            </label>
            <div className="auth-control">
              <KeyRound aria-hidden="true" />
              <input
                id="password"
                className="auth-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("auth.login.passwordPlaceholder")}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                className="auth-password-toggle"
                aria-label={
                  showPassword ? t("auth.login.hidePassword") : t("auth.login.showPassword")
                }
              >
                {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
          </div>

          {error && <AuthError id="login-error">{error}</AuthError>}

          <button type="submit" className="auth-primary-button" disabled={loading} aria-busy={loading}>
            {loading ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                <span>{t("auth.login.submitting")}</span>
                <span className="sr-only">{t("auth.login.submittingAnnounce")}</span>
              </>
            ) : (
              <>
                <span>{t("auth.login.submit")}</span>
                <ArrowRight aria-hidden="true" />
              </>
            )}
          </button>

          {registrationEnabled ? (
            <p className="auth-form__footer">
              {t("auth.login.newTo", { app: APP_NAME })}{" "}
              <Link href="/register">{t("auth.login.createAccount")}</Link>
            </p>
          ) : (
            <AuthHint>{t("auth.login.inviteOnly")}</AuthHint>
          )}
        </form>
      </motion.div>
    </AuthShell>
  );
}
