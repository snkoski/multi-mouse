import type { WebSocket } from 'ws'

export interface UserState {
  userId: string
  color: string
  x: number
  y: number
  lastSeen: number
}

export interface SocketMeta {
  userId: string
  color: string
  roomId: string
  isAlive: boolean
  messageCount: number
}

export type MultiMouseSocket = WebSocket & { meta: SocketMeta }

export interface CursorMoveMessage {
  type: 'cursor-move'
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

export type ServerMessage = UserJoinedMessage | UserLeftMessage | InitMessage | (CursorMoveMessage & { userId: string })

export interface ServerOptions {
  port?: number
  allowedOrigins?: string[]
}
