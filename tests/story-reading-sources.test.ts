import { expect, it } from 'vitest'
import { createMemoryAgentRepository } from '../src/features/agents/repository'
import { navigateStoryReading, readingBrief, readingProgress, refreshReading, saveReading } from '../src/features/story/reading'

it('两页分别关联不同原章，改动一章只撤销对应页，重读后保存新原文依据', async () => {
  const chapters = ['1', '2'].map((chapterIndex, order) => ({ bookId: 'book', chapterIndex, order }))
  const chapterTexts = chapters.map(chapter => ({ bookId: 'book', chapterIndex: chapter.chapterIndex, text: `第${chapter.chapterIndex}章原文：书信正在传递。` }))
  const nodes = chapters.flatMap(chapter => Array.from({ length: 10 }, (_, order) => ({
    id: `C${chapter.chapterIndex}-N${order}`, bookId: 'book', chapterIndex: chapter.chapterIndex, order, revision: 1,
    name: `第${chapter.chapterIndex}章事件${order}`, summary: '书信传递取得新进展。',
  })))
  const repo = createMemoryAgentRepository('book', { chapters, chapterTexts, nodes, pipelineRuns: [{ id: 'run', bookId: 'book' }] })
  const scope = { bookId: 'book', runId: 'run', taskId: 'task', sessionId: 'session', phase: 'window_link' }
  const refresh = () => repo.transaction(true, async store => {
    const state = await refreshReading(store, scope.runId, scope.sessionId, scope.phase)
    await saveReading(store, scope.runId, scope.phase, state)
    return state
  })
  const move = (callId: string, currentPageId: string) => repo.transaction(true, store => navigateStoryReading(store, scope, { direction: 'next', currentPageId }, callId))
  const initial = await refresh()
  expect(initial.pages).toHaveLength(2)
  expect(initial.pages.map(page => page.ids)).toEqual([nodes.slice(0, 10).map(node => node.id), nodes.slice(10).map(node => node.id)])

  expect(await move('read-chapter-1', initial.pages[0].id)).toMatchObject({ complete: false, page: { page: { pageNumber: 2 } } })
  expect(await move('read-chapter-2', initial.pages[1].id)).toMatchObject({ complete: true, page: null })
  const checked = await refresh()
  expect(readingProgress(checked)).toMatchObject({ checked: 2, complete: true })
  expect(Object.keys(checked.pages[0].sourceFingerprints!)).toEqual(['1'])
  expect(Object.keys(checked.pages[1].sourceFingerprints!)).toEqual(['2'])

  await repo.transaction(true, store => store.put('chapterTexts', { ...chapterTexts[0], text: '修订后的第一章：书信被截获，尚未交付。' }))
  const changed = await refresh()
  expect(changed.pages.map(page => page.checkedFingerprint === page.fingerprint)).toEqual([false, true])
  expect(readingProgress(changed)).toMatchObject({ pageNumber: 1, checked: 1, complete: false })
  expect(changed.pages[1].sourceFingerprints).toEqual(checked.pages[1].sourceFingerprints)
  const resumed = await repo.transaction(false, store => readingBrief(store, scope.bookId, scope.sessionId, scope.phase, changed))
  expect(resumed).toMatchObject({ page: { id: initial.pages[0].id, pageNumber: 1 }, remainingCount: 1 })

  expect(await move('reread-chapter-1', changed.currentPageId!)).toMatchObject({ complete: true, page: null })
  const updated = await refresh()
  expect(readingProgress(updated)).toMatchObject({ checked: 2, complete: true })
  expect(updated.pages[0].sourceFingerprints?.['1']).not.toBe(checked.pages[0].sourceFingerprints?.['1'])
  expect(updated.pages[1].sourceFingerprints).toEqual(checked.pages[1].sourceFingerprints)
  expect(await repo.transaction(false, store => store.rows('nodes'))).toEqual(nodes)
})
