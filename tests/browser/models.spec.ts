import { expect, test, type Page } from '@playwright/test'
import { anthropicBody, completionsBody, responsesBody } from '../support/model-streams'

const fakeKey = 'model-fixture-secret'
async function settings(page: Page) { await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click() }
async function editModel(page: Page, label: '提取模型' | '整理模型', value: string) {
  const manual = page.getByRole('button', { name: `手动填写${label}`, exact: true })
  if (await manual.count()) await manual.click()
  await page.getByLabel(label, { exact: true }).fill(value)
}
async function save(page: Page, api = 'openai-completions') {
  await page.getByText('高级设置（可选）', { exact: true }).click()
  await page.getByLabel('服务商标识', { exact: true }).fill('fixture')
  await page.getByLabel('调用协议', { exact: true }).selectOption(api)
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/model-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill(fakeKey)
  await editModel(page, '提取模型', 'saved-extraction')
  await editModel(page, '整理模型', 'saved-aggregation')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '模型配置已保存' })).toBeVisible()
}
test('保存刷新、保存并测试与两种Pi调用，凭据和当前配置正确', async ({ page }, testInfo) => {
  const calls: { model: string; key?: string }[] = []
  await page.route('**/model-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    calls.push({ model: body.model, key: await route.request().headerValue('authorization') ?? undefined })
    await route.fulfill({ contentType: 'text/event-stream', body: completionsBody(body.model) })
  })
  await settings(page)
  await save(page)
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByLabel('提取模型', { exact: true })).toHaveValue('saved-extraction')
  await expect(page.getByLabel('API Key（密钥）', { exact: true })).toHaveValue('')
  await expect(page.getByText(/当前服务 fixture：密钥已配置/)).toBeVisible()
  expect(calls).toEqual([])
  await editModel(page, '提取模型', 'current-model')
  await page.getByRole('button', { name: '保存并测试提取模型', exact: true }).click()
  const direct = page.getByRole('region', { name: '提取测试结果', exact: true })
  await expect(direct).toContainText('提取测试成功')
  await expect(direct).toContainText('current-model')
  await expect(direct).toContainText('实际请求：1 次')
  await expect(direct).toContainText('总用量 5')
  await expect(direct).toContainText('费用未知')
  await page.getByRole('button', { name: '测试整理模型', exact: true }).click()
  const agent = page.getByRole('region', { name: '整理测试结果', exact: true })
  await expect(agent).toContainText('整理测试成功')
  await expect(agent).toContainText('Agent 基础调用')
  expect(calls.map(row => row.model)).toEqual(['current-model', 'saved-aggregation'])
  expect(calls.every(row => row.key === `Bearer ${fakeKey}`)).toBe(true)
  await expect(direct).not.toContainText(fakeKey)
  await page.screenshot({ path: testInfo.outputPath('models-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: '清除当前服务密钥', exact: true }).click()
  await expect(page.getByRole('button', { name: '测试提取模型', exact: true })).toBeDisabled()
  await expect(page.getByText(/当前服务 fixture：密钥未配置/)).toBeVisible()
  expect((await page.evaluate(() => indexedDB.databases())).map(row => row.name)).toEqual(['westworld_settings'])
})

test('鉴权不重试，临时错误有限重试，限流等待可取消', async ({ page }) => {
  let scenario = 'auth'; let count = 0
  await page.route('**/model-fixture/v1/chat/completions', async route => {
    count++
    if (scenario === 'success' || (scenario === 'once' && count > 1)) await route.fulfill({ contentType: 'text/event-stream', body: completionsBody() })
    else {
      const status = scenario === 'auth' ? 401 : scenario === 'wait' ? 429 : 503
      await route.fulfill({ status, contentType: 'application/json', headers: status === 429 ? { 'Retry-After': '60' } : {}, body: JSON.stringify({ error: { message: `provider error ${fakeKey}` } }) })
    }
  })
  await settings(page); await save(page)
  const result = page.getByRole('region', { name: '提取测试结果', exact: true })
  await page.getByRole('button', { name: '测试提取模型', exact: true }).click()
  await expect(result).toContainText('鉴权失败')
  await expect(result).not.toContainText(fakeKey)
  expect(count).toBe(1)
  scenario = 'once'; count = 0
  await page.getByRole('button', { name: '测试提取模型', exact: true }).click()
  await expect(result).toContainText('提取测试成功')
  expect(count).toBe(2)
  scenario = 'wait'; count = 0
  await page.getByRole('button', { name: '测试提取模型', exact: true }).click()
  await expect(result).toContainText(/等待 (?:[1-9]|[12]\d|30) 秒后重试/)
  await page.getByRole('button', { name: '取消提取测试', exact: true }).click()
  await expect(result).toContainText('已取消')
  await expect(page.getByRole('button', { name: '测试提取模型', exact: true })).toBeEnabled()
  expect(count).toBe(1)
  scenario = 'success'; count = 0
  await page.getByRole('button', { name: '测试提取模型', exact: true }).click()
  await expect(result).toContainText('提取测试成功')
  expect(count).toBe(1)
})

test('运行中保存下一配置，当前调用保留启动快照', async ({ page }) => {
  const requests: { model: string; key: string | null }[] = []
  let release: () => void = () => undefined
  const hold = new Promise<void>(resolve => { release = resolve })
  await page.route('**/model-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    requests.push({ model: body.model, key: await route.request().headerValue('authorization') })
    if (requests.length === 1) await hold
    await route.fulfill({ contentType: 'text/event-stream', body: completionsBody(body.model) })
  })
  await settings(page); await save(page)
  await page.getByRole('button', { name: '测试提取模型', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  await editModel(page, '提取模型', 'next-model')
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('next-model-key')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '模型配置已保存' })).toBeVisible()
  release()
  const result = page.getByRole('region', { name: '提取测试结果', exact: true })
  await expect(result).toContainText('提取测试成功')
  await expect(result).toContainText('saved-extraction')
  await page.getByRole('button', { name: '测试提取模型', exact: true }).click()
  await expect(result).toContainText('next-model')
  expect(requests).toEqual([{ model: 'saved-extraction', key: `Bearer ${fakeKey}` }, { model: 'next-model', key: 'Bearer next-model-key' }])
})

