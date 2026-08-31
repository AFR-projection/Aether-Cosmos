"use client";

import Link from "next/link";
import { Brain, Check, Files, ShieldCheck, Share2, Sparkles, X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

import { Button } from "@/ui/primitives/button";
import { useT } from "@/shared/lib/i18n";

const EVENT = "aether:onboarding";

const STEPS = [
  { id: "files", href: "/files", match: "/files", icon: Files, title: "onboarding.filesTitle", body: "onboarding.filesBody" },
  { id: "share", href: "/shares", match: "/shares", icon: Share2, title: "onboarding.shareTitle", body: "onboarding.shareBody" },
  { id: "security", href: "/settings", match: "/settings", icon: ShieldCheck, title: "onboarding.securityTitle", body: "onboarding.securityBody" },
  { id: "brain", href: "/brain", match: "/brain", icon: Brain, title: "onboarding.brainTitle", body: "onboarding.brainBody" },
] as const;

type State = { dismissed: boolean; completed: string[] };
const EMPTY: State = { dismissed: false, completed: [] };

function key(scopeId: string) {
  return `aether_onboarding:${scopeId}`;
}

function decode(value: string | null): State {
  try {
    const parsed = JSON.parse(value ?? "null") as Partial<State> | null;
    return {
      dismissed: parsed?.dismissed === true,
      completed: Array.isArray(parsed?.completed)
        ? parsed.completed.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return EMPTY;
  }
}

function snapshot(scopeId: string): string {
  if (typeof window === "undefined") return "";
  try { return localStorage.getItem(key(scopeId)) ?? ""; } catch { return ""; }
}

function read(scopeId: string): State {
  return decode(snapshot(scopeId));
}

function write(scopeId: string, state: State) {
  try {
    localStorage.setItem(key(scopeId), JSON.stringify(state));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // Storage may be disabled or full. Onboarding must never break navigation.
  }
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function OnboardingChecklist({ scopeId }: { scopeId: string }) {
  const pathname = usePathname();
  const t = useT();
  const serialized = useSyncExternalStore(subscribe, () => snapshot(scopeId), () => "");
  const state = decode(serialized);

  useEffect(() => {
    const step = STEPS.find((candidate) => pathname.startsWith(candidate.match));
    if (!step) return;
    const current = read(scopeId);
    if (current.completed.includes(step.id)) return;
    write(scopeId, { ...current, completed: [...current.completed, step.id] });
  }, [pathname, scopeId]);

  if (pathname !== "/dashboard" || state.dismissed) return null;

  const completed = STEPS.filter((step) => state.completed.includes(step.id)).length;
  const finished = completed === STEPS.length;

  return (
    <section
      aria-labelledby="onboarding-title"
      className="mx-auto mb-5 w-full max-w-7xl px-4 pt-4 sm:px-6"
    >
      <div className="rounded-2xl border border-accent/25 bg-gradient-to-br from-accent/10 via-surface to-surface p-4 shadow-sm sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent-ink" aria-hidden="true">
            <Sparkles className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="onboarding-title" className="text-base font-semibold">{finished ? t("onboarding.doneTitle") : t("onboarding.title")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{finished ? t("onboarding.doneBody") : t("onboarding.body")}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0"
            aria-label={t("onboarding.dismiss")}
            onClick={() => write(scopeId, { ...state, dismissed: true })}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <p className="mt-4 text-xs font-medium text-muted-foreground" aria-live="polite">
          {t("onboarding.progress", { count: completed, total: STEPS.length })}
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(completed / STEPS.length) * 100}%` }} />
        </div>

        <ul className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((step) => {
            const done = state.completed.includes(step.id);
            const Icon = step.icon;
            return (
              <li key={step.id}>
                <Link
                  href={step.href}
                  className="flex min-h-20 items-start gap-3 rounded-xl border border-border/60 bg-background/60 p-3 transition-colors hover:border-accent/40 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  aria-label={`${t(step.title)}${done ? ` — ${t("onboarding.completed")}` : ""}`}
                >
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${done ? "bg-success/15 text-success-ink" : "bg-muted text-muted-foreground"}`} aria-hidden="true">
                    {done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{t(step.title)}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t(step.body)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
