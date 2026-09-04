# Backup & Restore — Design

**Status:** proposed · **Date:** 2026-09-01 · **Scope:** two separate encrypted backups —
**Second Brain** and **Files** — whole-system and per-user, downloaded from the app, restorable
onto any Aether Cosmos install.

Written in English to match the rest of `docs/`. Say the word and it moves to Indonesian.

---

## 1. Problem

Aether Cosmos has no backup. Confirmed by search across `app/`, `src/`, `scripts/`,
`install.sh` and `docker/`: nothing dumps the database, nothing copies R2, nothing can put
the system back. The only recovery paths that exist today are per-object and in-place —
`file_versions` restore and `memory_versions` restore — both of which live in the same
database they would need to recover from.

The data sits in two stores that do not know about each other:

| Store | Holds | If lost |
|---|---|---|
| Postgres (Aiven) | 45 tables: users, folder tree, file records, **note bodies** (`file_contents.content_json`), all of Second Brain | Structure and every written word. Not re-obtainable. |
| Cloudflare R2 | File blobs, thumbnails | Uploaded bytes. Often re-obtainable from elsewhere. |

Backing up one and not the other produces a restore that looks healthy and is not: a
database full of file rows whose objects are gone, or a bucket of anonymous objects with no
owner, name, or folder.

Aiven runs its own automated backups and PITR. This design is not a replacement for that.
It exists because (a) R2 has no equivalent safety net in this deployment — no versioning,
so a delete is final, (b) provider backups cannot be downloaded and held by the operator,
and (c) restoring one table without rolling back the entire cluster is impossible with PITR
alone.

## 2. Goals

1. **Two separate artifacts, chosen at download time: Second Brain, or Files.** Not one
   combined blob. Each is independently downloadable, independently schedulable, and
   independently restorable.
2. A single downloadable file per artifact that can rebuild its half on a fresh VPS.
3. Encrypted at rest with a passphrase the system cannot recover.
4. Usable **only** on Aether Cosmos — not on a raw Postgres server, not by unzipping.
5. Portable across VPS, provider, and hostname. A dead server must not strand a backup.
6. Automatic on a schedule, or on demand, per user and for the whole system.
7. Restore that refuses bad input **before** touching the database, never halfway.
8. Every backup verified after it is written, and the verification surfaced in the UI.

Goal 1 is the organising constraint, not a UI preference. It survives contact with the schema
because the two domains share no foreign keys (§5.3) — so it costs a shared core inside both
files and nothing else. What it buys: a Brain backup is small and fast enough to take before every
risky brain change, without dragging gigabytes of file blobs along; a Files restore can undo a
storage accident without rewinding a month of memories; and the two can be restored in either
order onto a clean install.

## 3. Non-goals

- **Not bound to an instance.** A backup that only opens on the machine that made it is not
  a backup; it is a second copy of a live system. Explicitly rejected.
- **No self-destruct on wrong passphrase.** A file is passive data. Any attempt counter
  lives either inside the file (attackers work on copies, and can edit the counter) or in
  the app database (offline attacks never touch it, and restore would then require a working
  app — defeating the purpose). The mechanism belongs to hardware with a secure element,
  not to a file on a disk. Worse, the person most likely to mistype three times is the owner
  during an actual outage. Brute-force resistance is handled by KDF cost instead (§6.4).
- **No recovery of client-encrypted file contents.** Files uploaded with the browser-side
  encryption (`files.encrypted`) are stored as ciphertext derived from a per-file passphrase
  via PBKDF2-310k in `src/shared/lib/crypto/client-encryption.ts`. The server never holds
  that passphrase. Backup preserves the ciphertext and `encryption_meta` byte-exactly, so
  restore is faithful — but if the owner has forgotten the passphrase, the backup cannot
  help. Stated in the UI, not discovered later.
- **No blob backup outside Cloudflare** in the first four phases. The mirror is R2→R2.
  Off-provider blob export is a later addition (§15).
- **Not a migration tool.** Restore targets the same schema version, or refuses (§9.2).

## 4. Threat model

| Threat | Covered | By what |
|---|---|---|
| Accidental bulk delete, bad batch operation | Yes | Selective table restore (§9.1) |
| Aiven cluster loss | Yes | DB dump held by the operator |
| R2 object deleted or overwritten | Yes (from P4) | Content-addressed mirror (§8) |
| VPS destroyed, provider change | Yes | Artifact is portable; no instance binding |
| Backup file stolen from operator's disk | Yes | AES-256-GCM under an Argon2id passphrase |
| Stolen file + attacker's own server | Yes | Passphrase, not a code check (§6.5) |
| Stolen file **and** passphrase | No | Nothing can cover this. Passphrase handling is the boundary. |
| Malicious admin with live DB access | No | They already hold the live data |
| Backup silently corrupt for months | Yes | Post-write verification, "last verified" in UI (§10) |
| Restoring an old dump into a newer schema | Yes | Schema-version gate, refuses by default (§9.2) |

Why encryption is not optional here: the dump contains `users.password_hash`,
`users.step_code_hash`, and **`users.totp_secret` in the clear** (`schema.ts:182`). An
unencrypted dump in the wrong hands means valid 2FA codes for every account plus offline
password cracking. The artifact is encrypted or it is not produced.

## 5. Table classification

Every table in `schema.ts` falls into exactly one class, and every included table belongs to
exactly one **domain**. This is the part of a backup design that silently rots, so it is enforced
by a test (§5.7) rather than by discipline.

The two domains are the whole point of the split (§2, goal 1): **Files** and **Brain** are backed
up and downloaded separately. **Core** is the shared spine and travels inside *both* artifacts,
because neither is restorable without it.

### 5.1 Core — in both artifacts (8)

`users` · `system_settings` · `mail_senders` · `oauth_clients` · `api_keys` · `webhooks` ·
`activity_scopes` · `activity_logs`

`api_keys` is core rather than Files, and this is not a judgement call:
`brain_agents.api_key_id` references it (`schema.ts:1051`), so a Brain-only restore with
`api_keys` missing would violate a foreign key. That is precisely the kind of mistake §5.7
exists to make impossible.

### 5.2 Files domain (8)

`folders` · `files` · `file_contents` · `file_versions` · `shares` · `folder_members` ·
`folder_invitations` · `change_history`

`file_contents.content_json` holds **note bodies**, so notes ride with Files, not with Brain.
Worth saying out loud, because "notes" sounds like a Second Brain concern and is not one here.
This is also the only domain with R2 blobs behind it (§8).

### 5.3 Brain domain (15)

`brains` · `brain_agents` · `brain_access` · `memories` · `memory_versions` · `memory_tags` ·
`memory_tag_map` · `brain_projects` · `brain_entities` · `brain_relationships` ·
`memory_links` · `memory_mentions` · `brain_embedding_settings` · `brain_review_items` ·
`brain_audit_logs`

`memories.embedding` is included. It is a `pgvector` column declared without a dimension
(`vector("embedding")` in `schema.ts`), so whatever model the instance is configured for writes
into it — which is one more reason to carry the values rather than re-derive them: a restore that
re-embedded would silently mix two models' vectors in one column if the setting had changed since.
Delivery is a download with no size ceiling, and `pg_dump` cannot exclude a single column anyway.
The extension itself must be *in* the artifact — see §7.2, which is where the flag that puts it
there lives.

**The split is clean, and that is a fact about the schema, not a hope.** Every foreign key out of
a `brain_*` / `memor*` table points at another Brain table, at `users`, or at `api_keys`. Nothing
in Brain references `files` or `folders`; nothing in Files references Brain. Verified by reading
every `references()` in `schema.ts:248-1660`. That FK-disjointness is what makes two independent
artifacts possible at all — and §5.7 keeps it true.

### 5.4 Excluded — derived, regenerated after restore (4, all Brain)

`memory_derived_links` · `brain_graph_metrics` · `brain_health_snapshots` ·
`brain_retrieval_events`

Restore enqueues the jobs that rebuild the first three. The fourth is telemetry.

### 5.5 Excluded — must never be restored (10)

`sessions` · `otp_tokens` · `oauth_access_tokens` · `oauth_authorization_codes` ·
`upload_sessions` · `upload_parts` · `archive_jobs` · `archive_job_items` ·
`deletion_jobs` · `deletion_job_items`

Restoring live session tokens or half-finished uploads is a security hole and a source of
phantom work, not a recovery. Plus the new `backup_jobs` / `backup_settings` / `backup_keys`
tables: a restored backup log would describe artifacts that may no longer exist, and a restored
`backup_keys` row would carry a `wrapped_kek` encrypted under the **old** `SESSION_SECRET`.

