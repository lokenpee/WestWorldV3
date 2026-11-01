import type { createWorkspace } from '../../lib/storage/workspace'
import { AssetError, type Character, type LocationAsset } from '../assets/types'
import type { AssetService } from '../assets/service'
import { createFrequencyCounter } from '../assets/derive'
import type { MergeRequest, WorldKind } from '../assets/merge'
import { coverage, type Receipt } from '../extraction/recovery'
import { coverageFingerprint } from './queue'
import { emptyReport, type Counts, type MechanicalQueueItem, type WorldRun } from './types'
import type { Row } from '../agents/repository'
import { canonical } from '../agents/contracts'
import { findExactNameGroups } from './candidates'

type Workspace = ReturnType<typeof createWorkspace>
export interface MechanicalState { running: boolean; phase: string; processed: number; total: number; error?: string; reportId?: string; reportType?: 'code' }
const isPending = (item: MechanicalQueueItem) => item.status === 'pending' || item.status === 'running'
const yieldPage = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const failures = (items: MechanicalQueueItem[]) => items.filter(item => item.status === 'failed').map(item => `${item.request.canonicalName}：${item.error ?? '请重新核对本组。'}`)
const freshRun = (bookId: string, counts: Counts): WorldRun => ({ id: crypto.randomUUID(), bookId, recordType: 'run', stage: 'P2', phase: 'mechanical_queue', status: 'paused', startedAt: new Date().toISOString(), planVersion: '2.2', report: { ...emptyReport(counts), status: 'paused' }, mechanicalQueue: { current: true, items: [], stopRequested: false, statisticsPending: false }, tasks: [], commandIntents: [], coverageItems: [], appliedCommands: [] } as WorldRun)

