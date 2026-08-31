import { describe, it, expect } from "vitest";
import { isAllowedRedirectUri } from "@/shared/lib/auth/oauth/constants";

describe("isAllowedRedirectUri — Standard MCP redirect policy", () => {
  it("accepts any HTTPS callback (ChatGPT, Claude, hosted web connectors)", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://some-new-platform.example.com/cb")).toBe(true);
  });

  it("accepts http only for loopback, on any port (RFC 8252 native apps)", () => {
    expect(isAllowedRedirectUri("http://localhost/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:49152/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:8080/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:3000/cb")).toBe(true);
  });

  it("accepts custom application schemes (Cursor, VS Code, native mobile)", () => {
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-retrieval/oauth")).toBe(true);
    expect(isAllowedRedirectUri("vscode://vscode.mcp/callback")).toBe(true);
    expect(isAllowedRedirectUri("com.example.app:/oauth2redirect")).toBe(true);
  });

  it("rejects plain http to non-loopback hosts (token interception risk)", () => {
    expect(isAllowedRedirectUri("http://evil.example.com/steal")).toBe(false);
    expect(isAllowedRedirectUri("http://chatgpt.com/callback")).toBe(false);
  });

  it("rejects script/exfiltration schemes", () => {
    expect(isAllowedRedirectUri("javascript:alert(document.cookie)")).toBe(false);
    expect(isAllowedRedirectUri("data:text/html,<script>x</script>")).toBe(false);
    expect(isAllowedRedirectUri("file:///etc/passwd")).toBe(false);
  });

  it("rejects malformed or empty input", () => {
    expect(isAllowedRedirectUri("")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri("foo:")).toBe(false);
  });
});
