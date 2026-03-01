export interface CursorOptions {
  serverUrl?: string
  room?: string
  throttleMs?: number
  cursorColor?: string
  onConnect?: () => void
  onDisconnect?: (code?: number, reason?: string) => void
  onError?: (err: Event) => void
  onUserJoin?: () => void
  onUserLeave?: () => void
}

export interface RemoteCursor {
  userId: string
  color: string
  element: HTMLDivElement
  lastUpdateAt: number
  x: number
  y: number
  targetX: number
  targetY: number
}

export interface InitMessage {
  type: 'init'
  userId: string
  color: string
  existingUsers: Array<{
    userId: string
    color: string
    x: number
    y: number
    lastSeen: number
  }>
}

export interface CursorMoveMessage {
  type: 'cursor-move'
  userId: string
  x: number
  y: number
}

export interface UserJoinedMessage {
  type: 'user-joined'
  userId: string
  color: string
}

export interface UserLeftMessage {
  type: 'user-left'
  userId: string
}

export type ServerMessage = InitMessage | CursorMoveMessage | UserJoinedMessage | UserLeftMessage
