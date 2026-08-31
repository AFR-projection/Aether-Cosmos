"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Cloud, Loader2, Eye, EyeOff, Mail } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { apiFetch } from "@/shared/api/client";
import { APP_NAME } from "@/shared/lib/app-version";
import { PASSWORD_MIN_LENGTH } from "@/shared/lib/security/password-policy";
import { apiErrorMessage, useT } from "@/shared/lib/i18n";

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [checking, setChecking] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const t = useT();

  /**
   * The same three rules `getPasswordPolicyRules()` returns for server responses
   * and tests, rendered from the dictionary instead so the screen reads in the
   * viewer's language. The English values are copied from that helper verbatim.
   */
  const passwordRules = [
    t("auth.passwordRule.minLength", { min: PASSWORD_MIN_LENGTH }),
    t("auth.passwordRule.mix"),
    t("auth.passwordRule.notCommon"),
  ];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ enabled: boolean; maintenance?: boolean }>(
        "/api/auth/register"
      );
      if (cancelled) return;
      if (res.data?.maintenance) {
        router.replace("/maintenance");
        return;
      }
      if (!res.success || !res.data?.enabled) {
        setEnabled(false);
        setChecking(false);
        router.replace("/login?registration=disabled");
        return;
      }
      setEnabled(true);
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      setError(t("auth.register.usernameInvalid"));
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError(t("auth.register.emailInvalid"));
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch<{ email?: string }>("/api/auth/register-email", {
        method: "POST",
        body: JSON.stringify({ username, email: email.trim().toLowerCase(), password }),
      });
      if (!res.success) {
        setError(apiErrorMessage(res, t, "auth.register.failed"));
        return;
      }
      router.push(`/verify-email?email=${encodeURIComponent(email.trim().toLowerCase())}`);
    } catch {
      setError(t("errors.network"));
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <main className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <Loader2 className="h-8 w-8 animate-spin text-accent-ink" aria-hidden="true" />
        <span className="sr-only">{t("common.loading")}</span>
      </main>
    );
  }

  if (!enabled) {
    return (
      <main className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <Loader2 className="h-8 w-8 animate-spin text-accent-ink" aria-hidden="true" />
        <span className="sr-only">{t("auth.login.registrationDisabled")}</span>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full max-w-md px-4"
      >
        <div className="rounded-2xl border border-border/60 bg-surface/70 px-8 py-10 shadow-xl backdrop-blur-2xl">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent shadow-lg shadow-accent/20">
              <Cloud className="h-8 w-8 text-on-accent" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-gradient">
              {t("auth.register.title")}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground/80">
              {t("auth.register.subtitle", { app: APP_NAME })}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="register-username" className="mb-1.5 block text-sm font-medium">
                {t("auth.register.username")}
              </label>
              <Input
                id="register-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                minLength={3}
                className="h-11"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("auth.register.usernameHint")}
              </p>
            </div>
            <div>
              <label htmlFor="register-email" className="mb-1.5 flex items-center gap-2 text-sm font-medium">
                <Mail className="h-4 w-4" aria-hidden="true" />
                {t("auth.register.email")}
              </label>
              <Input
                id="register-email"
                type="email"
                placeholder={t("auth.emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="h-11"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("auth.register.emailHint")}
              </p>
            </div>
            <div>
              <label htmlFor="register-password" className="mb-1.5 block text-sm font-medium">{t("auth.passwordLabel")}</label>
              <div className="relative">
                <Input
                  id="register-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  className="h-11 pr-12"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={
                    showPassword ? t("auth.login.hidePassword") : t("auth.login.showPassword")
                  }
                  className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-muted-foreground">
                {passwordRules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </div>

            {error && (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500" role="alert">{error}</p>
            )}

            <Button type="submit" className="h-11 w-full" disabled={loading || !username || !email || !password} aria-busy={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{t("auth.login.submitting")}</span>
                </>
              ) : t("auth.continue")}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t("auth.register.haveAccount")}{" "}
            <Link href="/login" className="font-medium text-accent-ink hover:underline">
              {t("auth.register.signIn")}
            </Link>
          </p>
        </div>
      </motion.div>
    </main>
  );
}
