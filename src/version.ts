/**
 * pixelguard's version, read from package.json so it's defined in one place.
 * Works from src/ (tsx) and dist/ (built): both are one level below the root.
 *
 * Ticket: P050
 */

import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const PIXELGUARD_VERSION: string = pkg.version;
