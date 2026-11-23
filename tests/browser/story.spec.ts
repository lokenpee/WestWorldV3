import { narrativeMaterial } from '../support/agent-protocol'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { StorageCall } from '../../src/features/local-storage/client'
import { createLocalStorageServer } from '../../src/features/local-storage/server'
import { transact } from '../../src/lib/storage/transaction'
import { createWorkspace } from '../../src/lib/storage/workspace'
import { agentStream, narrativeResponse } from '../support/agent-protocol'
import { storyResponse, storyTask } from '../support/story-protocol'

const seed = JSON.parse(readFileSync(new URL('../fixtures/F-跨窗口叙事.json', import.meta.url), 'utf8')) as { tables: Record<string, Record<string, unknown>[]> }
const chapterIds = new Set(seed.tables.nodes.map(row => row.chapterIndex))
const tables = structuredClone(seed.tables)
for (const table of ['chapters', 'chapterTexts', 'extractionReceipts']) tables[table] = tables[table].filter(row => chapterIds.has(row.chapterIndex))
tables.chapters.forEach((chapter, order) => { chapter.order = order })
tables.nodes = Array.from({ length: 24 }, (_, index) => ({ ...seed.tables.nodes[index % seed.tables.nodes.length], id: `reading-node-${String(index + 1).padStart(3, '0')}`, name: `信件进展${index + 1}`, order: Math.floor(index / seed.tables.nodes.length) }))
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