test('目录发现、空回复与上下文容量校验分别反馈', async ({ page }) => {
  await page.route('**/model-fixture/v1/models', route => route.fulfill({ json: { data: [{ id: 'catalog-model' }] } }))
  await page.route('**/model-fixture/v1/chat/completions', route => route.fulfill({ contentType: 'text/event-stream', body: completionsBody('saved-extraction', '') }))
  await settings(page); await save(page)
  await page.getByRole('button', { name: '拉取模型', exact: true }).click()
  await expect(page.getByRole('region', { name: '模型目录结果', exact: true })).toContainText('发现 1 个模型')
  await expect(page.getByRole('region', { name: '提取测试结果', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '测试提取模型', exact: true }).click()
  await expect(page.getByRole('region', { name: '提取测试结果', exact: true })).toContainText('空文本')
  await page.getByLabel('整理模型上下文容量', { exact: true }).fill('8191')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: '上下文容量须为不小于 8192' })).toBeVisible()
})

for (const api of ['openai-responses', 'anthropic-messages']) test(`${api}由Pi适配器生成请求并解析流`, async ({ page }) => {
  let calls = 0
  const path = api === 'openai-responses' ? 'responses' : 'messages'
  await page.route(url => url.pathname === `/model-fixture/v1/${path}`, async route => {
    calls++
    const body = route.request().postDataJSON()
    expect(body.model).toBe('saved-extraction')
    if (api === 'anthropic-messages') expect(new URL(route.request().url()).searchParams.get('beta')).toBe('true')
    expect(await route.request().headerValue(api === 'anthropic-messages' ? 'x-api-key' : 'authorization')).toBe(api === 'anthropic-messages' ? fakeKey : `Bearer ${fakeKey}`)
    await route.fulfill({ contentType: 'text/event-stream', body: api === 'openai-responses' ? responsesBody() : anthropicBody() })
  })
  await settings(page); await save(page, api)
  await page.getByRole('button', { name: '测试提取模型', exact: true }).click()
  await expect(page.getByRole('region', { name: '提取测试结果', exact: true })).toContainText('提取测试成功')
  expect(calls).toBe(1)
})

