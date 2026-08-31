"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  Brain as BrainIcon,
  FolderKanban,
  Network,
  ScrollText,
  Settings2,
  Sparkles,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useT, type TranslationKey } from "@/shared/lib/i18n";
import { useActiveBrain } from "@brain/presentation/hooks/use-brain";
import { openGraphPopup } from "@brain/presentation/canvas/links";
import { notify } from "@/shared/lib/system/notify-store";
import { BrainSelector } from "./brain-selector";

type NavSection = {
  href: string;
  labelKey: TranslationKey;
  icon: typeof Sparkles;
  exact?: boolean;
  /** Double-click also opens the standalone graph window. */
  popOut?: boolean;
};

const sections: NavSection[] = [
  { href: "/brain", labelKey: "brain.nav.overview", icon: Sparkles, exact: true },
  { href: "/brain/memories", labelKey: "brain.nav.memories", icon: BrainIcon },
  { href: "/brain/projects", labelKey: "brain.nav.projects", icon: FolderKanban },
  { href: "/brain/graph", labelKey: "brain.nav.graph", icon: Network, popOut: true },
  { href: "/brain/agents", labelKey: "brain.nav.agents", icon: Boxes },
  { href: "/brain/activity", labelKey: "brain.nav.activity", icon: ScrollText },
  { href: "/brain/settings", labelKey: "brain.nav.settings", icon: Settings2 },
];

/**
 * Shared chrome for every /brain page: heading, brain selector, section tabs.
 * Each page renders its own body inside, so a page stays one concern.
 */
export function BrainShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { brain, brains, select } = useActiveBrain();
  const t = useT();

  return (
    <div className="brain-page mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <header className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="brain-kicker">
              <BrainIcon aria-hidden="true" />
              {t("brain.kicker")}
            </p>
            <h1 className="brain-title">{title}</h1>
            {description && <p className="brain-lede">{description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BrainSelector brain={brain} brains={brains} onSelect={select} />
            {actions}
          </div>
        </div>

        <nav
          aria-label={t("brain.nav.label")}
          className="-mx-1 overflow-x-auto no-scrollbar"
        >
          <ul className="brain-rail mx-1 min-w-max">
            {sections.map((section) => {
              const Icon = section.icon;
              const active = section.exact
                ? pathname === section.href
                : pathname.startsWith(section.href);
              return (
                <li key={section.href}>
                  <Link
                    href={section.href}
                    aria-current={active ? "page" : undefined}
                    // Double-click is a shortcut, not the only way in: the graph page
                    // itself carries a pop-out button, so nothing depends on knowing
                    // this exists. The single click still navigates.
                    onDoubleClick={
                      section.popOut
                        ? (event) => {
                            event.preventDefault();
                            if (!openGraphPopup(brain?.id)) {
                              notify({
                                title: t("brain.nav.popupBlocked"),
                                tone: "error",
                              });
                            }
                          }
                        : undefined
                    }
                    title={section.popOut ? t("brain.nav.popOutHint") : undefined}
                    className={cn(
                      "brain-rail__link",
                      // Without this a double-click highlights the label text.
                      section.popOut && "select-none"
                    )}
                  >
                    <Icon aria-hidden="true" />
                    {t(section.labelKey)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      <div className="mt-6">{children}</div>
    </div>
  );
}
