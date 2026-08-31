"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/shared/api/client";
import { Numpad } from "@auth/presentation/components/numpad";
import { AuthShell } from "@auth/presentation/components/auth-shell";
import { apiErrorMessage, useT } from "@/shared/lib/i18n";

/**
 * Layer 2 of sign-in: verify the account's existing 2-Step Code.
 *
 * The pad is sized to the account's own code length, handed over by the login
 * response and kept in sessionStorage next to the staged token. Accounts whose
 * length was never recorded (enrolled before the column existed) get the old
 * flexible 6–10 pad until their next successful sign-in backfills it server-side.
 *
 * Mirrors of the server rules, not a second source of truth: the server still
 * rejects anything it disagrees with. These only shape the pad.
 */
const STEP_CODE_MIN = 6;
const STEP_CODE_MAX = 10;

const ORDERED_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

/**
 * Shuffled so the finger path across the pad is not the same every sign-in — a
 * shoulder-surfer or a camera above the desk learns positions, not digits. Called
 * from effects and event handlers only; never during render, where a different
 * order on the server and client pass would break hydration.
 */
function shuffleKeys(): string[] {
  const arr = [...ORDERED_KEYS];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function readStoredLength(): number | null {
  const raw = sessionStorage.getItem("auth_step_length");
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < STEP_CODE_MIN || parsed > STEP_CODE_MAX) return null;
  return parsed;
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
  const [expectedLength, setExpectedLength] = useState<number | null>(null);
  const [code, setCode] = useState("");
  const [keys, setKeys] = useState<string[]>(ORDERED_KEYS);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const t = useT();

  useEffect(() => {
    const token = sessionStorage.getItem("auth_step_token");
    if (!token) {
      router.replace("/login");
      return;
    }
    const length = readStoredLength();
    const setupFrame = window.setTimeout(() => {
      setStepToken(token);
      setExpectedLength(length);
      setKeys(shuffleKeys());
    }, 0);
    return () => window.clearTimeout(setupFrame);
  }, [router]);

  async function handleSubmit() {
    const enough = expectedLength
      ? code.length === expectedLength
      : code.length >= STEP_CODE_MIN;
    if (!stepToken || !enough || loading) return;

    setError("");
    setLoading(true);

    try {
      const res = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ stepToken, stepCode: code }),
      });

      if (!res.success) {
        setCode("");
        // A fresh layout for the retry: the failed attempt already showed an
        // observer where the fingers went. The error state itself drives the
        // shake and the red slots, so there is no separate timer to unwind.
        setKeys(shuffleKeys());
        setError(apiErrorMessage(res, t, "auth.stepCode.incorrect"));
        // Keyed off the stable code, not the message text: the staged token is
        // gone, so the only way forward is a fresh sign-in.
        if (res.code === "STEP_CODE_EXPIRED") {
          window.setTimeout(() => router.replace("/login"), 1200);
        }
        return;
      }

      const data = res.data;
      sessionStorage.removeItem("auth_step_token");
      sessionStorage.removeItem("auth_step_enrollment");
      sessionStorage.removeItem("auth_step_length");

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
      setError(t("errors.network"));
    } finally {
      setLoading(false);
    }
  }

  if (!stepToken) return null;

  return (
    <AuthShell
      step="step-code"
      icon={<ShieldCheck />}
      title={t("auth.stepCode.title")}
      description={
        expectedLength
          ? t("auth.stepCode.descriptionExact", { length: expectedLength })
          : t("auth.stepCode.description")
      }
      visualKicker={t("auth.stepCode.visualKicker")}
      visualTitle={
        <>
          {t("auth.stepCode.visualTitleTop")}
          <br />
          <em>{t("auth.stepCode.visualTitleEm")}</em>
        </>
      }
      visualDescription={t("auth.stepCode.visualDescription")}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <Numpad
          value={code}
          onChange={(next) => {
            setCode(next);
            if (error) setError("");
          }}
          onSubmit={() => void handleSubmit()}
          minLength={STEP_CODE_MIN}
          maxLength={STEP_CODE_MAX}
          exactLength={expectedLength}
          keyOrder={keys}
          shuffled
          error={Boolean(error)}
          loading={loading}
          message={error}
          submitLabel={t("auth.stepCode.submit")}
          loadingLabel={t("auth.stepCode.submitting")}
        />

        <button type="button" onClick={() => router.push("/login")} className="auth-secondary-link">
          <ArrowLeft aria-hidden="true" />
          {t("auth.backToSignIn")}
        </button>
      </motion.div>
    </AuthShell>
  );
}
