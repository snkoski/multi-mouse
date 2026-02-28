/**
 * @multicursor/server — WebSocket server for real-time multi-user cursors
 */

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";

const RATE_LIMIT = 60; // max messages per second per socket
const HEARTBEAT_INTERVAL_MS = 15_000;

const DEFAULT_COLORS = [
  "#e74c3c",
  "#3498db",
  "#2ecc71",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
  "#e67e22",
  "#34495e",
];

function hashColor(userId: string): string {
  let hash = 5381;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 33) ^ userId.charCodeAt(i);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function getNextColor(colorIndex: number, userId: string): string {
  if (colorIndex < DEFAULT_COLORS.length) {
    return DEFAULT_COLORS[colorIndex];
  }
  return hashColor(userId);
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function parseAllowedOrigins(): string[] {
  const raw = process.env.MULTICURSOR_ALLOWED_ORIGINS;
  if (!raw) {
    return ["http://localhost:3000", "http://localhost:5173", "http://localhost:8080", "http://127.0.0.1:3000", "http://127.0.0.1:5173", "http://127.0.0.1:8080"];
  }
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

interface UserState {
  userId: string;
  color: string;
  x?: number;
  y?: number;
  lastSeen?: number;
}

interface ExtendedWebSocket extends WebSocket {
  isAlive?: boolean;
  userId?: string;
  roomId?: string;
  color?: string;
}

function isValidCursorMove(msg: unknown): msg is { x: number; y: number } {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.x === "number" &&
    typeof m.y === "number" &&
    m.x >= 0 &&
    m.x <= 1 &&
    m.y >= 0 &&
    m.y <= 1
  );
}

export function createCursorServer(port: number): ReturnType<typeof createServer> {
  const rooms = new Map<string, Map<string, { socket: ExtendedWebSocket; state: UserState }>>();
  let colorIndex = 0;
  const allowedOrigins = parseAllowedOrigins();

  const server = createServer();

  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin?: string; req: { url?: string; headers: Record<string, string | string[] | undefined> } }, callback: (result: boolean, code?: number, message?: string) => void) => {
      const rawOrigin = info.origin || info.req.headers.origin;
      const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
      if (!origin || !allowedOrigins.includes(origin)) {
        callback(false, 403, "Origin not allowed");
        return;
      }
      callback(true);
    },
  });

  wss.on("connection", (socket: ExtendedWebSocket, req: { url?: string }) => {
    const url = parse(req.url || "", true);
    const roomId = (url.query?.room as string) || "default";
    const clientColor = (url.query?.color as string) || undefined;

    const userId = randomId();
    const color = clientColor || getNextColor(colorIndex++, userId);

    socket.userId = userId;
    socket.roomId = roomId;
    socket.color = color;
    socket.isAlive = true;

    let messageCount = 0;
    const resetInterval = setInterval(() => {
      messageCount = 0;
    }, 1000);

    let room = rooms.get(roomId);
    if (!room) {
      room = new Map();
      rooms.set(roomId, room);
    }

    const state: UserState = { userId, color };
    room.set(userId, { socket, state });

    const broadcastToRoom = (payload: object, excludeUserId?: string) => {
      const r = rooms.get(roomId);
      if (!r) return;
      const msg = JSON.stringify(payload);
      for (const [uid, { socket: s }] of r) {
        if (uid === excludeUserId) continue;
        if (s.readyState === WebSocket.OPEN) {
          s.send(msg);
        }
      }
    };

    socket.send(
      JSON.stringify({
        type: "init",
        userId,
        color,
        existingUsers: Array.from(room.entries())
          .filter(([uid]) => uid !== userId)
          .map(([, { state: s }]) => ({
            userId: s.userId,
            color: s.color,
            x: s.x,
            y: s.y,
            lastSeen: s.lastSeen,
          })),
      })
    );

    broadcastToRoom({ type: "user-joined", userId, color }, userId);

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", (data: Buffer | Buffer[]) => {
      if (++messageCount > RATE_LIMIT) {
        socket.terminate();
        return;
      }

      let msg: unknown;
      try {
        msg = JSON.parse(Buffer.isBuffer(data) ? data.toString() : Buffer.concat(data).toString());
      } catch {
        return;
      }

      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      if (m.type !== "cursor-move") return;

      if (!isValidCursorMove({ x: m.x, y: m.y })) return;

      const x = m.x as number;
      const y = m.y as number;
      state.x = x;
      state.y = y;
      state.lastSeen = Date.now();

      broadcastToRoom({ type: "cursor-move", userId, x, y }, userId);
    });

    socket.on("close", () => {
      clearInterval(resetInterval);

      const r = rooms.get(roomId);
      if (r) {
        r.delete(userId);
        if (r.size === 0) {
          rooms.delete(roomId);
        } else {
          const msg = JSON.stringify({ type: "user-left", userId });
          for (const [, { socket: s }] of r) {
            if (s.readyState === WebSocket.OPEN) {
              s.send(msg);
            }
          }
        }
      }
    });
  });

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((s: WebSocket) => {
      const socket = s as ExtendedWebSocket;
      if (!socket.isAlive) {
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(heartbeatInterval);
    wss.clients.forEach((s: WebSocket) => {
      s.close(1001, "Server shutting down");
    });
    wss.close(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", () => process.emit("SIGTERM"));

  server.listen(port, () => {
    console.log(`MultiCursor server listening on port ${port}`);
  });

  return server;
}
