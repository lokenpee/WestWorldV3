export function largeNetworkRows(bookId: string) {
  const roles = ['主要人物', '重要配角', 'NPC', '路人'] as const
  const characters = Array.from({ length: 2000 }, (_, index) => ({
    id: `C1-P${String(index + 1).padStart(4, '0')}`, bookId, name: index < 100 ? `同名${index % 100}` : `人物${index}`,
    aliases: index % 37 === 0 ? [`别名${index}`] : [], roleWeight: roles[index < 100 ? 0 : index < 400 ? 1 : index < 1600 ? 2 : 3],
    roleWeightSource: 'frequency', revision: 1, confidence: 1, createdBy: 'P1', chapterIndex: '1', chapterName: '第一章', sourceChapters: ['1'],
  }))
  const edits: Record<string, unknown>[] = []
  const connected = 1900
  for (let a = 0; a < connected && edits.length < 10000; a++) for (let b = a + 1; b < connected && edits.length < 10000; b++) {
    const [aId, bId] = [characters[a].id, characters[b].id].sort()
    edits.push({
      pairKey: JSON.stringify([characters[a].id, characters[b].id].sort()), bookId, aId, bId, state: 'active',
      aToBLabels: edits.length % 2 ? ['朋友'] : ['同乡', '熟人'], bToALabels: edits.length % 2 ? ['朋友'] : ['熟人'],
      directionUnclear: false, evidence: [], sourceRelationIds: [], revision: 1, updatedAt: '2026-11-03T00:00:00.000Z',
      updatedBy: 'manual', commitId: `fixture-${edits.length}`,
    })
  }
  return { characters, characterRelationEdits: edits }
}
