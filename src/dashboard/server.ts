/**
 * Dashboard server entry point (Phase 3).
 *
 * Ticket: P035
 */

import express from "express";
import { createApiRouter } from "./api.js";
import { loadSettings } from "../config.js";

const app = express();
app.use("/api", createApiRouter());

const settings = loadSettings();
const port = process.env.DASHBOARD_PORT ?? 8100;

app.listen(port, () => {
  console.log(`[pixelguard] Dashboard listening on port ${port}`);
});
