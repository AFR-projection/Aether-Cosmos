"use client";

import { useCallback, useEffect, useId, useRef } from "react";
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
      <div className={cn("auth-code-dots", error && "auth-code-dots--error")} aria-hidden="true">
        {Array.from({ length: Math.max(minLength, value.length) }).map((_, i) => {
          const filled = i < value.length;
          return (
            <span
              key={i}
              className={cn(
                "auth-code-dot",
                filled && "auth-code-dot--filled",
                filled && error && "auth-code-dot--error"
              )}
            />
          );
        })}
      </div>

      <p id={dotsId} className="sr-only">
        {value.length} of at least {minLength} digits entered
      </p>

      <div className="auth-code-caption mt-3 min-h-[2.5rem] px-2 text-center">
        {message ? (
          <p role="alert" className={cn(error && "auth-error-text")}>
            {message}
          </p>
        ) : (
          <p>{minLength}–{maxLength} digits</p>
        )}
      </div>

      <div className="auth-numpad mt-4">
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
        className="auth-primary-button auth-code-submit"
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
          "auth-numpad-button",
          variant === "muted" && "auth-numpad-button--muted"
        )}
    >
      {children}
    </button>
  );
}
