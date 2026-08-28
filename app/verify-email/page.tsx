"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import {
  Loader2,
  Mail,
  AlertTriangle,
  ExternalLink,
  CheckCircle2,
  Lightbulb,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";

const CODE_TTL_SECONDS = 10 * 60; // matches OTP_EXPIRY_MINUTES on the server
const RESEND_COOLDOWN_SECONDS = 60;
const HELP_AFTER_SECONDS = 20; // auto-reveal "can't find it?" help after this long
const GMAIL_SPAM_URL = "https://mail.google.com/mail/u/0/#spam";

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get("email");
  const isGmail = !!email && /@gmail\.com$/i.test(email);

  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [waitTimer, setWaitTimer] = useState(RESEND_COOLDOWN_SECONDS);
  const [secondsLeft, setSecondsLeft] = useState(CODE_TTL_SECONDS);
  const [helpForced, setHelpForced] = useState(false);
  const [justResent, setJustResent] = useState(false);

  const expired = secondsLeft <= 0;
  const mm = Math.floor(Math.max(secondsLeft, 0) / 60);
  const ss = Math.max(secondsLeft, 0) % 60;
  const clock = `${mm}:${String(ss).padStart(2, "0")}`;
  // Surface the "can't find it?" help once the user opens it OR enough time has
  // passed that a still-missing email almost certainly means it was filtered.
  const helpOpen = helpForced || CODE_TTL_SECONDS - secondsLeft >= HELP_AFTER_SECONDS;

  // Resend cooldown countdown.
  useEffect(() => {
    if (waitTimer <= 0) return;
    const timer = setTimeout(() => setWaitTimer((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [waitTimer]);

  // Code expiry countdown.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setVerifying(true);
    try {
      const res = await apiFetch("/api/auth/verify-otp", {
        method: "POST",
        body: JSON.stringify({ email, code: otp }),
      });
      if (!res.success) {
        setError(res.error ?? "Verification failed");
        setOtp("");
        return;
      }
      router.push("/dashboard");
    } catch {
      setError("Connection failed");
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    setError("");
    setJustResent(false);
    setResending(true);
    setWaitTimer(RESEND_COOLDOWN_SECONDS);
    try {
      const res = await apiFetch("/api/auth/resend-otp", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      if (!res.success) {
        setError(res.error ?? "Failed to resend code");
        setWaitTimer(0);
        return;
      }
      // Fresh code issued — reset the expiry clock and confirm to the user.
      setSecondsLeft(CODE_TTL_SECONDS);
      setOtp("");
      setJustResent(true);
      setHelpForced(true); // they clearly had trouble — keep the help visible
    } catch {
      setError("Connection failed");
      setWaitTimer(0);
    } finally {
      setResending(false);
    }
  };

  if (!email) return null;

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
              <Mail className="h-8 w-8 text-on-accent" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-gradient">Verify your email</h1>
            <p className="mt-2 text-sm text-muted-foreground/80">
              We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
            </p>
          </div>

          <form onSubmit={handleVerify} className="space-y-4">
            {justResent && (
              <div
                className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
                aria-live="polite"
              >
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>New code sent. It can take a minute — remember to check Spam too.</span>
              </div>
            )}

            <div>
              <label htmlFor="otp" className="mb-1.5 block text-sm font-medium">
                Verification code
              </label>
              <Input
                id="otp"
                name="otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                maxLength={6}
                className="h-12 text-center text-2xl tracking-[0.5em] font-mono"
                disabled={verifying}
                autoFocus
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {expired ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    This code has expired — tap Resend to get a new one.
                  </span>
                ) : (
                  <>Code expires in <span className="font-medium tabular-nums">{clock}</span></>
                )}
              </p>
            </div>

            {error && (
              <p
                className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
                aria-live="assertive"
              >
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="h-11 w-full"
              disabled={verifying || expired || otp.length !== 6}
            >
              {verifying ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : "Verify"}
            </Button>

            <div className="flex items-center justify-center gap-1 text-sm">
              <span className="text-muted-foreground">Didn&apos;t get the code?</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleResend}
                disabled={waitTimer > 0 || resending}
                className="h-auto px-1.5 py-0.5 text-accent-ink hover:text-foreground"
              >
                {resending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : waitTimer > 0 ? (
                  `Resend in ${waitTimer}s`
                ) : (
                  "Resend"
                )}
              </Button>
            </div>
          </form>

          {/* Escalating help: automated codes from Gmail senders frequently land
              in Spam/Promotions, so make the recovery steps unmissable. */}
          {!helpOpen ? (
            <button
              type="button"
              onClick={() => setHelpForced(true)}
              className="mt-4 w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Still nothing in your inbox?
            </button>
          ) : (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="mt-5 overflow-hidden rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/70 dark:bg-amber-950/50"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Can&apos;t find the code?
              </div>
              <ol className="mt-3 space-y-3 text-sm text-amber-900/90 dark:text-amber-100/90">
                <li className="flex gap-2">
                  <span className="font-semibold">1.</span>
                  <div>
                    Check your <strong>Spam</strong> and <strong>Promotions</strong> folders —
                    automated verification codes often get filtered there.
                    {isGmail && (
                      <a
                        href={GMAIL_SPAM_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 shadow-sm hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900"
                      >
                        Open Gmail Spam folder
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold">2.</span>
                  <div>
                    Make sure <strong>{email}</strong> is correct. Wrong address?{" "}
                    <button
                      type="button"
                      onClick={() => router.push("/register")}
                      className="font-medium underline underline-offset-2 hover:text-amber-950 dark:hover:text-white"
                    >
                      start over
                    </button>
                    .
                  </div>
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold">3.</span>
                  <div>
                    Wait a minute or two — email can be delayed — then tap{" "}
                    <strong>Resend</strong> above.
                  </div>
                </li>
              </ol>
              <p className="mt-3 flex gap-2 rounded-lg bg-amber-100/70 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100/90">
                <Lightbulb aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Found it in Spam? Open the email and tap{" "}
                  <strong>&ldquo;Not spam&rdquo;</strong> so future codes reach your inbox.
                </span>
              </p>
            </motion.div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
