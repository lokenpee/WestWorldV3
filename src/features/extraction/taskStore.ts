import Dexie from 'dexie'
import type { ExtractionDatabase, ExtractionInput, ExtractionTask, Run, StoredTask } from './recovery'

export const extractionTaskId = (runId: string, taskId: string) => JSON.stringify([runId, taskId])

export async function createExtractionInput(bookId: string, text: string, createdAt = new Date().toISOString()): Promise<ExtractionInput> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const id = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return { id, bookId, text, createdAt }
}

async function saveInput(db: ExtractionDatabase, input: ExtractionInput) {
  const existing = await db.table<ExtractionInput>('extractionInputs').get(input.id)
  if (!existing) await db.table<ExtractionInput>('extractionInputs').add(input)
  else if (existing.bookId !== input.bookId || existing.text !== input.text) throw new Error('提取输入快照与正文不一致，已停止保存。')
}

/** 调用方将任务、快照、运行汇总放在同一写事务中。新任务的快照哈希在事务前计算。 */
export async function registerExtractionTask(db: ExtractionDatabase, run: Run, task: StoredTask, input: ExtractionInput) {
  if (run.taskStorage !== 'separate') throw new Error('旧提取任务尚未转换，无法登记新任务。')
  await saveInput(db, input)
  const stored: ExtractionTask = { ...task, id: extractionTaskId(run.id, task.taskId), bookId: run.bookId, runId: run.id, ordinal: run.nextTaskOrdinal ?? 0, input: { chapterIndex: task.input.chapterIndex, chapterName: task.input.chapterName, snapshotId: input.id } }
  await db.table<ExtractionTask>('extractionTasks').add(stored)
  await db.table('pipelineRuns').update(run.id, { nextTaskOrdinal: stored.ordinal + 1 })
  return stored
}

/** 旧正文和标题直接来自任务历史；转换失败时由调用方的事务完整回滚。 */
export async function migrateExtractionRun(db: ExtractionDatabase, run: Run): Promise<Run> {
  if (run.taskStorage === 'separate') return run
  const { tasks = [], ...summary } = run
  if (!Array.isArray(tasks) || tasks.some(task => typeof task?.taskId !== 'string' || !task.taskId || typeof task?.input?.text !== 'string' || typeof task.input.chapterIndex !== 'string' || typeof task.input.chapterName !== 'string')) throw new Error('旧提取任务缺少当时的正文或章节信息，原记录已保留，请检查备份。')
  const originals = new Map<string, string>()
  for (const task of tasks) if (!originals.has(task.input.text)) originals.set(task.input.text, task.createdAt)
  const inputs = new Map<string, ExtractionInput>()
  // 旧运行可能已在恢复事务内。waitFor只保持该IndexedDB事务存活，本机适配器下直接等待。
  await Dexie.waitFor(Promise.all([...originals].map(async ([text, createdAt]) => {
    inputs.set(text, await createExtractionInput(run.bookId, text, createdAt))
  })))
  for (const input of inputs.values()) await saveInput(db, input)
  const independent: ExtractionTask[] = tasks.map((task, index) => ({ ...task, id: extractionTaskId(run.id, task.taskId), bookId: run.bookId, runId: run.id, ordinal: Number.isSafeInteger(task.ordinal) ? task.ordinal : index, input: { chapterIndex: task.input.chapterIndex, chapterName: task.input.chapterName, snapshotId: inputs.get(task.input.text)!.id } }))
  if (independent.length) await db.table<ExtractionTask>('extractionTasks').bulkAdd(independent)
  const compact: Run = { ...summary, taskStorage: 'separate', nextTaskOrdinal: independent.reduce((next, task) => Math.max(next, task.ordinal + 1), run.nextTaskOrdinal ?? 0) }
  // update会先读取并合并旧行；put才能彻底移除历史正文数组。
  await db.table<Run>('pipelineRuns').put(compact)
  return compact
}

export async function readExtractionTasks(db: ExtractionDatabase, run: Run): Promise<(StoredTask | ExtractionTask)[]> {
  return run.taskStorage === 'separate'
    ? db.table<ExtractionTask>('extractionTasks').where('runId').equals(run.id).sortBy('ordinal')
    : run.tasks ?? []
}

export async function readExtractionInput(db: ExtractionDatabase, task: StoredTask | ExtractionTask) {
  if ('text' in task.input) return task.input
  const input = await db.table<ExtractionInput>('extractionInputs').get(task.input.snapshotId)
  if (!input) throw new Error('提取任务的原始输入快照缺失。')
  return { chapterIndex: task.input.chapterIndex, chapterName: task.input.chapterName, text: input.text }
}

export async function updateExtractionTask(db: ExtractionDatabase, runId: string, taskId: string, changes: Partial<StoredTask>) {
  const updated = await db.table('extractionTasks').update(extractionTaskId(runId, taskId), changes)
  if (!updated) throw new Error('当前提取任务记录缺失，结果尚未保存。')
}

export async function interruptExtractionTasks(db: ExtractionDatabase, run: Run, changes: Pick<StoredTask, 'status'> & Partial<Pick<StoredTask, 'updatedAt' | 'lastError'>>): Promise<Run> {
  const compact = await migrateExtractionRun(db, run)
  await db.table<ExtractionTask>('extractionTasks').where('[runId+status]').equals([run.id, 'running']).modify(changes)
  return compact
}