### 5.6 Logs: all or nothing, not a time window

`activity_logs` (Core) · `change_history` (Files) · `brain_audit_logs` (Brain) are included in
full, with a per-domain `include_logs` toggle that drops them entirely.

An earlier draft promised "last 90 days". That was wrong: `pg_dump` has no row filter, so a
window would need a second export path just for three tables — a mechanism, and a bug farm, in
exchange for disk space on a download that has no size limit. `--exclude-table` is a flag
`pg_dump` already has. All or nothing is the honest shape of the tool.

### 5.7 The exhaustiveness test, and the FK-closure test

`tests/backup-table-classification.test.ts` imports `* as schema` and asserts:

1. **Exhaustiveness** — every `pgTable` export appears in exactly one class. Adding a table
   without classifying it fails CI.
2. **FK closure** — for each domain, walk every foreign key of every included table and assert
   the target is in the same domain or in Core. A brain table that starts referencing `files`
   fails the build, with the message that it has to be either moved or made core.

Test 2 is the one that matters. It converts "the domains are disjoint today" from a paragraph I
wrote after reading the schema into a property the build enforces forever. Without it, the first
feature that links a memory to a file silently produces Brain artifacts that cannot be restored.

Today: **8 core + 8 files + 15 brain + 4 derived + 10 never = 45**, matching the 45 `pgTable`
exports in `schema.ts` exactly. `include_logs` is a flag on three of those tables, not a sixth
class. The three tables §12 adds join the never-restored class and make 48.


## 6. The artifact

### 6.1 A Backup Set

One backup is one **set**: one domain, a single `backupId`, one manifest, and any number of
parts. A Brain set and a Files set are separate sets with separate ids — never two halves of one
thing. The number of physical files inside a set is an implementation detail; correctness rests
on the manifest.

```
backups/<scope>/<domain>/<backupId>/
  manifest.json           ← inventory: every part, its SHA-256, its size (plaintext JSON)
  data.acbak              ← pg_dump custom format, zlib-compressed → encrypted
  blobs.index.acbak       ← blob inventory: fileId → etag → mirror key   (files domain, P4)
```

`manifest.json` and not `manifest.acbak`: it is deliberately plaintext, because it holds the
sizes, table names, row counts and hashes an operator needs *before* deciding whether to type a
passphrase. It holds no row data and no key material — the wrapped DEK it would have to be secret
about lives in each part's header, not here.

`scope` is `system` or `user/<uuid>`; `domain` is `brain` or `files`. The downloaded filename
carries both, because six months later the filename is the only label anyone has:

```
aether-brain-system-20260902-0300.acbak
aether-files-system-20260902-0300.acbak
```

A Brain set has no `blobs.index.acbak` and never will — blobs belong to Files (§5.2). So the
Brain artifact is DB-only in every phase, which is why it stays small enough to take on impulse.

**How many files the user actually handles.** The manifest is small — kilobytes — so its bytes
are also written into a **trailer** at the end of every part (§6.2), covered by `trailerHmac`.
The consequence is the one that matters at 3 a.m.: a Brain set is *one downloadable file*, in
every phase, and a Files set is one file through P3 — self-describing, fetched with a presigned
URL straight from R2 with no proxying. The standalone `manifest.json` still exists on R2 because
it is the commit record (§7.3) and the input to retention pruning (§8.3) — infrastructure, not
something the user files away.

From P4 a Files set gains a blob part that can be very large, so the UI lists the parts and hands
out one presigned URL each, and restore accepts repeated `--file` or a `--dir`. That is when
"keep these together" becomes real advice, and it is also when the hash check below earns its
place.

Pairing is verified by **hash, not by comparing identifiers**. Matching ids prove two files
came from the same run; they cannot prove either file is intact. A truncated download, a
failed upload at 80%, one flipped byte — ids still match, restore still starts, and the
database is half-written before it dies. Hashes catch all of it, and catch it before the
first write.

### 6.2 File header and trailer

The header is plaintext, so the CLI and the UI can inspect a file before asking for a
passphrase.

| Field | Purpose |
|---|---|
| `magic` `"ACBAK\0"`, `formatVersion: u16` | Format signature. No other tool recognises it |
| `platform: "aether-cosmos"` | Platform marker |
| `domain: "brain" \| "files"` | Which artifact this is. Restore refuses a domain mismatch |
| `note` (short ASCII) | Human-readable "what is this file, what opens it" |
| `minAppVersion`, `schemaVersion` | Compatibility gate (§9.2) |
| `backupId`, `scope`, `createdAt`, `partIndex`, `partCount` | Identity and ordering |
| `coreDigest` | SHA-256 over the core tables' row counts + max `updated_at` (§9.4) |
| `kdf` = `{ algo: "argon2id", m, t, p, salt }` | Derivation parameters, **inside the file** |
| `wrappedDek` | Per-backup data key, wrapped under the passphrase KEK |
| `headerHmac` | HMAC-SHA256 over all preceding header bytes, keyed by a platform constant |

The KDF salt lives in the header, not in the database, because restore has to work on a
machine with no database and no application.

**The trailer, and why the manifest cannot live in the header.** A part's own hash is not known
until its last byte is written, so a manifest that lists part hashes cannot be embedded in a
header that precedes them. The embedded copy is therefore a plaintext **trailer**, appended
after the final chunk:

```
[ header ][ chunk 0 ][ chunk 1 ] … [ chunk n ][ trailer ]
└────────── payload region ──────────────────┘
```

- The manifest records `payloadSha256` and `payloadBytes` per part — the hash covers the header
  and chunks, **not** the trailer. Well-defined, computable while streaming, and verifiable on
  read by hashing the first `payloadBytes` bytes.
- The trailer carries the manifest bytes for *this* part plus `trailerHmac` over
  `headerBytes ‖ manifestBytes`. A single-part set (P1–P3) is therefore completely
  self-describing.
- With more than one part (from P4) the trailer's manifest is partial by construction — it
  cannot list a sibling part uploaded after it. `partCount` in the header is the tell: restore
  given fewer parts than `partCount` refuses and names what is missing. The standalone
  `manifest.json` remains the authoritative full inventory.

### 6.3 Payload framing

`headerHmac` and `trailerHmac` are what make the file *ours*: anything not produced by Aether
Cosmos fails validation, and the restore tool refuses it. Stated plainly — the HMAC key is a
constant in the source, so this is **format authenticity, not secrecy**. Secrecy is the
passphrase. The practical result is exactly the requirement: the file is an Aether Cosmos
artifact and nothing else, and without the passphrase it is ciphertext to everyone.

The payload is chunked so a 40 GB artifact never needs 40 GB of RAM — the binding constraint
on a 2 GB VPS.

- Chunk size 4 MiB, each sealed with AES-256-GCM under the DEK.
- Nonce = 4 random bytes fixed per part ‖ 8-byte little-endian chunk counter. No reuse.
- AAD per chunk = `backupId ‖ partIndex ‖ chunkIndex ‖ isFinal`. Binding the index defeats
  reordering and chunk splicing between files; the `isFinal` flag makes truncation at a
  chunk boundary detectable rather than silently producing a short file.
- A chunk that fails its tag aborts the stream. There is no partial-read mode.

### 6.4 Key hierarchy

```
passphrase ──Argon2id(salt, m=256MiB, t=4, p=1)──▶ KEK   (one per owner, both domains)
                                                   │
                                    ┌──────────────┴──────────────┐
                                    │ wraps                       │ stored at rest,
                                    ▼                             ▼ encrypted under
                              DEK (random 32B, per set)     SESSION_SECRET
                                    │
                    AES-256-GCM ◀───┘  4 MiB chunks → data.acbak
```

Both primitives are already dependencies: `@node-rs/argon2` (used for login) and
`node:crypto`. No new packages.

**Unattended backup.** A scheduled 02:00 run needs an encryption key with nobody present.
Storing the passphrase is unacceptable, so instead the KEK is derived **once**, when the owner
takes their first backup, and stored encrypted under `SESSION_SECRET` alongside the salt in the
clear. Every later run — manual or scheduled, Brain or Files — unwraps that KEK to wrap a fresh
per-set DEK. The passphrase itself is never persisted anywhere, which is why it can only be shown
once.

