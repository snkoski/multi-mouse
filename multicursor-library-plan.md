# MultiCursor Library — Technical Plan

## Overview

A lightweight, drop-in npm library that adds real-time multi-user cursor visibility to any web project. Users visiting the same page can see each other's cursors live. The library ships with a bundled dev server for local development and is designed to point at a self-hosted production server for deployment.

---

## Goals

- Single `npm install` to add the feature to any project
- Zero configuration required to get running in development
- Minimal footprint — no heavy dependencies
- Works with vanilla JS, React, Vue, or any other frontend framework
- A single hosted WebSocket server can serve multiple projects

---

## Package Structure

```
multicursor/
├── packages/
│   ├── client/          # Browser-side library
│   └── server/          # WebSocket server (also used as the bundled dev server)
├── README.md
└── package.json         # Monorepo root
```

Using a monorepo (with npm workspaces or pnpm) keeps the client and server in sync while allowing them to be published as separate npm packages if desired.

---

## Package 1: Client Library (`@multicursor/client`)

### Responsibilities

- Opens and maintains a WebSocket connection to the server
- Listens for `mousemove` events and sends throttled cursor position updates
- Pauses cursor broadcasting when the tab is backgrounded (Visibility API)
- Renders other users' cursors as absolutely positioned DOM elements with `pointer-events: none`
- Fades and hides idle remote cursors when no updates have been received for that user
- Batches incoming position updates through `requestAnimationFrame` to avoid layout thrashing
- Handles user connect/disconnect gracefully (removes stale cursors)
- Normalizes cursor coordinates to percentages so different screen sizes work correctly
- Has zero runtime dependencies

### Key API

```js
import { initCursors } from '@multicursor/client'

const destroyCursors = initCursors({
  serverUrl: process.env.CURSOR_SERVER_URL || 'ws://localhost:3001',
  room: 'my-project',       // Namespace so multiple projects share one server
  throttleMs: 40,           // ~25 updates/sec (optional, default 40)
  cursorColor: '#e74c3c',   // Optional, otherwise auto-assigned
})

// Later, when navigating away or unmounting:
destroyCursors()
```

`initCursors` returns a cleanup function that closes the WebSocket connection, removes the `mousemove` event listener from the window, and removes all injected cursor `<div>`s from the DOM. This is critical for SPA frameworks like React or Vue — without calling this on unmount, cursor elements and the open socket will persist in the background causing memory leaks. The pattern mirrors React's `useEffect` cleanup, so it will feel familiar to most developers.

### Auto-Reconnection

The native browser `WebSocket` API does not reconnect automatically when a connection drops (e.g. the user switches Wi-Fi networks or the server restarts). The client library must implement reconnection internally using exponential backoff — retrying immediately, then after 2 seconds, 4 seconds, 8 seconds, and so on up to a sensible maximum (e.g. 30 seconds). This should be invisible to the consuming code; the library handles it internally without the developer needing to think about it.

```js
let attempt = 0

function connect() {
  const socket = new WebSocket(serverUrl)

  socket.onclose = () => {
    if (destroyed) return // don't reconnect after deliberate teardown
    const delay = Math.min(1000 * 2 ** attempt, 30000)
    attempt++
    setTimeout(() => connect(), delay)
  }

  socket.onerror = (err) => {
    console.warn('MultiCursor: WebSocket error', err)
    // onclose will fire after onerror, so reconnection is handled there
  }

  socket.onopen = () => {
    attempt = 0
  }

  socket.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      console.warn('MultiCursor: received malformed message, ignoring')
      return
    }
    handleMessage(msg)
  }
}
```

`attempt` must live in the outer scope — if it were a function parameter, `attempt = 0` inside `onopen` would only reassign a local copy, meaning the backoff counter would never actually reset after a successful reconnection. `onerror` should be handled explicitly even though it always precedes `onclose` — leaving it unhandled causes an unhandled error event in some environments. JSON.parse is wrapped in a try/catch so a malformed server message cannot crash the entire client.

### Cursor Rendering

Each remote cursor is a small absolutely positioned `<div>` injected into the page body containing an SVG arrow and optionally a name label. A few CSS properties are essential:

- `pointer-events: none` — **critical**. Without this, the injected cursor divs silently intercept clicks and hovers on the host page. Users would click things that appear clickable and nothing would happen.
- `will-change: transform` — hints to the browser to promote cursor elements to their own compositing layer, avoiding full repaints on every position update.
- `transition: transform 60ms ease-out` — smooths movement between updates and absorbs network jitter. `ease-out` is preferred over `linear` because real cursor movement naturally decelerates, making it feel more lifelike.

