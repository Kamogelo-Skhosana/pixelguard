/**
 * Tests for the Anthropic LLM client, using a fake fetch (no real API calls).
 *
 * Ticket: P022
 */

import { describe, expect, it, vi } from "vitest";
import {
  AnthropicClient,
  createLLMClient,
  LLMError,
  type AnthropicClientOptions,
  type JudgeImages,
} from "../src/judge/llmClient.js";
import type { JudgePrompt } from "../src/judge/prompts.js";

const images: JudgeImages = { baseline: "QkFTRQ==", current: "Q1VSUg==", diff: "RElGRg==" };
const prompt: JudgePrompt = { system: "You are a QA engineer.", user: "Check: home page" };

const okBody = {
  model: "claude-sonnet-5",
  content: [
    { type: "text", text: '{"verdict":"Acceptable Change","confidence":9,"explanation":"ok"}' },
  ],
  usage: { input_tokens: 3200, output_tokens: 60 },
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Builds a client whose fetch returns the given responses in order. */
function client(responses: (Response | Error)[], options: Partial<AnthropicClientOptions> = {}) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  const c = new AnthropicClient({
    apiKey: "sk-test",
    model: "claude-sonnet-5",
    fetch: fetchMock as unknown as typeof fetch,
    sleep,
    random: () => 1,
    ...options,
  });
  return { c, fetchMock, sleep };
}

describe("AnthropicClient", () => {
  it("sends the prompt and the three labelled images, and returns the reply", async () => {
    const { c, fetchMock } = client([reply(200, okBody)]);
    const result = await c.judge(images, prompt);

    expect(result).toEqual({
      text: okBody.content[0].text,
      model: "claude-sonnet-5",
      usage: { inputTokens: 3200, outputTokens: 60 },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "claude-sonnet-5", temperature: 0, system: prompt.system });
    const content = body.messages[0].content;
    expect(content.map((b: { type: string; text?: string }) => b.text ?? b.type)).toEqual([
      "Check: home page",
      "BASELINE:",
      "image",
      "CURRENT:",
      "image",
      "DIFF:",
      "image",
    ]);
    expect(content[2].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "QkFTRQ==",
    });
    expect(content[4].source.data).toBe("Q1VSUg==");
    expect(content[6].source.data).toBe("RElGRg==");
  });

  it("joins multiple text blocks and ignores non-text blocks", async () => {
    const { c } = client([
      reply(200, {
        content: [
          { type: "thinking", thinking: "..." },
          { type: "text", text: '{"a":' },
          { type: "text", text: "1}" },
        ],
      }),
    ]);
    expect((await c.judge(images, prompt)).text).toBe('{"a":1}');
  });

  it("uses a custom base URL", async () => {
    const { c, fetchMock } = client([reply(200, okBody)], { baseUrl: "https://proxy.example/" });
    await c.judge(images, prompt);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://proxy.example/v1/messages"
    );
  });

  it.each([429, 500, 503, 529])("retries on HTTP %i, then succeeds", async (status) => {
    const { c, fetchMock, sleep } = client([
      reply(status, { error: { message: "busy" } }),
      reply(200, okBody),
    ]);
    await expect(c.judge(images, prompt)).resolves.toMatchObject({ model: "claude-sonnet-5" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("backs off exponentially, capped at maxRetryDelayMs", async () => {
    const { c, sleep } = client(
      [reply(529, {}), reply(529, {}), reply(529, {}), reply(529, {}), reply(200, okBody)],
      { maxRetries: 4, retryBaseDelayMs: 1000, maxRetryDelayMs: 5000 }
    );
    await c.judge(images, prompt);
    expect(sleep.mock.calls.map((call) => (call as unknown as [number])[0])).toEqual([
      1000, 2000, 4000, 5000,
    ]);
  });

  it("waits for the server's retry-after when given", async () => {
    const { c, sleep } = client([reply(429, {}, { "retry-after": "7" }), reply(200, okBody)]);
    await c.judge(images, prompt);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("gives up after maxRetries and says how many attempts were made", async () => {
    const { c, fetchMock } = client(
      [reply(503, {}), reply(503, {}), reply(503, { error: { message: "still down" } })],
      { maxRetries: 2 }
    );
    const err = await c.judge(images, prompt).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.message).toBe("LLM API error 503: still down after 3 attempts");
    expect(err.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [401, /check LLM_API_KEY/],
    [404, /check LLM_MODEL/],
    [400, /bad image/],
  ])("does not retry HTTP %i and explains it", async (status, message) => {
    const { c, fetchMock, sleep } = client([reply(status, { error: { message: "bad image" } })]);
    const err = await c.judge(images, prompt).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.message).toMatch(message);
    expect(err.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries network errors", async () => {
    const { c, fetchMock } = client([new TypeError("fetch failed"), reply(200, okBody)]);
    await expect(c.judge(images, prompt)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out slow requests and retries them", async () => {
    let calls = 0;
    const slowThenFast = vi.fn((_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(reply(200, okBody));
    });
    const c = new AnthropicClient({
      apiKey: "k",
      model: "m",
      fetch: slowThenFast as unknown as typeof fetch,
      sleep: async () => {},
      timeoutMs: 20,
    });
    await expect(c.judge(images, prompt)).resolves.toBeTruthy();
    expect(slowThenFast).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout clearly when every attempt is too slow", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const c = new AnthropicClient({
      apiKey: "k",
      model: "m",
      fetch: hang as unknown as typeof fetch,
      sleep: async () => {},
      timeoutMs: 10,
      maxRetries: 1,
    });
    await expect(c.judge(images, prompt)).rejects.toThrow(/timed out after 10ms after 2 attempts/);
  });

  it("treats an empty reply as a retryable error", async () => {
    const { c, fetchMock } = client([reply(200, { content: [] }), reply(200, okBody)]);
    await expect(c.judge(images, prompt)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles a non-JSON error body", async () => {
    const { c } = client([reply(502, "<html>Bad gateway</html>")], { maxRetries: 0 });
    await expect(c.judge(images, prompt)).rejects.toThrow(/502: <html>Bad gateway/);
  });
});

describe("createLLMClient", () => {
  it("creates an Anthropic client for the configured model", () => {
    const c = createLLMClient({ llmApiKey: "sk-test", llmModel: "claude-sonnet-5" });
    expect(c).toBeInstanceOf(AnthropicClient);
    expect(c.model).toBe("claude-sonnet-5");
  });

  it("explains a missing API key", () => {
    expect(() => createLLMClient({ llmApiKey: "  ", llmModel: "m" })).toThrow(
      /LLM_API_KEY is not set/
    );
  });
});