**One passphrase for both domains**, not one each. Splitting the artifacts is about what you can
download and restore independently; it is not a reason to hand someone two secrets to lose — with
17 retained sets across two domains, per-artifact passphrases end in a text file called
`passwords.txt`. The KEK therefore lives in `backup_keys`, keyed by owner alone, while schedules
and retention live in `backup_settings`, keyed by owner *and* domain (§12). Each set still gets its
own random DEK, so the two artifacts share no key material beyond the KEK that wraps them. A
rotation starts a new `keyEpoch` (§11.2) and leaves earlier artifacts openable with the earlier
passphrase. This is the one place the two artifacts are not independent, so it is put to the
operator explicitly as §16.4 rather than assumed.

A useful asymmetry falls out: rotating `SESSION_SECRET` means **new** backups need the
passphrase re-entered, while **existing** backups stay restorable, because their salt and
wrapped DEK travel inside the file. Rotation degrades convenience, never recoverability.

This stored KEK also gives same-instance restore for free — the running app can unwrap a DEK
without a passphrase prompt. An earlier draft proposed a second keyslot for this; it is
dropped as redundant. One passphrase, one path, one fewer thing to pick wrongly during an
actual recovery.

### 6.5 Where brute-force resistance actually comes from

Not from an attempt counter. From cost that cannot be removed:

- **Argon2id m=256 MiB, t=4** puts one guess at roughly 1–2 s on commodity hardware, and the
  memory cost is what makes GPU and ASIC attacks uneconomic — the entire design purpose of
  Argon2. This is not a check an attacker can patch out of a copy of our source, because it
  is not a check. It is the price of deriving the key at all.
- **System-generated passphrase**, nine words from a 512-word list — **81 bits**, and there is
  no user-chosen option (§16.3). At ~1 s per guess, 2⁸¹ guesses is not a search that finishes.
  A user-chosen passphrase would be the one case where a three-try limit would also have
  failed, because the second guess lands.
  The list is 512 words rather than the EFF 7776 because this passphrase is copied onto paper
  by hand and typed back six months later: every word on it is 3–6 letters, unambiguous when
  read aloud, and free of the homophone pairs a long list cannot avoid. Nine short words carry
  more entropy than six long ones (81 > 77) and are less likely to be transcribed wrongly.
  Both ends normalise case and whitespace before hashing, so the note can be written in any
  hand (§6.4).
- **Server-side rate limit and audit on download.** This *is* a real boundary — it runs on
  our machine. Every download writes to `activity_logs`.
- **Kill switch.** An admin action that deletes every stored backup from R2, server-side.
  Real destruction, actually enforceable — unlike asking a file to delete itself.

Memory note: 256 MiB per derivation is safe on a 2 GB VPS because Argon2id runs exactly twice in
the artifact's life — once when the passphrase is created (or rotated), and once per restore —
never concurrently, and never per backup: routine runs unwrap the stored KEK instead, which costs
nothing. The restore CLI derives in-process, one at a time.

## 7. Backup pipeline

### 7.1 Consistency point

A Brain set has one store behind it, so `pg_dump`'s single snapshot makes it a true
point-in-time, full stop. A Files set has two, and R2 has no snapshots. The ordering that makes
the Files case safe:

1. Dump the database first. `T1` is fixed.
2. Read the blob inventory **from the dump**, not from a live query — so the inventory can
   never list an object the dump does not know about.
3. Mirror those keys. Anything already deleted between `T1` and the mirror pass is recorded
   in the manifest as `missingBlobs[{ fileId, r2Key, reason }]` and **does not fail the
   backup**. Restore reports them explicitly instead of producing files that silently 404.
4. While a backup runs, `runScheduledCleanups` skips R2 purges (a `backup_in_progress` guard
   in `cleanup-state.ts`). This shrinks the window to near zero at the cost of delaying one
   cleanup cycle. Objects created after `T1` are simply not in the dump and are ignored —
   harmless.

Files created between `T1` and the mirror pass are absent from the dump and therefore absent
from the backup. That is correct behaviour for a point-in-time backup and worth stating so it
is not mistaken for data loss.

Brain and Files sets taken at different times are **not** a consistent pair, and nothing pretends
otherwise: they share only core tables, and `coreDigest` (§9.4) tells the operator when the two
files' cores disagree. Since the domains reference nothing of each other's, a mismatch is an
inconvenience to report, never a corrupt restore.

### 7.2 Streaming, table selection, and the memory budget

```
pg_dump --format=custom --compress=1 --extension=vector --exclude-table=…  ─stdout─▶  chunk+GCM  ─▶  R2 multipart
```

There is no compression stage of our own in that pipeline, and there does not need to be:
`--compress=1` is custom format's built-in zlib, which puts the compression exactly where it has
to be — **before** the encryption, since ciphertext does not compress — without a Transform to
own or a window to budget for. Level 1 rather than pg_dump's default 6 because this runs on a
2 GB box beside the app, Redis and the worker; level 1 takes most of the ratio for a fraction of
the CPU, and the bottleneck is the network to R2 either way. The TOC stays uncompressed at the
head of the archive whatever the level, which is why `pg_restore --list` still works on a stream
that never touches disk (§10).

The cost, stated plainly: an artifact's size leaks something about how compressible its contents
were. That is the trade every backup tool makes, and the alternative — a dump three to five times
larger, to store, to upload inside one job, and to stream back through verification — is worse in
every way that matters here.

The domain is selected by **exclusion**, not inclusion, and the reason is not stylistic. With
`--table` (an allow-list), `pg_dump` emits only those tables — no `CREATE EXTENSION vector`, no
`CREATE TYPE` for the pgEnums the tables use — so a fresh-database restore fails on missing
types before it loads a row. With `--exclude-table` the types survive, and the excluded tables
simply do not appear. So a Brain artifact is
"everything except the Files tables and the never-restored tables", and vice versa. Each artifact
is then a standalone `pg_restore` target on an empty database (§9.3).

**The extension has to be named explicitly.** Exclusion is not sufficient on its own, and this
is a trap: `pg_dump` emits `CREATE EXTENSION` only when its internal `include_everything` flag is
set, and **`--schema` clears that flag** — its option loop does this for `-n` exactly as it does
for `-t`. Since the dump is scoped with `--schema=public`, an artifact built from
`--exclude-table` alone contains no extension entry, and `CREATE TABLE "memories" (…
"embedding" "vector" …)` is then a syntax error on any clean database: the primary recovery path
fails on its first statement. `--extension=vector` restores the entry, because
`selectDumpableExtension` consults the include list *before* that flag. Naming one extension
rather than inheriting every installed one is also what keeps a managed provider's own
extensions out of an artifact that must restore as an unprivileged role. `--strict-names` then
turns "this database has no pgvector" into a failure in the dump's first second rather than a
verification failure after 40 GB; it constrains include patterns only, so the exclusion list is
unaffected. Verification asserts the entry is present in every artifact (§10), and the two spell
the extension's name from one constant.

Nothing is buffered whole. Peak resident memory is one multipart part buffer plus one 4 MiB
chunk plus its ciphertext — **~24 MiB** with the part size the backup actually asks for (§13.5),
flat regardless of database size. pg_dump's own compressor adds a zlib window on its side of the
pipe, which is a few hundred KiB and not worth counting. The dump is never written to local disk,
so a large database cannot fill `/`.

`--format=custom` is chosen over plain SQL for three reasons: built-in compression,
`pg_restore --list` for inspection without restoring (used by verification, §10), and
selective restore of individual tables and TOC entries (§9.1, §9.4).

### 7.3 Manifest-last commit

Object storage has no transactions, so the standalone manifest is the commit record:

1. Parts are uploaded first, each under its final key, trailer included.
2. Hashes are computed **while streaming** (`payloadSha256`), not by re-reading.
3. `manifest.json` is written **last**.

A set without a standalone manifest is invisible to restore and to the UI, and the hourly job
garbage collects orphaned prefixes older than 24 h. A crash mid-backup therefore leaves storage
litter, never a set that looks complete and is not. Note the asymmetry this creates on purpose:
a downloaded part is self-describing via its trailer, but a part still sitting in R2 with no
manifest beside it is treated as incomplete, because the trailer cannot prove the *set* finished.

### 7.4 Idempotency and single-flight

Following the `archive_jobs` precedent: `unique (owner_key, domain, idempotency_key)`, so a
double-clicked "Backup now" or a retried job produces one backup — per domain, because backing up
Brain and Files are two separate intents and must not deduplicate against each other.

Single-flight, on the other hand, is per **owner and not per domain**: `pg_try_advisory_lock` on a
hash of `owner_key` alone, so a Brain run and a Files run for the same owner serialise rather than
running side by side. A 2 GB box must not hold two `pg_dump` streams at once. "Back up both" is
therefore two jobs, second queued behind the first — which is also why the UI reports them as two
rows with independent status (§11.2), not one progress bar that hides a queue.

