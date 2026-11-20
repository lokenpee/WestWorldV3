import { useCallback, useState, type ComponentProps } from 'react'
import { useLiveResult, bookInterests } from '../../hooks/useLiveResult'
import { AssetEditor } from './AssetEditor'
import type { AssetService } from './service'
import { assetTables, type Asset, type AssetKind, type AssetSnapshot } from './types'
import { CharacterNetwork } from '../character-network/CharacterNetwork'
import { EventNetwork } from '../network/EventNetwork'
import type { Chapter } from '../../lib/storage/workspace'
import { MergeHistory } from './MergeHistory'

function assetViewInterests(bookId: string, kind: AssetKind) {
  const tables = kind === 'location' ? ['locations'] : kind === 'character' ? ['characters', 'characterRelations', 'characterRelationEdits'] : ['characters', 'nodes', 'eventLines', 'storyEvents']
  return bookInterests(bookId, [...tables, 'assetLifecycle'])
}
export function AssetDetails({ selectedId, confirmed, locks, ...props }: Omit<ComponentProps<typeof AssetEditor>, 'asset' | 'snapshot'> & { selectedId?: string; confirmed?: Asset; locks: AssetSnapshot['locks'] }) {
  const { service, bookId, kind } = props
  const [attempt, retry] = useState(0)
  const detailId = kind === 'character' ? undefined : selectedId
  const query = useCallback(() => service.readContent(bookId, { kind, selectedId: detailId }), [service, bookId, kind, detailId])
  const data = useLiveResult(query, attempt, assetViewInterests(bookId, kind))
  const [observed, setObserved] = useState<Asset>()
  if (data.status === 'loading') return <p role="status">正在读取资产详情…</p>
  if (data.status === 'error') return <div role="alert">{data.message}<button onClick={() => retry(value => value + 1)}>重新读取详情</button></div>
  const current = data.value[assetTables[kind]].find(row => row.id === selectedId)
  if (confirmed && current && current.revision >= confirmed.revision && observed !== confirmed) setObserved(confirmed)
  const asset = confirmed && observed !== confirmed && (!current || confirmed.revision > current.revision) ? confirmed : current
  return <AssetEditor key={selectedId ?? 'new'} {...props} asset={asset} snapshot={{ ...data.value, locks }} />
}

export function AssetNetwork({ bookId, service, kind, chapters, selectedId, active = true, onNavigate, onSelect, onClear }: {
  bookId: string; service: AssetService; kind: AssetKind; chapters: Chapter[]; selectedId?: string; active?: boolean
  onNavigate: (action: () => void) => void; onSelect: (id: string) => void; onClear: () => void
}) {
  const viewKind = kind === 'character' ? 'character' : 'node'
  const query = useCallback(() => service.readContent(bookId, { kind: viewKind, network: true }), [service, bookId, viewKind])
  const [attempt, retry] = useState(0)
  const data = useLiveResult(query, attempt, assetViewInterests(bookId, kind))
  if (data.status === 'loading') return <p role="status">正在读取网络…</p>
  if (data.status === 'error') return <div role="alert">{data.message}<button onClick={() => retry(value => value + 1)}>重新读取网络</button></div>
  return kind === 'character' ? <CharacterNetwork bookId={bookId} characters={data.value.characters} pairs={data.value.pairs} selectedId={selectedId} onSelect={id => onNavigate(() => onSelect(id))} />
    : <EventNetwork bookId={bookId} nodes={data.value.nodes} lines={data.value.eventLines} events={data.value.storyEvents} chapters={chapters} active={active} mode={kind === 'eventLine' ? 'eventLine' : 'node'} selectedId={kind === 'node' ? selectedId : undefined} onNavigate={onNavigate} onSelectNode={onSelect} onEditLine={onSelect} onClearSelection={onClear} />
}

export function AssetMergeHistory({ bookId, service, initialId, onClose }: { bookId: string; service: AssetService; initialId?: string; onClose: () => void }) {
  const query = useCallback(() => service.readMergeHistory(bookId), [service, bookId])
  const data = useLiveResult(query, 0, bookInterests(bookId, ['pipelineRuns'], 'merge'))
  if (data.status === 'loading') return <p role="status">正在读取合并记录…</p>
  if (data.status === 'error') return <p role="alert">{data.message}<button onClick={onClose}>关闭</button></p>
  return <MergeHistory runs={data.value} initialId={initialId} onClose={onClose} />
}
