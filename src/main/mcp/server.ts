import { createServer, type Server as HttpServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { rejection } from './auth'
import { instructions, tools } from './catalog'

export type Forward = (tool: string, args: Record<string, unknown>) => Promise<unknown>
export function protocolServer(forward: Forward): Server {
  const server = new Server({ name: 'Cascade', version: '0.1.0' }, { capabilities: { tools: {} }, instructions })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema, { io: 'input' }) as Tool['inputSchema'], annotations: t.annotations })) }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    try {
      const tool = tools.find(t => t.name === req.params.name)
      if (!tool) throw new Error(`Unknown tool ${req.params.name}`)
      const args = tool.schema.parse(req.params.arguments ?? {})
      const token = req.params._meta?.progressToken
      if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 0, total: 1, message: `Running ${tool.name}` } })
      const result = await forward(tool.name, args)
      if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 1, message: `Completed ${tool.name}; poll job_get for asynchronous export progress` } })
      return result as CallToolResult
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `${error instanceof Error ? error.message : String(error)}\nRecovery: inspect project_get / registry_list, correct the arguments and retry. Ensure Cascade has finished starting.` }] }
    }
  })
  return server
}

export async function startHttp(token: string, enabled: () => Promise<boolean>, forward: Forward, port = 47823): Promise<{ server: HttpServer; url: string }> {
  const active = new Set<Server>()
  const server = createServer(async (req, res) => {
    const deny = rejection(req, token)
    if (deny) { res.writeHead(deny); res.end(deny === 401 ? 'Bearer token required' : 'Local Host and Origin required'); return }
    if (!(await enabled())) { res.writeHead(503); res.end('Enable mcp.enabled in Cascade settings'); return }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
    // v1 clients initialize normally but need no server-side session. Each request owns its transport.
    const mcp = protocolServer(forward)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false })
    active.add(mcp)
    res.on('close', () => { active.delete(mcp); void mcp.close() })
    try { await mcp.connect(transport); await transport.handleRequest(req, res) }
    catch (error) { if (!res.headersSent) res.writeHead(500); if (!res.writableEnded) res.end('MCP request failed'); console.error('[mcp]', error) }
  })
  server.requestTimeout = 180000
  await new Promise<void>((resolve, reject) => {
    const listen = (candidate: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && candidate !== 0) listen(0)
        else reject(error)
      }
      server.once('error', onError)
      server.listen(candidate, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
    }
    listen(port)
  })
  server.on('close', () => { for (const mcp of active) void mcp.close() })
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` }
}
