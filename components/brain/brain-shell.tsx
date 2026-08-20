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
import { BrainSelector } from "./brain-selector";

const sections = [
  { href: "/brain", label: "Overview", icon: Sparkles, exact: true },
  { href: "/brain/memories", label: "Memories", icon: BrainIcon },
  { href: "/brain/projects", label: "Projects", icon: FolderKanban },
  { href: "/brain/graph", label: "Graph", icon: Network },
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
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <BrainIcon className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              Second Brain
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {title}
            </h1>
            {description && (
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BrainSelector brain={brain} brains={brains} onSelect={select} />
            {actions}
          </div>
        </div>

        <nav aria-label="Second Brain sections" className="-mx-1 overflow-x-auto">
          <ul className="flex min-w-max items-center gap-1 px-1">
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
                    className={cn(
                      "flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-accent/10 text-accent"
                        : "text-muted-foreground hover:bg-accent/5 hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
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
