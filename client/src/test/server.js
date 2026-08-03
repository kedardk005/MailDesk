/**
 * The MSW node server shared by every test file.
 *
 * `setup.js` starts it with `onUnhandledRequest: 'error'`, so any request that
 * no handler covers fails the test rather than silently hitting the network.
 * Per-test overrides go through `server.use(...)`; `setup.js` calls
 * `server.resetHandlers()` after each test so those overrides never leak.
 */
import { setupServer } from 'msw/node'

import { handlers } from './handlers'

export const server = setupServer(...handlers)
