"use client";

import { useEffect } from "react";
import { SystemToastViewport } from "@/ui/feedback/system-toast";
import { ConnectionStatusPill } from "@/ui/feedback/connection-status";
import { PageProgressBar } from "@/ui/feedback/page-progress";
import { DownloadsWidget } from "@files/presentation/components/download/downloads-widget";
import { notify, setConnectionStatus } from "@/shared/lib/system/notify-store";
import { createTranslator, getLocale } from "@/shared/lib/i18n";

/** Global system feedback layer: progress, connection, toasts, online/offline. */
export function SystemFeedback() {
  useEffect(() => {
    // The two listeners are registered once for the life of the page, so a `t`
    // captured from render would pin these toasts to whichever language was
    // active at mount. Built at the moment the event fires instead.
    const onOffline = () => {
      const t = createTranslator(getLocale());
      setConnectionStatus("offline");
      notify({
        title: t("system.offline.title"),
        description: t("system.offline.toastNote"),
        tone: "warning",
        duration: 5000,
      });
    };
    const onOnline = () => {
      const t = createTranslator(getLocale());
      setConnectionStatus("connecting");
      notify({
        title: t("system.offline.backTitle"),
        description: t("system.offline.backNote"),
        tone: "success",
        duration: 2800,
      });
    };

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setConnectionStatus("offline");
    }

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return (
    <>
      <PageProgressBar />
      <ConnectionStatusPill />
      <SystemToastViewport />
      <DownloadsWidget />
    </>
  );
}
