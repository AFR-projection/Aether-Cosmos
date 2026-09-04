import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AFR_ARGON2,
  MASTER_KEY_ENV,
  PREVIOUS_KEYS_ENV,
  deriveKeyId,
  deriveRecoveryWrappingKey,
  newDek,
  newPhraseSalt,
  openDek,
  openRecoveryKey,
  parseMasterKeyMaterial,
  parseMasterKeyRing,
  resolveMasterKey,
  sealRecoveryKey,
  unwrapDek,
  wrapDek,
  type AfrKeyRing,
  type AfrMasterKey,
} from "@backup/account/domain/keys";
import {
  AFR_CHUNK_SIZE,
  AFR_FORMAT_VERSION,
  encodeHeader,
  encodePreamble,
  headerHmac,
  type AfrAadContext,
  type AfrArgon2Params,
  type AfrHeader,
} from "@backup/account/domain/format";
import { AccountBackupError, GENERIC_UNREADABLE_MESSAGE } from "@backup/account/domain/errors";
import { BackupError } from "@backup/domain/errors";
import {
  KDF_MEMORY_KIB,
  KDF_PARALLELISM,
  KDF_SALT_BYTES,
  KDF_TIME_COST,
  KEY_BYTES,
} from "@backup/domain/types";

/**
 * The two doors into an archive, and what each one refuses.
 *
 * The tests that matter most here are the ones that pretend the server is gone. An
 * archive is only a disaster-recovery artifact if it opens on an instance that never
 * held the key it was written under — so "unknown `keyId` plus the right phrase opens
 * it" and "unknown `keyId` plus the wrong phrase says nothing useful" are the two
 * halves of the whole feature, and both are here.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4, §9.
 */

/**
 * Argon2id at a cost a test suite can afford.
 *
 * The real numbers (256 MiB, t=4) are asserted below as *data* rather than exercised:
 * every archive carries its own cost in the header and {@link openDek} uses that, so a
 * cheap header is the honest way to test the mechanism without spending a second per
 * derivation proving a constant this file also reads directly.
 */
const CHEAP: AfrArgon2Params = { m: 8 * 1024, t: 1, p: 1 };

const PHRASE = "amber cider harbor lantern meadow pepper quartz shelter tundra";

/** 32 bytes of real entropy, spelled the way an operator would paste them. */
function keyMaterial(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

function ringOf(active: string, previous?: string): AfrKeyRing {
  return parseMasterKeyRing({
    [MASTER_KEY_ENV]: active,
    ...(previous === undefined ? {} : { [PREVIOUS_KEYS_ENV]: previous }),
  });
}

interface Refusal {
  message: string;
  code: string;
  detail: string;
  /** Present only for the nine numbered refusals of §9. */
  reason?: number;
}

function asRefusal(error: unknown): Refusal {
  if (!(error instanceof BackupError)) throw error;
  const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
  return {
    message: error.message,
    code: error.code,
    detail,
    reason: error instanceof AccountBackupError ? error.reason : undefined,
  };
}

function refusalOf(run: () => unknown): Refusal {
  try {
    run();
  } catch (error) {
    return asRefusal(error);
  }
  return expect.unreachable("expected a refusal");
}

async function refusalOfAsync(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    return asRefusal(error);
  }
  return expect.unreachable("expected a refusal");
}

interface WrittenArchive {
  header: AfrHeader;
  preamble: Buffer;
  headerBytes: Buffer;
  headerMac: Buffer;
  context: AfrAadContext;
  dek: Buffer;
}

/**
 * What the exporter will write, minus the payload: a DEK sealed into both keyslots and
 * a header MAC'd under the instance that wrote it. Everything below reads this back the
 * way a reader on some *other* instance would.
 */
