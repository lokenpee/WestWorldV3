import { expect, test } from '@playwright/test'

function streamResponse(delta: object, reason: string) {
  const chunk = (content: object, finish: string | null) => ({
    id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
    choices: [{ index: 0, delta: content, finish_reason: finish }],
  })
  return `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, reason))}\n\ndata: [DONE]\n\n`
}

test('Pi 1.0.2 在浏览器完成 direct、Agent 工具、awaited hook 和取消', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const externalRequests: string[] = []
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') {
      externalRequests.push(route.request().url())
      await route.abort()
    } else await route.fallback()
  })
  let calls = 0
  const requests: { model: string; messages: { role: string; content?: string }[] }[] = []
  await page.route('**/mock/v1/chat/completions', async route => {
    calls += 1
    requests.push(route.request().postDataJSON())
    if (calls === 4) {
      // The probe aborts only after the request reaches the provider boundary.
      await page.getByRole('button', { name: '取消探针请求' }).click()
      await route.abort('aborted')
      return
    }
    const delta = calls === 2
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'fixture_increment', arguments: '{"amount":2}' } }] }
      : { role: 'assistant', content: calls === 1 ? 'DIRECT_OK' : 'AGENT_OK' }
    await route.fulfill({ contentType: 'text/event-stream', body: streamResponse(delta, calls === 2 ? 'tool_calls' : 'stop') })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '运行隔离 Pi 探针' }).click()
  await expect(page.getByTestId('result')).toHaveAttribute('data-state', 'passed')
  const result = JSON.parse(await page.getByTestId('result').innerText())
  expect(result).toMatchObject({ direct: 'DIRECT_OK', agent: 'AGENT_OK', toolValue: 2, preparations: 2, beforeCalls: 1, finishTurns: 2, awaitedListener: true, cancelled: true, idleAfterAbort: true })
  expect(calls).toBe(4)
  expect(requests.every(request => request.model === 'fixture-model')).toBe(true)
  expect(requests[2].messages.some(message => message.role === 'tool' && message.content?.includes('2'))).toBe(true)
  expect(errors).toEqual([])
  expect(externalRequests).toEqual([])
  expect(await page.evaluate(async () => ({ databases: await indexedDB.databases(), localStorage: localStorage.length }))).toEqual({ databases: [], localStorage: 0 })
})
