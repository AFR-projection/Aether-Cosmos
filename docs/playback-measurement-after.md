# Playback measurement — after

Run at 2026-09-07T18:33:43.220Z from `win32`, sample size 1.00 MiB.

Numbers are this machine's. The location-independent result is the **count of Aiven round trips inside the byte path**, and the two R2 measurements are comparable to each other because both were taken from here.

## Before vs after interpretation

The direct-R2 architecture removes all Aiven work from each plaintext video byte request: the legacy path paid three authorization round trips (about 514–520 ms in this run) before asking R2 for a byte, plus an accounting read/update and the VPS response hop; the direct path pays **0 Aiven queries and 0 Next.js/VPS hops per Range request** after capability issuance. Presigning itself remained local at 0.9–10.3 ms.

This run also demonstrates why a single network sample must not be presented as an absolute throughput win: from this Windows client, both direct 1 MiB samples were slower in total than the server-side R2 GET during this particular run, while the earlier baseline had one direct sample faster and one slower. The architectural result is removal of repeatable control-plane and proxy costs; end-user R2 throughput still depends on network conditions and needs VPS/browser production telemetry.

| sample     | legacy control-plane DB wait per Range | direct DB wait per Range | before direct TTFB | after direct TTFB | after Range matrix    |
| ---------- | -------------------------------------: | -----------------------: | -----------------: | ----------------: | --------------------- |
| 7.21 MiB   |                               520.3 ms |                     0 ms |           119.8 ms |          227.9 ms | 6× 206 + expected 416 |
| 117.36 MiB |                               513.9 ms |                     0 ms |            75.4 ms |          271.8 ms | 6× 206 + expected 416 |

No ready plaintext videos existed in the 128 MiB–1 GiB or >1 GiB buckets, so those cells remain unmeasured rather than inferred.

## kyuunanaa__7677816810342780168.mp4 — 7.21 MiB (video/mp4)

### Aiven, per range request (control plane cost the legacy route pays every chunk)

| query                                      | latency      |
| ------------------------------------------ | ------------ |
| `SELECT 1` (raw round trip)                | 85.4 ms      |
| `SELECT sessions` (requireAuth)            | 172.2 ms     |
| `SELECT users` (requireAuth)               | 173.2 ms     |
| `SELECT files` (getAccessibleFile)         | 174.9 ms     |
| `SELECT users` (recordBandwidth read half) | 172.8 ms     |
| **total before a byte is requested**       | **520.3 ms** |

`recordBandwidth`'s `UPDATE users` is not run by this script. It costs at least as much as its read half and takes a row lock on one `users` row, which is what made concurrent chunks queue behind each other.

### Data plane

| path                                          | status | TTFB     | total    | bytes    | throughput |
| --------------------------------------------- | ------ | -------- | -------- | -------- | ---------- |
| A: R2 GET from the server (legacy hop 1 of 2) | 206    | 297.7 ms | 551.6 ms | 1.00 MiB | 1.81 MiB/s |
| B: presigned URL, direct (new data plane)     | 206    | 227.9 ms | 717.7 ms | 1.00 MiB | 1.39 MiB/s |

Presign call itself: 10.3 ms (local signing, no network).

Response headers R2 returns to the browser on the direct path:

| header            | value                              |
| ----------------- | ---------------------------------- |
| `accept-ranges`   | bytes                              |
| `content-range`   | bytes 0-1048575/7556053            |
| `content-length`  | 1048576                            |
| `content-type`    | video/mp4                          |
| `etag`            | "397cfa72b810f47fb33d79f8aa629403" |
| `last-modified`   | Sat, 05 Sep 2026 19:35:20 GMT      |
| `cache-control`   | _(absent)_                         |
| `cf-cache-status` | _(absent)_                         |
| `age`             | _(absent)_                         |

### Range matrix, direct against R2

