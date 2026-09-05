/**
 * The one place a WebVTT body becomes an HTTP response.
 *
 * Four headers, and each one is here for a reason that is not obvious:
 *
 *  - `text/vtt; charset=utf-8` — the MIME type a `<track>` element requires. Serve the same bytes
 *    as `text/plain` and the browser silently renders no cues at all.
 *  - `Cache-Control: private, max-age=…` — a track is re-fetched every time the viewer reopens the
 *    file, and the bytes only change when somebody edits them. `private` because a track is as
 *    confidential as the video it belongs to, and must never land in a shared proxy cache.
 *  - `X-Content-Type-Options: nosniff` — cue text is arbitrary user or model output. Without this a
 *    browser is free to sniff a `.vtt` full of `<script>` as something else.
 *  - `Content-Language` — not read by the cue parser, but it makes a saved file self-describing.
 *
 * Shared by the authenticated route and the public share route, so a header can never be present on
 * one and missing on the other.
 */

/** Five minutes: long enough to stop a re-open refetching, short enough that an edit shows up. */
const CACHE_SECONDS = 300;

export function vttResponse(
  body: string,
  options: { language: string; fileName?: string | null }
): Response {
  const headers = new Headers({
    "Content-Type": "text/vtt; charset=utf-8",
    "Content-Language": options.language,
    "Cache-Control": `private, max-age=${CACHE_SECONDS}`,
    "X-Content-Type-Options": "nosniff",
  });

  if (options.fileName) {
    // The name reaches a Content-Disposition header, so it is stripped of anything that could
    // end the quoted string or inject a second header line. `filename*` carries the real name.
    const safe = options.fileName.replace(/["\\\r\n]/g, "").slice(0, 200);
    headers.set(
      "Content-Disposition",
      `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`
    );
    // A download is a one-off; caching it would only serve a stale copy to the next save.
    headers.set("Cache-Control", "private, no-store");
  }

  return new Response(body, { status: 200, headers });
}
