/**
 * The loader itself lives in lib/env/load-env.ts, because that is the directory every
 * image copies — the worker needs it too, and the worker image has no scripts/.
 *
 * This file stays as the import path the operational scripts already use (`import
 * "./load-env"`), and re-exports the reader so tests and callers keep one contract.
 * Importing it applies the environment, exactly as before.
 */
export { applyEnv, parseEnvFile } from "../lib/env/load-env";
