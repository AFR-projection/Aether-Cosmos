"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  Mail,
  ScrollText,
  Share2,
  Sliders,
  Users,
} from "lucide-react";
import { useT } from "@/shared/lib/i18n";
import type { TranslationKey } from "@/shared/lib/i18n";

const tabs: { href: string; labelKey: TranslationKey; icon: typeof Users }[] = [
  { href: "/admin", labelKey: "admin.nav.overview", icon: LayoutDashboard },
  { href: "/admin/users", labelKey: "admin.nav.users", icon: Users },
  { href: "/admin/shares", labelKey: "admin.nav.shares", icon: Share2 },
  { href: "/admin/email", labelKey: "admin.nav.email", icon: Mail },
  { href: "/admin/logs", labelKey: "admin.nav.logs", icon: ScrollText },
  { href: "/admin/settings", labelKey: "admin.nav.settings", icon: Sliders },
];

/**
 * The console frame: the tab rail plus the `.adm` scope that every admin page's
 * styling hangs off. Keeping the scope here rather than on each page means a new
 * route inherits the design language by existing.
 *
 * The active pill is a single shared `layoutId` element, so switching tabs slides
 * one pill instead of cross-fading two — the cheapest possible way to show where
 * you just came from.
 */
export function AdminTabs({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useT();

  return (
    <div className="adm">
      <nav className="adm-rail mb-5 sm:mb-6" aria-label={t("admin.nav.sections")}>
        {tabs.map((tab) => {
          const active =
            tab.href === "/admin" ? pathname === "/admin" : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="adm-rail__link"
              aria-current={active ? "page" : undefined}
            >
              {active && (
                <motion.span
                  layoutId="admin-tab-pill"
                  className="adm-rail__pill"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <tab.icon aria-hidden="true" />
              <span>{t(tab.labelKey)}</span>
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
