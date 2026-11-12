import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, it } from 'vitest'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createImportService } from '../src/lib/storage/importService'
import { createBackupService } from '../src/features/backup/service'
import { createAssetService } from '../src/features/assets/service'
import { createModelService } from '../src/features/models/service'
import { createWorldService } from '../src/features/world/service'
import { defaultConfig } from '../src/features/models/types'
import { flushTraceWriters } from '../src/features/agents/trace'
import { projectExecution } from '../src/features/agents/executionChain'
import { effectivePairs, pairFromPerspective, pairKeyOf } from '../src/features/assets/relations'
import type { Character, CharacterPairResult, CharacterRelation, CharacterRelationEdit } from '../src/features/assets/types'

const opened: ReturnType<typeof createWorkspace>[] = []
const characterName = process.env.WESTWORLD_TEST_CHARACTER ?? '贾珩'
const key = (() => {
  if (process.env.WESTWORLD_TEST_API_KEY) return process.env.WESTWORLD_TEST_API_KEY
  try {
    const file = readFileSync('.env.local', 'utf8')
    return file.split(/\r?\n/).find(line => line.startsWith('WESTWORLD_TEST_API_KEY='))?.slice('WESTWORLD_TEST_API_KEY='.length) ?? ''
  } catch { return '' }
})()
const contentText = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part === 'object' && part && 'text' in part ? String((part as { text?: unknown }).text ?? '') : '').join('') : ''
const estimateTokens = (value: string) => {
  let weight = 0
  for (const char of value) weight += /[㐀-鿿぀-ヿ가-힯]/u.test(char) ? 1.5 : char.codePointAt(0)! > 127 ? 1 : 0.25
  return Math.ceil(weight)
}
const labelsOf = (pair: CharacterPairResult) => [...pair.forwardLabels, ...pair.reverseLabels]
const hasDuplicate = (labels: string[]) => labels.some((label, index) => labels.some((other, otherIndex) => index !== otherIndex && other.includes(label)))

afterEach(async () => {
  for (const workspace of opened.splice(0)) {
    workspace.close()
    for (const name of await Dexie.getDatabaseNames()) if (name === workspace.scope.settingsName || name.startsWith(workspace.scope.bookPrefix)) await Dexie.delete(name)
  }
})