### 7.5 Job states

```
created → dumping → mirroring → verifying → completed
                                          ↘ failed
```

A Brain job skips `mirroring` entirely — it has no blobs (§5.2). `failed` records `error_code`
and `error_message`. Verification failure lands in `failed`, not `completed` (§10). Cancellation
is allowed up to `verifying`.

## 8. Blob mirror — Files domain only (P4)

Nothing in this section applies to a Brain backup. Brain sets are DB-only in every phase, which is
what keeps them small and quick enough to take before a risky change.

### 8.1 Server-side only

Blobs are mirrored with `CopyObject` (R2→R2). No bytes traverse the VPS: zero RAM, zero
bandwidth, no egress. `copyR2Object` at `r2.ts:259` currently hard-codes a single bucket via
`getBucket()`, so it gains an optional destination bucket. Objects over 5 GB need multipart
copy — the same `MAX_SINGLE_PART_COPY_BYTES` ceiling the paste feature already handles.

### 8.2 Content-addressed, deduplicated

The mirror is keyed by content, not by file:

```
backups/blobs/<etag[0:2]>/<etag>
```

The manifest maps `fileId → etag`. Three consequences, all good: the same PDF uploaded by
five users is stored once; a daily backup only copies etags not already present, so storage
grows with new data rather than with backup count; and pruning is a set difference over
retained manifests instead of a per-backup delete pass.

**The trap this avoids.** `buildR2Key()` is `users/<userId>/objects/<fileId>` — keyed by file
id, so an in-place edit rewrites the *same* key with different bytes. An incremental mirror
that asks only "does this key exist?" would keep the stale copy while reporting success.
Comparing `(key, etag, size)` is what makes it correct, and content addressing makes the
comparison the natural one.

**Caveat, stated because it will surprise someone later:** an S3/R2 ETag for a multipart
upload is `md5-of-part-md5s-N`, not the object's MD5. Two byte-identical files uploaded with
different part sizes get different etags and will be stored twice. Deduplication is therefore
best-effort; **correctness never depends on it**, only storage efficiency does.

### 8.3 Retention and pruning

Grandfather-father-son, evaluated **per `(owner_key, domain)`** and pruned by the existing hourly
repeatable job. Files defaults to 7 daily / 4 weekly / 6 monthly; Brain is proposed denser because
it is two orders of magnitude smaller (§16.2). The two series never see each other: a nightly
Brain backup must not age out a weekly Files set just by being more frequent.

Blob pruning is a Files-only concern, and the blob namespace is shared across every Files set
regardless of scope. A blob may be deleted only when no retained manifest references its etag.
Rather than a reference-count table — one row per file per backup, hundreds of thousands of rows
for no gain — the prune pass streams the retained manifests and unions their etag sets. Seventeen
retained manifests of 100k files each collapse to a few MB of distinct etags because the sets
overlap almost completely, which is the entire point of content addressing.

Pruning is skipped entirely if any manifest fails to parse. Failing to reclaim storage is
recoverable; deleting a blob still referenced by a backup is not.

## 9. Restore

A CLI, not a button. You restore when the application is broken, which is exactly when a
button is unreachable. Script name `backup:restore`, following the `db:*` / `brain:*` prefix
convention already in `package.json`. The domain is read from the file header — never passed as a
flag, because a flag is a thing you can get wrong.

```bash
npm run backup:restore -- --file aether-brain-….acbak                      # dry run, default
npm run backup:restore -- --file aether-files-….acbak --fresh --confirm    # empty database
npm run backup:restore -- --file aether-brain-….acbak --skip-core --confirm
npm run backup:restore -- --file aether-brain-….acbak --table memories --confirm
```

### 9.1 Modes

| Mode | Use |
|---|---|
| `--dry-run` (default) | Decrypt, verify, print row counts and the change summary. Touches nothing |
| `--fresh` | Restore core + this domain into an empty database. The disaster path |
| `--skip-core` | Restore only this domain's tables. The second artifact of a two-domain recovery |
| `--table <name>` | One table, merged in. Undo a bad bulk delete without rolling back everything |

Two separate gates, because they answer two different questions. `--confirm` means "this is not
a rehearsal" and is required by any mode that writes. `--i-understand-this-destroys-data` is
required *additionally* when `--fresh` finds user rows already in the target — otherwise
`--fresh` aborts. There is no single flag that turns a dry run into a destructive overwrite.

`--table` refuses a table that is not in the artifact's domain or core, naming which artifact does
hold it. Asking a Brain backup for `files` is a mistake worth catching by name rather than by an
empty result.

### 9.2 Refusal rules — all checked before the first write

1. `magic` / `platform` / `headerHmac` invalid → not an Aether Cosmos backup.
2. `formatVersion` newer than this build → "upgrade Aether Cosmos first".
3. `schemaVersion` ≠ current migration head → refuse unless `--force-schema`. Restoring an
   old dump into a newer schema is the classic silent corruption; it must be a deliberate act.
4. Any part missing, mis-ordered, or `payloadSha256` mismatched → refuse, naming the part.
5. Any GCM tag failure → refuse. A wrong passphrase and a tampered file are the same event
   here, reported as "passphrase incorrect or file damaged".
6. `trailerHmac` invalid, or the trailer's `backupId` ≠ the other parts' → the parts are not
   from one set. With a standalone `manifest.json` supplied, it must **agree with** the copy
   sealed in the trailer — field by field, not byte for byte. Byte equality is the wrong test: a
   sidecar that has been through an editor, a `jq`, or a Windows checkout differs in key order
   and line endings while describing the same set, and refusing that would teach the operator to
   drop the flag during the one recovery it exists for. What must match is what a restore acts
   on: `backupId`, `domain`, `schemaVersion`, the table lists, and the row counts. A
   disagreement is reported field by field, because "a manifest from a different set" and "this
   set is incomplete" are different problems with different answers.
7. `--fresh` on a database that already holds this domain's rows → refuse and suggest
   `--skip-core` or the destroy flag. Restoring Brain over an existing Brain is not a merge.

### 9.3 Restoring both domains

The order does not matter, and that is deliberate. Whichever artifact goes first carries core:

```bash
npm run backup:restore -- --file aether-files-….acbak --fresh      --confirm   # core + files
npm run backup:restore -- --file aether-brain-….acbak --skip-core  --confirm   # brain only
```

The first restore is a plain `pg_restore` of the whole archive into an empty database: extensions,
enum types, tables, data, then constraints — `pg_restore` adds foreign keys after the data by
default in custom format, so self-references like `memories.superseded_by_id` and
`folders.parent_id` load without any trigger-disabling privilege. This is why the artifact is a
full dump and not `--data-only`.

The second restore must add only its own domain's tables, and it does that with a **filtered TOC
list**, not with `--table`. `pg_restore --table` deliberately restores nothing the named table
depends on — no indexes, no constraints, no foreign keys — which would leave the brain tables
present, unindexed, and unprotected. So instead:

```
pg_restore -l  archive  >  toc.txt          # every TOC entry, one per line
grep -v <core entries>  toc.txt  >  toc.brain.txt
pg_restore -L toc.brain.txt --single-transaction archive
```

Indexes, constraints, and foreign keys are their own TOC entries, so keeping every entry whose
owning table is in this domain keeps the domain's full structure while dropping core entirely. The
filter is generated from the same table-classification module that builds the exclude list (§5.7) —
one source of truth, tested by the same exhaustiveness test. `--single-transaction` makes the second
restore all-or-nothing, which the first cannot be (it creates the extension and types).

One parsing detail in that filter is load-bearing. `pg_restore -l` prints each entry as
`dumpId; tableoid oid desc namespace tag owner`, substituting `-` for a missing namespace but the
**empty string** for a missing owner — and `pg_dump` records no owner for an `EXTENSION`. So
`CREATE EXTENSION vector` arrives as `EXTENSION - vector ` with one field fewer than a table's
line, marked only by a trailing space. Trimming the line before tokenising reads `vector` as the
*owner* of a nameless entry, which makes the extension check (§10) false for every archive
PostgreSQL has ever written and fails verification on every backup. The parser therefore inspects
the trailing whitespace before splitting, and treats a two-token tail with namespace `-` as
ownerless in case an intermediary ate the space. The filter is an allow-list for the same family
of reasons: an unparseable line is dropped rather than kept, because a missing index is a slow
query while a re-created extension aborts the whole `--single-transaction`.

`--skip-core` is a hard requirement here, and rule 9.2.7 is what stops the operator learning that
the hard way.

