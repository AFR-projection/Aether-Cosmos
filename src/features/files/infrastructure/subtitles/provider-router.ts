import { classifyProviderFailure, fullJitterBackoffMs, type ProviderFailure } from "./provider-retry";

export type SubtitleProviderCapability = "asr" | "translation";
export type SubtitleProviderRole = "primary" | "fallback";

/** Schema-neutral profile contract: orchestration may map DB rows into this shape later. */
export type SubtitleProviderProfile<TClient> = {
  id: string;
  capability: SubtitleProviderCapability;
  role: SubtitleProviderRole;
  client: TClient;
};

export type CircuitState = {
  transientFailures: readonly number[];
  openedAt?: number;
  cooldownMs?: number;
  halfOpenProbeInFlight?: boolean;
};

export type ProviderRoutingState = {
  primary: CircuitState;
  itemPrimaryTransientFailures: number;
};

export type ProviderRoute = {
  role: SubtitleProviderRole;
  isHalfOpenProbe: boolean;
  reason: "primary" | "item_failover" | "circuit_open" | "half_open_probe";
};

export type ProviderRouterOptions = {
  failureThreshold?: number;
  failureWindowMs?: number;
  itemFallbackThreshold?: number;
  initialCooldownMs?: number;
  maxCooldownMs?: number;
};

const DEFAULTS = {
  failureThreshold: 5,
  failureWindowMs: 2 * 60_000,
  itemFallbackThreshold: 3,
  initialCooldownMs: 60_000,
  maxCooldownMs: 15 * 60_000,
};

function prune(failures: readonly number[], now: number, windowMs: number): number[] {
  return failures.filter((at) => at > now - windowMs);
}

export class SubtitleProviderRouter<TClient> {
  private readonly options: Required<ProviderRouterOptions>;

  constructor(
    readonly primary: SubtitleProviderProfile<TClient>,
    readonly fallback?: SubtitleProviderProfile<TClient>,
    options: ProviderRouterOptions = {}
  ) {
    if (primary.role !== "primary") throw new Error("The primary profile must have role primary");
    if (fallback && fallback.role !== "fallback") throw new Error("The fallback profile must have role fallback");
    if (fallback && fallback.capability !== primary.capability) {
      throw new Error("Primary and fallback profiles must have the same capability");
    }
    this.options = { ...DEFAULTS, ...options };
  }

  initialState(): ProviderRoutingState {
    return { primary: { transientFailures: [] }, itemPrimaryTransientFailures: 0 };
  }

  select(state: ProviderRoutingState, now = Date.now()): ProviderRoute {
    const circuit = state.primary;
    const failures = prune(circuit.transientFailures, now, this.options.failureWindowMs);
    const open = circuit.openedAt !== undefined && failures.length >= this.options.failureThreshold;

    if (open) {
      const cooldown = circuit.cooldownMs ?? this.options.initialCooldownMs;
      if (now - circuit.openedAt! >= cooldown && !circuit.halfOpenProbeInFlight) {
        return { role: "primary", isHalfOpenProbe: true, reason: "half_open_probe" };
      }
      if (this.fallback) return { role: "fallback", isHalfOpenProbe: false, reason: "circuit_open" };
      return { role: "primary", isHalfOpenProbe: false, reason: "primary" };
    }

    if (state.itemPrimaryTransientFailures >= this.options.itemFallbackThreshold && this.fallback) {
      return { role: "fallback", isHalfOpenProbe: false, reason: "item_failover" };
    }
    return { role: "primary", isHalfOpenProbe: false, reason: "primary" };
  }

  clientFor(route: ProviderRoute): SubtitleProviderProfile<TClient> {
    if (route.role === "fallback") {
      if (!this.fallback) throw new Error("No subtitle fallback provider is configured");
      return this.fallback;
    }
    return this.primary;
  }

  begin(state: ProviderRoutingState, route: ProviderRoute): ProviderRoutingState {
    if (!route.isHalfOpenProbe) return state;
    return { ...state, primary: { ...state.primary, halfOpenProbeInFlight: true } };
  }

  recordSuccess(state: ProviderRoutingState, route: ProviderRoute): ProviderRoutingState {
    if (route.role === "fallback") return state;
    return { primary: { transientFailures: [] }, itemPrimaryTransientFailures: 0 };
  }

  recordFailure(
    state: ProviderRoutingState,
    route: ProviderRoute,
    error: unknown,
    now = Date.now()
  ): { state: ProviderRoutingState; failure: ProviderFailure } {
    const failure = classifyProviderFailure(error);
    if (route.role !== "primary" || !failure.transient) return { state, failure };

    const failures = [
      ...prune(state.primary.transientFailures, now, this.options.failureWindowMs),
      now,
    ];
    const opening = failures.length >= this.options.failureThreshold;
    const previousCooldown = state.primary.cooldownMs ?? this.options.initialCooldownMs;
    const cooldownMs = route.isHalfOpenProbe
      ? Math.min(this.options.maxCooldownMs, previousCooldown * 2)
      : previousCooldown;

    return {
      failure,
      state: {
        itemPrimaryTransientFailures: state.itemPrimaryTransientFailures + 1,
        primary: {
          transientFailures: failures,
          ...(opening || route.isHalfOpenProbe ? { openedAt: now, cooldownMs } : {}),
          halfOpenProbeInFlight: false,
        },
      },
    };
  }

  retryDelayMs(error: unknown, attempt: number, random?: () => number): number | undefined {
    const failure = classifyProviderFailure(error);
    if (!failure.transient) return undefined;
    return fullJitterBackoffMs({ attempt, retryAfterMs: failure.retryAfterMs, random });
  }
}

/** Stable, header-safe request token. Callers should derive it from immutable work identity. */
export function deterministicProviderRequestId(parts: readonly (string | number)[]): string {
  const token = parts.map((part) => String(part).trim()).join(":");
  if (!token || token.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(token)) {
    throw new Error("Provider request identity must be 1-200 header-safe characters");
  }
  return token;
}
