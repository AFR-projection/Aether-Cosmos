type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const store = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, CLEANUP_INTERVAL);

function bucketKey(ip: string) {
  return `ip:${ip}`;
}

/** Read current count without incrementing. */
export function peekIpRateLimit(ip: string, windowMs: number): number {
  const now = Date.now();
  const existing = store.get(bucketKey(ip));
  if (!existing || existing.resetAt <= now) return 0;
  return existing.count;
}

export function checkIpRateLimit(
  ip: string,
  maxAttempts: number,
  windowMs: number
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const key = bucketKey(ip);
  const existing = store.get(key);

  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxAttempts - 1 };
  }

  existing.count += 1;
  if (existing.count > maxAttempts) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: maxAttempts - existing.count };
}

export function resetIpRateLimit(ip: string): void {
  store.delete(bucketKey(ip));
}
