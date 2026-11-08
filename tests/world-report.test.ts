import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { WorldReportDialog } from '../src/features/world/WorldReportDialog'
import { emptyReport, type WorldRun } from '../src/features/world/types'
import { createOrganizationState } from '../src/features/world/organization'

const run = (id: string, phase: string): WorldRun => ({
  id, phase, bookId: 'report-test', recordType: 'run', stage: 'P2', status: 'completed',
  startedAt: '2026-11-04T01:00:00Z', finishedAt: '2026-11-04T01:01:00Z',
  report: { ...emptyReport({ characters: 0, locations: 0 }), status: 'completed' },
})

it.each([
  { codeId: 'a', aiId: 'z', expected: 'AI整理' },
  { codeId: 'z', aiId: 'a', expected: '代码整理' },
])('报告时间相同按编号选择默认分栏 $expected', ({ codeId, aiId, expected }) => {
  const html = renderToStaticMarkup(createElement(WorldReportDialog, {
    runs: [run(codeId, 'mechanical'), run(aiId, 'ai')], onClose: () => undefined,
  }))
  expect(html).toMatch(new RegExp(`role="tab" aria-selected="true"[^>]*>${expected}`))
})

it('指定运行优先于默认排序', () => {
  const html = renderToStaticMarkup(createElement(WorldReportDialog, {
    runs: [run('a', 'mechanical'), run('z', 'ai')], initialId: 'a', onClose: () => undefined,
  }))
  expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>代码整理/)
  expect(html).toContain('编号 a')
})

it('未完成报告使用开始时间选择默认分栏', () => {
  const ai = run('a', 'ai')
  delete ai.finishedAt
  ai.startedAt = '2026-11-04T02:00:00Z'
  const html = renderToStaticMarkup(createElement(WorldReportDialog, {
    runs: [run('z', 'mechanical'), ai], onClose: () => undefined,
  }))
  expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>AI整理/)
})

it.each(['scan', 'relations', 'finalize', 'done'] as const)('人物整理%s步骤按实际完成状态展示统计，兼容旧报告误标', step => {
  const ai = run('organization', 'character_organization')
  ai.organization = { ...createOrganizationState([]), step, statisticsPending: step === 'finalize' }
  ai.report.organizationSummary = { scannedPages: 2, candidateGroups: 4, merged: 3, uncertain: 0, profilesChecked: 138, relationsChecked: 24, statistics: 'completed' }
  const html = renderToStaticMarkup(createElement(WorldReportDialog, { runs: [ai], onClose: () => undefined }))
  expect(html).toContain(step === 'done' ? '出场统计已更新' : '出场统计待更新')
})

it('三步报告从真实工作项计算检查数，不使用旧摘要冒充优化人数', () => {
  const ai = run('review', 'character_organization')
  ai.organization = { ...createOrganizationState(['P1']), step: 'done', profileItems: [{ id: 'P1', name: '崇平帝', status: 'checked', outcome: 'no_change', reason: '完整资料无需修改', contentFingerprint: 'proof', readRefs: ['proof'], commitIds: [] }] }
  ai.report.organizationSummary = { scannedPages: 2, candidateGroups: 4, merged: 3, uncertain: 0, profilesChecked: 138, relationsChecked: 138, statistics: 'completed' }
  const html = renderToStaticMarkup(createElement(WorldReportDialog, { runs: [ai], onClose: () => undefined }))
  expect(html).toContain('第二步：整理人物资料 · 已完成')
  expect(html).toContain('已检查 1/1 人 · 实际修改 0 人')
  expect(html).not.toContain('资料优化 138')
  expect(html).not.toContain('全资产核对')
})

it('局部疑点与真实资料修改并列，报告展示修改前后和依据', () => {
  const ai = run('review', 'character_organization')
  ai.organization = { ...createOrganizationState(['P1']), step: 'relations', reviewStartedAt: '2026-11-05T00:00:00Z', profileItems: [{ id: 'P1', name: '崇平帝', status: 'checked', outcome: 'uncertain', reason: '重复已归纳，国号仍待核实', uncertainFields: ['identity'], contentFingerprint: 'proof', readRefs: ['proof'], commitIds: ['edit-1'] }] }
  ai.report.assetEdits = [{ commitId: 'edit-1', tool: 'edit_character', kind: 'character', id: 'P1', reason: '归纳重复并保留独有事实', fieldChanges: [{ field: 'identity', before: '皇帝；当朝皇帝；五子三女', after: '在位皇帝，膝下五子三女；国号待核实' }], evidence: [], basis: [{ summary: '完整身份底稿保留子女事实与国号分歧', source: { kind: 'asset', assetKind: 'character', id: 'P1' } }], timestamp: '2026-11-05T01:00:00Z', actor: 'agent' }]
  const html = renderToStaticMarkup(createElement(WorldReportDialog, { runs: [ai], onClose: () => undefined }))
  expect(html).toContain('实际修改 1 人')
  expect(html).toContain('已修改，仍有疑点')
  expect(html).toContain('修改前：皇帝；当朝皇帝；五子三女')
  expect(html).toContain('修改后：在位皇帝，膝下五子三女；国号待核实')
  expect(html).toContain('依据：完整身份底稿保留子女事实与国号分歧')
  expect(html).toContain('第三步：整理人物关系 · 进行中')
})
