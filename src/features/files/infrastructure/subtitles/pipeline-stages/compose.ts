import { createHandleSubtitleWork, type StageHandlers } from "@files/application/subtitles/work-dispatcher";
import { handlePrepareStage } from "./prepare";
import { handleAsrStage } from "./asr";
import { handleTranslateStage } from "./translate";
import { handleMaterializeStage } from "./materialize";
import { handlePublishStage } from "./publish";
import { handleCleanupStage } from "./cleanup";

export type PipelineDependencies = {
  downloadToFile: (key: string, destination: string) => Promise<void>;
  runFfmpeg: (args: string[]) => Promise<void>;
  tmpPath: (name: string) => string;
  log: (message: string) => void;
};

export function buildStageHandlers(deps: PipelineDependencies): StageHandlers {
  return {
    prepare: (store, claimed, run, now, workerId) =>
      handlePrepareStage(store, claimed, run, now, workerId, deps),
    asr: (store, claimed, run, now, workerId) =>
      handleAsrStage(store, claimed, run, now, workerId, deps),
    translate: (store, claimed, run, now, workerId) =>
      handleTranslateStage(store, claimed, run, now, workerId, deps),
    materialize: (store, claimed, run, now, workerId) =>
      handleMaterializeStage(store, claimed, run, now, workerId, deps),
    publish: (store, claimed, run, now, workerId) =>
      handlePublishStage(store, claimed, run, now, workerId, deps),
    cleanup: (store, claimed, run, now, workerId) =>
      handleCleanupStage(store, claimed, run, now, workerId, deps),
  };
}

export function createSubtitleWorkHandler(deps: PipelineDependencies) {
  return createHandleSubtitleWork(buildStageHandlers(deps));
}