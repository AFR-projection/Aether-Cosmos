"use client";

import type { ReactNode } from "react";
import { Check, Cloud, LockKeyhole } from "lucide-react";
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

  return (
    <div className="auth-page">
      <div className="auth-page__backdrop" aria-hidden="true">
        <span className="auth-page__orb auth-page__orb--one" />
        <span className="auth-page__orb auth-page__orb--two" />
        <span className="auth-page__grain" />
      </div>

      <div className="auth-frame">
        <aside className="auth-visual" aria-label={APP_NAME}>
          <div className="auth-visual__canvas" aria-hidden="true" />
          <div className="auth-visual__shade" aria-hidden="true" />
          <div className="auth-visual__content">
            <AuthBrand />

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
