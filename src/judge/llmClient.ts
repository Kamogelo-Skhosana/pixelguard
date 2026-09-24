/**
 * Vision-capable LLM client wrapper for the judge layer.
 *
 * Ticket: P022
 */

export class LLMClient {
  constructor(private apiKey: string, private model: string) {}

  async judge(diffImageBase64: string, prompt: string): Promise<string> {
    // TODO (P022): implement the actual vision API call, with retries.
    // Tests should mock this method — see P025.
    throw new Error("Not implemented");
  }
}
