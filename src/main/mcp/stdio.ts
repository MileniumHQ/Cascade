import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { instructions } from './catalog'

/** The application must already be running; stdout is exclusively MCP JSON-RPC. */
export async function runStdio(userData: string): Promise<void> {
  const endpoint = JSON.parse(await readFile(join(userData, 'mcp-endpoint.json'), 'utf8')) as { url: string; token: string }
  const url = new URL(endpoint.url)
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Invalid local MCP endpoint')
  const client = new Client({ name: 'cascade-stdio-proxy', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } }))
  const server = new Server({ name: 'Cascade', version: '0.1.0' }, { capabilities: { tools: {} }, instructions })
  server.setRequestHandler(ListToolsRequestSchema, () => client.listTools())
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const token = request.params._meta?.progressToken
    return client.callTool(request.params, undefined, token === undefined ? undefined : { onprogress: progress => {
      void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken: token } }).catch(() => {})
    } })
  })
  await server.connect(new StdioServerTransport())
  process.stdin.on('end', () => { void Promise.all([client.close(), server.close()]).finally(() => process.exit(0)) })
}