async function writeArchive(options: {
  writer: AfrMasterKey;
  phrase?: string;
  domain?: "files" | "brain";
  backupId?: string;
}): Promise<WrittenArchive> {
  const domain = options.domain ?? "files";
  const backupId = options.backupId ?? "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60";
  const context: AfrAadContext = { backupId, domain, formatVersion: AFR_FORMAT_VERSION };
  const dek = newDek();
  const phraseSalt = newPhraseSalt();
  const rwk = await deriveRecoveryWrappingKey(options.phrase ?? PHRASE, phraseSalt, CHEAP);
  const header: AfrHeader = {
    backupId,
    createdAt: 1_772_500_000_000,
    keyId: options.writer.keyId,
    keyslot: [wrapDek(options.writer.key, dek, context, 0), wrapDek(rwk, dek, context, 1)],
    phraseSalt,
    argon2: CHEAP,
    chunkNoncePrefix: randomBytes(8),
    summaryNonce: randomBytes(12),
    indexNonce: randomBytes(12),
  };
  const headerBytes = encodeHeader(header);
  const preamble = encodePreamble({
    formatVersion: AFR_FORMAT_VERSION,
    domain,
    headerLength: headerBytes.length,
    summaryLength: 300,
    indexLength: 9_001,
    chunkSize: AFR_CHUNK_SIZE,
  });
  return {
    header,
    preamble,
    headerBytes,
    headerMac: headerHmac(options.writer.key, preamble, headerBytes),
    context,
    dek,
  };
}

/** Read an archive on an instance holding `ring`, with or without a typed phrase. */
function openWith(archive: WrittenArchive, ring: AfrKeyRing, phrase?: string) {
  return openDek({
    header: archive.header,
    preamble: archive.preamble,
    headerBytes: archive.headerBytes,
    headerMac: archive.headerMac,
    context: archive.context,
    ring,
    phrase,
  });
}

describe("BACKUP_MASTER_KEY is 32 random bytes or it is not configured", () => {
  it("reads hex, base64, and base64url spellings of the same key", () => {
    const key = randomBytes(KEY_BYTES);
    const hex = parseMasterKeyMaterial(key.toString("hex"), MASTER_KEY_ENV);
    const b64 = parseMasterKeyMaterial(key.toString("base64"), MASTER_KEY_ENV);
    const b64url = parseMasterKeyMaterial(key.toString("base64url"), MASTER_KEY_ENV);

    expect(hex.equals(key)).toBe(true);
    expect(b64.equals(key)).toBe(true);
    expect(b64url.equals(key)).toBe(true);
  });

  it("reads 64 hex characters as hex, never as base64 of 48 other bytes", () => {
    const hex = randomBytes(KEY_BYTES).toString("hex");

    // The same string is valid base64; decoding it that way yields 48 bytes, which is
    // the length check's job to catch — but only if the length check is what runs.
    expect(parseMasterKeyMaterial(hex, MASTER_KEY_ENV)).toHaveLength(KEY_BYTES);
    expect(Buffer.from(hex, "base64")).toHaveLength(48);
  });

  it("ignores surrounding whitespace, which a .env file adds for free", () => {
    const key = randomBytes(KEY_BYTES);

    expect(
      parseMasterKeyMaterial(` ${key.toString("base64")}\n`, MASTER_KEY_ENV).equals(key)
    ).toBe(true);
  });

  it("checks the charset before decoding, because Node's decoder skips junk", () => {
    const key = randomBytes(KEY_BYTES).toString("base64");
    const junked = `${key.slice(0, 10)}*${key.slice(10)}`;

    // Node would quietly drop the `*` and hand back 32 plausible bytes.
    expect(Buffer.from(junked, "base64")).toHaveLength(KEY_BYTES);
    expect(refusalOf(() => parseMasterKeyMaterial(junked, MASTER_KEY_ENV)).detail).toMatch(
      /neither hex nor base64/
    );
  });

  it("refuses an empty value and a wrong length, naming the variable", () => {
    expect(refusalOf(() => parseMasterKeyMaterial("   ", MASTER_KEY_ENV)).detail).toBe(
      `${MASTER_KEY_ENV} is empty`
    );
    expect(
      refusalOf(() =>
        parseMasterKeyMaterial(randomBytes(16).toString("base64"), MASTER_KEY_ENV)
      ).detail
    ).toMatch(/decodes to 16 bytes, needs exactly 32/);
  });
});

