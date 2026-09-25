/**
 * Serves the demo shop on its own, for showing it in a browser or pointing
 * your own .env at it:
 *
 *   npm run demo:site                 # http://localhost:3000, version 1
 *   npm run demo:site -- --version 2 --port 3001
 *
 * Add ?version=1 or ?version=2 to any page to see that version.
 *
 * Ticket: P049
 */

import { startDemoSite, type DemoVersion } from "../examples/demo-site/site.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const version = Number(arg("--version", "1"));
const port = Number(arg("--port", "3000"));
if (version !== 1 && version !== 2) {
  console.error("--version must be 1 or 2.");
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("--port must be a number from 1 to 65535.");
  process.exit(2);
}

try {
  const site = await startDemoSite({ version: version as DemoVersion, port });
  const url = site.url.replace("127.0.0.1", "localhost");
  console.log(`Demo shop (version ${version}) at ${url}`);
  console.log(`  Before/after: ${url}/pricing?version=1  and  ${url}/pricing?version=2`);
  console.log(`  To test it yourself: TARGET_BASE_URL=${url} TARGET_PAGES=/,/pricing,/blog`);
  console.log("Press Ctrl+C to stop.");
  const stop = () => void site.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  console.error(
    e.code === "EADDRINUSE"
      ? `Port ${port} is already in use. Try: npm run demo:site -- --port 3001`
      : e.message
  );
  process.exit(2);
}
