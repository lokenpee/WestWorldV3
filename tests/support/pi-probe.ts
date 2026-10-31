import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import * as completions from '@earendil-works/pi-ai/api/openai-completions'
import { Type } from 'typebox'

// This fixture is only bundled by tests/browser/vite.config.ts, never by the app.
export async function runProbe(registerAbort: (abort: () => void) => void) {
  const model: Model<'openai-completions'> = {
    id: 'fixture-model', name: 'Isolated fixture', provider: 'fixture',
    api: 'openai-completions', baseUrl: `${location.origin}/mock/v1`,
    input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } })
  models.setProvider(createProvider({
    id: 'fixture', models: [model], api: completions,
    auth: { apiKey: { name: 'isolated test credential', resolve: async () => ({ auth: { apiKey: 'fixture-not-a-real-key' } }) } },
  }))
  const directMessage = await models.completeSimple(model, {
    messages: [{ role: 'user', content: 'direct probe', timestamp: 1 }],
  })
  if (directMessage.stopReason !== 'stop') throw new Error(directMessage.errorMessage ?? directMessage.stopReason)

  let toolValue = 0
  let preparations = 0
  let beforeCalls = 0
  let finishTurns = 0
  let awaitedListener = false
  const parameters = Type.Object({ amount: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })
  const tool: AgentTool<typeof parameters, { value: number }> = {
    name: 'fixture_increment', label: 'Fixture increment', description: 'Update isolated memory only', parameters,
    outputSchema: Type.Object({ value: Type.Integer() }),
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted()
      toolValue += params.amount
      return { content: [{ type: 'text', text: JSON.stringify({ value: toolValue }) }], details: { value: toolValue }, structuredContent: { value: toolValue } }
    },
  }
  const agent = new Agent({
    initialState: { model, systemPrompt: 'Isolated integration probe', tools: [tool] },
    streamFn: (selected, context, options) => models.streamSimple(selected, context, options),
    toolExecution: 'sequential',
    prepareRequest: () => { preparations += 1 },
    beforeToolCall: async () => { beforeCalls += 1; return undefined },
    finishTurn: () => { finishTurns += 1 },
  })
  agent.subscribe(async event => {
    if (event.type === 'agent_end') {
      await new Promise(resolve => setTimeout(resolve, 10))
      awaitedListener = true
    }
  })
  await agent.prompt('Use fixture_increment with amount 2, then summarize.')
  if (!awaitedListener) throw new Error('Agent did not await agent_end listener')
  const last = agent.state.messages.findLast((message): message is AssistantMessage => message.role === 'assistant')
  if (!last || last.stopReason !== 'stop') throw new Error('Agent did not complete normally')

  const cancelAgent = new Agent({ initialState: { model }, streamFn: (selected, context, options) => models.streamSimple(selected, context, options) })
  registerAbort(() => cancelAgent.abort())
  await cancelAgent.prompt('Wait until browser test aborts this request.')
  await cancelAgent.waitForIdle()
  const cancelledMessage = cancelAgent.state.messages.findLast((message): message is AssistantMessage => message.role === 'assistant')
  const text = (message: AssistantMessage) => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
  return {
    direct: text(directMessage), agent: text(last), toolValue, preparations, beforeCalls, finishTurns, awaitedListener,
    cancelled: cancelledMessage?.stopReason === 'aborted', idleAfterAbort: !cancelAgent.state.isStreaming,
  }
}
