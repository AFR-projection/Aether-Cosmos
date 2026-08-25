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
import { cn } from "@/lib/utils";
import { useActiveBrain } from "@/hooks/use-brain";
import { openGraphPopup } from "@/lib/brain/graph/links";
import { notify } from "@/lib/system/notify-store";
import { BrainSelector } from "./brain-selector";

type NavSection = {
  href: string;
  label: string;
  icon: typeof Sparkles;
  exact?: boolean;
  /** Double-click also opens the standalone graph window. */
  popOut?: boolean;
};

const sections: NavSection[] = [
  { href: "/brain", label: "Overview", icon: Sparkles, exact: true },
  { href: "/brain/memories", label: "Memories", icon: BrainIcon },
  { href: "/brain/projects", label: "Projects", icon: FolderKanban },
  { href: "/brain/graph", label: "Graph", icon: Network, popOut: true },
  { href: "/brain/agents", label: "Agents", icon: Boxes },
  { href: "/brain/activity", label: "Activity", icon: ScrollText },
  { href: "/brain/settings", label: "Settings", icon: Settings2 },
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

  return (
    <div className="brain-page mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <header className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="brain-kicker">
              <BrainIcon aria-hidden="true" />
              Second Brain
            </p>
            <h1 className="brain-title">{title}</h1>
            {description && <p className="brain-lede">{description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BrainSelector brain={brain} brains={brains} onSelect={select} />
            {actions}
          </div>
        </div>

        <nav aria-label="Second Brain sections" className="-mx-1 overflow-x-auto no-scrollbar">
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
                                title: "Allow pop-ups for this site to open the graph window",
                                tone: "error",
                              });
                            }
                          }
                        : undefined
                    }
                    title={
                      section.popOut
                        ? "Double-click to open the graph in its own window"
                        : undefined
                    }
                    className={cn(
                      "brain-rail__link",
                      // Without this a double-click highlights the label text.
                      section.popOut && "select-none"
                    )}
                  >
                    <Icon aria-hidden="true" />
                    {section.label}
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
