import { describe, expect, it } from "vitest";
import { buildGoogleMapsUrl } from "./access-history-map";

describe("buildGoogleMapsUrl", () => {
  it("opens the recorded coordinates as a Google Maps search", () => {
    expect(buildGoogleMapsUrl(-6.2088, 106.8456)).toBe(
      "https://www.google.com/maps/search/?api=1&query=-6.2088%2C106.8456"
    );
  });

  it("returns null when coordinates are not finite", () => {
    expect(buildGoogleMapsUrl(Number.NaN, 106.8456)).toBeNull();
    expect(buildGoogleMapsUrl(-6.2088, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
