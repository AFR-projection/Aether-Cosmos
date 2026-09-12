import { describe, expect, it, vi } from "vitest";
import {
  createSafeLocalFetch,
  isForbiddenProviderAddress,
  validateLocalProviderEndpoint,
  type LocalProviderLookup,
} from "./local-endpoint";

const lookup: LocalProviderLookup = vi.fn(async () => [{ address: "10.12.0.8", family: 4 }]);

describe("validateLocalProviderEndpoint", () => {
  it("accepts an exact allowlisted internal HTTP host", async () => {
    await expect(validateLocalProviderEndpoint("http://subtitle-local:8000/v1", {
      allowedHosts: "subtitle-local, another-service",
      lookup,
    })).resolves.toMatchObject({ addresses: ["10.12.0.8"] });
  });

  it("rejects suffix tricks, embedded credentials, and HTTPS", async () => {
    await expect(validateLocalProviderEndpoint("http://subtitle-local.attacker.test/v1", {
      allowedHosts: "subtitle-local",
      lookup,
    })).rejects.toThrow(/not in/i);
    await expect(validateLocalProviderEndpoint("http://user:pass@subtitle-local/v1", {
      allowedHosts: "subtitle-local",
      lookup,
    })).rejects.toThrow(/credentials/i);
    await expect(validateLocalProviderEndpoint("https://subtitle-local/v1", {
      allowedHosts: "subtitle-local",
      lookup,
    })).rejects.toThrow(/HTTP/i);
  });

  it.each(["127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "ff02::1"])(
    "rejects forbidden destination %s",
    async (address) => {
      const family = address.includes(":") ? 6 : 4;
      await expect(validateLocalProviderEndpoint("http://subtitle-local/v1", {
        allowedHosts: "subtitle-local",
        lookup: vi.fn(async () => [{ address, family }]),
      })).rejects.toThrow(/forbidden/i);
    }
  );

  it("permits private and unique-local ranges for an internal sidecar", () => {
    expect(isForbiddenProviderAddress("10.0.0.8")).toBe(false);
    expect(isForbiddenProviderAddress("192.168.1.2")).toBe(false);
    expect(isForbiddenProviderAddress("fd00::8")).toBe(false);
  });
});

describe("createSafeLocalFetch", () => {
  it("revalidates at request time and forces redirect error mode", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const safeFetch = createSafeLocalFetch({
      allowedHosts: ["subtitle-local"],
      lookup,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await safeFetch("http://subtitle-local:8000/v1/chat/completions", { method: "POST" });
    expect(lookup).toHaveBeenCalledWith("subtitle-local", { all: true, verbatim: true });
    const call = fetchImpl.mock.calls[0] as unknown as [RequestInfo, RequestInit & { dispatcher?: unknown }] | undefined;
    expect(call).toBeDefined();
    expect(call![0]).toBe("http://subtitle-local:8000/v1/chat/completions");
    expect(call![1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(call![1]).toHaveProperty("dispatcher");
  });

  it("passes a pinned dispatcher without a second application DNS lookup", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const rebindingLookup: LocalProviderLookup = vi.fn(async () => [
      { address: "10.12.0.8", family: 4 },
    ]);
    const safeFetch = createSafeLocalFetch({
      allowedHosts: ["subtitle-local"],
      lookup: rebindingLookup,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await safeFetch("http://subtitle-local:8000/v1/audio/transcriptions");
    expect(rebindingLookup).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [RequestInfo, RequestInit & { dispatcher?: unknown }] | undefined;
    expect(call).toBeDefined();
    expect(call![1]).toHaveProperty("dispatcher");
  });
});
