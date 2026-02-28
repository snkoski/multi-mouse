import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const DEFAULT_PORT = 3001;
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RATE_LIMIT_PER_SECOND = 60;
const COLOR_PALETTE = [
  "#e74c3c",
  "#3498db",
  "#2ecc71",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
  "#e67e22",
  "#e84393",
  "#16a085",
  "#2d98da"
] as const;

type ClientMessage = { type: "cursor-move"; x: number; y: number };

type ServerMessage =
  | { type: "user-joined"; userId: string; color: string }
  | { type: "user-left"; userId: string }
  | {
      type: "init";
      userId: string;
      color: string;
      existingUsers: Array<{
        userId: string;
        color: string;
        x?: number;
        y?: number;
        lastSeen?: number;
      }>;
    }
  | { type: "cursor-move"; userId: string; x: number; y: number };

type CursorSocket = WebSocket & {
  isAlive?: boolean;
  userId?: string;
  roomId?: string;
  color?: string;
  messageCount?: number;
  resetInterval?: NodeJS.Timeout;
};

type UserState = {
  userId: string;
  color: string;
  socket: CursorSocket;
  x?: number;
  y?: number;
  lastSeen?: number;
};

type RoomRegistry = Map<string, Map<string, UserState>>;

type StartServerOptions = {
  port?: number;
  allowedOrigins?: string[];
  rateLimitPerSecond?: number;
};

function parseAllowedOrigins(input: string | undefined) {
  if (!input) {
    return [];
  }
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function hashColor(userId: string) {
  let hash = 5381;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 33) ^ userId.charCodeAt(i);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function assignColor(roomUsers: Map<string, UserState>, userId: string, preferredColor?: string) {
  if (preferredColor) {
    return preferredColor;
  }
  const usedColors = new Set<string>();
  for (const user of roomUsers.values()) {
    usedColors.add(user.color);
  }
  for (const color of COLOR_PALETTE) {
    if (!usedColors.has(color)) {
      return color;
    }
  }
  return hashColor(userId);
}

function sendJson(socket: CursorSocket, message: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function isValidCursorMoveMessage(payload: unknown): payload is ClientMessage {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const value = payload as Record<string, unknown>;
  if (value.type !== "cursor-move") {
    return false;
  }
  if (typeof value.x !== "number" || typeof value.y !== "number") {
    return false;
  }
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    return false;
  }
  return value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1;
}

function getRoomIdFromRequest(urlValue: string | undefined) {
  if (!urlValue) {
    return "default";
  }
  try {
    const url = new URL(urlValue, "ws://localhost");
    return url.searchParams.get("room")?.trim() || "default";
  } catch {
    return "default";
  }
}

function getPreferredColorFromRequest(urlValue: string | undefined) {
  if (!urlValue) {
    return undefined;
  }
  try {
    const url = new URL(urlValue, "ws://localhost");
    const color = url.searchParams.get("color")?.trim();
    return color || undefined;
  } catch {
    return undefined;
  }
}

export function startServer(options: StartServerOptions = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const rateLimitPerSecond = options.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("multicursor-server\n");
  });

  const rooms: RoomRegistry = new Map();
  let heartbeatInterval: NodeJS.Timeout;

  const wss = new WebSocketServer({
    server,
    verifyClient: ({ origin }) => {
      if (allowedOrigins.length === 0) {
        return true;
      }
      if (!origin) {
        return false;
      }
      return allowedOrigins.includes(origin);
    }
  });

  const broadcastToRoom = (roomId: string, message: ServerMessage, exceptUserId?: string) => {
    const users = rooms.get(roomId);
    if (!users) {
      return;
    }
    for (const user of users.values()) {
      if (exceptUserId && user.userId === exceptUserId) {
        continue;
      }
      sendJson(user.socket, message);
    }
  };

  wss.on("connection", (socket, req) => {
    const ws = socket as CursorSocket;
    const roomId = getRoomIdFromRequest(req.url);
    const preferredColor = getPreferredColorFromRequest(req.url);
    const roomUsers = rooms.get(roomId) ?? new Map<string, UserState>();
    rooms.set(roomId, roomUsers);

    const existingUsers = Array.from(roomUsers.values()).map((user) => ({
      userId: user.userId,
      color: user.color,
      x: user.x,
      y: user.y,
      lastSeen: user.lastSeen
    }));

    const userId = randomUUID();
    const color = assignColor(roomUsers, userId, preferredColor);
    ws.userId = userId;
    ws.roomId = roomId;
    ws.color = color;
    ws.isAlive = true;
    ws.messageCount = 0;
    ws.resetInterval = setInterval(() => {
      ws.messageCount = 0;
    }, 1_000);

    roomUsers.set(userId, { userId, color, socket: ws });

    sendJson(ws, { type: "init", userId, color, existingUsers });
    broadcastToRoom(roomId, { type: "user-joined", userId, color }, userId);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw: RawData) => {
      ws.messageCount = (ws.messageCount ?? 0) + 1;
      if ((ws.messageCount ?? 0) > rateLimitPerSecond) {
        ws.terminate();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isValidCursorMoveMessage(parsed)) {
        return;
      }

      const room = ws.roomId ? rooms.get(ws.roomId) : undefined;
      if (!room || !ws.userId) {
        return;
      }
      const user = room.get(ws.userId);
      if (!user) {
        return;
      }

      user.x = parsed.x;
      user.y = parsed.y;
      user.lastSeen = Date.now();

      broadcastToRoom(
        ws.roomId,
        { type: "cursor-move", userId: ws.userId, x: parsed.x, y: parsed.y },
        ws.userId
      );
    });

    ws.on("close", () => {
      if (ws.resetInterval) {
        clearInterval(ws.resetInterval);
      }
      const userRoomId = ws.roomId;
      const userIdToRemove = ws.userId;
      if (!userRoomId || !userIdToRemove) {
        return;
      }
      const room = rooms.get(userRoomId);
      if (!room) {
        return;
      }
      room.delete(userIdToRemove);
      broadcastToRoom(userRoomId, { type: "user-left", userId: userIdToRemove });
      if (room.size === 0) {
        rooms.delete(userRoomId);
      }
    });
  });

  heartbeatInterval = setInterval(() => {
    for (const socket of wss.clients) {
      const ws = socket as CursorSocket;
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(heartbeatInterval);
    for (const socket of wss.clients) {
      socket.close(1001, "Server shutting down");
    }
    wss.close(() => {
      server.close(() => process.exit(0));
    });
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", () => process.emit("SIGTERM"));

  server.listen(port);

  return {
    server,
    wss,
    rooms
  };
}