If both artifacts are restored, the CLI compares each one's `coreDigest` (§9.4) and prints a
warning when they differ — "core came from the Files backup of 2 Sep; the Brain backup's core is
from 26 Aug, 41 user rows newer". Nothing breaks: the domains reference nothing of each other's,
and every brain FK into `users`/`api_keys` is checked by Postgres at restore time. But a user
created after the older snapshot exists in one core and not the other, and the operator should
hear that from the tool rather than from a support ticket.

### 9.4 `coreDigest`, and `--table` as a merge

`coreDigest` is SHA-256 over, for each core table, its row count and its maximum `updated_at`
(`created_at` where there is no `updated_at`). Cheap to compute during the dump, stable across
`pg_dump` runs of the same data, and enough to answer the only question anyone asks: are these two
files' cores the same snapshot?

`--table` is a **merge, not an overwrite**, because the use case is "undo a bad bulk delete" and a
truncate-and-load would also discard every legitimate row written since the backup. `pg_restore`
cannot merge, so the CLI does it in four steps:

1. `pg_restore --data-only --table=X -f -` to emit the `COPY` stream as SQL text. `--table`'s
   refusal to bring dependencies (§9.3) is harmless here and in fact wanted — the only thing we
   need out of the archive is rows.
2. Rewrite the target to a scratch schema and load it into
   `acbak_staging.X`, created as `CREATE TABLE … (LIKE public.X)` — no constraints, so self-
   references and FKs cannot fight the load order.
3. `INSERT INTO public.X SELECT * FROM acbak_staging.X ON CONFLICT (<pk>) DO UPDATE SET …`.
4. `DROP SCHEMA acbak_staging CASCADE`, and report inserted / updated / unchanged counts.

Deleted rows come back, rows that still exist are brought back to their backup state, and rows
created after the backup are left alone. Dry-run prints those three counts without step 3, which
makes it a genuine rehearsal rather than a syntax check.

### 9.5 After a successful restore

- `sessions`, `otp_tokens`, `oauth_access_tokens`, `upload_sessions` are absent by design;
  every user re-authenticates. This is stated in the output, not left as a surprise.
- After a Brain restore, enqueue re-derivation of `memory_derived_links`, `brain_graph_metrics`,
  `brain_health_snapshots`. After a Files-only restore there is nothing to re-derive.
- Flush Redis caches (`cacheDelPattern`).
- Print `missingBlobs` — file id, name, owner — so the operator knows precisely which files
  came back as records without bytes. (Files domain only.)
- Print a reminder that `mail_senders.app_password_encrypted` and
  `brain_embedding_settings.api_key_encrypted` are only readable if `SESSION_SECRET` matches
  the source instance (§16.1).
- If only one domain was restored, say so plainly: "Brain restored. Files were not part of this
  artifact — the file tree is whatever the database already held." A half-restored system that
  does not announce itself is how a recovery turns into a second incident.

## 10. Verification — a backup nobody has read is a rumour

Verification runs as the last stage of every job, against R2, not against the buffers still
in memory. Reading back what we just wrote is the only way to catch a truncated multipart
upload or a wrong-key envelope.

1. Download every part with a fresh client.
2. Recompute SHA-256 per part; compare to the manifest.
3. Decrypt the DB part and stream it to `pg_restore --list`. A custom-format dump that lists
   its TOC is structurally sound; a corrupt one fails here rather than during a real disaster.
4. `HEAD` a sample of mirrored blobs (all, up to 200; then a random 200) confirming size.
   **Files domain only** — a Brain artifact has no blob part, and step 4 is skipped, not passed.
5. Record `verifiedAt`, `verifiedBytes`, `listedTables`.

Step 3's assertion is domain-specific, and that is the point of doing it per domain rather than
once: the TOC must contain **every table of this artifact's class list and none of the other
domain's**. A Brain artifact whose TOC mentions `files` means the exclude list was built wrong,
and it is far better to learn that from a failing job than from a restore that quietly overwrites
a live file tree. Both domains' TOCs must contain the 8 core tables, `CREATE EXTENSION vector`,
and every enum type — that is what makes either artifact restorable first (§9.3).

Step 3 needs the DEK, so it runs in the **same job that just wrote the artifact**, while the DEK
is still in memory — no passphrase prompt, no stored key required. A later re-verification
sweep unwraps `backup_keys.wrapped_kek`; if that row is gone (a rotated `SESSION_SECRET`),
the sweep does steps 1, 2 and 4 only and labels the result "integrity verified" rather than
"restorable", because that is exactly what it checked.

A job that fails verification ends `failed`, not `completed`, and is not downloadable. The
UI shows "Verified <relative time>" per backup, and a job that has never been verified is
labelled as such. Silence is not success.

Verification cost is one extra full read of the artifact. That is the price of knowing, and
it is paid by the worker, off the request path. Splitting into two domains makes this cheaper,
not dearer: a Brain artifact is small and re-reading it costs little, and it no longer has to be
read alongside gigabytes of file metadata to be trusted.

## 11. Surfaces

### 11.1 API

`domain` is a required parameter everywhere a backup is created or configured, and it is
part of the identity of a settings row — not a filter. There is no route that means "back up
everything".

| Route | Method | Who | Notes |
|---|---|---|---|
| `/api/backup` | GET | any authed | List own backups, both domains, newest first; master also sees `system`. `?domain=` filters |
| `/api/backup` | POST | master (P1) · any authed (P5) | Create. Body `{domain, scope, note?, idempotencyKey}`. Returns job id |
| `/api/backup/[id]` | GET | owner | Job status, domain, parts, verification result |
| `/api/backup/[id]` | DELETE | owner | Delete set + objects |
| `/api/backup/[id]/download/[part]` | POST | owner | Returns a 5-minute presigned URL |
| `/api/backup/settings` | GET | owner | Returns **both** domains' settings rows |
| `/api/backup/settings` | PUT | owner | Body `{domain, …}`. Writes one domain's row; the other is untouched |

`domain` is validated against `"brain" | "files"` with a Zod enum, and an absent or unknown value
is a 400 rather than a default. Defaulting would be the one decision that quietly re-merges the
two backups: whichever domain won the default would become "the" backup, and the other would go
unrun until someone noticed.

`scope: "system"` requires `role === "master"`; `scope: "user"` is always the caller's own id,
never a parameter — an id in the body is an escalation waiting to happen — and is rejected
outright until P5 (§15).

Download is gated by re-entering the **2-Step Code** in the download request itself — there
is no "recently verified" session flag today (`step-code.ts` issues staged tokens at login and
nothing else), so the request body carries the code and the route verifies it with
`verifyStepCode` against `users.step_code_hash`, reusing the existing
`stepCodeFailedAttempts` / `stepCodeLockedUntil` lockout. Accounts with no code enrolled
(`step_code_hash` null) re-enter their password instead. The reason is the same one a bank
re-asks at transfer time: a stolen session should not be enough to walk off with the whole
database. Rate limit: 10 download grants per hour per user, audited as `backup.download` with
domain, part index, and IP.

### 11.2 UI

One page, `/backup`, with **two independent cards** — Second Brain and Files. Not a page with a
domain dropdown: a dropdown makes the two backups look like two views of one thing, and the whole
point of the split is that they are two things with their own schedule, their own retention, their
own history, and their own last-verified time. Each card is a self-contained answer to "is this
half of my data safe?"

The page is reached from the **admin console** by the master (P1) and gains a **sidebar** entry
for regular users when per-user scope ships (P5). What it must never be is a section inside
`/settings`: the sidebar hides that page from a master (`sidebar.tsx` gates the link on
`role !== "master"`), so a `/settings`-only backup screen would be invisible to the one account
that needs it most — the same mistake that left the master with no 2-Step Code control until it
was added to `/admin/users/[id]`.

