/**
 * Vision-capable LLM client wrapper for the judge layer.
 *
 * Ticket: P022
 */

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

export class LLMClient {
  constructor(
    private apiKey: string,
    private model: string
  ) {}

  async judge(_images: JudgeImages, _prompt: string): Promise<string> {
    // TODO (P022): implement the actual vision API call (send all three
    // images, labelled, alongside the prompt), with retries.
    // Tests should mock this method — see P025.
    void this.apiKey;
    void this.model;
    throw new Error("Not implemented");
  }
}
