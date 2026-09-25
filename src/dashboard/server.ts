/**
 * Starts the dashboard server (Phase 3). Run it with:
 *
 *   npm run pixelguard -- dashboard [--port 8100] [--host 127.0.0.1]
 *
 * Ticket: P035
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getDatabase } from "../report/persistence.js";
import { createApp } from "./app.js";

export interface DashboardOptions {
  databasePath: string;
  /** Root screenshots folder (Settings.outputDir). */
  outputDir: string;
  host: string;
  /** 0 picks a free port (used by tests). */
  port: number;
  /** Refuse accept/restore (P047). */
  readOnly?: boolean;
}

export interface RunningDashboard {
  url: string;
  port: number;
  /** Stops the server and closes the database. */
  close(): Promise<void>;
}

export async function startDashboard(options: DashboardOptions): Promise<RunningDashboard> {
  const db = getDatabase(options.databasePath);
  const app = createApp({ db, outputDir: options.outputDir, readOnly: options.readOnly });

  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(options.port, options.host, () => resolve(s));
      s.once("error", reject);
    });
  } catch (err) {
    db.close();
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      throw new Error(
        `Port ${options.port} is already in use. Pick another with --port or DASHBOARD_PORT.`
      );
    }
    throw new Error(
      `Could not start the dashboard on ${options.host}:${options.port}: ${e.message}`
    );
  }

  const { port } = server.address() as AddressInfo;
  const shownHost = options.host === "0.0.0.0" ? "localhost" : options.host;
  return {
    url: `http://${shownHost}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