test('填写连接后直接拉取并下拉选择，两类测试保存当前配置且刷新保留', async ({ page }, testInfo) => {
  const requests: { model: string; key: string | null }[] = []
  const catalogKeys: (string | null)[] = []
  await page.route('**/model-fixture/v1/models', async route => {
    catalogKeys.push(await route.request().headerValue('authorization'))
    await route.fulfill({ json: { data: [{ id: 'fast-model' }, { id: 'strong-model' }] } })
  })
  await page.route('**/model-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    requests.push({ model: body.model, key: await route.request().headerValue('authorization') })
    await route.fulfill({ contentType: 'text/event-stream', body: completionsBody(body.model) })
  })
  await settings(page)
  await expect(page.getByLabel('调用协议', { exact: true })).not.toBeVisible()
  await page.getByLabel('模型服务', { exact: true }).selectOption('compatible')
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/model-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill(fakeKey)
  const pull = page.getByRole('button', { name: '保存并拉取模型', exact: true })
  await expect(pull).toBeInViewport()
  await pull.click()
  await expect(page.getByRole('region', { name: '模型目录结果', exact: true })).toContainText('发现 2 个模型')
  expect(catalogKeys).toEqual([`Bearer ${fakeKey}`])
  await expect(page.getByLabel('提取模型', { exact: true })).toHaveValue('')
  await page.getByLabel('提取模型', { exact: true }).selectOption('fast-model')
  await page.getByLabel('整理模型', { exact: true }).selectOption('strong-model')
  await page.getByRole('button', { name: '保存并测试提取模型', exact: true }).click()
  await expect(page.getByRole('region', { name: '提取测试结果', exact: true })).toContainText('提取测试成功')
  await page.getByRole('button', { name: '测试整理模型', exact: true }).click()
  await expect(page.getByRole('region', { name: '整理测试结果', exact: true })).toContainText('整理测试成功')
  expect(requests).toEqual([{ model: 'fast-model', key: `Bearer ${fakeKey}` }, { model: 'strong-model', key: `Bearer ${fakeKey}` }])
  await page.screenshot({ path: testInfo.outputPath('model-settings-connected.png'), fullPage: true })
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByLabel('提取模型', { exact: true })).toHaveValue('fast-model')
  await expect(page.getByLabel('整理模型', { exact: true })).toHaveValue('strong-model')
  await expect(page.getByLabel('API Key（密钥）', { exact: true })).toHaveValue('')
})

test('服务商预设自动匹配地址与协议，密钥状态按服务切换', async ({ page }) => {
  await settings(page)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('deepseek-fixture')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByText(/当前服务 deepseek：密钥已配置/)).toBeVisible()
  await page.getByLabel('模型服务', { exact: true }).selectOption('openai')
  await expect(page.getByLabel('服务基础地址', { exact: true })).toHaveValue('https://api.openai.com/v1')
  await expect(page.getByLabel('调用协议', { exact: true })).toHaveValue('openai-responses')
  await expect(page.getByLabel('调用协议', { exact: true })).not.toBeVisible()
  await expect(page.getByLabel('API Key（密钥）', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: '保存并拉取模型', exact: true })).toBeDisabled()
  await page.getByLabel('模型服务', { exact: true }).selectOption('anthropic')
  await expect(page.getByLabel('服务基础地址', { exact: true })).toHaveValue('https://api.anthropic.com')
  await expect(page.getByLabel('调用协议', { exact: true })).toHaveValue('anthropic-messages')
  await page.getByLabel('模型服务', { exact: true }).selectOption('deepseek')
  await expect(page.getByText(/当前服务 deepseek：密钥已配置/)).toBeVisible()
  await expect(page.getByRole('button', { name: '拉取模型', exact: true })).toBeEnabled()
})

test('切换连接后，原连接晚到的模型列表不会进入新选择框', async ({ page }) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let requested = false
  await page.route('**/model-fixture/v1/models', async route => { requested = true; await gate; await route.fulfill({ json: { data: [{ id: 'old-connection-model' }] } }) })
  await settings(page)
  await page.getByLabel('模型服务', { exact: true }).selectOption('compatible')
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/model-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill(fakeKey)
  await page.getByRole('button', { name: '保存并拉取模型', exact: true }).click()
  await expect.poll(() => requested).toBe(true)
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/other-service/v1`)
  release()
  await expect(page.getByRole('region', { name: '模型目录结果', exact: true })).toContainText('模型目录成功')
  await expect(page.getByRole('option', { name: 'old-connection-model', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('服务基础地址', { exact: true })).toHaveValue(`${new URL(page.url()).origin}/other-service/v1`)
})
