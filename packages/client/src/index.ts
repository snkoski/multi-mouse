type InitCursorsOptions = {
  serverUrl?: string;
  room: string;
  throttleMs?: number;
  cursorColor?: string;
};

type ServerToClientMessage =
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
  | { type: "user-joined"; userId: string; color: string }
  | { type: "user-left"; userId: string }
  | { type: "cursor-move"; userId: string; x: number; y: number };

type CursorMoveMessage = {
  type: "cursor-move";
  x: number;
  y: number;
};

type RemoteCursor = {
  element: HTMLDivElement;
  lastUpdateAt: number;
  pendingPx?: number;
  pendingPy?: number;
  hasPendingMove: boolean;
};

const DEFAULT_SERVER_URL = "ws://localhost:3001";
const DEFAULT_THROTTLE_MS = 40;
const MAX_RECONNECT_DELAY_MS = 30_000;
const IDLE_FADE_MS = 10_000;
const IDLE_HIDE_MS = 30_000;
const STALE_EXISTING_USER_MS = 60_000;

function safeDocumentSize() {
  const doc = document.documentElement;
  const width = Math.max(doc.scrollWidth, 1);
  const height = Math.max(doc.scrollHeight, 1);
  return { width, height };
}

function createCursorElement(color: string) {
  const element = document.createElement("div");
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = "0";
  element.style.pointerEvents = "none";
  element.style.willChange = "transform";
  element.style.transition = "transform 60ms ease-out, opacity 200ms linear";
  element.style.zIndex = "2147483647";
  element.style.opacity = "1";
  element.innerHTML = `
    <svg width="16" height="24" viewBox="0 0 16 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 2L13.5 12L8 12.3L10.8 21.3L8 22L5.2 13L2 2Z" fill="${color}" stroke="rgba(0,0,0,0.18)" />
    </svg>
  `;
  document.body.appendChild(element);
  return element;
}

function normalizePagePosition(pageX: number, pageY: number) {
  const { width, height } = safeDocumentSize();
  const x = pageX / width;
  const y = pageY / height;
  return {
    x: Math.min(Math.max(x, 0), 1),
    y: Math.min(Math.max(y, 0), 1)
  };
}

function denormalizePagePosition(x: number, y: number) {
  const { width, height } = safeDocumentSize();
  return {
    px: Math.round(x * width),
    py: Math.round(y * height)
  };
}

