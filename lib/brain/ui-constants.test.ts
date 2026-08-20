import { describe, it, expect } from "vitest";
import {
  BRAIN_API_SCOPES,
  BRAIN_ENTITY_TYPES,
  MEMORY_TYPES,
} from "@/lib/brain/constants";
import {
  BRAIN_SCOPE_LABELS,
  ENTITY_TYPE_OPTIONS,
  MEMORY_TYPE_OPTIONS,
} from "@/lib/brain/ui-constants";

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

  it("gives every option a non-empty label", () => {
    for (const option of [...MEMORY_TYPE_OPTIONS, ...ENTITY_TYPE_OPTIONS]) {
      expect(option.label.length).toBeGreaterThan(0);
    }
    for (const scope of Object.values(BRAIN_SCOPE_LABELS)) {
      expect(scope.label.length).toBeGreaterThan(0);
      expect(scope.description.length).toBeGreaterThan(0);
    }
  });
});