describe("the entropy guards, each catching one real way an operator gets this wrong", () => {
  it("refuses a constant or counting sequence", () => {
    const flat = Buffer.alloc(KEY_BYTES, 0x2a);
    const counting = Buffer.from(Array.from({ length: KEY_BYTES }, (_, i) => i));

    expect(
      refusalOf(() => parseMasterKeyMaterial(flat.toString("base64"), MASTER_KEY_ENV)).detail
    ).toMatch(/constant or counting byte sequence/);
    expect(
      refusalOf(() =>
        parseMasterKeyMaterial(counting.toString("base64"), MASTER_KEY_ENV)
      ).detail
    ).toMatch(/constant or counting byte sequence/);
  });

  it("refuses a short pattern repeated to length", () => {
    const repeated = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([1, 90, 7, 200])));

    expect(
      refusalOf(() =>
        parseMasterKeyMaterial(repeated.toString("base64"), MASTER_KEY_ENV)
      ).detail
    ).toMatch(/too few distinct bytes/);
  });

  it("refuses a typed password and says how to generate a real key", () => {
    // Thirty-two characters, twenty-nine of them distinct — strong enough to sail past
    // the distinct-byte guard, and still a password rather than a key.
    const typed = Buffer.from("Tr0ub4dor&3-MindVault!x#Qz%Kp7Sw", "utf8");
    expect(typed).toHaveLength(KEY_BYTES);

    const detail = refusalOf(() =>
      parseMasterKeyMaterial(typed.toString("base64"), MASTER_KEY_ENV)
    ).detail;

    expect(detail).toMatch(/looks like a typed password/);
    expect(detail).toContain("openssl rand -base64 32");
  });

  it("never puts the value it rejected into the message", () => {
    const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const refusal = refusalOf(() => parseMasterKeyMaterial(secret, MASTER_KEY_ENV));

    expect(refusal.detail).not.toContain(secret);
    expect(refusal.message).not.toContain(secret);
    expect(refusal.code).toBe("AFRBAK_NOT_CONFIGURED");
  });

  it("accepts a real CSPRNG key every time, over enough draws to notice", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(parseMasterKeyMaterial(keyMaterial(), MASTER_KEY_ENV)).toHaveLength(KEY_BYTES);
    }
  });
});

describe("the ring, and the one key a header is allowed to name", () => {
  it("is not configured rather than broken when the variable is absent", () => {
    const refusal = refusalOf(() => parseMasterKeyRing({}));

    expect(refusal.detail).toBe(`${MASTER_KEY_ENV} is not set`);
    expect(refusal.code).toBe("AFRBAK_NOT_CONFIGURED");
    expect(refusal.message).toMatch(/not configured on this server/);
  });

  it("derives a key id from the key when the operator supplies none", () => {
    const material = keyMaterial();
    const ring = ringOf(material);

    expect(ring.active.keyId).toBe(
      deriveKeyId(parseMasterKeyMaterial(material, MASTER_KEY_ENV))
    );
    expect(ring.active.keyId).toMatch(/^k[0-9a-f]{8}$/);
    expect(ring.previous).toHaveLength(0);
  });

  it("gives two different keys two different ids, and one key one id", () => {
    const first = randomBytes(KEY_BYTES);

    expect(deriveKeyId(first)).toBe(deriveKeyId(Buffer.from(first)));
    expect(deriveKeyId(first)).not.toBe(deriveKeyId(randomBytes(KEY_BYTES)));
  });

  it("takes an operator label from `label:material`", () => {
    const ring = ringOf(`afrbak-2026-09:${keyMaterial()}`);

    expect(ring.active.keyId).toBe("afrbak-2026-09");
  });

  it("refuses a label that could be injected into a log line", () => {
    expect(
      refusalOf(() => ringOf(`bad label:${keyMaterial()}`)).detail
    ).toMatch(/key label outside/);
    expect(refusalOf(() => ringOf(`two\nlines:${keyMaterial()}`)).detail).toMatch(
      /key label outside/
    );
  });

  it("reads retired keys separated by commas or whitespace", () => {
    const ring = ringOf(keyMaterial(), `${keyMaterial()}, ${keyMaterial()}\n${keyMaterial()}`);

    expect(ring.previous).toHaveLength(3);
    expect(new Set(ring.previous.map((key) => key.keyId)).size).toBe(3);
  });

  it("refuses a ring where one id answers to two keys", () => {
    const material = keyMaterial();

    expect(refusalOf(() => ringOf(material, material)).detail).toMatch(/repeats the key id/);
    expect(
      refusalOf(() => ringOf(`dup:${keyMaterial()}`, `dup:${keyMaterial()}`)).detail
    ).toMatch(/repeats the key id dup/);
  });

  it("resolves only the named key, and answers null for a stranger's", () => {
    const ring = ringOf(`now:${keyMaterial()}`, `then:${keyMaterial()}`);

    expect(resolveMasterKey(ring, "now")).toBe(ring.active);
    expect(resolveMasterKey(ring, "then")).toBe(ring.previous[0]);
    expect(resolveMasterKey(ring, "never")).toBeNull();
  });
});

