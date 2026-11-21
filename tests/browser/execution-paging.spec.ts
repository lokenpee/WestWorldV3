import { expect, test } from '@playwright/test'

test('P2 在同一条时间线显示首轮输入和工具，后续只见新增内容', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const path = '/tests/browser/execution-paging-probe.tsx'
    const { mountExecutionProbe } = await import(/* @vite-ignore */ path)
    Object.assign(window, { executionProbe: mountExecutionProbe() })
  })
  const panel = page.locator('#execution-probe')
  const first = panel.getByRole('region', { name: 'API 01', exact: true })
  const second = panel.getByRole('region', { name: 'API 02', exact: true })
  const third = panel.getByRole('region', { name: 'API 03', exact: true })
  const headings = 'details > summary'
  const topRows = ':scope > details > summary'
  const calls = () => page.evaluate(() => (window as unknown as { executionProbe: { calls: string[] } }).executionProbe.calls)
  await expect(panel).toContainText('API 请求 3 次')
  await expect(first.locator(topRows)).toHaveText([
    'SYSTEM PROMPT · 实际发送', 'TOOLS · 可调用工具', 'USER · 程序注入', 'USER', 'USER',
    'ASSISTANT · 1 次工具调用', 'TOOL RESULT · read_original成功',
  ])
  await expect(third.locator(topRows)).toHaveText(['USER', 'ASSISTANT · 1 次工具调用', 'TOOL RESULT · read_original成功'])
  await expect(panel.locator('details[open]')).toHaveCount(0)
  expect(await calls()).toEqual([])
  await first.getByText('TOOLS · 可调用工具', { exact: true }).click()
  await first.getByText('read_original', { exact: true }).click()
  await expect(first).toContainText('chapter_indices')
  expect(await calls()).toEqual(['request:r1'])
  await first.getByText('USER · 程序注入', { exact: true }).click()
  await expect(first).toContainText('程序注入人物档案')
  await first.locator(headings).filter({ hasText: /^ASSISTANT/ }).click()
  await first.getByText('思考内容', { exact: true }).click()
  await expect(first).toContainText('思考 1')
  await first.getByText('TOOL CALL · read_original', { exact: true }).click()
  await expect(first).toContainText('"1"')
  await first.locator(topRows).filter({ hasText: 'TOOL RESULT' }).click()
  await expect(first).toContainText('工具返回 1')

  await panel.getByRole('button', { name: '查看更早的调用' }).click()
  const laterRows = ['USER', 'ASSISTANT · 1 次工具调用', 'TOOL RESULT · read_original成功']
  await expect(second.locator(topRows)).toHaveText(laterRows)
  await expect(third.locator(topRows)).toHaveText(laterRows)
  await expect(panel.getByText('TOOLS · 可调用工具', { exact: true })).toHaveCount(1)
  await expect(panel.getByText('首次 API 请求输入', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('查看本次实际请求', { exact: true })).toHaveCount(0)
  await expect(first).toContainText('工具返回 1')
  await second.getByText('USER', { exact: true }).click()
  await third.getByText('USER', { exact: true }).click()
  await expect(second).toContainText('本轮新增运行消息 2')
  await expect(third).toContainText('本轮新增运行消息 3')
})
