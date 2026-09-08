/**
 * Replaces safe install placeholders only when the user explicitly copies a
 * one-time ready-to-paste artifact in the browser.
 */
export function materializeAgentInstallText(safeText: string, rawKey: string): string {
  return safeText
    .split('bearer_token_env_var = "AETHER_BRAIN_AGENT_KEY"')
    .join(`bearer_token = "${rawKey}"`)
    .split("{env:AETHER_BRAIN_AGENT_KEY}")
    .join(rawKey)
    .split("${AETHER_BRAIN_AGENT_KEY}")
    .join(rawKey)
    .split("sk_YOUR_AGENT_KEY")
    .join(rawKey);
}
