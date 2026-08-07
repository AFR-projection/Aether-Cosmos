"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { Cloud, Loader2, Eye, EyeOff, ArrowLeft, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { Numpad } from "@/components/auth/numpad";
import {
  SecurityAlertBanner,
  useSecurityAlertFromStorage,
} from "@/components/auth/security-alert";

/**
 * Three-layer sign-in: password → 2-Step Code → authenticator.
 *
 * `stage` is driven entirely by what the server returns, never inferred locally,
 * so the client cannot advance itself past a layer the server still requires.
 */

const STEP_CODE_MIN = 6;
const STEP_CODE_MAX = 10;

type Stage = "password" | "step_code" | "step_code_enroll" | "totp";

interface LoginResponse {
  user?: { role?: string };
  requiresStepCode?: boolean;
  stepCodeEnrollment?: boolean;
  stepToken?: string;
  requires2fa?: boolean;
  pendingToken?: string;
  mustChangePassword?: boolean;
  stepCodeMustChange?: boolean;
  newDevice?: boolean;
  message?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("password");

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [stepToken, setStepToken] = useState<string | null>(null);
  const [stepCode, setStepCode] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [enrollPhase, setEnrollPhase] = useState<"choose" | "confirm">("choose");

  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const { alert: securityAlert, dismiss: dismissSecurityAlert } =
    useSecurityAlertFromStorage();

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("registration") === "disabled") {
        setError("Public registration is currently disabled");
      }
    }
    apiFetch<{ enabled: boolean }>("/api/auth/register").then((res) => {
      if (res.success && res.data?.enabled) setRegistrationEnabled(true);
    });
  }, []);

  function resetToPassword() {
    setStage("password");
    setStepToken(null);
    setPendingToken(null);
    setStepCode("");
    setConfirmCode("");
    setTotpCode("");
    setEnrollPhase("choose");
    setUseRecovery(false);
    setError("");
    setNotice("");
  }

  /** Routes a successful response to the next stage or into the app. */
  function handleResponse(data: LoginResponse | undefined) {
    if (data?.requiresStepCode && data.stepToken) {
      setStepToken(data.stepToken);
      setStepCode("");
      setConfirmCode("");
      setEnrollPhase("choose");
      setStage(data.stepCodeEnrollment ? "step_code_enroll" : "step_code");
      setNotice(data.message ?? "");
      return;
    }

    if (data?.requires2fa && data.pendingToken) {
      setPendingToken(data.pendingToken);
      setTotpCode("");
      setUseRecovery(false);
      setStage("totp");
      setNotice(data.message ?? "");
      return;
    }

    if (data?.newDevice) {
      try {
        sessionStorage.setItem("new_login_notice", "1");
      } catch {
        // storage unavailable — the in-app banner is a nicety, not a gate
      }
    }

    if (data?.mustChangePassword) {
      router.push("/change-password");
      router.refresh();
      return;
    }

    const next =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("next")
        : null;
    const home = data?.user?.role === "master" ? "/admin" : "/dashboard";
    const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : home;
    router.push(safeNext);
    router.refresh();
  }

  async function post(body: unknown, url = "/api/auth/login") {
    setError("");
    setLoading(true);
    try {
      const res = await apiFetch<LoginResponse>(url, {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!res.success) {
        setError(res.error ?? "Sign-in failed");
        // An expired staged token means the whole attempt must start over.
        if (res.error?.toLowerCase().includes("session expired")) {
          setTimeout(resetToPassword, 1200);
        }
        return;
      }

      handleResponse(res.data);
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    void post({ identifier, password });
  }

  function submitStepCode() {
    void post({ stepToken, stepCode });
  }

  function submitEnrollment() {
    if (enrollPhase === "choose") {
      setError("");
      setConfirmCode("");
      setEnrollPhase("confirm");
      return;
    }
    if (stepCode !== confirmCode) {
      setError("Codes do not match. Please re-enter.");
      setConfirmCode("");
      return;
    }
    void post(
      { stepToken, newCode: stepCode, confirmCode },
      "/api/auth/step-code/enroll"
    );
  }

  function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    void post({
      pendingToken,
      totpCode: useRecovery ? undefined : totpCode,
      recoveryCode: useRecovery ? totpCode : undefined,
    });
  }

  const heading = {
    password: "Sign in to your account",
    step_code: "Enter your 2-Step Code",
    step_code_enroll: "Create your 2-Step Code",
    totp: "Two-factor authentication",
  }[stage];

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          animate={{ x: [0, 30, 0], y: [0, -20, 0] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
          className="absolute -left-16 -top-16 h-80 w-80 rounded-full bg-accent/8 blur-3xl"
        />
        <motion.div
          animate={{ x: [0, -20, 0], y: [0, 30, 0] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
          className="absolute -right-20 top-1/3 h-96 w-96 rounded-full bg-accent/5 blur-3xl"
        />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative w-full max-w-md px-4"
      >
        <div className="relative rounded-2xl border border-border/60 bg-surface/70 px-8 py-10 shadow-xl backdrop-blur-2xl">
          <div className="pointer-events-none absolute inset-0 rounded-2xl bg-accent-gradient opacity-[0.04] blur-[2px]" />

          {securityAlert && (
            <div className="relative mb-2">
              <SecurityAlertBanner alert={securityAlert} onDismiss={dismissSecurityAlert} />
            </div>
          )}

          <div className="relative mb-8 text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.15 }}
              className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent shadow-lg shadow-accent/20"
            >
              {stage === "password" ? (
                <Cloud className="h-8 w-8 text-white" />
              ) : stage === "totp" ? (
                <ShieldCheck className="h-8 w-8 text-white" />
              ) : (
                <KeyRound className="h-8 w-8 text-white" />
              )}
            </motion.div>
            <h1 className="text-3xl font-bold tracking-tight text-gradient">Storage ByAFR</h1>
            <p className="mt-2 text-sm text-muted-foreground/80">{heading}</p>
            {stage !== "password" && <StageIndicator stage={stage} />}
          </div>

          {stage === "password" && (
            <form onSubmit={submitPassword} className="relative space-y-5">
              <div>
                <label
                  htmlFor="identifier"
                  className="mb-1.5 block text-sm font-medium text-foreground/80"
                >
                  Username / Email
                </label>
                <Input
                  id="identifier"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="Username or email"
                  autoComplete="username"
                  required
                  className="h-11"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="mb-1.5 block text-sm font-medium text-foreground/80"
                >
                  Password
                </label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    className="h-11 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 transition-colors hover:text-foreground"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && <ErrorNote>{error}</ErrorNote>}

              <Button type="submit" className="h-11 w-full text-base font-semibold" disabled={loading}>
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Sign In"}
              </Button>

              {registrationEnabled && (
                <p className="text-center text-sm text-muted-foreground">
                  Don&apos;t have an account?{" "}
                  <Link href="/register" className="font-medium text-accent hover:underline">
                    Create account
                  </Link>
                </p>
              )}
            </form>
          )}

          {stage === "step_code" && (
            <div className="relative">
              <Numpad
                value={stepCode}
                onChange={(v) => {
                  setStepCode(v);
                  if (error) setError("");
                }}
                onSubmit={submitStepCode}
                minLength={STEP_CODE_MIN}
                maxLength={STEP_CODE_MAX}
                error={!!error}
                loading={loading}
                message={error || notice}
                submitLabel="Verify"
              />
              <BackLink onClick={resetToPassword} />
            </div>
          )}

          {stage === "step_code_enroll" && (
            <div className="relative">
              <div className="mb-4 rounded-xl border border-border/50 bg-muted/20 p-3">
                <p className="text-xs font-medium text-foreground/80">
                  {enrollPhase === "choose"
                    ? "Choose a 2-Step Code"
                    : "Re-enter to confirm"}
                </p>
                <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  <li>• {STEP_CODE_MIN} to {STEP_CODE_MAX} characters, digits 0-9 only</li>
                  <li>• Avoid repeats, sequences, and dates</li>
                </ul>
              </div>
              <Numpad
                key={enrollPhase}
                value={enrollPhase === "choose" ? stepCode : confirmCode}
                onChange={(v) => {
                  if (enrollPhase === "choose") setStepCode(v);
                  else setConfirmCode(v);
                  if (error) setError("");
                }}
                onSubmit={submitEnrollment}
                minLength={STEP_CODE_MIN}
                maxLength={STEP_CODE_MAX}
                error={!!error}
                loading={loading}
                message={error || notice}
                submitLabel={enrollPhase === "choose" ? "Continue" : "Set code"}
              />
              <BackLink
                onClick={() => {
                  if (enrollPhase === "confirm") {
                    setEnrollPhase("choose");
                    setConfirmCode("");
                    setError("");
                  } else {
                    resetToPassword();
                  }
                }}
                label={enrollPhase === "confirm" ? "Change code" : "Back to sign in"}
              />
            </div>
          )}

          {stage === "totp" && (
            <form onSubmit={submitTotp} className="relative space-y-5">
              <div>
                <label htmlFor="totp" className="mb-2 block text-sm text-muted-foreground">
                  Enter the 6-digit code from your authenticator app
                  {useRecovery ? " or a recovery code" : ""}.
                </label>
                <Input
                  id="totp"
                  value={totpCode}
                  onChange={(e) => {
                    setTotpCode(e.target.value);
                    if (error) setError("");
                  }}
                  placeholder={useRecovery ? "Recovery code" : "000000"}
                  autoComplete="one-time-code"
                  inputMode={useRecovery ? "text" : "numeric"}
                  autoFocus
                  required
                  className="h-12 text-center font-mono text-lg tracking-[0.4em]"
                />
                <div className="mt-2 flex justify-between text-xs">
                  <button
                    type="button"
                    className="text-accent hover:underline"
                    onClick={() => {
                      setUseRecovery(!useRecovery);
                      setTotpCode("");
                      setError("");
                    }}
                  >
                    {useRecovery ? "Use authenticator code" : "Use recovery code"}
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:underline"
                    onClick={resetToPassword}
                  >
                    Start over
                  </button>
                </div>
              </div>

              {error && <ErrorNote>{error}</ErrorNote>}

              <Button type="submit" className="h-11 w-full text-base font-semibold" disabled={loading}>
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Verify"}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground/40">
          Secure cloud storage platform
        </p>
      </motion.div>
    </div>
  );
}

/** Shows how far through the layered sign-in the user is. */
function StageIndicator({ stage }: { stage: Stage }) {
  const index = stage === "totp" ? 2 : 1;
  const labels = ["Password", "2-Step Code", "Authenticator"];

  return (
    <div className="mt-4 flex items-center justify-center gap-2">
      {labels.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={cnStage(i, index)}
            aria-current={i === index ? "step" : undefined}
            title={label}
          />
          {i < labels.length - 1 && <span className="h-px w-4 bg-border" aria-hidden="true" />}
        </div>
      ))}
      <span className="sr-only">
        Step {index + 1} of 3: {labels[index]}
      </span>
    </div>
  );
}

function cnStage(i: number, current: number): string {
  const base = "block h-1.5 rounded-full transition-all duration-200";
  if (i < current) return `${base} w-6 bg-accent/50`;
  if (i === current) return `${base} w-8 bg-accent`;
  return `${base} w-6 bg-border`;
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <motion.p
      role="alert"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      {children}
    </motion.p>
  );
}

function BackLink({ onClick, label = "Back to sign in" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-auto mt-5 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}