```
┌─ Backup ────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─ Second Brain ───────────────────────────────────────────┐   │
│  │  Memories, entities, links, agents, review queue         │   │
│  │  Automatic     [ Daily ▾ ]  03:00        ● On            │   │
│  │  Keep          14 daily · 8 weekly · 12 monthly          │   │
│  │                                    [ Back up Brain now ] │   │
│  │  ─────────────────────────────────────────────────────   │   │
│  │  2 Sep 03:00    18 MB    ✓ Verified 2h ago   [Download]  │   │
│  │  1 Sep 03:00    18 MB    ✓ Verified 26h ago  [Download]  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ Files ──────────────────────────────────────────────────┐   │
│  │  Folders, files, versions, shares, notes                 │   │
│  │  Automatic     [ Weekly ▾ ]  Sunday 03:00   ○ Off        │   │
│  │  Keep          7 daily · 4 weekly · 6 monthly            │   │
│  │                                    [ Back up Files now ] │   │
│  │  ─────────────────────────────────────────────────────   │   │
│  │  2 Sep 03:00    1.4 GB   ✓ Verified 2h ago   [Download]  │   │
│  │  19 Aug 03:00     —      ⚠ Failed: dump timeout          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

Each card carries a one-line statement of what is inside it, because "Second Brain" and "Files"
are product names and the user is deciding what to protect, not choosing a label. The lines are
i18n keys like the rest of the app (`en` / `id` / `zh-CN`, edited additively). The schedules and
retention numbers drawn above are the §16.2 proposal in its default state, not fixed UI text.

When one domain has never been backed up, its card shows an empty state that says so in the
imperative — "No Brain backup yet" with the button as the primary action — rather than an empty
table. Two cards make one-sided coverage visible at a glance, which a merged list could hide.

The passphrase moment is the only part of this screen that deserves care. It happens **once per
owner**, at the first backup of *either* domain — manual or scheduled, whichever comes first
(§6.4). One passphrase covers both cards; the dialog says so, because a user who has just been
told the backups are separate will reasonably expect two passphrases and two things to lose. The
passphrase is shown with a copy button, a download-as-text option, and a checkbox the user must
tick — "I have saved this passphrase" — before the dialog will close. There is no "show it to me
again" link, because there is nothing to show: the server kept only Argon2id output. That
sentence appears in the dialog, not in a tooltip.

Rotating the passphrase mints a new one under a new `keyEpoch` and re-wraps nothing. Old
artifacts keep the old passphrase, so each row in each card is labelled with its epoch and the
user always knows which one to type. A backup whose epoch is not the current one says so.

Accessibility, since this page is new (`ui-ux-pro-max` rules, `MASTER.md`): the two cards are
`<section>`s with an `<h2>` each so the domain is announced, not inferred from position; the
status column pairs its icon with text (never colour alone — WCAG 1.4.1); `[Download]` opens the
2-Step Code dialog with focus moved into the input and returned to the button on close; the
passphrase dialog is a focus-trapped modal whose checkbox gates a genuinely `disabled` close
button, and the passphrase itself sits in a `readonly` input so a screen reader can walk it
character by character. Text colours use the `-ink` tokens; the status pills keep their vivid
fills with `--on-*` glyphs (`npm run lint:contrast` enforces AA).

## 12. Database changes

Three new tables, one migration pair — `drizzle/0027_backup.sql` and
`drizzle/0027_backup_rollback.sql`, matching the convention every migration since 0020 follows.
**The operator runs these; the implementation never runs a migration itself.**

The split shows up here as the shape of the schema, not as a column added to an existing design.
Settings are keyed `(owner_key, domain)` — two rows per owner, so Brain can be daily while Files
is weekly, and enabling one cannot touch the other. Keys are keyed by `owner_key` **alone**,
because one passphrase covers both domains (§6.4) and a per-domain key row would mean two
passphrases to lose. Jobs carry `domain` and are unique per `(owner_key, domain,
idempotency_key)`, so a Brain job and a Files job created in the same click are two jobs, not a
collision.

```sql
-- 0027_backup.sql

-- One key per owner, shared by both domains. Separate from backup_settings because its
-- lifetime is different: settings are per-domain and editable, the key is per-owner and
-- write-once per epoch.
CREATE TABLE IF NOT EXISTS backup_keys (
  -- 'system' or 'user:<uuid>'.
  owner_key        text PRIMARY KEY,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  -- The owner's KEK, sealed with SESSION_SECRET. Written at the first backup of either
  -- domain; unreadable (and reset) after SESSION_SECRET rotation.
  wrapped_kek      text NOT NULL,
  kdf_salt         text NOT NULL,
  key_epoch        integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at       timestamptz
);

CREATE TABLE IF NOT EXISTS backup_settings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key        text NOT NULL,
  -- 'brain' | 'files'. Part of the identity of the row, not a filter on it.
  domain           text NOT NULL,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  enabled          boolean NOT NULL DEFAULT false,
  frequency        text NOT NULL DEFAULT 'weekly',   -- daily | weekly | monthly
  hour_utc         integer NOT NULL DEFAULT 3,
  day_of_week      integer,                          -- 0-6, weekly only
  day_of_month     integer,                          -- 1-28, monthly only
  keep_daily       integer NOT NULL DEFAULT 7,
  keep_weekly      integer NOT NULL DEFAULT 4,
  keep_monthly     integer NOT NULL DEFAULT 6,
  -- All-or-nothing: pg_dump cannot filter rows, so a time window is not implementable (§5.6).
  include_logs     boolean NOT NULL DEFAULT true,
  last_run_at      timestamptz,
  next_run_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_settings_domain_chk CHECK (domain IN ('brain', 'files'))
);

-- One settings row per owner per domain. This is what makes "enable the schedule"
-- idempotent, and what keeps the two domains from sharing a schedule by accident.
CREATE UNIQUE INDEX IF NOT EXISTS backup_settings_owner_domain_idx
  ON backup_settings (owner_key, domain);

-- The scheduler's only query: which rows are due?
CREATE INDEX IF NOT EXISTS backup_settings_due_idx
  ON backup_settings (next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS backup_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key        text NOT NULL,
  domain           text NOT NULL,                    -- brain | files
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  scope            text NOT NULL,                    -- system | user
  trigger          text NOT NULL,                    -- manual | scheduled
  status           text NOT NULL DEFAULT 'created',
  key_epoch        integer NOT NULL DEFAULT 1,
  idempotency_key  text NOT NULL,
  note             text,
  -- Manifest, parts, coreDigest, missingBlobs, verification result. One JSON column
  -- instead of three child tables: it is written once by one worker and only ever
  -- read whole.
  manifest         jsonb,
  total_bytes      bigint NOT NULL DEFAULT 0,
  error            text,
  verified_at      timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_jobs_domain_chk CHECK (domain IN ('brain', 'files'))
);

-- Single-flight per domain: a double click cannot create the same job twice, and the
-- Brain job does not collide with the Files job that shares its idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_owner_domain_idem_idx
  ON backup_jobs (owner_key, domain, idempotency_key);

-- The list query: newest first for one owner, optionally narrowed to one card.
CREATE INDEX IF NOT EXISTS backup_jobs_owner_domain_created_idx
  ON backup_jobs (owner_key, domain, created_at DESC);

-- Retention and orphan GC both scan by status.
CREATE INDEX IF NOT EXISTS backup_jobs_status_idx ON backup_jobs (status);

