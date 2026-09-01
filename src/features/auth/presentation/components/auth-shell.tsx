"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Cloud, LockKeyhole, Pause, Play } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { APP_NAME } from "@/shared/lib/app-version";
import { useT, type TranslationKey } from "@/shared/lib/i18n";
import {
  SecurityAlertBanner,
  type SecurityAlertPayload,
} from "@auth/presentation/components/security-alert";

export type AuthStep = "password" | "step-code" | "authenticator";

const steps: Array<{ key: AuthStep; labelKey: TranslationKey }> = [
  { key: "password", labelKey: "auth.stepPassword" },
  { key: "step-code", labelKey: "auth.stepStepCode" },
  { key: "authenticator", labelKey: "auth.stepAuthenticator" },
];

/** The product wordmark and its build stamp read the same in every locale. */
const BRAND_NAME = "Aether Cosmos";
const BRAND_SUFFIX = "ByAFR";
const VERSION_STAMP = "AFR / 01";
const AUTH_VISUAL_VIDEO = "/auth/login-ambient.mp4";

type NetworkInformation = EventTarget & { saveData?: boolean };

/**
 * The cinematic layer is enhancement-only. It never downloads on compact
 * screens, with reduced motion, or while the browser's data-saver is active.
 * The constellation image underneath remains the stable first paint/fallback.
 */
function useAmbientVideoEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 960px)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    let frame = 0;

    const sync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setEnabled(desktop.matches && !reducedMotion.matches && !connection?.saveData);
      });
    };

    desktop.addEventListener("change", sync);
    reducedMotion.addEventListener("change", sync);
    connection?.addEventListener("change", sync);
    sync();

    return () => {
      window.cancelAnimationFrame(frame);
      desktop.removeEventListener("change", sync);
      reducedMotion.removeEventListener("change", sync);
      connection?.removeEventListener("change", sync);
    };
  }, []);

  return enabled;
}

interface AuthShellProps {
  step: AuthStep;
  icon: ReactNode;
  title: string;
  description: string;
  visualKicker: string;
  visualTitle: ReactNode;
  visualDescription: string;
  children: ReactNode;
  footer?: ReactNode;
  securityAlert?: SecurityAlertPayload | null;
  onDismissSecurityAlert?: () => void;
}

