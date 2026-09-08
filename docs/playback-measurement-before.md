# Playback measurement — before

Run at 2026-09-05T22:47:16.013Z from `win32`, sample size 1.00 MiB.

Numbers are this machine's. The location-independent result is the **count of Aiven round trips inside the byte path**, and the two R2 measurements are comparable to each other because both were taken from here.

## kyuunanaa__7677816810342780168.mp4 — 7.21 MiB (video/mp4)

### Aiven, per range request (control plane cost the legacy route pays every chunk)

| query                                      | latency      |
| ------------------------------------------ | ------------ |
| `SELECT 1` (raw round trip)                | 86.1 ms      |
| `SELECT sessions` (requireAuth)            | 173.2 ms     |
| `SELECT users` (requireAuth)               | 174.1 ms     |
| `SELECT files` (getAccessibleFile)         | 173.1 ms     |
| `SELECT users` (recordBandwidth read half) | 173.2 ms     |
| **total before a byte is requested**       | **520.3 ms** |

`recordBandwidth`'s `UPDATE users` is not run by this script. It costs at least as much as its read half and takes a row lock on one `users` row, which is what made concurrent chunks queue behind each other.

### Data plane

| path                                          | status | TTFB     | total    | bytes    | throughput |
| --------------------------------------------- | ------ | -------- | -------- | -------- | ---------- |
| A: R2 GET from the server (legacy hop 1 of 2) | 206    | 164.2 ms | 346.3 ms | 1.00 MiB | 2.89 MiB/s |
| B: presigned URL, direct (new data plane)     | 206    | 119.8 ms | 563.8 ms | 1.00 MiB | 1.77 MiB/s |

Presign call itself: 10.1 ms (local signing, no network).

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
| open-ended from 0 (Chrome's first request)            | `bytes=0-`         | 206    | ✅       | bytes 0-7556052/7556053       | 113.9 ms |
| probe (Safari's first request)                        | `bytes=0-1`        | 206    | ✅       | bytes 0-1/7556053             | 85.3 ms  |
| closed range                                          | `bytes=0-65535`    | 206    | ✅       | bytes 0-65535/7556053         | 73.6 ms  |
| seek forward (mid-file, open-ended)                   | `bytes=3778026-`   | 206    | ✅       | bytes 3778026-7556052/7556053 | 74.0 ms  |
| seek backward (closed, earlier)                       | `bytes=1024-65535` | 206    | ✅       | bytes 1024-65535/7556053      | 64.1 ms  |
| suffix range (tail, where a non-faststart moov lives) | `bytes=-65536`     | 206    | ✅       | bytes 7490517-7556052/7556053 | 67.8 ms  |
| unsatisfiable (past the end)                          | `bytes=7557077-`   | 416    | ✅       | —                             | 64.5 ms  |

Faststart: moov before mdat → faststart

## コントしてみた (1).mp4 — 117.36 MiB (video/mp4)

### Aiven, per range request (control plane cost the legacy route pays every chunk)

| query                                      | latency      |
| ------------------------------------------ | ------------ |
| `SELECT 1` (raw round trip)                | 86.0 ms      |
| `SELECT sessions` (requireAuth)            | 172.3 ms     |
| `SELECT users` (requireAuth)               | 173.3 ms     |
| `SELECT files` (getAccessibleFile)         | 173.3 ms     |
| `SELECT users` (recordBandwidth read half) | 173.5 ms     |
| **total before a byte is requested**       | **518.9 ms** |

`recordBandwidth`'s `UPDATE users` is not run by this script. It costs at least as much as its read half and takes a row lock on one `users` row, which is what made concurrent chunks queue behind each other.

### Data plane

| path                                          | status | TTFB    | total    | bytes    | throughput |
| --------------------------------------------- | ------ | ------- | -------- | -------- | ---------- |
| A: R2 GET from the server (legacy hop 1 of 2) | 206    | 75.1 ms | 350.1 ms | 1.00 MiB | 2.86 MiB/s |
| B: presigned URL, direct (new data plane)     | 206    | 75.4 ms | 280.3 ms | 1.00 MiB | 3.57 MiB/s |

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
| open-ended from 0 (Chrome's first request)            | `bytes=0-`         | 206    | ✅       | bytes 0-123062501/123062502         | 68.9 ms  |
| probe (Safari's first request)                        | `bytes=0-1`        | 206    | ✅       | bytes 0-1/123062502                 | 74.4 ms  |
| closed range                                          | `bytes=0-65535`    | 206    | ✅       | bytes 0-65535/123062502             | 158.2 ms |
| seek forward (mid-file, open-ended)                   | `bytes=61531251-`  | 206    | ✅       | bytes 61531251-123062501/123062502  | 67.2 ms  |
| seek backward (closed, earlier)                       | `bytes=1024-65535` | 206    | ✅       | bytes 1024-65535/123062502          | 76.1 ms  |
| suffix range (tail, where a non-faststart moov lives) | `bytes=-65536`     | 206    | ✅       | bytes 122996966-123062501/123062502 | 84.8 ms  |
| unsatisfiable (past the end)                          | `bytes=123063526-` | 416    | ✅       | —                                   | 66.5 ms  |

Faststart: moov before mdat → faststart
