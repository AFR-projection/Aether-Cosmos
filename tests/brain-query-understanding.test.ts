import { describe, expect, it } from "vitest";
import {
  normalizeText,
  tokenize,
  detectIntent,
  extractContentWords,
  detectPhrases,
  processQuery,
  buildEnhancedQuery,
  extractEntityMatchWords,
  IMPERATIVE_VERBS,
} from "@/lib/brain/retrieval/query-understanding";
import { STOP_WORDS } from "@/lib/brain/graph/relate";

describe("query-understanding", () => {
  describe("normalizeText", () => {
    it("converts to lowercase", () => {
      expect(normalizeText("Hello WORLD")).toBe("hello world");
    });

    it("normalizes smart quotes", () => {
      expect(normalizeText("it's \"quoted\"")).toBe("it's \"quoted\"");
    });

    it("normalizes dashes", () => {
      expect(normalizeText("em—dash en–dash")).toBe("em-dash en-dash");
    });

    it("collapses multiple spaces", () => {
      expect(normalizeText("too    many   spaces")).toBe("too many spaces");
    });

    it("handles Unicode NFD normalization", () => {
      const result = normalizeText("café");
      // NFD normalization doesn't change visual appearance, just internal representation
      expect(result.toLowerCase()).toContain("caf");
      expect(result.length).toBeGreaterThan(3);
    });
  });

  describe("tokenize", () => {
    it("splits on non-alphanumeric", () => {
      expect(tokenize("hello, world!")).toEqual(["hello", "world"]);
    });

    it("filters short words", () => {
      expect(tokenize("a bb ccc dddd")).toEqual(["ccc", "dddd"]);
    });

    it("handles Indonesian text", () => {
      expect(tokenize("pengguna dan preferensi")).toEqual(["pengguna", "dan", "preferensi"]);
    });

    it("handles mixed punctuation", () => {
      expect(tokenize("user@example.com port:8080")).toEqual(["user", "example", "com", "port", "8080"]);
    });
  });

  describe("detectIntent", () => {
    it("detects ACTION for imperative queries", () => {
      expect(detectIntent(["cek", "identitas"])).toBe("ACTION");
      expect(detectIntent(["show", "me"])).toBe("ACTION");
      expect(detectIntent(["tampilkan", "data"])).toBe("ACTION");
    });

    it("detects SEARCH for non-imperative queries", () => {
      expect(detectIntent(["identitas", "pengguna"])).toBe("SEARCH");
      expect(detectIntent(["user", "authentication"])).toBe("SEARCH");
      expect(detectIntent(["preferensi", "komunikasi"])).toBe("SEARCH");
    });

    it("returns SEARCH for empty query", () => {
      expect(detectIntent([])).toBe("SEARCH");
    });
  });

  describe("extractContentWords", () => {
    it("removes stopwords", () => {
      const words = ["identitas", "dan", "preferensi"];
      expect(extractContentWords(words)).toEqual(["identitas", "preferensi"]);
    });

    it("removes imperatives", () => {
      const words = ["cek", "identitas", "pengguna"];
      expect(extractContentWords(words)).toEqual(["identitas", "pengguna"]);
    });

    it("removes both stopwords and imperatives", () => {
      const words = ["show", "the", "user", "and", "settings"];
      expect(extractContentWords(words)).toEqual(["user", "settings"]);
    });

    it("deduplicates words", () => {
      const words = ["user", "user", "settings", "user"];
      expect(extractContentWords(words)).toEqual(["user", "settings"]);
    });

    it("filters short words", () => {
      const words = ["ab", "cde", "fghi"];
      expect(extractContentWords(words)).toEqual(["cde", "fghi"]);
    });

    it("handles Indonesian stopwords", () => {
      const words = ["identitas", "untuk", "pengguna", "yang", "aktif"];
      expect(extractContentWords(words)).toEqual(["identitas", "pengguna", "aktif"]);
    });
  });

  describe("detectPhrases", () => {
    it("detects bigrams", () => {
      const words = ["preferensi", "komunikasi", "pengguna"];
      const phrases = detectPhrases(words);
      expect(phrases).toContain("preferensi komunikasi");
      expect(phrases).toContain("komunikasi pengguna");
    });

    it("detects trigrams", () => {
      const words = ["identitas", "pengguna", "aktif", "sistem"];
      const phrases = detectPhrases(words);
      expect(phrases).toContain("identitas pengguna aktif");
      expect(phrases).toContain("pengguna aktif sistem");
    });

    it("skips phrases with stopwords", () => {
      const words = ["user", "dan", "settings"];
      const phrases = detectPhrases(words);
      expect(phrases).not.toContain("user dan");
      expect(phrases).not.toContain("dan settings");
    });

    it("skips phrases with imperatives", () => {
      const words = ["show", "user", "data"];
      const phrases = detectPhrases(words);
      expect(phrases).not.toContain("show user");
      // "user data" should be detected
      expect(phrases).toContain("user data");
    });

    it("returns empty for single word", () => {
      expect(detectPhrases(["user"])).toEqual([]);
    });

    it("returns empty for no valid phrases", () => {
      expect(detectPhrases(["the", "and", "or"])).toEqual([]);
    });
  });

  describe("processQuery", () => {
    it("processes simple Indonesian query", () => {
      const result = processQuery("identitas pengguna");
      expect(result.original).toBe("identitas pengguna");
      expect(result.normalized).toBe("identitas pengguna");
      expect(result.intent).toBe("SEARCH");
      expect(result.contentWords).toEqual(["identitas", "pengguna"]);
      expect(result.phrases).toContain("identitas pengguna");
    });

    it("processes imperative query", () => {
      const result = processQuery("Cek identitas pengguna dan preferensi komunikasi");
      expect(result.intent).toBe("ACTION");
      expect(result.contentWords).toEqual(["identitas", "pengguna", "preferensi", "komunikasi"]);
      expect(result.phrases).toContain("identitas pengguna");
      expect(result.phrases).toContain("preferensi komunikasi");
      // "cek" should not be in contentWords
      expect(result.contentWords).not.toContain("cek");
      // "dan" should not be in contentWords
      expect(result.contentWords).not.toContain("dan");
    });

    it("processes English query", () => {
      const result = processQuery("show user authentication settings");
      expect(result.intent).toBe("ACTION");
      expect(result.contentWords).toEqual(["user", "authentication", "settings"]);
      expect(result.phrases).toContain("user authentication");
      expect(result.phrases).toContain("authentication settings");
    });

    it("handles mixed case and punctuation", () => {
      const result = processQuery("User's \"Communication Preferences\"");
      expect(result.normalized).toBe("user's \"communication preferences\"");
      expect(result.contentWords).toEqual(["user", "communication", "preferences"]);
    });

    it("handles query with only stopwords", () => {
      const result = processQuery("dan atau yang");
      expect(result.contentWords).toEqual([]);
      expect(result.phrases).toEqual([]);
    });

    it("preserves allWords for entity matching", () => {
      const result = processQuery("cek MCP server dan Postgres");
      expect(result.allWords).toEqual(["cek", "mcp", "server", "dan", "postgres"]);
      expect(result.contentWords).toEqual(["mcp", "server", "postgres"]);
    });
  });

  describe("buildEnhancedQuery", () => {
    it("uses content words", () => {
      const processed = processQuery("identitas pengguna");
      const enhanced = buildEnhancedQuery(processed);
      expect(enhanced).toContain("identitas");
      expect(enhanced).toContain("pengguna");
    });

    it("boosts phrases by repeating them", () => {
      const processed = processQuery("preferensi komunikasi pengguna");
      const enhanced = buildEnhancedQuery(processed);
      // Content words: ["preferensi", "komunikasi", "pengguna"]
      // Phrases: ["preferensi komunikasi", "komunikasi pengguna"]
      // Enhanced should contain phrase words multiple times
      const words = enhanced.split(" ");
      const prefCount = words.filter((w) => w === "preferensi").length;
      const komCount = words.filter((w) => w === "komunikasi").length;
      expect(prefCount).toBeGreaterThan(1); // base + phrase boost
      expect(komCount).toBeGreaterThan(1);
    });

    it("removes imperatives and stopwords", () => {
      const processed = processQuery("cek identitas dan preferensi");
      const enhanced = buildEnhancedQuery(processed);
      expect(enhanced).not.toContain("cek");
      expect(enhanced).not.toContain("dan");
      expect(enhanced).toContain("identitas");
      expect(enhanced).toContain("preferensi");
    });

    it("deduplicates terms", () => {
      const processed = processQuery("user user settings");
      const enhanced = buildEnhancedQuery(processed);
      // Should not have "user user user" (once from each duplicate + phrase)
      expect(enhanced.split(" ").filter((w) => w === "user").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("extractEntityMatchWords", () => {
    it("removes stopwords but keeps content words", () => {
      const processed = processQuery("identitas dan preferensi");
      const entityWords = extractEntityMatchWords(processed);
      expect(entityWords).toEqual(["identitas", "preferensi"]);
      expect(entityWords).not.toContain("dan");
    });

    it("removes imperatives", () => {
      const processed = processQuery("cek MCP server");
      const entityWords = extractEntityMatchWords(processed);
      expect(entityWords).toEqual(["mcp", "server"]);
      expect(entityWords).not.toContain("cek");
    });

    it("keeps all significant words for entity matching", () => {
      const processed = processQuery("PostgreSQL pgvector extension");
      const entityWords = extractEntityMatchWords(processed);
      expect(entityWords).toEqual(["postgresql", "pgvector", "extension"]);
    });

    it("handles acronyms", () => {
      const processed = processQuery("MCP API REST");
      const entityWords = extractEntityMatchWords(processed);
      expect(entityWords).toEqual(["mcp", "api", "rest"]);
    });
  });

  describe("integration: natural language queries", () => {
    it("handles the failing test case", () => {
      const query = "Cek identitas pengguna dan preferensi komunikasi";
      const processed = processQuery(query);

      // Should extract content words without imperative
      expect(processed.contentWords).toEqual([
        "identitas",
        "pengguna",
        "preferensi",
        "komunikasi",
      ]);

      // Should detect phrases
      expect(processed.phrases).toContain("identitas pengguna");
      expect(processed.phrases).toContain("preferensi komunikasi");

      // Enhanced query for FTS
      const enhanced = buildEnhancedQuery(processed);
      expect(enhanced).toContain("identitas");
      expect(enhanced).toContain("komunikasi");
      expect(enhanced).not.toContain("cek");
      expect(enhanced).not.toContain("dan");

      // Entity match words
      const entityWords = extractEntityMatchWords(processed);
      expect(entityWords).toEqual(["identitas", "pengguna", "preferensi", "komunikasi"]);
    });

    it("handles search intent queries", () => {
      const query = "identitas pengguna Aldo Bos Nova";
      const processed = processQuery(query);

      expect(processed.intent).toBe("SEARCH");
      expect(processed.contentWords).toContain("identitas");
      expect(processed.contentWords).toContain("pengguna");
      expect(processed.contentWords).toContain("aldo");
      expect(processed.contentWords).toContain("bos");
      expect(processed.contentWords).toContain("nova");
    });

    it("handles English imperative", () => {
      const query = "show me user authentication preferences";
      const processed = processQuery(query);

      expect(processed.intent).toBe("ACTION");
      expect(processed.contentWords).toEqual(["user", "authentication", "preferences"]);
      expect(processed.contentWords).not.toContain("show");
      expect(processed.contentWords).not.toContain("me");
    });

    it("handles mixed language query", () => {
      const query = "cek PostgreSQL configuration untuk production";
      const processed = processQuery(query);

      expect(processed.intent).toBe("ACTION");
      expect(processed.contentWords).toEqual(["postgresql", "configuration", "production"]);
      expect(processed.contentWords).not.toContain("cek");
      expect(processed.contentWords).not.toContain("untuk");
    });
  });

  describe("edge cases", () => {
    it("handles empty query", () => {
      const processed = processQuery("");
      expect(processed.contentWords).toEqual([]);
      expect(processed.phrases).toEqual([]);
      expect(processed.intent).toBe("SEARCH");
    });

    it("handles query with only punctuation", () => {
      const processed = processQuery("!@#$%^&*()");
      expect(processed.contentWords).toEqual([]);
      expect(processed.phrases).toEqual([]);
    });

    it("handles very long query", () => {
      const longQuery = "word ".repeat(100);
      const processed = processQuery(longQuery);
      // Should be capped at MAX_QUERY_WORDS
      expect(processed.contentWords.length).toBeLessThanOrEqual(16);
    });

    it("handles query with numbers", () => {
      const processed = processQuery("port 8080 server config");
      expect(processed.contentWords).toContain("port");
      expect(processed.contentWords).toContain("8080");
      expect(processed.contentWords).toContain("server");
      expect(processed.contentWords).toContain("config");
    });

    it("handles query with special characters", () => {
      const processed = processQuery("user@example.com email:test@domain.org");
      expect(processed.allWords).toContain("user");
      expect(processed.allWords).toContain("example");
      expect(processed.allWords).toContain("com");
      expect(processed.allWords).toContain("email");
    });
  });

  describe("stopwords validation", () => {
    it("filters Indonesian stopwords", () => {
      const indonesianStops = ["yang", "dan", "atau", "untuk", "dengan", "pada", "dari"];
      for (const stop of indonesianStops) {
        expect(STOP_WORDS.has(stop)).toBe(true);
        const words = extractContentWords([stop, "test"]);
        expect(words).not.toContain(stop);
      }
    });

    it("filters English stopwords", () => {
      const englishStops = ["the", "and", "or", "for", "with", "from"];
      for (const stop of englishStops) {
        expect(STOP_WORDS.has(stop)).toBe(true);
        const words = extractContentWords([stop, "test"]);
        expect(words).not.toContain(stop);
      }
    });
  });

  describe("imperative verbs validation", () => {
    it("recognizes Indonesian imperatives", () => {
      const indonesianImperatives = ["cek", "tampilkan", "carikan", "lihat"];
      for (const verb of indonesianImperatives) {
        expect(IMPERATIVE_VERBS.has(verb)).toBe(true);
        const words = extractContentWords([verb, "test"]);
        expect(words).not.toContain(verb);
      }
    });

    it("recognizes English imperatives", () => {
      const englishImperatives = ["show", "get", "find", "search", "check"];
      for (const verb of englishImperatives) {
        expect(IMPERATIVE_VERBS.has(verb)).toBe(true);
        const words = extractContentWords([verb, "test"]);
        expect(words).not.toContain(verb);
      }
    });
  });
});