test('V4 暂停后恢复同一批次，再完成全书并查看实际请求',async ({page},testInfo)=>{
  test.setTimeout(90000)
  const inputs:string[]=[]
  type Captured={messages:{role:string;content:unknown}[]}
  const isNodeBatch=(body:Captured)=>body.messages.some(m=>{
    const content=Array.isArray(m.content)?m.content.map(part=>part.text ?? '').join(''):m.content
    return typeof content==='string' && narrativeMaterial(content)?.mode === 'node_batch'
  })
  const bodies:Captured[]=[]
  const rawBodies:string[]=[]
  let extraReads=0
  let blocked=false,release=()=>{}
  const gate=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/story-fixture/v1/chat/completions',async route=>{
    if(inputs.length===1 && !blocked){blocked=true;await gate; await route.abort().catch(()=>{});return}
    const body=route.request().postDataJSON()
    bodies.push(body)
    rawBodies.push(route.request().postData()!)
    const nodeBatch=isNodeBatch(body)
    const response=nodeBatch && body.messages.some((m:{role:string})=>m.role==='tool') && extraReads++<3
      ? agentStream([{name:'get_outline',args:{kind:'events'}}])
      : narrativeResponse(body,inputs)
    await route.fulfill({contentType:'text/event-stream',body:await response.text()})
  })
  try {
    await prepare(page,undefined,2)
    await page.getByRole('button',{name:'开始整理大纲',exact:true}).click()
    await expect.poll(()=>blocked).toBe(true)
    const {db}=await sampleBook(page)
    const before=await db.table('compileProgress').get('P3')
    await page.getByRole('button',{name:'P3 整理详情',exact:true}).click()
    const liveDialog=page.getByRole('dialog')
    await liveDialog.getByRole('button',{name:'事件归入故事线',exact:true}).click()
    await expect(liveDialog.getByText('本轮尚未生成该阶段的任务。')).toBeVisible()
    await liveDialog.getByRole('button',{name:'关闭',exact:true}).click()
    await page.getByRole('button',{name:'暂停',exact:true}).click()
    release()
    await expect(page.getByRole('button',{name:'继续整理大纲',exact:true})).toBeEnabled()
    expect(await db.table('eventLines').count()).toBe(0)
    await page.getByRole('button',{name:/^事件节点 2$/}).click()
    await page.getByRole('button',{name:'事件网络',exact:true}).click()
    const network=page.getByRole('region',{name:'事件网络',exact:true})
    await expect(network.locator('[data-network-edge]')).toHaveCount(1)
    await expect(network).toContainText('0 个孤立节点')
    await network.getByLabel('只看孤立节点').check()
    await expect(network.locator('[data-network-node]')).toHaveCount(0)
    await page.getByRole('button',{name:'查看逐项复核表',exact:true}).click()
    const pendingReview=page.getByRole('dialog',{name:'P3 逐项复核表'})
    await expect(pendingReview).toContainText('本阶段尚未开始复核。')
    await pendingReview.getByRole('button',{name:'关闭',exact:true}).click()
    await page.getByRole('button',{name:'继续整理大纲',exact:true}).click()
    await expect(page.getByRole('button',{name:'重新整理大纲',exact:true})).toBeEnabled({timeout:60000})
    expect((await db.table('compileProgress').get('P3')).runId).toBe(before.runId)
    expect(await db.table('storyEvents').count()).toBe(1)
    const panel=page.getByRole('region',{name:'P3 叙事大纲',exact:true})
    await expect(panel).toContainText('节点归入事件 2/2')
    await expect(panel).toContainText('事件归入故事线 1/1')
    await panel.getByRole('button',{name:'查看逐项复核表',exact:true}).click()
    const reviewDialog=page.getByRole('dialog',{name:'P3 逐项复核表'})
    for(const phase of ['节点归入事件','事件归入故事线']){
      await reviewDialog.getByRole('button',{name:phase,exact:true}).click()
      await expect(reviewDialog.getByRole('table')).toContainText('已核对信件经过和印记')
      await expect(reviewDialog.getByRole('table')).toContainText('已修正')
      await expect(reviewDialog.getByText('本段已确认',{exact:true})).toBeVisible()
      await expect(reviewDialog.getByRole('table')).toContainText('保存核心关键线索')
      await expect(reviewDialog.getByText(/本段开始时/)).toHaveCount(0)
    }
    await reviewDialog.screenshot({path:testInfo.outputPath('p3-review-table.png')})
    await reviewDialog.getByRole('button',{name:'关闭',exact:true}).click()
    const traces = await db.table('storySessionEntries').toArray()
    const editTrace = traces.find(row => row.runId === before.runId && row.type === 'request_trace' &&
      Array.isArray(row.toolCalls) && row.toolCalls.some((call: {name?: string}) => call.name === 'edit_events'))
    expect(editTrace).toBeDefined()
    // 模拟旧字段名和只用于计数的空记录，核对详情仍以真实工具名显示。
    await db.table('storySessionEntries').put({ ...editTrace!, toolCalls: [
      ...editTrace!.toolCalls.map(({name, ...call}: {name?: string}) => ({...call,toolName:name})), {},
    ] })
    await panel.getByRole('button',{name:'P3 整理详情'}).click()
    const dialog=page.getByRole('dialog')
    await expect(dialog.getByRole('button',{name:'事件归入故事线'})).toBeVisible()
    await expect(dialog.getByText('发送给 API',{exact:true})).toHaveCount(1)
    await dialog.getByRole('button',{name:'事件归入故事线',exact:true}).click()
    await dialog.getByLabel('批次或复核分段').selectOption({index:0})
    await dialog.locator('.narrative-outcome summary').click()
    await expect(dialog.locator('.narrative-outcome li')).toHaveCount(1)
    await dialog.getByRole('button',{name:'节点归入事件',exact:true}).click()
    await dialog.getByLabel('批次或复核分段').selectOption({index:0})
    await dialog.locator('.narrative-outcome summary').click()
    await expect(dialog.locator('.narrative-outcome li')).toHaveCount(2)
    await dialog.locator('.narrative-outcome summary').click()
    const placeholders=dialog.locator('summary').filter({has:page.getByText('历史占位',{exact:true})})
    await expect(placeholders.first()).toBeVisible()
    await placeholders.first().click()
    await expect(dialog.locator('.run-role-user[open] pre').first()).toContainText('【占位符·工具返回】')
    await placeholders.first().click()
    await expect(dialog.getByText('confirm · 成功',{exact:true})).toBeVisible()
    await dialog.locator('.merge-dialog-body').evaluate(node=>{node.scrollTop=0})
    await dialog.screenshot({path:testInfo.outputPath('p3-narrative-request.png')})
    const raw=dialog.locator('details').filter({has:page.locator('summary',{hasText:'完整 API 请求原文'})}).last()
    await raw.locator('summary').click()
    const captured = await raw.locator('pre').textContent()
    const at = bodies.findLastIndex(isNodeBatch)
    expect(captured).toBe(rawBodies[at])
    const keys = Object.keys(JSON.parse(captured!))
    expect(keys.indexOf('tools')).toBeLessThan(keys.indexOf('messages'))
    await dialog.getByRole('button',{name:'第 1 次请求',exact:true}).click()
    await expect(dialog.getByRole('region',{name:'API 01',exact:true})).toBeVisible()
    await expect(dialog.getByText('历史占位',{exact:true})).toHaveCount(0)
    await expect(dialog.getByText('调用 edit_events',{exact:true})).toBeVisible()
    await expect(dialog.getByText('edit_events · 成功',{exact:true})).toBeVisible()
    await expect(dialog.getByText(/undefined/)).toHaveCount(0)
    await dialog.getByText('模型返回的推理内容',{exact:true}).click()
    await expect(dialog.getByText('先按本段原文核实成员。',{exact:true})).toBeVisible()
  } finally {release()}
})

