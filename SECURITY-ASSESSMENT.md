# Web Application Security Assessment — StorageByAFR / Aether Cosmos ByAFR

| | |
|---|---|
| **Target** | StorageByAFR / Aether Cosmos ByAFR — Next.js 16 App Router, PostgreSQL (Neon), Cloudflare R2, Redis |
| **Scope** | Full source tree at `C:\Users\User\Documents\StrogeByAFR` (branch `main`, v0.4.0) — authentication, session management, authorization, upload/download, public sharing, admin console, OAuth 2.1 + API keys, and the Second Brain MCP surface |
| **Authorization** | Owner-authorized white-box review. No third-party system was touched. |
| **Method** | OWASP WSTG, adapted to source-level review (see *Methodology*) |
| **Assessed** | 2026-08-26 |
| **Findings** | 29 (1 Critical, 10 High, 14 Medium, 2 Low, 2 Informational) — **all remediated in-tree, each with regression tests** |
| **Verification** | `tsc --noEmit` clean · `eslint` 0 errors · `vitest` 2056 passed / 35 skipped (DB-dependent) / 0 failed |

---

## Executive summary

The application is a multi-tenant file store with public share links, a shared-folder
collaboration model, an OAuth 2.1 provider, and an MCP surface for AI agents. Its
security architecture is sound in the places that usually fail first: argon2 password
hashing with a real strength policy, CSRF tokens on cookie-authenticated mutations,
role-clamped OAuth scopes, magic-byte upload validation, tenant isolation enforced in
every brain query, and a capability model for shared folders. Rate limiting, audit
logging and bandwidth quotas all exist as first-class services.

What this assessment found were **gaps between controls that each worked in isolation**.
The recurring pattern, present in six separate findings, is a check and the action it
guards being *separable* — a limit read in one statement and spent in another (OTP
attempt budgets, share access budgets, OAuth single-use codes), or an exemption granted
on one interpretation of a request while the response was built from another (the share
`Range` bypass). The second recurring pattern is **unbounded input on paths a signed-out
caller can reach**: request bodies, path segments, query parameters and cache keys whose
size was chosen by the caller.

The single most serious issue was not a logic flaw but a default: three modules each
carried their own `|| "dev-insecure-secret-change-me"` fallback for `SESSION_SECRET`, so
a deployment that forgot the variable ran on a key published in the repository — enough
to forge the staged login token that sits between the password and the second factor.

Every finding below was fixed in-tree and pinned with tests. Nothing in this report
requires a production change beyond deploying the current branch and confirming that
`SESSION_SECRET` is set in the live environment.

## Risk matrix

| Severity | Count | Findings |
|---|---|---|
| Critical (9.0–10.0) | 1 | WEB-001 |
| High (7.0–8.9) | 10 | WEB-002 … WEB-011 |
| Medium (4.0–6.9) | 14 | WEB-012 … WEB-025 |
| Low (0.1–3.9) | 2 | WEB-026, WEB-027 |
| Informational | 2 | WEB-028, WEB-029 |

The 27 scored findings are all **remediated**. Of the two informational entries, WEB-028
records a control-integrity regression that was introduced and fixed during remediation,
and WEB-029 records a control that was verified correct and then locked by a test.
Severity is CVSS 3.1 base score, computed from the vector shown on each finding.
Findings are grouped into severity bands in ID order; **within** a band they are grouped by
subsystem rather than by decimal score, so two neighbours may differ by a tenth in either
direction (WEB-012 6.5 precedes WEB-013 6.8).

---

## Methodology

No live target, proxy or scanner was available for this engagement, so each WSTG step was
executed against the source instead. The substitution is stated per step so the coverage
claim can be judged honestly.

| WSTG step | How it was performed here | What this cannot cover |
|---|---|---|
| 1. Reconnaissance / mapping | Enumerated every route handler under `app/api/**` and every page under `app/**`; read `lib/**` for the shared gate helpers; mapped which routes are reachable with no session | Deployed headers, CDN behaviour, edge config |
| 2. Authentication | Read the full login → 2-Step Code → authenticator → session chain, the OTP and password-reset flows, and the staged-token HMAC | Real timing measurements |
| 3. Authorization | Traced every mutating route to its guard (`requireAuth` / `requireMaster` / `requireMasterOrApiKey` / `requireBrainContext` / `folderCapabilities`); asserted structurally that no route can be added without one | — |
| 4. Input validation | Checked every body-reading route for a zod parse and a byte ceiling; every path segment and query parameter for a shape check before it reaches SQL, Redis or a filesystem-like API | Runtime fuzzing |
| 5. Session management | Read cookie flags, rotation, absolute/idle expiry, IP binding, revocation-on-credential-change | Entropy sampling of live tokens |
| 6. Business logic | Modelled concurrency in tests: the fake `db` evaluates predicates *at write time*, so a read-then-write control fails the test the way it fails in Postgres | — |
| 7. Report | This document | — |

**Attack surface with no credential at all:** `/api/auth/*` (login, register, OTP,
password reset), `/api/shared/[token]` (GET metadata, PUT note edit), `/api/shared/[token]/preview`,
`/api/shared/[token]/download`, `/api/oauth/token`, `/api/oauth/register`, `/api/oauth/authorize`,
`/.well-known/*`, and the MCP transport (bearer-authenticated, no cookie). These received
the most attention, and 12 of the 29 findings are on them.

**Note on `middleware.ts`:** this project has none. Every gate is per-route, which is why
the structural tests (`tests/csrf-coverage.test.ts`, `tests/brain-isolation.test.ts`)
matter more than usual — they are the only thing that makes "no route forgot the gate" a
checkable property rather than a hope.

---

# Findings

## WEB-001 — Authentication secret defaulted to a value published in the source