describe("a keyslot belongs to one archive and one position", () => {
  const context: AfrAadContext = {
    backupId: "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60",
    domain: "files",
    formatVersion: AFR_FORMAT_VERSION,
  };

  it("round trips the DEK and writes the 48 bytes the header expects", () => {
    const key = randomBytes(KEY_BYTES);
    const dek = newDek();
    const slot = wrapDek(key, dek, context, 0);

    expect(slot.alg).toBe("AES-256-GCM");
    expect(slot.nonce).toHaveLength(12);
    expect(slot.ct).toHaveLength(KEY_BYTES + 16);
    expect(unwrapDek(key, slot, context, 0)?.equals(dek)).toBe(true);
  });

  it("uses a fresh nonce per wrap, so two slots never share one", () => {
    const key = randomBytes(KEY_BYTES);
    const dek = newDek();
    const nonces = new Set(
      Array.from({ length: 50 }, () => wrapDek(key, dek, context, 0).nonce.toString("hex"))
    );

    expect(nonces.size).toBe(50);
  });

  it("returns null for the wrong key rather than throwing", () => {
    const slot = wrapDek(randomBytes(KEY_BYTES), newDek(), context, 0);

    expect(unwrapDek(randomBytes(KEY_BYTES), slot, context, 0)).toBeNull();
  });

  it("returns null when a single byte of the ciphertext or tag was edited", () => {
    const key = randomBytes(KEY_BYTES);
    const slot = wrapDek(key, newDek(), context, 0);

    for (const index of [0, 31, 32, 47]) {
      const edited = { ...slot, ct: Buffer.from(slot.ct) };
      edited.ct[index] ^= 0x01;
      expect(unwrapDek(key, edited, context, 0)).toBeNull();
    }
  });

  it("refuses a keyslot of the wrong width without asking the cipher", () => {
    const key = randomBytes(KEY_BYTES);
    const slot = wrapDek(key, newDek(), context, 0);

    expect(unwrapDek(key, { ...slot, ct: slot.ct.subarray(0, 47) }, context, 0)).toBeNull();
    expect(
      unwrapDek(key, { ...slot, ct: Buffer.concat([slot.ct, Buffer.alloc(1)]) }, context, 0)
    ).toBeNull();
  });
});

