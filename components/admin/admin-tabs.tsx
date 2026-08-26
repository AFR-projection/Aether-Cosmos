"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { LayoutDashboard, Users, ScrollText, Sliders, Share2, Mail } from "lucide-react";

const tabs = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/shares", label: "Shares", icon: Share2 },
  { href: "/admin/email", label: "Email", icon: Mail },
  { href: "/admin/logs", label: "Logs", icon: ScrollText },
  { href: "/admin/settings", label: "Settings", icon: Sliders },
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

  return (
    <div className="adm">
      <nav className="adm-rail mb-5 sm:mb-6" aria-label="Admin sections">
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
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
