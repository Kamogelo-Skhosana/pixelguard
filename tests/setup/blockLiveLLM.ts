/**
 * Test safety net: blocks any request to a real LLM API, so tests (and CI)
 * never make live calls, spend money, or depend on an API key.
 * Tests that exercise the client pass their own fake fetch instead.
 *
 * Ticket: P025
 */

const BLOCKED_HOSTS = ["api.anthropic.com"];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (BLOCKED_HOSTS.includes(host)) {
    throw new Error(
      `Blocked a live LLM API call to ${host} during tests. Use tests/helpers/mockLLM.ts or pass a fake fetch.`
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
