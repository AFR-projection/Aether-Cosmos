"use client";

import { Sidebar } from "./sidebar";
import { BottomNav } from "./bottom-nav";
import { startTransition, useSyncExternalStore, useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { Menu, Search } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { cn } from "@/shared/lib/utils";
import Link from "next/link";
import { useRealtimeEvents, rememberCurrentSessionId } from "@/ui/hooks/use-realtime-events";
import { notify } from "@/shared/lib/system/notify-store";
import { apiFetch } from "@/shared/api/client";
import { OfflineOverlay } from "@/ui/feedback/offline-overlay";
import { useQueryClient } from "@tanstack/react-query";
import { configureActivityScope } from "@/shared/lib/activity/activity-store";
import { configureDownloadScope } from "@files/application/commands/download-store";
import { configureEncryptedDownloadScope } from "@files/application/commands/encrypted-download-store";
import { clearLocalUploads } from "@/shared/lib/system/local-upload-registry";
import { publishActivityIdentity } from "@/shared/lib/activity/activity-identity";
import { resetCsrfToken } from "@/shared/api/client";
import { APP_NAME } from "@/shared/lib/app-version";
import { createTranslator, getLocale, useT, type TranslationKey } from "@/shared/lib/i18n";
import { OnboardingChecklist } from "@shell/compositions/onboarding-checklist";

const STORAGE_KEY = "sidebar_collapsed";

const PAGE_TITLE_KEYS: Record<string, TranslationKey> = {
  "/dashboard": "nav.dashboard",
  "/files": "nav.files",
  "/favorites": "nav.favorites",
  "/shares": "nav.shared",
  "/recycle-bin": "nav.recycleBin",
};

/** null means the route has no title of its own and the product name stands in —
 *  a brand is the same word in every locale, so it is not a translation key. */
function getPageTitleKey(pathname: string): TranslationKey | null {
  if (pathname.startsWith("/admin")) return "nav.admin";
  return PAGE_TITLE_KEYS[pathname] ?? null;
}

function getStoredCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function subscribeCollapsed(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

export function ClientShell({
  user,
  children,
  activityScopeId,
}: {
  user: {
    username: string;
    role: string;
    quotaBytes: number;
    usedBytes: number;
    isImpersonating?: boolean;
  };
  children: React.ReactNode;
  activityScopeId: string;
}) {
  configureActivityScope(activityScopeId);
  configureDownloadScope(activityScopeId);
  configureEncryptedDownloadScope(activityScopeId);
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarTransition, setSidebarTransition] = useState(false);
  const initialCollapsed = useRef(true);
  const identityRef = useRef<string | null>(null);
  const [identityReady, setIdentityReady] = useState<string | null>(null);
  const t = useT();

  useRealtimeEvents(identityReady === activityScopeId);

  useEffect(() => {
    if (identityReady === activityScopeId) return;
    const previousScopeId = identityRef.current;
    identityRef.current = activityScopeId;
    clearLocalUploads();
    resetCsrfToken();
    queryClient.clear();
    if (previousScopeId) publishActivityIdentity(activityScopeId, previousScopeId);
    startTransition(() => setIdentityReady(activityScopeId));
  }, [activityScopeId, identityReady, queryClient]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch<{ sessionId?: string }>("/api/auth/login");
        if (res.success && res.data?.sessionId) {
          rememberCurrentSessionId(res.data.sessionId);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("new_login_notice") === "1") {
        sessionStorage.removeItem("new_login_notice");
        // This fires once on mount, so it must not depend on `t` — a translator
        // built here reads the locale that is live at the moment the toast goes out.
        const translate = createTranslator(getLocale());
        notify({
          title: translate("notify.newLoginTitle"),
          description: translate("notify.newLoginBody"),
          tone: "warning",
          duration: 6000,
        });
      }
    } catch {
      // ignore
    }
  }, []);

  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    () => getStoredCollapsed(),
    () => false
  );

  const setCollapsed = (value: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(value));
    window.dispatchEvent(new Event("storage"));
  };

  // Track initial collapsed state to prevent layout shift
  useEffect(() => {
    initialCollapsed.current = collapsed;
  }, []);

  // Enable transition after mount to avoid flash
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSidebarTransition(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  // Prevent body scroll when mobile sidebar is open
  useEffect(() => {
    if (mobileSidebarOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileSidebarOpen]);

  if (identityReady !== activityScopeId) {
    return <div className="min-h-dvh bg-background" aria-busy="true" />;
  }

  const titleKey = getPageTitleKey(pathname);
  const title = titleKey ? t(titleKey) : APP_NAME;

  return (
    <div className="min-h-dvh bg-background" suppressHydrationWarning>
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[200] -translate-y-24 rounded-lg bg-background px-4 py-3 text-sm font-semibold shadow-lg focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-accent"
      >
        {t("nav.skipToContent")}
      </a>
      <Sidebar
        user={user}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />

      {/* Mobile/Tablet Header */}
      <header className="chrome-surface fixed top-0 left-0 right-0 z-30 flex h-14 items-center gap-2 border-b border-border/50 px-3 pt-safe lg:hidden" style={{ height: "calc(3.5rem + var(--safe-top))" }}>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-lg shrink-0"
          onClick={() => setMobileSidebarOpen(true)}
          aria-label={t("nav.openNavigationMenu")}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <h1 className="text-sm font-semibold truncate flex-1">{title}</h1>
        <Link
          href="/files"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/5 transition-colors"
          aria-label={t("nav.searchFiles")}
        >
          <Search className="h-4 w-4" />
        </Link>
      </header>

      {/* Main content — padding handled purely by CSS to avoid layout shift.
          Mobile: offset for the fixed header (incl. notch) and leave room for
          the bottom tab bar so the last row is never hidden behind it. */}
      <main
        id="main-content"
        tabIndex={-1}
        className={cn(
          "min-h-dvh max-lg:!pl-0 max-lg:pb-nav-safe",
          sidebarTransition && "transition-all duration-250 ease-out",
          collapsed ? "lg:pl-[72px]" : "lg:pl-[240px]"
        )}
        style={{ scrollPaddingTop: "calc(3.5rem + var(--safe-top))" }}
        suppressHydrationWarning
      >
        <div className="max-lg:pt-[calc(3.5rem+var(--safe-top))]">
          <OnboardingChecklist scopeId={activityScopeId} />
          {children}
        </div>
      </main>

      {/* Native-style bottom tab bar (mobile/tablet only). Its Menu button
          opens the same sidebar drawer used by the header hamburger. */}
      <BottomNav onOpenMenu={() => setMobileSidebarOpen(true)} />

      <OfflineOverlay />
    </div>
  );
}
