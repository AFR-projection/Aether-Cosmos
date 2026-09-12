import { db } from "@/shared/infrastructure/db";
import { subtitleCuePartitions, subtitleAudioChunks, subtitlePipelineTargets } from "@/shared/infrastructure/db/schema";
import { eq, and } from "drizzle-orm";
import { ChatCompletionTranslator } from "@files/infrastructure/subtitles/translator";
import { loadSubtitleConfig } from "@files/infrastructure/subtitles/config";
import { createHash } from "node:crypto";
import { downloadR2Stream } from "@/shared/infrastructure/storage/r2-stream";
import { putR2Object } from "@/shared/infrastructure/storage/r2-objects";
import { subtitleProviderRequestKey } from "@files/domain/services/subtitles/pipeline-planning";
import { planTranslationBatches, parseTranslationReply, buildTranslationSystemPrompt, buildBatchPayload, unflattenCueBreaks, type TranslationBatch } from "@files/domain/services/subtitles/translate-batch";
import { buildGlossaryPrompt, buildGlossarySample, parseGlossaryReply, type GlossaryEntry } from "@files/domain/services/subtitles/glossary";
import type { SubtitleCue } from "@files/domain/services/subtitles/vtt";
import { findSubtitleLanguage, UNDETERMINED_LANGUAGE } from "@files/domain/services/subtitles/languages";
import { workKey } from "@files/application/subtitles/pipeline/ledger";
import type { PipelineDependencies } from "./compose";
import type { ClaimedWork, PipelineRun, SubtitlePipelineStore } from "@files/application/subtitles/pipeline/contracts";

interface TranslateCheckpoint {
  readonly targetLanguage: string;
  readonly sourceCueCount: number;
  readonly translatedCues: number;
  readonly partitionKeys: string[];
}

function englishName(tag: string | null): string | null {
  if (!tag || tag === UNDETERMINED_LANGUAGE) return null;
  return findSubtitleLanguage(tag)?.english ?? null;
}

async function resolveGlossary(
  complete: (input: { system: string; user: string }) => Promise<string>,
  cues: readonly SubtitleCue[],
  sourceLanguage: string | null,
  targetLanguage: string
): Promise<GlossaryEntry[]> {
  const sample = buildGlossarySample(cues);
  if (sample.length === 0) return [];
  try {
    const reply = await complete({
      system: buildGlossaryPrompt({
        sourceLanguage: sourceLanguage ?? "the language of the source lines",
        targetLanguage,
      }),
      user: sample,
    });
    return parseGlossaryReply(reply);
  } catch {
    return [];
  }
}

async function attemptBatch(
  complete: (input: { system: string; user: string }) => Promise<string>,
  system: string,
  batch: TranslationBatch
): Promise<string[] | null> {
  const reply = await complete({ system, user: buildBatchPayload(batch) });
  return parseTranslationReply(reply, batch.cues.length);
}

async function translateSingle(
  complete: (input: { system: string; user: string }) => Promise<string>,
  system: string,
  cue: SubtitleCue
): Promise<string | null> {
  const single: TranslationBatch = { cues: [cue], before: [], after: [], offset: cue.idx };
  const reply = await complete({ system, user: buildBatchPayload(single) });
  const parsed = parseTranslationReply(reply, 1);
  return parsed ? parsed[0] : null;
}

