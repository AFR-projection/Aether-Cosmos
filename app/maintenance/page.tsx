"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Wrench, Cloud } from "lucide-react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/client";

export default function MaintenancePage() {
  const [message, setMessage] = useState("System is under maintenance. Please check back later.");

  useEffect(() => {
    apiFetch<{ maintenanceMode: boolean; maintenanceMessage: string }>("/api/auth/maintenance").then(
      (res) => {
        if (res.success && res.data?.maintenanceMessage) {
          setMessage(res.data.maintenanceMessage);
        }
      }
    );
  }, []);

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-2xl border border-border/60 bg-surface/80 p-8 text-center shadow-xl backdrop-blur-xl"
      >
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-500">
          <Wrench className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Under maintenance</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{message}</p>
        <Link
          href="/login"
          className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-accent-ink hover:underline"
        >
          <Cloud className="h-4 w-4" /> Back to sign in
        </Link>
      </motion.div>
    </div>
  );
}
