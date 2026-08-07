"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { FolderOpen, Star, Share2, Menu, Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { QuickActionsSheet } from "./quick-actions-sheet";

interface BottomNavProps {
  /** Opens the existing sidebar drawer for the full menu. */
  onOpenMenu: () => void;
}

const TABS = [
  { href: "/files", label: "Files", icon: FolderOpen },
  { href: "/favorites", label: "Favorit", icon: Star },
  { href: "/shares", label: "Dibagikan", icon: Share2 },
] as const;

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

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <nav
        className="chrome-surface fixed inset-x-0 bottom-0 z-40 border-t border-border/50 pb-safe lg:hidden"
        aria-label="Navigasi utama"
      >
        <div className="mx-auto flex h-[60px] max-w-md items-stretch justify-around px-2">
          {/* First two tabs */}
          {TABS.slice(0, 2).map((tab) => (
            <TabButton key={tab.href} {...tab} active={isActive(tab.href)} />
          ))}

          {/* Center FAB */}
          <button
            onClick={() => setSheetOpen(true)}
            className="tap relative flex w-[64px] shrink-0 items-center justify-center"
            aria-label="Buat baru"
          >
            <span className="flex h-12 w-12 -translate-y-3 items-center justify-center rounded-2xl bg-accent text-white shadow-lg shadow-accent/30">
              <Plus className="h-6 w-6" />
            </span>
          </button>

          {/* Last tab + menu */}
          {TABS.slice(2).map((tab) => (
            <TabButton key={tab.href} {...tab} active={isActive(tab.href)} />
          ))}
          <button
            onClick={onOpenMenu}
            className="tap flex flex-1 flex-col items-center justify-center gap-0.5 text-muted-foreground"
            aria-label="Menu lengkap"
          >
            <Menu className="h-5 w-5" />
            <span className="text-[10px] font-medium">Menu</span>
          </button>
        </div>
      </nav>

      <QuickActionsSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}

function TabButton({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: typeof FolderOpen;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "tap relative flex flex-1 flex-col items-center justify-center gap-0.5",
        active ? "text-accent" : "text-muted-foreground"
      )}
    >
      {active && (
        <motion.span
          layoutId="bottom-nav-active"
          className="absolute -top-px h-0.5 w-8 rounded-full bg-accent"
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
        />
      )}
      <Icon className={cn("h-5 w-5", active && "fill-accent/15")} />
      <span className="text-[10px] font-medium">{label}</span>
    </Link>
  );
}
