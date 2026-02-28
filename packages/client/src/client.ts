import type { CursorOptions, RemoteCursor, ServerMessage } from './types.js'
import { createCursorElement, removeCursorElement } from './cursor-element.js'

const IDLE_FADE_MS = 10_000
const IDLE_HIDE_MS = 30_000
const STALE_POSITION_MS = 60_000

export function initCursors(options: CursorOptions = {}): () => void {
  const {
    serverUrl = 'ws://localhost:3001',
    room = 'default',
    throttleMs = 40,
  } = options

  let destroyed = false
  let socket: WebSocket | null = null
  let myUserId: string | null = null
  let attempt = 0
  let paused = false
  let lastSent = 0
  let rafId: number | null = null

  const remoteCursors = new Map<string, RemoteCursor>()
  const pendingUpdates = new Map<string, { x: number; y: number }>()

  function getDocDimensions() {
    const w = document.documentElement.scrollWidth
    const h = document.documentElement.scrollHeight
    return { w: w > 0 ? w : 1, h: h > 0 ? h : 1 }
  }

  function getOrCreateCursor(userId: string, color: string): RemoteCursor {
    let cursor = remoteCursors.get(userId)
    if (!cursor) {
      const element = createCursorElement(color, userId)
      cursor = {
        userId,
        color,
        element,
        lastUpdateAt: Date.now(),
        x: 0,
        y: 0,
        targetX: 0,
        targetY: 0,
      }
      remoteCursors.set(userId, cursor)
    }
    return cursor
  }

  function removeCursor(userId: string) {
    const cursor = remoteCursors.get(userId)
    if (cursor) {
      removeCursorElement(cursor.element)
      remoteCursors.delete(userId)
    }
    pendingUpdates.delete(userId)
  }

  function removeAllCursors() {
    for (const [, cursor] of remoteCursors) {
      removeCursorElement(cursor.element)
    }
    remoteCursors.clear()
    pendingUpdates.clear()
  }

  function applyPendingUpdates() {
    rafId = null
    if (pendingUpdates.size === 0) return

    const { w, h } = getDocDimensions()

    for (const [userId, { x, y }] of pendingUpdates) {
      const cursor = remoteCursors.get(userId)
      if (!cursor) continue

      const px = x * w
      const py = y * h
      cursor.element.style.transform = `translate(${px}px, ${py}px)`
      cursor.x = px
      cursor.y = py
      cursor.lastUpdateAt = Date.now()
      cursor.element.style.opacity = '1'
    }

    pendingUpdates.clear()
  }

  function scheduleUpdate(userId: string, x: number, y: number) {
    pendingUpdates.set(userId, { x, y })
    if (rafId === null) {
      rafId = requestAnimationFrame(applyPendingUpdates)
    }
  }

  function handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'init': {
        myUserId = msg.userId
        for (const user of msg.existingUsers) {
          const age = Date.now() - user.lastSeen
          if (age > STALE_POSITION_MS) continue
          const cursor = getOrCreateCursor(user.userId, user.color)
          cursor.lastUpdateAt = Date.now() - age
          scheduleUpdate(user.userId, user.x, user.y)
        }
        break
      }
      case 'cursor-move': {
        if (msg.userId === myUserId) break
        getOrCreateCursor(msg.userId, '')
        scheduleUpdate(msg.userId, msg.x, msg.y)
        break
      }
      case 'user-joined': {
        if (msg.userId === myUserId) break
        getOrCreateCursor(msg.userId, msg.color)
        break
      }
      case 'user-left': {
        removeCursor(msg.userId)
        break
      }
    }
  }

  function connect() {
    if (destroyed) return

    const url = `${serverUrl}?room=${encodeURIComponent(room)}`
    socket = new WebSocket(url)

    socket.onopen = () => {
      attempt = 0
    }

    socket.onclose = () => {
      socket = null
      if (destroyed) return
      removeAllCursors()
      const delay = Math.min(1000 * 2 ** attempt, 30_000)
      attempt++
      setTimeout(() => connect(), delay)
    }

    socket.onerror = (err) => {
      console.warn('MultiCursor: WebSocket error', err)
    }

    socket.onmessage = (event) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(event.data as string)
      } catch {
        console.warn('MultiCursor: received malformed message, ignoring')
        return
      }
      handleMessage(msg)
    }
  }

  function onMouseMove(e: MouseEvent) {
    if (paused) return
    if (!socket || socket.readyState !== WebSocket.OPEN) return

    const now = Date.now()
    if (now - lastSent < throttleMs) return
    lastSent = now

    const { w, h } = getDocDimensions()
    const x = e.pageX / w
    const y = e.pageY / h

    socket.send(JSON.stringify({ type: 'cursor-move', x, y }))
  }

  function onVisibilityChange() {
    paused = document.hidden
  }

  const idleCheckInterval = setInterval(() => {
    const now = Date.now()
    for (const [, cursor] of remoteCursors) {
      const age = now - cursor.lastUpdateAt
      if (age > IDLE_HIDE_MS) {
        cursor.element.style.opacity = '0'
      } else if (age > IDLE_FADE_MS) {
        const progress = (age - IDLE_FADE_MS) / (IDLE_HIDE_MS - IDLE_FADE_MS)
        cursor.element.style.opacity = String(1 - progress)
      } else {
        cursor.element.style.opacity = '1'
      }
    }
  }, 2000)

  window.addEventListener('mousemove', onMouseMove)
  document.addEventListener('visibilitychange', onVisibilityChange)

  connect()

  return function destroy() {
    destroyed = true
    clearInterval(idleCheckInterval)
    window.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (rafId !== null) cancelAnimationFrame(rafId)
    removeAllCursors()
    if (socket) {
      socket.onclose = null
      socket.close()
      socket = null
    }
  }
}
