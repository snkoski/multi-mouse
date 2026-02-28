#!/usr/bin/env node
/**
 * CLI entrypoint for multicursor-server
 */

import { parseArgs } from "util";
import { createCursorServer } from "./index.js";

const { values } = parseArgs({
  options: {
    port: {
      type: "string",
      short: "p",
      default: "3001",
    },
  },
  allowPositionals: true,
});

const port = parseInt(values.port || "3001", 10);
if (isNaN(port) || port < 1 || port > 65535) {
  console.error("Invalid port. Use --port or -p with a number between 1 and 65535.");
  process.exit(1);
}

createCursorServer(port);
