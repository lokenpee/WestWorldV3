import type { Chapter, createWorkspace } from '../../lib/storage/workspace'
import type { Character, CharacterRelation, CharacterRelationEdit, EventLine, EventNode, Lifecycle, LocationAsset } from '../assets/types'
import { dexieMergeStore, type Row } from '../assets/mergeCore'
import { invalidateAssetProgress, type AssetChange } from '../assets/invalidate'
import { syncRelations } from '../assets/relations'
import type { Receipt, ReExtractScope, Run } from './recovery'

type Database = ReturnType<ReturnType<typeof createWorkspace>['openBook']>
const unique = (values: string[]) => [...new Set(values.filter(Boolean))]

export interface ReExtractCounts { characters: number; locations: number; relations: number; nodes: number; eventLines: number }

export async function previewReExtractData(db: Database, scope: ReExtractScope, chapters: Chapter[]): Promise<ReExtractCounts> {
  const chapterSet = scope.scope === 'all' ? new Set(chapters.map(row => row.chapterIndex)) : new Set([scope.chapterIndex ?? ''])
  const receipts = await db.table<Receipt>('extractionReceipts').toArray()
  const originIds = new Set(receipts.filter(row => row.substep === scope.step && chapterSet.has(row.chapterIndex)).flatMap(row => row.originIds))
  if (scope.step === 'worldAssets') {
    const people = await db.table<Character>('characters').toArray()
    const places = await db.table<LocationAsset>('locations').toArray()
    const lifecycle = await db.table<Lifecycle>('assetLifecycle').toArray()
    const affectedOrigins = new Set(lifecycle.filter(row => (scope.scope === 'all' && ['character', 'location'].includes(row.kind)) || originIds.has(row.originId) || (!!row.currentId && originIds.has(row.currentId))).map(row => row.originId))
    const removedIds = new Set([...people, ...places].filter(row => scope.scope === 'all' || originIds.has(row.id)).map(row => row.id))
    const relations = await db.table<CharacterRelation>('characterRelations').toArray()
    return {
      characters: scope.scope === 'all' ? people.length : people.filter(row => originIds.has(row.id)).length,
      locations: scope.scope === 'all' ? places.length : places.filter(row => originIds.has(row.id)).length,
      relations: scope.scope === 'all' ? relations.length : relations.filter(row => affectedOrigins.has(row.originCharacterId) || (!!row.sourceId && removedIds.has(row.sourceId))).length,
      nodes: 0, eventLines: 0,
    }
  }
  const nodes = await db.table<EventNode>('nodes').toArray()
  const removedNodes = new Set(nodes.filter(row => scope.scope === 'all' || originIds.has(row.id)).map(row => row.id))
  const lines = await db.table<EventLine>('eventLines').toArray()
  return {
    characters: 0, locations: 0, relations: 0,
    nodes: removedNodes.size,
    eventLines: scope.scope === 'all' ? lines.length : lines.filter(line => line.nodeIds.some(id => removedNodes.has(id))).length,
  }
}

