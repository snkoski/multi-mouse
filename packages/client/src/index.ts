/**
 * @multicursor/client — Real-time multi-user cursor visibility
 */

const IDLE_FADE_MS = 10_000; // start fading after 10s of no movement
const IDLE_HIDE_MS = 30_000; // fully hide after 30s
const STALE_POSITION_MS = 60_000; // omit positions older than 60s in init
const IDLE_CHECK_INTERVAL_MS = 2_000;

export interface InitCursorsOptions {
  /** WebSocket server URL (default: ws://localhost:3001) */
  serverUrl?: string;
  /** Room/namespace so multiple projects share one server */
  room: string;
  /** Throttle outgoing updates in ms (~25/sec at 40ms, default: 40) */
  throttleMs?: number;
  /** Optional cursor color, otherwise auto-assigned by server */
  cursorColor?: string;
}

interface RemoteCursor {
  element: HTMLDivElement;
  lastUpdateAt: number;
  x: number;
  y: number;
}

interface CursorMoveMessage {
  type: "cursor-move";
  userId: string; // added by server when broadcasting
  x: number;
  y: number;
}

interface UserJoinedMessage {
  type: "user-joined";
  userId: string;
  color: string;
}

interface UserLeftMessage {
  type: "user-left";
  userId: string;
}

interface InitMessage {
  type: "init";
  userId: string;
  color: string;
  existingUsers: Array<{ userId: string; color: string; x?: number; y?: number; lastSeen?: number }>;
}

type ServerMessage = CursorMoveMessage | UserJoinedMessage | UserLeftMessage | InitMessage;

function createCursorElement(userId: string, color: string): HTMLDivElement {
  const div = document.createElement("div");
  div.setAttribute("data-multicursor", userId);
  div.style.cssText = `
    position: absolute;
    left: 0;
    top: 0;
    width: 20px;
    height: 20px;
    pointer-events: none;
    will-change: transform;
    transition: transform 60ms ease-out;
    z-index: 2147483647;
  `;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.style.fill = color;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.86a.5.5 0 0 0-.85.35Z"
  );
  svg.appendChild(path);
  div.appendChild(svg);

  return div;
}

function getWebSocketUrl(serverUrl: string, room: string): string {
  const url = new URL(serverUrl);
  url.searchParams.set("room", room);
  return url.toString();
}

function safeNormalizeOutgoing(
  pageX: number,
  pageY: number
): { x: number; y: number } | null {
  const scrollWidth = document.documentElement.scrollWidth;
  const scrollHeight = document.documentElement.scrollHeight;
  if (scrollWidth < 10 || scrollHeight < 10) return null;
  return {
    x: pageX / scrollWidth,
    y: pageY / scrollHeight,
  };
}

function safeDenormalizeIncoming(
  x: number,
  y: number
): { x: number; y: number } | null {
  const scrollWidth = document.documentElement.scrollWidth;
  const scrollHeight = document.documentElement.scrollHeight;
  if (scrollWidth < 10 || scrollHeight < 10) return null;
  return {
    x: x * scrollWidth,
    y: y * scrollHeight,
  };
}

/**
 * Initialize multi-user cursor visibility. Returns a cleanup function to call on unmount.
 */
