"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { FolderOpen, Star, Share2, Menu, Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "@/shared/lib/utils";
import { useT, type TranslationKey } from "@/shared/lib/i18n";
import { QuickActionsSheet } from "./quick-actions-sheet";

interface BottomNavProps {
  /** Opens the existing sidebar drawer for the full menu. */
  onOpenMenu: () => void;
}

/** `as const satisfies` keeps `href` a literal while checking every label key. */
const TABS = [
  { href: "/files", labelKey: "nav.files", icon: FolderOpen },
  { href: "/favorites", labelKey: "nav.favorites", icon: Star },
  { href: "/shares", labelKey: "nav.shared", icon: Share2 },
] as const satisfies readonly { href: string; labelKey: TranslationKey; icon: typeof FolderOpen }[];

/**
 * Native-style bottom tab bar for mobile/tablet. Three primary destinations, a
 * center "+" FAB for quick actions, and a Menu button that opens the existing
 * sidebar drawer (so Dashboard/Settings/Admin/Recycle-bin/logout stay in one
 * place instead of being duplicated here). Hidden on lg+ where the sidebar
 * lives. Sits above the safe area so the iPhone home indicator never overlaps.
 */
export function BottomNav({ onOpenMenu }: BottomNavProps) {
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);
  const t = useT();

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <nav
        className="chrome-surface fixed inset-x-0 bottom-0 z-40 border-t border-border/50 pb-safe lg:hidden"
        aria-label={t("nav.mainNavigation")}
      >
        <div className="mx-auto flex h-[60px] max-w-md items-stretch justify-around px-2">
          {/* First two tabs */}
          {TABS.slice(0, 2).map((tab) => (
            <TabButton key={tab.href} {...tab} active={isActive(tab.href)} />
          ))}

          {/* Center FAB */}
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="tap relative flex w-[64px] shrink-0 items-center justify-center"
            aria-label={t("quickActions.title")}
            // The "+" opens a sheet rather than doing something, so it says so —
            // and says whether the sheet is currently up.
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
          >
            <span className="flex h-12 w-12 -translate-y-3 items-center justify-center rounded-2xl bg-accent text-on-accent shadow-lg shadow-accent/30">
              <Plus aria-hidden className="h-6 w-6" />
            </span>
          </button>

          {/* Last tab + menu */}
          {TABS.slice(2).map((tab) => (
            <TabButton key={tab.href} {...tab} active={isActive(tab.href)} />
          ))}
          <button
            type="button"
            onClick={onOpenMenu}
            className="tap flex flex-1 flex-col items-center justify-center gap-0.5 text-muted-foreground"
            aria-label={t("nav.moreMenu")}
            aria-haspopup="dialog"
          >
            <Menu aria-hidden className="h-5 w-5" />
            <span className="text-[10px] font-medium">{t("nav.menu")}</span>
          </button>
        </div>
      </nav>

      <QuickActionsSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}

function TabButton({
  href,
  labelKey,
  icon: Icon,
  active,
}: {
  href: string;
  labelKey: TranslationKey;
  icon: typeof FolderOpen;
  active: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const t = useT();
  return (
    <Link
      href={href}
      // The accent colour and the little bar are the only thing saying "you are here",
      // and neither reaches a screen reader.
      aria-current={active ? "page" : undefined}
      className={cn(
        "tap relative flex flex-1 flex-col items-center justify-center gap-0.5",
        active ? "text-accent-ink" : "text-muted-foreground"
      )}
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId="bottom-nav-active"
          className="absolute -top-px h-0.5 w-8 rounded-full bg-accent"
          // The sliding indicator is a framer-motion animation, so the global
          // prefers-reduced-motion CSS block in globals.css cannot reach it.
          transition={
            reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 30 }
          }
        />
      )}
      <Icon aria-hidden className={cn("h-5 w-5", active && "fill-accent/15")} />
      <span className="text-[10px] font-medium">{t(labelKey)}</span>
    </Link>
  );
}
