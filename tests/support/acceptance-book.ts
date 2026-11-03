import { largeNetworkRows } from './character-network'
import type { BookData, BookTables } from '../../src/features/backup/data'
import { emptyTables } from '../../src/features/backup/data'
import { relationId } from '../../src/features/assets/relations'

/** 固定种子大图：2000人物、10000无自连人物对、100个孤立人物。 */
export function largeBookData(): BookData {
  const bookId = 'large-fixture'
  const chapters = [{ bookId, chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 4 }]
  const chapterTexts = [{ bookId, chapterIndex: '1', text: '样本正文' }]
  const { characters, characterRelationEdits: edits } = largeNetworkRows(bookId)
  const tables: BookTables = { ...emptyTables(), chapters, chapterTexts, characters, characterRelationEdits: edits }
  return { book: { id: bookId, title: '大图验收样本', sourceFileName: 'large.txt', createdAt: '2026-11-03T00:00:00.000Z' }, tables }
}

/** 验收固定小书：A/A2/B1–B3/C/D/E/F/G、关系R1/R2、地点、节点与事件线。 */
export function smallBookData(): BookData {
  const bookId = 'workbench-fixture'
  const ch2 = '船夫张三是长女张蕾的父亲。李沁是张三的妻子。张三暗恋赵六，但赵六并不知情。'
  const ch5 = '商人张蕾与船夫张三没有亲缘关系。账房张三与船夫张三是不同的人。'
  const ch10 = '刺客张蕾杀害了张三的母亲。李沁在北京城的东门等候张三。'
  const chapters = [
    { bookId, chapterIndex: '1', chapterName: '第一章', order: 0, charCount: 7 },
    { bookId, chapterIndex: '2', chapterName: '第二章', order: 1, charCount: ch2.length },
    { bookId, chapterIndex: '5', chapterName: '第五章', order: 2, charCount: ch5.length },
    { bookId, chapterIndex: '10', chapterName: '第十章', order: 3, charCount: ch10.length },
  ]
  const chapterTexts = [
    { bookId, chapterIndex: '1', text: '序章正文内容。' }, { bookId, chapterIndex: '2', text: ch2 },
    { bookId, chapterIndex: '5', text: ch5 }, { bookId, chapterIndex: '10', text: ch10 },
  ]
  const character = (id: string, name: string, aliases: string[], identity: string, roleWeight: string, chapterIndex: string) => ({ id, bookId, name, aliases, identity, roleWeight, roleWeightSource: 'manual', revision: 1, confidence: 1, createdBy: 'P1', chapterIndex, chapterName: chapters.find(row => row.chapterIndex === chapterIndex)!.chapterName, sourceChapters: [chapterIndex] })
  const characters = [
    character('C1-P001', '张三', ['老张'], '船夫', '主要人物', '1'), character('C5-P003', '张三', ['账房张三'], '账房', 'NPC', '5'),
    character('C2-P002', '张蕾', ['长女'], '张三长女', '重要配角', '2'), character('C5-P001', '张蕾', ['商人张蕾'], '商人', 'NPC', '5'),
    character('C10-P002', '张蕾', ['刺客张蕾'], '刺客', '路人', '10'), character('C2-P001', '李沁', ['阿沁'], '张三之妻', '重要配角', '2'),
    character('C10-P003', '赵六', ['小六'], '过客', 'NPC', '10'), { ...character('C1-P004', '北京王', [], '贾府访客', 'NPC', '1'), background: '贾字背景' },
    character('C1-P005', '贾明', ['小贾'], '邻居', 'NPC', '1'), character('C1-P006', '王五', ['贾老板'], '店主', 'NPC', '1'),
  ]
  const relations = [
    { id: relationId({ bookId, originCharacterId: 'C1-P001', targetName: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '女儿', direction: 'directed', chapterIndex: '2' }), bookId, originCharacterId: 'C1-P001', sourceName: '张三', targetName: '张蕾', relationType: 'parent_child', forwardLabel: '父亲', reverseLabel: '女儿', direction: 'directed', evidence: [{ chapterIndex: '2', quote: '船夫张三是长女张蕾的父亲' }], sourceId: 'C1-P001', targetIds: ['C2-P002', 'C5-P001', 'C10-P002'], revision: 1, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' },
    { id: relationId({ bookId, originCharacterId: 'C1-P001', targetName: '李沁', relationType: 'spouse', forwardLabel: '丈夫', reverseLabel: '妻子', direction: 'bidirectional', chapterIndex: '2' }), bookId, originCharacterId: 'C1-P001', sourceName: '张三', targetName: '李沁', relationType: 'spouse', forwardLabel: '丈夫', reverseLabel: '妻子', direction: 'bidirectional', evidence: [{ chapterIndex: '2', quote: '李沁是张三的妻子' }], sourceId: 'C1-P001', targetIds: ['C2-P001'], revision: 1, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' },
  ]
  const locations = [{ bookId, id: 'C10-L001', name: '北京城', description: '西门', revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '10', chapterName: '第十章', sourceChapters: ['10'] }]
  const nodes = [
    { bookId, id: 'C2-N001', name: '父女相认', summary: '张三与张蕾相认', chapterIndex: '2', chapterName: '第二章', actors: ['张三', '张蕾'], actorIds: ['C1-P001', 'C2-P002', 'C5-P001', 'C10-P002'], targets: [], targetCharacterIds: [], quote: '船夫张三是长女张蕾的父亲。', offset: 0, order: 0, revision: 1, confidence: 1, createdBy: 'P1', eventLineIds: ['E1'] },
    { bookId, id: 'C10-N002', name: '东门等候', summary: '李沁在东门等候', chapterIndex: '10', chapterName: '第十章', actors: ['李沁'], actorIds: ['C2-P001'], targets: ['张三'], targetCharacterIds: ['C1-P001'], quote: '李沁在北京城的东门等候张三。', offset: 0, order: 0, revision: 1, confidence: 1, createdBy: 'P1', eventLineIds: ['E1'] },
  ]
  const eventLines = [{ bookId, id: 'E1', title: '张三与李沁', nodeIds: ['C2-N001', 'C10-N002'], chapters: ['2', '10'], cause: '', process: '', result: '', lineStatus: 'open', revision: 1, createdBy: 'P3', updatedAt: '2026-11-03T00:00:00.000Z' }]
  const lifecycle = [
    ...characters.map(row => ({ key: `character:${row.id}`, bookId, kind: 'character', originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: '2026-11-03T00:00:00.000Z' })),
    ...locations.map(row => ({ key: `location:${row.id}`, bookId, kind: 'location', originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: '2026-11-03T00:00:00.000Z' })),
    ...nodes.map(row => ({ key: `node:${row.id}`, bookId, kind: 'node', originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: '2026-11-03T00:00:00.000Z' })),
    ...eventLines.map(row => ({ key: `eventLine:${row.id}`, bookId, kind: 'eventLine', originId: row.id, currentId: row.id, state: 'live', revision: 1, updatedAt: '2026-11-03T00:00:00.000Z' })),
  ]
  return { book: { id: bookId, title: '人物关系验收样本', sourceFileName: 'workbench.txt', createdAt: '2026-11-03T00:00:00.000Z' }, tables: { ...emptyTables(), chapters, chapterTexts, characters, locations, nodes, eventLines, characterRelations: relations, assetLifecycle: lifecycle } as BookTables }
}
