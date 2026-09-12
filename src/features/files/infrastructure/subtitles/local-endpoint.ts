import { isIP } from "node:net";
import { lookup as nodeLookup } from "node:dns/promises";
import { Agent } from "undici";

export type LocalProviderLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<readonly { address: string; family: number }[]>;

export type LocalEndpointValidationOptions = {
  allowedHosts?: string | readonly string[];
  lookup?: LocalProviderLookup;
};

type EndpointValidationResult = {
  url: URL;
  addresses: string[];
};

function parseAllowedHosts(value: string | readonly string[] | undefined): Set<string> {
  const source = value ?? process.env.SUBTITLE_LOCAL_PROVIDER_HOSTS ?? "";
  const entries: readonly string[] = typeof source === "string" ? source.split(/[\s,]+/) : source;
  return new Set(entries.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function isForbiddenIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 127 || (a === 169 && b === 254) || (a >= 224 && a <= 255);
}

function isForbiddenIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) !== 4 || isForbiddenIpv4(mapped);
  }
  return false;
}

export function isForbiddenProviderAddress(address: string): boolean {
  const family = isIP(address.split("%")[0]);
  if (family === 4) return isForbiddenIpv4(address);
  if (family === 6) return isForbiddenIpv6(address);
  return true;
}

function validateUrl(url: URL, allowedHosts: Set<string>): void {
  if (url.protocol !== "http:") throw new Error("A local subtitle provider endpoint must use HTTP");
  if (url.username || url.password) throw new Error("A local subtitle provider endpoint cannot contain credentials");
  const hostname = url.hostname.toLowerCase();
  if (!allowedHosts.has(hostname)) {
    throw new Error("The local subtitle provider host is not in SUBTITLE_LOCAL_PROVIDER_HOSTS");
  }
}

/**
 * Validate a local HTTP endpoint and resolve it before every request.
 *
 * Exact host allowlisting prevents suffix tricks; resolved addresses reject loopback, link-local,
 * unspecified and multicast destinations. RFC1918/ULA addresses remain valid because the local
 * provider is expected to live on an internal network.
 */
export async function validateLocalProviderEndpoint(
  endpoint: string | URL,
  options: LocalEndpointValidationOptions = {}
): Promise<EndpointValidationResult> {
  let url: URL;
  try {
    url = endpoint instanceof URL ? new URL(endpoint.href) : new URL(endpoint);
  } catch {
    throw new Error("The local subtitle provider endpoint is not a valid URL");
  }

  const allowedHosts = parseAllowedHosts(options.allowedHosts);
  validateUrl(url, allowedHosts);

  const literalFamily = isIP(url.hostname);
  const resolved = literalFamily
    ? [{ address: url.hostname, family: literalFamily }]
    : await (options.lookup ?? (nodeLookup as LocalProviderLookup))(url.hostname, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error("The local subtitle provider host did not resolve");

  const addresses = [...new Set(resolved.map((entry) => entry.address.split("%")[0]))];
  if (addresses.some(isForbiddenProviderAddress)) {
    throw new Error("The local subtitle provider host resolved to a forbidden address");
  }
  return { url, addresses };
}

export type SafeLocalFetchOptions = LocalEndpointValidationOptions & {
  fetchImpl?: typeof fetch;
};

type FetchWithDispatcher = (
  input: URL | RequestInfo,
  init?: RequestInit & { dispatcher?: Agent }
) => Promise<Response>;

/**
 * Revalidates DNS and pins the validated addresses into Undici's connection lookup.
 *
 * The request URL is unchanged, preserving the HTTP Host header. HTTPS is deliberately rejected
 * for local profiles, so SNI is not involved. Redirects are disabled to prevent an allowlisted
 * service redirecting to an unvalidated authority.
 */
export function createSafeLocalFetch(options: SafeLocalFetchOptions = {}): typeof fetch {
  const fetchImpl = (options.fetchImpl ?? fetch) as FetchWithDispatcher;
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input.url : input;
    const validated = await validateLocalProviderEndpoint(String(raw), options);
    let cursor = 0;
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _lookupOptions, callback) => {
          const address = validated.addresses[cursor++ % validated.addresses.length];
          callback(null, address, isIP(address));
        },
      },
    });
    try {
      return await fetchImpl(input, { ...init, redirect: "error", dispatcher });
    } finally {
      await dispatcher.close();
    }
  };
}
