import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { BRAIN_MCP_SERVER_NAME } from "./mcp/server";
import { materializeAgentInstallText } from "@brain/domain/agent-install";
import {
  AGENT_KEY_ENV,
  AGENT_KEY_PLACEHOLDER,
  buildBrainAgentInstallBundle,
  buildBrainAgentTemplates,
} from "./agent-templates";

const ORIGIN = "https://mindvault.example";
const BRAIN = "11111111-1111-4111-8111-111111111111";
const MCP_URL = `${ORIGIN}/api/brain/mcp`;

function templates() {
  return buildBrainAgentTemplates({
    origin: ORIGIN,
    brainId: BRAIN,
    brainName: "Personal Brain",
    mcpUrl: MCP_URL,
  });
}

function install(scopes: string[]) {
  return buildBrainAgentInstallBundle({
    origin: ORIGIN,
    brainId: BRAIN,
    brainName: "Personal Brain",
    mcpUrl: MCP_URL,
    scopes,
  });
}

describe("brain agent templates", () => {
  it("builds exact lifecycle URLs and placeholder metadata", () => {
    const result = templates();

    expect(result.placeholders).toMatchObject({
      agentKey: AGENT_KEY_PLACEHOLDER,
      agentKeyEnvironment: AGENT_KEY_ENV,
      brainId: BRAIN,
      mcpUrl: MCP_URL,
      restBase: `${ORIGIN}/api/brain/${BRAIN}`,
    });
    expect(result.lifecycle.endpoints).toEqual({
      start: `${ORIGIN}/api/brain/${BRAIN}/session/start`,
      turn: `${ORIGIN}/api/brain/${BRAIN}/session/turn`,
      end: `${ORIGIN}/api/brain/${BRAIN}/session/end`,
      ingest: `${ORIGIN}/api/brain/${BRAIN}/ingest`,
    });
  });

  it("states that every MCP-capable AI client is compatible", () => {
    const result = templates();

    expect(result.compatibility.protocol).toBe("MCP");
    expect(result.compatibility.anyMcpCapableClient).toBe(true);
    expect(result.compatibility.note).toContain("any MCP-capable AI agent or client");
    expect(result.compatibility.exampleTemplates).toEqual([
      "claudeCode",
      "claudeDesktop",
      "codex",
      "openCode",
      "hermes",
    ]);
  });

  it("uses environment interpolation in Claude Code without embedding a real key", () => {
    const result = templates();
    const config = result.claudeCode.mcpConfig.mcpServers[BRAIN_MCP_SERVER_NAME];
    const serialized = JSON.stringify(result);

    expect(config.headers.Authorization).toBe(`Bearer \${${AGENT_KEY_ENV}}`);
    expect(result.claudeCode.environment).toBe(`${AGENT_KEY_ENV}=${AGENT_KEY_PLACEHOLDER}`);
    expect(serialized).not.toMatch(/sk_[A-Za-z0-9]{24,}/);
  });

  it("installs all lifecycle hooks with supported matchers", () => {
    const hooks = templates().claudeCode.hooksConfig.hooks;

    expect(Object.keys(hooks)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"]);
    expect(hooks.SessionStart[0]?.matcher).toBe("startup|resume|clear|compact|fork");
    expect(hooks.SessionEnd[0]?.matcher).toContain("prompt_input_exit");
    for (const entries of Object.values(hooks)) {
      expect(entries[0]?.hooks[0]?.command).toBe("node .claude/hooks/aether-brain.cjs");
    }
  });

  it("generates syntactically valid CommonJS that consumes documented hook fields", () => {
    const script = templates().claudeCode.hookScript.content;

    expect(() => new vm.Script(script, { filename: "aether-brain.cjs" })).not.toThrow();
    for (const field of ["session_id", "hook_event_name", "prompt", "transcript_path", "cwd"]) {
      expect(script).toContain(`input.${field}`);
    }
    expect(script).toContain('process.env.AETHER_BRAIN_AGENT_KEY');
    expect(script).toContain('turns.slice(-60)');
  });

  it("exposes client-specific configuration and lifecycle guidance", () => {
    const result = templates();

    expect(result.claudeDesktop.config.mcpServers).toHaveProperty(BRAIN_MCP_SERVER_NAME);
    expect(result.codex.config).toContain(`[mcp_servers.${BRAIN_MCP_SERVER_NAME}]`);
    expect(result.codex.config).toContain(`bearer_token_env_var = "${AGENT_KEY_ENV}"`);
    expect(result.openCode.config.mcp[BRAIN_MCP_SERVER_NAME]).toMatchObject({
      type: "remote",
      enabled: true,
      url: MCP_URL,
    });
    expect(result.hermes.config).toContain("mcp_servers:");
    expect(result.lifecycle.tools).toEqual([
      "brain_session_start",
      "brain_session_turn",
      "brain_session_end",
      "brain_ingest",
    ]);
  });

  it("builds a safe install bundle with universal and client-specific targets", () => {
    const result = install(["brain.read", "brain.search", "brain.write"]);
    const serialized = JSON.stringify(result);

    expect(result.targets.map((target) => target.id)).toEqual([
      "universal",
      "claudeCode",
      "claudeDesktop",
      "codex",
      "openCode",
      "hermes",
      "other",
    ]);
    expect(result.compatibility.anyMcpCapableClient).toBe(true);
    expect(result.compatibility.note).toContain("not an allowlist");
    expect(result.targets.find((target) => target.id === "openCode")?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "environment",
          content: `${AGENT_KEY_ENV}=${AGENT_KEY_PLACEHOLDER}`,
        }),
      ])
    );
    expect(serialized).toContain(AGENT_KEY_PLACEHOLDER);
    expect(serialized).toContain(AGENT_KEY_ENV);
    expect(serialized).not.toMatch(/sk_[A-Za-z0-9]{24,}/);
  });

  it("provides strong operational instructions without overstating ingest permission", () => {
    const result = install(["brain.read", "brain.search", "brain.write"]);
    const prompt = result.systemInstruction;

    expect(prompt).toContain("brain_session_start");
    expect(prompt).toContain("brain_session_turn");
    expect(prompt).toContain("binding");
    expect(prompt).toMatch(/recall|search/i);
    expect(prompt).toContain("brain_update");
    expect(prompt).toContain("do not call brain_session_end or brain_ingest");
    expect(prompt).toContain("Never expose, log, repeat, or save the API key");
    expect(result.capabilities.ingest).toBe(false);
    expect(result.verification.length).toBeGreaterThanOrEqual(4);
  });

  it("enables closing-session harvesting only when brain.ingest is granted", () => {
    const result = install([
      "brain.read",
      "brain.search",
      "brain.write",
      "brain.ingest",
    ]);

    expect(result.capabilities.ingest).toBe(true);
    expect(result.systemInstruction).toContain("Call brain_session_end");
    expect(result.systemInstruction).toContain("durable knowledge");
    expect(result.systemInstruction).not.toContain(
      "do not call brain_session_end or brain_ingest"
    );
  });

  it("materializes one-time text without mutating the safe source", () => {
    const safe = JSON.stringify(install(["brain.read"]));
    const rawKey = "sk_1234567890abcdefghijklmnopqrstuvwxyz";
    const ready = materializeAgentInstallText(safe, rawKey);

    expect(ready).toContain(rawKey);
    expect(ready).not.toContain(AGENT_KEY_PLACEHOLDER);
    expect(ready).not.toContain(`{env:${AGENT_KEY_ENV}}`);
    expect(ready).not.toContain(`\${${AGENT_KEY_ENV}}`);
    expect(ready).not.toContain(`bearer_token_env_var = "${AGENT_KEY_ENV}"`);
    expect(safe).toContain(AGENT_KEY_PLACEHOLDER);
    expect(safe).not.toContain(rawKey);
  });
});
