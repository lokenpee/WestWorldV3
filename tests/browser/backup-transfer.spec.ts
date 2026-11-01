import { expect, firefox, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { agentStream } from '../support/agent-protocol'
import { storyResponse } from '../support/story-protocol'

async function exportBook(page: Page, title: string) {
  await page.getByRole('button', { name: `导出 ${title}`, exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载备份', exact: true }).click()
  return readFile((await (await download).path())!)
}

test('固定响应贯通P1至P3，备份从Edge恢复到Firefox并保留网络和会话', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.route('**/transfer-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    let response: Response
    if (body.tools.length === 1) response = agentStream([{ name: 'submit_result', args: body.tools[0].function.parameters.properties.characters
      ? { characters: [{ name: '沈青', confidence: 1 }, { name: '顾衡', confidence: 1 }], locations: [] }
      : { nodes: [{ name: '收信', summary: '沈青收到信', actors: ['沈青'], quote: '沈青收到信。', confidence: 1 }, { name: '接信', summary: '顾衡接过信', actors: ['顾衡'], quote: '顾衡接过信。', confidence: 1 }] } }])
    else if (body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'get_editor_memory')) response = storyResponse(body)
    else {
      const users = body.messages.filter((row: { role: string }) => row.role === 'user').map((row: { content: string | { text: string }[] }) => typeof row.content === 'string' ? row.content : row.content.map(part => part.text).join(''))
      const input = JSON.parse(users.find((value: string) => value.startsWith('{'))!)
      response = body.messages.some((row: { role: string }) => row.role === 'tool')
        ? agentStream([{ name: 'submit_result', args: { status: 'completed', commitIds: [], summary: '核实完成', remainingWorkIds: [], reviewedItems: input.workItems.map((work: { workItemId: string }) => ({ workItemId: work.workItemId, outcome: 'no_change', reason: '独立人物' })) } }])
        : agentStream([{ name: 'get_character_detail', args: { ids: input.workItems.map((work: { id: string }) => work.id) } }])
    }
    await route.fulfill({ contentType: 'text/event-stream', body: await response.text() })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/transfer-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('transfer-fixture-key')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await page.getByRole('button', { name: '资产', exact: true }).click()
  const text = '第一章 书信\n沈青收到信。顾衡接过信。'
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '全流程样本.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await page.getByRole('button', { name: '开始提取', exact: true }).click()
  await expect(page.getByRole('button', { name: 'AI整理', exact: true })).toBeEnabled({ timeout: 15000 })
  await page.getByRole('button', { name: 'AI整理', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '世界资产整理报告', exact: true })).toContainText('完成', { timeout: 15000 })
  await page.getByRole('button', { name: '关闭报告', exact: true }).click()
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  await expect(panel).toContainText('窗口串联完成', { timeout: 20000 })
  await page.getByRole('button', { name: '全书复核', exact: true }).click()
  await expect(panel).toContainText('全书复核完成', { timeout: 20000 })
  const bytes = await exportBook(page, '全流程样本')
  const secondBrowser = await firefox.launch({ headless: true, channel: 'firefox' })
  try {
    const context = await secondBrowser.newContext({ baseURL: new URL(page.url()).origin })
    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: '设置', exact: true }).click()
    await other.getByLabel('选择备份文件（.wwv2）', { exact: true }).setInputFiles({ name: '全流程样本.wwv2', mimeType: 'application/zip', buffer: bytes })
    await expect(other.getByRole('region', { name: '备份预检' })).toContainText('1 章 / 块 · 人物 2 · 地点 0 · 节点 2 · 事件线 1')
    await other.getByRole('button', { name: '确认恢复为新书', exact: true }).click()
    await expect(other.getByRole('status').filter({ hasText: '已恢复：全流程样本（导入）' })).toBeVisible({ timeout: 20000 })
    await other.getByRole('button', { name: '资产', exact: true }).click()
    await expect(other.getByRole('region', { name: '事件线窗口串联', exact: true })).toContainText('全书复核完成', { timeout: 15000 })
    await expect(other.getByRole('region', { name: '事件线窗口串联', exact: true })).toContainText('已完成 1/1 个窗口')
    await other.getByRole('button', { name: /^事件节点 2$/ }).click()
    await other.getByRole('button', { name: '事件网络', exact: true }).click()
    await expect(other.getByRole('region', { name: '事件网络', exact: true })).toContainText('显示 2 / 2 个节点 · 1 条事件线')
    expect(await other.getByRole('region', { name: '事件网络', exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await other.getByRole('region', { name: '事件网络', exact: true }).screenshot({ path: testInfo.outputPath('firefox-restored-network.png') })
    await other.reload()
    await expect(other.getByRole('region', { name: '事件线窗口串联', exact: true })).toContainText('全书复核完成')
    let extraCalls = 0
    await other.route('**/transfer-fixture/v1/chat/completions', async route => { extraCalls++; await route.abort() })
    await other.getByRole('button', { name: '设置', exact: true }).click()
    await other.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(other.url()).origin}/transfer-fixture/v1`)
    await other.getByLabel('API Key（密钥）', { exact: true }).fill('restored-fixture-key')
    await other.getByRole('button', { name: '保存模型配置', exact: true }).click()
    await other.getByRole('button', { name: '资产', exact: true }).click()
    await other.getByRole('button', { name: '重新复核全书', exact: true }).click()
    await expect(other.getByRole('button', { name: '重新复核全书', exact: true })).toBeEnabled()
    await expect(other.getByRole('alert')).toHaveCount(0)
    expect(extraCalls).toBe(0)
    const again = await exportBook(other, '全流程样本（导入）')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByLabel('选择备份文件（.wwv2）', { exact: true }).setInputFiles({ name: 'Firefox副本.wwv2', mimeType: 'application/zip', buffer: again })
    await expect(page.getByText('备份校验通过', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '备份预检' })).toContainText('节点 2 · 事件线 1')
  } finally { await secondBrowser.close() }
})
