/**
 * Smart Context Window Manager
 *
 * Dynamically adjusts memory retrieval based on:
 * - Available context window size
 * - Token usage patterns
 * - Memory relevance scores
 * - User's model tier (Opus has more context than Haiku)
 *
 * Goal: Maximize relevant memories without exceeding context limits
 */

import { estimateTokens } from "@/lib/brain/tokens";

export interface ContextBudget {
  total: number; // Total context window (e.g., 200k for Opus)
  system: number; // Tokens used by system prompt
  conversation: number; // Tokens in conversation history
  available: number; // Remaining for memories
}

export interface MemoryCandidate {
  id: string;
  content: string;
  score: number; // Relevance score from retrieval
  tokens: number;
}

export interface ContextAllocation {
  selected: MemoryCandidate[];
  totalTokens: number;
  coverage: number; // % of available budget used
  dropped: number; // Count of candidates dropped due to budget
}

/**
 * Estimate context budget based on model tier.
 */
export function estimateContextBudget(
  model: string,
  systemPromptTokens: number,
  conversationTokens: number
): ContextBudget {
  const contextLimits: Record<string, number> = {
    "claude-opus-5": 200_000,
    "claude-sonnet-5": 200_000,
    "claude-haiku-4-5": 200_000,
    "claude-fable-5": 200_000,
    "gpt-4-turbo": 128_000,
    "gpt-3.5-turbo": 16_000,
  };

  const total = contextLimits[model] || 200_000;
  const system = systemPromptTokens;
  const conversation = conversationTokens;

  // Reserve 20% buffer for response generation + safety margin
  const available = Math.floor((total - system - conversation) * 0.8);

  return {
    total,
    system,
    conversation,
    available: Math.max(0, available),
  };
}

/**
 * Select memories that fit within context budget.
 * Uses greedy algorithm: take highest-scoring memories until budget exhausted.
 */
export function allocateContextWindow(
  candidates: MemoryCandidate[],
  budget: ContextBudget
): ContextAllocation {
  const selected: MemoryCandidate[] = [];
  let totalTokens = 0;
  let dropped = 0;

  // Sort by score descending (highest relevance first)
  const sorted = [...candidates].sort((a, b) => b.score - a.score);

  for (const candidate of sorted) {
    if (totalTokens + candidate.tokens <= budget.available) {
      selected.push(candidate);
      totalTokens += candidate.tokens;
    } else {
      dropped++;
    }
  }

  return {
    selected,
    totalTokens,
    coverage: budget.available > 0 ? totalTokens / budget.available : 0,
    dropped,
  };
}

/**
 * Prepare memory candidates with token estimation.
 */
export function prepareMemoryCandidates(
  memories: Array<{ id: string; content: string; score: number }>
): MemoryCandidate[] {
  return memories.map((mem) => ({
    id: mem.id,
    content: mem.content,
    score: mem.score,
    tokens: estimateTokens(mem.content),
  }));
}

/**
 * Smart retrieval: adjust limit based on average memory size.
 */
export function calculateSmartLimit(
  budget: ContextBudget,
  avgMemoryTokens: number
): number {
  if (avgMemoryTokens <= 0) return 20; // Default fallback

  // Calculate how many memories can theoretically fit
  const maxPossible = Math.floor(budget.available / avgMemoryTokens);

  // Retrieve 2x to account for variance in memory sizes
  // (allocateContextWindow will trim to actual budget)
  return Math.min(maxPossible * 2, 100);
}

/**
 * Analyze historical memory sizes for a brain.
 */
export async function analyzeMemorySizes(
  brainId: string,
  sampleSize: number = 100
): Promise<{ avg: number; p50: number; p95: number }> {
  const { db } = await import("@/lib/db");
  const { memories } = await import("@/lib/db/schema");
  const { eq, isNull, desc, sql } = await import("drizzle-orm");

  const samples = await db
    .select({
      tokens: sql<number>`length(content) / 4`, // Rough token estimate (4 chars/token)
    })
    .from(memories)
    .where(eq(memories.brainId, brainId))
    .orderBy(desc(memories.createdAt))
    .limit(sampleSize);

  if (samples.length === 0) {
    return { avg: 500, p50: 500, p95: 1500 }; // Sensible defaults
  }

  const tokenCounts = samples.map((s) => s.tokens).sort((a, b) => a - b);
  const avg = tokenCounts.reduce((sum, t) => sum + t, 0) / tokenCounts.length;
  const p50 = tokenCounts[Math.floor(tokenCounts.length * 0.5)];
  const p95 = tokenCounts[Math.floor(tokenCounts.length * 0.95)];

  return { avg, p50, p95 };
}

/**
 * Context-aware retrieval wrapper.
 */
export async function smartRetrieval(
  brainId: string,
  query: string,
  budget: ContextBudget,
  retrievalFn: (limit: number) => Promise<
    Array<{ id: string; content: string; score: number }>
  >
): Promise<ContextAllocation> {
  // Analyze historical memory sizes
  const sizes = await analyzeMemorySizes(brainId);

  // Calculate smart limit
  const limit = calculateSmartLimit(budget, sizes.p50);

  // Retrieve candidates
  const rawMemories = await retrievalFn(limit);

  // Prepare with token counts
  const candidates = prepareMemoryCandidates(rawMemories);

  // Allocate within budget
  return allocateContextWindow(candidates, budget);
}
