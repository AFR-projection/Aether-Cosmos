import Redis from "ioredis";

let redis: Redis | null = null;
let redisAvailable = true;

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";

  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    retryStrategy: (times) => {
      if (times > 2) {
        redisAvailable = false;
        return null;
      }
      return Math.min(times * 500, 1500);
    },
  });

  client.on("error", () => {
    redisAvailable = false;
  });

  client.on("connect", () => {
    redisAvailable = true;
  });

  return client;
}

export function getRedis(): Redis | null {
  if (process.env.REDIS_DISABLED === "true") return null;
  if (!redisAvailable && redis) return null;

  if (!redis) {
    redis = createRedisClient();
  }
  return redis;
}

async function withRedis<T>(fn: (client: Redis) => Promise<T>, fallback: T): Promise<T> {
  const client = getRedis();
  if (!client) return fallback;

  try {
    if (client.status !== "ready") {
      await client.connect();
    }
    return await fn(client);
  } catch {
    redisAvailable = false;
    return fallback;
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  return withRedis(async (client) => {
    const value = await client.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }, null);
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 30): Promise<void> {
  await withRedis(async (client) => {
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }, undefined);
}

export async function cacheDel(key: string): Promise<void> {
  await withRedis(async (client) => {
    await client.del(key);
  }, undefined);
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  await withRedis(async (client) => {
    const keys = await client.keys(pattern);
    if (keys.length > 0) await client.del(...keys);
  }, undefined);
}

export async function redisIncr(key: string, windowMs: number): Promise<number | null> {
  return withRedis(async (client) => {
    const count = await client.incr(key);
    if (count === 1) {
      await client.pexpire(key, windowMs);
    }
    return count;
  }, null);
}

export async function redisGetInt(key: string): Promise<number | null> {
  return withRedis(async (client) => {
    const value = await client.get(key);
    if (value === null) return 0;
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }, null);
}

export async function redisDel(key: string): Promise<void> {
  await withRedis(async (client) => {
    await client.del(key);
  }, undefined);
}
