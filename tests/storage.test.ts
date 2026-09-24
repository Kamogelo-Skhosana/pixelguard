/**
 * Tests for the screenshot storage convention.
 *
 * Ticket: P010
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listTags,
  readManifest,
  screenshotPath,
  tagDir,
  validateTag,
  writeManifest,
  type CaptureManifest,
} from "../src/capture/storage.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixelguard-storage-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("validateTag", () => {
  it.each(["baseline", "current", "release-1.2", "PR_42", "a"])("accepts %s", (tag) => {
    expect(validateTag(tag)).toBe(tag);
  });

  it.each(["", "..", "a/b", "a\\b", ".hidden", "-x", "a..b", "has space", "x".repeat(51)])(
    "rejects %j",
    (tag) => {
      expect(() => validateTag(tag)).toThrow(/Invalid tag/);
    }
  );
});

describe("paths", () => {
  it("follows <outputDir>/<tag>/<viewport>/<page>.png", () => {
    expect(tagDir("shots", "baseline")).toBe(join("shots", "baseline"));
    expect(screenshotPath("shots", "current", "mobile", "home")).toBe(
      join("shots", "current", "mobile", "home.png")
    );
  });

  it("validates the tag when building paths", () => {
    expect(() => screenshotPath("shots", "../evil", "mobile", "home")).toThrow(/Invalid tag/);
  });
});

describe("manifest", () => {
  const manifest: CaptureManifest = {
    tag: "baseline",
    capturedAt: "2026-09-24T12:00:00.000Z",
    baseUrl: "http://x.com",
    viewports: [{ name: "desktop", width: 1440, height: 900 }],
    pages: [
      {
        page: "/",
        name: "home",
        url: "http://x.com/",
        screenshots: [
          { viewport: "desktop", ok: true, file: "desktop/home.png", width: 1440, height: 2000 },
        ],
      },
    ],
  };

  it("round-trips through writeManifest/readManifest", async () => {
    await mkdir(join(dir, "baseline"), { recursive: true });
    await writeManifest(join(dir, "baseline"), manifest);
    expect(await readManifest(dir, "baseline")).toEqual(manifest);
  });

  it("explains how to capture a missing tag", async () => {
    await expect(readManifest(dir, "nope")).rejects.toThrow(
      /No capture found for tag "nope".*pixelguard capture --tag nope/
    );
  });
});

describe("listTags", () => {
  it("lists only folders with a manifest, sorted", async () => {
    const root = join(dir, "list");
    for (const tag of ["current", "baseline"]) {
      await mkdir(join(root, tag), { recursive: true });
      await writeFile(join(root, tag, "manifest.json"), "{}");
    }
    await mkdir(join(root, "incomplete"), { recursive: true });
    await mkdir(join(root, ".tmp-current-1-2"), { recursive: true });
    await writeFile(join(root, ".tmp-current-1-2", "manifest.json"), "{}");

    expect(await listTags(root)).toEqual(["baseline", "current"]);
  });

  it("returns an empty list when the output folder doesn't exist", async () => {
    expect(await listTags(join(dir, "does-not-exist"))).toEqual([]);
  });
});
