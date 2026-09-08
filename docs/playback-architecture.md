# Private R2 video playback architecture

## Purpose and decision

Plaintext video playback uses a short-lived private R2 capability: Next.js decides whether a viewer may play the file, accounts for that capability once, and then the browser reads byte ranges directly from R2. The bucket remains private. Encrypted media, downloads, thumbnails, subtitles, documents, and rollback retain their existing application routes.

Progressive playback is the first stage, not HLS. Native MP4/WebM playback already supports buffering and seeking when R2 answers Range requests. HLS would add manifests, segmentation, storage, transcoding, and another authorization surface without addressing the measured bottleneck.

## Request paths

### Before: proxy in every byte request

```text
Browser <video>
  -> Nginx
  -> Next.js preview route
  -> Aiven session/user/file/accounting queries
  -> R2 Range GET
  -> Node stream
  -> Nginx
  -> Browser
```

A player repeats this path for initial buffering, each additional segment, and seeks. The measured control-plane database time was about 520 ms before requesting a byte, per Range request, excluding the accounting UPDATE and the second network hop back through the VPS.

### After: control plane once, data plane direct

```text
Control plane:
Browser -> Next.js capability route
        -> authenticate / authorize / validate file
        -> privately presign R2 GET
        -> account one capability
        -> return bounded capability metadata

Data plane:
Browser <video> -> private R2 presigned URL
                -> native 206 Range responses
```

Next.js and Aiven are no longer involved in normal plaintext video Range traffic. The application never makes the object public and does not fetch a whole plaintext video into a Blob.

## Capability contract

The capability endpoints return a presigned GET URL plus its expiry, MIME type, size, and file version. Authorization always precedes issuance. The URL is a bearer capability until it expires: anyone holding it can read that one private object for its remaining lifetime, so it must be short-lived and handled as a secret.

The client refreshes before expiry and when a hidden tab becomes visible. It keeps a still-valid capability after a transient refresh error. Source rotation is imperative on the same `<video>` element and preserves `currentTime` and whether playback was active; it does not remount the player for every refresh. Recovery is bounded and eventually falls back to the legacy proxy.

Do not put a complete capability URL in logs, telemetry, analytics, error reporting, browser persistence, screenshots, or support messages. Query parameters contain the signature. Object keys are also omitted from application telemetry.

## Authorization boundaries

### Authenticated files

The private endpoint requires a valid session, resolves file access through the existing permission model, and requires view capability. A master role does not bypass feature-specific ownership or membership rules where those rules intentionally take precedence. Direct playback is offered only for a live, ready, plaintext, non-note video with a real R2 key.

### Public share links

The shared endpoint rejects malformed token shapes before rate limiting or database access, applies an IP rate limit, loads the share and ready file, checks expiry and media eligibility, and enforces both the owner's bandwidth budget and the share's access ceiling. A token is never emitted in telemetry or logs.

Share access means one issued playback capability, replacing the legacy interpretation of one initial byte delivery plus recent continuation requests. One capability can fetch the object's ranges during its lifetime. Refused, expired, unsupported, exhausted, or quota-blocked requests do not receive a capability.

## Accounting model

Bandwidth is charged once per issued capability for the object's recorded size, matching the legacy first-request charge while removing accounting from each Range request. This intentionally overcounts a viewer who watches only part of a video; it never makes a share link an unbilled download channel. Client telemetry is advisory and is not trusted for billing.

Issuance order is important:

1. authenticate/validate/authorize and decide playback eligibility;
2. create the private presigned URL without returning or logging it;
3. atomically reserve bandwidth and, for a share, claim one access;
4. return the already-created capability only after accounting succeeds.

Signing failure therefore changes no counters. Shared quota refusal does not consume an access, exhausted shares do not consume bandwidth, and transaction rollback keeps the counters together. A capability is never returned before accounting commits, favoring no unbilled capability.

## Browser and R2 CORS

Direct playback is cross-origin. The desired operator-applied policy is recorded in `docker/r2-cors.json`; source control does not apply it to production. The production origin and local development origin may issue `GET` and `HEAD`, send Range/request headers, and read validators needed by browser media handling. R2 must continue requiring signed requests.

Before enabling direct mode, verify from the deployed browser origin that R2 answers:

- `bytes=0-`, `bytes=0-1`, closed, suffix, forward-seek, and backward-seek ranges with 206;
- an out-of-bounds range with 416;
- `Accept-Ranges`, `Content-Range`, `Content-Length`, `Content-Type`, `ETag`, and `Last-Modified` as appropriate;
- CORS preflight/response headers without wildcard credential leakage.

Never replace this with a public bucket or public custom-domain object path.

## Encrypted and legacy consumers

End-to-end encrypted video stays on the browser-decryption path: the server cannot inspect or transcode ciphertext, so the client downloads the encrypted object through the authorized legacy route, decrypts it locally, and creates a Blob URL. Blob playback is an explicit encrypted-media exception, not the plaintext default.

The following paths remain intentionally application-mediated:

- file and folder downloads and archives;
- non-video and PDF previews;
- encrypted media;
- subtitle resources and subtitle management;
- thumbnails and poster images;
- legacy private/shared preview fallback;
- unsupported browser/container recovery.

Legacy preview routes must not be deleted until every consumer above has a verified replacement. Nginx buffering is disabled only for the remaining streaming preview routes, not for all APIs.

## Metadata and media jobs

