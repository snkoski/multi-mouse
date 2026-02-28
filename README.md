# MultiCursor Library

A lightweight monorepo containing:

- `@multicursor/client` - browser library for rendering real-time remote cursors
- `@multicursor/server` - WebSocket server and CLI for local development or hosted use

## Development

```bash
pnpm install
pnpm build
pnpm dev:server
```

## Client Usage

```ts
import { initCursors } from "@multicursor/client";

const destroyCursors = initCursors({
  room: "my-project",
  serverUrl: "ws://localhost:3001"
});

// On unmount / teardown:
destroyCursors();
```
