import storySeedJson from '../../tests/fixtures/F-跨窗口叙事.json?raw'
import { createStoryService } from '../features/story/service'
import worldSeedJson from '../../tests/fixtures/E-世界资产整理.json?raw'
import { createWorldService } from '../features/world/service'
import { useState } from 'react'
import seedJson from '../../tests/fixtures/C-固定资产.json?raw'
import mergeSeedJson from '../../tests/fixtures/D-合并资产.json?raw'
import { createWorkspace, type BookRepository } from '../lib/storage/workspace'
import './Stage1Acceptance.css'
import { createImportService } from '../lib/storage/importService'
import shortNovelUrl from '../../tests/fixtures/A-三章短篇.txt?url'
import gbkNovelUrl from '../../tests/fixtures/B-GBK.txt?url'
import longNovelUrl from '../../tests/fixtures/B-长章.txt?url'
import { createAssetService } from '../features/assets/service'
import { createBackupService } from '../features/backup/service'
import { createModelService } from '../features/models/service'
import { createModelAcceptance } from './ModelAcceptance'
import { createExtractionService } from '../features/extraction/service'

// Only loaded through import.meta.env.DEV in main.tsx; never target MAIN_SCOPE.
export function createStage1Acceptance(stage: 1 | 2 | 'assets' | 'merge' | 'backup' | 'models' | 'world' | 'story' = 1) {
  const namespace = typeof stage === 'string' ? stage : `stage${stage}`
  const workspace = createWorkspace({ settingsName: `westworld_acceptance_${namespace}_settings`, bookPrefix: `westworld_acceptance_${namespace}_book_` })
  const assets = createAssetService(workspace)
  let failNextImport = false
  let failNextDelete = false
  const importer = createImportService(workspace, { checkpoint: async point => {
    if (failNextImport && point === 'after-book-write') { failNextImport = false; throw new Error('验收模拟：书库写入后失败') }
    if (failNextDelete && point === 'after-delete-hide') { failNextDelete = false; throw new Error('验收模拟：删除登记后失败') }
  } })
  const backups = createBackupService(workspace, importer)
  const modelDemo = stage === 'models' ? createModelAcceptance(workspace) : undefined
  const models = modelDemo?.models ?? createModelService(workspace)
  const extraction = createExtractionService(workspace, models)
  const world = createWorldService(workspace, models, assets)
  const story = createStoryService(workspace, models)
  const sampleIds = ['stage1-book-a', 'stage1-book-b']
  const seed = JSON.parse(stage === 'story' ? storySeedJson : stage === 'world' ? worldSeedJson : stage === 'merge' ? mergeSeedJson : seedJson) as { tables: Record<string, Record<string, unknown>[]> }

  async function assertReadable() {
    if ((await workspace.settings.appSettings.get('acceptance.failReads'))?.value === true) throw new Error('验收模拟：本地存储读取失败。请先点击“恢复存储”，再重新读取。')
  }
  const repository: BookRepository = {
    async listBooks() { await assertReadable(); return workspace.listBooks() },
    async getBookSummary(bookId) { await assertReadable(); return workspace.getBookSummary(bookId) },
    async listChapters(bookId) { await assertReadable(); return workspace.listChapters(bookId) },
    async readChapter(bookId, chapterIndex) { await assertReadable(); return workspace.readChapter(bookId, chapterIndex) },
  }

  async function seedBooks() {
    await workspace.settings.appSettings.delete('acceptance.failReads')
    const first = workspace.openBook(sampleIds[0])
    await first.open()
    await first.transaction('rw', first.tables, async () => {
      for (const table of first.tables) await table.clear()
      for (const [table, rows] of Object.entries(seed.tables)) await first.table(table).bulkPut(rows.map(row => ({ ...row, bookId: sampleIds[0] })))
    })
    const second = workspace.openBook(sampleIds[1])
    await second.open()
    const text = '第一章 山城清晨\n林遥沿着石阶走入山城。清晨有雾。'
    await second.transaction('rw', second.tables, async () => {
      for (const table of second.tables) await table.clear()
      await second.chapters.put({ bookId: sampleIds[1], chapterIndex: '1', chapterName: '第一章 山城清晨', order: 0, charCount: text.length })
      await second.table('chapterTexts').put({ bookId: sampleIds[1], chapterIndex: '1', text })
    })
    await workspace.settings.books.bulkPut([
      { id: sampleIds[0], title: stage === 'story' ? '跨窗口信件样本' : stage === 'world' ? '世界资产整理样本' : stage === 'merge' ? '渡口人物资料' : '青石镇来信', sourceFileName: stage === 'merge' ? '合并样本.txt' : 'A-三章短篇.txt', createdAt: '2026-10-23T00:00:00.000Z' },
      { id: sampleIds[1], title: '山城来客', sourceFileName: '山城来客.txt', createdAt: '2026-10-24T00:00:00.000Z' },
    ])
  }

  async function clearBooks() {
    await workspace.settings.appSettings.delete('acceptance.failReads')
    // Clear only the two named sample books; do not enumerate or delete user DBs.
    await workspace.settings.books.bulkDelete(sampleIds)
    for (const id of sampleIds) {
      const db = workspace.openBook(id)
      await db.open()
      await db.transaction('rw', db.tables, async () => { for (const table of db.tables) await table.clear() })
    }
  }

  async function seedLongStoryHistory() {
    const bookId = sampleIds[0]
    const db = workspace.openBook(bookId)
    const session = (await db.table('storySessions').toArray()).find(row => row.profile === 'story_editor' && row.status === 'active')
    if (!session) throw new Error('请先完成跨窗口样本的窗口串联。')
    if (story.state(bookId)?.running || session.leaseOwner && Number(session.leaseUntil) > Date.now()) throw new Error('请等待当前整理结束。')
    const settings = await models.settings.read()
    await models.settings.saveDraft({ ...settings.config, aggregationContextWindow: 65536 })
    const [{ createBookAgentRepository }, { appendEntry }] = await Promise.all([import('../features/agents/repository'), import('../features/agents/commands')])
    const repo = createBookAgentRepository(workspace, bookId)
    await repo.transaction(true, async store => {
      const current = (await store.get('storySessions', String(session.id)))!
      if (current.leaseOwner && Number(current.leaseUntil) > Date.now()) throw new Error('请等待当前整理结束。')
      await appendEntry(store, { bookId, profile: 'story_editor', phase: 'global_review', runId: '', taskId: '', sessionId: String(session.id), owner: '', workItemIds: [] }, { type: 'message', message: { role: 'user', content: `【压缩验收历史样本】以下为重复的历史记录，用于测试上下文压缩。\n${'历史已核对信件从接收到转交、保管、取信、读信和归还空信封，后续结论以工具查询和代码提交为准。\n'.repeat(1200)}`, timestamp: Date.now() } })
      const progress = await store.get('compileProgress', 'P3')
      if (progress?.phase === 'global_review') {
        const run = (await store.get('pipelineRuns', String(progress.runId)))!
        await store.put('pipelineRuns', { ...run, status: 'paused', coverageItems: (run.coverageItems as Record<string, unknown>[]).filter(row => row.phase !== 'global_review') })
        await store.put('compileProgress', { ...progress, status: 'paused' })
      }
    })
  }

  function Tools() {
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('独立样本库；正常入口不会出现这些书籍。')
    if (modelDemo) return <modelDemo.Tools />
    async function run(action: () => Promise<unknown>, success: string) {
      setBusy(true)
      try { await action(); setMessage(success) }
      catch (error) { setMessage(`操作失败：${error instanceof Error ? error.message : String(error)}`) }
      finally { setBusy(false) }
    }
    async function setLock(resource: 'world' | 'narrative' | null) {
      const db = workspace.openBook(sampleIds[0])
      if (!resource) { await db.table('pipelineRuns').bulkDelete(['lease:world', 'lease:narrative']); return }
      await db.table('pipelineRuns').put({ id: `lease:${resource}`, recordType: 'lease', bookId: sampleIds[0], lockKey: resource, owner: 'acceptance-owner', runId: 'acceptance-run', expiresAt: Date.now() + 300000 })
    }
    return <section className="acceptance-tools" aria-label={stage === 'backup' ? '备份验收' : stage === 'merge' ? '合并验收' : stage === 'assets' ? '资产维护验收' : `阶段${stage}隔离验收`}>
      <div><strong>{stage === 'backup' ? '备份、恢复与删除 · 独立验收库' : stage === 'merge' ? '批量合并 · 独立验收库' : stage === 'assets' ? '资产维护 · 独立验收库' : `阶段 ${stage} · 隔离验收`}</strong><p role="status">{message}</p></div>
      <div className="acceptance-actions">
        {stage === 'backup' && <><button disabled={busy} onClick={() => void run(seedBooks, '备份样本已装载，可导出青石镇来信并恢复独立副本。')}>装载备份样本</button><button disabled={busy} onClick={() => { failNextDelete = true; setMessage('下一次删除将在登记后模拟失败，可通过书籍恢复完成。') }}>模拟下次删除失败</button><button disabled={busy} onClick={() => void run(() => setLock('world'), '青石镇来信的世界资产已锁定，可导出快照。')}>锁定世界资产</button><button disabled={busy} onClick={() => void run(() => setLock(null), '验收锁已释放。')}>释放验收锁</button></>}
        {stage === 'story' && <><button disabled={busy} onClick={() => void run(seedBooks, '240原章、6个跨窗口节点已装载。选择跨窗口信件样本后可串联。')}>装载跨窗口样本</button><button disabled={busy} onClick={() => void run(seedLongStoryHistory, '长历史已追加，复核项重新列入待办；验收库容量设为65536。继续全书复核可观察自动压缩。')}>装载压缩验收历史</button></>}
        {stage === 'world' && <button disabled={busy} onClick={() => void run(seedBooks, '世界资产样本已装载，可分别测试代码整理与AI整理。')}>装载世界资产样本</button>}
        {stage === 'merge' && <button disabled={busy} onClick={() => void run(seedBooks, '合并样本已装载，请选择渡口人物资料。张三与张清是同一个人的两份资料。')}>装载合并样本</button>}
        {stage === 'assets' && <><button disabled={busy} onClick={() => void run(seedBooks, '两本资产样本已装载，请选择青石镇来信进行维护。')}>装载资产样本</button><button disabled={busy} onClick={() => void run(() => setLock('world'), '青石镇来信的世界资产已锁定。')}>锁定世界资产</button><button disabled={busy} onClick={() => void run(() => setLock('narrative'), '青石镇来信的叙事资产已锁定。')}>锁定叙事资产</button><button disabled={busy} onClick={() => void run(() => setLock(null), '验收锁已释放。')}>释放验收锁</button></>}
        {stage === 2 && <><a href={shortNovelUrl} download="A-三章短篇.txt">下载三章样本</a><a href={gbkNovelUrl} download="B-GBK.txt">下载 GBK 样本</a><a href={longNovelUrl} download="B-长章.txt">下载长章样本</a><button disabled={busy} onClick={() => { failNextImport = true; setMessage('下一次导入会在书库写入后模拟失败；失败后可再次导入。') }}>模拟下次导入失败</button></>}
        {stage === 1 && <><button disabled={busy} onClick={() => void run(seedBooks, '两本样本已就绪。可切书或刷新，重复装载不会增加书籍。')}>装载两本样本</button>
        <button disabled={busy} onClick={() => void run(clearBooks, '验收样本已清空。正常书库未操作。')}>清空验收样本</button>
        <button disabled={busy} onClick={() => void run(() => workspace.settings.appSettings.put({ key: 'acceptance.failReads', value: true }), '已模拟读取失败，接下来可恢复存储并重试。')}>模拟读取失败</button>
        <button disabled={busy} onClick={() => void run(() => workspace.settings.appSettings.delete('acceptance.failReads'), '存储已恢复。请点击页面中的重新读取按钮。')}>恢复存储</button></>}
      </div>
    </section>
  }
  return { repository, importer, assets, backups, models, extraction, world, story, Tools }
}
