import { describe, it, expect } from "vitest";
import {
  EXTRACTION_CONFIDENCE,
  EXTRACTOR_VERSION,
  MAX_ENTITIES_PER_MEMORY,
  extractEntities,
  type ExtractionField,
} from "./extract";

/**
 * These tests exist to hold one line: an entity node may only appear when the text
 * literally justifies it. Most of them are therefore negative — asserting what
 * extraction must NOT invent — because a fabricated node silently poisons every
 * graph query built on top of it.
 */

function names(input: Parameters<typeof extractEntities>[0]): string[] {
  return extractEntities(input).entities.map((entity) => entity.name);
}

function fieldText(
  input: { title: string; summary?: string | null; content: string },
  field: ExtractionField
): string {
  if (field === "title") return input.title;
  if (field === "summary") return input.summary ?? "";
  return input.content;
}

describe("extractEntities", () => {
  it("returns nothing for empty input", () => {
    const result = extractEntities({ title: "", content: "" });
    expect(result.entities).toEqual([]);
    expect(result.extractedBy).toBe(EXTRACTOR_VERSION);
  });

  it("is deterministic", () => {
    const input = {
      title: "Storage decision",
      content: "We use PostgreSQL and Redis. Cloudflare R2 only for files.",
    };
    expect(extractEntities(input)).toEqual(extractEntities(input));
  });

  it("types a lexicon match from its declared type, not a guess", () => {
    const result = extractEntities({
      title: "Storage",
      content: "We keep PostgreSQL as the canonical source of truth.",
    });
    const postgres = result.entities.find((entity) => entity.name === "PostgreSQL");
    expect(postgres).toBeDefined();
    expect(postgres?.type).toBe("technology");
    expect(postgres?.rule).toBe("lexicon");
    expect(postgres?.confidence).toBe(EXTRACTION_CONFIDENCE.lexicon);
  });

  it("prefers the longest span, so one phrase does not become two nodes", () => {
    const input = { title: "Blob", content: "Cloudflare R2 stores the blobs." };
    const extracted = names(input);
    expect(extracted).toContain("Cloudflare R2");
    expect(extracted).not.toContain("Cloudflare");
  });

  it("records an alias only when the text defines it", () => {
    const result = extractEntities({
      title: "Retrieval",
      content: "Retrieval Augmented Generation (RAG) is not used in the core brain.",
    });
    const rag = result.entities.find(
      (entity) => entity.name === "Retrieval Augmented Generation"
    );
    expect(rag?.aliases).toEqual(["RAG"]);
  });

  it("never invents an alias", () => {
    const result = extractEntities({
      title: "Blob",
      content: "Cloudflare R2 stores the blobs.",
    });
    for (const entity of result.entities) {
      expect(entity.aliases).toEqual([]);
    }
  });

  it("ignores a capitalized word that only starts a sentence", () => {
    const extracted = names({
      title: "notes",
      content: "Right now we start implementation. Later we review it again.",
    });
    expect(extracted).not.toContain("Right");
    expect(extracted).not.toContain("Later");
  });

  it("accepts a capitalized word confirmed away from a sentence boundary", () => {
    const extracted = names({
      title: "notes",
      content: "Andi wrote that draft. Then Andi left.",
    });
    expect(extracted).toContain("Andi");
  });

  it("uses an honorific as a person signal and strips it from the name", () => {
    const result = extractEntities({
      title: "notes",
      content: "Pak Andi decided the architecture. Then Pak Andi left.",
    });
    const andi = result.entities.find((entity) => entity.name === "Andi");
    expect(andi).toBeDefined();
    expect(andi?.type).toBe("person");
    // An honorific is a form of address, never part of the name, so it must not
    // survive into any node — otherwise "Pak Andi" and "Andi" become two people.
    for (const entity of result.entities) {
      expect(entity.name.startsWith("Pak ")).toBe(false);
    }
  });

  it("keeps a legal suffix in an organization name", () => {
    // The suffix is both the evidence and part of the registered name, so the node
    // is "Maju Jaya Ltd". Stripping it (as honorifics are stripped) would be wrong:
    // it would collide with a person or product legitimately named "Maju Jaya".
    const result = extractEntities({
      title: "vendor",
      content: "The contract is with Maju Jaya Ltd and nobody else.",
    });
    const org = result.entities.find((entity) => entity.name === "Maju Jaya Ltd");
    expect(org?.type).toBe("organization");
  });

  it("skips capitalization rules inside a title-cased heading", () => {
    const input = {
      title: "Decision To Keep Postgres Everywhere For Now",
      content: "nothing else here.",
    };
    const extracted = names(input);
    expect(extracted).not.toContain("Decision To Keep");
    expect(extracted).not.toContain("Decision");
    // The lexicon still fires, because it does not depend on capitalization.
    expect(extracted).toContain("Postgres");
  });

  it("does not turn all-caps emphasis into an entity", () => {
    const extracted = names({
      title: "rules",
      content: "DO NOT create fake relationships. IMPORTANT.",
    });
    expect(extracted).not.toContain("DO");
    expect(extracted).not.toContain("NOT");
    expect(extracted).not.toContain("IMPORTANT");
  });

  it("extracts a real acronym", () => {
    const extracted = names({
      title: "protocol",
      content: "The agent talks over HTTP only.",
    });
    expect(extracted).toContain("HTTP");
  });

  it("lets a known brain entity outrank the lexicon", () => {
    const result = extractEntities({
      title: "hosting",
      content: "Aiven hosts the database.",
      known: [{ name: "Aiven", type: "organization", aliases: [] }],
    });
    const aiven = result.entities.find((entity) => entity.name === "Aiven");
    expect(aiven?.type).toBe("organization");
    expect(aiven?.rule).toBe("known");
    expect(aiven?.confidence).toBe(EXTRACTION_CONFIDENCE.known);
  });

  it("resolves a known alias to its canonical node", () => {
    const result = extractEntities({
      title: "protocol",
      content: "We expose MCP over stateless HTTP.",
      known: [
        { name: "Model Context Protocol", type: "technology", aliases: ["MCP"] },
      ],
    });
    const canonical = result.entities.find(
      (entity) => entity.name === "Model Context Protocol"
    );
    expect(canonical).toBeDefined();
    expect(canonical?.aliases).toContain("MCP");
  });

  it("rejects pure stop-word candidates", () => {
    const extracted = names({
      title: "The And Or",
      content: "The Yang. Dan Untuk.",
    });
    for (const name of extracted) {
      expect(["The", "And", "Or", "Yang", "Dan", "Untuk"]).not.toContain(name);
    }
  });

  it("keeps every mention offset consistent with the source text", () => {
    const input = {
      title: "PostgreSQL and Redis",
      summary: "Redis is only a cache.",
      content: "We use PostgreSQL. Redis is used for the queue, not as the data source.",
    };
    const result = extractEntities(input);
    expect(result.entities.length).toBeGreaterThan(0);
    for (const entity of result.entities) {
      expect(entity.mentions.length).toBeGreaterThan(0);
      for (const mention of entity.mentions) {
        const text = fieldText(input, mention.field);
        expect(text.slice(mention.startOffset, mention.endOffset)).toBe(mention.surface);
        expect(mention.endOffset).toBeGreaterThan(mention.startOffset);
      }
    }
  });

  it("never emits two entities claiming the same characters", () => {
    const result = extractEntities({
      title: "Cloudflare R2 and Amazon S3",
      content: "Cloudflare R2 replaced Amazon S3 for blobs. Cloudflare R2 is cheaper.",
    });
    const spans: Record<string, Array<[number, number]>> = {};
    for (const entity of result.entities) {
      for (const mention of entity.mentions) {
        const list = (spans[mention.field] ??= []);
        for (const [start, end] of list) {
          expect(mention.startOffset < end && start < mention.endOffset).toBe(false);
        }
        list.push([mention.startOffset, mention.endOffset]);
      }
    }
  });

  it("stays bounded on a large document", () => {
    const content = Array.from(
      { length: 400 },
      (_, index) => `System Alpha${index} uses PostgreSQL for Module Beta${index}.`
    ).join(" ");
    const result = extractEntities({ title: "large", content });
    expect(result.entities.length).toBeLessThanOrEqual(MAX_ENTITIES_PER_MEMORY);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it("caps mentions per entity", () => {
    const content = Array.from({ length: 50 }, () => "PostgreSQL").join(" then ");
    const result = extractEntities({ title: "repeated", content });
    const postgres = result.entities.find((entity) => entity.name === "PostgreSQL");
    expect(postgres?.mentions.length).toBeLessThanOrEqual(12);
  });
});
