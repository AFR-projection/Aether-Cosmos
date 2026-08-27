/**
 * Multi-Modal Embedding Support
 *
 * Extends brain retrieval to support multiple embedding models simultaneously:
 * - text-embedding-3-large (OpenAI) - primary for semantic search
 * - voyage-3 (Voyage AI) - specialized for code/technical content
 * - bge-m3 (BAAI) - multilingual support for Indonesian+English
 *
 * Architecture:
 * - Each memory can have multiple embeddings (one per model)
 * - Query embeds via all available models
 * - Results merged using reciprocal rank fusion (RRF)
 * - Model weights configurable per brain
 */

import { db } from "@/lib/db";
import { embed } from "@/lib/brain/embed";

export type EmbeddingModel =
  | "text-embedding-3-large"
  | "voyage-3"
  | "bge-m3"
  | "text-embedding-3-small";

export interface MultiModalEmbedding {
  memoryId: string;
  model: EmbeddingModel;
  embedding: number[];
  dimensions: number;
  createdAt: Date;
}

export interface ModelWeight {
  model: EmbeddingModel;
  weight: number;
}

/**
 * Store embedding for a specific model.
 */
export async function storeModelEmbedding(
  memoryId: string,
  model: EmbeddingModel,
  embedding: number[]
): Promise<void> {
  await db.query(
    `INSERT INTO memory_embeddings (memory_id, model, embedding, dimensions)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (memory_id, model)
     DO UPDATE SET embedding = $3, dimensions = $4, updated_at = NOW()`,
    [memoryId, model, JSON.stringify(embedding), embedding.length]
  );
}

/**
 * Get all embeddings for a memory.
 */
export async function getMemoryEmbeddings(
  memoryId: string
): Promise<MultiModalEmbedding[]> {
  const result = await db.query(
    `SELECT memory_id, model, embedding, dimensions, created_at
     FROM memory_embeddings
     WHERE memory_id = $1`,
    [memoryId]
  );

  return result.rows.map((row) => ({
    memoryId: row.memory_id,
    model: row.model,
    embedding: JSON.parse(row.embedding),
    dimensions: row.dimensions,
    createdAt: row.created_at,
  }));
}

/**
 * Multi-modal retrieval: query across all models and merge results.
 */
export async function multiModalRetrieval(
  brainId: string,
  query: string,
  models: ModelWeight[],
  limit: number = 20
): Promise<
  Array<{
    memoryId: string;
    content: string;
    fusedScore: number;
    modelScores: Record<EmbeddingModel, number>;
  }>
> {
  // Embed query with each model
  const queryEmbeddings: Record<EmbeddingModel, number[]> = {} as any;

  for (const { model } of models) {
    const embedding = await embedWithModel(query, model);
    queryEmbeddings[model] = embedding;
  }

  // Query each model's embeddings
  const modelResults: Record<
    EmbeddingModel,
    Array<{ memoryId: string; content: string; score: number; rank: number }>
  > = {} as any;

  for (const { model, weight } of models) {
    const result = await db.query(
      `SELECT
         m.id as memory_id,
         m.content,
         1 - (me.embedding::vector <=> $1::vector) as similarity
       FROM memories m
       JOIN memory_embeddings me ON me.memory_id = m.id
       WHERE m.brain_id = $2
         AND m.deleted_at IS NULL
         AND me.model = $3
       ORDER BY me.embedding::vector <=> $1::vector
       LIMIT $4`,
      [JSON.stringify(queryEmbeddings[model]), brainId, model, limit * 2]
    );

    modelResults[model] = result.rows.map((row, idx) => ({
      memoryId: row.memory_id,
      content: row.content,
      score: parseFloat(row.similarity),
      rank: idx + 1,
    }));
  }

  // Reciprocal Rank Fusion (RRF)
  const fusedScores = new Map<
    string,
    {
      memoryId: string;
      content: string;
      fusedScore: number;
      modelScores: Record<EmbeddingModel, number>;
    }
  >();

  const k = 60; // RRF constant

  for (const { model, weight } of models) {
    const results = modelResults[model] || [];

    for (const result of results) {
      const rrfScore = weight * (1 / (k + result.rank));

      if (!fusedScores.has(result.memoryId)) {
        fusedScores.set(result.memoryId, {
          memoryId: result.memoryId,
          content: result.content,
          fusedScore: 0,
          modelScores: {} as any,
        });
      }

      const entry = fusedScores.get(result.memoryId)!;
      entry.fusedScore += rrfScore;
      entry.modelScores[model] = result.score;
    }
  }

  // Sort by fused score and return top results
  return Array.from(fusedScores.values())
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, limit);
}

/**
 * Embed text using a specific model.
 */
async function embedWithModel(
  text: string,
  model: EmbeddingModel
): Promise<number[]> {
  // Map model names to OpenRouter model IDs
  const modelMap: Record<EmbeddingModel, string> = {
    "text-embedding-3-large": "openai/text-embedding-3-large",
    "text-embedding-3-small": "openai/text-embedding-3-small",
    "voyage-3": "voyageai/voyage-3",
    "bge-m3": "baai/bge-m3",
  };

  return embed(text, modelMap[model]);
}

/**
 * Backfill embeddings: generate embeddings for all models on existing memories.
 */
export async function backfillMultiModalEmbeddings(
  brainId: string,
  models: EmbeddingModel[],
  batchSize: number = 50
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  let offset = 0;

  while (true) {
    const memories = await db.query(
      `SELECT id, content
       FROM memories
       WHERE brain_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [brainId, batchSize, offset]
    );

    if (memories.rows.length === 0) break;

    for (const memory of memories.rows) {
      for (const model of models) {
        try {
          const embedding = await embedWithModel(memory.content, model);
          await storeModelEmbedding(memory.id, model, embedding);
          processed++;
        } catch (error) {
          console.error(
            `Failed to embed memory ${memory.id} with ${model}:`,
            error
          );
          failed++;
        }
      }
    }

    offset += batchSize;
  }

  return { processed, failed };
}