test('V4 复核成果在整段确认前可见，暂停后仍能查看', async ({ page }) => {
  test.setTimeout(90000)
  const inputs: string[] = []
  let editing = false
  let holding = false
  let allowEdit = () => {}
  let release = () => {}
  const editGate = new Promise<void>(resolve => { allowEdit = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const task = body.messages.filter((message: { role: string }) => message.role === 'user')
      .map(({ content }: { content: string | { text: string }[] }) =>
        narrativeMaterial(typeof content === 'string' ? content : content.map(part => part.text).join('')))
      .find(Boolean)
    let reply
    if (task?.mode === 'event_review' && task.part === 'structure') {
      const id = task.targets[0].id
      if (!holding && body.messages.some((message: { role: string }) => message.role === 'tool')) {
        holding = true
        await gate
        await route.abort().catch(() => {})
        return
      }
      if (!holding) {
        editing = true
        await editGate
      }
      reply = holding
        ? agentStream([{ name: 'confirm', args: {} }])
        : agentStream([{ name: 'edit_events', args: { operations: [{op: 'update_event', eventId: id, title: '信使递交密信', summary: '信使当面递交密信。', reason: '以交信动作为名称。'}] } }])
    } else reply = narrativeResponse(body, inputs)
    await route.fulfill({ contentType: 'text/event-stream', body: await reply.text() })
  })
  try {
    await prepare(page, undefined, 2)
    await page.getByRole('button', { name: '开始整理大纲', exact: true }).click()
    await expect.poll(() => editing).toBe(true)
    await page.getByRole('button', { name: 'P3 整理详情', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'P3 整理详情' })
    const table = dialog.getByRole('table')
    await expect(dialog.getByRole('heading', { name: /检查事件里的节点是否分对 · 第 1 段 · 1 个事件/ })).toBeVisible()
    await expect(dialog.getByText('本段未确认', { exact: true })).toBeVisible()
    await expect(dialog.getByText('本段尚无已保存的修改。', { exact: true })).toBeVisible()
    allowEdit()
    await expect.poll(() => holding).toBe(true)
    await expect(table.getByText('名称从「密信抵达」改为「信使递交密信」', { exact: true })).toBeVisible()
    await expect(table.getByText(/待提交|待确认/)).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '第 1 次请求', exact: true })).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: /查看全部变更|查看逐项结论|查看 API 调用/ })).toHaveCount(0)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    release()
    await expect(page.getByRole('button', { name: '继续整理大纲', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '查看逐项复核表', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'P3 逐项复核表' })
    await expect(review.getByText('本段未确认', { exact: true })).toBeVisible()
    await expect(review.getByText('已暂停', { exact: true })).toBeVisible()
    await expect(review.getByRole('table')).toContainText('保存概况')
    await review.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '继续整理大纲', exact: true }).click()
    await expect(page.getByRole('button', { name: '重新整理大纲', exact: true })).toBeEnabled({ timeout: 60000 })
    await page.getByRole('button', { name: '查看逐项复核表', exact: true }).click()
    await review.getByRole('button', { name: '节点归入事件', exact: true }).click()
    await review.getByLabel('批次或复核分段').selectOption({ label: '全书事件复核 · 检查事件里的节点是否分对 · 第 1 段 · 已确认' })
    await expect(review.getByText('本段已确认', { exact: true })).toBeVisible()
    await expect(review.getByRole('row', { name: /信使递交密信/ })).toContainText('以交信动作为名称。')
    await review.getByRole('button', { name: '事件归入故事线', exact: true }).click()
    await expect(review.getByRole('list', { name: '全书故事线复核任务' })).toContainText('检查故事线里的事件是否分对')
    await review.getByLabel('批次或复核分段').selectOption({label:'全书故事线复核 · 复查未归线事件和单事件故事线 · 第 1 段 · 已确认'})
    await expect(review.getByRole('table')).toContainText('保留单事件故事线')
  } finally { allowEdit(); release() }
})

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
  await page.getByText('旧版串联与复核', { exact:true }).click()
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeDisabled()
  const { book, db } = await sampleBook(page)
  await transact(db, 'rw', [Object.keys(tables).map(name => db.table(name))], async tx => {
    for (const [name, rows] of Object.entries(tables)) {
      await tx.table(name).clear()
      const selected = name === 'nodes' ? rows.slice(0, nodeCount) : rows
      await tx.table(name).bulkPut(selected.map(row => ({ ...row, bookId: book.id })))
    }
  })
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeEnabled({ timeout: 15000 })
}

