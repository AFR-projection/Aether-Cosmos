"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, ShieldPlus } from "lucide-react";
import { apiFetch } from "@/shared/api/client";
import { Numpad } from "@auth/presentation/components/numpad";
import { AuthShell } from "@auth/presentation/components/auth-shell";
import { apiErrorMessage, useT } from "@/shared/lib/i18n";

const STEP_CODE_MIN = 6;
const STEP_CODE_MAX = 10;

interface EnrollResponse {
  user?: { role?: string };
  requires2fa?: boolean;
  pendingToken?: string;
  mustChangePassword?: boolean;
  newDevice?: boolean;
}

export default function StepCodeSetupPage() {
  const router = useRouter();
  const [stepToken, setStepToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<"choose" | "confirm">("choose");
  const [newCode, setNewCode] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const t = useT();

  useEffect(() => {
    const token = sessionStorage.getItem("auth_step_token");
    const isEnroll = sessionStorage.getItem("auth_step_enrollment") === "1";
    if (!token || !isEnroll) {
      router.replace("/login");
      return;
    }
    const setupFrame = window.setTimeout(() => setStepToken(token), 0);
    return () => window.clearTimeout(setupFrame);
  }, [router]);

  async function handleSubmit() {
    if (!stepToken) return;

    if (phase === "choose") {
      setError("");
      setConfirmCode("");
      setPhase("confirm");
      return;
    }

    if (newCode !== confirmCode) {
      setError(t("auth.setup.mismatch"));
      setConfirmCode("");
      return;
    }

    setError("");
    setLoading(true);
    try {
      const res = await apiFetch<EnrollResponse>("/api/auth/step-code/enroll", {
        method: "POST",
        body: JSON.stringify({ stepToken, newCode, confirmCode }),
      });

      if (!res.success) {
        setError(apiErrorMessage(res, t, "auth.setup.failed"));
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

  if (!stepToken) return null;

  const isConfirming = phase === "confirm";

  return (
    <AuthShell
      step="step-code"
      icon={<ShieldPlus />}
      title={isConfirming ? t("auth.setup.titleConfirm") : t("auth.setup.titleChoose")}
      description={
        isConfirming ? t("auth.setup.descriptionConfirm") : t("auth.setup.descriptionChoose")
      }
      visualKicker={t("auth.setup.visualKicker")}
      visualTitle={
        <>
          {t("auth.setup.visualTitleTop")}
          <br />
          <em>{t("auth.setup.visualTitleEm")}</em>
        </>
      }
      visualDescription={t("auth.setup.visualDescription")}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="auth-setup-note">
          <div className="auth-setup-note__heading">
            <span className="auth-setup-note__signal" aria-hidden="true" />
            <span>{isConfirming ? t("auth.setup.noteConfirm") : t("auth.setup.noteChoose")}</span>
          </div>
          <ul>
            <li>{t("auth.setup.ruleDigits", { min: STEP_CODE_MIN, max: STEP_CODE_MAX })}</li>
            <li>{t("auth.setup.ruleAvoid")}</li>
          </ul>
        </div>

        <Numpad
          key={phase}
          value={isConfirming ? confirmCode : newCode}
          onChange={(value) => {
            if (isConfirming) setConfirmCode(value);
            else setNewCode(value);
            if (error) setError("");
          }}
          onSubmit={handleSubmit}
          minLength={STEP_CODE_MIN}
          maxLength={STEP_CODE_MAX}
          /*
           * Free length while choosing; locked to the chosen length while
           * confirming, so the second entry has to be the same shape as the
           * first and a typo shows up as an unfilled slot rather than a
           * "codes do not match" after the fact.
           */
          exactLength={isConfirming ? newCode.length : null}
          label={isConfirming ? t("auth.setup.labelConfirm") : t("auth.setup.labelNew")}
          error={Boolean(error)}
          loading={loading}
          message={error}
          submitLabel={isConfirming ? t("auth.setup.submit") : t("auth.continue")}
          loadingLabel={t("auth.setup.submitting")}
        />

        <button
          type="button"
          onClick={() => {
            if (isConfirming) {
              setPhase("choose");
              setConfirmCode("");
              setError("");
            } else {
              router.push("/login");
            }
          }}
          className="auth-secondary-link"
        >
          <ArrowLeft aria-hidden="true" />
          {isConfirming ? t("auth.setup.changeCode") : t("auth.backToSignIn")}
        </button>
      </motion.div>
    </AuthShell>
  );
}
