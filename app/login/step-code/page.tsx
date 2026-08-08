"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Delete, Loader2, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { AuthError, AuthShell } from "@/components/auth/auth-shell";

const STEP_CODE_MIN = 6;
const STEP_CODE_MAX = 10;

function shuffleDigits(): number[] {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface LoginResponse {
  user?: { role?: string };
  requires2fa?: boolean;
  pendingToken?: string;
  mustChangePassword?: boolean;
  newDevice?: boolean;
}

export default function StepCodePage() {
  const router = useRouter();
  const [stepToken, setStepToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [keys, setKeys] = useState<number[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = sessionStorage.getItem("auth_step_token");
    if (!token) {
      router.replace("/login");
      return;
    }
    const setupFrame = window.setTimeout(() => {
      setStepToken(token);
      setKeys(shuffleDigits());
    }, 0);
    return () => window.clearTimeout(setupFrame);
  }, [router]);

  const pressDigit = useCallback((digit: number) => {
    if (code.length >= STEP_CODE_MAX || loading) return;
    setCode((current) => current + digit);
    setActiveKey(digit);
    window.setTimeout(() => setActiveKey(null), 120);
    if (error) setError("");
  }, [code.length, error, loading]);

  const deleteLast = useCallback(() => {
    if (loading) return;
    setCode((current) => current.slice(0, -1));
    if (error) setError("");
  }, [error, loading]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key)) {
        pressDigit(Number(event.key));
        return;
      }
      if (event.key === "Backspace") {
        deleteLast();
        return;
      }
      if (event.key === "Enter") void handleSubmit();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  async function handleSubmit() {
    if (!stepToken || code.length < STEP_CODE_MIN || loading) return;
    setError("");
    setLoading(true);

    try {
      const res = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ stepToken, stepCode: code }),
      });

      if (!res.success) {
        setShake(true);
        window.setTimeout(() => setShake(false), 600);
        setCode("");
        setError(res.error ?? "Incorrect code");
        if (res.error?.toLowerCase().includes("session expired")) {
          window.setTimeout(() => router.replace("/login"), 1200);
        }
        return;
      }

      const data = res.data;
      sessionStorage.removeItem("auth_step_token");
      sessionStorage.removeItem("auth_step_enrollment");

      if (data?.requires2fa && data.pendingToken) {
        sessionStorage.setItem("auth_pending_token", data.pendingToken);
        router.push("/login/authenticator");
        return;
      }
      if (data?.mustChangePassword) {
        router.push("/change-password");
        router.refresh();
        return;
      }
      if (data?.newDevice) {
        try {
          sessionStorage.setItem("new_login_notice", "1");
        } catch {
          // The notice is helpful, but never blocks a successful login.
        }
      }

      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      const home = data?.user?.role === "master" ? "/admin" : "/dashboard";
      router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : home);
      router.refresh();
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  const topKeys = keys.slice(0, 9);
  const bottomKey = keys[9];
  const canSubmit = code.length >= STEP_CODE_MIN && !loading;

  if (!stepToken) return null;

  return (
    <AuthShell
      step="step-code"
      icon={<ShieldCheck />}
      title="Second layer"
      description="Enter your personal security code to continue."
      visualKicker="STORAGE / SECOND SIGNAL"
      visualTitle={<>One more<br /><em>quiet signal.</em></>}
      visualDescription="A second layer keeps the path to your workspace deliberate, even when your password is known."
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <div
          className={["auth-code-display", shake ? "auth-code-display--error" : ""].join(" ")}
          aria-label={`${code.length} of ${STEP_CODE_MAX} digits entered`}
        >
          <div className="auth-code-dots" aria-hidden="true">
            {Array.from({ length: STEP_CODE_MAX }).map((_, index) => (
              <motion.span
                key={index}
                animate={index < code.length ? { scale: 1.12 } : { scale: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 20 }}
                className={[
                  "auth-code-dot",
                  index < code.length ? "auth-code-dot--filled" : "",
                  index < code.length && error ? "auth-code-dot--error" : "",
                ].join(" ")}
              />
            ))}
          </div>

          <AnimatePresence mode="wait">
            {error ? (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <AuthError id="step-code-error">{error}</AuthError>
              </motion.div>
            ) : (
              <motion.p key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="auth-code-caption">
                {STEP_CODE_MIN}–{STEP_CODE_MAX} digits · shuffled for safety
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <div className="auth-numpad" role="group" aria-label="Security code keypad">
          {topKeys.map((digit) => (
            <NumKey
              key={`k-${digit}`}
              digit={digit}
              active={activeKey === digit}
              disabled={loading}
              onPress={() => pressDigit(digit)}
            />
          ))}
          <span aria-hidden="true" />
          <NumKey
            digit={bottomKey}
            active={activeKey === bottomKey}
            disabled={loading}
            onPress={() => pressDigit(bottomKey)}
          />
          <button
            type="button"
            onClick={deleteLast}
            disabled={loading || code.length === 0}
            aria-label="Delete last digit"
            className="auth-numpad-button auth-numpad-button--muted"
          >
            <Delete aria-hidden="true" />
          </button>
        </div>

        <motion.button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          whileTap={canSubmit ? { scale: 0.985 } : {}}
          className="auth-primary-button auth-code-submit"
          aria-busy={loading}
        >
          {loading ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              <span>Verifying code…</span>
            </>
          ) : (
            <>
              <ShieldCheck aria-hidden="true" />
              <span>Verify security code</span>
            </>
          )}
        </motion.button>

        <button type="button" onClick={() => router.push("/login")} className="auth-secondary-link">
          <ArrowLeft aria-hidden="true" />
          Back to sign in
        </button>
      </motion.div>
    </AuthShell>
  );
}

function NumKey({
  digit,
  active,
  disabled,
  onPress,
}: {
  digit: number;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onPress}
      disabled={disabled}
      animate={active ? { scale: 0.94 } : { scale: 1 }}
      transition={{ type: "spring", stiffness: 600, damping: 25 }}
      className="auth-numpad-button"
    >
      {digit}
    </motion.button>
  );
}
