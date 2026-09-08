import { BRAIN_MCP_SERVER_NAME } from "./mcp/server";

/**
 * Copy-pasteable client configuration for turning the Brain from a tool into lifecycle.
 *
 * The object is returned by `GET /api/brain/[id]/connect`; it contains placeholders, never
 * a real key. We keep the templates in executable TypeScript rather than in prose so tests
 * can pin every URL and every hook event. A documentation snippet that drifts is annoying;
 * a hook template that drifts silently removes a user's memory.
 *
 * Claude Code is the one client here with deterministic lifecycle hooks. Its template is
 * split into `.mcp.json`, `.claude/settings.json`, and one tiny cross-platform Node script.
 * The script reads the documented hook JSON from stdin, carries session state in the OS
 * temp directory, reads the JSONL transcript on SessionEnd, and emits only context text on
 * stdout — exactly what SessionStart/UserPromptSubmit inject into Claude's context.
 */

export const AGENT_KEY_PLACEHOLDER = "sk_YOUR_AGENT_KEY";
export const AGENT_KEY_ENV = "AETHER_BRAIN_AGENT_KEY";

export type BrainAgentTemplates = ReturnType<typeof buildBrainAgentTemplates>;
export type BrainAgentInstallBundle = ReturnType<typeof buildBrainAgentInstallBundle>;
export type BrainAgentInstallTargetId =
  | "universal"
  | "claudeCode"
  | "claudeDesktop"
  | "codex"
  | "openCode"
  | "hermes"
  | "other";

export type BrainAgentInstallArtifact = {
  id: string;
  label: string;
  file?: string;
  language: "json" | "toml" | "yaml" | "javascript" | "text";
  content: string;
};

export type BrainAgentInstallTarget = {
  id: BrainAgentInstallTargetId;
  label: string;
  description: string;
  artifacts: BrainAgentInstallArtifact[];
  systemInstruction: string;
};