test('AI主动翻三页复用事件线，进度与大纲刷新保留，窄屏操作可达', async ({ page }, testInfo) => {
  test.setTimeout(60000)
  const pages: number[] = [], quickPages: number[] = []; let calls = 0
  const duplicateKeys: string[] = []
  page.on('console', message => { if (message.text().includes('same key')) duplicateKeys.push(message.text()) })
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    calls++; const body = route.request().postDataJSON(); const { input } = storyTask(body)
    expect(input.contextHints.assigned.length).toBeLessThanOrEqual(10)
    expect(input.contextHints.assigned.every((row: Record<string, unknown>) => row.process === undefined && row.summary === undefined && row.clues === undefined && row.quote === undefined)).toBe(true)
    if (input.quick) {
      const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
      expect([...names].sort()).toEqual(['get_story_detail', 'navigate_story_pages', 'save_story_notes', 'save_story_outline'])
      quickPages.push(input.page.pageNumber)
    }
    expect(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'search_story_context')).toBe(false)
    expect(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'navigate_story_pages')).toBe(true)
    pages.push(input.page.pageNumber)
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(body).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 30000 })
  expect([...new Set(pages)]).toEqual([1, 2, 3])
  await panel.getByRole('button', { name: 'P3 整理详情', exact: true }).click()
  const trace = page.getByRole('dialog', { name: '整理详情', exact: true })
  await expect(trace).toContainText('API 请求')
  await expect(trace).toContainText('完整输入')
  await expect(trace).toContainText('缓存读')
  await expect(trace).toContainText('SYSTEM')
  await expect(trace).toContainText('USER')
  await expect(trace.locator('.execution-conversation details[open]')).toHaveCount(0)
  await trace.locator('.run-conversation-assistant > summary').first().click()
  await expect(trace).toContainText('TOOL CALL')
  await expect(trace).toContainText('navigate_story_pages')
  await expect(trace.getByRole('tab', { name: /人物资料|人物关系/ })).toHaveCount(0)
  await expect(trace).not.toContainText('本次实际修改')
  await trace.getByRole('button', { name: '关闭', exact: true }).click()
  await panel.getByText('节点串联进度', { exact: true }).click()
  await expect(panel).toContainText('第 1 页')
  await expect(panel).toContainText('第 3 页')
  await page.getByRole('button', { name: /^事件线 1$/ }).click()
  await expect(page.getByRole('button', { name: '编辑 信件流转', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '重新串联事件线', exact: true })).toBeEnabled({ timeout: 15000 })
  await disks.get(page)!.reload()
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 15000 })
  const previous = calls
  const { db } = await sampleBook(page)
  const before = await db.table('storyEvents').toArray()
  await page.getByRole('button', { name: '快速核对后继续', exact: true }).click()
  await expect(panel).toContainText('快速核对 3/3 页', { timeout: 30000 })
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 30000 })
  expect(calls).toBeGreaterThan(previous)
  expect(quickPages).toEqual([1, 2, 3])
  expect(await db.table('storyEvents').toArray()).toEqual(before)
  expect(duplicateKeys).toEqual([])
  await page.setViewportSize({ width: 375, height: 812 })
  await panel.screenshot({ path: testInfo.outputPath('story-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('暂停和继续保留同一轮，取消后快速核对已完成页并续接', async ({ page }) => {
  test.setTimeout(100000)
  let calls = 0, releasePause = () => {}, releaseCancel = () => {}
  const pauseGate = new Promise<void>(resolve => { releasePause = resolve })
  const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve })
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    calls++
    if (calls === 4) await pauseGate
    if (calls === 5) { await cancelGate; await route.abort().catch(() => undefined); return }
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(route.request().postDataJSON()).text() })
  })
  await prepare(page)
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  await expect.poll(() => calls, { timeout: 15000 }).toBe(4)
  await expect(page.locator('.story-panel .agent-activity')).toContainText(/第 4 次 API · 等待模型回复/)
  await expect(page.locator('.story-panel .agent-activity')).toHaveClass(/is-active/)
  await page.getByRole('button', { name: /^事件节点 24$/ }).click()
  await expect(page.getByRole('button', { name: '新增事件节点', exact: true })).toBeDisabled()
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  const { db } = await sampleBook(page)
  const started = await db.table('compileProgress').get('P3')
  await page.getByRole('button', { name: '暂停串联', exact: true }).click()
  releasePause()
  await expect(panel).toContainText('串联已暂停 · 已检查 1/3 页')
  await page.getByRole('button', { name: '继续串联', exact: true }).click()
  await expect.poll(() => calls, { timeout: 15000 }).toBe(5)
  expect(await db.table('compileProgress').get('P3')).toMatchObject({ runId: started.runId, editorSessionId: started.editorSessionId })
  await page.getByRole('button', { name: '取消 P3', exact: true }).click()
  await expect(panel).toContainText('串联已取消 · 已检查 1/3 页')
  await expect(panel.locator('.agent-activity')).toContainText('已取消 · 已保存的进度保留')
  await expect(panel.locator('.agent-activity')).not.toHaveClass(/is-active/)
  await expect(page.getByRole('button', { name: '新增事件节点', exact: true })).toBeEnabled()
  releaseCancel()
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '快速核对后继续', exact: true }).click()
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 35000 })
  await expect(panel).toContainText('快速核对 1/1 页')
  expect((await db.table('compileProgress').get('P3')).editorSessionId).not.toBe(started.editorSessionId)
  await expect(panel.locator('.agent-activity')).toContainText('已完成')
  await page.getByRole('button', { name: /^事件线 1$/ }).click()
  await expect(page.getByRole('button', { name: '编辑 信件流转', exact: true })).toHaveCount(1)
})