describe("what the keyslot's own tag binds, when HDR_HMAC cannot be checked", () => {
  const context: AfrAadContext = {
    backupId: "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60",
    domain: "files",
    formatVersion: AFR_FORMAT_VERSION,
  };
  const key = randomBytes(KEY_BYTES);

  it("refuses to open slot 1 with a slot 0 wrap, and the reverse", () => {
    const dek = newDek();

    expect(unwrapDek(key, wrapDek(key, dek, context, 0), context, 1)).toBeNull();
    expect(unwrapDek(key, wrapDek(key, dek, context, 1), context, 0)).toBeNull();
  });

  it("refuses a keyslot lifted into an archive with another backupId", () => {
    const slot = wrapDek(key, newDek(), context, 1);
    const other = { ...context, backupId: "00000000-0000-4000-8000-000000000000" };

    expect(unwrapDek(key, slot, other, 1)).toBeNull();
  });

  it("refuses a keyslot whose header now claims the other domain", () => {
    const slot = wrapDek(key, newDek(), context, 1);

    // The domain byte lives in the plaintext preamble. On the recovery path nothing
    // MACs that byte, so this tag is the only thing standing between a Files archive
    // relabelled `brain` and an importer pointed at the wrong tables.
    expect(unwrapDek(key, { ...slot }, { ...context, domain: "brain" }, 1)).toBeNull();
  });

  it("refuses a keyslot re-labelled with another formatVersion", () => {
    const slot = wrapDek(key, newDek(), context, 1);

    expect(unwrapDek(key, slot, { ...context, formatVersion: 2 }, 1)).toBeNull();
  });
});

describe("the phrase becomes a key, never the key itself", () => {
  it("keeps the real Argon2id cost as the default", () => {
    expect(AFR_ARGON2).toEqual({
      m: KDF_MEMORY_KIB,
      t: KDF_TIME_COST,
      p: KDF_PARALLELISM,
    });
    expect(AFR_ARGON2.m).toBe(256 * 1024);
  });

  it("derives 32 bytes, the same ones every time, for one phrase and salt", async () => {
    const salt = newPhraseSalt();
    const first = await deriveRecoveryWrappingKey(PHRASE, salt, CHEAP);
    const again = await deriveRecoveryWrappingKey(PHRASE, salt, CHEAP);

    expect(first).toHaveLength(KEY_BYTES);
    expect(first.equals(again)).toBe(true);
  });

  it("forgives the retyping a note invites, and nothing more", async () => {
    const salt = newPhraseSalt();
    const canonical = await deriveRecoveryWrappingKey(PHRASE, salt, CHEAP);
    const sloppy = await deriveRecoveryWrappingKey(
      `  ${PHRASE.toUpperCase().replace(/ /g, "   ")}\n`,
      salt,
      CHEAP
    );
    const different = await deriveRecoveryWrappingKey(`${PHRASE} extra`, salt, CHEAP);

    expect(sloppy.equals(canonical)).toBe(true);
    expect(different.equals(canonical)).toBe(false);
  });

  it("gives each account its own key for the same phrase", async () => {
    const mine = await deriveRecoveryWrappingKey(PHRASE, newPhraseSalt(), CHEAP);
    const theirs = await deriveRecoveryWrappingKey(PHRASE, newPhraseSalt(), CHEAP);

    expect(mine.equals(theirs)).toBe(false);
    expect(newPhraseSalt()).toHaveLength(KDF_SALT_BYTES);
  });

  it("refuses a salt of the wrong width as an unreadable archive", async () => {
    const refusal = await refusalOfAsync(() =>
      deriveRecoveryWrappingKey(PHRASE, Buffer.alloc(8, 1), CHEAP)
    );

    expect(refusal.reason).toBe(4);
    expect(refusal.message).toBe(GENERIC_UNREADABLE_MESSAGE);
    expect(refusal.detail).toMatch(/phraseSalt is 8 bytes/);
  });
});

