import { narrativeMaterial } from './support/agent-protocol'
import 'fake-indexeddb/auto'
import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import Dexie from 'dexie'
import { createWorkspace } from '../src/lib/storage/workspace'
import { createImportService } from '../src/lib/storage/importService'
import { createBackupService } from '../src/features/backup/service'
import { createNarrativeService } from '../src/features/story/narrativeService'
import { createModelService } from '../src/features/models/service'
import { defaultConfig } from '../src/features/models/types'
import type { Character, EventNode } from '../src/features/assets/types'
import { findExactNameGroups } from '../src/features/world/candidates'

for (const suffix of ['efba6291', '272245c9']) {
  const path = readdirSync('.').find((name) => name.endsWith(suffix + '.wwv2'))
  it.skipIf(!path || process.env.P3_SAMPLE_CHECK !== '1')(
    '格式12恢复后在本地核对首批人物绑定 ' + suffix,
    async () => {
      const prefix = 'p3-sample-' + crypto.randomUUID(),
        workspace = createWorkspace({ settingsName: prefix, bookPrefix: prefix + '-book-' })
      const importer = createImportService(workspace)
      try {
        const copy = await createBackupService(workspace, importer).importBackup(readFileSync(path!))
        const db = workspace.openBook(copy.id)
        const bound = async () =>
          (await db.table<EventNode>('nodes').get('C1-N004'))!.actorBindings?.find(
            (b) => b.mention === '贾珩'
          )?.ids ?? []
        const before = await bound(),
          places = await db.table('locations').toArray()
        const models = createModelService(workspace)
        await models.settings.save(
          {
            ...defaultConfig,
            providerId: 'custom',
            aggregationModel: 'fixture',
            baseUrl: 'https://fixture.invalid/v1',
          },
          'local-test'
        )
        let brief: { targets: EventNode[] } | undefined
        const service = createNarrativeService(workspace, {
          settings: models.settings,
          agent: async (input) => {
            brief = narrativeMaterial(input.prompt)
            throw Error('已取得本地首批输入')
          },
        })
        await service.start(copy.id)
        expect(brief, service.message(copy.id)).toBeDefined()
        expect(await db.table('nodes').count()).toBe(134)
        const after = await bound()
        expect(before.length).toBe(suffix === 'efba6291' ? 36 : 1)
        expect(after).toHaveLength(1)
        expect(before).toContain(after[0])
        expect(
          findExactNameGroups('character', await db.table<Character>('characters').toArray())
        ).toHaveLength(0)
        expect(await db.table('locations').toArray()).toEqual(places)
        expect(brief?.targets).toHaveLength(20)
        expect(brief?.targets.find((n) => n.id === 'C1-N004')?.actorIds).toContain(after[0])
        console.info(suffix, 'C1-N004 贾珩', before.length, '→', after.join('、'))
      } finally {
        importer.close()
        workspace.close()
        for (const name of await Dexie.getDatabaseNames())
          if (name.startsWith(prefix)) await Dexie.delete(name)
      }
    },
    180000
  )
}
