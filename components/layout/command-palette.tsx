"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Search, FileText, FolderOpen, LayoutDashboard, Star, Command, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api/client";


export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; name: string; mimeType: string }>>([]);
  const router = useRouter();

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    const res = await apiFetch<{ files: Array<{ id: string; name: string; mimeType: string }> }>(
      `/api/search?q=${encodeURIComponent(q)}&limit=8`
    );
    setResults(res.data?.files ?? []);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(query), 300);
    return () => clearTimeout(t);
  }, [query, search]);

  const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, desc: "Overview & stats" },
    { href: "/files", label: "Files", icon: FolderOpen, desc: "Browse and manage files" },
    { href: "/favorites", label: "Favorites", icon: Star, desc: "Starred items" },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="scrim fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.93, opacity: 0, y: -8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.93, opacity: 0, y: -8 }}
            transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
            className="w-full max-w-xl rounded-2xl border border-border/50 bg-surface-elevated shadow-2xl shadow-black/20 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 border-b border-border/40 px-5">
              <Search className="h-4 w-4 text-muted-foreground/50 shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search files or navigate..."
                className="flex-1 bg-transparent py-4 text-sm outline-none placeholder:text-muted-foreground/40"
              />
              <kbd className="shrink-0 flex items-center gap-1 rounded-lg border border-border/40 bg-surface/50 px-2 py-1 text-[10px] font-medium text-muted-foreground/60">
                <Command className="h-2.5 w-2.5" />K
              </kbd>
            </div>

            <div className="max-h-80 overflow-auto p-2">
              {/* Navigation section */}
              {!query && (
                <div className="mb-2">
                  <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                    Navigation
                  </p>
                  {navItems.map((item) => (
                    <button
                      key={item.href}
                      className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-accent/5 transition-colors"
                      onClick={() => { router.push(item.href); setOpen(false); }}
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                        <item.icon className="h-4 w-4 text-accent" />
                      </div>
                      <div className="flex-1 text-left">
                        <p className="font-medium">{item.label}</p>
                        <p className="text-xs text-muted-foreground/60">{item.desc}</p>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {/* Search results */}
              {query && results.length > 0 && (
                <div>
                  <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                    Files
                  </p>
                  {results.map((file, idx) => (
                    <motion.button
                      key={file.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.025 }}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-accent/5 transition-colors"
                      onClick={() => { router.push(`/files?select=${file.id}`); setOpen(false); }}
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                        <FileText className="h-4 w-4 text-accent" />
                      </div>
                      <span className="truncate font-medium">{file.name}</span>
                    </motion.button>
                  ))}
                </div>
              )}

              {/* Empty state */}
              {query && results.length === 0 && (
                <div className="flex flex-col items-center py-10 text-muted-foreground">
                  <FileText className="h-8 w-8 text-muted-foreground/20 mb-2" />
                  <p className="text-sm font-medium">No results found</p>
                  <p className="text-xs text-muted-foreground/50">Try a different search term</p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-4 border-t border-border/30 px-5 py-2.5 text-[10px] text-muted-foreground/40">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border/30 px-1.5 py-0.5 text-[9px] font-medium">ESC</kbd>
                close
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border/30 px-1.5 py-0.5 text-[9px] font-medium">↑↓</kbd>
                navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border/30 px-1.5 py-0.5 text-[9px] font-medium">↵</kbd>
                select
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}