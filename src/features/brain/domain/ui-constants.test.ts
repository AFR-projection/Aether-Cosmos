import { describe, it, expect } from "vitest";
import {
  BRAIN_API_SCOPES,
  BRAIN_ENTITY_TYPES,
  MEMORY_TYPES,
} from "@brain/domain/constants";
import {
  BRAIN_OPERATION_KEYS,
  BRAIN_SCOPE_LABELS,
  ENTITY_TYPE_OPTIONS,
  MEMORY_TYPE_OPTIONS,
  brainOperationLabel,
  brainScopeLabel,
  memoryTypeLabel,
} from "@brain/domain/ui-constants";
import { hasKey } from "@/shared/lib/i18n/dictionary";

/**
 * The UI keeps its own hand-written copies of these lists so client bundles do not
 * pull in the Drizzle schema. That is only safe if the copies stay identical to the
 * database enums — which is what these tests enforce.
 */
describe("UI constants track the database enums", () => {
  it("offers exactly the memory types the enum declares, in the same order", () => {
    expect(MEMORY_TYPE_OPTIONS.map((option) => option.value)).toEqual([...MEMORY_TYPES]);
  });

  it("offers exactly the entity types the enum declares, in the same order", () => {
    expect(ENTITY_TYPE_OPTIONS.map((option) => option.value)).toEqual([...BRAIN_ENTITY_TYPES]);
  });

  it("labels every brain scope, and invents none", () => {
    expect(Object.keys(BRAIN_SCOPE_LABELS).sort()).toEqual([...BRAIN_API_SCOPES].sort());
  });

  it("points every option at a key the dictionary actually defines", () => {
    for (const option of [...MEMORY_TYPE_OPTIONS, ...ENTITY_TYPE_OPTIONS]) {
      expect(hasKey(option.labelKey), option.labelKey).toBe(true);
    }
    for (const scope of Object.values(BRAIN_SCOPE_LABELS)) {
      expect(hasKey(scope.labelKey), scope.labelKey).toBe(true);
      expect(hasKey(scope.descriptionKey), scope.descriptionKey).toBe(true);
    }
    for (const key of Object.values(BRAIN_OPERATION_KEYS)) {
      expect(hasKey(key), key).toBe(true);
    }
  });

  it("falls back to the raw wire value for anything it has no key for", () => {
    // A stand-in translator: it would throw on a real lookup, so these assertions
    // only pass if the resolver never reached for a key at all.
    const t = (key: string) => `<${key}>`;
    expect(brainOperationLabel("memory.consolidate", t)).toBe("memory.consolidate");
    expect(brainScopeLabel("brain.telepathy", t)).toBe("brain.telepathy");
    expect(memoryTypeLabel("rumour", t)).toBe("rumour");
    // …and that it does resolve the ones it knows.
    expect(brainOperationLabel("memory.create", t)).toBe("<brain.operation.memoryCreate>");
  });
});
