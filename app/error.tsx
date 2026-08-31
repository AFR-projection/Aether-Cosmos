"use client";

import { useEffect } from "react";
import { Button } from "@/ui/primitives/button";
import { AlertTriangle } from "lucide-react";
import { useT } from "@/shared/lib/i18n";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="text-center max-w-md">
        <div className="mb-6 mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-red-500/10 border border-red-500/20">
          <AlertTriangle className="h-10 w-10 text-red-500" />
        </div>
        <h1 className="text-2xl font-bold mb-2">{t("common.somethingWentWrong")}</h1>
        <p className="text-muted-foreground mb-6 text-sm">{t("errorPages.unexpectedBody")}</p>
        <Button onClick={reset} variant="default">
          {t("errorPages.tryAgain")}
        </Button>
      </div>
    </div>
  );
}
