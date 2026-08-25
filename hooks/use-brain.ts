"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import type { BrainGraphSnapshot } from "@/lib/brain/graph/types";
import {
  getActiveBrainId,
  getServerActiveBrainId,
  setActiveBrainId,
  subscribeActiveBrain,
} from "@/lib/brain/active-brain";
import { publishBrainChange, subscribeBrainChange } from "@/lib/brain/brain-sync";

/**
 * Data access for the Second Brain UI.
 *
 * Every hook goes through the same REST API an external agent uses — the UI is
 * one client of the Brain, never a privileged path into it (§2).
 */

export type BrainStatus = "active" | "archived";

export type Brain = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  status: BrainStatus;
  createdAt: string;
  updatedAt: string;
};

export type Memory = {
  id: string;
  brainId: string;
  type: string;
  title: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  sourceType: string;
  sourceId: string | null;
  createdBy: string | null;
  createdByAgent: string | null;
  projectId: string | null;
  version: number;
  archivedAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};

export type MemoryVersion = {
  id: string;
  versionNumber: number;
  title: string;
  content: string;
  summary: string | null;
  changeReason: string | null;
  changedBy: string | null;
  changedByAgent: string | null;
  createdAt: string;
};

export type BrainProject = {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "paused" | "done" | "archived";
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type BrainEntity = {
  id: string;
  name: string;
  type: string;
  description: string | null;
};

export type BrainRelationship = {
  id: string;
  source: string;
  type: string;
  target: string;
  confidence: number;
  sourceEntityId: string;
  targetEntityId: string;
};

export type BrainAgent = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  status: "active" | "revoked";
  scopes: string[];
  createdAt: string;
};

export type BrainAuditEntry = {
  id: string;
  principalType: "user" | "agent";
  principalId: string;
  operation: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

async function get<T>(url: string): Promise<T> {
  const res = await apiFetch<T>(url);
  if (!res.success || !res.data) throw new Error(res.error ?? "Request failed");
  return res.data;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await apiFetch<T>(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.success) throw new Error(res.error ?? "Request failed");
  return res.data as T;
}

// ── brain selection ─────────────────────────────────────────────────────────

export function useBrains() {
  return useQuery({
    queryKey: ["brains"],
    queryFn: () => get<{ brains: Brain[]; maxBrains: number }>("/api/brain"),
    staleTime: 30_000,
  });
}

/**
 * The brain the UI is pointed at. Falls back to the default brain the first time,
 * and self-heals if the stored id belongs to a brain that no longer exists.
 */
export function useActiveBrain() {
  const { data, isLoading, isError } = useBrains();
  const storedId = useSyncExternalStore(
    subscribeActiveBrain,
    getActiveBrainId,
    getServerActiveBrainId
  );

  const brains = data?.brains ?? [];
  const stored = brains.find((brain) => brain.id === storedId);
  const fallback = brains.find((brain) => brain.isDefault) ?? brains[0];
  const active = stored ?? fallback;

  useEffect(() => {
    if (!active) return;
    if (storedId !== active.id) setActiveBrainId(active.id);
  }, [active, storedId]);

  return { brain: active, brains, isLoading, isError, select: setActiveBrainId };
}

export function useBrainOverview(brainId: string | undefined) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "overview"],
    queryFn: () =>
      get<{
        brain: Brain;
        stats: {
          memoryCount: number;
          archivedCount: number;
          agentCount: number;
          recentMemories: Memory[];
        };
      }>(`/api/brain/${brainId}`),
    refetchInterval: 60_000,
  });
}

// ── memories ────────────────────────────────────────────────────────────────

export type MemoryListFilters = {
  q?: string;
  type?: string;
  tag?: string;
  projectId?: string;
  archived?: boolean;
  limit?: number;
};

function memoryQuery(filters: MemoryListFilters): string {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (filters.type) params.set("type", filters.type);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.archived) params.set("archived", "true");
  params.set("limit", String(filters.limit ?? 30));
  return params.toString();
}

export function useMemories(brainId: string | undefined, filters: MemoryListFilters) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "memories", filters],
    queryFn: () =>
      get<{ memories: Memory[]; nextCursor: string | null }>(
        `/api/brain/${brainId}/memories?${memoryQuery(filters)}`
      ),
  });
}