Position is updated by setting `transform: translate(x, y)`. Incoming position updates should be batched through a `requestAnimationFrame` loop rather than applied immediately on message receipt — if multiple updates arrive in the same frame, applying them all at once avoids redundant layout work.

### Idle Cursor Fading

If a remote user stops moving their mouse but remains connected, their cursor sits frozen on everyone else's screen indefinitely until the 15-second heartbeat catches a full disconnect. To improve this, the client tracks the last update time per remote cursor element and fades idle cursors out over time. This is cheap to implement and meaningfully improves the experience.

```js
const IDLE_FADE_MS = 10000   // start fading after 10s of no movement
const IDLE_HIDE_MS = 30000   // fully hide after 30s

setInterval(() => {
  const now = Date.now()
  for (const [userId, cursor] of remoteCursors) {
    const age = now - cursor.lastUpdateAt
    if (age > IDLE_HIDE_MS) {
      cursor.element.style.opacity = '0'
    } else if (age > IDLE_FADE_MS) {
      cursor.element.style.opacity = String(1 - (age - IDLE_FADE_MS) / (IDLE_HIDE_MS - IDLE_FADE_MS))
    } else {
      cursor.element.style.opacity = '1'
    }
  }
}, 2000)
```

Note: this is the correct use of `requestAnimationFrame` in this library. We deliberately avoid rAF for *outgoing* throttling (a `Date.now()` check is more appropriate there), but for *incoming* DOM updates, rAF is exactly the right tool.

### Coordinate Normalization

Outgoing: `{ x: e.pageX / document.documentElement.scrollWidth, y: e.pageY / document.documentElement.scrollHeight }`

Incoming: multiply back by the receiver's `scrollWidth` / `scrollHeight` to get pixel position.

Guard against `scrollWidth` or `scrollHeight` being zero or unexpectedly small — this can happen if `initCursors` is called before the page has fully rendered. A simple check before normalizing prevents division-by-zero or wildly out-of-range values.

**Note:** `pageX/pageY` accounts for scroll position, ensuring cursors stay anchored to page content rather than the viewport. Using `clientX/clientY` would cause cursors to appear at the wrong position for users scrolled to different parts of the page. Be aware that normalizing by percentage can cause minor cursor position distortion between very different screen aspect ratios (e.g. wide desktop vs. tall mobile) — acceptable for V1 but worth revisiting if users report misalignment on responsive layouts.

**V1 Known Limitation:** Dividing by `scrollWidth/scrollHeight` at send time assumes both users have the same document dimensions. On pages with lazy-loaded content, expanding accordions, or async-rendered sections, these dimensions can differ between users and change over time, causing cursor positions to drift. A more robust future approach would be to send absolute pixel coordinates plus the sender's document dimensions, letting the receiver decide how to map them.

**V1 Known Limitation:** Touch devices do not fire `mousemove` events, so cursors will not be sent or visible on mobile. `touchmove` listeners would be needed to support touch devices. This is explicitly out of scope for V1.

### Throttling and Visibility

Use a simple timestamp check (`Date.now() - lastSent >= throttleMs`) on each `mousemove` event to cap outgoing messages at the configured rate. Do not use `setInterval` — tie the check to mouse events so no messages are sent when the cursor is still.

When the user's tab is backgrounded, stop sending cursor updates entirely using the Visibility API. There is no point broadcasting cursor positions that no one can act on, and it eliminates unnecessary server load from idle background tabs. Importantly, "pausing" means setting a flag that the outgoing throttle check reads — the WebSocket connection itself stays open. This ensures the client continues to receive other users' cursor updates while backgrounded, and can resume broadcasting immediately when the tab comes back into focus without needing to reconnect.

```js
let paused = false

document.addEventListener('visibilitychange', () => {
  paused = document.hidden
})

// In the mousemove handler:
if (paused) return
```

---

## Package 2: Server (`@multicursor/server`)

### Responsibilities

- Accepts WebSocket connections from clients from allowed origins
- Enforces per-socket message rate limits and disconnects abusive clients
- Maintains a registry of connected users per room
- Broadcasts cursor position updates to all other users in the same room
- Assigns each new user a unique ID and a color from a preset palette
- Detects disconnections and broadcasts a "user left" event via a centralized `close` handler
- Implements a heartbeat mechanism to detect ghost connections
- Handles SIGTERM/SIGINT gracefully for clean deployments
- Exposes a simple CLI entrypoint for use as a dev server

### Origin Validation

WebSockets are not subject to standard browser CORS rules, meaning any website could connect to your server and consume bandwidth. To prevent this, use the `verifyClient` option when setting up the `ws` server — this intercepts the HTTP upgrade request and can reject it before the WebSocket connection is established.

