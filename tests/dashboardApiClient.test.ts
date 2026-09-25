/**
 * Tests for the dashboard's API client (public/js/api.js): error messages,
 * retries, timeouts, cancellation and the action calls.
 *
 * Ticket: P043
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptRun,
  ApiError,
  fetchBaselineHistory,
  fetchRuns,
  getJson,
  isAbort,
  postJson,
  queryString,
  request,
  restoreBaseline,
} from "../public/js/api.js";

type Call = { url: string; init: RequestInit };
let calls: Call[];

/** Replaces fetch with one that returns the given responses (or throws errors) in order. */
function fakeFetch(...responses: (Response | Error | (() => Promise<Response>))[]) {
  calls = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("request", () => {
  it("returns the parsed JSON", async () => {
    fakeFetch(json({ runs: [] }));
    await expect(getJson("/api/runs")).resolves.toEqual({ runs: [] });
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).accept).toBe("application/json");
  });

  it("uses the server's error message, issues and code", async () => {
    fakeFetch(json({ error: "Invalid query", issues: ["limit: too big"] }, 400));
    const err = await getJson("/api/runs").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      message: "Invalid query",
      status: 400,
      issues: ["limit: too big"],
    });

    fakeFetch(json({ error: "2 screenshot(s) failed", code: "failed_screenshots" }, 409));
    const conflict = await postJson("/api/runs/1/accept", {}).catch((e) => e);
    expect(conflict).toMatchObject({ status: 409, code: "failed_screenshots" });
  });

  it("explains errors that aren't JSON", async () => {
    fakeFetch(new Response("<h1>Bad gateway</h1>", { status: 500, statusText: "Server Error" }));
    await expect(getJson("/x")).rejects.toThrow("Request failed (HTTP 500 Server Error)");
  });

  it("retries a GET once after a network error", async () => {
    fakeFetch(new TypeError("Failed to fetch"), json({ ok: true }));
    await expect(getJson("/x")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("retries a GET once after 502/503/504, then reports the error", async () => {
    fakeFetch(json({}, 503), json({ ok: true }));
    await expect(getJson("/x")).resolves.toEqual({ ok: true });

    fakeFetch(json({}, 502), json({ error: "Still down" }, 502));
    await expect(getJson("/x")).rejects.toThrow("Still down");
    expect(calls).toHaveLength(2);
  });

  it("says the server is unreachable when retries run out", async () => {
    fakeFetch(new TypeError("Failed to fetch"), new TypeError("Failed to fetch"));
    const err = await getJson("/x").catch((e) => e);
    expect(err).toMatchObject({ status: 0 });
    expect(err.message).toMatch(/Can't reach the pixelguard server/);
  });

  it("never retries actions", async () => {
    fakeFetch(new TypeError("Failed to fetch"));
    await expect(postJson("/api/runs/1/accept", {})).rejects.toThrow(/Can't reach/);
    expect(calls).toHaveLength(1);

    fakeFetch(json({ error: "busy" }, 503));
    await expect(postJson("/api/runs/1/accept", {})).rejects.toThrow("busy");
    expect(calls).toHaveLength(1);
  });

  it("times out slow requests", async () => {
    // A fetch that only ends when its signal aborts.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            )
          )
      )
    );
    await expect(request("GET", "/x", { timeoutMs: 20, retries: 0 })).rejects.toThrow(
      "The server took too long to answer (over 1s). Try again."
    );
  });

  it("can be cancelled, without retrying or wrapping the error", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          )
        )
    );
    vi.stubGlobal("fetch", fetch);
    const pending = getJson("/x", { signal: controller.signal }).catch((e) => e);
    controller.abort();
    const err = await pending;
    expect(isAbort(err)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Already cancelled: doesn't even start.
    await expect(getJson("/x", { signal: controller.signal })).rejects.toSatisfy(isAbort);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("endpoint helpers", () => {
  it("builds query strings without empty values", () => {
    expect(queryString({ limit: 25, offset: 0, status: "", target: undefined })).toBe(
      "?limit=25&offset=0"
    );
    expect(queryString({})).toBe("");
  });

  it("calls the read endpoints", async () => {
    fakeFetch(json({}), json({}));
    await fetchRuns({ limit: 25, status: "fail" });
    await fetchBaselineHistory("my baseline");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/runs?limit=25&status=fail",
      "/api/baselines/my%20baseline/history",
    ]);
  });

  it("posts accept and restore as JSON", async () => {
    fakeFetch(json({ accepted: {} }), json({ accepted: {} }), json({ restored: {} }));
    await acceptRun(7);
    await acceptRun(7, { pages: ["/pricing"], force: true });
    await restoreBaseline("baseline", 3);
    expect(calls.map((c) => [c.url, c.init.method, c.init.body])).toEqual([
      ["/api/runs/7/accept", "POST", "{}"],
      ["/api/runs/7/accept", "POST", '{"pages":["/pricing"],"force":true}'],
      ["/api/baselines/baseline/restore", "POST", '{"version":3}'],
    ]);
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json"
    );
  });
});
