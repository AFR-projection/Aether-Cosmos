"use client";

import { useEffect, useState } from "react";

/**
 * Trailing-edge debounce for search inputs.
 *
 * Search terms feed straight into react-query keys, so without this every
 * keystroke is its own request — and on the Brain that means a full-text query
 * plus a rate-limit check per character.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
