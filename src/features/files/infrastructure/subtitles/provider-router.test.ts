import { describe, expect, it } from "vitest";
import {
  deterministicProviderRequestId,
  SubtitleProviderRouter,
  type ProviderRoutingState,
  type SubtitleProviderProfile,
} from "./provider-router";

const primary: SubtitleProviderProfile<string> = {
  id: "cloud",
  capability: "asr",
  role: "primary",
  client: "cloud-client",
};
const fallback: SubtitleProviderProfile<string> = {
  id: "local",
  capability: "asr",
  role: "fallback",
  client: "local-client",
};

function fail(
  router: SubtitleProviderRouter<string>,
  state: ProviderRoutingState,
  now: number,
  route = router.select(state, now)
): ProviderRoutingState {
  return router.recordFailure(state, route, { status: 503 }, now).state;
}

describe("SubtitleProviderRouter", () => {
  it("uses a healthy primary and resolves its client", () => {
    const router = new SubtitleProviderRouter(primary, fallback);
    const route = router.select(router.initialState(), 0);
    expect(route).toMatchObject({ role: "primary", reason: "primary" });
    expect(router.clientFor(route).client).toBe("cloud-client");
  });

  it("fails one item over after three transient primary failures", () => {
    const router = new SubtitleProviderRouter(primary, fallback);
    let state = router.initialState();
    state = fail(router, state, 1);
    state = fail(router, state, 2);
    state = fail(router, state, 3);
    expect(router.select(state, 4)).toMatchObject({ role: "fallback", reason: "item_failover" });
  });

  it("opens after five transient failures in two minutes", () => {
    const router = new SubtitleProviderRouter(primary, fallback, { itemFallbackThreshold: 99 });
    let state = router.initialState();
    for (let index = 0; index < 5; index += 1) state = fail(router, state, index * 1_000);
    expect(router.select(state, 5_000)).toMatchObject({ role: "fallback", reason: "circuit_open" });
  });

  it("allows exactly one half-open probe after cooldown", () => {
    const router = new SubtitleProviderRouter(primary, fallback, { itemFallbackThreshold: 99 });
    let state = router.initialState();
    for (let index = 0; index < 5; index += 1) state = fail(router, state, index * 1_000);
    const probe = router.select(state, 64_000);
    expect(probe).toMatchObject({ role: "primary", isHalfOpenProbe: true });
    state = router.begin(state, probe);
    expect(router.select(state, 64_001).role).toBe("fallback");
  });

  it("closes on successful primary probe and doubles cooldown after a failed one", () => {
    const router = new SubtitleProviderRouter(primary, fallback, { itemFallbackThreshold: 99 });
    let state = router.initialState();
    for (let index = 0; index < 5; index += 1) state = fail(router, state, index * 1_000);
    const probe = router.select(state, 64_000);
    const failed = fail(router, router.begin(state, probe), 64_000, probe);
    expect(failed.primary.cooldownMs).toBe(120_000);
    expect(router.recordSuccess(failed, { role: "primary", isHalfOpenProbe: true, reason: "half_open_probe" }))
      .toEqual(router.initialState());
  });

  it("does not count permanent or fallback failures against the primary circuit", () => {
    const router = new SubtitleProviderRouter(primary, fallback);
    const state = router.initialState();
    expect(router.recordFailure(state, router.select(state), { status: 401 }).state).toBe(state);
    expect(router.recordFailure(state, { role: "fallback", isHalfOpenProbe: false, reason: "item_failover" }, { status: 503 }).state).toBe(state);
  });
});

describe("deterministicProviderRequestId", () => {
  it("derives a stable, header-safe value from immutable parts", () => {
    expect(deterministicProviderRequestId(["run-1", "asr", 10001])).toBe("run-1:asr:10001");
    expect(deterministicProviderRequestId(["run-1", "asr", 10001])).toBe("run-1:asr:10001");
  });

  it("rejects unsafe values", () => {
    expect(() => deterministicProviderRequestId(["line\nbreak"])).toThrow(/header-safe/);
  });
});
