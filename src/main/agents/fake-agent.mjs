// Test fixture: a tiny ACP agent over stdio. Echoes prompts, streams a tool call, asks permission once.
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable'
let model = 'small'
const options = () => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'small', name: 'Small' }, { value: 'big', name: 'Big' }] }]
let seen = {}
// FAKE_AUTH=1: session/new needs an `authenticate` call first, like a logged-out agent.
let signedIn = !process.env.FAKE_AUTH
agent({ name: 'fake' })
  .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, ...(process.env.FAKE_SYSTEM_PROMPT ? { sessionCapabilities: { systemPrompt: {} } } : {}), promptCapabilities: { image: true }, mcpCapabilities: { http: true } }, agentInfo: { name: 'fake', title: 'Fake Agent', version: '1.0' }, authMethods: [{ id: 'key', name: 'API key', type: 'env_var', vars: [{ name: 'FAKE_KEY' }] }, { id: 'browser', name: 'Log in' }] }))
  .onRequest('authenticate', ({ params }) => { if (params.methodId === 'browser') signedIn = true; return {} })
  .onRequest('session/new', ({ params }) => {
    if (!signedIn) throw RequestError.authRequired(); seen = { cwd: params.cwd, mcp: params.mcpServers, allowed: params._meta?.claudeCode?.options?.allowedTools, system: params.systemPrompt?.mode }; return { sessionId: 's1', configOptions: options() } })
  .onRequest('session/load', async ({ params, client }) => {
    // Replays history like real agents do; the host must not re-emit it.
    await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY' } } })
    return { configOptions: options() }
  })
  .onRequest('session/set_config_option', ({ params }) => { model = params.value; return { configOptions: options() } })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt[0].text
    const say = (t) => client.notify('session/update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } })
    await say(`seen=${JSON.stringify(seen)} model=${model} `)
    await say(`preamble=${text.startsWith('[Context from Cascade]')} `)
    await say(`echo:${text.split('\n\n').at(-1)} blocks=${params.prompt.map(b => b.type + (b.uri ? `(${b.uri})` : '')).join(',')} `)
    await client.notify('session/update', { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'mcp__cascade__timeline_get', kind: 'other', status: 'in_progress' } })
    const answer = await client.request('session/request_permission', { sessionId: 's1', toolCall: { toolCallId: 't1', title: 'Edit', rawInput: { command: 'rm x' } }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] })
    await client.notify('session/update', { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'ok' ? 'completed' : 'failed' } })
    return { stopReason: 'end_turn' }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
