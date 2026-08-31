"use client";

import type { LucideIcon } from "lucide-react";
import { Check as CheckIcon, Minus } from "lucide-react";
import { useT } from "@/shared/lib/i18n";
import { cn } from "@/shared/lib/utils";

/**
 * The admin console design system.
 *
 * Every /admin page is built from these primitives so the six routes read as one
 * product rather than six. The rules they encode:
 *
 * - **Colour means something.** A tone is one of six semantic values, never a raw
 *   palette hue. It travels as a `data-tone` attribute because the CSS that
 *   consumes it is unlayered and would otherwise lose to a Tailwind utility.
 * - **Numbers are mono and tabular.** These pages poll every 10–30s; a figure
 *   that changes width mid-poll drags the whole row with it.
 * - **State is never colour alone.** Dots ship with labels, filters with
 *   `aria-pressed`, meters with a written value next to them.
 *
 * Layout and spacing stay here as Tailwind utilities. Only what Tailwind cannot
 * express — sticky table chrome, drawn checkboxes, meters, tone maths — lives in
 * the `.adm-*` block in `app/globals.css`.
 */
export type Tone = "accent" | "success" | "warning" | "danger" | "info" | "muted";

/* ── Page header ─────────────────────────────────────────────────────────── */

export function AdminHeader({
  icon: Icon,
  kicker,
  title,
  lede,
  live,
  liveLabel,
  liveTone = "success",
  actions,
  className,
}: {
  icon?: LucideIcon;
  kicker?: string;
  title: string;
  lede?: string;
  live?: boolean;
  liveLabel?: string;
  liveTone?: Tone;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {kicker && (
          <p className="adm-kicker">
            {Icon && <Icon aria-hidden="true" />}
            {kicker}
          </p>
        )}
        <h1 className="adm-title">{title}</h1>
        {lede && <p className="adm-lede">{lede}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {live && <LiveBadge label={liveLabel} tone={liveTone} />}
        {actions}
      </div>
    </header>
  );
}

/** Pulsing "this data refreshes itself" badge. The label carries the meaning. */
export function LiveBadge({ label, tone = "success" }: { label?: string; tone?: Tone }) {
  const t = useT();
  return (
    <span className="adm-live" data-tone={tone}>
      <span className="adm-live__dot" aria-hidden="true" />
      {label ?? t("admin.ui.live")}
    </span>
  );
}

/* ── Metric tile ─────────────────────────────────────────────────────────── */

/**
 * One number, told once. Replaces four separate stat-card implementations that
 * each carried their own gradient bar and hardcoded hue.
 *
 * Pass `onClick` and it becomes a filter toggle — the users page uses the tiles
 * above its table as the primary way to narrow it, so the tile has to be a real
 * button with `aria-pressed`, not a div with a handler.
 */
export function AdminMetric({
  icon: Icon,
  label,
  value,
  unit,
  hint,
  tone = "accent",
  onClick,
  pressed,
  className,
}: {
  icon?: LucideIcon;
  label: string;
  value: React.ReactNode;
  unit?: string;
  hint?: React.ReactNode;
  tone?: Tone;
  onClick?: () => void;
  pressed?: boolean;
  className?: string;
}) {
  const inner = (
    <>
      <span className="adm-metric__label">
        {Icon && <Icon aria-hidden="true" />}
        {label}
      </span>
      <span className="adm-metric__value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {hint && <span className="adm-metric__hint">{hint}</span>}
    </>
  );

  if (!onClick) {
    return (
      <div className={cn("adm-metric", className)} data-tone={tone}>
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn("adm-metric", className)}
      data-tone={tone}
    >
      {inner}
    </button>
  );
}


/* ── Small parts ─────────────────────────────────────────────────────────── */

export function Chip({
  icon: Icon,
  tone,
  mono,
  children,
  className,
}: {
  icon?: LucideIcon;
  tone?: Tone;
  mono?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("adm-chip", mono && "adm-chip--mono", className)} data-tone={tone}>
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * A status dot. Always rendered next to its own text label — on a console where
 * suspended, offline and rate-limited all matter, colour cannot be the only
 * channel. `ring` adds the live ripple, which stops under reduced-motion.
 */
export function StatusDot({
  presence,
  tone,
  ring,
  className,
}: {
  presence?: "live" | "idle" | "dormant" | "never" | "revoked";
  tone?: Tone;
  ring?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("adm-dot", ring && "adm-dot--ring", className)}
      data-presence={presence}
      data-tone={tone}
      aria-hidden="true"
    />
  );
}

/** Quota / limit bar. `value` is 0..1; the caller states the number in text too. */
export function Meter({ value, tone = "accent", className }: { value: number; tone?: Tone; className?: string }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className={cn("adm-meter", className)} data-tone={tone} aria-hidden="true">
      <div className="adm-meter__fill" style={{ "--v": v } as React.CSSProperties} />
    </div>
  );
}