-- FK child index, same rule 0021 applied to every other FK in this schema.
CREATE INDEX IF NOT EXISTS backup_jobs_user_id_idx ON backup_jobs (user_id);
CREATE INDEX IF NOT EXISTS backup_settings_user_id_idx ON backup_settings (user_id);
CREATE INDEX IF NOT EXISTS backup_keys_user_id_idx ON backup_keys (user_id);
```

```sql
-- 0027_backup_rollback.sql
DROP TABLE IF EXISTS backup_jobs;
DROP TABLE IF EXISTS backup_settings;
DROP TABLE IF EXISTS backup_keys;
```

All three tables are in the **never-restored** class of §5.5. A restored `backup_jobs` row would
point at objects that may not exist in the destination bucket and would claim a verification that
was never performed against it; a restored `backup_keys` row would carry a KEK sealed with the
*source* instance's `SESSION_SECRET`, which on a new VPS is an unreadable blob masquerading as a
usable key — worse than absent, because absent triggers a clean first-backup key creation. History
of the old instance is not history of the new one.

`owner_key` rather than a nullable `user_id` alone: `'system'` has no user row, and a partial
unique index over a nullable column to express "one system row" is harder to read than a text
key that says what it is. `user_id` is kept alongside purely so `ON DELETE CASCADE` cleans up
when an account is deleted.

`backup_settings` takes a surrogate `id` primary key with a unique index on `(owner_key, domain)`
rather than a composite primary key, because Drizzle's `.references()` and the app's existing
row-by-id update helpers all assume a single-column key, and every other table in
`schema.ts` follows that shape. The unique index carries the real constraint.

`domain` is a `text` column with a `CHECK`, not a `pgEnum`. Every enum in this schema costs a
`CREATE TYPE` in the dump and a migration to extend; a two-value check constraint is the same
guarantee with none of that, and §5.5's rule that new tables must be classified is enforced by a
test rather than by the type system anyway.

The column defaults above are the **Files** numbers, because a single column default cannot differ
per domain. The application seeds each settings row on first read, and seeds the Brain row with
§16.2's denser retention (14/8/12, schedule on) rather than accepting the column defaults. Two
rows created by the same code path with two different sets of values is the honest way to express
"the domains have different natural cadences"; a `CASE` in a DDL default is not available and a
second table would be worse.

## 13. Infrastructure changes

**1. `pg_dump` in the worker image.** `docker/Dockerfile.worker` gains
`postgresql17-client`. Pinned to 17 because `pg_dump` requires client ≥ server and Aiven runs
nothing above 17 today; a client newer than the server is always safe, the reverse never is.

**2. A version check per job, not at boot.** Before a dump starts, `assertPgToolsUsable` reads
`pg_dump --version`, `pg_restore --version` and `SHOW server_version`, and refuses the job if the
client cannot be parsed, is older than 16, or is older than the server — naming the package to
install (`postgresql<N>-client`). The restore CLI calls the same function before it touches
anything.

Per job rather than on boot, which is a change from this document's first draft. A worker that
starts before the database is reachable is normal on a single box where Postgres, Redis and the app
come up together, and refusing to register the queue for it would turn a five-second startup race
into a dead backup subsystem that only a redeploy clears. Failing the one job that needs the tool
puts the message in the job record, where the operator is already looking, and costs two `--version`
spawns per run. The version parser reads the number from the *front* of the string, because Debian
and Ubuntu append their own package version — `pg_dump (PostgreSQL) 16.4 (Ubuntu 16.4-…)` — and
anchoring at the end reads the packaging or nothing at all.

**3. `copyR2Object` gains an optional destination bucket** — **P4, not built.**
`copyR2Object` (`src/features/files/infrastructure/storage/r2.ts:176`) still takes only
`(sourceKey, destKey)`. The parameter would default to the current bucket so every existing caller
is unchanged, and is needed only if blobs are ever mirrored into a separate bucket; the default
single-bucket path stays the norm.

**4. Multipart copy for blobs over 5 GB** — **P4, not built.** The 5 GB `CopyObject` ceiling is
still a local constant in `app/api/files/paste/route.ts:57` (`MAX_SINGLE_PART_COPY_BYTES`); the
mirror needs the same limit, so it moves into `r2.ts` next to `copyR2Object` and both callers
import it. Above the limit the mirror uses `UploadPartCopy`. No object that large exists today, so
this is a correctness guard, not a hot path — and nothing in P1–P3 copies a blob at all.

**5. Upload path and memory ceiling.** The artifact is written by a shared streaming uploader,
`uploadR2Stream` in `src/shared/infrastructure/storage/r2-stream.ts` — streaming multipart with
abort-on-error, for "internally generated objects", which is exactly this case. It lives in
`shared/` rather than being borrowed from the Files feature because the layer rules forbid one
feature importing another's infrastructure, and because the two callers want different part
sizes from the same bucket.

The part size *is* the memory budget: exactly one part is buffered at a time. Files keeps the
64 MiB default; the backup passes `BACKUP_PART_SIZE_BYTES` = **16 MiB**, which gives
16 MiB part + 4 MiB plaintext chunk + 4 MiB ciphertext ≈ **~24 MiB resident**, one job at a
time, on a 2 GB VPS already running Next.js, Redis, and the worker. The cost of the smaller part
is a lower object ceiling — 10 000 parts × 16 MiB = 160 GB — which is far past anything this
instance will produce. R2's 5 MiB minimum part size is the floor, and the uploader clamps to it
rather than letting R2 reject the part with an opaque error.

The two domains do not double that figure. The advisory lock is taken on `owner_key` alone
(§7.4), so a Brain job and a Files job for the same owner serialise rather than run side by side,
and the ceiling stays ~24 MiB no matter how many domains exist. This is the reason the lock is not
keyed `(owner_key, domain)`, which would otherwise be the more natural choice: on a 2 GB box,
concurrency is the thing we are buying protection from, not the thing we want.

**6. One engine, two exclude lists.** Nothing in the worker, the envelope, the uploader, or the
verifier is domain-aware beyond a single `domain` argument that selects an exclude list (§7.2) and
whether the mirror stage runs (§7.5). There is no second code path to keep in step with the first,
which is what makes shipping both domains in P1 cheaper than shipping one and retrofitting the
other.

## 14. Testing strategy

The engine is pure enough to test properly, and the parts that matter are the failure paths.
Existing suites (`tests/*.test.ts`, Vitest, `environment: "node"`) are the model, including the
convention of skipping DB integration tests when `DATABASE_URL` is absent.

**`tests/backup-envelope.test.ts` — the crypto envelope, no I/O**

| Case | Expected |
|---|---|
| Round-trip 0 B, 1 B, exactly 4 MiB, 4 MiB + 1, 10 MiB | Byte-identical plaintext out |
| Wrong passphrase | Rejected at the first chunk, no plaintext emitted |
| Flip one ciphertext byte | GCM tag failure, named chunk index |
| Truncate the last chunk | Rejected — `isFinal` never seen |
| Swap chunk 2 and chunk 3 | Rejected — AAD binds the index |
| Splice chunk 5 from another backup with the same passphrase | Rejected — AAD binds `backupId` |
| Tamper with the header `note` | `headerHmac` mismatch |
| Tamper with the trailer manifest | `trailerHmac` mismatch |
| Append bytes after the trailer | Refused — the end marker must be *at* EOF, not merely present |
| `formatVersion` = current + 1 | Refused with the upgrade message |
| `platform` ≠ `"aether-cosmos"` | Refused |
| `domain` = `"brain"`, restore asked for files | Refused, naming the artifact that holds it |
| `domain` absent or unrecognised | Refused — no default domain, ever |
| Splice a Brain chunk into a Files artifact, same passphrase and epoch | Rejected — AAD binds `backupId`, and `domain` is in the HMAC'd header |

The reorder and splice cases are the reason AAD includes indices and `backupId` at all; without
tests they would be an unverified claim in a comment. The last two rows are the split's own
failure mode: one KEK covers both domains (§6.4), so the *only* thing standing between a
cross-domain splice and a successful decrypt is that `backupId` differs and `domain` is inside
the HMAC'd header. That deserves a test rather than a paragraph.

The appended-bytes row reverses what an earlier draft of this document assumed. `payloadBytes`
does bound the region `payloadSha256` covers, so a file with junk after its trailer still hashes
correctly — and that is precisely why the reader refuses it rather than ignoring it:
`readTrailerLength` looks for the end marker in the last twelve bytes, and anything that pushed
the marker off EOF was not written by this app. A digest that passes while the file's shape is
wrong is the one case where "tolerate it" and "someone is editing artifacts" look identical.

**`tests/backup-manifest.test.ts`** — `payloadSha256` covers header + chunks and excludes the
trailer; a set with fewer parts than `partCount` is incomplete; a trailer from set A rejects
parts from set B; a supplied standalone manifest that differs from the trailer is refused;
`missingBlobs` survives the round-trip; `coreDigest` is byte-stable across two dumps of unchanged
core data and changes when a user row is added. *(The row "a Files manifest has a
`blobs.index.acbak` part and a Brain manifest does not" belongs to **P4**: until the mirror exists,
both domains produce exactly one `data` part, and asserting otherwise would be asserting a
feature into existence.)*

**`tests/backup-table-classification.test.ts`** — the two structural tests from §5.7, and the
most valuable file in this list because both of them fail on the day someone adds a table and
forgets this document exists:

1. **Exhaustiveness.** `import * as schema`, assert every `pgTable` export appears in exactly
   one class — core, files, brain, derived, never. Today: 8 + 8 + 15 + 4 + 10 = 45, plus the
   three of §12 = 48.
2. **FK closure.** Walk every `references()` in the schema and assert no foreign key crosses
   from a files-domain table to a brain-domain table or back. `brain_agents.api_key_id →
   api_keys.id` passes because `api_keys` is core; a new `memories.file_id` would fail, loudly,
   at the moment it is written rather than at the first restore. This test *is* the two-artifact
   guarantee — everything else in this document depends on the property it checks.

**`tests/backup-retention.test.ts`** — GFS selection over synthetic timestamps (DST boundary,
month with 28 days, a gap where a scheduled run failed); an unparseable manifest aborts the
prune instead of deleting; **pruning one domain never selects the other domain's sets** —
retention is evaluated per `(owner_key, domain)`, and a Brain backup every day plus a Files
backup every week must not let the denser series evict the sparser one. *(The row "a blob
referenced by exactly one retained manifest is never deleted" is **P4**: there are no mirrored
blobs to reference yet, and the prune deletes by R2 prefix, which is why it is safe to defer.)*

**`tests/backup-route-gates.test.ts`** — following `tests/shared-file-route-gates.test.ts`:
`scope: "system"` as non-master → 403; requesting another user's backup → 404 not 403 (don't
confirm existence); download with a wrong 2-Step Code → 401 `STEP_CODE_INVALID`; with no code in
the body → 400 `VALIDATION_ERROR` (the schema, before any gate); while the code is locked → **429
`STEP_CODE_LOCKED`**; on an account that never set one → 400 `STEP_CODE_NOT_SET`; the `user_id` in
a POST body is ignored; a POST with no `domain` → 400 rather than a default; a POST with
`domain: "everything"` → 400; two POSTs sharing an `idempotencyKey` across the two domains
create two jobs, while two in the same domain create one; `PUT /api/backup/settings` for one
domain leaves the other domain's row byte-identical.

429 and not 423: a lockout is rate limiting, which is what every client and proxy already
understands 429 to mean, and the dialog needs the 401/429 distinction to decide whether to keep
the input open for another try or close it and start a countdown. 423 `Locked` is WebDAV's
resource lock and would say something else entirely.

**The live-database drill — the restore CLI itself, not a test file.** The obvious addition here
is a `DATABASE_URL`-gated integration test: `pg_dump` a seeded database, restore into a scratch
one, compare row counts per included table, assert the excluded tables are empty, twice per
domain. It is not shipped, and the reason is that the thing it would build already exists in a
better form. Every mode of `scripts/backup-restore.ts` is a rehearsal until `--confirm` is
passed: `--dry-run` pulls the header and trailer, decrypts, reads the TOC and prints the plan
without touching a database, and `--fresh`/`--skip-core`/`--table` against a scratch
`DATABASE_URL` *is* the round-trip the test would perform — run by the same code path a real
recovery uses, which a test harness spawning its own `pg_dump` would not be.

What that leaves untested by machine is the sequence: restore the Files artifact `--fresh`, then
the Brain artifact `--skip-core`, and assert every brain FK into `users` and `api_keys` resolves.
That is §9.3's central claim, it needs a live server and a `pg_dump`/`pg_restore` pair to check,
and it is the first thing to run on the VPS — `--dry-run` on both artifacts, then the pair into a
scratch database — rather than something to assert in CI, where no PostgreSQL client exists.

## 15. Phases

Each phase is independently useful and independently shippable. If work stops after P1, the
system has real backups — that is the ordering principle.

**P1 ships both domains.** Not Brain first, then Files: the engine is one code path with two
exclude lists (§13.6), so building one and retrofitting the other would cost more than building
both and would leave half the data uncovered for however long the retrofit took. The split is a
property of the design from the first commit, which is also the only way §5.7's FK-closure test
can be true from the first commit.

**P1 — Engine and verification, both domains.** Crypto envelope (header, chunks, trailer), the
owner KEK sealed under `SESSION_SECRET`, `pg_dump` streaming with the per-domain exclude list,
manifest, R2 write, post-write verification with the per-domain TOC assertion,
`backup_keys`/`backup_settings`/`backup_jobs`, manual `POST /api/backup` for `scope: "system"` in
either domain, the `/backup` page in the admin console with its two cards (§11.2) — create, list,
download — the passphrase-shown-once dialog, and `pg_dump` in the worker image with the per-job
version gate (§13.2). Deliverable: the master can produce, verify, and download **an encrypted
Second Brain backup and an encrypted Files backup, separately**. This is the phase that ends the
current exposure.

**P2 — Restore.** The CLI: dry-run, `--fresh`, `--skip-core`, `--table` with the staging-schema
merge, every refusal rule of §9.2, the `coreDigest` comparison, post-restore re-derivation and
cache flush. Deliverable: both artifacts are proven usable, individually and in sequence, which is
the only thing that makes P1 worth having. P1 without P2 is faith.

**P3 — Schedule and retention.** Per-domain frequency settings, `next_run_at`, the hourly worker
hook running unattended off the P1 KEK, GFS pruning evaluated per `(owner_key, domain)`,
`keyEpoch` rotation. Deliverable: both backups happen without anyone remembering to click, on
their own cadences — Brain nightly because it is small, Files weekly because it is not.

**P4 — Blob mirror, Files domain only.** Content-addressed R2→R2 mirror, incremental by etag,
multipart copy above 5 GB, `missingBlobs` reconciliation, prune by set difference. Deliverable:
file bytes are covered, not just metadata. Deliberately last of the automatic phases: it is the
largest surface and the least urgent, because R2 durability is not the threat model (§4) — our own
bugs are.

Until P4 lands, the Files card says so in words, because "Files backup" that contains no file
bytes is exactly the kind of thing a user discovers at the worst possible moment: **"File records
and structure. File contents are not included yet."** The Brain card needs no such caveat — a
Brain backup is complete from P1, since memories live in the database and nowhere else. That
asymmetry is worth stating plainly rather than smoothing over: from P1, Second Brain is fully
backed up and Files is half backed up.

**P5 — Per-user takeout.** `scope: "user"` for both domains: one user's rows plus their own
blobs, initiated by the user, plus the sidebar entry that makes `/backup` reachable for non-master
accounts. Deliverable: a data-portability answer — and, given the split, a genuinely useful one:
"export my notes" and "export my files" are two different requests, and now they have two
different buttons.

Through P4 the API accepts only `scope: "system"` and rejects `scope: "user"` with "not yet
available" — the shape is in the contract from day one so P5 adds a capability rather than
reworking routes, but nothing pretends to work before it does. `domain`, by contrast, is fully
live from P1: both values are accepted, and neither is a stub.

## 16. Open decisions

These need one answer each before P1 code is written. Everything above is settled.

### 16.1 Credentials inside the artifact

`mail_senders.app_password_encrypted` and `brain_embedding_settings.api_key_encrypted` are
sealed with a key derived from `SESSION_SECRET`. Both are core-or-brain tables, so this question
applies to both artifacts. Two options, and this is the operator's call because it is a policy
question, not a technical one:

- **(a) Include as-is (recommended).** Restore is whole; nothing to re-enter. The ciphertext is
  useless without `SESSION_SECRET`, so a restore onto a new VPS with a new secret yields
  unreadable values that must be re-entered anyway — the same behaviour the operator already
  knows from rotating the secret. The artifact holds no plaintext credential.
- **(b) Exclude and re-enter.** The artifact provably contains no credential material, at the
  cost of two manual steps after every restore.

Note this is exactly the trap that already bit once: changing `SESSION_SECRET` silently broke
stored Gmail App Passwords and the embedding key. Under (a) the restore output must say so.

### 16.2 Retention defaults, per domain and per user

The split makes one set of numbers wrong for both domains, because the two artifacts differ in
size by roughly two orders of magnitude. Proposal:

| | Brain | Files |
|---|---|---|
| System, default schedule | Daily 03:00, **on** | Weekly Sunday 03:00, **off** |
| System, retention | 14 daily / 8 weekly / 12 monthly | 7 daily / 4 weekly / 6 monthly |
| Per-user (P5) | 3 daily / 2 weekly / 0 monthly, cap 5 sets, 30-day expiry, schedule off | same |

Brain gets a longer, denser history because it costs almost nothing to keep — 34 sets of an 18 MB
artifact is under a gigabyte — and because it is the data whose loss is least recoverable by other
means. Files keeps 7/4/6 because 17 sets × 1.4 GB is already 24 GB before any blob mirror. For 500
users at the per-user caps it is 5 sets each, capped, expiring in 30 days. Needs a yes, or
different numbers.

### 16.3 Passphrase: system-generated only, or user-chosen allowed?

The design assumes system-generated (§6.5) — nine words, 81 bits, which is what makes the
Argon2id cost meaningful. Allowing a user-chosen passphrase reintroduces `password123` and
quietly undoes the whole KDF argument. Recommendation: system-generated only, no override.
Needs a yes.

### 16.4 One passphrase for both domains, or one each?

§6.4 gives each owner a single KEK covering both artifacts. One passphrase to save, one to
remember, one dialog ever — and a cross-domain splice is still refused, because AAD binds
`backupId` to every chunk and `domain` sits inside the HMAC'd header (§14). The alternative is a
passphrase per domain, which buys a genuine property: a leaked Brain passphrase cannot open the
Files artifact. It costs two secrets to lose instead of one, and on the evidence of how people
actually store recovery phrases, that trade usually loses.

Recommendation: **one passphrase per owner**, as designed. Worth an explicit yes rather than a
silent assumption, because it is the one place where the two artifacts are not independent, and
reversing it after P1 means a migration.