it.skipIf(!key)('真实人物关系整理：分开验收程序、写库与关系质量，并记录最终值和真实顺序', async () => {
  const backupPath = process.env.WESTWORLD_JIAHENG_BACKUP ?? '红楼之挽天-三河帮-2026-11-08T14-09-20-514Z-575cf256.wwv2'
  const id = crypto.randomUUID(), workspace = createWorkspace({ settingsName: `live-jiaheng-${id}`, bookPrefix: `live-jiaheng-${id}-` })
  opened.push(workspace)
  const importer = createImportService(workspace)
  try {
    const book = await createBackupService(workspace, importer).importBackup(new Uint8Array(readFileSync(backupPath)))
    const db = workspace.openBook(book.id)
    const people = await db.table<Character>('characters').toArray()
    const target = people.find(row => row.name === characterName || row.id === characterName)
    if (!target) throw new Error(`样本中未找到人物：${characterName}`)
    const slug = target.name === '贾珩' ? 'jiaheng' : target.name === '戴权' ? 'daiquan' : target.name === '贾赦' ? 'jiashe' : target.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const models = createModelService(workspace, { fetch: globalThis.fetch.bind(globalThis), wait: async (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(signal.reason) }; signal.addEventListener('abort', abort, { once: true }) }) })
    await models.settings.save({ ...defaultConfig, providerId: process.env.WESTWORLD_TEST_PROVIDER ?? 'deepseek', baseUrl: process.env.WESTWORLD_TEST_BASE_URL ?? defaultConfig.baseUrl, aggregationModel: process.env.WESTWORLD_TEST_MODEL ?? 'deepseek-flash' }, key)
    const service = createWorldService(workspace, models, createAssetService(workspace), { assetReview: false })
    let started = false
    const finished = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('贾珩关系整理超时。')), 600000)
      const unsubscribe = service.subscribe(() => {
        const state = service.state(book.id)
        if (state?.running) started = true
        if (started && !state?.running) { clearTimeout(timeout); unsubscribe(); resolve() }
      })
    })
    const runId = await service.startCharacterOrganization(book.id, target.id, 'relations')
    await finished
    await flushTraceWriters()
    const run = await db.table('pipelineRuns').get(runId) as Record<string, unknown>
    const organization = run.organization as Record<string, unknown>
    const item = (organization.relationItems as Record<string, unknown>[]).find(row => row.id === target.id)
    const entries = (await db.table<Record<string, unknown>>('storySessionEntries').toArray()).filter(entry => entry.sessionId === run.sessionId)
    const traces = entries.filter(entry => entry.type === 'request_trace' && typeof entry.requestId === 'string')
      .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0) || Number(a.requestOrdinal ?? 0) - Number(b.requestOrdinal ?? 0) || String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
    type Initial = { bytes: number; estimatedTokens: number; relations: number; unlinkedRelations: unknown[]; hasEvidence: boolean; hasPairKey: boolean; maxIdentity: number; first?: Record<string, unknown> }
    let initial: Initial | undefined
    for (const trace of traces) {
      const input = trace.input && typeof trace.input === 'object' ? trace.input as Record<string, unknown> : {}
      const messages = Array.isArray(input.messages) ? input.messages as Record<string, unknown>[] : []
      for (const message of messages) {
        if (message.role !== 'user') continue
        try {
          const value = JSON.parse(contentText(message.content)) as Record<string, unknown>
          const work = value.work as Record<string, unknown> | undefined
          if (work?.kind === 'relations' && work.data) {
            const data = work.data as Record<string, unknown>
            const relations = Array.isArray(data.relations) ? data.relations as Record<string, unknown>[] : []
            initial = {
              bytes: new TextEncoder().encode(JSON.stringify(data)).length,
              estimatedTokens: estimateTokens(JSON.stringify(data)),
              relations: relations.length,
              unlinkedRelations: Array.isArray(data.unlinkedRelations) ? data.unlinkedRelations : [],
              hasEvidence: relations.some(row => 'evidence' in row),
              hasPairKey: relations.some(row => 'pairKey' in row),
              maxIdentity: Math.max(0, ...relations.map(row => String(row.identity ?? '').length)),
              first: relations[0],
            }
            break
          }
        } catch { /* 非任务消息 */ }
      }
      if (initial) break
    }
    const toolCalls: Record<string, unknown>[] = traces.flatMap(trace => Array.isArray(trace.toolCalls) ? (trace.toolCalls as Record<string, unknown>[]).map(call => ({ ...call, requestId: trace.requestId, ordinal: trace.ordinal, requestOrdinal: trace.requestOrdinal })) : [])
    const toolCounts = toolCalls.reduce<Record<string, number>>((counts, call) => { const name = String(call.name ?? ''); if (name) counts[name] = (counts[name] ?? 0) + 1; return counts }, {})
    const chain = await service.execution(book.id, runId)
    const projected = projectExecution(chain)
    const chainEvidence = {
      runId, status: run.status, runStartedAt: run.startedAt, runFinishedAt: run.finishedAt,
      entries: chain.entries,
      requests: chain.requests,
      snapshots: [...chain.snapshots.entries()].map(([snapshotId, row]) => ({ snapshotId, ...row })),
      events: projected.events.map(event => ({ key: event.key, kind: event.kind, role: event.role, content: event.content, thinking: event.thinking, toolCalls: event.toolCalls, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, apiIndex: event.apiIndex, entryId: event.entry.id, entryType: event.entry.type, execution: event.execution })),
      apiByToolCall: [...projected.apiByToolCall.entries()],
      toolCounts,
      note: 'P2 整理详情同款执行链：entries 为完整消息，requests 为每次 API 的完整输入/输出，snapshots 为 SYSTEM/业务提示词/工具 Schema。',
    }
    mkdirSync('test-results', { recursive: true })
    writeFileSync(`test-results/live-${slug}-execution-chain.json`, JSON.stringify(chainEvidence, null, 2))
    const reportEdits: Record<string, unknown>[] = (((run.report as Record<string, unknown> | undefined)?.assetEdits as Record<string, unknown>[] | undefined) ?? [])
      .filter(edit => edit.kind === 'relation')
      .map((edit, index) => ({ ...edit, writeSeq: Number(edit.writeSeq ?? index + 1) }))
      .sort((a, b) => a.writeSeq - b.writeSeq)
    const finalEditRows = await db.table<CharacterRelationEdit>('characterRelationEdits').toArray()
    const relationRows = await db.table<CharacterRelation>('characterRelations').toArray()
    const finalPairs = effectivePairs(relationRows, finalEditRows, people).filter(pair => pair.fromId === target.id || pair.toId === target.id)
    const pairOf = (targetId: string) => pairFromPerspective(finalPairs, target.id, targetId, people)
    const editOf = (targetId: string) => [...reportEdits].reverse().find(edit => String(edit.id) === pairKeyOf(target.id, targetId))
    const failures: string[] = []
    if (!item || item.status !== 'checked') failures.push(`程序未完成：${service.state(book.id)?.error ?? item?.reason ?? '无结论'}`)
    if (!initial) failures.push('没有找到初始关系工作项。')
    if (initial?.hasEvidence || initial?.hasPairKey) failures.push('初始关系概览仍含证据或pairKey。')
    if (Number(initial?.maxIdentity ?? 0) > 50) failures.push('关系身份超过50字。')
    if (target.name === '贾珩') {
      const yuanyang = labelsOf(pairOf('C3-P029'))
      if (yuanyang.some(label => label === '族中长辈' || label === '族中晚辈')) failures.push('鸳鸯仍被写成族中长辈/晚辈')
      const laijia = pairOf('C8-P014')
      if (labelsOf(laijia).some(label => /查问|讯问|审问|严查/.test(label))) {
        if (!/查问者|讯问者|审问者|严查者/.test(laijia.forwardLabels.join('、')) || !/被查问者|被讯问者|被审问者|被严查者/.test(laijia.reverseLabels.join('、'))) failures.push('赖家查问方向错误')
      }
      for (const targetId of ['C3-P023', 'C3-P024', 'C3-P026']) if (labelsOf(pairOf(targetId)).some(label => label.includes('族')) && String(editOf(targetId)?.evidenceStatus) !== 'verified') failures.push(`族亲缺少已核实证据：${targetId}`)
      if (labelsOf(pairOf('C2-P029')).some(label => ['主子', '主家', '学生'].includes(label)) && String(editOf('C2-P029')?.evidenceStatus) !== 'verified') failures.push('宋源具体关系缺少已核实证据')
      const jiamu = pairOf('C3-P021')
      if (hasDuplicate(jiamu.forwardLabels) || hasDuplicate(jiamu.reverseLabels)) failures.push('贾母仍有包含关系的重复标签')
      const caiquan = pairOf('C1-P037')
      if (labelsOf(caiquan).includes('未知')) failures.push('蔡权仍残留未知')
      if (new Set(labelsOf(caiquan)).size < 2) failures.push('蔡权独立关系维度被删空')
    }
    if (!finalPairs.length) failures.push('没有最终关系对')
    for (const edit of reportEdits) {
      if (edit.evidenceStatus !== 'unverified') continue
      const members = JSON.parse(String(edit.id)) as string[]
      const pairKey = String(edit.id)
      const check = (organization.pairChecks as Record<string, unknown>[]).find(row => row.pairKey === pairKey)
      if (!check || check.outcome !== 'uncertain') failures.push(`未核实修改未标记待核对：${members.join(' ↔ ')}`)
    }
    const ledger = ((run.requestLedger as Record<string, unknown>[] | undefined) ?? []).slice().sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) || Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0))
    const ledgerCost = ledger.reduce((sum, row) => sum + Number(row.cost ?? 0), 0)
    const ledgerTokens = ledger.reduce((sum, row) => sum + Number(row.totalTokens ?? 0), 0)
    const reportUsage = (run.report as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined
    const costDiff = Number(reportUsage?.cost ?? 0) - ledgerCost
    const tokenDiff = Number(reportUsage?.totalTokens ?? 0) - ledgerTokens
    if (ledger.length > 1 && new Set(ledger.map(row => String(row.finishedAt ?? ''))).size <= 1) failures.push('请求账本 finishedAt 全部相同')
    if (Math.abs(costDiff) > 1e-9) failures.push(`报告费用与账本差额 ${costDiff}`)
    if (Math.abs(tokenDiff) > 1e-9) failures.push(`报告token与账本差额 ${tokenDiff}`)
    const programCompleted = run.status === 'completed' && item?.status === 'checked'
    const writesApplied = reportEdits.filter(edit => ((edit.fieldChanges as unknown[] | undefined) ?? []).length > 0).length
    const qualityPassed = failures.length === 0
    const evidence = {
      book: book.title, character: { id: target.id, name: target.name }, runId, status: run.status, outcome: item?.outcome, reason: item?.reason, commitIds: item?.commitIds,
      program: { completed: programCompleted, status: run.status, itemStatus: item?.status, checked: (organization.relationItems as Record<string, unknown>[]).filter(row => row.status === 'checked').length, total: (organization.relationItems as Record<string, unknown>[]).length },
      write: { reportEditRecords: reportEdits.length, changedRecords: writesApplied, finalEditRows: finalEditRows.length, finalPairs: finalPairs.length, reportEdits },
      quality: { passed: qualityPassed, failures },
      initial, requests: traces.length,
      requestTimeline: traces.map(trace => ({ requestId: trace.requestId, requestOrdinal: trace.requestOrdinal, ordinal: trace.ordinal, startedAt: trace.startedAt, modelFinishedAt: trace.modelFinishedAt, finishedAt: trace.finishedAt, status: trace.status, attemptIds: trace.attemptIds, toolCalls: Array.isArray(trace.toolCalls) ? (trace.toolCalls as Record<string, unknown>[]).map(call => call.name) : [] })),
      toolCalls: toolCalls.map(call => ({ name: call.name, state: call.state, arguments: call.arguments, requestId: call.requestId, ordinal: call.ordinal, requestOrdinal: call.requestOrdinal })), toolCounts,
      usage: traces.map(trace => trace.usage).filter(Boolean), reportUsage, requestLedger: ledger, ledgerCost, ledgerTokens, costDiff, tokenDiff,
      finalRelationEdits: finalEditRows.map(row => ({ pairKey: row.pairKey, state: row.state, aToBLabels: row.aToBLabels, bToALabels: row.bToALabels, directionUnclear: row.directionUnclear, evidence: row.evidence, basis: row.basis, evidenceStatus: row.evidenceStatus, revision: row.revision, updatedAt: row.updatedAt, commitId: row.commitId })),
      finalPairs: finalPairs.map(pair => ({ pairKey: pair.pairKey, fromId: pair.fromId, toId: pair.toId, state: pair.state, forwardLabels: pair.forwardLabels, reverseLabels: pair.reverseLabels, directionUnclear: pair.directionUnclear, fingerprint: pair.fingerprint, evidenceCount: pair.evidence.length })),
      pairChecks: organization.pairChecks,
      error: service.state(book.id)?.error, note: '程序、写库、质量分开验收；最终值来自副本数据库，不使用 toolCalls 数组顺序当时间线。',
    }
    mkdirSync('test-results', { recursive: true })
    writeFileSync(`test-results/live-${slug}-relations.json`, JSON.stringify(evidence, null, 2))
    if (!programCompleted) throw new Error(`贾珩关系程序未完成：${service.state(book.id)?.error ?? item?.reason ?? '无结论'}`)
    if (!qualityPassed) throw new Error(`关系质量未通过：${failures.join('；')}`)
  } finally { importer.close() }
}, 540000)
