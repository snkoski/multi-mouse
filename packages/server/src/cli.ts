import { parseArgs } from 'node:util'
import { createMultiCursorServer } from './server.js'

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '3001' },
    origins: { type: 'string', short: 'o' },
  },
  strict: false,
})

const port = parseInt(values.port as string, 10)
const allowedOrigins = values.origins
  ? (values.origins as string).split(',').map((s) => s.trim())
  : undefined

const server = createMultiCursorServer({ port, allowedOrigins })
server.start()