**Severity**: Critical (CVSS 9.8 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`)
**Affected**: `lib/security/step-code.ts`, `lib/email/crypto.ts`, `lib/auth/*` — every consumer of `SESSION_SECRET`
**Parameter**: none (deployment default)
**Status**: Fixed

**Description**
`SESSION_SECRET` is the HMAC key behind the staged login token — the short-lived
credential that says "this user has passed the password step and may now present a second
factor" — and it is also the KDF input for stored Gmail App Passwords. Three modules each
carried their own fallback:

```ts
const secret = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
```

A deployment that did not set the variable therefore ran on a secret that is readable in
the repository. Knowing it, anyone can mint a `step_code`-stage token for any known user
id and present it to the second-factor endpoint, skipping both the 2-Step Code and the
authenticator layer entirely — no password required. The same key derives the AES-GCM key
for stored SMTP credentials.

**Reproduction steps**
1. Deploy without `SESSION_SECRET` (the pre-fix default path).
2. Compute `HMAC-SHA256("dev-insecure-secret-change-me", "<userId>:step_code:<exp>")` using the algorithm in `lib/security/step-code.ts`.
3. POST the forged token to the second-factor endpoint with any code-bearing payload the stage accepts.
4. A full session cookie is issued for `<userId>`.

**HTTP request**
```http
POST /api/auth/verify-step-code HTTP/1.1
Host: target
Content-Type: application/json

{"token":"<forged staged token>","code":"<the stage's own check>"}
```
**HTTP response**
```http
HTTP/1.1 200 OK
Set-Cookie: storage_session=…; HttpOnly; Secure; SameSite=Strict
{"success":true}
```

**Impact**
Complete authentication bypass for every account on any deployment missing the variable,
including accounts with 2FA fully configured. Stored mail credentials become decryptable.

**Remediation (applied)**
`lib/security/app-secret.ts` is now the single source: it accepts `SESSION_SECRET` or
`CSRF_SECRET`, enforces `MIN_SECRET_LENGTH`, and treats `DEV_FALLBACK_SECRET` as a
development-only value that warns loudly once and is refused outside development. The
three local fallbacks were deleted.
**Evidence**: `lib/security/app-secret.test.ts`
**Operator action**: confirm `SESSION_SECRET` is set in the live environment. Rotating it
invalidates saved Gmail App Passwords and enrolled 2FA secrets — re-enter them after a
rotation.

---

## WEB-002 — OTP verification signed in whoever owned the address

**Severity**: High (CVSS 8.1 — `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H`)
**Affected**: `POST /api/auth/verify-otp`, `POST /api/auth/resend-otp`
**Parameter**: `email`, `code`
**Status**: Fixed

**Description**
`/verify-otp` is the only endpoint that creates a session without a password. The
"activate the account" branch was conditional on the account genuinely awaiting
verification — but the `createSession` call that followed it was **not**. Since
`/resend-otp` would mail a fresh 6-digit code to *any* address it recognised, one guessed
or intercepted code was a complete authentication bypass of an existing, fully-activated
account: no password, no 2-Step Code, no authenticator, even for users who had all three.

Chained with WEB-003 (the attempt-cap race, which removed the 5-guess ceiling) the attack
complexity drops from High to Low and the chain scores **9.8 Critical**.

**Reproduction steps**
1. `POST /api/auth/resend-otp` with a known victim address — a fresh code is mailed to the victim.
2. `POST /api/auth/verify-otp` with that address and a guessed 6-digit code.
3. On a correct guess the response sets a full session cookie for the victim's account, regardless of whether the account was pending verification.

**HTTP request**
```http
POST /api/auth/verify-otp HTTP/1.1
Host: target
Content-Type: application/json

{"email":"victim@example.com","code":"481902"}
```
**HTTP response** (pre-fix)
```http
HTTP/1.1 200 OK
Set-Cookie: storage_session=…; HttpOnly; Secure; SameSite=Strict
{"success":true,"data":{"user":{"id":"…","role":"user"}}}
```

**Impact**
Account takeover of any account whose email address is known, with the second factor
bypassed. The mail is delivered to the victim, so the only limit on the attacker was
guessing a 6-digit code — and WEB-003 removed that limit.

**Remediation (applied)**
A code is now issued only for an account that is genuinely awaiting verification, and only
such an account can be signed in by this endpoint. Both halves are gated on the same
condition, in the same statement.
**Evidence**: `tests/otp-session-mint.test.ts`

---

## WEB-003 — OTP guess budget was read, compared, then written back

**Severity**: High (CVSS 8.1 — `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H`)
**Affected**: `POST /api/auth/verify-otp` → `lib/email/otp-verify.ts`
**Parameter**: `code`
**Status**: Fixed

**Description**
The "5 attempts per code" cap was a select-then-update: every request read the same
`attemptCount`, compared it to 5 in JavaScript, and only then wrote back. A concurrent
burst therefore all observed the same starting value and all passed the check — the budget
was really "as many guesses as fit in one round trip", which makes a 10⁶ keyspace
tractable. The final "burn the code" write had the same shape.

**Reproduction steps**
1. Request an OTP for a target address.
2. Fire 20 `POST /api/auth/verify-otp` requests simultaneously with 20 distinct guesses.
3. Pre-fix, all 20 were evaluated and `attemptCount` ended at 1–2, not 20. Repeat until the code is found.

**HTTP request** (×20, concurrently)
```http
POST /api/auth/verify-otp HTTP/1.1
Host: target
Content-Type: application/json

{"email":"victim@example.com","code":"000001"}
```
**HTTP response**
```http
HTTP/1.1 400 Bad Request
{"success":false,"error":"Invalid code"}      ← all 20, none refused as over-budget
```

**Impact**
The only quantitative control on the OTP path was removed under concurrency, turning
WEB-002 from "needs a lucky guess" into a feasible brute force.

**Remediation (applied)**
Both the attempt and the burn are single conditional UPDATE statements: the ceiling is part
of the `WHERE`, the counter is incremented as a SQL expression, and a loser gets zero rows
back. The test's fake `db` evaluates the predicate at write time, so a return to
select-then-update fails it.
**Evidence**: `lib/email/otp-verify.test.ts`

---

## WEB-004 — OAuth authorization codes and refresh tokens were not atomically single-use

**Severity**: High (CVSS 8.1 — `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H`)
**Affected**: `POST /api/oauth/token` → `lib/oauth/codes.ts`, `lib/oauth/tokens.ts`
**Parameter**: `code`, `refresh_token`
**Status**: Fixed

**Description**
Both consumption paths were select-then-update: read the row while `usedAt IS NULL` /
`revokedAt IS NULL`, then mark it used in a second statement. Two token requests racing on
the same stolen code (or refresh token) both observed an unclaimed row and both received a
live access token. RFC 6749 §10.4 and RFC 6819 §4.4.1 require single use precisely because
replay detection is what makes a leaked code recoverable.

**Reproduction steps**
1. Obtain one authorization code (e.g. from a referrer leak or a logged redirect).
2. POST it to `/api/oauth/token` twice, concurrently, with the same PKCE verifier.
3. Pre-fix both responses carried distinct, valid access tokens.

**HTTP request** (×2, concurrently)
```http
POST /api/oauth/token HTTP/1.1
Host: target
Content-Type: application/json

{"grant_type":"authorization_code","code":"oac_…","code_verifier":"…","client_id":"…"}
```
**HTTP response**
```http
HTTP/1.1 200 OK
{"access_token":"oat_…","refresh_token":"ort_…","token_type":"Bearer"}   ← twice
```

**Impact**
A captured code or refresh token can be redeemed by both the legitimate client and the
attacker, so the theft leaves no trace and is not self-limiting. Refresh-token rotation
without atomic revocation also defeats the standard leaked-token detection signal.

**Remediation (applied)**
Consumption is a single conditional UPDATE with `usedAt IS NULL` / `revokedAt IS NULL` in
the `WHERE` and `RETURNING` the claimed row; zero rows means "somebody else got it" and the
request is refused. No SELECT precedes the claim.
**Evidence**: `tests/oauth-single-use.test.ts`

---

## WEB-005 — A `view` member of a shared folder could delete or relocate the owner's data

**Severity**: High (CVSS 8.1 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:H`)
**Affected**: `PATCH|DELETE /api/folders`, `/api/folders/batch`, `/api/folders/[id]/members`, `/api/invitations`, `PATCH|DELETE /api/files`, `/api/files/batch`
**Parameter**: `folderId`, `fileId`, `parentId` (move destination)
**Status**: Fixed

**Description**
This is a confirmed incident, not a theoretical one: a member invited with `view` deleted a
shared folder and it disappeared from the **owner's** account. Two defects combined —
`view` was never actually narrower than `owner` for an account that happened to hold the
master role (the master override was consulted before membership), and `resolveWritableDestination`
did not validate a move, so a collaborator could drag the owner's file into their own
account, out of the owner's reach.

**Reproduction steps**
1. As the owner, share a folder with account B at `view` capability.
2. As B, `DELETE /api/folders` with the shared folder's id.
3. Pre-fix the folder was soft-deleted for the owner too.
4. As B, `PATCH /api/files` moving one of the owner's files to a `parentId` B owns — pre-fix the file left the owner's tree.

**HTTP request**
```http
DELETE /api/folders HTTP/1.1
Host: target
Cookie: storage_session=<member B>
X-CSRF-Token: …
Content-Type: application/json

{"id":"<owner's folder id>"}
```
**HTTP response** (post-fix)
```http
HTTP/1.1 403 Forbidden
{"success":false,"error":"You do not have permission to delete this folder"}
```

**Impact**
Destructive, cross-tenant data loss by the least-privileged role in the sharing model, plus
silent data exfiltration by relocation.

**Remediation (applied)**
`folderCapabilities()` in `lib/auth/permissions.ts` is now the single authority and
**membership beats the master override**; `view` yields no mutating capability; a member
leaves a share rather than deleting it; `resolveWritableDestination()` validates every move
target. Every mutating route consults the model and refuses **before** any write.
**Evidence**: `tests/folder-permissions.test.ts`, `tests/shared-folder-route-gates.test.ts`,
`tests/shared-file-route-gates.test.ts` — the route tests count DB calls, so a 403 issued
*after* an UPDATE fails them.

---

## WEB-006 — Privileged cookie-authenticated endpoints shipped without a CSRF gate

**Severity**: High (CVSS 8.0 — `CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:C/C:H/I:H/A:N`; AC:H because `SameSite=Strict` on the session cookie blocks the naive delivery)
**Affected**: `POST /api/auth/impersonate`, `POST|PUT /api/admin/email/senders`, `POST /api/admin/email/verify`, `POST /api/admin/monitoring`
**Parameter**: whole body
**Status**: Fixed

**Description**
These four authorized with `requireMaster` / `requireMasterOrApiKey`, which reads the
session cookie the browser attaches automatically, and validated no CSRF token. A
cross-site POST from any page a signed-in master visited could start an impersonation
session or rotate the stored Gmail sender credentials. `SameSite=Strict` made it not
trivially exploitable — but "another control happens to cover this" is not the same as
having the control, and it does not survive a cookie-policy change.

**Reproduction steps**
1. As a master, stay signed in.
2. Visit an attacker page that auto-submits `POST /api/auth/impersonate` with `{"userId":"<target>"}`.
3. Pre-fix, in any browser configuration that delivers the cookie, the impersonation session is created.

**HTTP request / response**
```http
POST /api/auth/impersonate HTTP/1.1        →  HTTP/1.1 403 Forbidden   (post-fix)
Host: target                                  {"success":false,"error":"Invalid CSRF token"}
Cookie: storage_session=<master>
Origin: https://evil.example
{"userId":"victim-id"}
```

**Impact**
Cross-site initiation of an impersonation session (full access to any account) or rotation
of server-wide mail credentials.

**Remediation (applied)**
`validateCsrf(request)` on all four, before the authorization check. The guarantee is now
structural: `tests/csrf-coverage.test.ts` walks every route file, finds every exported
`POST|PUT|PATCH|DELETE`, and fails if it lacks a gate — deliberate exemptions must be listed
with a stated reason. A new route cannot forget it.
**Evidence**: `tests/csrf-coverage.test.ts`, `lib/security/csrf-bearer.test.ts`

---

## WEB-007 — SSRF through user-supplied webhook URLs

**Severity**: High (CVSS 7.7 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N`)
**Affected**: `POST|PUT /api/webhooks`, `POST /api/webhooks/[id]/test`, delivery worker
**Parameter**: `url`
**Status**: Fixed

**Description**
The guard was a three-entry denylist on the hostname string. Every standard bypass worked:
private literals over `https`, alternate loopback encodings (`127.1`, `0177.0.0.1`,
`[::ffff:127.0.0.1]`, `localtest.me`), a public hostname that merely *resolves* to a private
address, and an HTTP redirect into the cloud metadata service on the follow-up request.

**Reproduction steps**
1. `POST /api/webhooks` with `{"url":"https://169.254.169.254/latest/meta-data/iam/security-credentials/"}` — accepted pre-fix.
2. `POST /api/webhooks/<id>/test` — the server fetched it and the response body was surfaced in the delivery log.
3. Variant: point the URL at a hostname you control that resolves to `10.0.0.5`, or that 302-redirects to `http://169.254.169.254/`.

**HTTP request / response**
```http
POST /api/webhooks HTTP/1.1                →  HTTP/1.1 400 Bad Request  (post-fix)
Cookie: storage_session=<any user>            {"success":false,
X-CSRF-Token: …                                "error":"Webhook target resolves to a blocked address"}
{"url":"https://169.254.169.254/latest/meta-data/"}
```

**Impact**
Read access to cloud instance metadata (IAM credentials), internal admin panels and the
Redis/Postgres ports from inside the perimeter, with the response echoed back to the caller
through the delivery log. Scope is Changed: the impacted component is the infrastructure, not
this app.

**Remediation (applied)**
`lib/webhooks/ssrf.ts` replaces the denylist with a resolve-then-verify allowlist:
`parseWebhookUrl` enforces scheme and shape; DNS resolution is performed and **every**
returned address is checked against the full set of private/reserved IPv4 and IPv6 ranges
(`isBlockedAddress`); loopback is permitted only where explicitly enabled
(`loopbackAllowed`); `fetchWebhook` re-validates on redirect rather than following blindly.
`assertSafeWebhookTarget` throws `WebhookTargetError` and fails closed.
**Evidence**: `lib/webhooks/ssrf.test.ts` (written as the bypasses that used to work),
`lib/webhooks/manage.test.ts`
**Residual risk**: one-lookup DNS-rebinding window between validation and connection —
accepted, see *Residual risks*.

---

## WEB-008 — Share access budget bypassed by a `Range` header the route never honoured

**Severity**: High (CVSS 7.5 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N`)
**Affected**: `GET /api/shared/[token]/preview`
**Parameter**: `Range` request header
**Status**: Fixed
**WSTG**: ATHZ-02 / BUSLOGIC-01

**Description**
The route read `Range` for one purpose only — deciding whether to charge the link's access
budget — with `isContinuation = !!rangeHeader && !/^bytes=0-/.test(rangeHeader)`. It then
called `downloadFromR2Stream(file.r2Key)` **without the range** and returned the whole
object with `200 OK`. So "is this a continuation?" and "what will actually be sent?" had
different answers, and the gap between them was a free download: `Range: bytes=1-` fetched
the complete file, forever, without ever decrementing `accessCount`. `maxAccessCount`
bounded nothing.

**Reproduction steps**
1. Create a share link with `maxAccessCount: 1`.
2. `GET /api/shared/<token>/preview` with `Range: bytes=1-`.
3. Observe `200 OK` with the **entire** file body and `accessCount` still `0`.
4. Repeat indefinitely.

**HTTP request**
```http
GET /api/shared/abc123/preview HTTP/1.1
Host: target
Range: bytes=1-
```
**HTTP response** (pre-fix)
```http
HTTP/1.1 200 OK
Content-Length: 4096          ← the whole object, not the requested 4095 bytes
Content-Type: image/png
```
**HTTP response** (post-fix, first request)
```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 1-4095/4096
Content-Length: 4095
```
…and, once the budget is spent:
```http
HTTP/1.1 403 Forbidden
{"success":false,"error":"Share link has reached maximum access limit"}
```

**Impact**
Every access-limited public share link was unlimited to anyone who sent a one-byte-offset
`Range` header — including links created specifically to be single-use. Combined with
WEB-020 (no metering) the same request was also invisible to the owner's bandwidth quota.

**Remediation (applied)**
Both questions are now answered by one parse. `lib/storage/http-range.ts` (extracted from
the authenticated preview route, so the two byte-serving routes share it) parses the header
once; the parsed range is forwarded to R2 and the response is a real `206` with
`Content-Range`. The continuation exemption now requires *evidence of a paid access*:
`shareResumeIsFree()` in `lib/shares/access.ts` grants it only when `accessCount >= 1` and
`lastAccessedAt` is within `SHARE_RESUME_WINDOW_MS` (5 minutes). A caller who has never paid
gets charged; an unsatisfiable range is treated as a whole-object request and charged.
**Evidence**: `lib/storage/http-range.test.ts` (13), `lib/shares/access.test.ts` (18),
`tests/share-token-budget.test.ts` (38) — including "charges a Range from a caller who has
not paid for anything yet", "refuses that Range once the link is spent", and "actually
serves the range it was given".

---

## WEB-009 — Share access budget was read, compared, then written back

**Severity**: High (CVSS 7.5 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N`)
**Affected**: `GET /api/shared/[token]`, `…/preview`, `…/download`
**Parameter**: path `token`
**Status**: Fixed

**Description**
`accessCount` was selected, compared with `maxAccessCount` in JavaScript, and written back
as `accessCount + 1`. A concurrent burst on a single-use link all read `0`, all passed the
comparison, and all were served.

**Reproduction steps**
1. Create a link with `maxAccessCount: 1`.
2. Issue 25 simultaneous `GET /api/shared/<token>/download` requests.
3. Pre-fix, all 25 succeeded and `accessCount` finished at 1.

**HTTP request / response**
```http
GET /api/shared/abc123/download HTTP/1.1   →  1 × 200 OK, 24 × 403 Forbidden  (post-fix)
Host: target                                  {"success":false,
(× 25 concurrently)                            "error":"Share link has reached maximum access limit"}
```

**Impact**
A "single use" link was worth as many downloads as the attacker could open sockets for.

**Remediation (applied)**
`claimShareAccess()` is one statement: the ceiling is in the `WHERE`, the increment is a SQL
expression, `lastAccessedAt` is stamped in the same UPDATE, and `RETURNING` yields the row
or nothing. The test's fake `db` refuses to accept a numeric `accessCount` payload, so a
return to JS arithmetic fails the suite rather than silently regressing.
**Evidence**: `lib/shares/access.test.ts` — "caps a concurrent burst at the ceiling",
"increments with a SQL expression, never a value read beforehand".

---

## WEB-010 — Unbounded request bodies on endpoints reachable without a session

**Severity**: High (CVSS 7.5 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H`)
**Affected**: `POST /api/oauth/token`, `POST /api/oauth/register` (via `parseOAuthBody`), `PUT /api/shared/[token]` (shared-note editor)
**Parameter**: whole body
**Status**: Fixed

**Description**
All three read the body with an unbounded `request.json()` / `request.text()`. Any anonymous
caller could turn a single request into an arbitrarily large allocation in the shared Node
process. A `Content-Length` check alone is no defence: the header is absent under
`Transfer-Encoding: chunked` and it can simply lie.

**Reproduction steps**
1. `POST /api/oauth/register` with `Transfer-Encoding: chunked` and no `Content-Length`.
2. Stream hundreds of megabytes of JSON.
3. Pre-fix the process buffered all of it before parsing; concurrent senders exhaust memory for every user.

**HTTP request / response**
```http
POST /api/oauth/register HTTP/1.1          →  HTTP/1.1 413 Payload Too Large  (post-fix)
Host: target                                  {"success":false,"code":"BODY_TOO_LARGE",
Transfer-Encoding: chunked                     "maxBytes":65536}
{"client_name":"AAAA… (500 MB)"}
```

**Impact**
Denial of service for every tenant from an unauthenticated request, at negligible cost to
the attacker.

**Remediation (applied)**
`lib/api/read-body.ts` / `lib/api/body.ts` drain the body through the stream with a hard
ceiling (`MAX_REQUEST_BODY_BYTES` = 64 KiB), abandon the read the moment it is crossed, and
cancel the reader rather than politely draining the rest. The declared `Content-Length` is
used only as a *free early refusal*, never to allow. `handleApiError` maps
`BodyTooLargeError` → 413 and `BodyInvalidJsonError` → 400.
**Evidence**: `lib/api/body.test.ts` (a false `content-length`, and a chunked stream with no
`content-length` that keeps going), `lib/api/response.test.ts`,
`tests/oauth-public-endpoints.test.ts`

---

## WEB-011 — An admin credential reset left the target's existing sessions live

**Severity**: High (CVSS 7.4 — `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N`)
**Affected**: `PATCH /api/admin/users/[id]`, `DELETE /api/admin/users/[id]`
**Parameter**: `password`, `mustChangePassword`, account state fields
**Status**: Fixed

**Description**
Session rows carry no link to the password, and neither route revoked them. An administrator
resetting a compromised account's credential — the standard incident response — changed
nothing the attacker was holding: every cookie already issued kept working until its own
expiry. Deleting the account did not evict its sessions either.

**Reproduction steps**
1. Attacker holds a stolen `storage_session` cookie for account V.
2. Admin resets V's password (or suspends/deletes V).
3. Pre-fix, the attacker's cookie continued to authenticate.

**HTTP request / response**
```http
GET /api/files HTTP/1.1                    →  HTTP/1.1 401 Unauthorized  (post-fix)
Cookie: storage_session=<stolen, pre-reset>   {"success":false,"error":"Unauthorized"}
```

**Impact**
Credential rotation did not end an active compromise — the one thing it exists to do.

**Remediation (applied)**
Both routes revoke the target's sessions as part of the same operation, and the revocation is
recorded in the activity log. The test counts the revoked session ids.
**Evidence**: `tests/admin-users-routes.test.ts`, `lib/admin/user-update.test.ts`

---

## WEB-012 — Admin user-edit endpoints parsed nothing

**Severity**: Medium (CVSS 6.5 — `CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:H/A:H`)
**Affected**: `PATCH /api/admin/users/[id]`, `DELETE /api/admin/users/[id]`
**Parameter**: `role`, `quotaBytes`, `username`, `mustChangePassword`
**Status**: Fixed

**Description**
`await request.json()` was copied field by field onto a drizzle update. `role: "root"`
reached a `pgEnum` column (driver error → 500), `quotaBytes: -1` and `1e30` reached a
`bigint({mode:"number"})` column, `username` was unbounded against an unbounded `text`
column, and `mustChangePassword: "no"` stored as truthy. `DELETE` destructured an unvalidated
body, so a request with no body was a 500.

**Reproduction steps**
`PATCH /api/admin/users/<id>` with `{"quotaBytes":1e30,"role":"root","mustChangePassword":"no"}`.

**HTTP request / response**
```http
PATCH /api/admin/users/u1 HTTP/1.1         →  HTTP/1.1 400 Bad Request  (post-fix)
Cookie: storage_session=<master>              {"success":false,"code":"VALIDATION_ERROR",
{"quotaBytes":1e30,"role":"root"}              "error":"role: Invalid enum value"}
```

**Impact**
Row corruption and 500s from a privileged console; a negative or absurd quota silently
breaks storage accounting for that tenant. Requires master privileges, so exposure is
limited to operator error and to an attacker who already holds an admin session.

**Remediation (applied)**
A zod schema per route: `role` as an enum, `quotaBytes` as a bounded non-negative integer,
`username` length- and charset-checked, booleans as booleans, and a body-optional `DELETE`.
The last-master guard is preserved.
**Evidence**: `tests/admin-users-routes.test.ts`, `lib/admin/user-update.test.ts`

---

## WEB-013 — Zip-slip: uploader-controlled entry names written verbatim into server-built archives

**Severity**: Medium (CVSS 6.8 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:N/I:H/A:N`)
**Affected**: `POST /api/download/zip`
**Parameter**: `files.name` (stored at upload time)
**Status**: Fixed

**Description**
`files.name` is uploader-controlled and was validated for length only, so it can be
`../../evil.sh`. Appended verbatim to the archive, the ZIP handed to the downloader is a
zip-slip payload: an extractor that trusts entry paths writes outside the chosen directory.
In a shared folder the uploader and the downloader are different people, which is what makes
the name untrusted input. The sibling folder-archive route already sanitized; this one did not.

**Reproduction steps**
1. As member A of a shared folder, upload a file named `../../../../etc/cron.d/payload`.
2. As member B, `POST /api/download/zip` selecting that file.
3. Pre-fix the archive contained the traversal path verbatim.

**HTTP request / response**
```http
POST /api/download/zip HTTP/1.1            →  200 OK, entry name "etc_cron.d_payload"
Cookie: storage_session=<member B>            (traversal flattened; duplicates de-duplicated
{"fileIds":["<A's file>"]}                     rather than overwriting)
```

**Impact**
Arbitrary file write on the downloader's machine with a vulnerable extractor — scope Changed,
because the impacted component is the victim's system.

**Remediation (applied)**
`lib/storage/archive-path.ts`: `archiveSegment` flattens POSIX and Windows traversal, strips
control characters and NUL, and `uniqueArchivePath` keeps duplicates distinct instead of
overwriting. Both archive routes use it.
**Evidence**: `lib/storage/archive-path.test.ts`, `tests/download-zip-entry-names.test.ts`
(asserts every name handed to `archiver`)

---

## WEB-014 — Archive inspection buffered the whole object; extraction had no decompression ceiling

**Severity**: Medium (CVSS 6.5 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H`)
**Affected**: `GET /api/files/[id]/archive/listing`, `POST /api/files/[id]/archive/extract`
**Parameter**: `id` (any archive the caller can read)
**Status**: Fixed

**Description**
Both pulled the entire R2 object into one `Buffer` with no limit, and `extract` decompressed
one entry with `entry.async()` — also with no limit. Any signed-in user could turn one request
into a multi-GB allocation in the shared Node process, and a few-megabyte decompression bomb
did the same on extract. That is an availability failure for every tenant, not just the caller.

**Reproduction steps**
1. Upload a 42 KB nested-deflate bomb (`42.zip`-style).
2. `POST /api/files/[id]/archive/extract` for the inner entry.
3. Pre-fix the worker inflated it until the process was OOM-killed.

**HTTP request / response**
```http
POST /api/files/f1/archive/extract         →  HTTP/1.1 413 Payload Too Large  (post-fix)
Cookie: storage_session=<any user>            {"success":false,"code":"ARCHIVE_TOO_LARGE"}
{"entry":"bomb/inner"}
```

**Impact**
Single-request denial of service affecting all tenants, from the lowest privilege level.

**Remediation (applied)**
Ceilings are enforced *before* the memory is spent — a bounded read of the object
(`lib/storage/read-bounded.ts`), a cap on entry count and per-entry uncompressed size, and a
bounded decompression on extract. Over-limit answers 413 rather than dying.
**Evidence**: `tests/archive-inspect-limits.test.ts`, `lib/storage/archive-read.test.ts`

---

## WEB-015 — Image editor accepted unbounded dimensions and read the source with no ceiling

**Severity**: Medium (CVSS 6.5 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H`)
**Affected**: `POST /api/files/edit`
**Parameter**: `width`, `height`, `rotate`, `crop`
**Status**: Fixed

**Description**
The four geometry parameters were bare numbers handed straight to `sharp`. `resize` there runs
with `fit: "inside"` and no `withoutEnlargement`, so it **enlarges**: a ~200-byte body asking
for `100000 x 100000` is a request for a 10-gigapixel canvas in the shared Node process. The
source object was also read whole with `transformToByteArray()` with no ceiling, while trusting
the uploader-declared `sizeBytes` in the row.

**Reproduction steps**
`POST /api/files/edit` with `{"fileId":"…","width":100000,"height":100000}`.

**HTTP request / response**
```http
POST /api/files/edit HTTP/1.1              →  HTTP/1.1 400 Bad Request  (post-fix)
Cookie: storage_session=<any user>            {"success":false,"code":"VALIDATION_ERROR",
{"fileId":"f1","width":100000,                 "error":"width: must be at most 20000"}
 "height":100000}
```

**Impact**
Memory exhaustion of the shared process from a tiny authenticated request.

**Remediation (applied)**
`lib/files/edit-limits.ts` pins `EDIT_MAX_DIMENSION` and `EDIT_SOURCE_MAX_BYTES`; the route
parses geometry with zod against those bounds and reads the source through the bounded reader,
using the **actual** byte count rather than the declared one.
**Evidence**: `tests/files-edit-limits.test.ts`

---

## WEB-016 — Media trim destroyed the original on an inverted window

**Severity**: Medium (CVSS 6.5 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N`)
**Affected**: `PUT /api/files/edit`
**Parameter**: `start`, `end`, file media type
**Status**: Fixed

**Description**
The trim path had no media-type check and no `end > start` validation, and the worker writes
ffmpeg's output back **over the original**. A request with an inverted window produced an empty
or broken output that replaced the caller's file, with no version retained. In a shared folder
an `edit` member could do this to the owner's media.

**Reproduction steps**
`PUT /api/files/edit` with `{"fileId":"…","start":90,"end":10}` on a video.

**HTTP request / response**
```http
PUT /api/files/edit HTTP/1.1               →  HTTP/1.1 400 Bad Request  (post-fix)
Cookie: storage_session=<editor>              {"success":false,"code":"VALIDATION_ERROR",
{"fileId":"f1","start":90,"end":10}            "error":"end: must be greater than start"}
```

**Impact**
Irreversible data loss, triggerable by a collaborator on someone else's file.

**Remediation (applied)**
The route requires an audio/video media type, validates `end > start` and both against the
media duration, and refuses before the job is enqueued. ffmpeg is invoked with an argv array
(no shell), so the parameters are not a command-injection vector.
**Evidence**: `tests/files-edit-limits.test.ts`

---

## WEB-017 — Stored XSS in the text previewer via file content

**Severity**: Medium (CVSS 6.1 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N`)
**Affected**: text/code previewer (`lib/viewers/text-highlight.ts`), reachable through `/shared/[token]` and shared folders
**Parameter**: file content
**Status**: Fixed

**Description**
The previewer writes `highlightLine`'s output into the DOM with `dangerouslySetInnerHTML`, and
its input is file content the viewer did not write — a file uploaded by another member of a
shared folder, or one behind a public share link anyone can open. Two highlighters ran over the
**raw** line before escaping: the JSON one always, the Markdown one on any line containing a
link, `**bold**`, or a backtick. So `<img src=x onerror=…>` inside a previewed `.json` or `.md`
file executed as script on our origin, in the session of whoever opened the preview.

**Reproduction steps**
1. Upload `notes.md` containing `[x](y) <img src=x onerror=alert(document.domain)>`.
2. Share it, or place it in a folder shared with the victim.
3. The victim opens the preview — pre-fix the script ran on the application origin.

**HTTP request / response**
```http
GET /shared/abc123 HTTP/1.1                →  the previewer now emits
Host: target                                  &lt;img src=x onerror=…&gt;
(victim's browser)                            for every language
```

**Impact**
Script execution on the application origin in a victim session, including a signed-in
victim's — session-scoped data access and actions as that user. Scope Changed (browser).

**Remediation (applied)**
Escaping happens **before** any highlighter runs, for every language. The invariant the tests
hold is blunt: for each of the ~15 selectable languages plus unmapped ones, no `<` from the file
may survive into the output as markup.
**Evidence**: `lib/viewers/text-highlight.test.ts`

---

## WEB-018 — The authenticator (TOTP) layer had no per-account guess ceiling

**Severity**: Medium (CVSS 5.9 — `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N`; presupposes a valid password)
**Affected**: `POST /api/auth/verify-totp`
**Parameter**: `code`
**Status**: Fixed

**Description**
A 6-digit TOTP is one guess in a million, but the `users` lockout columns only cover the
password and 2-Step Code layers, and the IP rate limit is worthless against a guesser with more
than one address. So the second factor had no per-account budget at all.

**Reproduction steps**
1. Authenticate the password step for a target account (credential known/phished).
2. Submit TOTP guesses from rotating source addresses.
3. Pre-fix, no per-account counter ever tripped.

**HTTP request / response**
```http
POST /api/auth/verify-totp HTTP/1.1        →  HTTP/1.1 429 Too Many Requests  (post-fix)
{"code":"000001"}                             {"success":false,"error":"Too many attempts"}
```

**Impact**
The second factor could be brute-forced by an attacker who already holds the password, which
is exactly the scenario it exists to stop.

**Remediation (applied)**
A per-account ceiling on the authenticator layer, independent of the IP limiter, with the same
lockout accounting as the other factors.
**Evidence**: `tests/login-hardening.test.ts`, `lib/security/user-rate-limit.test.ts`

---

## WEB-019 — OAuth dynamic client registration: unbounded metadata, no rate limit, internal error echoed

**Severity**: Medium (CVSS 5.4 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L`)
**Affected**: `POST /api/oauth/register`
**Parameter**: `client_name`, `redirect_uris`, `grant_types`, `response_types`
**Status**: Fixed

**Description**
An anonymous caller could register clients with no rate limit, storing `client_name`,
`redirect_uris`, `grant_types` and `response_types` into `jsonb` columns with no length, count
or vocabulary check. The 500 branch echoed the internal error message back to the caller.

**Reproduction steps**
1. `POST /api/oauth/register` with a 10 000-entry `redirect_uris` array and a megabyte `client_name`.
2. Repeat in a loop — pre-fix nothing throttled it and the table grew unbounded.

**HTTP request / response**
```http
POST /api/oauth/register HTTP/1.1          →  HTTP/1.1 400 Bad Request  (post-fix)
{"client_name":"A…", "redirect_uris":[…]}     {"success":false,"code":"VALIDATION_ERROR"}
                                              …and after N attempts: 429
```

**Impact**
Unauthenticated table growth and row bloat, plus internal error disclosure.

**Remediation (applied)**
Bounded body (WEB-010), zod-validated metadata with length and count limits and a closed
vocabulary for `grant_types` / `response_types`, every `redirect_uri` checked against
`isAllowedRedirectUri` (no `javascript:`/`data:`/`file:`, no plaintext `http` off loopback), a
per-IP rate limit, and a generic 500 body.
**Evidence**: `tests/oauth-public-endpoints.test.ts`, `lib/oauth/redirect-policy.test.ts`

---

## WEB-020 — `POST /api/oauth/approve` read an unparsed body and stored an unverifiable PKCE method

**Severity**: Medium (CVSS 5.4 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:L`)
**Affected**: `POST /api/oauth/approve`
**Parameter**: `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method`
**Status**: Fixed

**Description**
Every field was read as `String(body.x ?? "")` off an unparsed body. A JSON `null` body threw a
`TypeError` and answered 500; an object or array became the literal `"[object Object]"` and was
stored as if it were a client id or a challenge; `state`, `scope` and `code_challenge` were
unbounded strings written into the authorization-code row. Worst, `code_challenge_method` was
stored verbatim while `verifyPkce` only ever accepts `S256` — so a client sending `plain` (the
other method RFC 7636 defines, and the one `/api/oauth/authorize` already refuses) was handed a
code that could never be exchanged, surfacing much later as an opaque `invalid_grant`.

**Reproduction steps**
1. `POST /api/oauth/approve` with body `null` → pre-fix 500.
2. Same with `{"client_id":{},"code_challenge_method":"plain",…}` → pre-fix accepted and stored.

**HTTP request / response**
```http
POST /api/oauth/approve HTTP/1.1           →  HTTP/1.1 400 Bad Request  (post-fix)
Cookie: storage_session=<any user>            {"success":false,"code":"VALIDATION_ERROR",
X-CSRF-Token: …                                "error":"code_challenge_method: Invalid literal"}
{"code_challenge_method":"plain", …}
```

**Impact**
Stored garbage in the authorization-code table, unbounded row size chosen by the caller, 500s
on a malformed body, and a silently unusable consent flow for `plain` clients.

**Remediation (applied)**
`approveSchema`: bounded `client_id`/`redirect_uri`/`scope`/`state`, a base64url-shaped
`code_challenge` (43–128 chars), and `code_challenge_method` as `z.literal("S256").default("S256")`
so the mismatch is refused at the consent step. CSRF-before-auth and the role scope clamp
(`clampScopesToRole`) are unchanged — the role, not the request, decides whether `admin:*` can be
granted.
**Evidence**: `tests/oauth-approve.test.ts` (25 tests), `lib/oauth/scope-clamp.test.ts`

---

## WEB-021 — Login answered a different message for an unknown identifier (account enumeration)

**Severity**: Medium (CVSS 5.3 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N`)
**Affected**: `POST /api/auth/login`
**Parameter**: `identifier`
**Status**: Fixed
**WSTG**: ATHN-02

**Description**
A wrong password answered *"Invalid credentials. 4 attempt(s) remaining before account lock."*
while an unknown identifier answered a bare *"Invalid credentials"* — free account enumeration
from a username list. The timing differed too, because an unknown identifier skipped the argon2
verification entirely.

**Reproduction steps**
1. `POST /api/auth/login` with a known username and a wrong password → message includes the attempt counter.
2. Same with an unknown username → bare message, and a measurably faster response.

**HTTP request / response**
```http
POST /api/auth/login HTTP/1.1              →  HTTP/1.1 401 Unauthorized  (post-fix, both cases)
{"identifier":"alice","password":"x"}         {"success":false,"error":"Invalid credentials"}
```

**Impact**
Confirms which accounts exist, which is the input to credential stuffing and to the OTP path in
WEB-002.

**Remediation (applied)**
The bodies are identical, **and** an unknown identifier still spends a real argon2 verification
against a decoy hash so the response time cannot answer the question the body no longer does.
**Evidence**: `tests/login-hardening.test.ts` (asserts the decoy verification actually runs)

---

## WEB-022 — Public share preview served bytes without metering them

**Severity**: Medium (CVSS 5.3 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L`)
**Affected**: `GET /api/shared/[token]/preview`
**Parameter**: path `token`
**Status**: Fixed

**Description**
Every other byte-serving route calls `recordBandwidth(userId, bytes)`; this one did not. A public
link was therefore an unmetered egress channel around the owner's `bandwidthQuotaBytes` — the
quota could be fully spent and the link kept serving.

**Reproduction steps**
1. Set a small `bandwidthQuotaBytes` on the owner.
2. Fetch a shared preview repeatedly — pre-fix the 30-day rolling counter never moved.

**HTTP request / response**
```http
GET /api/shared/abc123/preview HTTP/1.1    →  HTTP/1.1 429 Too Many Requests  (post-fix, over quota)
Host: target                                  {"success":false,"error":"BANDWIDTH_QUOTA_EXCEEDED"}
```

**Impact**
Unbounded egress cost attributable to no one, and a quota that a public link could ignore.

**Remediation (applied)**
The route bills `file.userId` for exactly the bytes it will serve — `rangeLength(parsedRange)`
for a partial response, the full size otherwise — and answers 429 **before** opening the R2
stream when the quota is spent. `bandwidthQuotaBytes <= 0` still means unlimited.
**Evidence**: `tests/share-token-budget.test.ts` — metering describe block (full object billed,
range bills its own length, over-quota answers 429 with R2 untouched, `0` means unlimited)

---

## WEB-023 — Share token was an unbounded, unvalidated path segment

**Severity**: Medium (CVSS 5.3 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L`)
**Affected**: `GET|PUT /api/shared/[token]`, `…/preview`, `…/download`
**Parameter**: path `token`
**Status**: Fixed

**Description**
`shares.token` is a `text` column, so nothing about the path segment was checked before it became
a query — and on the `PUT` handler, before it became a Redis rate-limit key (`share_edit:${token}`).
An anonymous caller could therefore write a cache key of any size they liked, and push arbitrary
bytes into a database predicate.

**Reproduction steps**
1. `PUT /api/shared/<64 KiB of 'a'>` → pre-fix a 64 KiB Redis key was created per distinct token.
2. `GET /api/shared/../../etc/passwd` → pre-fix reached the query layer.

**HTTP request / response**
```http
GET /api/shared/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd  →  HTTP/1.1 404 Not Found  (post-fix)
Host: target                                        {"success":false,"error":"Share not found"}
                                                    (no query, no cache key)
```

**Impact**
Attacker-sized Redis keys (memory pressure on shared cache) and unnecessary query load, from an
unauthenticated request.

**Remediation (applied)**
`lib/shares/token.ts`: `isPossibleShareToken` bounds the segment to 8–128 characters over
nanoid's URL-safe alphabet, and each route answers 404 — no oracle — **before** any query or cache
key. Applied to all four handlers.
**Evidence**: `lib/shares/token.test.ts`, `tests/share-token-budget.test.ts` (asserts
`store.rateKeys === []` for a rejected token)

---

## WEB-024 — The anonymous share endpoints had no rate limit

**Severity**: Medium (CVSS 5.3 — `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L`)
**Affected**: `GET /api/shared/[token]`, `GET /api/shared/[token]/preview`, `PUT /api/shared/[token]`
**Parameter**: path `token`
**Status**: Fixed

**Description**
GET metadata and GET preview had no limiter at all, and the note-edit `PUT` was keyed only on the
token — so one caller could hammer any number of distinct tokens, and a token-guessing sweep was
unthrottled.

**Reproduction steps**
Issue several hundred `GET /api/shared/<random>` per second from one address — pre-fix all were
processed.

**HTTP request / response**
```http
GET /api/shared/abc123/preview HTTP/1.1    →  HTTP/1.1 429 Too Many Requests  (post-fix)
(× 200 from one IP within a minute)           {"success":false,"error":"Too many requests. Slow down."}
```

**Impact**
Unthrottled token-space probing and DB/R2 load from an unauthenticated source.

**Remediation (applied)**
Per-IP limits on all three: `share_view:` 120/min, `share_preview:` 60/min, `share_edit_ip:`
60/min, with the existing per-token `share_edit:` limit retained on top. The check runs before any
lookup, claim or write.
**Evidence**: `tests/share-token-budget.test.ts` — rate-limit describe block (asserts 429 with no
claim and no writes)

---

## WEB-025 — List endpoints took unbounded, unvalidated query parameters

**Severity**: Medium (CVSS 4.3 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L`)
**Affected**: `GET /api/files`, `GET /api/search`
**Parameter**: `cursor`, `from`, `to`, `q`, `mimeType`, `page`
**Status**: Fixed

**Description**
`cursor`, `from` and `to` were bare optional strings handed to `new Date(...)`. `new Date("banana")`
is an Invalid Date rather than an error, so it reached the driver as a broken parameter:
`?cursor=banana` was a 500 with a logged stack for any authenticated caller. `q` and `mimeType` were
unbounded **and both go into the Redis cache key**, and `page` was unbounded, so `?page=1e9` asked
Postgres for a billion-row `OFFSET`.

**Reproduction steps**
`GET /api/files?cursor=banana` → 500. `GET /api/search?q=<1 MB>&page=1e9` → oversized cache key and
a pathological query.

**HTTP request / response**
```http
GET /api/files?cursor=banana HTTP/1.1      →  HTTP/1.1 400 Bad Request  (post-fix)
Cookie: storage_session=<any user>            {"success":false,"code":"VALIDATION_ERROR",
                                               "error":"cursor: invalid datetime"}
```

**Impact**
Log-flooding 500s, attacker-sized cache keys, and an expensive query from a trivial request.

**Remediation (applied)**
A zod schema per endpoint: `cursor`/`from`/`to` parsed as real datetimes (rejected, not coerced),
`q` and `mimeType` length-bounded before they reach the cache key, `page` a bounded positive
integer.
**Evidence**: `tests/list-query-params.test.ts`

---

## WEB-026 — A malformed identifier in the path answered 500 across 27 dynamic routes

**Severity**: Low (CVSS 3.7 — `CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:N/A:L`)
**Affected**: every `app/api/**/[id]/**` route that passes the segment to a `uuid` column — 27 in total
**Parameter**: path `id`
**Status**: Fixed

**Description**
`GET /api/webhooks/banana` handed `"banana"` to `eq(webhooks.id, …)` on a `uuid` column. Postgres
answers SQLSTATE `22P02` ("invalid input syntax for type uuid"), which `handleApiError` did not
recognise — so a malformed request produced a 500 and a logged stack on 27 routes. No row was ever
reached, so there was nothing to roll back; 500 was simply the wrong answer, and the log noise
buries real faults.

**Reproduction steps**
`GET /api/webhooks/banana` with any valid session.

**HTTP request / response**
```http
GET /api/webhooks/banana HTTP/1.1          →  HTTP/1.1 400 Bad Request  (post-fix)
Cookie: storage_session=<any user>            {"success":false,"error":"Malformed identifier",
                                               "code":"INVALID_ID"}
```

**Impact**
Log flooding and misleading error telemetry; no data exposure (the database message is not echoed).

**Remediation (applied)**
`handleApiError` maps `22P02` → 400 `INVALID_ID` centrally, so all 27 routes are covered at once,
and **still logs** it — the same SQLSTATE comes from a genuine server-side bad cast, which is a bug
worth seeing. The response carries no Postgres detail (asserted).
**Evidence**: `lib/api/response.test.ts` — "answers 400 for an id that is not a UUID", "still logs
22P02", "does not echo the database's own message on the 400"

---

## WEB-027 — A presigned upload could be finalised for another user's file through the master override

**Severity**: Low (CVSS 3.8 — `CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:L/A:N`)
**Affected**: `POST /api/upload/complete`, `POST /api/upload/complete-batch`
**Parameter**: `fileId`
**Status**: Fixed

**Description**
The legacy presign→complete flow resolved the pending row with a helper that honours the master
override, so a master account could finalise a pending upload belonging to another user — writing
that user's row (size, checksum, status) from its own request. Finalisation is not an
administrative act; it is the second half of one specific user's upload, and the only correct
owner is the user who presigned it.

**Reproduction steps**
User A presigns and obtains `fileId`. A master account calls `POST /api/upload/complete` with A's
`fileId`. Pre-fix the row was updated; post-fix the response is 404 and no `UPDATE` is issued.

**HTTP request / response**
```http
POST /api/upload/complete HTTP/1.1         →  HTTP/1.1 404 Not Found  (post-fix)
Cookie: storage_session=<master>              {"success":false,"error":"File not found"}
{"fileId":"<user A's pending upload>"}
```

**Impact**
Cross-account write of upload metadata by a privileged account outside any audited admin path.

**Remediation (applied)**
Ownership is now tested by equality against the session user — no override path — and a mismatch is
a 404 with no write, for both the single and batch handlers.
**Evidence**: `tests/upload-complete-ownership.test.ts`

---

## WEB-028 — Informational: `BodyTooLargeError` existed twice, breaking the 413 branch

**Severity**: Informational (control-integrity regression, introduced and fixed during this engagement)
**Affected**: `lib/api/body.ts`, `lib/api/read-body.ts`, `lib/api/response.ts`
**Status**: Fixed

**Description**
While remediating WEB-010 the bounded-body reader was split across two modules and each declared
its **own** `BodyTooLargeError` / `BodyInvalidJsonError`. `instanceof` compares class identity, not
name, so `handleApiError`'s 413 branch matched only one of them: a route using the other reader
answered **500 for an oversized body** — the exact opposite of the refusal the control was added to
perform. This is recorded because it is the failure mode a control-hardening change is most likely
to produce: the check fires, and the response says the server broke.

**Remediation (applied)**
The classes are declared once in `lib/api/read-body.ts` and re-exported from `lib/api/body.ts` (the
re-export also avoids a `response.ts` ↔ `body.ts` import cycle). The regression test asserts
**object identity** across both module paths, not just that both names exist, and drives a real
oversized and a real malformed body through each reader into `handleApiError`.
**Evidence**: `lib/api/response.test.ts` — "there is exactly one class per name" (4 tests)

---

## WEB-029 — Informational: MCP↔REST scope parity

**Severity**: Informational (verified correct, now locked by a test)
**Affected**: `lib/brain/mcp/**`, brain REST routes
**Status**: Verified

**Description**
The Second Brain MCP surface and the REST surface authorise the same operations through separate
code. A tool that mapped to a weaker scope than its REST equivalent would be a privilege
escalation reachable with an API key. Every MCP tool was checked against its REST counterpart: the
mapping is complete and **fail-closed** — an unmapped tool is denied rather than allowed.

**Remediation (applied)**
A parity test enumerates the tool table and asserts each entry requires at least the scope its REST
equivalent requires, and that an unknown tool name resolves to "deny".
**Evidence**: `lib/brain/mcp/scope-parity.test.ts`

---

# Candidates investigated and dismissed

A penetration test is only as honest as its negative results. Each of the following looked
like a finding during mapping and was **traced to a control that already holds**. They are
listed so a future reviewer does not have to rediscover the reasoning — and so that if one
of the stated preconditions ever changes, the dismissal is re-openable.

| Candidate | Why it is not exploitable |
|---|---|
| `validateCsrf` returns true for a bearer-authenticated request | A bearer token is never attached by the browser automatically, so a cross-origin page cannot cause the request. CSRF protects *ambient* credentials only; the cookie path still requires the token. |
| MCP endpoint reflects the request `Origin` in `Access-Control-Allow-Origin` | No `Access-Control-Allow-Credentials`, and the surface is bearer-only. A reflected origin without credentials grants a cross-site page nothing it could not fetch server-side. |
| OAuth scopes are not re-clamped on refresh | The role is re-read on refresh and the grant is refused if it no longer permits the stored scopes, so a demoted user cannot keep an `admin:*` grant alive. |
| Zip-slip on archive **extract** | The handler streams entries to R2 under generated keys; there is no server-side filesystem write for `../` to escape. (Entry *names* were still fixed — see WEB-013 — because clients write them to disk.) |
| `auth/step-code` / `enroll` have no CSRF token | Both run before a session exists and are authenticated by a staged HMAC token the attacker cannot mint; the code claim is atomic. There is no ambient credential to ride. |
| ffmpeg / sharp invocation | Arguments are passed as an argv array with no shell, and no user string reaches a flag position. |
| argon2 CPU exhaustion via MCP API keys | The key prefix is looked up first; hashing only runs for a prefix that exists, so an attacker with no valid prefix cannot force the work factor. |
| Admin impersonation keeps `role: master` on the session | By design and audited: the impersonation session is explicitly labelled and revocable, and the audit log records both identities. |
| OAuth access/refresh token brute force | `nanoid(48)` — ~286 bits — behind the same rate limiter as everything else. |

---

# Accepted residual risks

These are real, were judged not worth the trade to fix, and are recorded rather than
silently closed. Each is a **deliberate** acceptance, not an oversight.

1. **`ACCOUNT_LOCKED` (429) and `ACCOUNT_SUSPENDED` (403) are distinguishable at login.**
   An attacker holding a valid username learns which state it is in. Collapsing them into
   one response would leave a locked-out legitimate user with no way to know why they
   cannot sign in — the support cost outweighs the leak, which requires knowing the
   username first.
2. **`assertSafeWebhookTarget` resolves DNS once, then the request is made separately.**
   A hostname that resolves to a public address at check time and a private one at connect
   time (DNS rebinding) has a narrow window. Closing it requires pinning the resolved IP
   into the connection — an agent-level change to the fetch stack. The blast radius is
   limited by the egress allowlist and the fact that responses are not returned to the
   caller.
3. **Folder invitations reveal whether a username exists.** The invite flow has to tell the
   inviter that the person they named cannot be found; a uniform response would make the
   feature unusable. Rate-limited, and requires an authenticated account to probe.

---

# Controls verified clean

Reported so the coverage claim is falsifiable — these were checked and found correct, and
several are now pinned structurally so a future route cannot silently omit them.

- **Admin console** — all 14 routes under `app/api/admin/**` carry the correct per-area
  scope *and* CSRF on every mutating method. Verified route-by-route, not by pattern match.
- **CSRF coverage is structural** — `tests/csrf-coverage.test.ts` enumerates every route
  file and fails if a mutating cookie-authenticated handler lacks `validateCsrf`. With no
  `middleware.ts` in this project, this test *is* the "no route forgot the gate" guarantee.
- **Brain tenant isolation is structural** — `tests/brain-isolation.test.ts` fails if any
  brain query omits its `brain_id` predicate, including in the same `WHERE` as an ANN
  `ORDER BY`.
- **Body validation coverage** — of 61 body-reading routes, only 3 lacked a zod parse; one
  is `oauth/register`, which validates inside `lib/oauth/clients.ts` instead. The other two
  are fixed above.
- **`app/api/brain/[id]/import`** — bounded, owner-only, rate-limited to 2 per window.
- **`app/api/shares/[id]/access-logs`** — ownership check correct; no cross-tenant read.
- **`verifyPkce`** — no downgrade path; `S256` only, which is what makes WEB-020's
  `z.literal("S256")` the right fix rather than a restriction.
- **Upload validation** — magic-byte sniffing, not extension or declared MIME.
- **Password policy** — argon2id with a real strength policy; credential change revokes
  sessions.
- **The 500 path leaks nothing** — asserted: no Postgres message, table, column or routine
  name reaches a client response.

---

# Observed but not acted on

Weaknesses in depth rather than exploitable defects. None is a finding on its own; each is
a place where the next change should be careful.

- `brain/[id]/import` reads the whole upload via `formData()` / `arrayBuffer()` **before**
  its byte-count check, so the ceiling is enforced after the memory has been allocated. It
  is owner-only and rate-limited to 2 per window, which is what keeps it off the findings
  list.
- Authenticated routes generally still call `request.json()` unbounded. The signed-out
  paths were the ones bounded (WEB-010); extending `readBoundedJson` to the authenticated
  set is the natural follow-up.
- `archive/extract` resolves access with `getAccessibleFile` while `archive/listing` uses
  `resolveFileAccess`. Both are correct today, but two helpers for one question is how a
  divergence starts.
- `download/[id]` carries a **local duplicate** of `getSafeMimeType`. This is the same
  shape as WEB-028 — one concept, two definitions — and should be collapsed to the shared
  helper.
- `sanitizeFilename` in `lib/utils.ts` is dead code. Dead security helpers get called by
  mistake later; delete it or wire it in.
- The legacy `upload/presign` → `complete` flow trusts the client-declared `sizeBytes`
  until the object is verified. Quota accounting is therefore briefly client-influenced.
- `POST /api/files/edit` compress writes JPEG bytes while retaining the original
  `ContentType`, so a compressed PNG is served with a stale content type.
- The 27 dynamic routes now fail safely on a malformed UUID (WEB-026) but do so via the
  central error mapper. Explicit up-front validation would turn a 400 into a decision
  rather than a caught error.

---

# Verification

Every change in this report is in-tree on branch `main` and was verified together, not
per-fix, so the interactions are covered too.

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **0 errors** |
| Lint | `npm run lint` | **0 errors**, 82 warnings (all pre-existing; the baseline was 85 — no new file contributes one) |
| Tests | `npm test` | **2056 passed · 35 skipped · 0 failed** across 114 files |

The 35 skips are the suites that require a live `DATABASE_URL`; they are skipped by design
in this environment, not failing.

Regression tests were added or extended for **every** scored finding. The tests that matter
most are the ones that fail if a fix is reverted in spirit rather than in letter:

- `lib/shares/access.test.ts` — the fake `db` evaluates the budget predicate **at write
  time** inside a single `returning()`, with no `await` in between. A 25-way concurrent
  burst against a 1-unit link must yield exactly 1 success. If the production code ever
  decides in JS again, this overspends and the test fails.
- `lib/shares/access.test.ts` also throws if `accessCount` arrives as a **number** rather
  than a SQL expression — i.e. it detects a value computed from an earlier read, which is
  the actual defect, not just its symptom.
- `lib/api/response.test.ts` — asserts **class identity** across both body-module paths, so
  re-splitting `BodyTooLargeError` is a failing test instead of a silent 413 → 500.
- `tests/csrf-coverage.test.ts` / `tests/brain-isolation.test.ts` — structural: a new route
  that forgets its gate fails the suite without anyone remembering to write a test for it.

---

# Operator actions

Two items are outside the source tree and are the operator's to do.

1. **Confirm `SESSION_SECRET` is set in the production environment** (WEB-001). The
   fallback is gone, so a deployment without it now fails loudly at startup instead of
   running on a published key — but confirm before deploying, or the app will not boot.
2. **If `SESSION_SECRET` must be rotated**, know what rotation costs here: the same secret
   derives the encryption key for **stored Gmail App Passwords and 2FA secrets**. Rotating
   it makes those undecryptable — the App Password must be re-entered and authenticator
   enrolment redone. Rotate deliberately, not as routine hygiene.

Beyond these, no production change is required other than deploying the current branch.

---

*Assessment performed 2026-08-26 against branch `main` (v0.4.0) under owner authorization.
Source-level review only — no live system was tested, and the Methodology table states what
that leaves uncovered.*





















