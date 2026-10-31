import type { Asset, AssetInput, AssetKind, Character, EventLine, EventNode, LocationAsset, RoleWeight } from './types'
import { nodeParticipants, nodeProcess } from './characterLinks'

export const labels: Record<keyof AssetInput, string> = {
  participantIds: '涉及人物', unlinkedParticipants: '补充人物称呼',
  name: '名称', title: '标题', aliases: '别名', chapterIndex: '来源章节', manualSourceNote: '来源说明', identity: '身份', ageText: '年龄描述', appearance: '外貌', personality: '性格', background: '背景', speechStyleSample: '原话片段', roleWeight: '人物层级', description: '地点描述', summary: '概述', process: '详细经过', quote: '参考引文', actors: '行动人物', targets: '涉及对象', actorIds: '关联行动人物', targetCharacterIds: '关联对象人物', time_text: '明确时间', time_hint: '时间提示', world_delta: '状态变化', new_facts: '新增事实', started_actions: '开始的行动', nodeIds: '成员节点', cause: '起因', result: '结果', lineStatus: '事件线状态',
}
export type FormValues = Record<keyof AssetInput, string>
const split = (value: string) => value.split(/[,，\n]/).map(part => part.trim()).filter(Boolean)
export function formValues(asset?: Asset, characters: Character[] = []): FormValues {
  const values = Object.fromEntries(Object.keys(labels).map(key => [key, ''])) as FormValues
  values.roleWeight = 'NPC'; values.lineStatus = 'open'
  if (!asset) return values
  const world = asset as Character & LocationAsset
  const node = asset as EventNode
  const line = asset as EventLine
  const strings = ['name', 'title', 'chapterIndex', 'manualSourceNote', 'identity', 'appearance', 'personality', 'background', 'speechStyleSample', 'description', 'summary', 'process', 'quote', 'time_text', 'time_hint', 'cause', 'result', 'roleWeight', 'lineStatus'] as const
  for (const key of strings) {
    const value = (asset as unknown as Record<string, unknown>)[key]
    if (typeof value === 'string') values[key] = value
  }
  values.aliases = (world.aliases ?? []).join('，')
  values.ageText = world.profile?.ageText ?? ''
  values.actors = (node.actors ?? []).join('，'); values.targets = (node.targets ?? []).join('，')
  values.actorIds = (node.actorIds ?? []).join('\n'); values.targetCharacterIds = (node.targetCharacterIds ?? []).join('\n')
  for (const key of ['world_delta', 'new_facts', 'started_actions'] as const) values[key] = (node[key] ?? []).join('\n')
  values.nodeIds = (line.nodeIds ?? []).join('\n')
  if ('actors' in asset) {
    const participants = nodeParticipants(asset, characters)
    values.participantIds = participants.ids.join('\n')
    values.unlinkedParticipants = participants.names.join('\n')
    values.process = nodeProcess(asset, characters)
  }
  return values
}

export function formInput(kind: AssetKind, values: FormValues, creating: boolean): AssetInput {
  if (kind === 'character' || kind === 'location') {
    const base: AssetInput = { name: values.name, aliases: split(values.aliases), chapterIndex: values.chapterIndex, manualSourceNote: values.manualSourceNote }
    if (kind === 'location') return { ...base, description: values.description }
    return { ...base, identity: values.identity, ageText: values.ageText, appearance: values.appearance, personality: values.personality, background: values.background, speechStyleSample: values.speechStyleSample, ...(creating ? { roleWeight: values.roleWeight as RoleWeight } : {}) }
  }
  if (kind === 'node') return { name: values.name, summary: values.summary, chapterIndex: values.chapterIndex, quote: values.quote, process: values.process, participantIds: split(values.participantIds), unlinkedParticipants: split(values.unlinkedParticipants), time_text: values.time_text, time_hint: values.time_hint, world_delta: split(values.world_delta), new_facts: split(values.new_facts), started_actions: split(values.started_actions) }
  return { title: values.title, nodeIds: split(values.nodeIds), cause: values.cause, process: values.process, result: values.result, ...(creating ? { lineStatus: values.lineStatus as 'open' | 'closed' } : {}) }
}
export const memberIds = (value: string) => split(value)
