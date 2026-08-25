/**
 * Client-safe copies of the Brain enum lists.
 *
 * lib/brain/constants.ts derives these from the Drizzle pgEnums, which drags the
 * whole schema module into any bundle that imports it. The UI only needs the
 * labels, so this file keeps the list small — and the test below pins it to the
 * database enum so the two can never drift.
 */

export const MEMORY_TYPE_OPTIONS = [
  { value: "fact", label: "Fact" },
  { value: "preference", label: "Preference" },
  { value: "decision", label: "Decision" },
  { value: "instruction", label: "Instruction" },
  { value: "project", label: "Project" },
  { value: "person", label: "Person" },
  { value: "concept", label: "Concept" },
  { value: "experience", label: "Experience" },
  { value: "procedure", label: "Procedure" },
  { value: "event", label: "Event" },
  { value: "observation", label: "Observation" },
  { value: "conversation", label: "Conversation" },
  { value: "knowledge", label: "Knowledge" },
] as const;

export const ENTITY_TYPE_OPTIONS = [
  { value: "person", label: "Person" },
  { value: "project", label: "Project" },
  { value: "organization", label: "Organization" },
  { value: "technology", label: "Technology" },
  { value: "location", label: "Location" },
  { value: "concept", label: "Concept" },
  { value: "product", label: "Product" },
  { value: "agent", label: "Agent" },
  { value: "document", label: "Document" },
  { value: "other", label: "Other" },
] as const;

export const PROJECT_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
] as const;

export const BRAIN_SCOPE_LABELS: Record<string, { label: string; description: string }> = {
  "brain.read": { label: "Read", description: "Read memories, tags, entities and recall context" },
  "brain.search": { label: "Search", description: "Full-text search across memories" },
  "brain.write": {
    label: "Write",
    description: "Create and update memories, entities and relationships",
  },
  "brain.link": {
    label: "Link",
    description: "Connect memories to each other and to entities (backlinks)",
  },
  "brain.delete": { label: "Delete", description: "Soft-delete memories and remove graph nodes" },
  "brain.export": { label: "Export", description: "Bulk-export the whole brain" },
  "brain.import": {
    label: "Import",
    description: "Bulk-import an .afrbrain archive into this brain",
  },
  "brain.consolidate": {
    label: "Consolidate",
    description: "Merge duplicate memories and resolve flagged conflicts",
  },
};

/**
 * Scopes that let an agent destroy or exfiltrate the brain. The UI marks these
 * so a user ticking through a list notices them instead of granting them out of
 * momentum — they are also the two the API leaves out of the defaults.
 */
export const BRAIN_RISKY_SCOPES = new Set(["brain.delete", "brain.export"]);

/**
 * Human sentences for brain_audit_logs.operation. Shared by the activity log and
 * the agents roster so the same event never gets two different names.
 */
export const BRAIN_OPERATION_COPY: Record<string, string> = {
  "memory.create": "Created a memory",
  "memory.update": "Updated a memory",
  "memory.delete": "Deleted a memory",
  "memory.restore": "Restored a memory version",
  "memory.search": "Searched the brain",
  "memory.recall": "Recalled context",
  "entity.upsert": "Recorded an entity",
  "entity.update": "Updated an entity",
  "entity.delete": "Deleted an entity",
  "relationship.upsert": "Linked two entities",
  "relationship.delete": "Removed a link",
  "project.create": "Created a project",
  "project.update": "Updated a project",
  "project.delete": "Deleted a project",
  "brain.update": "Changed brain settings",
  "brain.export": "Exported the brain",
  "agent.create": "Connected an agent",
  "agent.revoke": "Revoked an agent",
  "agent.scopes": "Changed agent permissions",
  "agent.access_revoke": "Removed an agent from this brain",
};