| shape                                                 | sent               | status | expected | Content-Range                 | TTFB     |
| ----------------------------------------------------- | ------------------ | ------ | -------- | ----------------------------- | -------- |
| open-ended from 0 (Chrome's first request)            | `bytes=0-`         | 206    | ✅       | bytes 0-7556052/7556053       | 178.6 ms |
| probe (Safari's first request)                        | `bytes=0-1`        | 206    | ✅       | bytes 0-1/7556053             | 246.7 ms |
| closed range                                          | `bytes=0-65535`    | 206    | ✅       | bytes 0-65535/7556053         | 243.7 ms |
| seek forward (mid-file, open-ended)                   | `bytes=3778026-`   | 206    | ✅       | bytes 3778026-7556052/7556053 | 152.2 ms |
| seek backward (closed, earlier)                       | `bytes=1024-65535` | 206    | ✅       | bytes 1024-65535/7556053      | 168.0 ms |
| suffix range (tail, where a non-faststart moov lives) | `bytes=-65536`     | 206    | ✅       | bytes 7490517-7556052/7556053 | 242.9 ms |
| unsatisfiable (past the end)                          | `bytes=7557077-`   | 416    | ✅       | —                             | 181.6 ms |

Faststart: moov before mdat → faststart

## コントしてみた (1).mp4 — 117.36 MiB (video/mp4)

### Aiven, per range request (control plane cost the legacy route pays every chunk)

| query                                      | latency      |
| ------------------------------------------ | ------------ |
| `SELECT 1` (raw round trip)                | 86.1 ms      |
| `SELECT sessions` (requireAuth)            | 170.6 ms     |
| `SELECT users` (requireAuth)               | 171.8 ms     |
| `SELECT files` (getAccessibleFile)         | 171.6 ms     |
| `SELECT users` (recordBandwidth read half) | 171.5 ms     |
| **total before a byte is requested**       | **513.9 ms** |

`recordBandwidth`'s `UPDATE users` is not run by this script. It costs at least as much as its read half and takes a row lock on one `users` row, which is what made concurrent chunks queue behind each other.

### Data plane

| path                                          | status | TTFB     | total    | bytes    | throughput |
| --------------------------------------------- | ------ | -------- | -------- | -------- | ---------- |
| A: R2 GET from the server (legacy hop 1 of 2) | 206    | 173.3 ms | 491.7 ms | 1.00 MiB | 2.03 MiB/s |
| B: presigned URL, direct (new data plane)     | 206    | 271.8 ms | 618.1 ms | 1.00 MiB | 1.62 MiB/s |

Presign call itself: 0.9 ms (local signing, no network).

Response headers R2 returns to the browser on the direct path:

| header            | value                                |
| ----------------- | ------------------------------------ |
| `accept-ranges`   | bytes                                |
| `content-range`   | bytes 0-1048575/123062502            |
| `content-length`  | 1048576                              |
| `content-type`    | video/mp4                            |
| `etag`            | "f77972130e8ed76579a7ee42c0a5db6e-2" |
| `last-modified`   | Sat, 05 Sep 2026 20:21:11 GMT        |
| `cache-control`   | _(absent)_                           |
| `cf-cache-status` | _(absent)_                           |
| `age`             | _(absent)_                           |

### Range matrix, direct against R2

| shape                                                 | sent               | status | expected | Content-Range                       | TTFB     |
| ----------------------------------------------------- | ------------------ | ------ | -------- | ----------------------------------- | -------- |
| open-ended from 0 (Chrome's first request)            | `bytes=0-`         | 206    | ✅       | bytes 0-123062501/123062502         | 271.6 ms |
| probe (Safari's first request)                        | `bytes=0-1`        | 206    | ✅       | bytes 0-1/123062502                 | 253.4 ms |
| closed range                                          | `bytes=0-65535`    | 206    | ✅       | bytes 0-65535/123062502             | 156.8 ms |
| seek forward (mid-file, open-ended)                   | `bytes=61531251-`  | 206    | ✅       | bytes 61531251-123062501/123062502  | 158.4 ms |
| seek backward (closed, earlier)                       | `bytes=1024-65535` | 206    | ✅       | bytes 1024-65535/123062502          | 160.2 ms |
| suffix range (tail, where a non-faststart moov lives) | `bytes=-65536`     | 206    | ✅       | bytes 122996966-123062501/123062502 | 247.9 ms |
| unsatisfiable (past the end)                          | `bytes=123063526-` | 416    | ✅       | —                                   | 154.8 ms |

Faststart: moov before mdat → faststart
