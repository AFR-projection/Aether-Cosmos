"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import {
  getSystemBusy,
  setNavigationBusy,
  subscribeSystemBusy,
} from "@/lib/system/notify-store";

/** Thin top progress bar for route changes + in-flight API activity. */
export function PageProgressBar() {
  const pathname = usePathname();
  const prevPath = useRef(pathname);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const busy = useSyncExternalStore(subscribeSystemBusy, getSystemBusy, () => false);

  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    setNavigationBusy(true);
    if (finishTimer.current) clearTimeout(finishTimer.current);
    finishTimer.current = setTimeout(() => setNavigationBusy(false), 420);
    return () => {
      if (finishTimer.current) clearTimeout(finishTimer.current);
      // Busy is global state, so dropping the timer is not enough: unmounting
      // mid-navigation would otherwise leave the app "loading" for good.
      setNavigationBusy(false);
    };
  }, [pathname]);

  return (
    // 130 sits above the toast tier on purpose — see the LAYER scale in
    // components/ui/modal.tsx. Only the offline overlay (200) covers it.
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[130] h-[2px] overflow-hidden"
      aria-hidden
    >
      <div
        className={cn(
          "h-full origin-left bg-gradient-to-r from-accent via-info to-success",
          "transition-[transform,opacity] duration-300 ease-out",
          busy ? "page-progress-active opacity-100" : "scale-x-0 opacity-0"
        )}
      />
      {/* Glowing comet head that streaks ahead of the bar while busy. Its paint
          lives in globals.css so the highlight can follow the theme. */}
      {busy && <span className="page-progress-comet absolute top-0 h-full w-24" />}
    </div>
  );
}