test('全书复核隔离串联长历史，刷新后可分别查看会话与复核结论', async ({ page }, testInfo) => {
  test.setTimeout(110000)
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(route.request().postDataJSON()).text() })
  })
  await prepare(page, '65536')
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  await expect(panel).toContainText('串联完成', { timeout: 30000 })
  const { db } = await sampleBook(page)
  await expect(panel.getByText('大纲归类疑点与处理结果', { exact: true })).toHaveCount(0)
  const sessionId = await transact(db, 'rw', [[db.table('storySessions'), db.table('storySessionEntries'), db.table('storyEditorNotes')]], async tx => {
    const [session] = await tx.table('storySessions').toArray()
    const id = crypto.randomUUID(), now = new Date().toISOString()
    await tx.table('storySessionEntries').put({ id, sessionId: session.id, bookId: session.bookId, ordinal: session.nextOrdinal, parentId: session.leafId, type: 'message', message: { role: 'user', content: `浏览器旧历史标记：${'保留本书的原始工具依据。'.repeat(6000)}`, timestamp: Date.now() }, createdAt: now })
    await tx.table('storySessions').put({ ...session, leafId: id, nextOrdinal: Number(session.nextOrdinal) + 1, updatedAt: now })
    await tx.table('storyEditorNotes').put({ id: 'note-sender', key: 'sender', sessionId: session.id, bookId: session.bookId,
      stage: 'P3', kind: 'review', status: 'active', statement: '这封信是谁寄来的？', nodeIds: ['reading-node-001'],
      lineIds: [], evidence: [], basisFingerprint: '', revision: 1, createdAt: now, updatedAt: now })
    return String(session.id)
  })
  await page.getByRole('button', { name: '全书复核', exact: true }).click()
  await expect(panel).toContainText('全书复核完成', { timeout: 45000 })
  await expect(panel).toContainText('事件说明 1/1')
  await expect(panel).toContainText('已压缩 0 次')
  await panel.getByRole('button', { name: 'P3 整理详情', exact: true }).click()
  const trace = page.getByRole('dialog', { name: '整理详情', exact: true })
  await expect(trace.getByRole('button', { name: '全书复核', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await trace.getByRole('button', { name: '事件串联', exact: true }).click()
  const system = trace.getByRole('region', { name: 'API 01', exact: true }).locator('.run-role-system')
  await system.locator('summary').click()
  await expect(system.locator('pre')).toContainText('按页维护剧情大纲')
  await trace.getByRole('button', { name: '全书复核', exact: true }).click()
  const reviewSystems = trace.locator('.run-role-system > summary')
  await expect(reviewSystems.first()).toBeVisible()
  for (const label of await reviewSystems.all()) await label.click()
  await expect(trace.locator('.run-role-system pre').filter({ hasText: '全书剧情大纲复核' }).first()).toBeVisible()
  await expect(trace.locator('.run-role-system pre').filter({ hasText: '按页维护剧情大纲' })).toHaveCount(0)
  await trace.getByRole('button', { name: '关闭', exact: true }).click()
  await disks.get(page)!.reload()
  await expect(panel).toContainText('全书复核完成', { timeout: 15000 })
  await panel.getByRole('button', { name: '查看会话历史', exact: true }).click()
  await expect(panel).toContainText(sessionId)
  const history = panel.getByLabel('本书会话历史', { exact: true })
  await expect(history.getByRole('combobox')).not.toHaveValue(sessionId)
  await history.getByRole('combobox').selectOption(sessionId)
  await expect(history.getByRole('combobox')).toHaveValue(sessionId)
  for (let turn = 0; turn < 5 && !await history.locator('details').filter({ hasText: '浏览器旧历史标记' }).count(); turn++) {
    await history.getByRole('button', { name: '下一页记录', exact: true }).click()
    await expect(history).toContainText(new RegExp(`${21 + turn * 20}–`))
  }
  const longLabel = await history.locator('details').filter({ hasText: '浏览器旧历史标记' }).first().locator('summary').textContent()
  const longEntry = history.locator('details').filter({ has: page.locator('summary', { hasText: longLabel! }) })
  await longEntry.locator('summary').click()
  await longEntry.getByRole('button', { name: '下一段内容', exact: true }).click()
  await expect(longEntry).toContainText('12001–')
  await panel.getByText('大纲归类疑点与处理结果', { exact: true }).click()
  await expect(panel.getByText('已核对，疑点保留 · 这封信是谁寄来的？', { exact: true })).toBeVisible()
  await expect(panel.getByText('现有章节尚未交代来信者，保留疑点。', { exact: true })).toBeVisible()
  await panel.getByText('全书复核进度', { exact: true }).click()
  await expect(panel.getByText(/第 1 项 · 全书目录初查 · 已检查/)).toBeVisible()
  await expect(panel.getByText('节点串联进度', { exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 1366, height: 768 })
  await panel.screenshot({ path: testInfo.outputPath('story-review-desktop.png') })
  await page.setViewportSize({ width: 375, height: 812 })
  await panel.screenshot({ path: testInfo.outputPath('story-review-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await panel.evaluate(element => element.clientHeight <= innerHeight - 100)).toBe(true)
  expect(await history.locator('.story-details-body').evaluate(element => element.clientHeight <= innerHeight * 0.36 + 1)).toBe(true)
})

test('切到另一书后晚到的串联结果保持原书归属', async ({ page }) => {
  let release: () => void = () => undefined, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    if (++calls === 1) await gate
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(route.request().postDataJSON()).text() })
  })
  await prepare(page)
  const { workspace, db } = await sampleBook(page)
  await workspace.settings.books.put({ id: 'book-other', title: '另一书', sourceFileName: '另一书.txt', createdAt: new Date().toISOString() })
  await expect(page.getByRole('button', { name: '进入 另一书', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  await expect.poll(() => calls,{timeout:15000}).toBe(1)
  await page.getByRole('button', { name: '进入 另一书', exact: true }).click()
  release()
  await expect(page.getByRole('heading', { name: '另一书', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^事件线 0$/ })).toBeVisible()
  await expect(page.getByRole('region', { name: 'P3 叙事大纲', exact: true })).toBeVisible()
  await expect(page.locator('.story-panel .agent-activity')).toHaveCount(0)
  await expect.poll(() => db.table('compileProgress').get('P3'), { timeout: 30000 }).toMatchObject({ status: 'completed', phase: 'window_link_complete' })
  await page.getByRole('button', { name: '进入 跨窗口信件样本', exact: true }).click()
  await expect(page.getByRole('region', { name: '事件线窗口串联', exact: true })).toContainText('已检查 3/3 页', { timeout: 15000 })
  await expect(page.getByRole('button', { name: /^事件线 1$/ })).toBeVisible()
})

test('失效标签的叙事执行权到期后，页面自动恢复启动入口', async ({ page }) => {
  await prepare(page)
  const { book, db } = await sampleBook(page)
  await db.table('pipelineRuns').put({ id: 'lease:narrative', bookId: book.id, recordType: 'lease', lockKey: 'narrative', runId: 'interrupted', owner: 'closed-tab', expiresAt: Date.now() + 10000 })
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '串联事件线', exact: true })).toBeEnabled({ timeout: 20000 })
})


for (const previous of [false, true]) test(`P3启动失败保留可见原因，修正后能重试（旧取消记录：${previous}）`, async ({ page }) => {
  test.setTimeout(60000)
  let calls = 0
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    calls++
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(route.request().postDataJSON()).text() })
  })
  await prepare(page)
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  if (previous) {
    await page.getByRole('button', { name: '串联事件线', exact: true }).click()
    await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 30000 })
    await expect(page.getByRole('button', { name: '重新串联事件线', exact: true })).toBeEnabled({ timeout: 15000 })
    const { db } = await sampleBook(page)
    await transact(db, 'rw', [[db.table('compileProgress'), db.table('pipelineRuns')]], async tx => {
      const progress = await tx.table('compileProgress').get('P3')
      await tx.table('compileProgress').put({ ...progress, status: 'cancelled', validity: 'stale' })
      const run = await tx.table('pipelineRuns').get(progress.runId)
      await tx.table('pipelineRuns').put({ ...run, status: 'cancelled' })
    })
    await expect(panel).toContainText('串联已取消')
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '清除当前服务密钥', exact: true }).click()
  await expect(page.getByText('已清除当前服务商的密钥。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '资产', exact: true }).click()
  const before = calls
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('请先保存整理模型与密钥。')
  await expect(panel.locator('.agent-activity')).toHaveCount(1)
  await expect(panel.locator('.agent-activity')).not.toHaveClass(/is-active/)
  expect(calls).toBe(before)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('story-browser-fixture')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '模型配置已保存' })).toBeVisible()
  await page.getByRole('button', { name: '资产', exact: true }).click()
  await page.getByRole('button', { name: '串联事件线', exact: true }).click()
  await expect(panel).toContainText('串联完成 · 已检查 3/3 页', { timeout: 30000 })
  await expect(panel.getByRole('alert')).toHaveCount(0)
  expect(calls).toBeGreaterThan(before)
})


