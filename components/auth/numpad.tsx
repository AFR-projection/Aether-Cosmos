"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Delete, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Numpad entry for the 2-Step Code layer.
 *
 * Design notes:
 * - Every key is a real <button> in a grid, so keyboard tabbing and screen
 *   readers work without extra wiring; physical number keys are also bound.
 * - Keys are 56px tall (well past the 44px minimum) with 12px gaps, which is
 *   what makes this usable one-handed on a phone.
 * - Errors are signalled three ways — shake, red dots, and a role="alert"
 *   message — because motion and colour each fail for some users.
 * - Digits are never rendered; filled positions show as dots only.
 */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export interface NumpadProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  minLength: number;
  maxLength: number;
  /** Renders the shake + red state. Caller clears it on the next edit. */
  error?: boolean;
  disabled?: boolean;
  loading?: boolean;
  submitLabel?: string;
  /** Announced to assistive tech and shown under the dots. */
  message?: string;
  autoFocus?: boolean;
}

export function Numpad({
  value,
  onChange,
  onSubmit,
  minLength,
  maxLength,
  error = false,
  disabled = false,
  loading = false,
  submitLabel = "Continue",
  message,
  autoFocus = true,
}: NumpadProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dotsId = useId();
  const canSubmit = value.length >= minLength && !disabled && !loading;

  const append = useCallback(
    (digit: string) => {
      if (disabled || loading) return;
      if (value.length >= maxLength) return;
      onChange(value + digit);
    },
    [value, maxLength, onChange, disabled, loading]
  );

  const backspace = useCallback(() => {
    if (disabled || loading) return;
    onChange(value.slice(0, -1));
  }, [value, onChange, disabled, loading]);

  // Physical keyboard support. Scoped to this component's subtree so it never
  // hijacks typing elsewhere on the page.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    function onKeyDown(e: KeyboardEvent) {
      if (disabled || loading) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        append(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        backspace();
      } else if (e.key === "Enter" && value.length >= minLength) {
        e.preventDefault();
        onSubmit();
      }
    }

    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [append, backspace, onSubmit, value.length, minLength, disabled, loading]);

  useEffect(() => {
    if (autoFocus) containerRef.current?.focus();
  }, [autoFocus]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="outline-none"
      role="group"
      aria-label="2-Step Code entry"
      aria-describedby={dotsId}
    >
      {/* Progress dots — one per possible position up to the minimum, then a
          growing tail so a longer code still reads as progress. */}
      <div
        className={cn("flex justify-center gap-2.5 py-1", error && "animate-shake")}
        aria-hidden="true"
      >
        {Array.from({ length: Math.max(minLength, value.length) }).map((_, i) => {
          const filled = i < value.length;
          return (
            <span
              key={i}
              className={cn(
                "h-3 w-3 rounded-full border-2 transition-[background-color,border-color,transform] duration-150",
                filled
                  ? error
                    ? "scale-110 border-danger bg-danger"
                    : "scale-110 border-accent bg-accent"
                  : "border-border bg-transparent"
              )}
            />
          );
        })}
      </div>

      <p id={dotsId} className="sr-only">
        {value.length} of at least {minLength} digits entered
      </p>

      <div className="mt-3 min-h-[2.5rem] px-2 text-center">
        {message ? (
          <p
            role="alert"
            className={cn(
              "text-sm leading-snug",
              error ? "font-medium text-danger" : "text-muted-foreground"
            )}
          >
            {message}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/70">
            {minLength}–{maxLength} digits
          </p>
        )}
      </div>

      <div className="mx-auto mt-4 grid max-w-[280px] grid-cols-3 gap-3">
        {KEYS.map((key) => (
          <NumpadKey key={key} onPress={() => append(key)} disabled={disabled || loading}>
            {key}
          </NumpadKey>
        ))}

        {/* Bottom row: the 0 key is centred with a backspace to its right and a
            deliberately empty cell to its left, matching every phone keypad. */}
        <span aria-hidden="true" />
        <NumpadKey onPress={() => append("0")} disabled={disabled || loading}>
          0
        </NumpadKey>
        <NumpadKey
          onPress={backspace}
          disabled={disabled || loading || value.length === 0}
          label="Delete last digit"
          variant="muted"
        >
          <Delete className="h-5 w-5" aria-hidden="true" />
        </NumpadKey>
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className={cn(
          "mx-auto mt-6 flex h-12 w-full max-w-[280px] items-center justify-center gap-2 rounded-xl",
          "bg-accent text-base font-semibold text-white shadow-sm",
          "transition-[background-color,opacity,transform] duration-150",
          "hover:bg-accent/90 active:scale-[0.98]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
          "motion-reduce:transition-none motion-reduce:active:scale-100"
        )}
      >
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        )}
        {submitLabel}
      </button>
    </div>
  );
}

function NumpadKey({
  children,
  onPress,
  disabled,
  label,
  variant = "default",
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  label?: string;
  variant?: "default" | "muted";
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "flex h-14 items-center justify-center rounded-xl border text-xl font-semibold tabular-nums",
        "transition-[background-color,border-color,transform] duration-150",
        "active:scale-[0.96]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100",
        "motion-reduce:transition-none motion-reduce:active:scale-100",
        variant === "muted"
          ? "border-transparent bg-transparent text-muted-foreground hover:bg-surface-hover"
          : "border-border/60 bg-surface hover:border-accent/40 hover:bg-surface-hover"
      )}
    >
      {children}
    </button>
  );
}