describe("the sealed recovery key the server keeps so an export needs no phrase", () => {
  const OWNER = "afrbak:user:9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60";

  it("round trips and is spelled apart from the system backup's KEK", () => {
    const ring = ringOf(keyMaterial());
    const rwk = randomBytes(KEY_BYTES);
    const sealed = sealRecoveryKey(ring.active.key, rwk, OWNER);

    expect(sealed.split(":")).toHaveLength(4);
    expect(sealed.startsWith("afr1:")).toBe(true);
    const opened = openRecoveryKey(ring, sealed, OWNER);
    expect(opened.rwk.equals(rwk)).toBe(true);
    expect(opened.keyId).toBe(ring.active.keyId);
    expect(opened.stale).toBe(false);
  });

  it("seals the same key to different bytes twice", () => {
    const ring = ringOf(keyMaterial());
    const rwk = randomBytes(KEY_BYTES);

    expect(sealRecoveryKey(ring.active.key, rwk, OWNER)).not.toBe(
      sealRecoveryKey(ring.active.key, rwk, OWNER)
    );
  });

  it("will not open under another account's owner key", () => {
    const ring = ringOf(keyMaterial());
    const sealed = sealRecoveryKey(ring.active.key, randomBytes(KEY_BYTES), OWNER);
    const refusal = refusalOf(() =>
      openRecoveryKey(ring, sealed, "afrbak:user:00000000-0000-4000-8000-000000000000")
    );

    expect(refusal.code).toBe("AFRBAK_RECOVERY_KEY_UNREADABLE");
    expect(refusal.detail).toMatch(/no key in the ring opens/);
  });

  it("opens under a retired key and says so, which is how rotation finishes", () => {
    const retired = keyMaterial();
    const retiredRing = ringOf(retired);
    const sealed = sealRecoveryKey(retiredRing.active.key, randomBytes(KEY_BYTES), OWNER);
    const rotated = ringOf(keyMaterial(), `old:${retired}`);
    const opened = openRecoveryKey(rotated, sealed, OWNER);

    expect(opened.stale).toBe(true);
    expect(opened.keyId).toBe("old");
    // And re-sealing under the active key retires the old one for good.
    const resealed = sealRecoveryKey(rotated.active.key, opened.rwk, OWNER);
    expect(openRecoveryKey(rotated, resealed, OWNER).stale).toBe(false);
  });

  it("refuses the system backup's `v1:` spelling instead of trying to open it", () => {
    const ring = ringOf(keyMaterial());
    const systemShaped = `v1:${randomBytes(12).toString("base64")}:${randomBytes(16).toString(
      "base64"
    )}:${randomBytes(48).toString("base64")}`;

    expect(refusalOf(() => openRecoveryKey(ring, systemShaped, OWNER)).detail).toMatch(
      /not afr1 with four fields/
    );
    expect(refusalOf(() => openRecoveryKey(ring, "afr1:only:three", OWNER)).detail).toMatch(
      /four fields/
    );
  });

  it("refuses a wrapped key of the wrong width at seal time", () => {
    const ring = ringOf(keyMaterial());

    expect(
      refusalOf(() => sealRecoveryKey(ring.active.key, randomBytes(16), OWNER)).detail
    ).toMatch(/rwk is 16 bytes/);
  });
});

