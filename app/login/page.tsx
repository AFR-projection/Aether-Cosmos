"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, UserRound } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { useSecurityAlertFromStorage } from "@/components/auth/security-alert";
import { AuthError, AuthHint, AuthShell } from "@/components/auth/auth-shell";

interface LoginResponse {
  user?: { role?: string };
  requiresStepCode?: boolean;
  stepCodeEnrollment?: boolean;
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("registration") === "disabled") {
      window.setTimeout(() => setError("Public registration is currently disabled"), 0);
    }
    apiFetch<{ enabled: boolean }>("/api/auth/register").then((res) => {
      if (res.success && res.data?.enabled) setRegistrationEnabled(true);
    });
    sessionStorage.removeItem("auth_step_token");
    sessionStorage.removeItem("auth_step_enrollment");
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
        setError(res.error ?? "Sign-in failed");
        return;
      }

      const data = res.data;

      if (data?.requiresStepCode && data.stepToken) {
        sessionStorage.setItem("auth_step_token", data.stepToken);
        sessionStorage.setItem("auth_step_enrollment", data.stepCodeEnrollment ? "1" : "0");
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
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      step="password"
      icon={<KeyRound />}
      title="Welcome back"
      description="Sign in to open your private workspace."
      visualKicker="STORAGE / CONTROLLED ACCESS"
      visualTitle={<>Your files.<br /><em>In their right place.</em></>}
      visualDescription="A quiet, dependable home for the things you need to keep close — with every layer of access made deliberate."
      securityAlert={securityAlert}
      onDismissSecurityAlert={dismissSecurityAlert}
      footer={
        <span>
          <span className="auth-main__footer-dot" aria-hidden="true" />
          Your space stays yours
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
              <span>Username or email</span>
              <span className="auth-label__hint">Required</span>
            </label>
            <div className="auth-control">
              <UserRound aria-hidden="true" />
              <input
                id="identifier"
                className="auth-input"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@example.com"
                autoComplete="username"
                autoCapitalize="none"
                required
              />
            </div>
          </div>

          <div className="auth-field">
            <label htmlFor="password" className="auth-label">
              <span>Password</span>
              <span className="auth-label__hint">Required</span>
            </label>
            <div className="auth-control">
              <KeyRound aria-hidden="true" />
              <input
                id="password"
                className="auth-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                className="auth-password-toggle"
                aria-label={showPassword ? "Hide password" : "Show password"}
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
                <span>Checking access…</span>
                <span className="sr-only">Signing you in</span>
              </>
            ) : (
              <>
                <span>Continue to workspace</span>
                <ArrowRight aria-hidden="true" />
              </>
            )}
          </button>

          {registrationEnabled ? (
            <p className="auth-form__footer">
              New to Storage ByAFR?{" "}
              <Link href="/register">Create an account</Link>
            </p>
          ) : (
            <AuthHint>Access is invitation-only for this workspace.</AuthHint>
          )}
        </form>
      </motion.div>
    </AuthShell>
  );
}