test('P3链路默认收起，展开首个请求与消息后实时刷新保持状态，重开重新折叠', async ({ page }) => {
  test.setTimeout(60000)
  let calls = 0, release = () => {}
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    calls++
    if (calls === 2) await new Promise<void>(resolve => { release = resolve })
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(route.request().postDataJSON()).text() })
  })
  try {
    await prepare(page, undefined, 4)
    const { db } = await sampleBook(page)
    await page.getByRole('button', { name: '串联事件线', exact: true }).click()
    await expect.poll(() => calls, { timeout: 15000 }).toBe(2)
    const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
    await panel.getByRole('button', { name: 'P3 整理详情', exact: true }).click()
    const trace = page.getByRole('dialog', { name: '整理详情', exact: true })
    const conversation = trace.locator('.execution-conversation')
    await expect(conversation.locator('.run-conversation-assistant').first()).toBeVisible()
    await expect(conversation.locator('details[open]')).toHaveCount(0)
    const assistants = conversation.locator('.run-api-slice > .run-conversation-assistant')
    const assistant = assistants.first()
    await assistant.locator(':scope > summary').click()
    await expect(assistant.locator('details[open]')).toHaveCount(0)
    await assistant.locator('.run-role-toolcall > summary').first().click()
    await expect(assistant.locator('pre').first()).toBeVisible()
    await conversation.locator('.run-api-boundary > summary').first().click()
    const request = conversation.locator('.run-api').first()
    await expect(request).not.toHaveAttribute('open', '')
    await request.locator(':scope > summary').click()
    await expect(request.locator('details[open]')).toHaveCount(0)
    release()
    await expect.poll(() => db.table('compileProgress').get('P3'), { timeout: 30000 }).toMatchObject({ status: 'completed', phase: 'window_link_complete' })
    await expect(assistants.nth(1)).toBeVisible()
    await expect(assistant).toHaveAttribute('open', '')
    await expect(assistant.locator('.run-role-toolcall').first()).toHaveAttribute('open', '')
    await expect(request).toHaveAttribute('open', '')
    await expect(assistants.nth(1)).not.toHaveAttribute('open', '')
    await trace.getByRole('button', { name: '关闭', exact: true }).click()
    await panel.getByRole('button', { name: 'P3 整理详情', exact: true }).click()
    await expect(conversation.locator('.run-conversation-assistant').first()).toBeVisible()
    await expect(conversation.locator('details[open]')).toHaveCount(0)
  } finally { release() }
})

