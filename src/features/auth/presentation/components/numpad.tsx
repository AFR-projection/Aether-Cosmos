"use client";

import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { Delete, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/lib/i18n";

/**
 * Numpad entry for the 2-Step Code layer. Shared by the verify screen and by
 * mid-login enrolment so the two can never drift apart visually.
 *
 * Design notes:
 * - The slot row is sized to `exactLength` when the account's own digit count is
 *   known, and only falls back to the full min–max range when it is not. Drawing
 *   ten slots for a six-digit code was read as "you have not finished typing".
 * - Every key is a real <button> in a grid, so keyboard tabbing and screen
 *   readers work without extra wiring; physical number keys are also bound.
 * - Keys are 56px+ tall (well past the 44px minimum) with 10px gaps, which is
 *   what makes this usable one-handed on a phone.
 * - Errors are signalled three ways — shake, red slots, and a role="alert"
 *   message — because motion and colour each fail for some users. Progress is
 *   mirrored in an aria-live line, so it is not conveyed by dots alone.
 * - Digits are never rendered; filled positions show as dots only.
 * - `keyOrder` is a prop rather than shuffled in here: randomising during render
 *   would differ between the server and client pass. The caller owns the order.
 */

const ORDERED_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;

export interface NumpadProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  minLength: number;
  maxLength: number;
  /**
   * The account's own digit count. When set (and inside min–max) the pad locks to
   * exactly this many slots and only submits on a full code.
   */
  exactLength?: number | null;
  /** Ten digits: the first nine fill the grid, the tenth sits centred below. */
  keyOrder?: readonly string[];
  /** Notes the shuffle in the frame header. The order itself comes from keyOrder. */
  shuffled?: boolean;
  /** Small monospace label in the frame header. Defaults to the translated one. */
  label?: string;
  /** Renders the shake + red state. Caller clears it on the next edit. */
  error?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** Defaults to the translated "Continue". */
  submitLabel?: string;
  loadingLabel?: string;
  /** Announced to assistive tech and shown under the slots. */
  message?: string;
  autoFocus?: boolean;
}

export function Numpad({
  value,
  onChange,
  onSubmit,
  minLength,
  maxLength,
  exactLength = null,
  keyOrder,
  shuffled = false,
  label,
  error = false,
  disabled = false,
  loading = false,
  submitLabel,
  loadingLabel,
  message,
  autoFocus = true,
}: NumpadProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusId = useId();
  const liveId = useId();
  const t = useT();
  // A default parameter cannot call a hook, so the translated defaults resolve here.
  const padLabel = label ?? t("auth.numpad.label");
  const primaryLabel = submitLabel ?? t("auth.continue");

  /**
   * A length outside the allowed range is ignored rather than trusted: a pad
   * locked to a length no code can have could never be submitted.
   */
  const locked =
    typeof exactLength === "number" &&
    Number.isInteger(exactLength) &&
    exactLength >= minLength &&
    exactLength <= maxLength
      ? exactLength
      : null;

  const cap = locked ?? maxLength;
  const filled = value.length;
  const slots = locked ?? Math.min(Math.max(minLength, filled), maxLength);
  const complete = locked ? filled === locked : filled >= minLength;
  const canSubmit = complete && !disabled && !loading;
  const inert = disabled || loading;

  const keys = useMemo(() => {
    const order =
      keyOrder && keyOrder.length === ORDERED_KEYS.length ? keyOrder : ORDERED_KEYS;
    return { grid: order.slice(0, 9), last: order[9] };
  }, [keyOrder]);

  const append = useCallback(
    (digit: string) => {
      if (inert) return;
      if (value.length >= cap) return;
      onChange(value + digit);
    },
    [value, cap, onChange, inert]
  );

  const backspace = useCallback(() => {
    if (inert) return;
    onChange(value.slice(0, -1));
  }, [value, onChange, inert]);

  // Physical keyboard support. Scoped to this component's subtree so it never
  // hijacks typing elsewhere on the page.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    function onKeyDown(e: KeyboardEvent) {
      if (inert) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        append(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        backspace();
      } else if (e.key === "Enter" && complete) {
        e.preventDefault();
        onSubmit();
      }
    }

    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [append, backspace, onSubmit, complete, inert]);

  useEffect(() => {
    if (autoFocus) containerRef.current?.focus();
  }, [autoFocus]);

  const progressText = locked
    ? t("auth.numpad.progressExact", { filled, total: locked })
    : t("auth.numpad.progressRange", { filled, min: minLength, max: maxLength });

  const shapeText = locked
    ? t("auth.numpad.shapeExact", { length: locked })
    : t("auth.numpad.shapeRange", { min: minLength, max: maxLength });

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="outline-none"
      role="group"
      aria-label={t("auth.numpad.groupLabel")}
      aria-describedby={`${statusId} ${liveId}`}
    >
      <div
        className={cn(
          "auth-code-display",
          error && "auth-code-display--error",
          complete && !error && "auth-code-display--complete"
        )}
      >
        <div className="auth-code-display__head">
          <span className="auth-code-display__label">{padLabel}</span>
          <span className="auth-code-display__meta">
            {locked ? `${filled} / ${locked}` : `${filled} / ${minLength}+`}
          </span>
        </div>

        {/* One slot per digit the code actually has, so a full row means a full
            code. Without a recorded length this falls back to the min plus a
            growing tail, capped at the maximum. */}
        <div
          className={cn(
            "auth-code-dots",
            slots > 8 && "auth-code-dots--dense",
            error && "auth-code-dots--error"
          )}
          aria-hidden="true"
        >
          {Array.from({ length: slots }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "auth-code-dot",
                i < filled && "auth-code-dot--filled",
                i < filled && error && "auth-code-dot--error",
                i === filled && !error && !inert && "auth-code-dot--next"
              )}
            />
          ))}
        </div>

        <div className="auth-code-status" id={statusId}>
          {message ? (
            <p role="alert" className={cn("auth-code-caption", error && "auth-error-text")}>
              {message}
            </p>
          ) : (
            <p className="auth-code-caption">
              {shapeText}
              {shuffled && (
                <span className="auth-code-caption__aside"> {t("auth.numpad.shuffled")}</span>
              )}
            </p>
          )}
        </div>

        {/* The dots are decorative to assistive tech, so progress is announced
            here instead. Kept out of the visible caption, which states the shape
            of the code rather than repeating the counter above. */}
        <p id={liveId} className="sr-only" aria-live="polite">
          {progressText}
        </p>
      </div>

      <div className="auth-numpad" role="group" aria-label={t("auth.numpad.keypadLabel")}>
        {keys.grid.map((key) => (
          <NumpadKey key={key} onPress={() => append(key)} disabled={inert}>
            {key}
          </NumpadKey>
        ))}

        {/* Bottom row: the tenth key is centred with a backspace to its right and
            a deliberately empty cell to its left, matching every phone keypad. */}
        <span aria-hidden="true" />
        <NumpadKey onPress={() => append(keys.last)} disabled={inert}>
          {keys.last}
        </NumpadKey>
        <NumpadKey
          onPress={backspace}
          disabled={inert || filled === 0}
          label={t("auth.numpad.deleteLast")}
          variant="muted"
        >
          <Delete className="h-5 w-5" aria-hidden="true" />
        </NumpadKey>
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        aria-busy={loading}
        className="auth-primary-button auth-code-submit"
      >
        {loading ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            <span>{loadingLabel ?? primaryLabel}</span>
          </>
        ) : (
          <>
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            <span>{primaryLabel}</span>
          </>
        )}
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
