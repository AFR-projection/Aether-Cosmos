import { createSubtitleWorkHandler } from "@files/infrastructure/subtitles/pipeline-stages/compose";
import { postgresSubtitlePipelineStore } from "@files/infrastructure/subtitles/pipeline-store";
import { downloadR2Stream } from "@/shared/infrastructure/storage/r2-stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import type { SubtitleWorkHandler } from "./handlers";

const execFileAsync = promisify(execFile);

const tmpPath = (name: string) => path.join(os.tmpdir(), name);

async function downloadToFile(key: string, destination: string): Promise<void> {
  const { body } = await downloadR2Stream(key);
  if (!body) throw new Error(`Source object is empty: ${key}`);
  const { createWriteStream } = await import("fs");
  const { pipeline } = await import("stream/promises");
  await pipeline(body, createWriteStream(destination));
}

async function runFfmpeg(args: string[]): Promise<void> {
  const { stderr } = await execFileAsync("ffmpeg", args);
  if (stderr) {
    const error = new Error(`ffmpeg stderr: ${stderr.slice(0, 500)}`) as Error & { stderr: string };
    error.stderr = stderr;
    throw error;
  }
}

const deps = {
  downloadToFile,
  runFfmpeg,
  tmpPath,
  log: (message: string) => console.log(`[subtitle-worker] ${message}`),
};

const handleFull = createSubtitleWorkHandler(deps);

/**
 * SubtitleWorkHandler compatible entry point. Each delivery creates a fresh store
 * (one DB connection pool is shared via the module-level defaultDb import).
 */
export const handleSubtitleWork: SubtitleWorkHandler = async (delivery) => {
  const store = postgresSubtitlePipelineStore();
  await handleFull(delivery, store);
};