export function useMemory(brainId: string | undefined, memoryId: string | undefined) {
  return useQuery({
    enabled: !!brainId && !!memoryId,
    queryKey: ["brain", brainId, "memory", memoryId],
    queryFn: () => get<{ memory: Memory }>(`/api/brain/${brainId}/memories/${memoryId}`),
  });
}

export function useMemoryVersions(brainId: string | undefined, memoryId: string | undefined) {
  return useQuery({
    enabled: !!brainId && !!memoryId,
    queryKey: ["brain", brainId, "memory", memoryId, "versions"],
    queryFn: () =>
      get<{ versions: MemoryVersion[] }>(
        `/api/brain/${brainId}/memories/${memoryId}/versions`
      ),
  });
}

/** Invalidate everything under one brain after a write. */
function useBrainInvalidator(brainId: string | undefined) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["brain", brainId] });
    void queryClient.invalidateQueries({ queryKey: ["brains"] });
    // Other documents (the popped-out graph window, a second tab) hold their own
    // cache and cannot see this invalidation, so it is announced to them too.
    publishBrainChange(brainId);
  };
}

/**
 * Applies writes made in *other* documents to this one's cache.
 *
 * Mount it wherever a window has to stay current without the user reloading —
 * the standalone graph window in particular. It invalidates rather than patching,
 * so the API remains the source of truth for what changed.
 */
export function useBrainDataSync(brainId: string | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!brainId) return;
    return subscribeBrainChange((message) => {
      if (message.brainId !== brainId) return;
      void queryClient.invalidateQueries({ queryKey: ["brain", brainId] });
    });
  }, [brainId, queryClient]);
}

export type MemoryDraft = {
  title: string;
  content: string;
  type?: string;
  summary?: string;
  importance?: number;
  confidence?: number;
  projectId?: string | null;
  tags?: string[];
};

export function useCreateMemory(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (draft: MemoryDraft) =>
      send<{ memory: Memory }>(`/api/brain/${brainId}/memories`, "POST", draft),
    onSuccess: invalidate,
  });
}

export function useUpdateMemory(brainId: string | undefined, memoryId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (patch: Partial<MemoryDraft> & { archived?: boolean; changeReason?: string }) =>
      send<{ memory: Memory }>(
        `/api/brain/${brainId}/memories/${memoryId}`,
        "PATCH",
        patch
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteMemory(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (memoryId: string) =>
      send<{ deleted: boolean }>(`/api/brain/${brainId}/memories/${memoryId}`, "DELETE"),
    onSuccess: invalidate,
  });
}

export function useRestoreVersion(brainId: string | undefined, memoryId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (versionId: string) =>
      send<{ memory: Memory }>(
        `/api/brain/${brainId}/memories/${memoryId}/versions/${versionId}/restore`,
        "POST",
        {}
      ),
    onSuccess: invalidate,
  });
}

// ── tags, projects, graph, agents, audit ────────────────────────────────────

export function useBrainTags(brainId: string | undefined) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "tags"],
    queryFn: () => get<{ tags: { id: string; name: string }[] }>(`/api/brain/${brainId}/tags`),
  });
}

export function useProjects(brainId: string | undefined) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "projects"],
    queryFn: () =>
      get<{ projects: BrainProject[]; statuses: string[] }>(`/api/brain/${brainId}/projects`),
  });
}

export function useCreateProject(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (draft: { name: string; description?: string }) =>
      send<{ project: BrainProject }>(`/api/brain/${brainId}/projects`, "POST", draft),
    onSuccess: invalidate,
  });
}

export function useUpdateProject(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: ({
      projectId,
      ...patch
    }: {
      projectId: string;
      name?: string;
      description?: string | null;
      status?: BrainProject["status"];
    }) =>
      send<{ project: BrainProject }>(
        `/api/brain/${brainId}/projects/${projectId}`,
        "PATCH",
        patch
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteProject(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (projectId: string) =>
      send<{ deleted: boolean }>(`/api/brain/${brainId}/projects/${projectId}`, "DELETE"),
    onSuccess: invalidate,
  });
}

