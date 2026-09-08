import { describe, expect, it } from "vitest";
import {
  SHARING_LINKS_HREF,
  SHARING_RECEIVED_HREF,
  resolveSharingView,
} from "./sharing-view";

describe("resolveSharingView", () => {
  it.each([
    [undefined, "received"],
    [null, "received"],
    ["", "received"],
    ["unknown", "received"],
    [["links"], "received"],
    ["received", "received"],
    ["links", "links"],
  ] as const)("resolves %j to %s", (value, expected) => {
    expect(resolveSharingView(value)).toBe(expected);
  });

  it("exposes stable canonical URLs", () => {
    expect(SHARING_RECEIVED_HREF).toBe("/shares?view=received");
    expect(SHARING_LINKS_HREF).toBe("/shares?view=links");
  });
});
