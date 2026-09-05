# Account Backup & Restore

Every account backs up **its own** data: the files it owns and the Second Brain it
owns. One `.afrbak` file per section, downloaded by the account holder, restorable
into the same account or into a fresh account on another server.

This is not a server backup. The master's backup contains the master's own data and
nobody else's. Disaster recovery for the whole deployment is a PostgreSQL dump plus
the R2 bucket — see [Deployment](deployment.md).

```
/backup        one card per section (Files, Brain): what is in it, Download, Restore
```

---

## Two keys open one file

Each archive is sealed with a random data key, and that key is wrapped twice:

| Keyslot | Wrapped with | Opens when |
|---|---|---|
| 0 | `BACKUP_MASTER_KEY` — this server's key | restoring on the server that wrote the file |
| 1 | a nine-word recovery phrase, through Argon2id | always, on any server, for anyone holding the words |

Either slot alone is enough. That is the whole design: restoring on the same server
asks for nothing, and restoring on a rebuilt or different server asks for the phrase.
Nothing in the archive is readable without one of the two, which is what makes
"only the AFR platform can read it" true rather than a claim.

### `BACKUP_MASTER_KEY`

- **Generated on first install**, by `scripts/deploy/*`. It is never typed in by hand
  and never needs to be carried to a new VPS.
- **Never replaced once set.** `autofill_env` fills it only when it is empty or still
  the `.env.example` placeholder.
- Accepts 64 hex characters, or base64/base64url that decodes to exactly 32 bytes.
  Arithmetic sequences, fewer than 16 distinct bytes, and all-printable-ASCII are
  rejected — those are the shapes a hand-typed "key" takes.
- Rotating it makes every existing archive phrase-only, unless the old value is listed
  in `BACKUP_MASTER_KEY_PREVIOUS` (comma- or space-separated; the ring refuses two
  entries with the same key id).
- Absent or unusable: `/backup` answers **503** and nothing else in the app changes.

`aether doctor` reports whether the key is set. `aether update` fills it in on an
existing deployment that predates the feature.

### The recovery phrase

Nine words, 81 bits, from a 512-word list.

- **Shown on every single download**, in a dialog, *before* any bytes move. That order
  is deliberate: the dialog is the only moment the words exist in readable form, so a
  user who closes the tab must not already have the file.
- **Different for every download.** It is derived from `BACKUP_MASTER_KEY` and that
  download's ticket id, so two backups of the same section never share a phrase.
- **Stored nowhere.** Not in PostgreSQL, not in Redis, not in the archive. The download
  handler recomputes the identical words from the ticket it is handed. The audit log
  records that a phrase was shown and how many words it had — never the words.
- Lose it and the archive still opens on this server. Lose it *and* the server, and
  nothing opens the archive, by design.

---

## Downloading

1. `POST /api/backup/takeout/prepare` — refuses what cannot be exported, mints a
   **90-second** ticket, returns the phrase.
2. The dialog blocks on "write these down".
3. `GET /api/backup/takeout/{ticket}` — streams the archive as
   `afr-files-YYYYMMDD.afrbak` or `afr-brain-YYYYMMDD.afrbak`.

Refusals happen in step 1 rather than mid-stream, because a sentence in a dialog is
still possible there and a truncated download is not.

| Limit | Value |
|---|---|
| Backups per section | 1 per 10 minutes |
| Ticket lifetime | 90 seconds |
| Files / folders per archive | 200,000 / 50,000 |
| Brain rows per archive | 500,000 |
| End-to-end encrypted files | refused — the server holds no key to re-seal them |

---

## Restoring

Drop the `.afrbak` on the card for its own section. A Brain archive on the Files card
is refused, and the other way round.

**Inspect first.** The page uploads a **prefix**, not the archive: 32 bytes of preamble
say exactly how far to read, and that is at most ~80 KiB however large the file is. From
it the page learns what is inside, whether this account already owns the archive, whether
a phrase is needed, and — when the archive's index fits in 2 MiB — the exact
restore/skip/rename split. When it cannot compute that split from the index it says so
instead of estimating.

| Mode | Effect | Second factor |
|---|---|---|
| **Merge** | Nothing is lost: matching paths are skipped, non-matching ones are restored under a new name. | no |
| **Replace** | Files go to the Recycle Bin, Brain memories are deleted outright, then the archive is restored. | **2-Step Code** |

Replace is the one action in this feature that destroys data, so it is gated on the same
code and the same lockout counters login uses — a stolen session cannot wipe an account.

**Adoption.** An archive whose identity this account does not hold is refused *unless*
the recovery phrase opened it. That is the migration path: type the words, the account
adopts the archive's identity, and the restore proceeds. It is recorded as
`backup_restore_adopted`.

**Streaming.** The upload is never buffered — 4 MiB at a time, decrypted and written as
it arrives. `/api/backup/restore` is excluded from the `proxy.ts` matcher for exactly
this reason: Next buffers the body of every matched route at 10 MB and, past that,
silently pushes EOF into the copy the handler reads. That failure once surfaced as
"wrong recovery phrase" on a perfectly good 40 MB archive.

**After a Brain restore.** The archive carries the graph the account authored and the
memory embeddings, but not `memory_derived_links` — the scored edges behind
`/brain/graph` are derived data and are always recomputed. The restore queues that
rebuild for the background worker and reports "queued N of M", so a stopped worker reads
as a queue that did not move rather than as an empty graph.

---

## Deliberate limits

These are decisions, not gaps:

- **Authorship collapses to the restoring account.** Every restored row is owned by the
  account that restored it. An archive cannot introduce a row attributed to someone else.
- **The payload digest sits in the plaintext trailer.** It proves the encrypted payload
  was not altered; it does not hide how large the payload is.
- **The derived-graph sweep handles at most 1,000 memories per run** and does not requeue
  itself. A brain larger than that needs `npm run brain:backfill-relate` after the
  restore.
- **End-to-end encrypted files are never in an archive.** The server cannot re-seal what
  it cannot read.
- **A download failure is silent.** The download is an anchor navigation, so if the
  ticket expires between the dialog and the click, the browser reports it, not the page.

## Audit trail

| Action | Written when |
|---|---|
| `backup_recovery_view` | a phrase was shown (records the word count, never the words) |
| `backup_restore_merge` / `backup_restore_replace` | a restore committed, with its counts |
| `backup_restore_adopted` | a phrase bound a new identity to this account |
| `backup_restore_refused` | any refusal, with its number and detail — written before the response, so the record exists even for the deliberately vague messages |

## When a restore refuses

"This backup cannot be opened. Wrong recovery phrase, or the file is damaged." is one
message for several causes, on purpose — it does not tell an attacker which guess was
close. The `backup_restore_refused` audit row carries the real reason. See
[Troubleshooting](troubleshooting.md).

## Design documents

The two specs under `docs/superpowers/specs/` are the authority for this feature and are
cited by section number throughout the source:

- `2026-09-01-backup-design.md` — the `.afrbak` container, keyslots, wordlist.
- `2026-09-03-per-user-backup-restore-design.md` — the per-account flow, the numbered
  refusals, and the restore stage order.



