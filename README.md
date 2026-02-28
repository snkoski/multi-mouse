# MultiCursor Library

A lightweight, drop-in npm library that adds real-time multi-user cursor visibility to any web project. Users visiting the same page can see each other's cursors live.

## Features

- **Single `npm install`** — Add the feature to any project
- **Zero configuration** — Works out of the box in development
- **Minimal footprint** — No heavy dependencies
- **Framework agnostic** — Works with vanilla JS, React, Vue, or any frontend
- **One server, many projects** — A single hosted WebSocket server can serve multiple projects via rooms

## Quick Start

### 1. Install

```bash
npm install @multicursor/client
```

### 2. Start the cursor server (for local development)

In your project, add the server as a dev dependency and a script:

```json
{
  "devDependencies": {
    "@multicursor/server": "^0.1.0"
  },
  "scripts": {
    "cursors": "multicursor-server --port 3001"
  }
}
```

Then run `npm run cursors` to start the WebSocket server on `ws://localhost:3001`.

### 3. Add to your app

```js
import { initCursors } from '@multicursor/client'

const destroyCursors = initCursors({
  serverUrl: process.env.CURSOR_SERVER_URL || 'ws://localhost:3001',
  room: 'my-project',
  throttleMs: 40,
  cursorColor: '#e74c3c', // optional
})

// When navigating away or unmounting (e.g. React useEffect cleanup):
destroyCursors()
```

## Package Structure

```
multicursor/
├── packages/
│   ├── client/     # @multicursor/client — browser library
│   └── server/     # @multicursor/server — WebSocket server
├── README.md
└── package.json
```

## Production Deployment

1. Deploy the server to Railway, Render, Fly.io, or any Node.js host
2. Set `CURSOR_SERVER_URL=wss://your-server.example.com` in your app's environment
3. Configure `MULTICURSOR_ALLOWED_ORIGINS` on the server (comma-separated list of allowed origins)

## API

### `initCursors(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverUrl` | string | `ws://localhost:3001` | WebSocket server URL |
| `room` | string | required | Room/namespace (multiple projects share one server) |
| `throttleMs` | number | 40 | Throttle outgoing updates (~25/sec) |
| `cursorColor` | string | auto | Optional cursor color (otherwise server-assigned) |

Returns a cleanup function. Call it when unmounting to close the connection and remove cursor elements.

## Development

```bash
npm install
npm run build
npm run cursors   # Start WebSocket server on port 3001
```

### Demo

1. Run `npm run cursors` in one terminal
2. Serve the examples folder (e.g. `npx serve examples -p 5173`)
3. Open http://localhost:5173/demo.html in multiple tabs to see cursors

## License

MIT