```js
const ALLOWED_ORIGINS = ['https://your-site.com', 'http://localhost:5173']

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => {
    return ALLOWED_ORIGINS.includes(origin)
  }
})
```

Note: `handleProtocols` is the wrong hook for this — it is intended for subprotocol negotiation and returning `false` there does not reliably reject the connection. Always use `verifyClient` for origin validation.

The allowlist can be configured via environment variable so adding a new project to the server requires no code changes.

### Rate Limiting

Since throttling is enforced client-side only, a malicious or buggy client can send cursor-move messages far faster than the 40ms throttle. The server must enforce its own per-socket rate limit. A simple rolling message counter — tracking how many messages have arrived in the last second per socket — is sufficient. Clients that exceed the limit should be disconnected immediately.

```js
const RATE_LIMIT = 60 // max messages per second per socket

wss.on('connection', (socket) => {
  let messageCount = 0
  const resetInterval = setInterval(() => { messageCount = 0 }, 1000)

  socket.on('message', (data) => {
    if (++messageCount > RATE_LIMIT) {
      socket.terminate() // triggers 'close', which handles clearInterval
      return
    }
    handleMessage(socket, data)
  })

  socket.on('close', () => {
    clearInterval(resetInterval) // always runs — covers both clean disconnect and rate-abuse termination
    removeUserFromRoom(socket)
    broadcastUserLeft(socket)
  })
})
```

`clearInterval` belongs exclusively in the `close` handler. If it were called inline in the rate-limit branch, it would still fire again from `close` (since `terminate()` triggers `close`) — and if a user disconnects cleanly without ever hitting the rate limit, the interval would keep ticking until garbage collection caught up. Centralizing cleanup in `close` covers every disconnect path without duplication.
```

### Room Access Control

**V1 Known Gap:** Currently any client that knows a room name can join it. For personal projects this is likely acceptable, but it is worth acknowledging. A simple mitigation for the future would be to require a shared secret or signed token passed as a query parameter during the WebSocket handshake, validated in `verifyClient` alongside the origin check.

### Graceful Shutdown

Platforms like Railway, Fly.io, and Render send `SIGTERM` when cycling server processes. Without handling it, active WebSocket connections are dropped abruptly with no notice to clients, causing them to hit their reconnection logic unnecessarily. On `SIGTERM`, the server should notify all connected clients, close the WebSocket server cleanly, and clear the heartbeat interval before exiting.

```js
process.on('SIGTERM', () => {
  clearInterval(heartbeatInterval)
  wss.clients.forEach((socket) => socket.close(1001, 'Server shutting down'))
  wss.close(() => process.exit(0))
})
process.on('SIGINT', () => process.emit('SIGTERM'))
```

### Heartbeat / Ghost Connection Handling

WebSockets do not always close cleanly — if a user closes their laptop lid or loses internet, the server may never receive a `close` event, leaving a ghost cursor frozen on everyone else's screen. To handle this, the server sends a ping to each connected client on a regular interval (every 15 seconds). A 30-second interval is too long for a cursor feature — a frozen ghost cursor sitting on screen for up to half a minute is very noticeable. If no pong is received back within the interval window, the server forcefully terminates the connection.

Critically, all cleanup logic (removing the user from the room registry and broadcasting `user-left`) must live in the socket's `close` event handler — not in the terminate call. The `ws` library emits a `close` event whether a socket closes cleanly or is forcefully terminated, so routing through `close` guarantees a single unified cleanup path regardless of how the disconnect happened.

```js
const HEARTBEAT_INTERVAL = 15000

wss.on('connection', (socket) => {
  socket.isAlive = true
  socket.on('pong', () => { socket.isAlive = true })

  socket.on('close', () => {
    // All cleanup happens here, whether clean close or heartbeat termination
    removeUserFromRoom(socket)
    broadcastUserLeft(socket)
  })
})

