"use client";

import { useState, useEffect } from "react";

type PreviewSourceState = {
  arrayBuffer: ArrayBuffer | null;
  blobUrl: string | null;
  loading: boolean;
  error: string | null;
};

/**
 * Fetch file bytes for in-browser preview. Uses session cookies for API routes
 * and supports pre-decrypted blob: URLs for encrypted files.
 */
export function usePreviewSource(src: string | null): PreviewSourceState {
  const [arrayBuffer, setArrayBuffer] = useState<ArrayBuffer | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!src);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setArrayBuffer(null);
      setBlobUrl(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let ownedBlobUrl: string | null = null;

    const url = src;
    async function load() {
      setLoading(true);
      setError(null);
      setArrayBuffer(null);

      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) {
          /* The status is worth keeping — 403 and 404 mean different things to whoever
             has to explain the blank viewer — but it goes after the sentence rather
             than being the whole message. */
          throw new Error(
            res.status === 404
              ? "This file is no longer in storage."
              : res.status === 403
                ? "You don't have access to this file."
                : `Couldn't load this file (HTTP ${res.status}).`
          );
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        ownedBlobUrl = URL.createObjectURL(new Blob([buf]));
        setArrayBuffer(buf);
        setBlobUrl(ownedBlobUrl);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Couldn't load the preview.");
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
      if (ownedBlobUrl) URL.revokeObjectURL(ownedBlobUrl);
    };
  }, [src]);

  return { arrayBuffer, blobUrl, loading, error };
}
