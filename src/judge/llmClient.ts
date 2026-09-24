/**
 * Vision-capable LLM client wrapper for the judge layer.
 *
 * The judge only depends on the small LLMClient interface, so tests can
 * swap in a fake (P025). AnthropicClient implements it by calling the
 * Anthropic Messages API with the prompt and the three screenshots,
 * retrying on rate limits, overload and transient network errors.
 *
 * Ticket: P022
 */

import type { JudgePrompt } from "./prompts.js";

/**
 * The three images the model needs to judge a change properly:
 * the diff image alone shows *where* pixels changed, but only the
 * baseline + current pair shows *what* actually changed.
 * All values are base64-encoded PNGs.
 */
export interface JudgeImages {
  baseline: string;
  current: string;
  diff: string;
}

export interface LLMReply {
  /** The model's text reply (expected to be the JSON verdict). */
  text: string;
  /** The model that actually answered. */
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** What the judge needs from an LLM. */
export interface LLMClient {
  readonly model: string;
  judge(images: JudgeImages, prompt: JudgePrompt): Promise<LLMReply>;
}

/** Thrown when the LLM call fails. `retryable` says whether trying again could help. */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  /** Default: https://api.anthropic.com */
  baseUrl?: string;
  /** Retries after the first attempt for retryable errors (default: 3). */
  maxRetries?: number;
  /** First retry delay in ms; doubles each time, with jitter (default: 1000). */
  retryBaseDelayMs?: number;
  /** Longest single wait between retries in ms (default: 30000). */
  maxRetryDelayMs?: number;
  /** Per-request timeout in ms (default: 60000). */
  timeoutMs?: number;
  /** Max tokens in the reply (default: 1024 — the verdict JSON is short). */
  maxTokens?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** HTTP statuses worth retrying: rate limit, server errors, and Anthropic's "overloaded". */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AnthropicClient implements LLMClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: AnthropicClientOptions) {
    if (!options.apiKey || options.apiKey.trim() === "") {
      throw new LLMError(
        "LLM_API_KEY is not set. Add your Anthropic API key to .env to use the AI judge."
      );
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxTokens = options.maxTokens ?? 1024;
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Builds the Messages API request body: prompt text, then each image with its label. */
  buildRequest(images: JudgeImages, prompt: JudgePrompt): Record<string, unknown> {
    const image = (data: string) => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data },
    });
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system: prompt.system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt.user },
            { type: "text", text: "BASELINE:" },
            image(images.baseline),
            { type: "text", text: "CURRENT:" },
            image(images.current),
            { type: "text", text: "DIFF:" },
            image(images.diff),
          ],
        },
      ],
    };
  }

  async judge(images: JudgeImages, prompt: JudgePrompt): Promise<LLMReply> {
    const body = JSON.stringify(this.buildRequest(images, prompt));
    let lastError: LLMError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.send(body);
      } catch (err) {
        lastError = err instanceof LLMError ? err : new LLMError(String(err), undefined, true);
        if (!lastError.retryable || attempt === this.maxRetries) break;
        await this.sleep(this.retryDelay(attempt, lastError));
      }
    }

    const attempts = lastError?.retryable ? ` after ${this.maxRetries + 1} attempts` : "";
    throw new LLMError(
      `${lastError?.message ?? "LLM call failed"}${attempts}`,
      lastError?.status,
      lastError?.retryable ?? false
    );
  }

  /** Exponential backoff with jitter, or the server's retry-after if it sent one. */
  private retryDelay(attempt: number, error: LLMError & { retryAfterMs?: number }): number {
    if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, this.maxRetryDelayMs);
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    const jittered = exponential * (0.5 + this.random() * 0.5);
    return Math.min(Math.round(jittered), this.maxRetryDelayMs);
  }

  private async send(body: string): Promise<LLMReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      throw new LLMError(
        timedOut
          ? `LLM request timed out after ${this.timeoutMs}ms`
          : `Could not reach the LLM API: ${(err as Error).message}`,
        undefined,
        true
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Non-JSON body (e.g. a proxy error page) — handled below.
    }

    if (!response.ok) {
      const apiMessage =
        (data.error as { message?: string } | undefined)?.message ?? text.slice(0, 200);
      const hint =
        response.status === 401
          ? " (check LLM_API_KEY)"
          : response.status === 404
            ? " (check LLM_MODEL)"
            : "";
      const error = new LLMError(
        `LLM API error ${response.status}: ${apiMessage}${hint}`,
        response.status,
        RETRYABLE_STATUSES.has(response.status)
      ) as LLMError & { retryAfterMs?: number };
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
      throw error;
    }

    const content = Array.isArray(data.content)
      ? (data.content as { type: string; text?: string }[])
      : [];
    const reply = content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!reply) {
      throw new LLMError("The LLM returned an empty reply", response.status, true);
    }

    const usage = (data.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    return {
      text: reply,
      model: typeof data.model === "string" ? data.model : this.model,
      usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 },
    };
  }
}

/** Creates the configured LLM client from settings. Throws a clear error if the key is missing. */
export function createLLMClient(settings: { llmApiKey: string; llmModel: string }): LLMClient {
  return new AnthropicClient({ apiKey: settings.llmApiKey, model: settings.llmModel });
}