test('旧复核暂停后可以取消 P3，刷新后从全书目录开启独立会话', async ({ page }) => {
  test.setTimeout(90000)
  const requests: { type: string; roles: string[] }[] = []
  await page.route('**/story-fixture/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    const { input } = storyTask(body)
    requests.push({ type: input.page.type, roles: body.messages.map((message: { role: string }) => message.role) })
    await route.fulfill({ contentType: 'text/event-stream', body: await storyResponse(body).text() })
  })
  await prepare(page, undefined, 2)
  const panel = page.getByRole('region', { name: '事件线窗口串联', exact: true })
  await panel.getByRole('button', { name: '串联事件线', exact: true }).click()
  await expect(panel).toContainText('串联完成 · 已检查 1/1 页', { timeout: 30000 })
  await expect(panel.getByRole('button', { name: '全书复核', exact: true })).toBeEnabled()
  const { db } = await sampleBook(page)
  const old = await db.table('compileProgress').get('P3')
  await transact(db, 'rw', [[db.table('pipelineRuns'), db.table('compileProgress')]], async tx => {
    const run = await tx.table('pipelineRuns').get(old.runId)
    await tx.table('pipelineRuns').put({ ...run, phase: 'global_review', status: 'paused', storyReading: {
      ...run.storyReading, global_review: { pages: [], receipts: [], currentPageId: null },
    } })
    await tx.table('compileProgress').put({ ...old, phase: 'global_review', status: 'paused' })
  })
  await disks.get(page)!.reload()
  const count = requests.length
  await expect(panel).toContainText('复核已暂停')
  await panel.getByRole('button', { name: '取消 P3', exact: true }).click()
  await expect(panel).toContainText('复核已取消')
  await disks.get(page)!.reload()
  await expect(panel.getByRole('button', { name: '重新复核全书', exact: true })).toBeEnabled()
  expect(requests.length).toBe(count)
  await panel.getByRole('button', { name: '重新复核全书', exact: true }).click()
  await expect(panel).toContainText('全书复核完成', { timeout: 30000 })
  const current = await db.table('compileProgress').get('P3')
  expect(current.editorSessionId).not.toBe(old.editorSessionId)
  expect(current.runId).not.toBe(old.runId)
  expect(requests[count]).toEqual({ type: 'directory_open', roles: ['system', 'user', 'user'] })
})
