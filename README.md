# MultiMouse

Real-time multi-user cursor visibility for any web project. Users visiting the same page see each other's cursors live.

## Quick Start

### 1. Start the dev server

```bash
npx multi-mouse-server --port 3001
```

Or add it to your `package.json`:

```json
{
  "scripts": {
    "cursors": "multi-mouse-server --port 3001"
  }
}
```

### 2. Add the client to your page

```js
import { initCursors } from '@multi-mouse/client'

const destroy = initCursors({
  serverUrl: 'ws://localhost:3001',
  room: 'my-project',
})

// Call destroy() to clean up (e.g. on unmount in React/Vue)
```

That's it. Open the page in two browser windows and move your mouse.

## Client Options

| Option | Type | Default | Description |
|---|---|---|---|
| `serverUrl` | `string` | `'ws://localhost:3001'` | WebSocket server URL |
| `room` | `string` | `'default'` | Room namespace (multiple projects can share one server) |
| `throttleMs` | `number` | `40` | Min ms between outgoing cursor updates (~25/sec) |
| `cursorColor` | `string` | auto-assigned | Force a specific cursor color |

## Server Options

### CLI

```bash
multi-mouse-server --port 3001 --origins "https://mysite.com,http://localhost:5173"
```

| Flag | Default | Description |
|---|---|---|
| `--port`, `-p` | `3001` | Port to listen on |
| `--origins`, `-o` | allow all | Comma-separated allowed origins |

### Programmatic

```js
import { createMultiMouseServer } from '@multi-mouse/server'

const server = createMultiMouseServer({
  port: 3001,
  allowedOrigins: ['https://mysite.com'],
})

await server.start()
```

## Production

Deploy the server as a plain Node.js process (Railway, Fly.io, Render, Docker, etc.) and point clients at it:

```js
initCursors({
  serverUrl: process.env.CURSOR_SERVER_URL || 'ws://localhost:3001',
  room: 'my-project',
})
```

One server instance handles many projects simultaneously via rooms.

## How It Works

- Cursor positions are normalized to percentages so different screen sizes work
- The client throttles outgoing messages and pauses when the tab is backgrounded
- The server enforces per-socket rate limits and disconnects abusive clients
- Ghost connections are detected via a 15-second heartbeat/ping cycle
- Idle remote cursors fade out after 10 seconds and hide after 30 seconds
- The client auto-reconnects with exponential backoff on connection loss

## Development

```bash
npm install
npm run build
npm run dev:server
```

## Packages

| Package | Description |
|---|---|
| `@multi-mouse/client` | Browser-side library (zero runtime dependencies) |
| `@multi-mouse/server` | WebSocket server + CLI dev server |