export function initCursors(options: InitCursorsOptions) {
  const serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL;
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const room = options.room;
  const preferredColor = options.cursorColor;

  if (!room) {
    throw new Error("MultiCursor: room is required");
  }

  const remoteCursors = new Map<string, RemoteCursor>();
  let socket: WebSocket | null = null;
  let selfUserId: string | null = null;
  let destroyed = false;
  let paused = document.hidden;
  let reconnectAttempt = 0;
  let reconnectTimeout: number | null = null;
  let lastSentAt = 0;
  let animationFrameId: number | null = null;

  const idleInterval = window.setInterval(() => {
    const now = Date.now();
    for (const cursor of remoteCursors.values()) {
      const age = now - cursor.lastUpdateAt;
      if (age > IDLE_HIDE_MS) {
        cursor.element.style.opacity = "0";
      } else if (age > IDLE_FADE_MS) {
        const progress = (age - IDLE_FADE_MS) / (IDLE_HIDE_MS - IDLE_FADE_MS);
        cursor.element.style.opacity = String(1 - progress);
      } else {
        cursor.element.style.opacity = "1";
      }
    }
  }, 2_000);

  const flushCursorMoves = () => {
    animationFrameId = null;
    for (const cursor of remoteCursors.values()) {
      if (!cursor.hasPendingMove || cursor.pendingPx == null || cursor.pendingPy == null) {
        continue;
      }
      cursor.hasPendingMove = false;
      cursor.element.style.transform = `translate(${cursor.pendingPx}px, ${cursor.pendingPy}px)`;
    }
  };

  const scheduleCursorFlush = () => {
    if (animationFrameId != null) {
      return;
    }
    animationFrameId = window.requestAnimationFrame(flushCursorMoves);
  };

  const getOrCreateRemoteCursor = (userId: string, color: string) => {
    let cursor = remoteCursors.get(userId);
    if (!cursor) {
      cursor = {
        element: createCursorElement(color),
        lastUpdateAt: Date.now(),
        hasPendingMove: false
      };
      remoteCursors.set(userId, cursor);
    }
    return cursor;
  };

  const removeRemoteCursor = (userId: string) => {
    const cursor = remoteCursors.get(userId);
    if (!cursor) {
      return;
    }
    cursor.element.remove();
    remoteCursors.delete(userId);
  };

  const sendCursorPosition = (message: CursorMoveMessage) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(message));
  };

  const onMouseMove = (event: MouseEvent) => {
    if (destroyed || paused) {
      return;
    }
    const now = Date.now();
    if (now - lastSentAt < throttleMs) {
      return;
    }
    lastSentAt = now;
    const normalized = normalizePagePosition(event.pageX, event.pageY);
    sendCursorPosition({ type: "cursor-move", x: normalized.x, y: normalized.y });
  };

  const onVisibilityChange = () => {
    paused = document.hidden;
  };

  const buildWebSocketUrl = () => {
    const url = new URL(serverUrl);
    url.searchParams.set("room", room);
    if (preferredColor) {
      url.searchParams.set("color", preferredColor);
    }
    return url.toString();
  };

  const connect = () => {
    if (destroyed) {
      return;
    }

    socket = new WebSocket(buildWebSocketUrl());

    socket.onopen = () => {
      reconnectAttempt = 0;
    };

    socket.onerror = (error) => {
      console.warn("MultiCursor: WebSocket error", error);
    };

    socket.onclose = () => {
      if (destroyed) {
        return;
      }
      const delay =
        reconnectAttempt === 0
          ? 0
          : Math.min(2_000 * 2 ** (reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);
      reconnectAttempt += 1;
      reconnectTimeout = window.setTimeout(() => connect(), delay);
    };

    socket.onmessage = (event) => {
      let message: ServerToClientMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerToClientMessage;
      } catch {
        console.warn("MultiCursor: received malformed message, ignoring");
        return;
      }

      if (message.type === "init") {
        selfUserId = message.userId;
        for (const user of message.existingUsers) {
          if (user.userId === selfUserId) {
            continue;
          }
          const cursor = getOrCreateRemoteCursor(user.userId, user.color);
          const hasFreshPosition =
            typeof user.x === "number" &&
            typeof user.y === "number" &&
            typeof user.lastSeen === "number" &&
            Date.now() - user.lastSeen <= STALE_EXISTING_USER_MS;
          if (!hasFreshPosition) {
            cursor.element.style.opacity = "0";
            continue;
          }
          const denormalized = denormalizePagePosition(user.x!, user.y!);
          cursor.pendingPx = denormalized.px;
          cursor.pendingPy = denormalized.py;
          cursor.lastUpdateAt = Date.now();
          cursor.hasPendingMove = true;
          cursor.element.style.opacity = "1";
        }
        scheduleCursorFlush();
        return;
      }

      if (message.type === "user-joined") {
        if (message.userId === selfUserId) {
          return;
        }
        getOrCreateRemoteCursor(message.userId, message.color);
        return;
      }

      if (message.type === "user-left") {
        removeRemoteCursor(message.userId);
        return;
      }

      if (message.type === "cursor-move") {
        if (message.userId === selfUserId) {
          return;
        }
        const cursor = remoteCursors.get(message.userId);
        if (!cursor) {
          return;
        }
        const { px, py } = denormalizePagePosition(message.x, message.y);
        cursor.pendingPx = px;
        cursor.pendingPy = py;
        cursor.lastUpdateAt = Date.now();
        cursor.hasPendingMove = true;
        cursor.element.style.opacity = "1";
        scheduleCursorFlush();
      }
    };
  };

  window.addEventListener("mousemove", onMouseMove, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  connect();

  return () => {
    destroyed = true;
    if (reconnectTimeout != null) {
      window.clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (animationFrameId != null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    window.clearInterval(idleInterval);
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (socket) {
      socket.close(1000, "Client teardown");
      socket = null;
    }
    for (const [userId, cursor] of remoteCursors) {
      cursor.element.remove();
      remoteCursors.delete(userId);
    }
  };
}
