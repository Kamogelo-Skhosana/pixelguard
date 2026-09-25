/**
 * Sanity checks for the Docker setup. The image itself is built by
 * `docker compose build`; these catch the easy-to-miss mistakes in CI
 * without needing Docker.
 *
 * Ticket: P046
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yml");
const dockerignore = read(".dockerignore")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

describe("Dockerfile (P046)", () => {
  it("builds from the lockfile and ships only what runs", () => {
    expect(dockerfile).toMatch(/COPY package\.json package-lock\.json/);
    expect(dockerfile).toMatch(/RUN npm ci/);
    expect(dockerfile).toMatch(/npm prune --omit=dev/);
    // The dashboard serves public/ from ../../public relative to dist/dashboard.
    expect(dockerfile).toMatch(/COPY public \.\/public/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/dist \.\/dist/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["node", "\/app\/dist\/cli\.js"\]/);
  });

  it("installs Chromium with the project's own playwright version", () => {
    expect(dockerfile).toMatch(/node_modules\/playwright\/cli\.js install --with-deps chromium/);
  });

  it("runs as a non-root user and keeps data in /data", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^WORKDIR \/data$/m);
    for (const setting of [
      "OUTPUT_DIR=/data/screenshots",
      "DIFF_DIR=/data/diffs",
      "DATABASE_URL=sqlite:/data/pixelguard.db",
      "DASHBOARD_HOST=0.0.0.0",
    ]) {
      expect(dockerfile).toContain(setting);
    }
  });

  it("health-checks the dashboard's /api/health", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*\/api\/health/);
  });

  it("uses a Node version the project supports", () => {
    const node = /ARG NODE_VERSION=(\d+)/.exec(dockerfile)?.[1];
    expect(Number(node)).toBeGreaterThanOrEqual(20);
  });
});

describe(".dockerignore (P046)", () => {
  it.each([".env", "node_modules", ".git", "*.db", "screenshots", "diffs", "pixelguard-data"])(
    "keeps %s out of the image",
    (entry) => {
      expect(dockerignore).toContain(entry);
    }
  );

  it("still sends everything the build needs", () => {
    for (const needed of ["src", "public", "package.json", "package-lock.json", "tsconfig.json"]) {
      expect(dockerignore).not.toContain(needed);
    }
  });
});

describe("docker-compose.yml (P046)", () => {
  it("publishes the dashboard on this computer only by default", () => {
    expect(compose).toMatch(/- "127\.0\.0\.1:8100:8100"/);
  });

  it("makes the dashboard listen on all interfaces inside the container", () => {
    // Overrides DASHBOARD_HOST=127.0.0.1 from a local .env, which would
    // make the dashboard unreachable through the port mapping.
    const dashboard = compose.slice(compose.indexOf("  dashboard:"));
    expect(dashboard).toMatch(/DASHBOARD_HOST: 0\.0\.0\.0/);
  });

  it("keeps data in the shared ./pixelguard-data folder", () => {
    expect(compose).toMatch(/- \.\/pixelguard-data:\/data/);
    expect(compose).toMatch(/DATABASE_URL: sqlite:\/data\/pixelguard\.db/);
    // The folder is committed so it exists with the user's permissions.
    expect(existsSync(resolve(root, "pixelguard-data/.gitkeep"))).toBe(true);
  });

  it("gives Chromium enough shared memory and a way to reach the host", () => {
    expect(compose).toMatch(/shm_size: "1gb"/);
    expect(compose).toMatch(/host\.docker\.internal:host-gateway/);
  });

  it("has a CLI service for one-off commands", () => {
    expect(compose).toMatch(/  pixelguard:\n[\s\S]*profiles: \["cli"\]/);
  });
});