export function useEntities(brainId: string | undefined, search?: string) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "entities", search ?? ""],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100" });
      if (search?.trim()) params.set("search", search.trim());
      return get<{ entities: BrainEntity[]; types: string[] }>(
        `/api/brain/${brainId}/entities?${params.toString()}`
      );
    },
  });
}

export function useRelationships(brainId: string | undefined) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "relationships"],
    queryFn: () =>
      get<{ relationships: BrainRelationship[] }>(
        `/api/brain/${brainId}/relationships?limit=100`
      ),
  });
}

/**
 * The whole graph in one request: entities and memories as nodes, relationships
 * and memory links as edges. Separate from useEntities/useRelationships because
 * those are paginated lists capped at 100 rows — a graph needs the whole picture,
 * which is why the endpoint is rate limited and doubly capped server-side.
 */
export function useBrainGraph(
  brainId: string | undefined,
  options?: { includeMemories?: boolean }
) {
  const includeMemories = options?.includeMemories ?? true;
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "graph", includeMemories],
    queryFn: () =>
      get<BrainGraphSnapshot>(
        `/api/brain/${brainId}/graph?includeMemories=${includeMemories ? "true" : "false"}`
      ),
    // A snapshot is expensive to build; the graph does not need to be live.
    staleTime: 60_000,
  });
}

export function useAgents(brainId: string | undefined) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "agents"],
    queryFn: () =>
      get<{
        agents: BrainAgent[];
        availableScopes: string[];
        defaultScopes: string[];
        maxAgents: number;
      }>(`/api/brain/${brainId}/agents`),
    // The roster doubles as a live connection list, so keep it fresh. React
    // Query pauses polling on a hidden tab, so an idle background tab is free.
    refetchInterval: 15_000,
  });
}

export function useCreateAgent(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (draft: { name: string; description?: string; scopes: string[] }) =>
      send<{ agent: BrainAgent; rawKey: string }>(
        `/api/brain/${brainId}/agents`,
        "POST",
        draft
      ),
    onSuccess: invalidate,
  });
}

export function useRevokeAgent(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: ({ agentId, everywhere }: { agentId: string; everywhere: boolean }) =>
      everywhere
        ? send(`/api/brain/${brainId}/agents/${agentId}`, "PATCH", { status: "revoked" })
        : send(`/api/brain/${brainId}/agents/${agentId}`, "DELETE"),
    onSuccess: invalidate,
  });
}

export type ConnectInfo = {
  brain: { id: string; name: string };
  mcp: {
    url: string;
    transport: string;
    authentication: { format: string; note: string };
    exampleClientConfig: Record<string, unknown>;
    exampleCurl: string;
  };
  rest: { baseUrl: string };
  scopes: { available: string[]; default: string[] };
};

export function useConnectInfo(brainId: string | undefined) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "connect"],
    queryFn: () => get<ConnectInfo>(`/api/brain/${brainId}/connect`),
  });
}

/**
 * @param refetchMs how often to re-poll. The agents page derives live presence
 *   from this feed, so it asks for a tighter interval than the read-only views.
 */
export function useBrainAudit(brainId: string | undefined, limit = 40, refetchMs = 30_000) {
  return useQuery({
    enabled: !!brainId,
    queryKey: ["brain", brainId, "audit", limit],
    queryFn: () =>
      get<{ entries: BrainAuditEntry[] }>(`/api/brain/${brainId}/audit?limit=${limit}`),
    refetchInterval: refetchMs,
  });
}

export function useUpdateBrain(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (patch: { name?: string; description?: string | null; status?: BrainStatus }) =>
      send<{ brain: Brain }>(`/api/brain/${brainId}`, "PATCH", patch),
    onSuccess: invalidate,
  });
}

export function useCreateBrain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: { name: string; description?: string }) =>
      send<{ brain: Brain }>("/api/brain", "POST", draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["brains"] });
    },
  });
}

// ── links & backlinks (§41) ─────────────────────────────────────────────────

/** One resolved edge, either direction, with the far end already labelled. */
export type MemoryLinkNode = {
  id: string;
  linkType: string;
  direction: "outgoing" | "incoming";
  targetType: "memory" | "entity";
  /** Memory or entity id at the far end. */
  nodeId: string;
  label: string;
  nodeType: string | null;
  createdAt: string;
};

