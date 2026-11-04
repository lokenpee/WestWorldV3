import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { validateBookData } from '../src/features/backup/data'
import { encodeBackup } from '../src/features/backup/codec'
import { effectivePairs, paginateCharacterPairs } from '../src/features/assets/relations'
import type { Character, CharacterRelationEdit } from '../src/features/assets/types'
import { largeBookData, smallBookData } from './support/acceptance-book'

it('生成2000人物10000人物对的可导入验收包，数据完整且分页无遗漏', async () => {
  const data = largeBookData()
  expect(await validateBookData(data)).toEqual([])
  const characters = data.tables.characters as unknown as Character[]
  const edits = data.tables.characterRelationEdits as unknown as CharacterRelationEdit[]
  const pairs = effectivePairs([], edits, characters)
  expect(pairs.filter(pair => pair.state === 'active')).toHaveLength(10000)
  expect(characters.length).toBe(2000)
  const connected = new Set<string>()
  let offset: number | null = 0
  while (offset !== null) {
    const page = paginateCharacterPairs(pairs, characters, characters[0].id, offset, 50)
    for (const item of page.items) connected.add(item.pairKey)
    offset = page.nextOffset
  }
  expect(connected.size).toBe(1899)
  const exported = await encodeBackup(data)
  expect(exported.manifest.formatVersion).toBe(8)
  const folder = join(tmpdir(), 'westworld-acceptance')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, exported.fileName)
  writeFileSync(path, exported.bytes)
  console.log(`验收包已生成：${path}（${exported.bytes.length} bytes）`)
  expect(exported.bytes.length).toBeGreaterThan(0)
  const small = smallBookData()
  expect(await validateBookData(small)).toEqual([])
  const smallExport = await encodeBackup(small)
  const smallPath = join(folder, smallExport.fileName)
  writeFileSync(smallPath, smallExport.bytes)
  console.log(`小样本验收包已生成：${smallPath}（${smallExport.bytes.length} bytes）`)
  expect(await validateBookData(largeBookData())).toEqual([])
}, 60000)