export function createMechanicalQueue(workspace: Workspace, assets: AssetService, notify: (bookId: string, state: MechanicalState) => void, aiRunning: (bookId: string) => boolean) {
  const active = new Set<string>()
  const dbFor = (bookId: string) => workspace.openBook(bookId)
  async function latest(bookId: string) {
    return (await dbFor(bookId).table<WorldRun>('pipelineRuns').where('stage').equals('P2').toArray()).find(run => run.phase === 'mechanical_queue' && run.mechanicalQueue?.current)
  }
  async function available(bookId: string) {
    const db = dbFor(bookId)
    const leases = await db.table('pipelineRuns').where('recordType').equals('lease').toArray()
    if (leases.some(row => ['world', 'extraction'].includes(row.lockKey) && (row.expiresAt === undefined || row.expiresAt > Date.now()))) throw new AssetError('ASSET_DOMAIN_LOCKED', '本书世界资产或提取任务正在运行。')
    if (!coverage(await db.chapters.toArray(), await db.table<Receipt>('extractionReceipts').toArray()).allCovered) throw new AssetError('VALIDATION', '请先完成全书逐章提取。')
  }
  async function locked<T>(bookId: string, work: () => Promise<T>): Promise<T> {
    if (!await workspace.settings.books.get(bookId)) throw new AssetError('NOT_FOUND', '书籍不存在。')
    const locks = globalThis.navigator?.locks
    if (!locks) return work()
    return locks.request(`westworld-mechanical:${workspace.scope.settingsName}:${bookId}`, { mode: 'exclusive', ifAvailable: true }, lock => {
      if (!lock) throw new AssetError('ASSET_DOMAIN_LOCKED', '本书机械合并正在另一标签处理中。')
      return work()
    })
  }
  async function read(bookId: string) {
    const db = dbFor(bookId)
    return db.transaction('r', db.table('pipelineRuns'), async () => {
      const run = await latest(bookId), lease = await db.table('pipelineRuns').get('lease:world')
      const items = run?.mechanicalQueue?.items ?? []
      return { run, items, pending: items.filter(isPending).length, failed: items.filter(item => item.status === 'failed').length, completed: items.filter(item => item.status === 'completed').length, statisticsPending: run?.mechanicalQueue?.statisticsPending ?? false, running: !!run && run.status === 'running' && lease?.runId === run.id && (lease.expiresAt === undefined || lease.expiresAt > Date.now()) }
    })
  }
  async function add(bookId: string, kind: WorldKind, request: MergeRequest) {
    if (active.has(bookId) || aiRunning(bookId)) throw new AssetError('ASSET_DOMAIN_LOCKED', '本书正在处理，请等待结束。')
    return locked(bookId, async () => {
      const preview = await assets.previewMerge(bookId, kind, request)
      if (request.memberIds.some(id => request.expectedRevisions?.[id] !== preview.request.expectedRevisions[id])) throw new AssetError('CONFLICT', '所选资料已变化，请重新核对后加入队列。')
      const approvalFingerprints = Object.fromEntries(await Promise.all(preview.members.map(async row => [row.id, await coverageFingerprint(kind === 'character' ? 'characters' : 'locations', row as unknown as Row)])))
      const db = dbFor(bookId)
      return db.transaction('rw', db.tables, async () => {
        await available(bookId)
        const current = await db.table(kind === 'character' ? 'characters' : 'locations').bulkGet(request.memberIds)
        if (current.some((row, index) => !row || row.revision !== preview.request.expectedRevisions[request.memberIds[index]])) throw new AssetError('CONFLICT', '资料在确认时已变化，请重新核对。')
        let run = await latest(bookId)
        if (!run || run.mechanicalQueue!.items.every(item => item.status === 'completed') && !run.mechanicalQueue!.statisticsPending && run.mechanicalQueue!.items.length > 0) {
          if (run) await db.table('pipelineRuns').put({ ...run, mechanicalQueue: { ...run.mechanicalQueue!, current: false } })
          const counts = { characters: await db.table('characters').count(), locations: await db.table('locations').count() }
          run = freshRun(bookId, counts)
        }
        const queue = run.mechanicalQueue!
        const overlap = queue.items.filter(item => item.kind === kind && item.status !== 'completed' && item.request.memberIds.some(id => request.memberIds.includes(id)))
        const same = overlap.length === 1 && overlap[0].request.memberIds.length === request.memberIds.length && overlap[0].request.memberIds.every(id => request.memberIds.includes(id)) ? overlap[0] : undefined
        if (overlap.length && !same) throw new AssetError('VALIDATION', '部分成员已在待合并队列，请先移除对应组再调整。')
        const item: MechanicalQueueItem = { id: same?.id ?? crypto.randomUUID(), kind, request: structuredClone(preview.request), memberNames: preview.members.map(row => row.name), approvalFingerprints, status: 'pending', confirmedAt: new Date().toISOString(), confirmation: 'manual' }
        const items = same ? queue.items.map(row => row.id === same.id ? item : row) : [...queue.items, item]
        await db.table('pipelineRuns').put({ ...run, status: 'paused', mechanicalQueue: { ...queue, items, stopRequested: false }, report: { ...run.report, status: 'paused', failed: failures(items) } })
        return item
      })
    })
  }
  async function remove(bookId: string, itemId: string) {
    if (active.has(bookId) || aiRunning(bookId)) throw new AssetError('ASSET_DOMAIN_LOCKED', '本书正在处理，请等待结束。')
    await locked(bookId, async () => {
      const db = dbFor(bookId)
      await db.transaction('rw', db.tables, async () => {
        await available(bookId)
        const run = await latest(bookId)
        if (!run) return
        const queue = run.mechanicalQueue!, item = queue.items.find(row => row.id === itemId)
        if (item?.status === 'completed') throw new AssetError('VALIDATION', '本组已经合并，可在合并记录中查看。')
        const items = queue.items.filter(row => row.id !== itemId)
        const status = items.some(isPending) || queue.statisticsPending ? 'paused' : items.some(row => row.status === 'failed') ? 'degraded' : 'completed'
        await db.table('pipelineRuns').put({ ...run, status, mechanicalQueue: { ...queue, items }, report: { ...run.report, status, failed: failures(items) } })
      })
    })
  }
  async function stop(bookId: string) {
    const db = dbFor(bookId)
    await db.transaction('rw', db.table('pipelineRuns'), async () => {
      const run = await latest(bookId)
      if (run?.status === 'running') await db.table('pipelineRuns').put({ ...run, mechanicalQueue: { ...run.mechanicalQueue!, stopRequested: true } })
    })
  }
  async function recover(bookId: string) {
    if (active.has(bookId) || aiRunning(bookId)) return
    const db = dbFor(bookId), lease = await db.table('pipelineRuns').get('lease:world')
    if (!lease) return
    const run = await db.table<WorldRun>('pipelineRuns').get(lease.runId)
    if (run?.phase !== 'mechanical_queue' || !run.mechanicalQueue || run.status === 'running' && lease.expiresAt > Date.now()) return
    try {
      await locked(bookId, () => db.transaction('rw', db.table('pipelineRuns'), async () => {
        const currentLease = await db.table('pipelineRuns').get('lease:world')
        if (currentLease?.owner !== lease.owner || currentLease?.runId !== run.id) return
        const current = (await db.table<WorldRun>('pipelineRuns').get(run.id))!
        const queue = current.mechanicalQueue!, items = queue.items.map(item => item.status === 'running' ? { ...item, status: 'pending' as const } : item)
        const status = items.some(isPending) || queue.statisticsPending ? 'paused' : items.some(item => item.status === 'failed') ? 'degraded' : 'completed'
        await db.table('pipelineRuns').put({ ...current, status, mechanicalQueue: { ...queue, items }, report: { ...current.report, status } })
        await db.table('pipelineRuns').delete('lease:world')
      }))
    } catch (error) { if (!(error instanceof AssetError) || error.code !== 'ASSET_DOMAIN_LOCKED') throw error }
  }
  async function execute(bookId: string, onlyIds?: ReadonlySet<string>) {
    const db = dbFor(bookId), owner = crypto.randomUUID()
    let runId = '', acquired = false, timer: ReturnType<typeof setInterval> | undefined, errorMessage: string | undefined
    const state = async (phase: string, running = true) => {
      const run = await db.table<WorldRun>('pipelineRuns').get(runId), items = run?.mechanicalQueue?.items ?? []
      notify(bookId, { running, phase, processed: items.filter(item => !isPending(item)).length, total: items.length, error: errorMessage, ...(running ? {} : { reportId: runId, reportType: 'code' as const }) })
    }
    const check = async () => {
      const lease = await db.table('pipelineRuns').get('lease:world')
      if (lease?.owner !== owner || lease.runId !== runId) throw new AssetError('ASSET_DOMAIN_LOCKED', '机械合并队列的执行权已变化。')
      const other = await db.table('pipelineRuns').get('lease:extraction')
      if (other && (other.expiresAt === undefined || other.expiresAt > Date.now())) throw new AssetError('ASSET_DOMAIN_LOCKED', '本书提取任务已取得执行权。')
      await db.table('pipelineRuns').update('lease:world', { expiresAt: Date.now() + 30000 })
    }
    const renew = () => db.transaction('rw', db.table('pipelineRuns'), check)
    async function statistics() {
      const run = (await db.table<WorldRun>('pipelineRuns').get(runId))!
      if (!run.mechanicalQueue!.statisticsPending) return
      await state('统一更新出场统计')
      const people = await db.table<Character>('characters').toArray(), places = await db.table<LocationAsset>('locations').toArray()
      const pc = createFrequencyCounter(people, true), lc = createFrequencyCounter(places, false)
      const chapterIds = await db.table('chapterTexts').toCollection().primaryKeys()
      let renewedAt = Date.now()
      for (const [index, id] of chapterIds.entries()) {
        if (Date.now() - renewedAt > 5000) { await renew(); renewedAt = Date.now() }
        const text = await db.table<{ chapterIndex: string; text: string }>('chapterTexts').get(id)
        if (text) { pc.add(text); lc.add(text) }
        if ((index + 1) % 10 === 0 || index + 1 === chapterIds.length) await state(`更新出场统计：${index + 1}/${chapterIds.length}章`)
        await yieldPage()
      }
      const updates = [...pc.result().map((row, index) => ({ table: 'characters', row, before: people[index] })), ...lc.result().map((row, index) => ({ table: 'locations', row, before: places[index] }))].filter(({ row, before }) => JSON.stringify(row) !== JSON.stringify(before))
      await state(`保存出场统计：${updates.length}条`)
      await db.transaction('rw', db.table('characters'), db.table('locations'), db.table('pipelineRuns'), async () => {
        await check()
        for (const table of ['characters', 'locations']) {
          const selected = updates.filter(row => row.table === table)
          const currentRows = await db.table(table).bulkGet(selected.map(value => value.row.id))
          if (selected.some((value, index) => currentRows[index]?.revision !== value.before.revision)) throw new AssetError('CONFLICT', '出场统计保存前资料已变化，请继续机械合并完成收尾。')
          if (selected.length) await db.table(table).bulkUpdate(selected.map(({ row, before }) => ({ key: row.id, changes: { frequency: row.frequency, revision: before.revision + 1, ...('roleWeight' in row ? { roleWeight: row.roleWeight, roleWeightSource: row.roleWeightSource } : {}) } })))
        }
        const current = (await db.table<WorldRun>('pipelineRuns').get(runId))!
        await db.table('pipelineRuns').put({ ...current, mechanicalQueue: { ...current.mechanicalQueue!, statisticsPending: false } })
      })
    }
    try {
      await db.transaction('rw', db.tables, async () => {
        await available(bookId)
        const run = await latest(bookId)
        if (!run || !run.mechanicalQueue!.items.some(item => isPending(item) && (!onlyIds || onlyIds.has(item.id))) && !run.mechanicalQueue!.statisticsPending) throw new AssetError('VALIDATION', '请先逐组核对并加入待合并队列。')
        runId = run.id
        const queue = run.mechanicalQueue!, items = queue.items.map(item => item.status === 'running' ? { ...item, status: 'pending' as const } : item)
        const counts = { characters: await db.table('characters').count(), locations: await db.table('locations').count() }
        await db.table('pipelineRuns').put({ ...run, status: 'running', mechanicalQueue: { ...queue, stopRequested: false, items }, report: { ...run.report, status: 'running', ...(items.some(item => item.status === 'completed') ? {} : { beforeCounts: counts }), afterCounts: counts, failed: failures(items) } })
        await db.table('pipelineRuns').put({ id: 'lease:world', bookId, recordType: 'lease', lockKey: 'world', owner, runId, expiresAt: Date.now() + 30000 })
      }); acquired = true; active.add(bookId)
      timer = setInterval(() => { void renew().catch(() => undefined) }, 8000)
      await state('准备顺序合并已确认组')
      type Preparation = { request: MergeRequest } | { error: unknown }
      const preparing = new Map<string, Promise<Preparation>>()
      const prepare = async (item: MechanicalQueueItem): Promise<Preparation> => {
        try {
          const table = item.kind === 'character' ? 'characters' : 'locations'
          const members = await db.table(table).bulkGet(item.request.memberIds)
          const proofs = await Promise.all(members.map(row => row ? coverageFingerprint(table, row) : Promise.resolve('')))
          if (members.some((row, index) => !row || proofs[index] !== item.approvalFingerprints[item.request.memberIds[index]])) throw new AssetError('CONFLICT', '成员内容已变化或删除，请重新核对后加入队列。')
          return { request: { ...item.request, expectedRevisions: Object.fromEntries(members.map(row => [row!.id, row!.revision])) } }
        } catch (error) { return { error } }
      }
      for (;;) {
        await renew()
        const run = (await db.table<WorldRun>('pipelineRuns').get(runId))!, queue = run.mechanicalQueue!
        if (queue.stopRequested) break
        const pending = queue.items.filter(item => isPending(item) && (!onlyIds || onlyIds.has(item.id)))
        const item = pending[0]
        if (!item) break
        for (const next of pending.slice(0, 3)) if (!preparing.has(next.id)) preparing.set(next.id, prepare(next))
        await state(`机械合并：${item.request.canonicalName}`)
        try {
          const prepared = await preparing.get(item.id)!
          preparing.delete(item.id)
          if ('error' in prepared) throw prepared.error
          const request = prepared.request
          const proceed = await db.transaction('rw', db.table('pipelineRuns'), async () => {
            await check()
            const current = (await db.table<WorldRun>('pipelineRuns').get(runId))!
            if (current.mechanicalQueue!.stopRequested) return false
            await db.table('pipelineRuns').put({ ...current, mechanicalQueue: { ...current.mechanicalQueue!, items: current.mechanicalQueue!.items.map(row => row.id === item.id ? { ...row, request, status: 'running' } : row) } })
            return true
          })
          if (!proceed) break
          await assets.confirmMerge(bookId, item.kind, request, { runId, itemId: item.id, owner })
        } catch (error) {
          if (!(error instanceof AssetError) || !['CONFLICT', 'VALIDATION', 'NOT_FOUND'].includes(error.code)) throw error
          await db.transaction('rw', db.table('pipelineRuns'), async () => {
            await check()
            const current = (await db.table<WorldRun>('pipelineRuns').get(runId))!
            const items = current.mechanicalQueue!.items.map(row => row.id === item.id ? { ...row, status: 'failed' as const, error: error.message } : row)
            await db.table('pipelineRuns').put({ ...current, mechanicalQueue: { ...current.mechanicalQueue!, items }, report: { ...current.report, failed: failures(items) } })
          })
        }
        await yieldPage()
      }
    } catch (error) { errorMessage = error instanceof Error ? error.message : '机械合并中断，请稍后继续。'; if (!acquired) throw error }
    finally {
      if (acquired) {
        try { await renew(); await statistics() } catch (error) { errorMessage = error instanceof Error ? error.message : '统计尚未完成，请继续机械合并。' }
        try {
          await db.transaction('rw', db.table('pipelineRuns'), async () => {
            await check()
            const run = (await db.table<WorldRun>('pipelineRuns').get(runId))!, queue = run.mechanicalQueue!
            const status = errorMessage || queue.items.some(isPending) || queue.statisticsPending ? 'paused' : queue.items.some(item => item.status === 'failed') ? 'degraded' : 'completed'
            await db.table('pipelineRuns').put({ ...run, status, finishedAt: new Date().toISOString(), report: { ...run.report, status, failed: [...failures(queue.items), ...(errorMessage ? [errorMessage] : [])] } })
          })
        } catch (error) { errorMessage ??= error instanceof Error ? error.message : '队列状态保存失败。' }
        clearInterval(timer)
        await db.transaction('rw', db.table('pipelineRuns'), async () => { if ((await db.table('pipelineRuns').get('lease:world'))?.owner === owner) await db.table('pipelineRuns').delete('lease:world') }).catch(() => undefined)
        active.delete(bookId)
        try { await state('机械合并已停稳', false) }
        catch { notify(bookId, { running: false, phase: '机械合并已停稳', processed: 0, total: 0, error: errorMessage ?? '队列已停稳，请重新读取进度。', reportId: runId, reportType: 'code' }) }
      }
    }
  }
  async function start(bookId: string) {
    if (active.has(bookId) || aiRunning(bookId)) throw new AssetError('ASSET_DOMAIN_LOCKED', '本书正在处理，请等待结束。')
    await locked(bookId, () => execute(bookId))
  }
  async function mergeExactNames(bookId: string) {
    if (active.has(bookId) || aiRunning(bookId)) throw new AssetError('ASSET_DOMAIN_LOCKED', '本书正在处理，请等待结束。')
    return locked(bookId, async () => {
      const db = dbFor(bookId)
      const snapshot = await db.transaction('r', db.table('characters'), db.table('locations'), db.table('pipelineRuns'), async () => ({ characters: await db.table<Character>('characters').toArray(), locations: await db.table<LocationAsset>('locations').toArray(), run: await latest(bookId) }))
      const byId = new Map<string, Character | LocationAsset>([...snapshot.characters.map(row => [`character:${row.id}`, row] as const), ...snapshot.locations.map(row => [`location:${row.id}`, row] as const)])
      const previous = snapshot.run?.mechanicalQueue?.items ?? []
      const reserved = new Set(previous.filter(item => item.status !== 'completed' && (item.request.memberIds.some(id => !byId.has(`${item.kind}:${id}`)) || new Set(item.request.memberIds.map(id => byId.get(`${item.kind}:${id}`)?.name.trim())).size !== 1)).flatMap(item => item.request.memberIds.map(id => `${item.kind}:${id}`)))
      const groups = [...findExactNameGroups('character', snapshot.characters.filter(row => !reserved.has(`character:${row.id}`))), ...findExactNameGroups('location', snapshot.locations.filter(row => !reserved.has(`location:${row.id}`)))]
      const prepared: MechanicalQueueItem[] = [], replaced = new Set<string>()
      for (let index = 0; index < groups.length; index += 3) prepared.push(...await Promise.all(groups.slice(index, index + 3).map(async group => {
        const members = group.memberIds.map(id => byId.get(`${group.kind}:${id}`)!)
        const overlaps = previous.filter(item => item.status !== 'completed' && item.kind === group.kind && item.request.memberIds.some(id => group.memberIds.includes(id)))
        overlaps.forEach(item => replaced.add(item.id))
        const prior = overlaps.find(item => group.memberIds.includes(item.request.keepId))
        const protectedRows = members.filter(row => row.manualKeep)
        const keepId = prior?.request.keepId ?? (protectedRows.length === 1 ? protectedRows[0].id : [...members].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))[0].id)
        return { id: prior?.id ?? crypto.randomUUID(), kind: group.kind, request: { memberIds: group.memberIds, keepId, canonicalName: prior?.request.canonicalName ?? members[0].name.trim(), expectedRevisions: Object.fromEntries(members.map(row => [row.id, row.revision])) }, memberNames: members.map(row => row.name), approvalFingerprints: Object.fromEntries(await Promise.all(members.map(async row => [row.id, await coverageFingerprint(group.kind === 'character' ? 'characters' : 'locations', row as unknown as Row)]))), status: 'pending' as const, confirmedAt: new Date().toISOString(), confirmation: 'exact_name' as const }
      })))
      if (prepared.length) await db.transaction('rw', db.tables, async () => {
        await available(bookId)
        let run = await latest(bookId)
        if (run?.id !== snapshot.run?.id || canonical(run?.mechanicalQueue?.items) !== canonical(snapshot.run?.mechanicalQueue?.items)) throw new AssetError('CONFLICT', '待合并队列已更新，请重新点击代码整理。')
        for (const item of prepared) {
          const current = await db.table(item.kind === 'character' ? 'characters' : 'locations').bulkGet(item.request.memberIds)
          if (current.some((row, index) => !row || row.revision !== item.request.expectedRevisions[item.request.memberIds[index]])) throw new AssetError('CONFLICT', '同名资料已变化，请重新点击代码整理。')
        }
        if (!run || run.mechanicalQueue!.items.every(item => item.status === 'completed') && !run.mechanicalQueue!.statisticsPending && run.mechanicalQueue!.items.length) {
          if (run) await db.table('pipelineRuns').put({ ...run, mechanicalQueue: { ...run.mechanicalQueue!, current: false } })
          run = freshRun(bookId, { characters: snapshot.characters.length, locations: snapshot.locations.length })
        }
        const items = [...run.mechanicalQueue!.items.filter(item => !replaced.has(item.id)), ...prepared]
        await db.table('pipelineRuns').put({ ...run, status: 'paused', mechanicalQueue: { ...run.mechanicalQueue!, items, stopRequested: false }, report: { ...run.report, status: 'paused', failed: failures(items) } })
      })
      if (prepared.length || snapshot.run?.mechanicalQueue?.statisticsPending) await execute(bookId, new Set(prepared.map(item => item.id)))
      const saved = await read(bookId), selected = new Set(prepared.map(item => item.id))
      return { merged: saved.items.filter(item => selected.has(item.id) && item.status === 'completed').length, failed: saved.items.filter(item => selected.has(item.id) && item.status === 'failed').length }
    })
  }
  return { read, add, remove, start, stop, recover, mergeExactNames, isRunning: (bookId: string) => active.has(bookId) }
}
