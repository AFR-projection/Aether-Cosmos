/**
 * Client-safe copies of the Brain enum lists.
 *
 * @brain/domain/constants.ts derives these from the Drizzle pgEnums, which drags the
 * whole schema module into any bundle that imports it. The UI only needs the
 * labels, so this file keeps the list small — and the test below pins it to the
 * database enum so the two can never drift.
 *
 * Every user-facing string here is a translation *key*, never a sentence: the
 * `value` is what the API receives, the `labelKey` is what the screen shows. The
 * import is type-only because `@/lib/i18n` is a client module and this file is
 * imported from server code as well.
 *
 * Wire values contain dots (`memory.create`, `brain.read`) and `resolve()` splits
 * a key on ".", so the key side is camelCase: `brain.operation.memoryCreate`.
 */

import type { TranslationKey } from "@/shared/lib/i18n";

export const MEMORY_TYPE_OPTIONS = [
  { value: "fact", labelKey: "brain.memoryType.fact" },
  { value: "preference", labelKey: "brain.memoryType.preference" },
  { value: "decision", labelKey: "brain.memoryType.decision" },
  { value: "instruction", labelKey: "brain.memoryType.instruction" },
  { value: "project", labelKey: "brain.memoryType.project" },
  { value: "person", labelKey: "brain.memoryType.person" },
  { value: "concept", labelKey: "brain.memoryType.concept" },
  { value: "experience", labelKey: "brain.memoryType.experience" },
  { value: "procedure", labelKey: "brain.memoryType.procedure" },
  { value: "event", labelKey: "brain.memoryType.event" },
  { value: "observation", labelKey: "brain.memoryType.observation" },
  { value: "conversation", labelKey: "brain.memoryType.conversation" },
  { value: "knowledge", labelKey: "brain.memoryType.knowledge" },
] as const satisfies readonly { value: string; labelKey: TranslationKey }[];

export const ENTITY_TYPE_OPTIONS = [
  { value: "person", labelKey: "brain.entityType.person" },
  { value: "project", labelKey: "brain.entityType.project" },
  { value: "organization", labelKey: "brain.entityType.organization" },
  { value: "technology", labelKey: "brain.entityType.technology" },
  { value: "location", labelKey: "brain.entityType.location" },
  { value: "concept", labelKey: "brain.entityType.concept" },
  { value: "product", labelKey: "brain.entityType.product" },
  { value: "agent", labelKey: "brain.entityType.agent" },
  { value: "document", labelKey: "brain.entityType.document" },
  { value: "other", labelKey: "brain.entityType.other" },
] as const satisfies readonly { value: string; labelKey: TranslationKey }[];

export const PROJECT_STATUS_OPTIONS = [
  { value: "active", labelKey: "brain.projectStatus.active" },
  { value: "paused", labelKey: "brain.projectStatus.paused" },
  { value: "done", labelKey: "brain.projectStatus.done" },
  { value: "archived", labelKey: "brain.projectStatus.archived" },
] as const satisfies readonly { value: string; labelKey: TranslationKey }[];

export const BRAIN_SCOPE_LABELS: Record<
  string,
  { labelKey: TranslationKey; descriptionKey: TranslationKey }
> = {
  "brain.read": {
    labelKey: "brain.scope.readLabel",
    descriptionKey: "brain.scope.readDesc",
  },
  "brain.search": {
    labelKey: "brain.scope.searchLabel",
    descriptionKey: "brain.scope.searchDesc",
  },
  "brain.write": {
    labelKey: "brain.scope.writeLabel",
    descriptionKey: "brain.scope.writeDesc",
  },
  "brain.link": {
    labelKey: "brain.scope.linkLabel",
    descriptionKey: "brain.scope.linkDesc",
  },
  "brain.delete": {
    labelKey: "brain.scope.deleteLabel",
    descriptionKey: "brain.scope.deleteDesc",
  },
  "brain.export": {
    labelKey: "brain.scope.exportLabel",
    descriptionKey: "brain.scope.exportDesc",
  },
  "brain.import": {
    labelKey: "brain.scope.importLabel",
    descriptionKey: "brain.scope.importDesc",
  },
  "brain.consolidate": {
    labelKey: "brain.scope.consolidateLabel",
    descriptionKey: "brain.scope.consolidateDesc",
  },
};

/**
 * Scopes that let an agent destroy or exfiltrate the brain. The UI marks these
 * so a user ticking through a list notices them instead of granting them out of
 * momentum — they are also the two the API leaves out of the defaults.
 */
