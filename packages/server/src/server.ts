import { createServer, type IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type {
  MultiCursorSocket,
  UserState,
  CursorMoveMessage,
  ServerOptions,
} from './types.js'

const CURSOR_PALETTE = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#e84393', '#00b894', '#6c5ce7',
  '#fd79a8', '#00cec9', '#fab1a0', '#74b9ff', '#a29bfe',
]

const HEARTBEAT_INTERVAL = 15_000
const RATE_LIMIT = 60

function hashColor(userId: string): string {
  let hash = 5381
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 33) ^ userId.charCodeAt(i)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 70%, 55%)`
}

function validateCursorMove(data: unknown): data is CursorMoveMessage {
  if (typeof data !== 'object' || data === null) return false
  const msg = data as Record<string, unknown>
  return (
    msg.type === 'cursor-move' &&
    typeof msg.x === 'number' &&
    typeof msg.y === 'number' &&
    isFinite(msg.x) &&
    isFinite(msg.y) &&
    msg.x >= 0 && msg.x <= 1 &&
    msg.y >= 0 && msg.y <= 1
  )
}

export function createMultiCursorServer(options: ServerOptions = {}) {
  const { port = 3001, allowedOrigins } = options

  const rooms = new Map<string, Map<string, MultiCursorSocket>>()
  const userStates = new Map<string, UserState>()
  let colorIndex = 0

  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('multicursor server ok')
  })

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ origin }: { origin?: string }) => {
      if (!allowedOrigins || allowedOrigins.length === 0) return true
      return origin != null && allowedOrigins.includes(origin)
    },
  })

  function assignColor(): string {
    if (colorIndex < CURSOR_PALETTE.length) {
      return CURSOR_PALETTE[colorIndex++]!
    }
    return hashColor(randomUUID())
  }

  function getRoom(roomId: string): Map<string, MultiCursorSocket> {
    let room = rooms.get(roomId)
    if (!room) {
      room = new Map()
      rooms.set(roomId, room)
    }
    return room
  }

  function broadcastToRoom(roomId: string, message: object, excludeUserId?: string) {
    const room = rooms.get(roomId)
    if (!room) return
    const payload = JSON.stringify(message)
    for (const [uid, sock] of room) {
      if (uid === excludeUserId) continue
      if (sock.readyState === sock.OPEN) {
        sock.send(payload)
      }
    }
  }

  function removeUserFromRoom(socket: MultiCursorSocket) {
    const { roomId, userId } = socket.meta
    const room = rooms.get(roomId)
    if (!room) return

    room.delete(userId)
    userStates.delete(userId)

    if (room.size === 0) {
      rooms.delete(roomId)
    }
  }

  function broadcastUserLeft(socket: MultiCursorSocket) {
    const { roomId, userId } = socket.meta
    broadcastToRoom(roomId, { type: 'user-left', userId })
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const socket = ws as MultiCursorSocket
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const roomId = url.searchParams.get('room') || 'default'
    const userId = randomUUID()
    const color = assignColor()

    socket.meta = {
      userId,
      color,
      roomId,
      isAlive: true,
      messageCount: 0,
    }

    const room = getRoom(roomId)
    room.set(userId, socket)

    const existingUsers = Array.from(room.entries())
      .filter(([uid]) => uid !== userId)
      .map(([uid]) => {
        const state = userStates.get(uid)
        const sock = room.get(uid)!
        return {
          userId: uid,
          color: sock.meta.color,
          x: state?.x ?? 0,
          y: state?.y ?? 0,
          lastSeen: state?.lastSeen ?? Date.now(),
        }
      })

    socket.send(JSON.stringify({
      type: 'init',
      userId,
      color,
      existingUsers,
    }))

    broadcastToRoom(roomId, { type: 'user-joined', userId, color }, userId)

    const rateLimitReset = setInterval(() => {
      socket.meta.messageCount = 0
    }, 1000)

    socket.on('pong', () => {
      socket.meta.isAlive = true
    })

    socket.on('message', (raw) => {
      if (++socket.meta.messageCount > RATE_LIMIT) {
        socket.terminate()
        return
      }

      let data: unknown
      try {
        data = JSON.parse(String(raw))
      } catch {
        return
      }

      if (!validateCursorMove(data)) return

      const { x, y } = data
      const { roomId: rid, userId: uid } = socket.meta

      userStates.set(uid, {
        userId: uid,
        color: socket.meta.color,
        x,
        y,
        lastSeen: Date.now(),
      })

      broadcastToRoom(rid, { type: 'cursor-move', userId: uid, x, y }, uid)
    })

    socket.on('close', () => {
      clearInterval(rateLimitReset)
      removeUserFromRoom(socket)
      broadcastUserLeft(socket)
    })

    socket.on('error', (err) => {
      console.warn('MultiCursor: socket error', err.message)
    })
  })

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as MultiCursorSocket
      if (!socket.meta?.isAlive) {
        socket.terminate()
        return
      }
      socket.meta.isAlive = false
      socket.ping()
    })
  }, HEARTBEAT_INTERVAL)

  function shutdown() {
    console.log('MultiCursor: shutting down...')
    clearInterval(heartbeatInterval)
    wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'))
    wss.close(() => {
      httpServer.close(() => {
        process.exit(0)
      })
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  function start(): Promise<void> {
    return new Promise((resolve) => {
      httpServer.listen(port, () => {
        console.log(`MultiCursor server listening on ws://localhost:${port}`)
        resolve()
      })
    })
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      clearInterval(heartbeatInterval)
      wss.close(() => {
        httpServer.close(() => resolve())
      })
    })
  }

  return { start, close, wss, httpServer }
}