export function AdminPanel({
  icon: Icon,
  title,
  sub,
  tone = "accent",
  tools,
  children,
  className,
  bodyClassName,
  flush,
  tight,
  variant,
}: {
  icon?: LucideIcon;
  title?: string;
  sub?: string;
  tone?: Tone;
  tools?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Body takes no padding — for tables and full-bleed lists. */
  flush?: boolean;
  tight?: boolean;
  variant?: "warn" | "danger";
}) {
  return (
    <section
      className={cn(
        "adm-panel",
        variant === "warn" && "adm-panel--warn",
        variant === "danger" && "adm-panel--danger",
        className
      )}
    >
      {(title || tools) && (
        <div className="adm-panel__head">
          {Icon && (
            <span className="adm-panel__badge" data-tone={tone} aria-hidden="true">
              <Icon />
            </span>
          )}
          {title && (
            <div className="min-w-0">
              <h2 className="adm-panel__title">{title}</h2>
              {sub && <p className="adm-panel__sub">{sub}</p>}
            </div>
          )}
          {tools && <div className="adm-panel__tools">{tools}</div>}
        </div>
      )}
      <div
        className={cn(
          "adm-panel__body",
          flush && "adm-panel__body--flush",
          tight && "adm-panel__body--tight",
          bodyClassName
        )}
      >
        {children}
      </div>
    </section>
  );
}

/* ── Controls ────────────────────────────────────────────────────────────── */

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  icon: Icon,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  icon?: LucideIcon;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("adm-search", className)}>
      {Icon && <Icon aria-hidden="true" />}
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? t("admin.ui.searchPlaceholder")}
        aria-label={label}
      />
    </div>
  );
}

/**
 * Segmented control. `role="group"` with `aria-pressed` buttons, not a tablist —
 * nothing here owns a tabpanel, and claiming otherwise breaks screen-reader
 * navigation.
 */
export function Segment<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: LucideIcon; count?: number }[];
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("adm-seg", className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="adm-seg__btn"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <option.icon aria-hidden="true" />}
          {option.label}
          {option.count !== undefined && <span className="adm-num">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function FilterChip({
  icon: Icon,
  tone,
  active,
  onClick,
  children,
  title,
}: {
  icon?: LucideIcon;
  tone?: Tone;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="adm-filter"
      data-tone={tone}
      aria-pressed={active}
      onClick={onClick}
      title={title}
    >
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * Drawn checkbox. The native control stays in the DOM (so keyboard, form and
 * a11y semantics are the browser's), but the box is ours — the default is both
 * off-palette and too small to hit on a phone.
 */
export function Check({
  checked,
  indeterminate,
  onChange,
  label,
  showLabel,
  disabled,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={cn("adm-check", className)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={showLabel ? undefined : label}
        ref={(node) => {
          if (node) node.indeterminate = !!indeterminate && !checked;
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="adm-check__box" aria-hidden="true">
        {indeterminate && !checked ? <Minus /> : <CheckIcon />}
      </span>
      {showLabel && <span className="adm-check__label">{label}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="adm-switch"
    >
      <span className="adm-switch__thumb" aria-hidden="true" />
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  tone,
  onClick,
  disabled,
  className,
}: {
  icon: LucideIcon;
  label: string;
  tone?: Tone;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn("adm-iconbtn", className)}
      data-tone={tone}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

export function Note({
  icon: Icon,
  tone = "info",
  children,
  className,
}: {
  icon?: LucideIcon;
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("adm-note", className)} data-tone={tone}>
      {Icon && <Icon aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

/* ── States ──────────────────────────────────────────────────────────────── */

export function AdminEmpty({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="adm-empty">
      <span className="adm-empty__icon">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="adm-empty__title">{title}</p>
      {body && <p className="adm-empty__body">{body}</p>}
      {action}
    </div>
  );
}

/**
 * Loading placeholder. Takes the height of the thing it stands in for, because a
 * page that polls cannot afford to shift layout every time data lands.
 */
export function Skeleton({ className, rows = 1 }: { className?: string; rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className={cn("adm-skel h-4 w-full", className)} />
      ))}
    </div>
  );
}

/** Initial disc with an optional presence pip. Master accounts read amber. */
export function Avatar({
  name,
  presence,
  master,
  className,
}: {
  name: string;
  presence?: "live" | "idle" | "dormant" | "never" | "revoked";
  master?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("adm-avatar", master && "adm-avatar--master", className)}
      data-presence={presence}
      aria-hidden="true"
    >
      {name.charAt(0) || "?"}
    </span>
  );
}
