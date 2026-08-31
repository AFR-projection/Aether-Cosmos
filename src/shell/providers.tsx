"use client";

import { LocaleProvider } from "@/ui/i18n/locale-provider";
import { ThemeProvider } from "@/ui/providers/theme-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { MotionConfig } from "framer-motion";
import { SystemFeedback } from "@shell/compositions/system-feedback";
import { EncryptedDownloadDialog } from "@files/presentation/components/download/encrypted-download-dialog";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <LocaleProvider>
          <ThemeProvider>
            {children}
            <SystemFeedback />
            <EncryptedDownloadDialog />
          </ThemeProvider>
        </LocaleProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
