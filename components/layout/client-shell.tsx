"use client";

import { Sidebar } from "./sidebar";
import { BottomNav } from "./bottom-nav";
import { startTransition, useSyncExternalStore, useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useRealtimeEvents, rememberCurrentSessionId } from "@/hooks/use-realtime-events";
import { notify } from "@/lib/system/notify-store";
import { apiFetch } from "@/lib/api/client";
import { OfflineOverlay } from "@/components/system/offline-overlay";
import { useQueryClient } from "@tanstack/react-query";
import { configureActivityScope } from "@/lib/activity/activity-store";
import { configureDownloadScope } from "@/lib/download/download-store";
import { configureEncryptedDownloadScope } from "@/lib/download/encrypted-download-store";
import { clearLocalUploads } from "@/lib/system/local-upload-registry";
import { publishActivityIdentity } from "@/lib/activity/activity-identity";
import { resetCsrfToken } from "@/lib/api/client";

const STORAGE_KEY = "sidebar_collapsed";

const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/files": "Files",
  "/favorites": "Favorites",
  "/shares": "Shared",
  "/recycle-bin": "Recycle Bin",
};

function getPageTitle(pathname: string): string {
  if (pathname.startsWith("/admin")) return "Admin";
  return PAGE_TITLES[pathname] ?? "Storage ByAFR";
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
        notify({
          title: "New login detected",
          description: "New login detected from a new device or location.",
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

  const title = getPageTitle(pathname);

  return (
    <div className="min-h-dvh bg-background" suppressHydrationWarning>
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
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <h1 className="text-sm font-semibold truncate flex-1">{title}</h1>
        <Link
          href="/files"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/5 transition-colors"
          aria-label="Search files"
        >
          <Search className="h-4 w-4" />
        </Link>
      </header>

      {/* Main content — padding handled purely by CSS to avoid layout shift.
          Mobile: offset for the fixed header (incl. notch) and leave room for
          the bottom tab bar so the last row is never hidden behind it. */}
      <main
        className={cn(
          "min-h-dvh max-lg:!pl-0 max-lg:pb-nav-safe",
          sidebarTransition && "transition-all duration-250 ease-out",
          collapsed ? "lg:pl-[72px]" : "lg:pl-[240px]"
        )}
        style={{ scrollPaddingTop: "calc(3.5rem + var(--safe-top))" }}
        suppressHydrationWarning
      >
        <div className="max-lg:pt-[calc(3.5rem+var(--safe-top))]">{children}</div>
      </main>

      {/* Native-style bottom tab bar (mobile/tablet only). Its Menu button
          opens the same sidebar drawer used by the header hamburger. */}
      <BottomNav onOpenMenu={() => setMobileSidebarOpen(true)} />

      <OfflineOverlay />
    </div>
  );
}
