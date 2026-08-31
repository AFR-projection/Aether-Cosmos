"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/lib/i18n";
import {
  consumeSecurityAlert,
  type SecurityAlertPayload,
} from "@/shared/lib/auth/security-alert-store";

export type { SecurityAlertPayload };

export function SecurityAlertBanner({
  alert,
  onDismiss,
  className,
}: {
  alert: SecurityAlertPayload;
  onDismiss?: () => void;
  className?: string;
}) {
  const isIp = alert.code === "SESSION_IP_CHANGED";
  const isRevoked = alert.code === "SESSION_REVOKED";
  const t = useT();

  return (
    <div
      role="alert"
      className={cn(
        "relative mb-5 rounded-xl border px-4 py-3 text-sm",
        isIp
          ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100"
          : isRevoked
            ? "border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-100"
            : "border-orange-500/30 bg-orange-500/10 text-orange-900 dark:text-orange-100",
        className
      )}
    >
      <div className="flex gap-3">
        <div className="mt-0.5 shrink-0">
          {isIp || isRevoked ? (
            <ShieldAlert
              className={cn(
                "h-5 w-5",
                isIp ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400"
              )}
            />
          ) : (
            <AlertTriangle className="h-5 w-5 text-orange-600 dark:text-orange-400" />
          )}
        </div>
        <div className="min-w-0 flex-1 pr-6">
          <p className="font-semibold tracking-tight">
            {isIp
              ? t("securityAlert.ipTitle")
              : isRevoked
                ? t("securityAlert.revokedTitle")
                : t("securityAlert.expiredTitle")}
          </p>
          {isIp ? (
            <div className="mt-1 space-y-1 text-[13px] opacity-90">
              <p>{t("securityAlert.ipReason")}</p>
              <p>
                {t("securityAlert.previousIp")}{" "}
                <span className="font-mono font-medium">
                  {alert.previousIp ?? t("securityAlert.unknownIp")}
                </span>
              </p>
              <p>
                {t("securityAlert.currentIp")}{" "}
                <span className="font-mono font-medium">
                  {alert.currentIp ?? t("securityAlert.unknownIp")}
                </span>
              </p>
              <p className="pt-1">{t("securityAlert.signInAgain")}</p>
            </div>
          ) : isRevoked ? (
            <p className="mt-1 text-[13px] opacity-90">{t("securityAlert.revokedBody")}</p>
          ) : (
            <p className="mt-1 text-[13px] opacity-90">{t("securityAlert.expiredBody")}</p>
          )}
        </div>
        {onDismiss && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1 h-7 w-7 opacity-70 hover:opacity-100"
            onClick={onDismiss}
            aria-label={t("securityAlert.dismiss")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** Reads one-shot alert from sessionStorage or URL ?alert= */
export function useSecurityAlertFromStorage(): {
  alert: SecurityAlertPayload | null;
  dismiss: () => void;
} {
  const [alert, setAlert] = useState<SecurityAlertPayload | null>(null);

  useEffect(() => {
    const stored = consumeSecurityAlert();
    if (stored) {
      setAlert(stored);
      return;
    }
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("alert");
    if (code === "SESSION_IP_CHANGED" || code === "SESSION_INACTIVE" || code === "SESSION_REVOKED") {
      setAlert({
        code,
        previousIp: params.get("previousIp") ?? undefined,
        currentIp: params.get("currentIp") ?? undefined,
      });
    }
  }, []);

  return {
    alert,
    dismiss: () => setAlert(null),
  };
}
