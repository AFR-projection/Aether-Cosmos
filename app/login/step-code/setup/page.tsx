"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, ShieldPlus } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { Numpad } from "@/components/auth/numpad";
import { AuthShell } from "@/components/auth/auth-shell";

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
      setError("Codes do not match. Please enter the same code again.");
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
        setError(res.error ?? "Setup failed");
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
      setError("Connection failed");
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
      title={isConfirming ? "Confirm your code" : "Create your code"}
      description={isConfirming ? "Enter it one more time so we know it is yours." : "Choose a code you can remember, but others cannot guess."}
      visualKicker="STORAGE / PERSONAL KEY"
      visualTitle={<>Make access<br /><em>uniquely yours.</em></>}
      visualDescription="This code becomes a private signal between you and your workspace. Keep it memorable, never predictable."
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="auth-setup-note">
          <div className="auth-setup-note__heading">
            <span className="auth-setup-note__signal" aria-hidden="true" />
            <span>{isConfirming ? "One last check" : "A code worth remembering"}</span>
          </div>
          <ul>
            <li>{STEP_CODE_MIN}–{STEP_CODE_MAX} digits, numbers only</li>
            <li>Avoid repeats, sequences, and important dates</li>
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
          error={Boolean(error)}
          loading={loading}
          message={error}
          submitLabel={isConfirming ? "Set secure code" : "Continue"}
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
          {isConfirming ? "Change code" : "Back to sign in"}
        </button>
      </motion.div>
    </AuthShell>
  );
}
