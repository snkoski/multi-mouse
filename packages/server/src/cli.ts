#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startServer } from "./index.js";

const parsed = parseArgs({
  options: {
    port: {
      type: "string",
      short: "p"
    },
    origins: {
      type: "string"
    }
  }
});

const portValue = parsed.values.port ? Number(parsed.values.port) : undefined;
const port = Number.isFinite(portValue) ? portValue : undefined;
const allowedOrigins = parsed.values.origins
  ?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);

startServer({
  port,
  allowedOrigins
});

const effectivePort = port ?? 3001;
const displayOrigins =
  allowedOrigins && allowedOrigins.length > 0
    ? allowedOrigins.join(", ")
    : process.env.ALLOWED_ORIGINS || "*";

process.stdout.write(
  `multicursor-server listening on :${effectivePort} (allowed origins: ${displayOrigins})\n`
);
