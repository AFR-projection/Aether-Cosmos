import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Environment loading with NO production dependency, for everything that boots outside
 * Next.js: the worker process and the operational scripts (migrations, backfills,
 * verifiers, master bootstrap).
 *
 * Those run on the server, where `npm ci --omit=dev` is normal — so `import
 * "dotenv/config"` crashes with MODULE_NOT_FOUND before a single line runs. Depending on
 * a devDependency to reach the database is a deployment trap, not a convenience: it has
 * now cost one production script run AND one worker container, which restart-looped
 * through a whole deploy while every other service reported healthy.
 *
 * It lives in lib/ because that is the one directory every image copies: the worker image
 * takes lib/ and workers/, the setup image takes lib/ and scripts/.
 *
 * So: use the real `dotenv` when it happens to be installed (identical behaviour in
 * development), and otherwise parse `.env` with the small reader below. Either way the
 * contract is dotenv's:
 *
 *  - the file is read from `process.cwd()/.env`;
 *  - a variable ALREADY present in `process.env` is never overwritten, so a systemd /
 *    pm2 / docker env always wins over the file;
 *  - a missing or unreadable `.env` is not an error — the process may legitimately get
 *    everything from the real environment.
 *
 * Import it FIRST, exactly where `dotenv/config` used to sit: anything that reads
 * `process.env` at module scope must see the values already applied.
 */

/** One `KEY=value` line, dotenv-compatible for the syntax an `.env` actually uses. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/**
 * Parse `.env` text into pairs. Handles comments, blank lines, an `export ` prefix, and
 * single- or double-quoted values (`\n` and `\"` are unescaped inside double quotes
 * only, as in dotenv). An unquoted value keeps everything up to a ` #` comment.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = LINE.exec(rawLine);
    if (!match) continue;

    const key = match[1];
    let value = match[2];

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1) {
      // Closing quote of the same kind; anything after it (e.g. a comment) is dropped.
      const end = value.indexOf(quote, 1);
      if (end > 0) {
        value = value.slice(1, end);
        if (quote === '"') {
          value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"');
        }
      } else {
        value = value.slice(1);
      }
    } else {
      // Unquoted: an inline comment needs whitespace in front of `#`, so a value like
      // `pass#word` survives while `KEY=value # note` does not keep the note.
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }

    out[key] = value;
  }

  return out;
}

/** Apply pairs to `process.env` without ever clobbering an existing variable. */
export function applyEnv(
  pairs: Record<string, string>,
  env: Record<string, string | undefined> = process.env
): void {
  for (const [key, value] of Object.entries(pairs)) {
    if (env[key] === undefined) env[key] = value;
  }
}

/** Real dotenv, if this install has it. Returns false when it is simply not there. */
function loadWithDotenv(): boolean {
  try {
    const require_ = createRequire(__filename);
    const dotenv = require_("dotenv") as { config: () => unknown };
    dotenv.config();
    return true;
  } catch {
    return false;
  }
}

/** The dependency-free path: read and apply `cwd/.env`, tolerating its absence. */
function loadFromFile(): void {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return; // No file — the real environment is expected to carry everything.
  }
  applyEnv(parseEnvFile(text));
}

if (!loadWithDotenv()) loadFromFile();