export const BRAIN_RISKY_SCOPES = new Set(["brain.delete", "brain.export"]);

/**
 * Keys for brain_audit_logs.operation. Shared by the activity log and the agents
 * roster so the same event never gets two different names.
 */
export const BRAIN_OPERATION_KEYS: Record<string, TranslationKey> = {
  "memory.create": "brain.operation.memoryCreate",
  "memory.update": "brain.operation.memoryUpdate",
  "memory.delete": "brain.operation.memoryDelete",
  "memory.restore": "brain.operation.memoryRestore",
  "memory.search": "brain.operation.memorySearch",
  "memory.recall": "brain.operation.memoryRecall",
  "entity.upsert": "brain.operation.entityUpsert",
  "entity.update": "brain.operation.entityUpdate",
  "entity.delete": "brain.operation.entityDelete",
  "relationship.upsert": "brain.operation.relationshipUpsert",
  "relationship.delete": "brain.operation.relationshipDelete",
  "project.create": "brain.operation.projectCreate",
  "project.update": "brain.operation.projectUpdate",
  "project.delete": "brain.operation.projectDelete",
  "brain.update": "brain.operation.brainUpdate",
  "brain.export": "brain.operation.brainExport",
  "agent.create": "brain.operation.agentCreate",
  "agent.revoke": "brain.operation.agentRevoke",
  "agent.scopes": "brain.operation.agentScopes",
  "agent.access_revoke": "brain.operation.agentAccessRevoke",
};

/**
 * Verbs the link picker offers. A link type is not an enum — the API accepts any
 * `[a-z0-9_-]` word — so anything outside this table is free text the user typed,
 * and the fallback only makes it readable (`supported_by` → `supported by`)
 * instead of inventing a translation for it.
 */
export const LINK_VERB_KEYS: Record<string, TranslationKey> = {
  relates_to: "brain.links.verb.relatesTo",
  supersedes: "brain.links.verb.supersedes",
  supported_by: "brain.links.verb.supportedBy",
  contradicts: "brain.links.verb.contradicts",
  depends_on: "brain.links.verb.dependsOn",
  mentions: "brain.links.verb.mentions",
};

/**
 * Resolvers. Each one falls back to the raw wire value, so an operation, scope or
 * type the server adds before this table is updated shows up as its own code
 * rather than as a blank or as a key path.
 */

export function linkVerbLabel(linkType: string, t: (key: TranslationKey) => string): string {
  const key = LINK_VERB_KEYS[linkType];
  return key ? t(key) : linkType.replace(/[_-]+/g, " ");
}

export function brainOperationLabel(
  operation: string,
  t: (key: TranslationKey) => string
): string {
  const key = BRAIN_OPERATION_KEYS[operation];
  return key ? t(key) : operation;
}

export function brainScopeLabel(scope: string, t: (key: TranslationKey) => string): string {
  const meta = BRAIN_SCOPE_LABELS[scope];
  return meta ? t(meta.labelKey) : scope;
}

export function brainScopeDescription(
  scope: string,
  t: (key: TranslationKey) => string
): string | null {
  const meta = BRAIN_SCOPE_LABELS[scope];
  return meta ? t(meta.descriptionKey) : null;
}

const MEMORY_TYPE_KEYS: Record<string, TranslationKey> = Object.fromEntries(
  MEMORY_TYPE_OPTIONS.map((option) => [option.value, option.labelKey])
);

const ENTITY_TYPE_KEYS: Record<string, TranslationKey> = Object.fromEntries(
  ENTITY_TYPE_OPTIONS.map((option) => [option.value, option.labelKey])
);

const PROJECT_STATUS_KEYS: Record<string, TranslationKey> = Object.fromEntries(
  PROJECT_STATUS_OPTIONS.map((option) => [option.value, option.labelKey])
);

export function memoryTypeLabel(type: string, t: (key: TranslationKey) => string): string {
  const key = MEMORY_TYPE_KEYS[type];
  return key ? t(key) : type;
}

export function entityTypeLabel(type: string, t: (key: TranslationKey) => string): string {
  const key = ENTITY_TYPE_KEYS[type];
  return key ? t(key) : type;
}

export function projectStatusLabel(status: string, t: (key: TranslationKey) => string): string {
  const key = PROJECT_STATUS_KEYS[status];
  return key ? t(key) : status;
}
