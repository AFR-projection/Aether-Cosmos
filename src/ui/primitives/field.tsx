"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export interface FieldChildProps {
  /** Put this on the control so the label actually points at it. */
  id: string;
  /** Wire onto the control so hint and error are announced with it. */
  "aria-describedby": string | undefined;
  "aria-invalid": boolean | undefined;
}

interface FieldProps {
  label: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  optional?: boolean;
  className?: string;
  /**
   * Render prop rather than a wrapper: the control is the only thing that can
   * own the generated id, and a wrapper cannot guarantee it received one.
   */
  children: (props: FieldChildProps) => React.ReactNode;
}

/** Label + control + hint/error, with the aria wiring done once. */
export function Field({ label, hint, error, optional, className, children }: FieldProps) {
  const uid = React.useId();
  const id = `${uid}-control`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        {label}
        {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
      </label>
      {children({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-xs text-danger-ink">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : (
        hint && (
          <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