export function buildBrainAgentTemplates(params: {
  origin: string;
  brainId: string;
  brainName: string;
  mcpUrl: string;
}) {
  const { origin, brainId, brainName, mcpUrl } = params;
  const restBase = `${origin}/api/brain/${brainId}`;
  const mcpWithEnvironment = {
    type: "http" as const,
    url: mcpUrl,
    headers: { Authorization: `Bearer \${${AGENT_KEY_ENV}}` },
  };
  const mcpWithPlaceholder = {
    type: "http" as const,
    url: mcpUrl,
    headers: { Authorization: `Bearer ${AGENT_KEY_PLACEHOLDER}` },
  };

  const claudeCodeScript = renderClaudeCodeHookScript({ brainId, restBase });
  const lifecycleInstruction = [
    `Use the MCP server ${BRAIN_MCP_SERVER_NAME} as long-term memory for “${brainName}”.`,
    "Call brain_session_start once, before the first substantive response, if a SessionStart hook did not already inject memory.",
    "Call brain_session_turn for a new user message only when a UserPromptSubmit hook did not already inject context.",
    "Call brain_session_end with durable turns when the conversation finishes if no SessionEnd hook is installed.",
    "Standing instructions returned by the server are binding. Do not save pleasantries or transient chat.",
  ].join(" ");

  return {
    placeholders: {
      agentKey: AGENT_KEY_PLACEHOLDER,
      agentKeyEnvironment: AGENT_KEY_ENV,
      brainId,
      brainName,
      mcpUrl,
      restBase,
    },
    compatibility: {
      protocol: "MCP",
      anyMcpCapableClient: true,
      note:
        "any MCP-capable AI agent or client can connect; the generated templates below are examples, not an allowlist.",
      exampleTemplates: ["claudeCode", "claudeDesktop", "codex", "openCode", "hermes"],
    },
    claudeCode: {
      notes: [
        `Set ${AGENT_KEY_ENV} to the raw agent key; never commit the key itself.`,
        "Put mcpConfig in .mcp.json, hooksConfig in .claude/settings.json, and hookScript.content at hookScript.file.",
        "Merge these objects into existing files instead of replacing them.",
        "The SessionEnd transcript is written asynchronously by Claude Code and can lag the final in-memory turn.",
      ],
      environment: `${AGENT_KEY_ENV}=${AGENT_KEY_PLACEHOLDER}`,
      mcpFile: ".mcp.json",
      mcpConfig: { mcpServers: { [BRAIN_MCP_SERVER_NAME]: mcpWithEnvironment } },
      hooksFile: ".claude/settings.json",
      hooksConfig: {
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|clear|compact|fork",
              hooks: [
                {
                  type: "command",
                  command: "node .claude/hooks/aether-brain.cjs",
                  timeout: 20,
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node .claude/hooks/aether-brain.cjs",
                  timeout: 15,
                },
              ],
            },
          ],
          SessionEnd: [
            {
              matcher: "clear|logout|prompt_input_exit|bypass_permissions_disabled|other",
              hooks: [
                {
                  type: "command",
                  command: "node .claude/hooks/aether-brain.cjs",
                  timeout: 45,
                },
              ],
            },
          ],
        },
      },
      hookScript: {
        file: ".claude/hooks/aether-brain.cjs",
        content: claudeCodeScript,
      },
    },
    claudeDesktop: {
      file: "claude_desktop_config.json",
      note: "Claude Desktop receives standing instructions at MCP initialization; use the bootstrap prompt if your version does not auto-call lifecycle tools.",
      config: { mcpServers: { [BRAIN_MCP_SERVER_NAME]: mcpWithPlaceholder } },
      bootstrapPrompt: lifecycleInstruction,
    },
    codex: {
      file: "~/.codex/config.toml",
      config: [
        `[mcp_servers.${BRAIN_MCP_SERVER_NAME}]`,
        `url = "${mcpUrl}"`,
        `bearer_token_env_var = "${AGENT_KEY_ENV}"`,
      ].join("\n"),
      environment: `${AGENT_KEY_ENV}=${AGENT_KEY_PLACEHOLDER}`,
      instructions: lifecycleInstruction,
    },
    openCode: {
      file: "opencode.json",
      config: {
        mcp: {
          [BRAIN_MCP_SERVER_NAME]: {
            type: "remote",
            url: mcpUrl,
            headers: { Authorization: `Bearer {env:${AGENT_KEY_ENV}}` },
            enabled: true,
          },
        },
        instructions: [lifecycleInstruction],
      },
    },
    hermes: {
      file: "config.yaml",
      config: [
        "mcp_servers:",
        `  ${BRAIN_MCP_SERVER_NAME}:`,
        `    url: ${mcpUrl}`,
        "    headers:",
        `      Authorization: \"Bearer ${AGENT_KEY_PLACEHOLDER}\"`,
        "system_prompt: >-",
        `  ${lifecycleInstruction}`,
      ].join("\n"),
    },
    lifecycle: {
      automaticClient: "claude-code",
      endpoints: {
        start: `${restBase}/session/start`,
        turn: `${restBase}/session/turn`,
        end: `${restBase}/session/end`,
        ingest: `${restBase}/ingest`,
      },
      tools: [
        "brain_session_start",
        "brain_session_turn",
        "brain_session_end",
        "brain_ingest",
      ],
      instruction: lifecycleInstruction,
    },
  };
}

