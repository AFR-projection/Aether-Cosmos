import { describe, expect, it } from "vitest";
import {
  QUEUE_NAME,
  SUBTITLE_QUEUE_NAMES,
  defaultJobOptionsFor,
  queueForJob,
  queueRoleForSubtitleWork,
  resolveQueueName,
  subtitleWorkJobId,
} from "./index";

describe("queue topology", () => {
  it("keeps non-subtitle jobs on the storage queue", () => {
    expect(queueForJob("inspect_media")).toBe(QUEUE_NAME);
    expect(defaultJobOptionsFor(QUEUE_NAME)).toMatchObject({ attempts: 3 });
  });

  it("routes legacy subtitle jobs to their dedicated queues", () => {
    expect(queueForJob("transcribe_media")).toBe(SUBTITLE_QUEUE_NAMES.asr);
    expect(queueForJob("translate_subtitles")).toBe(SUBTITLE_QUEUE_NAMES.translate);
    expect(defaultJobOptionsFor(SUBTITLE_QUEUE_NAMES.asr)).toMatchObject({ attempts: 1 });
    expect(defaultJobOptionsFor(SUBTITLE_QUEUE_NAMES.translate)).toMatchObject({ attempts: 1 });
  });

  it("accepts roles and concrete queue names", () => {
    expect(resolveQueueName("control")).toBe("subtitle-control");
    expect(resolveQueueName("subtitle-prepare")).toBe("subtitle-prepare");
    expect(() => resolveQueueName("unknown" as never)).toThrow("Unknown queue selector");
  });

  it("maps every pipeline work kind onto a named queue", () => {
    expect(queueRoleForSubtitleWork("control")).toBe("control");
    expect(queueRoleForSubtitleWork("prepare")).toBe("prepare");
    expect(queueRoleForSubtitleWork("asr")).toBe("asr");
    expect(queueRoleForSubtitleWork("translate")).toBe("translate");
    expect(queueRoleForSubtitleWork("materialize")).toBe("control");
    expect(queueRoleForSubtitleWork("publish")).toBe("control");
    expect(queueRoleForSubtitleWork("cleanup")).toBe("control");
  });

  it("builds stable delivery IDs without payload content", () => {
    expect(subtitleWorkJobId("asr", { workItemId: "work_01", deliverySequence: 7 })).toBe(
      "subtitle-work-asr-work_01-7"
    );
    expect(() =>
      subtitleWorkJobId("asr", { workItemId: "contains content", deliverySequence: 7 })
    ).toThrow("Invalid subtitle work item ID");
  });
});
