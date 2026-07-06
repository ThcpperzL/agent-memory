// Plaintext-bearer-auth guard for the jiuwen-memory pi extension.
//
// Adapted from agentmemory's integrations/pi/security.ts. Re-named to jiuwen's
// env vars (JIUWEN_MEMORY_URL / JIUWEN_MEMORY_API_KEY /
// JIUWEN_MEMORY_REQUIRE_HTTPS) so the warning/throw message and the default
// env lookup match the rest of the jiuwen code-agent integrations.
//
// Behavior is unchanged from the reference: when a bearer secret is configured
// for a plaintext-HTTP, non-loopback URL, we warn once by default and throw
// when JIUWEN_MEMORY_REQUIRE_HTTPS=1.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function usesPlaintextBearerAuth(baseUrl: string, secret?: string): boolean {
  if (!secret) return false;
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(normalizedHostname(parsed.hostname));
  } catch {
    return false;
  }
}

export function plaintextBearerAuthMessage(baseUrl: string): string {
  return `jiuwen-memory: JIUWEN_MEMORY_API_KEY is configured for plaintext HTTP to ${baseUrl}. Bearer token and memory payloads can be observed on the network; use HTTPS or an SSH tunnel, or unset JIUWEN_MEMORY_API_KEY for local loopback use.`;
}

export function createPlaintextBearerAuthGuard(
  warn: (message: string) => void = (message) => console.warn(message),
  env?: { JIUWEN_MEMORY_REQUIRE_HTTPS?: string },
): (baseUrl: string, secret?: string) => void {
  let warned = false;
  return (baseUrl, secret) => {
    if (!usesPlaintextBearerAuth(baseUrl, secret)) return;
    const message = plaintextBearerAuthMessage(baseUrl);
    if ((env || process.env).JIUWEN_MEMORY_REQUIRE_HTTPS === "1") throw new Error(message);
    if (!warned) {
      warned = true;
      warn(message);
    }
  };
}
