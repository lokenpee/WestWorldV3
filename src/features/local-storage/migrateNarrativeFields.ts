import type { DatabaseSync } from 'node:sqlite'
import { migrateNarrativeFields, type NarrativeTables } from '../assets/narrativeMigration.ts'

/** 在调用方的升级事务内转换资产并保留原主键。 */
export function migrateStoredNarrativeFields(database: DatabaseSync) {
  const select = database.prepare('SELECT recordKey,body FROM records WHERE scope=? AND tableName=?')
  const update = database.prepare('UPDATE records SET body=?,version=? WHERE scope=? AND tableName=? AND recordKey=?')
  const revision = Number(database.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value) + 1
  let changed = false
  const scopes = database.prepare("SELECT DISTINCT scope FROM records WHERE tableName IN ('nodes','storyEvents','eventLines')").all()
  for (const { scope } of scopes) {
    const tables: NarrativeTables = { nodes: [], storyEvents: [], eventLines: [], characters: [] }
    const originals = new Map<string,string>()
    for (const table of Object.keys(tables) as (keyof NarrativeTables)[]) {
      for (const record of select.all(scope, table)) {
        const body = String(record.body)
        tables[table].push(JSON.parse(body))
        originals.set(table + ':' + record.recordKey, body)
      }
    }
    migrateNarrativeFields(tables)
    for (const table of ['nodes','storyEvents','eventLines'] as const) {
      for (const row of tables[table]) {
        const body = JSON.stringify(row)
        if (body === originals.get(table + ':' + row.id)) continue
        update.run(body, revision, scope, table, String(row.id))
        changed = true
      }
    }
  }
  if (changed) {
    database.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(revision))
    database.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('lastSavedAt',?)").run(new Date().toISOString())
  }
}
