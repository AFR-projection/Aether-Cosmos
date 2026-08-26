import { beforeEach, describe, expect, it } from "vitest";
import {
  dismissNotice,
  getSystemNotices,
  notify,
} from "@/lib/system/notify-store";

beforeEach(() => {
  for (const notice of [...getSystemNotices()]) dismissNotice(notice.id);
});

describe("system notice de-duplication", () => {
  it("collapses an identical message into the card already on screen", () => {
    const first = notify({ title: "Upload completed", description: "1 file uploaded successfully." });
    const second = notify({ title: "Upload completed", description: "1 file uploaded successfully." });

    expect(second).toBe(first);
    const notices = getSystemNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.count).toBe(2);
  });

  it("keeps messages that differ apart", () => {
    notify({ title: "Upload completed", description: "1 file uploaded successfully." });
    notify({ title: "Upload completed", description: "2 files uploaded successfully." });
    notify({ title: "Upload failed" });

    expect(getSystemNotices()).toHaveLength(3);
    expect(getSystemNotices().every((notice) => notice.count === 1)).toBe(true);
  });

  it("keeps the newest four and drops the rest", () => {
    for (const index of [1, 2, 3, 4, 5, 6]) notify({ title: `Notice ${index}` });

    const titles = getSystemNotices().map((notice) => notice.title);
    expect(titles).toEqual(["Notice 6", "Notice 5", "Notice 4", "Notice 3"]);
  });

  it("dismisses by id and ignores an unknown id", () => {
    const id = notify({ title: "Back online" });
    dismissNotice("not-a-real-id");
    expect(getSystemNotices()).toHaveLength(1);

    dismissNotice(id);
    expect(getSystemNotices()).toHaveLength(0);
  });
});
