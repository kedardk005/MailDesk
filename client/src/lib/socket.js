import { io } from 'socket.io-client'
import { SOCKET_URL } from './config'
import { getToken } from './auth'

/**
 * Single shared Socket.io connection.
 *
 * Previously NotificationBell opened its own connection with a hard-coded
 * `http://localhost:5015` and no `connect_error` handler, so a rejected
 * handshake retried silently forever.
 *
 * The server's handshake middleware rejects a token whose `tokenVersion` no
 * longer matches the user record — that rejection is the app's session-
 * invalidation signal (see AUTH_ERROR_PATTERN below).
 */

let socket = null
let currentToken = null

export const AUTH_ERROR_PATTERN = /authentication|token|jwt|unauthor/i

/** @returns {import('socket.io-client').Socket|null} */
export function getSocket() {
  const token = getToken()
  if (!token) return null

  // Token changed (re-login, password change bumping tokenVersion) -> reconnect
  // with the new credentials rather than retrying with a dead one.
  if (socket && currentToken !== token) {
    closeSocket()
  }

  if (!socket) {
    currentToken = token
    socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 10000,
    })
  }

  return socket
}

/** Force a fresh handshake with the current token (call after tokenVersion changes). */
export function reconnectSocket() {
  closeSocket()
  return getSocket()
}

export function closeSocket() {
  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }
  currentToken = null
}

/** True when a `connect_error` means the session is no longer valid. */
export function isAuthHandshakeError(error) {
  return AUTH_ERROR_PATTERN.test(error?.message || '')
}

export default getSocket