export function buildBrainAgentInstallBundle(params: {
  origin: string;
  brainId: string;
  brainName: string;
  mcpUrl: string;
  scopes: readonly string[];
}) {
  const templates = buildBrainAgentTemplates(params);
  const scopes = new Set(params.scopes);
  const capabilities = {
    read: scopes.has("brain.read") || scopes.has("brain.full"),
    search: scopes.has("brain.search") || scopes.has("brain.full"),
    write: scopes.has("brain.write") || scopes.has("brain.full"),
    ingest: scopes.has("brain.ingest") || scopes.has("brain.full"),
  };
  const systemInstruction = buildInstallSystemInstruction({
    brainName: params.brainName,
    capabilities,
  });
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const targets: BrainAgentInstallTarget[] = [
    {
      id: "universal",
      label: "Universal MCP",
      description: "Standard Streamable HTTP configuration for any MCP-capable client.",
      artifacts: [
        {
          id: "mcp-config",
          label: "MCP configuration",
          language: "json",
          content: json(templates.claudeDesktop.config),
        },
      ],
      systemInstruction,
    },
    {
      id: "claudeCode",
      label: "Claude Code",
      description: "MCP connection plus automatic start, turn, and end lifecycle hooks.",
      artifacts: [
        {
          id: "environment",
          label: "Environment variable",
          language: "text",
          content: templates.claudeCode.environment,
        },
        {
          id: "mcp-config",
          label: templates.claudeCode.mcpFile,
          file: templates.claudeCode.mcpFile,
          language: "json",
          content: json(templates.claudeCode.mcpConfig),
        },
        {
          id: "hooks-config",
          label: templates.claudeCode.hooksFile,
          file: templates.claudeCode.hooksFile,
          language: "json",
          content: json(templates.claudeCode.hooksConfig),
        },
        {
          id: "hook-script",
          label: templates.claudeCode.hookScript.file,
          file: templates.claudeCode.hookScript.file,
          language: "javascript",
          content: templates.claudeCode.hookScript.content,
        },
      ],
      systemInstruction,
    },
    {
      id: "claudeDesktop",
      label: "Claude Desktop",
      description: "Remote MCP configuration and lifecycle system instruction.",
      artifacts: [
        {
          id: "mcp-config",
          label: templates.claudeDesktop.file,
          file: templates.claudeDesktop.file,
          language: "json",
          content: json(templates.claudeDesktop.config),
        },
      ],
      systemInstruction,
    },
    {
      id: "codex",
      label: "Codex",
      description: "Remote MCP configuration using a credential from the environment.",
      artifacts: [
        {
          id: "environment",
          label: "Environment variable",
          language: "text",
          content: templates.codex.environment,
        },
        {
          id: "mcp-config",
          label: templates.codex.file,
          file: templates.codex.file,
          language: "toml",
          content: templates.codex.config,
        },
      ],
      systemInstruction,
    },
    {
      id: "openCode",
      label: "OpenCode",
      description: "Remote MCP configuration using an environment reference.",
      artifacts: [
        {
          id: "environment",
          label: "Environment variable",
          language: "text",
          content: `${AGENT_KEY_ENV}=${AGENT_KEY_PLACEHOLDER}`,
        },
        {
          id: "mcp-config",
          label: templates.openCode.file,
          file: templates.openCode.file,
          language: "json",
          content: json(templates.openCode.config),
        },
      ],
      systemInstruction,
    },
    {
      id: "hermes",
      label: "Hermes",
      description: "YAML MCP configuration plus lifecycle system instruction.",
      artifacts: [
        {
          id: "mcp-config",
          label: templates.hermes.file,
          file: templates.hermes.file,
          language: "yaml",
          content: templates.hermes.config,
        },
      ],
      systemInstruction,
    },
    {
      id: "other",
      label: "Other MCP client",
      description: "Endpoint, Bearer header, and instructions for any MCP-capable host.",
      artifacts: [
        {
          id: "connection-details",
          label: "Connection details",
          language: "text",
          content: [
            `Transport: Streamable HTTP`,
            `URL: ${params.mcpUrl}`,
            `Authorization: Bearer ${AGENT_KEY_PLACEHOLDER}`,
          ].join("\n"),
        },
      ],
      systemInstruction,
    },
  ];

  return {
    compatibility: templates.compatibility,
    placeholders: templates.placeholders,
    capabilities,
    scopes: [...params.scopes],
    systemInstruction,
    targets,
    verification: [
      "Install or merge the configuration without committing the API key.",
      "Restart or reconnect the AI client so it reloads MCP configuration.",
      `Confirm ${BRAIN_MCP_SERVER_NAME} appears and tools/list succeeds.`,
      "Start a fresh conversation and confirm standing instructions arrive before substantive work.",
      "Ask for a known durable fact and confirm the agent recalls or searches the Brain before claiming it does not know.",
    ],
  };
}

