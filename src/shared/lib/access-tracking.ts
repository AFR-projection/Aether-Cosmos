export interface DeviceInfo {
  device: string;
  browser: string;
  os: string;
}

export interface LocationInfo {
  city: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  isp: string;
  org: string;
  timezone: string;
  asn: string;
  zip: string;
}

export interface AccessDetails {
  ip: string;
  userAgent: string;
  device: DeviceInfo;
  location: LocationInfo | null;
}

export function parseUserAgent(ua: string): DeviceInfo {
  const lower = ua.toLowerCase();

  // Device
  let device = "Desktop";
  if (/mobile|android.*mobile|iphone|ipod|blackberry/i.test(lower)) device = "Mobile";
  else if (/tablet|ipad|playbook|silk/i.test(lower) || (/android/i.test(lower) && !/mobile/i.test(lower))) device = "Tablet";
  else if (/ipad/i.test(lower)) device = "Tablet";

  // Browser
  let browser = "Unknown";
  if (lower.includes("edg") || lower.includes("edge")) browser = "Edge";
  else if (lower.includes("opr") || lower.includes("opera")) browser = "Opera";
  else if (lower.includes("chrome") && !lower.includes("edg")) browser = "Chrome";
  else if (lower.includes("safari") && !lower.includes("chrome")) browser = "Safari";
  else if (lower.includes("firefox")) browser = "Firefox";
  else if (lower.includes("msie") || lower.includes("trident")) browser = "Internet Explorer";

  // OS — detailed version parsing
  let os = "Unknown";
  if (lower.includes("windows nt 11")) os = "Windows 11";
  else if (lower.includes("windows nt 10")) os = "Windows 10";
  else if (lower.includes("windows nt 6.3")) os = "Windows 8.1";
  else if (lower.includes("windows nt 6.2")) os = "Windows 8";
  else if (lower.includes("windows nt 6.1")) os = "Windows 7";
  else if (lower.includes("windows nt 6.0")) os = "Windows Vista";
  else if (lower.includes("windows")) os = "Windows";
  else if (lower.includes("mac os x") || lower.includes("macintosh")) {
    const match = lower.match(/mac os x (\d+[._]\d+)/);
    os = match ? `macOS ${match[1].replace("_", ".")}` : "macOS";
  } else if (lower.includes("android")) {
    const match = lower.match(/android ([\d.]+)/);
    os = match ? `Android ${match[1]}` : "Android";
  } else if (lower.includes("ios") || lower.includes("iphone os") || lower.includes("ipad os")) {
    const match = lower.match(/(?:os|iphone os|ipad os) (\d+[._]\d+)/);
    os = match ? `iOS ${match[1].replace("_", ".")}` : "iOS";
  } else if (lower.includes("linux")) os = "Linux";
  else if (lower.includes("crkey") || lower.includes("cros")) os = "ChromeOS";

  return { device, browser, os };
}

async function queryIpapi(ip: string): Promise<LocationInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: controller.signal,
      headers: { "User-Agent": "AetherCosmosByAFR/1.0" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return {
      city: data.city ?? "Unknown",
      country: data.country_name ?? data.country ?? "Unknown",
      region: data.region ?? "",
      lat: data.latitude ?? 0,
      lon: data.longitude ?? 0,
      isp: data.org ?? "",
      org: data.org ?? "",
      timezone: data.timezone ?? "",
      asn: data.asn ?? "",
      zip: data.postal ?? "",
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function queryIpApi(ip: string): Promise<LocationInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=city,region,country,countryCode,lat,lon,isp,org,timezone,as,zip`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === "fail") return null;
    return {
      city: data.city ?? "Unknown",
      country: data.country ?? "Unknown",
      region: data.region ?? "",
      lat: data.lat ?? 0,
      lon: data.lon ?? 0,
      isp: data.isp ?? "",
      org: data.org ?? "",
      timezone: data.timezone ?? "",
      asn: data.as ?? "",
      zip: data.zip ?? "",
    };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export async function getIpLocation(ip: string): Promise<LocationInfo | null> {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip === "unknown") return null;

  // Primary: ipapi.co (free 1000/day, precise, includes ISP/ASN/timezone)
  const primary = await queryIpapi(ip);
  if (primary) return primary;

  // Fallback: ip-api.com (free 45/min, unlimited daily)
  return queryIpApi(ip);
}

export { getClientIp as getClientIpFromRequest } from "@/shared/lib/auth/session";