export function AuthShell({
  step,
  icon,
  title,
  description,
  visualKicker,
  visualTitle,
  visualDescription,
  children,
  footer,
  securityAlert,
  onDismissSecurityAlert,
}: AuthShellProps) {
  const titleId = `auth-title-${step}`;
  const t = useT();
  const videoEnabled = useAmbientVideoEnabled();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoPaused, setVideoPaused] = useState(false);

  function toggleAmbientVideo() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-page__backdrop" aria-hidden="true">
        <span className="auth-page__orb auth-page__orb--one" />
        <span className="auth-page__orb auth-page__orb--two" />
        <span className="auth-page__grain" />
      </div>

      <div className="auth-frame">
        <aside className="auth-visual" aria-label={APP_NAME}>
          <div className="auth-visual__canvas" aria-hidden="true">
            {videoEnabled && (
              <video
                ref={videoRef}
                className="auth-visual__video"
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                poster="/auth/auth-constellation.png"
                onPlay={() => setVideoPaused(false)}
                onPause={() => setVideoPaused(true)}
              >
                <source src={AUTH_VISUAL_VIDEO} type="video/mp4" />
              </video>
            )}
          </div>
          <div className="auth-visual__shade" aria-hidden="true" />
          <div className="auth-visual__content">
            <div className="auth-visual__topbar">
              <AuthBrand />
              {videoEnabled && (
                <button
                  type="button"
                  className="auth-video-toggle"
                  onClick={toggleAmbientVideo}
                  aria-pressed={videoPaused}
                  aria-label={videoPaused ? t("auth.playVisual") : t("auth.pauseVisual")}
                >
                  {videoPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                  <span>{videoPaused ? t("auth.playMotion") : t("auth.pauseMotion")}</span>
                </button>
              )}
            </div>

            <div className="auth-visual__copy">
              <p className="auth-kicker">
                <span className="auth-kicker__line" aria-hidden="true" />
                {visualKicker}
              </p>
              <h2>{visualTitle}</h2>
              <p>{visualDescription}</p>
            </div>

            <div className="auth-visual__footer">
              <div className="auth-signal">
                <span className="auth-signal__icon" aria-hidden="true">
                  <LockKeyhole />
                </span>
                <span>
                  <strong>{t("auth.privateByDefault")}</strong>
                  <small>{t("auth.privateByDefaultNote")}</small>
                </span>
              </div>
              <span className="auth-visual__version">{VERSION_STAMP}</span>
            </div>
          </div>
        </aside>

        <main className="auth-main">
          <div className="auth-main__inner">
            <div className="auth-mobile-brand">
              <AuthBrand />
              <span className="auth-mobile-brand__tag">{t("auth.secureWorkspace")}</span>
            </div>

            <AuthStepRail currentStep={step} />

            <section className="auth-card" aria-labelledby={titleId}>
              <div className="auth-card__topline" aria-hidden="true" />

              {securityAlert && (
                <div className="auth-card__alert">
                  <SecurityAlertBanner
                    alert={securityAlert}
                    onDismiss={onDismissSecurityAlert}
                    className="auth-alert"
                  />
                </div>
              )}

              <header className="auth-card__header">
                <div className="auth-card__icon" aria-hidden="true">
                  {icon}
                </div>
                <p className="auth-card__eyebrow">
                  {t("auth.eyebrow", { step: steps.findIndex((item) => item.key === step) + 1 })}
                </p>
                <h1 id={titleId}>{title}</h1>
                <p>{description}</p>
              </header>

              <div className="auth-card__body">{children}</div>
            </section>

            <footer className="auth-main__footer">
              {footer ?? (
                <span>
                  <span className="auth-main__footer-dot" aria-hidden="true" />
                  {t("auth.encryptedWorkspace")}
                </span>
              )}
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}

export function AuthBrand() {
  return (
    <div className="auth-brand">
      <span className="auth-brand__mark" aria-hidden="true">
        <Cloud />
        <span className="auth-brand__spark" />
      </span>
      <span className="auth-brand__name">
        <strong>{BRAND_NAME}</strong>
        <span>{BRAND_SUFFIX}</span>
      </span>
    </div>
  );
}

export function AuthStepRail({ currentStep }: { currentStep: AuthStep }) {
  const currentIndex = steps.findIndex((step) => step.key === currentStep);
  const t = useT();

  return (
    <nav className="auth-stepper" aria-label={t("auth.stepperLabel")}>
      {steps.map((step, index) => {
        const isComplete = index < currentIndex;
        const isCurrent = index === currentIndex;

        return (
          <div className="auth-stepper__item" key={step.key}>
            <span
              className={cn(
                "auth-stepper__number",
                isComplete && "auth-stepper__number--complete",
                isCurrent && "auth-stepper__number--current"
              )}
              aria-current={isCurrent ? "step" : undefined}
            >
              {isComplete ? <Check aria-hidden="true" /> : `0${index + 1}`}
            </span>
            <span
              className={cn(
                "auth-stepper__label",
                isCurrent && "auth-stepper__label--current"
              )}
            >
              {t(step.labelKey)}
            </span>
            {index < steps.length - 1 && (
              <span
                className={cn(
                  "auth-stepper__connector",
                  index < currentIndex && "auth-stepper__connector--complete"
                )}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function AuthError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p className="auth-error" id={id} role="alert">
      <span className="auth-error__icon" aria-hidden="true">!</span>
      <span>{children}</span>
    </p>
  );
}

export function AuthHint({ children }: { children: ReactNode }) {
  return <p className="auth-hint">{children}</p>;
}