async function translateCues(
  complete: (input: { system: string; user: string }) => Promise<string>,
  cues: readonly SubtitleCue[],
  sourceLanguage: string | null,
  targetLanguage: string
): Promise<{ cues: SubtitleCue[]; glossary: GlossaryEntry[]; degradedBatches: number; untranslatedLines: number }> {
  if (cues.length === 0) {
    return { cues: [], glossary: [], degradedBatches: 0, untranslatedLines: 0 };
  }

  const glossary = await resolveGlossary(complete, cues, sourceLanguage, targetLanguage);
  const system = buildTranslationSystemPrompt({
    sourceLanguage: englishName(sourceLanguage),
    targetLanguage,
    glossary,
  });

  const batches = planTranslationBatches(cues);

  const translated: SubtitleCue[] = [];
  let degradedBatches = 0;
  let untranslatedLines = 0;

  for (const batch of batches) {
    let texts = await attemptBatch(complete, system, batch);

    if (!texts) {
      const stricter =
        `${system}\n\nIMPORTANT: the previous attempt returned the wrong number of lines. ` +
        `Return exactly ${batch.cues.length} objects, numbered 1 to ${batch.cues.length}, one per ` +
        `line given. Do not merge or split lines.`;
      texts = await attemptBatch(complete, stricter, batch);
    }

    if (!texts) {
      degradedBatches += 1;
      const oneByOne: string[] = [];
      for (const cue of batch.cues) {
        const single = await translateSingle(complete, system, cue);
        if (single === null) {
          untranslatedLines += 1;
          oneByOne.push(cue.text);
        } else {
          oneByOne.push(single);
        }
      }
      texts = oneByOne;
    }

    const resolved = texts;
    batch.cues.forEach((cue, index) => {
      translated.push({
        idx: cue.idx,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: unflattenCueBreaks(resolved[index]),
      });
    });
  }

  return { cues: translated, glossary, degradedBatches, untranslatedLines };
}

/**
 * One work item per target language (materialize fans them out), so a single failing
 * language retries alone and never holds back the others.
 */