export function initCursors(options: InitCursorsOptions): () => void {
  const {
    serverUrl = typeof process !== "undefined" && process.env?.CURSOR_SERVER_URL
      ? process.env.CURSOR_SERVER_URL
      : "ws://localhost:3001",
    room,
    throttleMs = 40,
    cursorColor,
  } = options;

  let destroyed = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  const remoteCursors = new Map<string, RemoteCursor>();
  let lastSent = 0;
  let paused = false;
  let rafScheduled = false;
  const pendingUpdates = new Map<string, { x: number; y: number }>();
  let idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  const wsUrl = getWebSocketUrl(serverUrl, room);
  const cursorParams = cursorColor ? `&color=${encodeURIComponent(cursorColor)}` : "";

  function appendCursorToDOM(element: HTMLDivElement): void {
    document.body.appendChild(element);
  }

  function removeCursorFromDOM(userId: string): void {
    const cursor = remoteCursors.get(userId);
    if (cursor) {
      cursor.element.remove();
      remoteCursors.delete(userId);
    }
  }

  function applyPendingUpdates(): void {
    rafScheduled = false;
    const now = Date.now();
    for (const [userId, { x, y }] of pendingUpdates) {
      const cursor = remoteCursors.get(userId);
      if (!cursor) continue;

      const coords = safeDenormalizeIncoming(x, y);
      if (!coords) continue;

      cursor.x = coords.x;
      cursor.y = coords.y;
      cursor.lastUpdateAt = now;
      cursor.element.style.transform = `translate(${coords.x}px, ${coords.y}px)`;
    }
    pendingUpdates.clear();
  }

  function scheduleApplyUpdates(): void {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(applyPendingUpdates);
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "init": {
        for (const user of msg.existingUsers) {
          if (user.userId === msg.userId) continue;
          const age = user.lastSeen ? Date.now() - user.lastSeen : Infinity;
          if (age > STALE_POSITION_MS) continue;

          let cursor = remoteCursors.get(user.userId);
          if (!cursor) {
            cursor = {
              element: createCursorElement(user.userId, user.color),
              lastUpdateAt: user.lastSeen ?? Date.now(),
              x: 0,
              y: 0,
            };
            remoteCursors.set(user.userId, cursor);
            appendCursorToDOM(cursor.element);
          }

          if (user.x != null && user.y != null) {
            const coords = safeDenormalizeIncoming(user.x, user.y);
            if (coords) {
              cursor.x = coords.x;
              cursor.y = coords.y;
              cursor.element.style.transform = `translate(${coords.x}px, ${coords.y}px)`;
            }
          }
        }
        break;
      }
      case "user-joined": {
        if (remoteCursors.has(msg.userId)) break;
        const cursor: RemoteCursor = {
          element: createCursorElement(msg.userId, msg.color),
          lastUpdateAt: Date.now(),
          x: 0,
          y: 0,
        };
        remoteCursors.set(msg.userId, cursor);
        appendCursorToDOM(cursor.element);
        break;
      }
      case "user-left": {
        removeCursorFromDOM(msg.userId);
        break;
      }
      case "cursor-move": {
        const { userId, x, y } = msg;
        const cursor = remoteCursors.get(userId);
        if (!cursor) break;
        pendingUpdates.set(userId, { x, y });
        scheduleApplyUpdates();
        break;
      }
    }
  }

  function connect(): void {
    if (destroyed) return;
    const url = wsUrl + cursorParams;
    socket = new WebSocket(url);

    socket.onclose = () => {
      if (destroyed) return;
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      attempt++;
      setTimeout(() => connect(), delay);
    };

    socket.onerror = (err) => {
      console.warn("MultiCursor: WebSocket error", err);
    };

    socket.onopen = () => {
      attempt = 0;
    };

    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        console.warn("MultiCursor: received malformed message, ignoring");
        return;
      }
      handleMessage(msg);
    };
  }

  const handleMouseMove = (e: MouseEvent): void => {
    if (paused || destroyed || !socket || socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastSent < throttleMs) return;

    const normalized = safeNormalizeOutgoing(e.pageX, e.pageY);
    if (!normalized) return;

    lastSent = now;
    socket.send(
      JSON.stringify({
        type: "cursor-move",
        x: normalized.x,
        y: normalized.y,
      })
    );
  };

  document.addEventListener("visibilitychange", () => {
    paused = document.hidden;
  });

  document.addEventListener("mousemove", handleMouseMove);

  connect();

  idleCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [userId, cursor] of remoteCursors) {
      const age = now - cursor.lastUpdateAt;
      if (age > IDLE_HIDE_MS) {
        cursor.element.style.opacity = "0";
      } else if (age > IDLE_FADE_MS) {
        cursor.element.style.opacity = String(
          1 - (age - IDLE_FADE_MS) / (IDLE_HIDE_MS - IDLE_FADE_MS)
        );
      } else {
        cursor.element.style.opacity = "1";
      }
    }
  }, IDLE_CHECK_INTERVAL_MS);

  return function destroyCursors(): void {
    destroyed = true;
    document.removeEventListener("mousemove", handleMouseMove);
    if (idleCheckInterval) {
      clearInterval(idleCheckInterval);
      idleCheckInterval = null;
    }
    for (const [userId] of remoteCursors) {
      removeCursorFromDOM(userId);
    }
    if (socket) {
      socket.close();
      socket = null;
    }
  };
}
