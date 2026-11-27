import { expect, test, type Page } from '@playwright/test'
import { agentResponse, agentStream } from '../support/agent-protocol'
import { completionsBody } from '../support/model-streams'

async function prepare(page: Page) {
  await page.goto('/?acceptance=stage1')
  const settings = page.getByRole('button', { name: '设置', exact: true })
  const enter = page.getByRole('button', { name: '进入磁盘书库', exact: true })
  await expect(settings.or(enter)).toBeVisible()
  if (await enter.isVisible()) await enter.click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('模型服务', { exact: true }).selectOption('compatible')
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/agent-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('agent-browser-fixture')
  await page.getByRole('button', { name: '手动填写整理模型', exact: true }).click()
  await page.getByLabel('整理模型', { exact: true }).fill('probe-agent')
}
test('设置页保存当前配置，Pi依次完成两套工具读写与提交确认，测试样本保持隔离', async ({ page }, testInfo) => {
  let count = 0
  await page.route('**/agent-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON(); count++
    expect(body.model).toBe('probe-agent')
    expect(await route.request().headerValue('authorization')).toBe('Bearer agent-browser-fixture')
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
    if (count > 3) expect(names).toEqual(['get_nodes','get_event','search_events','search_prior_nodes','edit_events','confirm'])
    else expect(names).toHaveLength(6)
    await route.fulfill({ contentType: 'text/event-stream', body: await agentResponse(body).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '保存并测试工具', exact: true }).click()
  const panel = page.getByRole('region', { name: '智能体工具测试', exact: true })
  await expect(panel).toContainText('两套工具测试通过')
  await expect(panel).toContainText('世界资产 · 通过')
  await expect(panel).toContainText('叙事资产 · 通过')
  expect(count).toBe(6)
  await expect(panel).not.toContainText('agent-browser-fixture')
  await page.getByRole('button', { name: '资产', exact: true }).click()
  await expect(page.getByRole('heading', { name: '资产书架 0' })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  await panel.screenshot({ path: testInfo.outputPath('agent-tools-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
test('叙事探针失败时在设置页显示当前步骤和工具错误', async ({ page }) => {
  let count = 0
  await page.route('**/agent-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const response = ++count <= 3 ? agentResponse(body) : agentStream([{ name: 'get_tools', args: {} }])
    await route.fulfill({ contentType: 'text/event-stream', body: await response.text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '保存并测试工具', exact: true }).click()
  const panel = page.getByRole('region', { name: '智能体工具测试', exact: true })
  await expect(panel).toContainText('世界资产 · 通过')
  await expect(panel).toContainText('叙事资产 · 失败')
  await expect(panel.getByRole('alert')).toContainText('读取节点')
  await expect(panel.getByRole('alert')).toContainText('get_tools')
})
test('普通文本回复不能冒充工具成功，取消终止余下套件', async ({ page }) => {
  let count = 0; let waiting = false
  await page.route('**/agent-fixture/v1/chat/completions', async route => {
    count++
    if (waiting) await route.fulfill({ status: 429, headers: { 'Retry-After': '30' }, json: { error: { message: 'rate limit' } } })
    else await route.fulfill({ contentType: 'text/event-stream', body: completionsBody('probe-agent', '好') })
  })
  await prepare(page)
  await page.getByRole('button', { name: '保存并测试工具', exact: true }).click()
  const panel = page.getByRole('region', { name: '智能体工具测试', exact: true })
  await expect(panel).toContainText('工具测试未全部通过')
  await expect(panel).toContainText('世界资产 · 失败')
  await expect(panel).toContainText('叙事资产 · 失败')
  expect(count).toBe(6)
  waiting = true
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('agent-browser-fixture')
  await page.getByRole('button', { name: '保存并测试工具', exact: true }).click()
  await expect.poll(() => count).toBe(7)
  await page.getByRole('button', { name: '取消工具测试', exact: true }).click()
  await expect(panel).toContainText('已取消工具测试')
  expect(count).toBe(7)
})