function buildInstallSystemInstruction(params: {
  brainName: string;
  capabilities: { read: boolean; search: boolean; write: boolean; ingest: boolean };
}): string {
  const { capabilities } = params;
  const lines = [
    `Use the MCP server ${BRAIN_MCP_SERVER_NAME} as the protected, persistent long-term memory named “${params.brainName}”.`,
    "Treat standing instructions and preferences returned by this Brain as binding unless the user explicitly overrides them in the current conversation.",
  ];

  if (capabilities.read) {
    lines.push(
      "At the beginning of a conversation, call brain_session_start exactly once before the first substantive response unless the client already injected SessionStart context."
    );
  }
  if (capabilities.search) {
    lines.push(
      "For each new user prompt, call brain_session_turn unless a client hook already injected turn context. Before claiming you do not know a durable user, project, preference, or decision fact, use Brain recall or search."
    );
  }
  if (capabilities.write) {
    lines.push(
      "Save only durable knowledge that remains useful after this conversation. Do not save pleasantries, temporary requests, secrets, raw transcripts, or speculative claims. Use brain_update to correct or extend an existing memory instead of creating a contradiction."
    );
  } else {
    lines.push("This credential is read-only: do not attempt to create or update memories.");
  }
  if (capabilities.ingest) {
    lines.push(
      "Call brain_session_end when the conversation finishes so the conservative ingest pipeline can harvest durable knowledge; call brain_ingest mid-session only when durable knowledge must be captured before the session ends."
    );
  } else {
    lines.push(
      "This credential has no brain.ingest permission: do not call brain_session_end or brain_ingest for conversation harvesting."
    );
  }
  lines.push(
    "Never expose, log, repeat, or save the API key in chat, files committed to source control, tool arguments unrelated to authentication, or Brain memory."
  );
  return lines.join("\n\n");
}

function renderClaudeCodeHookScript(params: { brainId: string; restBase: string }): string {
  return `"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BASE = ${JSON.stringify(params.restBase)};
const BRAIN_ID = ${JSON.stringify(params.brainId)};
const KEY = process.env.${AGENT_KEY_ENV};
if (!KEY) process.exit(0);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => void main(JSON.parse(raw || "{}")));

async function main(input) {
  const sessionId = String(input.session_id || "claude-code");
  const stateFile = path.join(os.tmpdir(), "aether-brain-" + BRAIN_ID + "-" + safe(sessionId) + ".json");
  const state = readJson(stateFile) || { sessionId, exclude: [] };

  if (input.hook_event_name === "SessionStart") {
    const result = await call("session/start", {
      sessionId,
      topic: "Claude Code workspace " + String(input.cwd || ""),
    });
    state.sessionId = result.sessionId || sessionId;
    state.exclude = Array.isArray(result.memoryIds) ? result.memoryIds : [];
    fs.writeFileSync(stateFile, JSON.stringify(state));
    if (result.text) process.stdout.write(result.text);
    return;
  }

  if (input.hook_event_name === "UserPromptSubmit") {
    const result = await call("session/turn", {
      sessionId: state.sessionId,
      prompt: String(input.prompt || ""),
      exclude: state.exclude,
    });
    state.exclude = [...new Set(state.exclude.concat(result.memoryIds || []))].slice(-200);
    fs.writeFileSync(stateFile, JSON.stringify(state));
    if (result.text) process.stdout.write(result.text);
    return;
  }

  if (input.hook_event_name === "SessionEnd") {
    const turns = readTurns(String(input.transcript_path || ""));
    if (turns.length) await call("session/end", { sessionId: state.sessionId, turns });
    try { fs.unlinkSync(stateFile); } catch {}
  }
}

async function call(endpoint, body) {
  const response = await fetch(BASE + "/" + endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Brain " + endpoint + " failed: " + response.status);
  const payload = await response.json();
  return payload.data || {};
}

function readTurns(file) {
  if (!file || !fs.existsSync(file)) return [];
  const turns = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\\r?\\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type !== "user" && row.type !== "assistant") continue;
      const text = contentText(row.message && row.message.content);
      if (text) turns.push({ role: row.type, text });
    } catch {}
  }
  return turns.slice(-60);
}

function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text")
    .map((block) => String(block.text || "")).join("\\n").trim();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function safe(value) { return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120); }
`;
}
