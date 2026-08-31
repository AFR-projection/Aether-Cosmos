"use client";

import { useSyncExternalStore } from "react";

/**
 * Lite mode — a graceful degradation tier for low-end devices and slow links.
 *
 * When active, the app drops the effects that cost the most on weak mobile
 * GPUs (backdrop blur, decorative infinite animations) and asks the server for
 * smaller thumbnails. Layout, spacing, typography and colour stay identical, so
 * the interface still reads as the same premium product — it just stops paying
 * for effects the device cannot afford.
 *
 * Resolution order: explicit user preference > automatic device detection.
 */

export type LitePreference = "auto" | "on" | "off";

const STORAGE_KEY = "lite_mode";
const EVENT = "lite-mode-change";

/** Kept in sync with the inline boot script in app/layout.tsx. */
export const LITE_CLASS = "lite";

type NetworkInformation = {
  saveData?: boolean;
  effectiveType?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function getConnection(): NetworkInformation | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: NetworkInformation }).connection;
}

/**
 * Heuristic for "this device or link will struggle". Deliberately conservative:
 * a 4 GB / 8-core phone on Wi-Fi is not downgraded, but a 2 GB phone, a
 * 4 GB phone with a weak CPU, a 3G link, or an explicit Data Saver is.
 */
export function detectLowEndDevice(): boolean {
  if (typeof navigator === "undefined") return false;

  const connection = getConnection();
  if (connection?.saveData) return true;
  if (
    connection?.effectiveType &&
    ["slow-2g", "2g", "3g"].includes(connection.effectiveType)
  ) {
    return true;
  }

  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency;

  if (typeof memory === "number" && memory <= 2) return true;
  if (typeof memory === "number" && memory <= 4 && typeof cores === "number" && cores <= 4) {
    return true;
  }

  return false;
}

export function getLitePreference(): LitePreference {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "on" || stored === "off" ? stored : "auto";
  } catch {
    return "auto";
  }
}

/** Resolved answer: is lite mode active right now? */
export function isLiteMode(): boolean {
  if (typeof window === "undefined") return false;
  const preference = getLitePreference();
  if (preference === "on") return true;
  if (preference === "off") return false;
  return detectLowEndDevice();
}

function applyLiteClass(enabled: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(LITE_CLASS, enabled);
}

export function setLitePreference(preference: LitePreference): void {
  try {
    if (preference === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // storage unavailable — keep the in-memory result for this session
  }
  applyLiteClass(isLiteMode());
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onChange = () => {
    applyLiteClass(isLiteMode());
    callback();
  };

  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  const connection = getConnection();
  connection?.addEventListener?.("change", onChange);

  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
    connection?.removeEventListener?.("change", onChange);
  };
}

/** Reactive resolved state. Returns false during SSR and first paint. */
export function useLiteMode(): boolean {
  return useSyncExternalStore(subscribe, isLiteMode, () => false);
}

/** Reactive user preference — for the Settings toggle. */
export function useLitePreference(): LitePreference {
  return useSyncExternalStore(subscribe, getLitePreference, () => "auto");
}