/** 清空重提范围的资产、凭证和下游结果；调用方负责事务与进度写入。 */
export async function clearReExtractData(db: Database, scope: ReExtractScope, chapters: Chapter[], timestamp: string) {
  const chapterSet = scope.scope === 'all' ? new Set(chapters.map(row => row.chapterIndex)) : new Set([scope.chapterIndex ?? ''])
  const all = scope.scope === 'all'
  const receipts = await db.table<Receipt>('extractionReceipts').toArray()
  const scopedReceipts = receipts.filter(row => row.substep === scope.step && chapterSet.has(row.chapterIndex))
  const originIds = new Set(scopedReceipts.flatMap(row => row.originIds))
  const lifecycle = await db.table<Lifecycle>('assetLifecycle').toArray()
  const kinds = scope.step === 'worldAssets' ? ['character', 'location'] : ['node', 'eventLine']
  const affected = lifecycle.filter(row => all
    ? kinds.includes(row.kind)
    : originIds.has(row.originId) || (!!row.currentId && originIds.has(row.currentId)))
  for (const mapping of affected) {
    const { currentId: _currentId, ...rest } = mapping
    await db.table('assetLifecycle').put({ ...rest, state: 'deleted', revision: mapping.revision + 1, updatedAt: timestamp })
  }
  const affectedOrigins = new Set(affected.map(row => row.originId))
  const changes: AssetChange[] = []
  if (scope.step === 'worldAssets') {
    const people = await db.table<Character>('characters').toArray()
    const places = await db.table<LocationAsset>('locations').toArray()
    const removedPeople = all ? people : people.filter(row => originIds.has(row.id))
    const removedPlaces = all ? places : places.filter(row => originIds.has(row.id))
    const removedIds = new Set(removedPeople.map(row => row.id))
    if (removedPeople.length) await db.table('characters').bulkDelete([...removedIds])
    if (removedPlaces.length) await db.table('locations').bulkDelete(removedPlaces.map(row => row.id))
    if (all) {
      await db.table('characterRelations').clear()
      await db.table('characterRelationEdits').clear()
      await db.table('legacyRelationRecords').clear()
    } else {
      const relations = await db.table<CharacterRelation>('characterRelations').toArray()
      const removedRelations = relations.filter(row => affectedOrigins.has(row.originCharacterId) || (!!row.sourceId && removedIds.has(row.sourceId)))
      if (removedRelations.length) await db.table('characterRelations').bulkDelete(removedRelations.map(row => row.id))
      const surviving = relations.filter(row => !removedRelations.some(removed => removed.id === row.id))
      const currentPeople = await db.table<Character>('characters').toArray()
      const currentLifecycle = await db.table<Lifecycle>('assetLifecycle').toArray()
      const synced = syncRelations(surviving, currentPeople, currentLifecycle, timestamp)
      if (synced.changed.length) await db.table('characterRelations').bulkPut(synced.changed)
      for (const relation of synced.changed) for (const id of [relation.sourceId, ...relation.targetIds]) if (id) changes.push({ kind: 'character', id })
      const edits = await db.table<CharacterRelationEdit>('characterRelationEdits').toArray()
      const removedEdits = edits.filter(row => removedIds.has(row.aId) || removedIds.has(row.bId))
      if (removedEdits.length) await db.table('characterRelationEdits').bulkDelete(removedEdits.map(row => row.pairKey))
    }
    const nodes = await db.table<EventNode>('nodes').toArray()
    const strip = (values?: string[]) => values?.filter(id => !removedIds.has(id))
    for (const node of nodes) {
      const next: EventNode = {
        ...node,
        actorIds: strip(node.actorIds) ?? [], targetCharacterIds: strip(node.targetCharacterIds) ?? [],
        manualActorIds: strip(node.manualActorIds), manualTargetCharacterIds: strip(node.manualTargetCharacterIds),
        legacyActorIds: strip(node.legacyActorIds), legacyTargetCharacterIds: strip(node.legacyTargetCharacterIds),
        actorBindings: node.actorBindings?.map(group => ({ ...group, ids: group.ids.filter(id => !removedIds.has(id)) })),
        targetBindings: node.targetBindings?.map(group => ({ ...group, ids: group.ids.filter(id => !removedIds.has(id)) })),
      }
      if (JSON.stringify(next) !== JSON.stringify(node)) {
        await db.table('nodes').put({ ...next, revision: node.revision + 1 })
        changes.push({ kind: 'node', id: node.id })
      }
    }
    for (const id of removedIds) changes.push({ kind: 'character', id })
    for (const row of removedPlaces) changes.push({ kind: 'location', id: row.id })
    for (const receipt of scopedReceipts) await db.table('extractionReceipts').delete(receipt.key)
    if (all) {
      const runs = await db.table<Run>('pipelineRuns').where('stage').equals('P2').toArray()
      for (const run of runs) await db.table('pipelineRuns').delete(run.id)
      await db.table('compileProgress').delete('P2')
      const p3 = await db.table<{ validity?: string; updatedAt?: string }>('compileProgress').get('P3')
      if (p3) await db.table('compileProgress').put({ ...p3, validity: 'stale', updatedAt: timestamp })
    } else {
      const runs = await db.table<Run>('pipelineRuns').toArray()
      await invalidateAssetProgress(dexieMergeStore(db), changes, timestamp, runs as unknown as Row[])
    }
  } else {
    const nodes = await db.table<EventNode>('nodes').toArray()
    const removedNodes = all ? nodes : nodes.filter(row => originIds.has(row.id))
    const removedNodeIds = new Set(removedNodes.map(row => row.id))
    const lines = await db.table<EventLine>('eventLines').toArray()
    if (all) {
      for (const line of lines) await db.table('eventLines').delete(line.id)
      for (const node of removedNodes) await db.table('nodes').delete(node.id)
      const runs = await db.table<Run>('pipelineRuns').where('stage').equals('P3').toArray()
      for (const run of runs) await db.table('pipelineRuns').delete(run.id)
      await db.table('compileProgress').delete('P3')
      for (const table of ['storyEditorMemory', 'storyEditorNotes', 'storyEditorCheckpoints']) await db.table(table).clear()
    } else {
      for (const line of lines) {
        const remaining = line.nodeIds.filter(id => !removedNodeIds.has(id))
        if (remaining.length === line.nodeIds.length) continue
        if (!remaining.length) {
          await db.table('eventLines').delete(line.id)
          const mapping = await db.table<Lifecycle>('assetLifecycle').get(`eventLine:${line.id}`)
          if (mapping) await db.table('assetLifecycle').put({ ...mapping, state: 'deleted', revision: mapping.revision + 1, updatedAt: timestamp })
          changes.push({ kind: 'eventLine', id: line.id })
          continue
        }
        const members = await db.table<EventNode>('nodes').bulkGet(remaining)
        const times = members.map(row => row?.timeCoord).filter((value): value is string => !!value).sort()
        const next: EventLine = { ...line, nodeIds: remaining, chapters: unique(members.map(row => row?.chapterIndex ?? '')), revision: line.revision + 1, updatedAt: timestamp }
        if (times.length) next.timeRange = [times[0], times[times.length - 1]]
        else delete next.timeRange
        await db.table('eventLines').put(next)
        changes.push({ kind: 'eventLine', id: line.id })
      }
      for (const node of removedNodes) await db.table('nodes').delete(node.id)
      const survivingLines = await db.table<EventLine>('eventLines').toArray()
      for (const node of await db.table<EventNode>('nodes').toArray()) {
        const eventLineIds = survivingLines.filter(line => line.nodeIds.includes(node.id)).map(line => line.id).sort()
        if (JSON.stringify(eventLineIds) !== JSON.stringify(node.eventLineIds ?? [])) {
          await db.table('nodes').put({ ...node, eventLineIds, revision: node.revision + 1 })
          changes.push({ kind: 'node', id: node.id })
        }
      }
      for (const id of removedNodeIds) changes.push({ kind: 'node', id })
      const runs = await db.table<Run>('pipelineRuns').toArray()
      await invalidateAssetProgress(dexieMergeStore(db), changes, timestamp, runs as unknown as Row[])
    }
    for (const receipt of scopedReceipts) await db.table('extractionReceipts').delete(receipt.key)
  }
  return { changes }
}
