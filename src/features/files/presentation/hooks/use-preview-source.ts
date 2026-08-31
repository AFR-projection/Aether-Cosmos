"use client";

import { useState, useEffect } from "react";
import { useT, type TranslationKey } from "@/shared/lib/i18n";

/**
 * Which way the fetch failed, not what to say about it. The status is worth
 * keeping — 403 and 404 mean different things to whoever has to explain the
 * blank viewer — but it goes after the sentence rather than being the message.
 */
type PreviewFailure =
  | { kind: "gone" | "forbidden" | "generic" }
  | { kind: "http"; status: number };

/** A literal map rather than a template key, so a typo here is a tsc error. */
const FAILURE_KEY: Record<PreviewFailure["kind"], TranslationKey> = {
  gone: "files.viewer.load.gone",
  forbidden: "files.viewer.load.forbidden",
  http: "files.viewer.load.http",
  generic: "files.viewer.load.generic",
};

type PreviewSourceState = {
  arrayBuffer: ArrayBuffer | null;
  blobUrl: string | null;
  loading: boolean;
  error: string | null;
};

/**
 * Fetch file bytes for in-browser preview. Uses session cookies for API routes
 * and supports pre-decrypted blob: URLs for encrypted files.
 *
 * The effect records the failure and the sentence is built on the way out, so
 * `t` never enters the dependency array: a document that failed to load before
 * the reader switched language still explains itself in the language on screen.
 */
export function usePreviewSource(src: string | null): PreviewSourceState {
  const t = useT();
  const [arrayBuffer, setArrayBuffer] = useState<ArrayBuffer | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!src);
  const [failure, setFailure] = useState<PreviewFailure | null>(null);

  useEffect(() => {
    if (!src) {
      setArrayBuffer(null);
      setBlobUrl(null);
      setLoading(false);
      setFailure(null);
      return;
    }

    let cancelled = false;
    let ownedBlobUrl: string | null = null;

    const url = src;
    async function load() {
      setLoading(true);
      setFailure(null);
      setArrayBuffer(null);

      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) {
          if (cancelled) return;
          setFailure(
            res.status === 404
              ? { kind: "gone" }
              : res.status === 403
                ? { kind: "forbidden" }
                : { kind: "http", status: res.status }
          );
          setLoading(false);
          return;
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        ownedBlobUrl = URL.createObjectURL(new Blob([buf]));
        setArrayBuffer(buf);
        setBlobUrl(ownedBlobUrl);
        setLoading(false);
      } catch {
        // A thrown fetch is the network, and there is nothing more to say about
        // it than that the preview did not arrive.
        if (!cancelled) {
          setFailure({ kind: "generic" });
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

  const error = failure
    ? t(FAILURE_KEY[failure.kind], failure.kind === "http" ? { status: failure.status } : undefined)
    : null;

  return { arrayBuffer, blobUrl, loading, error };
}
