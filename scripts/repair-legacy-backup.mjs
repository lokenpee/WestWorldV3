import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('用法：node scripts/repair-legacy-backup.mjs <输入.wwv2> <输出.wwv2>')

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { inspectBackup, encodeBackup, restoredTables } = await server.ssrLoadModule('/src/features/backup/codec.ts')
  const { validateBookData } = await server.ssrLoadModule('/src/features/backup/data.ts')
  const { convertLegacyRelations } = await server.ssrLoadModule('/src/features/assets/legacyRelations.ts')
  const inspected = await inspectBackup(new Uint8Array(fs.readFileSync(input)))
  if (!inspected.ok || !inspected.data) throw new Error(inspected.errors.map(error => `${error.path}：${error.message}`).join('；'))
  const data = inspected.data
  const characters = data.tables.characters
  const lifecycle = data.tables.assetLifecycle
  const archives = data.tables.legacyRelationRecords
  const edits = data.tables.characterRelationEdits

  const mappings = new Map(lifecycle.filter(row => row.kind === 'character').map(row => [row.originId, row]))
  function resolveId(id) {
    if (!id) return null
    const seen = new Set()
    let current = id
    for (;;) {
      if (seen.has(current)) return null
      seen.add(current)
      const mapping = mappings.get(current)
      if (!mapping) return current
      if (mapping.state === 'deleted') return null
      const next = mapping.currentId || mapping.originId
      if (mapping.state !== 'merged' || next === current) return next
      current = next
    }
  }
  const known = new Set(characters.map(row => row.id))
  const live = id => { const resolved = resolveId(id); return resolved && known.has(resolved) ? resolved : null }
  const nameIndex = new Map()
  for (const person of characters) for (const name of [person.name, ...(person.aliases ?? [])]) {
    const value = String(name ?? '').trim()
    if (!value) continue
    if (!nameIndex.has(value)) nameIndex.set(value, [])
    if (!nameIndex.get(value).includes(person.id)) nameIndex.get(value).push(person.id)
  }
  const activeEdits = edits.filter(row => row.state === 'active')
  const overrides = new Map()
  let byName = 0, byLabel = 0
  for (const archive of archives) {
    if (archive.disposition !== 'unresolved') continue
    const original = archive.original
    const left = original.left ?? {}, right = original.right ?? {}
    const leftId = live(left.characterId), rightId = live(right.characterId)
    if (!!leftId === !!rightId) continue
    const missing = leftId ? right : left
    const otherId = leftId || rightId
    const name = String(missing?.nameHint ?? '').trim()
    let target = (nameIndex.get(name) ?? []).length === 1 ? nameIndex.get(name)[0] : null
    if (target === otherId) target = null
    if (target) byName++
    if (!target) {
      const label = String(original.label ?? '').trim()
      if (label) {
        const candidates = new Set()
        for (const pair of activeEdits) {
          if (pair.aId !== otherId && pair.bId !== otherId) continue
          if (![...pair.aToBLabels, ...pair.bToALabels].includes(label)) continue
          candidates.add(pair.aId === otherId ? pair.bId : pair.aId)
        }
        if (candidates.size === 1) { target = [...candidates][0]; byLabel++ }
      }
    }
    if (target && target !== otherId) overrides.set(archive.id, leftId ? { rightId: target } : { leftId: target })
  }

  const relationRows = archives.map(archive => {
    const original = structuredClone(archive.original)
    const override = overrides.get(archive.id)
    if (override?.leftId) { original.left = { ...(original.left ?? {}), characterId: override.leftId, binding: 'manual' } }
    if (override?.rightId) { original.right = { ...(original.right ?? {}), characterId: override.rightId, binding: 'manual' } }
    return original
  })
  const timestamp = new Date().toISOString()
  const migrationId = `legacy-migration:${crypto.randomUUID()}`
  const converted = convertLegacyRelations({
    bookId: data.book.id, relations: relationRows, characters, lifecycle, edits: [],
    chapterTexts: data.tables.chapterTexts, timestamp, migrationId,
  })
  const missing = converted.edits.filter(row => row.state === 'active' && (!known.has(row.aId) || !known.has(row.bId)))
  if (missing.length) throw new Error(`仍有${missing.length}个人物对端点不存在。`)
  data.tables.characterRelations = converted.relations
  data.tables.characterRelationEdits = converted.edits
  data.tables.legacyRelationRecords = converted.legacyRecords
  data.tables.pipelineRuns = data.tables.pipelineRuns.filter(row => row.result?.kind !== 'legacy_relation_migration')
  data.tables.pipelineRuns.push({ id: migrationId, bookId: data.book.id, recordType: 'asset_edit', stage: 'asset_edit', status: 'completed', startedAt: timestamp, finishedAt: timestamp, planVersion: '2.2', result: converted.report })

  const exported = await encodeBackup(data)
  const target = path.resolve(output)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, exported.bytes)
  const rechecked = await inspectBackup(exported.bytes)
  if (!rechecked.ok) throw new Error(rechecked.errors.map(error => `${error.path}：${error.message}`).join('；'))
  const restored = await restoredTables(rechecked.data, 'verify-book')
  const restoreErrors = await validateBookData({ book: { ...rechecked.data.book, id: 'verify-book' }, tables: restored })
  if (restoreErrors.length) throw new Error(`恢复副本校验失败：${restoreErrors.slice(0, 3).map(error => `${error.path}：${error.message}`).join('；')}`)
  const counts = converted.report.counts
  console.log(JSON.stringify({ output: target, formatVersion: exported.manifest.formatVersion, bytes: exported.bytes.length, overrides: overrides.size, byName, byLabel, counts, activePairs: converted.edits.filter(row => row.state === 'active').length, deletedPairs: converted.edits.filter(row => row.state === 'deleted').length, unresolved: counts.unresolved, restoreCheck: 'ok' }, null, 2))
} finally {
  await server.close()
}