describe("opening an archive on the instance that wrote it", () => {
  it("opens through keyslot 0 with no phrase typed", async () => {
    const ring = ringOf(keyMaterial());
    const archive = await writeArchive({ writer: ring.active });
    const opened = await openWith(archive, ring);

    expect(opened.dek.equals(archive.dek)).toBe(true);
    expect(opened.via).toBe("master");
    expect(opened.stale).toBe(false);
    expect(opened.keyId).toBe(ring.active.keyId);
  });

  it("lets a typed phrase decide, even here where keyslot 0 would have worked", async () => {
    const ring = ringOf(keyMaterial());
    const archive = await writeArchive({ writer: ring.active });

    // §3.2 rule 2: an id the account does not hold may only be adopted when keyslot 1 opened
    // the archive. Preferring keyslot 0 here would answer `via: "master"` on a rebuilt
    // instance whose `.env` survived — test #7's exact shape — and the phrase the user
    // correctly typed would be ignored while the restore refused as #6.
    expect((await openWith(archive, ring, PHRASE)).via).toBe("phrase");

    // And the corollary: a mistyped phrase is a refusal, not a silent fall back to the key
    // that happens to be sitting in this server's env.
    const refusal = await refusalOfAsync(() =>
      openWith(archive, ring, "amber cider harbor lantern meadow pepper quartz shelter walnut")
    );
    expect(refusal.reason).toBe(4);
    expect(refusal.detail).toMatch(/keyslot 0 would have/);
  });

  it("opens an archive written under a retired key, and flags it (#11)", async () => {
    const retired = keyMaterial();
    const writer = ringOf(`2026-q1:${retired}`).active;
    const archive = await writeArchive({ writer });
    const rotated = ringOf(keyMaterial(), `2026-q1:${retired}`);
    const opened = await openWith(archive, rotated);

    expect(opened.via).toBe("master");
    expect(opened.dek.equals(archive.dek)).toBe(true);
    expect(opened.keyId).toBe("2026-q1");
    expect(opened.stale).toBe(true);
  });

  it("never tries a key the header did not name", async () => {
    const decoy = keyMaterial();
    const writer = ringOf(`writer:${keyMaterial()}`).active;
    const archive = await writeArchive({ writer });
    // The writer's key is absent from this ring, but a key that *would* have worked if
    // the ring were tried blindly is not the point — nothing here may be tried at all.
    const ring = ringOf(decoy, `also:${keyMaterial()}`);
    const refusal = await refusalOfAsync(() => openWith(archive, ring));

    expect(refusal.reason).toBe(3);
    expect(refusal.detail).toContain("is not in this server's ring");
    expect(refusal.detail).toContain("writer");
  });

  it("refuses when keyslot 0 was replaced and no phrase was offered", async () => {
    const ring = ringOf(keyMaterial());
    const archive = await writeArchive({ writer: ring.active });
    const foreign = wrapDek(randomBytes(KEY_BYTES), newDek(), archive.context, 0);
    // The header *bytes* are left as they arrived, so HDR_HMAC still verifies and the
    // refusal that lands is the one this test is about rather than #3 arriving first.
    const tampered: WrittenArchive = {
      ...archive,
      header: { ...archive.header, keyslot: [foreign, archive.header.keyslot[1]] },
    };
    const refusal = await refusalOfAsync(() => openWith(tampered, ring));

    expect(refusal.reason).toBe(4);
    expect(refusal.detail).toMatch(/keyslot 0 did not authenticate/);
  });
});

describe("opening an archive after the server that wrote it is gone", () => {
  /** A fresh install: new VPS, new `BACKUP_MASTER_KEY`, empty database. */
  function freshInstall(): AfrKeyRing {
    return ringOf(keyMaterial());
  }

  it("opens through keyslot 1 with the right phrase (#9)", async () => {
    const archive = await writeArchive({ writer: ringOf(`dead-vps:${keyMaterial()}`).active });
    const opened = await openWith(archive, freshInstall(), PHRASE);

    expect(opened.dek.equals(archive.dek)).toBe(true);
    expect(opened.via).toBe("phrase");
    // The id is reported as the archive spells it, even though nothing here holds it.
    expect(opened.keyId).toBe("dead-vps");
    expect(opened.stale).toBe(false);
  });

  it("forgives case and spacing in the typed phrase", async () => {
    const archive = await writeArchive({ writer: freshInstall().active });
    const opened = await openWith(
      archive,
      freshInstall(),
      `  ${PHRASE.toUpperCase().replace(/ /g, "  ")} `
    );

    expect(opened.via).toBe("phrase");
  });

  it("says one sentence for a wrong phrase (#9) and the same one for a stranger's key", async () => {
    const archive = await writeArchive({ writer: ringOf(keyMaterial()).active });
    const ring = freshInstall();
    const wrongPhrase = await refusalOfAsync(() =>
      openWith(archive, ring, "amber cider harbor lantern meadow pepper quartz shelter walnut")
    );
    const noPhrase = await refusalOfAsync(() => openWith(archive, ring));

    expect(wrongPhrase.message).toBe(GENERIC_UNREADABLE_MESSAGE);
    expect(noPhrase.message).toBe(GENERIC_UNREADABLE_MESSAGE);
    expect(wrongPhrase.code).toBe("AFRBAK_UNREADABLE");
    expect(noPhrase.code).toBe("AFRBAK_UNREADABLE");
    // Only the audit trail is allowed to tell these two apart.
    expect(wrongPhrase.reason).toBe(4);
    expect(noPhrase.reason).toBe(3);
    expect(wrongPhrase.detail).toMatch(/keyslot 1 did not authenticate/);
  });

  it("carries no phrase, no key, and no plaintext in what it says or records", async () => {
    const archive = await writeArchive({ writer: ringOf(keyMaterial()).active });
    const refusal = await refusalOfAsync(() =>
      openWith(archive, freshInstall(), "the wrong nine words entirely written out here now")
    );

    for (const leak of [
      "wrong nine words",
      archive.dek.toString("base64"),
      archive.dek.toString("hex"),
      archive.header.phraseSalt.toString("base64"),
    ]) {
      expect(refusal.message).not.toContain(leak);
      expect(refusal.detail).not.toContain(leak);
    }
  });
});