setInterval(() => {
  wss.clients.forEach((socket) => {
    if (!socket.isAlive) return socket.terminate()
    socket.isAlive = false
    socket.ping()
  })
}, HEARTBEAT_INTERVAL)
```

### Technology

- **Node.js** with the **ws** library (lightweight, no framework overhead)

### Message Protocol

All messages are JSON. Types:

| Type | Direction | Payload |
|---|---|---|
| `cursor-move` | client → server → others | `{ x, y }` |
| `user-joined` | server → all in room | `{ userId, color }` |
| `user-left` | server → all in room | `{ userId }` |
| `init` | server → new client | `{ userId, color, existingUsers: [{ userId, color, x, y }] }` |

The `init` message includes the last known cursor position for each existing user, not just their ID and color. Without this, a late-joining user sees no cursors until each other user happens to move their mouse — a confusing experience. The server caches the last known `{ x, y, lastSeen }` per user and includes it in the `init` payload. The server updates `lastSeen` on every `cursor-move` message it receives for that user, so it always reflects the most recent activity. The receiving client should use the `lastSeen` timestamp to decide whether to render a cached position — positions older than 60 seconds should be omitted, since the user may have left their computer or the data may be significantly stale.

### Message Validation

Incoming messages from clients should be validated before being processed or broadcast. A malformed or malicious payload (oversized strings, missing fields, unexpected types) could crash the broadcast loop and affect all connected users. A lightweight schema check on every inbound message is sufficient — reject and drop anything that doesn't match the expected shape rather than letting it propagate.

### Color Assignment

Colors are assigned from a preset palette when a user joins. When the palette is exhausted (more users than palette entries), fall back to generating a color deterministically from the user's ID using a djb2 hash. Simple char-code summing is prone to collisions (e.g. "ab" and "ba" produce the same hue) — djb2 gives much better distribution across the 360° hue range.

```js
function hashColor(userId) {
  let hash = 5381
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 33) ^ userId.charCodeAt(i)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 70%, 55%)`
}
```

### Room Management

Rooms are identified by the `room` query parameter on the WebSocket URL: `ws://server?room=my-project`. The server maintains a `Map<roomId, Map<userId, socket>>` in memory. No persistence is needed since cursor state is ephemeral.

When the last user leaves a room, the room entry must be deleted from the Map. Without this cleanup, a long-running server accumulates empty room entries over time — a slow but real memory leak across many transient rooms.

The delete-on-empty check is safe in single-threaded Node.js — there is no async gap between removing a user and checking whether the room is now empty, so a simultaneous new join cannot race with the cleanup. Be careful not to introduce any `await` between these two operations if the server is ever refactored.

### CLI / Dev Server

The server package exposes a bin script so it can be used directly from `package.json`:

```json
{
  "scripts": {
    "cursors": "multicursor-server --port 3001"
  }
}
```

Running `npm run cursors` starts the WebSocket server locally. The client library defaults to `ws://localhost:3001` in development, so no extra configuration is needed.

---

## Suggested Tech Stack

| Concern | Choice | Reason |
|---|---|---|
| WebSocket server | `ws` npm package | Minimal, fast, no framework lock-in |
| Monorepo tooling | pnpm workspaces | Fast installs, simple workspace linking |
| Client bundling | tsup | Zero-config TypeScript bundler, outputs ESM + CJS |
| Language | TypeScript | Type safety across client and server, better DX |
| Dev server CLI | Node built-in `parseArgs` (util module) | Available since Node 18.3+, no extra dependency needed for simple --port parsing |

---

## Production Deployment

The server is a plain Node.js process. Deployment options:

- **Railway / Render / Fly.io** — push the server package, set a start command, done
- **VPS (DigitalOcean, Linode)** — run with `pm2` for process management
- **Docker** — straightforward containerization of the server package

Each project that uses the client library sets an environment variable pointing at the hosted server:

```
CURSOR_SERVER_URL=wss://your-cursor-server.fly.dev
```

One server instance can serve many different projects simultaneously via rooms.

---

## Scaling Considerations

A single Node.js server comfortably handles ~1,000 total concurrent connections for cursor-only traffic. Note this is a total connection count — broadcast cost scales with room size, so a single room with 1,000 users is significantly more expensive than 100 rooms with 10 users each. Beyond comfortable single-server capacity:

- Reduce broadcast frequency or scope (only send to users on the same sub-page/section)
- Add Redis pub/sub to relay messages across multiple server instances
- At very high scale, adopt a hosted service like Liveblocks or Ably instead

For personal projects, a single server will almost certainly never be a bottleneck.

---

## Build & Publish Plan

1. Set up monorepo with pnpm workspaces
2. Build and test client package locally against the dev server
3. Publish both packages to npm (or keep private with `npm link` for personal use)
4. Deploy server to a hosting provider
5. In each personal project: `npm install @multicursor/client`, call `initCursors()`, done

---

## Future Enhancements (Optional)

- Named cursors with avatar initials
- Click/tap effect broadcasts (show a ripple where others click)
- React hook wrapper (`useCursors()`) for cleaner integration in React projects
- Scroll position broadcasting so you can see where on the page others are
- Touch device support via `touchmove` listeners (explicitly out of scope for V1)
- Room access control via shared secret or signed token query parameter
- Binary message format for cursor-move events (ArrayBuffer with packed x/y/userId) to reduce payload size and eliminate JSON overhead on the hot path — only worth pursuing at meaningful scale
- Server-side batch broadcasting — buffer incoming moves and flush per room on a fixed interval to reduce WebSocket write volume at high room occupancy