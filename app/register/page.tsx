"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Cloud, Loader2, Eye, EyeOff, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { APP_NAME } from "@/lib/app-version";
import { getPasswordPolicyRules } from "@/lib/security/password-policy";

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
      setError("Username may only contain letters, numbers, dot, underscore, and hyphen (no spaces)");
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError("Please enter a valid email address");
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch<{ email?: string }>("/api/auth/register-email", {
        method: "POST",
        body: JSON.stringify({ username, email: email.trim().toLowerCase(), password }),
      });
      if (!res.success) {
        setError(res.error ?? "Registration failed");
        return;
      }
      router.push(`/verify-email?email=${encodeURIComponent(email.trim().toLowerCase())}`);
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!enabled) return null;

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full max-w-md px-4"
      >
        <div className="rounded-2xl border border-border/60 bg-surface/70 px-8 py-10 shadow-xl backdrop-blur-2xl">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent shadow-lg shadow-accent/20">
              <Cloud className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-gradient">Create account</h1>
            <p className="mt-2 text-sm text-muted-foreground/80">Join {APP_NAME}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Username</label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                minLength={3}
                className="h-11"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Letters, numbers, dot, underscore, hyphen. No spaces.
              </p>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Email Address
              </label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="h-11"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                We&apos;ll send a 6-digit code here to verify your account.
              </p>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={10}
                  className="h-11 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                {getPasswordPolicyRules().map((r) => (
                  <li key={r}>• {r}</li>
                ))}
              </ul>
            </div>

            {error && (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>
            )}

            <Button type="submit" className="h-11 w-full" disabled={loading || !username || !email || !password}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : "Continue"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-accent hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
