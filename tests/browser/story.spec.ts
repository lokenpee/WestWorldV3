import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { StorageCall } from '../../src/features/local-storage/client'
import { createLocalStorageServer } from '../../src/features/local-storage/server'
import { transact } from '../../src/lib/storage/transaction'
import { createWorkspace } from '../../src/lib/storage/workspace'
import { narrativeResponse } from '../support/agent-protocol'

const seed = JSON.parse(readFileSync(new URL('../fixtures/F-跨窗口叙事.json', import.meta.url), 'utf8')) as { tables: Record<string, Record<string, unknown>[]> }
const chapterIds = new Set(seed.tables.nodes.map(row => row.chapterIndex))
const tables = structuredClone(seed.tables)
for (const table of ['chapters', 'chapterTexts', 'extractionReceipts']) tables[table] = tables[table].filter(row => chapterIds.has(row.chapterIndex))
tables.chapters.forEach((chapter, order) => { chapter.order = order })
tables.nodes = Array.from({ length: 24 }, (_, index) => ({ ...seed.tables.nodes[index % seed.tables.nodes.length], id: `reading-node-${String(index + 1).padStart(3, '0')}`, name: `信件进展${index + 1}`, clues: ['密信'], order: Math.floor(index / seed.tables.nodes.length) }))
const disks = new WeakMap<Page, { workspace: ReturnType<typeof createWorkspace>; reload: () => Promise<void>; close: () => Promise<void> }>()
test.beforeEach(async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'westworld-story-browser-'))
  const server = createLocalStorageServer(directory, { protect: value => value, unprotect: value => value })
  const call: StorageCall = async <T>(body: Record<string, unknown>) => await server.execute(body) as T
  const workspace = createWorkspace(undefined, call)
  const transactions = new Set<string>()
  let reloading = false
  disks.set(page, { workspace, async reload() {
    reloading = true
    try {
      await expect.poll(() => transactions.size).toBe(0)
      await page.reload({ waitUntil: 'commit' })
    } finally { reloading = false }
  }, async close() { workspace.close(); await server.close(); rmSync(directory, { recursive: true, force: true }) } })
  await page.route('**/api/storage', async route => {
    const input = route.request().postDataJSON()
    const action = input.action
    try {
      const result = reloading && action === 'begin' ? null : await server.execute(input)
      if (action === 'begin' && typeof result === 'string') transactions.add(result)
      if (action === 'commit' || action === 'abort') transactions.delete(input.transaction)
      await route.fulfill({ json: { ok: true, result } })
    }
    catch (error) { await route.fulfill({ status: 500, json: { ok: false, error: String(error) } }) }
  })
})
test.afterEach(async ({ page }) => { await disks.get(page)?.close() })

async function sampleBook(page: Page) {
  const workspace = disks.get(page)!.workspace
  const book = (await workspace.listBooks()).find(row => row.title === '跨窗口信件样本')!
  return { workspace, book, db: workspace.openBook(book.id) }
}

async function prepare(page: Page, contextWindow?: string, nodeCount = tables.nodes.length) {
  await page.goto('/')
  await page.getByRole('button', { name: '进入磁盘书库', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('服务基础地址', { exact: true }).fill(`${new URL(page.url()).origin}/story-fixture/v1`)
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('story-browser-fixture')
  if (contextWindow) { await page.getByText('高级设置（可选）', { exact: true }).click(); await page.getByLabel('整理模型上下文容量', { exact: true }).fill(contextWindow) }
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '模型配置已保存' })).toBeVisible()
  await page.getByRole('button', { name: '资产', exact: true }).click()
  const text = tables.chapterTexts.map(row => row.text).join('')
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '跨窗口信件样本.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '跨窗口信件样本', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始整理大纲', exact: true })).toBeDisabled()
  await expect(page.getByText('旧版串联与复核',{exact:true})).toHaveCount(0)
  const { book, db } = await sampleBook(page)
  await transact(db, 'rw', [Object.keys(tables).map(name => db.table(name))], async tx => {
    for (const [name, rows] of Object.entries(tables)) {
      await tx.table(name).clear()
      const selected = name === 'nodes' ? rows.slice(0, nodeCount) : rows
      await tx.table(name).bulkPut(selected.map(row => ({ ...row, bookId: book.id })))
    }
  })
  await expect(page.getByRole('button', { name: '开始整理大纲', exact: true })).toBeEnabled({ timeout: 15000 })
}