Ready plaintext audio/video is inspected asynchronously with ffprobe. Derived columns include duration, dimensions, FPS, codecs, bitrate, container, MP4 faststart, and advisory browser compatibility. Raw ffprobe JSON and media content are not stored.

Jobs carry the expected file key, MIME, and version. Before expensive work and before persisting results, workers compare those values plus ready/plaintext/non-note/live/non-restore state. A stale job is a successful no-op. Transform output is staged and published only after claiming the exact expected state; retries repair metadata/accounting and deterministic derivative jobs rather than re-transforming committed bytes. Thumbnail and inspection failures retry their own jobs.

Compatibility metadata is advisory. A null or incompatible result does not synchronously transcode a request and does not force HLS. Native playback, bounded recovery, and the legacy fallback remain available.

## Telemetry and privacy

Playback telemetry is bounded, process-local operational data. It may record surface, outcome, refusal/error category, status, timing, size bucket inputs, and MIME. Client submission requires authentication and CSRF protection; anonymous share issuance telemetry is generated server-side.

Never log or transmit:

- R2 credentials or bucket secrets;
- a complete presigned URL or its query string;
- session cookies or authorization headers;
- share tokens;
- object keys or sensitive filenames;
- personal data or file contents.

Errors must be normalized to bounded categories. Do not pass arbitrary exception messages from R2, PostgreSQL, ffmpeg, or the browser into telemetry.

## Threat model

### URL leakage and replay

A leaked capability can be replayed until expiry. Reduce exposure with short TTLs, HTTPS, no URL logging/persistence, narrow object scope, private R2, and refresh rather than long-lived links. Immediate per-URL revocation is not available; force `legacy_proxy` to stop new issuance and rotate credentials only for an actual signer compromise.

### Referer, history, and third-party scripts

The URL is assigned to a media element rather than navigated as an application page. Keep third-party scripts minimal, use an appropriate referrer policy, and never copy capability URLs into analytics events. R2 and edge access logs, if enabled, need query-string redaction and retention controls.

### Token guessing and anonymous abuse

Share tokens have strict shape/entropy and malformed values do not reach database or rate-limit state. Valid-shape requests are IP-rate-limited. The share expiry and atomic access ceiling are checked before a capability can leave the service.

### Cross-origin misuse

CORS limits which browser origins can read responses but is not authorization: a copied URL can still be used by a non-browser HTTP client. Signature scope/expiry and application authorization are the real controls. Keep allowed origins exact and review them during domain changes.

### CSRF and telemetry poisoning

Capability GETs use existing session cookie protections and return a read capability only after permission checks. Playback telemetry POSTs require CSRF validation and bounded schemas/rates so a site cannot silently poison operational metrics.

### Stale worker jobs

A delayed transform targeting an old version could overwrite newer bytes. Version/key/MIME/state compare-and-set checks, staged publication, deterministic operation identities, and no-op stale handling prevent that. Derivative jobs repeat the same identity checks.

### Quota and share abuse

Concurrent issuance must not use JS read-modify-write counters. Row locking/transactional reservations close lost-update races and couple the owner's bandwidth reservation to the share claim. No capability is returned before commit.

### Rollback abuse or outage

`playbackMode = "legacy_proxy"` is a server-enforced emergency switch. It refuses new direct capabilities; clients then use the existing authorized proxy. The switch restores VPS/database load and is therefore a safety rollback, not a performance mode.

## Deployment and migration

Migration `drizzle/0030_media_metadata.sql` is local until the operator applies it. Application/worker code that selects or updates those columns must not be deployed first.

Deployment order:

1. Back up Aiven/PostgreSQL and verify restore access.
2. Apply migration `0030_media_metadata.sql` manually.
3. Verify all columns and four check constraints exist; do not assume the command succeeded.
4. Deploy worker and application versions compatible with the new schema together.
5. Apply and verify `docker/r2-cors.json` on the private R2 bucket if the policy is not already present.
6. Run authenticated and shared smoke tests for capability issuance, 206 seeking, encrypted playback, downloads, subtitles, thumbnails, and legacy fallback.
7. Keep `playbackMode = "legacy_proxy"` until smoke tests pass, then enable direct playback.
8. Watch refusal/error telemetry, capability latency, R2 4xx, worker failures, and bandwidth/share counters.

Do not apply a migration, change R2 CORS, deploy, or expose the bucket as part of a local code run.

## Rollback

Fast rollback:

1. Set `playbackMode = "legacy_proxy"` to stop new capability issuance.
2. Verify private and shared videos use authorized preview routes.
3. Restore the previous compatible application and worker if necessary.
4. Leave metadata columns in place; old code can ignore nullable derived fields.
5. Diagnose telemetry, CORS, R2, or worker failures before re-enabling direct mode.

Only run `drizzle/0030_media_metadata_rollback.sql` later if the feature is intentionally retired and all deployed code no longer references those columns. The rollback deletes derived metadata, not media objects, but is still a production schema mutation requiring a backup and explicit operator action.

## Operational checks

Monitor capability issuance p50/p95, refusals by bounded reason, direct-playback recovery/fallback rate, R2 403/416 responses, share exhaustion, bandwidth quota refusals, inspection/thumbnail job failures, and stale-job no-op counts. Compare after measurements with `docs/playback-measurement-before.md` using `npx tsx scripts/measure-playback.ts --label=after`; do not fabricate unavailable buckets or environments.
