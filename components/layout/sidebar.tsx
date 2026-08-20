"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  FolderOpen,
  Brain,
  Star,
  Share2,
  Trash2,
  Shield,
  Cloud,
  LogOut,
  Moon,
  Sun,
  ChevronLeft,
  ChevronRight,
  Command,
  Search,
  X,
  Loader2,
  Settings,
  Users,
  Mail,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import { publishActivityIdentity } from "@/lib/activity/activity-identity";
import { getActivityScopeId } from "@/lib/activity/activity-store";
import { resetCsrfToken } from "@/lib/api/client";
import { useRouter } from "next/navigation";
import { useState, useEffect, useSyncExternalStore } from "react";

interface SidebarProps {
  user: {
    username: string;
    role: string;
    quotaBytes: number;
    usedBytes: number;
    isImpersonating?: boolean;
  };
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/brain", label: "Second Brain", icon: Brain },
  { href: "/favorites", label: "Favorites", icon: Star },
  { href: "/shared-with-me", label: "Shared with me", icon: Users },
  { href: "/shares", label: "Shared", icon: Share2 },
  { href: "/recycle-bin", label: "Recycle Bin", icon: Trash2 },
];

const STORAGE_KEY = "sidebar_collapsed";

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

function SidebarInner({
  user,
  collapsed,
  setCollapsed,
  isMobile,
  onNav,
}: {
  user: SidebarProps["user"];
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  isMobile?: boolean;
  onNav?: () => void;
}) {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const usedPct = user.quotaBytes > 0 ? (user.usedBytes / user.quotaBytes) * 100 : 0;
  const showLabels = isMobile || (mounted && !collapsed);

  async function handleLogout() {
    setLoggingOut(true);
    publishActivityIdentity(null, getActivityScopeId());
    resetCsrfToken();
    try {
      await apiFetch("/api/auth/login", { method: "DELETE" });
      router.push("/login");
      router.refresh();
    } catch {
      setLoggingOut(false);
    }
  }

  function handleNav() {
    if (onNav) onNav();
  }

  return (
    <div className="flex h-full flex-col" suppressHydrationWarning>
      {/* Logo */}
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border/50 px-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent glow-accent">
          <Cloud className="h-5 w-5 text-white" />
        </div>
        {!isMobile ? (
          <motion.div
            animate={{ opacity: collapsed ? 0 : 1, width: collapsed ? 0 : "auto" }}
            className="min-w-0 overflow-hidden"
          >
            <p className="truncate text-sm font-bold text-gradient">Storage ByAFR</p>
            <p className="truncate text-xs text-muted-foreground/80">@{user.username}</p>
          </motion.div>
        ) : (
          <div className="min-w-0 overflow-hidden">
            <p className="truncate text-sm font-bold text-gradient">Storage ByAFR</p>
            <p className="truncate text-xs text-muted-foreground/80">@{user.username}</p>
          </div>
        )}
      </div>

      {/* Quick Search */}
      {(isMobile || (mounted && !collapsed)) && (
        <div className="shrink-0 px-3 pt-3">
          <Link
            href="/files"
            onClick={handleNav}
            className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-accent/30 hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5" />
            <span>Quick search...</span>
            {!isMobile && (
              <kbd className="ml-auto flex items-center gap-0.5 rounded border border-border bg-surface/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70">
                <Command className="h-2.5 w-2.5" />K
              </kbd>
            )}
          </Link>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-3 pt-2">
        {navItems
          .filter((item) => !(user.role === "master" && item.href === "/dashboard"))
          .map(({ href, label, icon: Icon }, idx) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <motion.div
              key={href}
              initial={!isMobile ? { opacity: 0, x: -12 } : undefined}
              animate={!isMobile ? { opacity: 1, x: 0 } : undefined}
              transition={!isMobile ? { delay: idx * 0.04, duration: 0.25 } : undefined}
            >
              <Link
                href={href}
                onClick={handleNav}
                className={cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 min-h-[40px]",
                  active ? "text-accent" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {active && (
                  <motion.div
                    layoutId={`nav-active${isMobile ? "-mobile" : ""}`}
                    className="absolute inset-0 rounded-lg bg-accent/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
                <Icon className={cn("relative z-10 h-4 w-4 shrink-0", active && "text-accent")} />
                {showLabels && <span className="relative z-10">{label}</span>}
                {active && showLabels && (
                  <motion.div
                    layoutId={`nav-dot${isMobile ? "-mobile" : ""}`}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-accent"
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
              </Link>
            </motion.div>
          );
        })}

        {user.role !== "master" && (
          <motion.div
            initial={!isMobile ? { opacity: 0, x: -12 } : undefined}
            animate={!isMobile ? { opacity: 1, x: 0 } : undefined}
            transition={!isMobile ? { delay: navItems.length * 0.04, duration: 0.25 } : undefined}
          >
            <Link
              href="/settings"
              onClick={handleNav}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 min-h-[40px]",
                pathname === "/settings" ? "text-accent" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {pathname === "/settings" && (
                <motion.div
                  layoutId={`nav-active-settings${isMobile ? "-mobile" : ""}`}
                  className="absolute inset-0 rounded-lg bg-accent/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <Settings className={cn("relative z-10 h-4 w-4 shrink-0", pathname === "/settings" && "text-accent")} />
              {showLabels && <span className="relative z-10">Settings</span>}
            </Link>
          </motion.div>
        )}

        {user.role === "master" && (
          <motion.div
            initial={!isMobile ? { opacity: 0, x: -12 } : undefined}
            animate={!isMobile ? { opacity: 1, x: 0 } : undefined}
            transition={!isMobile ? { delay: (navItems.length + 1) * 0.04, duration: 0.25 } : undefined}
          >
            <Link
              href="/admin/users"
              onClick={handleNav}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 min-h-[40px]",
                pathname.startsWith("/admin") ? "text-accent" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {pathname.startsWith("/admin") && (
                <motion.div
                  layoutId={`nav-active-admin${isMobile ? "-mobile" : ""}`}
                  className="absolute inset-0 rounded-lg bg-accent/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <Shield className={cn("relative z-10 h-4 w-4 shrink-0", pathname.startsWith("/admin") && "text-accent")} />
              {showLabels && <span className="relative z-10">Admin</span>}
            </Link>
          </motion.div>
        )}
      </nav>

      {/* Storage Meter */}
      <div
        className={cn(
          "shrink-0 overflow-hidden border-t border-border/50",
          collapsed && !isMobile && "h-0 opacity-0 overflow-hidden"
        )}
      >
        {isMobile ? (
          <div className="p-4">
            <div className="mb-2 flex justify-between text-[11px] font-medium text-muted-foreground/70">
              <span>Storage used</span>
              <span className="font-mono text-[10px]">{formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
              <div className="h-full rounded-full bg-accent-gradient glow-sm" style={{ width: `${Math.min(usedPct, 100)}%` }} />
            </div>
          </div>
        ) : (
          <motion.div
            initial={false}
            animate={{ height: collapsed ? 0 : "auto" }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
          >
            <div className="p-4">
              <div className="mb-2 flex justify-between text-[11px] font-medium text-muted-foreground/70">
                <span>Storage used</span>
                <span className="font-mono text-[10px]">{formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-hover">
                <motion.div
                  className="h-full rounded-full bg-accent-gradient glow-sm"
                  initial={false}
                  animate={{ width: `${Math.min(usedPct, 100)}%` }}
                  transition={{ duration: 0.8, ease: "easeOut", delay: 0.2 }}
                  suppressHydrationWarning
                />
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* Bottom Actions */}
      <div className={cn(
        "flex shrink-0 items-center border-t border-border/50 p-3",
        isMobile ? "gap-1" : (collapsed ? "justify-center gap-2" : "gap-1")
      )}>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-lg text-muted-foreground hover:text-foreground"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        {!isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg text-muted-foreground hover:text-foreground"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        )}
        {showLabels && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-9 gap-1.5 rounded-lg text-muted-foreground hover:text-danger hover:bg-danger/10"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
          </Button>
        )}
      </div>
    </div>
  );
}

export function Sidebar({ user, collapsed, setCollapsed, mobileOpen = false, onMobileClose }: SidebarProps) {
  const storedCollapsed = useSyncExternalStore(
    subscribeCollapsed,
    () => getStoredCollapsed(),
    () => false
  );

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const effectiveCollapsed = mounted ? collapsed : storedCollapsed;
  const sidebarWidth = effectiveCollapsed ? "w-[72px]" : "w-[240px]";

  return (
    <>
      {/* Desktop sidebar — plain aside, no framer-motion. CSS hides on mobile. */}
      <aside
        className={cn(
          "chrome-surface fixed left-0 top-0 z-40 hidden h-screen flex-col border-r border-border transition-[width] duration-250 ease-out lg:flex",
          sidebarWidth
        )}
        suppressHydrationWarning
        aria-label="Sidebar"
      >
        <SidebarInner user={user} collapsed={effectiveCollapsed} setCollapsed={setCollapsed} />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="scrim fixed inset-0 z-40 lg:hidden"
              onClick={onMobileClose}
              suppressHydrationWarning
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="chrome-surface fixed left-0 top-0 z-50 flex h-screen w-[280px] flex-col border-r border-border lg:hidden"
              suppressHydrationWarning
              aria-label="Navigation menu"
            >
              <button
                onClick={onMobileClose}
                className="chrome-surface absolute -right-10 top-4 flex h-8 w-8 items-center justify-center rounded-full border border-border/50 text-muted-foreground hover:text-foreground"
                aria-label="Close navigation menu"
              >
                <X className="h-4 w-4" />
              </button>
              <SidebarInner user={user} collapsed={false} setCollapsed={() => {}} isMobile onNav={onMobileClose} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