test('两个节点逐项串联并复核事件，第一阶段结束后保留详情并暂停归线',async ({page})=>{
  test.setTimeout(90000)
  const inputs:string[]=[]
  let releaseSecond!: () => void
  const gate = new Promise<void>(resolve => { releaseSecond = resolve })
  const prefixes: string[] = []
  await page.route('**/story-fixture/v1/chat/completions',async route=>{
    const body=route.request().postDataJSON()
    if (inputs.length < 2) {
      const firstUser = body.messages.findIndex((message: {role:string}) => message.role === 'user')
      prefixes.push(JSON.stringify([body.messages.slice(0,firstUser),body.tools,body.messages[firstUser]]))
      if (inputs.length === 1) await gate
    }
    await route.fulfill({contentType:'text/event-stream',body:await narrativeResponse(body,inputs).text()})
  })
  await prepare(page,undefined,2)
  await page.getByRole('button',{name:'开始整理大纲',exact:true}).click()
  const dialog=page.getByRole('dialog')
  try {
    await page.getByRole('button',{name:'P3 整理详情'}).click()
    await expect(dialog.getByRole('button',{name:'第 1 次请求'})).toBeVisible()
    await dialog.getByRole('button',{name:'第 1 次请求'}).click()
    await expect(dialog.getByRole('heading',{name:/第 1 次请求/})).toBeVisible()
    await expect.poll(() => prefixes.length).toBe(2)
    expect(prefixes[1]).toBe(prefixes[0])
    expect(prefixes[0]).toContain('【事件串联规则结束】')
    expect(prefixes[0]).toContain('【本轮任务结束】')
  } finally { releaseSecond() }
  await expect(dialog.getByRole('button',{name:'第 2 次请求'})).toBeVisible()
  await dialog.getByRole('button',{name:'关闭'}).click()
  await expect(page.getByText('第一阶段已完成，已在故事线整理前暂停。',{exact:true})).toBeVisible({timeout:60000})
  const {db} = await sampleBook(page)
  expect(await db.table('storyEvents').count()).toBe(1)
  expect(await db.table('eventLines').count()).toBe(0)
  expect(await db.table('compileProgress').get('P3')).toMatchObject({status:'paused',phase:'window_link'})
  await expect(page.getByRole('button',{name:/继续整理大纲|启动第二阶段/})).toHaveCount(0)
  const requestsAfterRun=inputs.length
  await page.getByRole('button',{name:'P3 整理详情'}).click()
  await expect(dialog.getByLabel('事件任务')).toBeVisible()
  await dialog.getByRole('button',{name:'节点串联'}).click()
  const picker=dialog.getByRole('combobox')
  const nodes=picker.locator('option').filter({hasText:'节点串联'})
  await expect(nodes).toHaveCount(2)
  await picker.selectOption(await nodes.first().getAttribute('value') ?? '')
  const outcome=dialog.getByRole('region',{name:'本节点处理结果'})
  const resultHeading=outcome.locator('summary').filter({hasText:'本节点处理结果'})
  await expect(outcome.getByText('本轮新建',{exact:true})).toBeHidden()
  await resultHeading.click()
  await expect(outcome.getByText('本轮新建',{exact:true})).toBeVisible()
  await picker.selectOption(await nodes.last().getAttribute('value') ?? '')
  await expect(outcome.getByText('已有事件',{exact:true})).toBeHidden()
  await resultHeading.click()
  await expect(outcome.getByText('已有事件',{exact:true})).toBeVisible()
  await expect(outcome.getByText('新加入 · 当前节点',{exact:true})).toBeHidden()
  await outcome.getByText('已有事件',{exact:true}).click()
  await expect(outcome.getByText('新加入 · 当前节点',{exact:true})).toBeVisible()
  const member=outcome.locator('li details').filter({has:page.getByText('新加入 · 当前节点',{exact:true})})
  await expect(member.locator('p')).toBeHidden()
  await member.locator('summary').click()
  await expect(member.locator('p')).toBeVisible()
  await member.locator('summary').press('Enter')
  await expect(member.locator('p')).toBeHidden()
  await outcome.getByText(/事件编号与操作记录/).click()
  await expect(outcome.getByText('密信继续传递',{exact:false}).last()).toBeVisible()
  await expect(dialog.getByText(/检索降级.*密钥/)).toBeVisible()
  await dialog.getByRole('button',{name:'逐事件主审'}).click()
  await expect(dialog.getByLabel('事件任务')).toBeVisible()
  await expect(dialog.getByRole('heading',{name:/第 1 次请求/})).toBeVisible()
  const review=dialog.getByRole('region',{name:'本事件复核结果'})
  await review.locator('summary').filter({hasText:'本事件复核结果'}).click()
  await review.getByText('已有事件',{exact:true}).click()
  await expect(review.getByText('本轮未编辑此事件。')).toBeVisible()
  expect(inputs).toHaveLength(requestsAfterRun)
  expect(inputs).toContain('review_sequence/structure')
  expect(inputs.every(mode => mode.startsWith('link_node/') || mode.startsWith('review_sequence/') || mode.startsWith('review_boundaries/'))).toBe(true)
  await dialog.getByRole('button',{name:'关闭'}).click()
  const mainRun=await db.table('compileProgress').get('P3')
  await page.getByRole('button',{name:'事件复核',exact:true}).click()
  await expect(page.getByText('事件复核完成。',{exact:true})).toBeVisible()
  expect(await db.table('compileProgress').get('P3')).toEqual(mainRun)
  expect(inputs.slice(requestsAfterRun)).toEqual(['review_sequence/structure'])
})