export async function handleTranslateStage(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  workerId: string,
  deps: PipelineDependencies
): Promise<void> {
  const lease = { id: claimed.id, leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken };

  if (claimed.targetId === null) {
    await store.complete(lease, { outcome: "no-target" }, now);
    return;
  }
  const target = (await store.listTargets(run.id)).find((t) => t.id === claimed.targetId);
  if (!target) {
    await store.complete(lease, { outcome: "target-gone" }, now);
    return;
  }
  if (!["pending", "queued", "processing"].includes(target.status)) {
    await store.complete(lease, { outcome: "target-terminal" }, now);
    return;
  }

  // Source partitions come from the materialize stage; retry until they exist.
  const sourcePartitions = await db
    .select()
    .from(subtitleCuePartitions)
    .where(and(
      eq(subtitleCuePartitions.runId, run.id),
      eq(subtitleCuePartitions.kind, "source")
    ));

  if (sourcePartitions.length === 0) {
    await store.retry(lease, { code: "NO_SOURCE", message: "Source partitions not yet available", availableAt: new Date(now.getTime() + 10_000) }, now);
    return;
  }

  const config = await loadSubtitleConfig(db, true);
  if (!config.translateApiKey) {
    await db
      .update(subtitlePipelineTargets)
      .set({ status: "blocked", terminalCode: "NO_TRANSLATION_CONFIG", terminalMessage: "No translation provider is configured", updatedAt: now })
      .where(eq(subtitlePipelineTargets.id, target.id));
    await store.complete(lease, { outcome: "no-translate-config" }, now);
    return;
  }

  try {
    await db
      .update(subtitlePipelineTargets)
      .set({ status: "processing", updatedAt: now })
      .where(eq(subtitlePipelineTargets.id, target.id));

    // Load source cues from R2 partitions
    const sourceCues: SubtitleCue[] = [];
    for (const partition of sourcePartitions.sort((a, b) => a.ordinal - b.ordinal)) {
      const { body } = await downloadR2Stream(partition.objectKey);
      if (!body) throw new Error(`Empty partition object: ${partition.objectKey}`);
      const buffers: Buffer[] = [];
      for await (const piece of body) {
        buffers.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array));
      }
      const parsed = JSON.parse(Buffer.concat(buffers).toString("utf8")) as { cues: SubtitleCue[] };
      sourceCues.push(...parsed.cues);
    }

    if (sourceCues.length === 0) {
      await db
        .update(subtitlePipelineTargets)
        .set({ status: "skipped", terminalCode: "NO_CUES", terminalMessage: "The source transcript is empty", updatedAt: now })
        .where(eq(subtitlePipelineTargets.id, target.id));
      await store.complete(lease, { outcome: "no-cues" }, now);
      return;
    }

    // Detect source language from audio chunks' ASR detection
    const audioChunks = await db
      .select({ detectedLanguage: subtitleAudioChunks.detectedLanguage })
      .from(subtitleAudioChunks)
      .where(eq(subtitleAudioChunks.runId, run.id));
    const sourceLanguage = audioChunks.find((c) => c.detectedLanguage)?.detectedLanguage ?? "und";

    const translator = new ChatCompletionTranslator({
      apiKey: config.translateApiKey,
      baseUrl: config.translateBaseUrl,
      model: config.translateModel,
      requestId: subtitleProviderRequestKey({
        pipelineKey: `full:${run.fileId}:v${run.sourceVersion}:p${run.policyVersion}`,
        stage: "translate",
        ordinal: claimed.ordinal ?? 0,
        targetLanguage: target.language,
        inputHash: sourcePartitions.map((p) => p.checksumSha256).join(","),
      }),
    });

    deps.log(`translate run ${run.id} target ${target.language}: translating ${sourceCues.length} cues`);

    const { cues: translatedCues } = await translateCues(
      async (input) => translator.complete(input),
      sourceCues,
      sourceLanguage,
      target.language
    );

    // Deterministic partition key: a retry overwrites the same object, never leaks a second one.
    const partitionData = JSON.stringify({ cues: translatedCues });
    const partitionChecksum = createHash("sha256").update(partitionData).digest("hex");
    const partitionKey = `subtitles/v2/${run.fileId}/v${run.sourceVersion}/${run.id}/translate/${target.language}/v1.json`;

    await putR2Object(partitionKey, Buffer.from(partitionData), "application/json");

    // Replace this target's translation partition row (delete-then-insert keeps retries idempotent)
    await db
      .delete(subtitleCuePartitions)
      .where(and(
        eq(subtitleCuePartitions.runId, run.id),
        eq(subtitleCuePartitions.targetId, target.id),
        eq(subtitleCuePartitions.kind, "translation")
      ));
    await db.insert(subtitleCuePartitions).values({
      runId: run.id,
      targetId: target.id,
      trackId: null, // Set during materialize
      kind: "translation",
      ordinal: 0,
      startMs: sourceCues[0]?.startMs ?? 0,
      endMs: sourceCues[sourceCues.length - 1]?.endMs ?? 0,
      firstCueSequence: 0,
      lastCueSequence: Math.max(0, translatedCues.length - 1),
      cueCount: translatedCues.length,
      inputHash: partitionChecksum,
      objectKey: partitionKey,
      checksumSha256: partitionChecksum,
      schemaVersion: 1,
      materializationState: "pending",
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });

    await store.createWork([{
      runId: run.id,
      targetId: target.id,
      userId: run.userId,
      kind: "materialize",
      idempotencyKey: workKey(run, "materialize", undefined, target.language),
      ordinal: null,
      cursorStartMs: null,
      cursorEndMs: null,
    }], now);

    const checkpoint: TranslateCheckpoint = {
      targetLanguage: target.language,
      sourceCueCount: sourceCues.length,
      translatedCues: translatedCues.length,
      partitionKeys: [partitionKey],
    };
    await store.complete(lease, { outcome: "translated", checkpoint }, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Translate failed";
    const outcome = await store.retry(lease, { code: "TRANSLATE_FAILED", message: message.slice(0, 500), availableAt: new Date(now.getTime() + 60_000) }, now);
    if (outcome === "failed") {
      // Attempts exhausted for this language only; other targets are unaffected.
      await db
        .update(subtitlePipelineTargets)
        .set({ status: "failed", terminalCode: "TRANSLATE_FAILED", terminalMessage: message.slice(0, 500), updatedAt: now })
        .where(eq(subtitlePipelineTargets.id, target.id));
    }
    throw error;
  }
}