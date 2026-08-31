import { Suspense } from "react";
import { LoadingFallback } from "@/ui/i18n/loading-fallback";
import OAuthConsentClient from "./consent-client";

export default function OAuthConsentPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
          <LoadingFallback />
        </div>
      }
    >
      <OAuthConsentClient />
    </Suspense>
  );
}
