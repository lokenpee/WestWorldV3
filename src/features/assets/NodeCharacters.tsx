import { useState } from 'react'
import { characterCandidates } from './characterLinks'
import { memberIds } from './form'
import type { Character } from './types'

export function NodeCharacters({ characters, ids, names, disabled, error, onChange }: {
  characters: Character[]; ids: string[]; names: string; disabled: boolean; error?: string
  onChange: (ids: string[], names: string) => void
}) {
  const [search, setSearch] = useState('')
  const pending = [...new Set(memberIds(names))]
  const normalized = search.trim().toLocaleLowerCase()
  const visible = characters.filter(person => [person.name, ...(person.aliases ?? []), person.identity ?? '', person.id].some(value => value.toLocaleLowerCase().includes(normalized)))
  const select = (person: Character, checked: boolean) => {
    const next = checked ? [...new Set([...ids, person.id])] : ids.filter(id => id !== person.id)
    const retained = checked ? pending.filter(name => !characterCandidates(name, characters).includes(person.id)) : pending
    onChange(next, retained.join('\n'))
  }
  return <fieldset className="node-characters" disabled={disabled}>
    <legend>涉及人物</legend>
    <p className="field-help">选择与这件事有关的人物。物品、地点及谁对谁做了什么，请写在概述或详细经过中。</p>
    <p className="node-character-count">已选 {ids.length} 人</p>
    <ul className="selected-characters" aria-label="已选人物">
      {ids.length === 0 && <li className="field-help">尚未选择人物</li>}
      {ids.map(id => {
        const person = characters.find(row => row.id === id)
        return <li className="selected-character" key={id}><span>{person?.name ?? '人物已删除'}<small>{person?.identity || id}</small></span><button type="button" className="text-button" aria-label={`移除人物 ${person?.name ?? id} ${id}`} onClick={() => onChange(ids.filter(value => value !== id), names)}>移除</button></li>
      })}
    </ul>
    <div className="asset-field"><label htmlFor="node-character-search">搜索人物</label><input id="node-character-search" value={search} placeholder="姓名、别名或身份" onChange={event => setSearch(event.target.value)} /></div>
    <p className="node-character-count">匹配 {visible.length} 人</p>
    <ul className="node-character-options" aria-label="人物搜索结果">
      {visible.map(person => <li key={person.id}><label><input type="checkbox" aria-label={`选择人物 ${person.name} ${person.identity || person.id} ${person.id}`} checked={ids.includes(person.id)} onChange={event => select(person, event.target.checked)} /><span>{person.name}<small>{person.identity || '身份未填写'} · {person.id}</small></span></label></li>)}
      {visible.length === 0 && <li className="field-help">没有匹配的人物，可在下方补充人物称呼。</li>}
    </ul>
    <div className="asset-field"><label htmlFor="node-unlinked-characters">补充人物称呼</label><textarea id="node-unlinked-characters" rows={2} value={names} placeholder="资料中找不到的人物，每行一个称呼" onChange={event => onChange(ids, event.target.value)} /></div>
    {pending.map(name => {
      const candidates = characterCandidates(name, characters).map(id => characters.find(person => person.id === id)).filter((person): person is Character => !!person)
      if (candidates.some(person => ids.includes(person.id))) return null
      return <p className="field-help" key={name}>{candidates.length > 1 ? `同名人物：${name}，保存时将关联 ${candidates.length} 个编号。` : candidates.length === 1 ? `保存时关联：${name} → ${candidates[0].name}（${candidates[0].id}）` : `待关联：${name}，称呼会随节点保存。`}<button className="text-button" type="button" aria-label={`移除暂存称呼 ${name}`} onClick={() => onChange(ids, pending.filter(value => value !== name).join('\n'))}>移除</button></p>
    })}
    {error && <p className="field-error" role="alert">{error}</p>}
  </fieldset>
}