/**
 * Both directions in one request. `referencedBy` is the half the client cannot
 * compute for itself — the referencing memory is not loaded here.
 */
export function useMemoryLinks(brainId: string | undefined, memoryId: string | undefined) {
  return useQuery({
    enabled: !!brainId && !!memoryId,
    queryKey: ["brain", brainId, "memory", memoryId, "links"],
    queryFn: () =>
      get<{ relatedTo: MemoryLinkNode[]; referencedBy: MemoryLinkNode[] }>(
        `/api/brain/${brainId}/memories/${memoryId}/links`
      ),
  });
}

export type LinkDraft = {
  targetMemoryId?: string;
  targetEntityId?: string;
  linkType?: string;
};

export function useLinkMemory(brainId: string | undefined, memoryId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (draft: LinkDraft) =>
      send<{ link: { id: string } }>(
        `/api/brain/${brainId}/memories/${memoryId}/links`,
        "POST",
        draft
      ),
    // Invalidates the whole brain, not just this memory: the other end of the new
    // edge just gained a backlink it does not know about.
    onSuccess: invalidate,
  });
}

export function useUnlinkMemory(brainId: string | undefined, memoryId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (linkId: string) =>
      send<{ deleted: boolean }>(
        `/api/brain/${brainId}/memories/${memoryId}/links/${linkId}`,
        "DELETE"
      ),
    onSuccess: invalidate,
  });
}

// ── consolidation (§30/§31) ─────────────────────────────────────────────────

export type DuplicateGroup = {
  key: string;
  type: string;
  /** Winner first: highest importance, then most recently updated. */
  memories: { id: string; title: string; importance: number; updatedAt: string }[];
};

export type ConflictPair = {
  memoryId: string;
  memoryTitle: string;
  conflictsWithId: string;
  conflictsWithTitle: string;
  overlap: number;
  reason: string;
};

export type ConsolidationReport = {
  scanned: number;
  duplicates: DuplicateGroup[];
  conflicts: ConflictPair[];
  applied?: {
    memoriesArchived: number;
    supersedesLinks: number;
    conflictLinks: number;
  };
  truncated: boolean;
};

/**
 * Dry-run unless `apply` is true. The preview path is a read, so it does not
 * invalidate anything; applying archives memories and adds links, so it does.
 */
export function useConsolidate(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: (input: { apply: boolean; limit?: number }) =>
      send<ConsolidationReport>(`/api/brain/${brainId}/consolidate`, "POST", input),
    onSuccess: (_report, input) => {
      if (input.apply) invalidate();
    },
  });
}

// ── .afrbrain import (§37) ──────────────────────────────────────────────────

export type ImportCounts = {
  memories: number;
  memoryVersions: number;
  memoryLinks: number;
  tags: number;
  projects: number;
  entities: number;
  relationships: number;
};

export type ImportPreview = {
  sourceBrainName: string | null;
  exportedAt: string | null;
  formatVersion: number;
  counts: ImportCounts;
  dropped: {
    versionsWithoutMemory: number;
    linksWithMissingEnd: number;
    relationshipsWithMissingEnd: number;
    projectRefsCleared: number;
  };
  warnings: string[];
};

export type ImportRunResult = ImportPreview & {
  written: {
    memories: number;
    memoryVersions: number;
    memoryLinks: number;
    projects: number;
    entities: number;
    relationships: number;
    tagAssignments: number;
  };
};

export type ImportResponse =
  | { applied: false; preview: ImportPreview }
  | { applied: true; result: ImportRunResult };

/**
 * Uploads the archive as multipart so the bytes never go through JSON.
 * `apply: false` validates and returns counts with nothing written — the same
 * request shape, so the numbers the user confirms come from the real parser.
 */
export function useImportBrain(brainId: string | undefined) {
  const invalidate = useBrainInvalidator(brainId);
  return useMutation({
    mutationFn: async ({ file, apply }: { file: File; apply: boolean }) => {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch<ImportResponse>(
        `/api/brain/${brainId}/import?apply=${apply ? "true" : "false"}`,
        { method: "POST", body: form }
      );
      if (!res.success || !res.data) throw new Error(res.error ?? "Import failed");
      return res.data;
    },
    onSuccess: (data) => {
      if (data.applied) invalidate();
    },
  });
}
