/**
 * MCP server over Streamable HTTP, JSON-RPC 2.0.
 *
 * Bound to 127.0.0.1 only: an agent on this machine can drive the editor, but the
 * port is not reachable from the network. Hand-rolled rather than SDK-based so the
 * protocol surface stays small and pinned.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { OpError } from '../../core/ops.js'
import { FFmpegError } from '../media/ffmpeg.js'
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools.js'

export const DEFAULT_MCP_PORT = 19789
const PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY_BYTES = 4 * 1024 * 1024

const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, any>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      body += chunk.toString('utf8')
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, payload: unknown, sessionId?: string): void {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  res.writeHead(status, headers)
  res.end(body)
}

/** Maps a thrown error onto a tool result the agent can act on, not a transport failure. */
function toolErrorPayload(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  let text: string
  if (error instanceof OpError) {
    text = `${error.code}: ${error.message}`
  } else if (error instanceof FFmpegError) {
    text = `ffmpeg_failed: ${error.message}\n${error.stderr.split('\n').slice(-12).join('\n')}`
  } else {
    text = `internal_error: ${(error as Error).message ?? String(error)}`
  }
  return { content: [{ type: 'text', text }], isError: true }
}

export class MCPServer {
  private server: Server | null = null
  private sessions = new Set<string>()

  constructor(
    private readonly ctx: ToolContext,
    readonly port: number = DEFAULT_MCP_PORT,
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch((error) => {
          if (!res.headersSent) {
            send(res, 500, {
              jsonrpc: '2.0',
              id: null,
              error: { code: ERROR_CODES.internal, message: (error as Error).message },
            })
          }
        })
      })
      server.on('error', reject)
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server
        resolve(this.port)
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)

    if (url.pathname === '/health') {
      return send(res, 200, { status: 'ok', tools: TOOLS.length, protocolVersion: PROTOCOL_VERSION })
    }
    if (url.pathname !== '/mcp') {
      return send(res, 404, { error: 'not found' })
    }
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id']
      if (typeof sessionId === 'string') this.sessions.delete(sessionId)
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'use POST for JSON-RPC' })
    }

    const raw = await readBody(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return send(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: ERROR_CODES.parse, message: 'request body is not valid JSON' },
      })
    }

    // A batch is answered as a batch; notifications produce no entry.
    const batch = Array.isArray(parsed)
    const requests = (batch ? parsed : [parsed]) as JsonRpcRequest[]
    const responses: JsonRpcResponse[] = []
    let newSession: string | undefined

    for (const request of requests) {
      if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        responses.push({
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: { code: ERROR_CODES.invalidRequest, message: 'malformed JSON-RPC request' },
        })
        continue
      }
      if (request.method === 'initialize') newSession = randomUUID()
      const response = await this.dispatch(request, newSession)
      if (response) responses.push(response)
    }

    if (newSession) this.sessions.add(newSession)
    if (responses.length === 0) {
      res.writeHead(202).end()
      return
    }
    send(res, 200, batch ? responses : responses[0], newSession)
  }

  private async dispatch(request: JsonRpcRequest, sessionId?: string): Promise<JsonRpcResponse | null> {
    const isNotification = request.id === undefined || request.id === null
    const reply = (result: unknown): JsonRpcResponse | null =>
      isNotification ? null : { jsonrpc: '2.0', id: request.id!, result }
    const fail = (code: number, message: string): JsonRpcResponse | null =>
      isNotification ? null : { jsonrpc: '2.0', id: request.id!, error: { code, message } }

    switch (request.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'palmier-win', version: '0.1.0' },
          instructions:
            'You are editing a video timeline. Call get_timeline first to learn the real clip ids, then act with ' +
            'add_clips, move_clips, split_clips, set_clip_properties and add_texts. Use capture_frame to look at ' +
            'the result before declaring an edit done. Every frame value is at the timeline frame rate.',
          ...(sessionId ? { sessionId } : {}),
        })

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null

      case 'ping':
        return reply({})

      case 'tools/list':
        return reply({
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        })

      case 'tools/call': {
        const name = request.params?.name
        if (typeof name !== 'string') {
          return fail(ERROR_CODES.invalidParams, 'params.name must be a string')
        }
        const tool = TOOLS_BY_NAME.get(name)
        if (!tool) {
          return fail(ERROR_CODES.methodNotFound, `unknown tool "${name}"`)
        }
        const args = (request.params?.arguments ?? {}) as Record<string, any>
        try {
          const result = await this.ctx.store.runAttributed(
            { source: 'mcp', name, args },
            () => tool.handler(args, this.ctx),
          )
          return reply({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          })
        } catch (error) {
          // Tool failures belong in the result so the agent can recover, not in the transport.
          return reply(toolErrorPayload(error))
        }
      }

      default:
        return fail(ERROR_CODES.methodNotFound, `unknown method "${request.method}"`)
    }
  }
}