describe("an edited header, on the path where HDR_HMAC cannot save us", () => {
  it("falls through to the phrase when HDR_HMAC fails under a known key", async () => {
    const ring = ringOf(keyMaterial());
    const archive = await writeArchive({ writer: ring.active });
    const headerBytes = Buffer.from(archive.headerBytes);
    headerBytes[headerBytes.length - 2] ^= 0x20;
    const edited: WrittenArchive = { ...archive, headerBytes };

    const refused = await refusalOfAsync(() => openWith(edited, ring));
    expect(refused.reason).toBe(3);
    expect(refused.detail).toMatch(/HDR_HMAC does not verify/);

    // Deliberate: the same fall-through the disaster path relies on. Everything the
    // header could lie about is still bound by the keyslot's own tag, the chunk AADs,
    // and TRL_HMAC — and this rescues an archive whose `keyId` two instances collided on.
    const opened = await openWith(edited, ring, PHRASE);
    expect(opened.via).toBe("phrase");
    expect(opened.dek.equals(archive.dek)).toBe(true);
  });

  it("still refuses when the edit was to a field keyslot 1 is bound to", async () => {
    const archive = await writeArchive({ writer: ringOf(keyMaterial()).active });
    const otherId = "00000000-0000-4000-8000-000000000000";
    const relabelled: WrittenArchive = {
      ...archive,
      header: { ...archive.header, backupId: otherId },
      context: { ...archive.context, backupId: otherId },
    };
    const refusal = await refusalOfAsync(() =>
      openWith(relabelled, ringOf(keyMaterial()), PHRASE)
    );

    expect(refusal.reason).toBe(4);
    expect(refusal.message).toBe(GENERIC_UNREADABLE_MESSAGE);
  });

  it("still refuses when the archive was relabelled into the other domain", async () => {
    const archive = await writeArchive({ writer: ringOf(keyMaterial()).active, domain: "files" });
    const relabelled: WrittenArchive = {
      ...archive,
      context: { ...archive.context, domain: "brain" },
    };
    const refusal = await refusalOfAsync(() =>
      openWith(relabelled, ringOf(keyMaterial()), PHRASE)
    );

    expect(refusal.reason).toBe(4);
  });

  it("wipes the derived wrapping key before returning", async () => {
    // Nothing observable from outside proves a buffer was zeroed, so this asserts the
    // property that would break if the wipe happened too early: the DEK survives it.
    const archive = await writeArchive({ writer: ringOf(keyMaterial()).active });
    const opened = await openWith(archive, ringOf(keyMaterial()), PHRASE);

    expect(opened.dek.equals(archive.dek)).toBe(true);
    expect(opened.dek.some((byte) => byte !== 0)).toBe(true);
  });
});
