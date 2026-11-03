/** 在原仓库 app/ 内执行：pnpm exec tsx --tsconfig tsconfig.app.json ../docs/reverse-prd/v2/scripts/extract-contracts.ts */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const app = path.join(root, 'app')
const out = path.dirname(here)
const require = createRequire(path.join(app, 'package.json'))
await import(pathToFileURL(require.resolve('fake-indexeddb/auto')).href)
const ts = (await import(pathToFileURL(require.resolve('typescript')).href)).default
const schemas = await import(pathToFileURL(path.join(app, 'src/core/schema/index.ts')).href)
const { createCompileTools } = await import(pathToFileURL(path.join(app, 'src/core/tools/compile-tools.ts')).href)
const stores = await import(pathToFileURL(path.join(app, 'src/core/db/stores.ts')).href)
const { getCanonDb } = await import(pathToFileURL(path.join(app, 'src/core/db/canon.ts')).href)
const split = await import(pathToFileURL(path.join(app, 'src/core/pipeline/split-chapters.ts')).href)
const { aliasSimilarity, twoPassAssetGroups } = await import(pathToFileURL(path.join(app, 'src/core/pipeline/asset-merge-policy.ts')).href)
const { assignFrequencyWeights } = await import(pathToFileURL(path.join(app, 'src/core/pipeline/character-merge-policy.ts')).href)
const { buildChapterTimeline } = await import(pathToFileURL(path.join(app, 'src/core/graph/chapter-timeline.ts')).href)
const resources = path.join(out, 'resources')
await fs.mkdir(resources, { recursive: true })
const json = async (name: string, value: unknown) => fs.writeFile(path.join(resources, name), JSON.stringify(value, null, 2) + '\n')
const dictionary = Object.fromEntries(Object.entries(schemas).filter(([name, value]) => name.endsWith('Schema') && value && typeof value === 'object'))
await json('schemas.json', dictionary)
await json('dynamic-schema-examples.json', {
  aliasInput: ['沈青', '青郎'], aliasResult: schemas.aliasGroupsSchemaFor(['沈青', '青郎']),
  optimizationInput: [{ id: 'C1-P001', name: '沈青', aliases: ['青郎'], facts: [{ id: 'F1' }, { id: 'F2' }] }],
  optimizationResult: schemas.characterOptimizationSchemaFor([{ id: 'C1-P001', name: '沈青', aliases: ['青郎'], facts: [{ id: 'F1' }, { id: 'F2' }] }]),
})
const tools: Record<string, unknown> = {}
for (const profile of ['asset_editor', 'story_editor'] as const) {
  tools[profile] = (await createCompileTools('__contract_extract__', { profile, sessionId: '' })).map(({ tool, kind, maxResults, maxBytes, returns }) => ({ ...tool, kind, maxResults, maxBytes, ...(returns ? { returns } : {}) }))
}
await json('tool-contracts.json', tools)
getCanonDb('__contract_extract__').close()
await json('stores.json', { legacy: stores.LEGACY_CANON_STORES, v3: stores.V3_CANON_STORES, v4: stores.CANON_STORES })

const walk = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat()
}
const srcFiles = (await walk(path.join(app, 'src'))).sort()
const printer = ts.createPrinter({ removeComments: true })
const signatures: Record<string, string[]> = {}
const ui: Record<string, unknown> = {}
for (const file of srcFiles.filter((f) => /\.tsx?$/.test(f))) {
  const raw = await fs.readFile(file, 'utf8')
  const parsed = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const key = path.relative(path.join(app, 'src'), file).replaceAll('\\', '/')
  const defs: string[] = []
  for (const stmt of parsed.statements) {
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) defs.push(printer.printNode(ts.EmitHint.Unspecified, stmt, parsed))
    if (ts.isFunctionDeclaration(stmt)) {
      const signature = raw.slice(stmt.getStart(parsed), stmt.body?.getStart(parsed) ?? stmt.end).trim()
      defs.push(signature + (stmt.body ? ';' : ''))
    }
  }
  if (defs.length) signatures[key] = defs
  if (key.startsWith('features/') && file.endsWith('tsx')) {
    const literals = new Set<string>(), styles = new Set<string>()
    const controls: unknown[] = []
    const visit = (node: import('typescript').Node) => {
      if (ts.isJsxText(node)) { const text = node.text.replace(/\s+/g, ' ').trim(); if (text) literals.add(text) }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(parsed)
        const attrs = Object.fromEntries(node.attributes.properties.filter((a) => ts.isJsxAttribute(a)).map((a) => [a.name.getText(parsed), a.initializer?.getText(parsed) ?? 'true']))
        if (attrs.className) styles.add(attrs.className)
        if (['button', 'input', 'select', 'textarea', 'ReactFlow', 'Controls', 'aside', 'section', 'div', 'label'].includes(tag)) {
          const clean = Object.fromEntries(Object.entries(attrs).filter(([name]) => !name.startsWith('on')))
          const events = Object.keys(attrs).filter((name) => name.startsWith('on'))
          controls.push({ tag, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, attributes: clean, events })
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const value = node.text
        if (/[\u3400-\u9fff]/u.test(value)) literals.add(value)
        if (node.parent && ts.isJsxAttribute(node.parent) && node.parent.name.getText(parsed) === 'className') styles.add(value)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    ui[key] = { copy: [...literals], classNames: [...styles], controls }
  }
}
await json('internal-contracts.json', signatures)
await json('ui-copy-and-styles.json', ui)
const templateModules = ['core/pipeline/p1.ts', 'core/pipeline/run-merge.ts', 'core/pipeline/run-link.ts', 'core/agent/run.ts', 'core/session/compaction.ts', 'core/session/pi-context.ts', 'core/llm/call.ts', 'core/config/settings.ts']
const templates: Record<string, unknown> = {}
for (const key of templateModules) {
  const file = path.join(app, 'src', key)
  const raw = await fs.readFile(file, 'utf8')
  const parsed = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true)
  const values: unknown[] = []
  const visit = (node: import('typescript').Node) => {
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || (ts.isStringLiteral(node) && /[\u3400-\u9fff]/u.test(node.text))) values.push({ line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, template: node.getText(parsed) })
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  templates[key] = values
}
await json('ai-message-templates.json', templates)
const normalRaw = await fs.readFile(path.join(app, 'src/core/pipeline/merge-characters.ts'), 'utf8')
const normalParsed = ts.createSourceFile('names.ts', normalRaw, ts.ScriptTarget.Latest, true)
const patterns: string[] = []
const collectRegex = (node: import('typescript').Node) => { if (ts.isRegularExpressionLiteral(node)) patterns.push(node.getText(normalParsed)); ts.forEachChild(node, collectRegex) }
collectRegex(normalParsed)
await json('algorithm-parameters.json', { normalization: { suffixReplacements: patterns.slice(0,6).map((regex) => ({regex,replacement:''})), whitespaceRegex:patterns[6], whitespaceReplacement:' ', lowerCaseBeforePunctuationStrip:true, punctuationRegex:patterns[7], punctuationReplacement:'', legacyQualityHeuristicExcluded:patterns[8] }, defaultChapterRegex: split.DEFAULT_CHAPTER_REGEX.toString(), numericDefaults: { chunkChars: 10000, fallbackChars: 4000, windowSize: 100, overlap: 20, aliasThresholdStrictlyGreater: 0.9, aliasBatchSize: 180, aliasStride: 160, nodeBatch: 400, reviewBatch: 30, maxSteps: 6, timeoutMs: 180000, toolMaxBytes: 65536 } })
const apiText = Object.entries(signatures).map(([name, defs]) => `## ${name}\n\n\`\`\`typescript\n${defs.join('\n\n')}\n\`\`\`\n`).join('\n')
await fs.writeFile(path.join(resources, 'internal-contracts.md'), '# 内部边界签名与类型\n\n参数初值属于契约。无显式返回类型的函数返回语义由详细Spec规定；本文件不包含业务函数体。\n\n' + apiText)
const goldenEntities = Array.from({ length: 20 }, (_, i) => ({ id: `C1-P${i}`, bookId: 'golden', chapterIndex: '1', chapterName: '一', name: `人物${String(i).padStart(2, '0')}`, confidence: 1 }))
assignFrequencyWeights(goldenEntities, goldenEntities.map((e, i) => ({ bookId: 'golden', chapterIndex: String(i + 1), text: Array(20 - i).fill(e.name).join(' ') })))
const samples = JSON.parse(await fs.readFile(path.join(resources, 'fixtures/graph-input.json'), 'utf8'))
await json('golden-results.json', {
  split: ['第一章 开始\n甲。\n第二章 结束\n乙。', '序言内容\n第一章 开始\n甲。', 'x'.repeat(4001)].map((text) => ({ input: text, result: split.splitChapters(text) })),
  regex: split.DEFAULT_CHAPTER_REGEX.toString(),
  alias: [{ a: ['甲'], b: ['甲'], value: aliasSimilarity(['甲'], ['甲']) }, { a: ['沈青', '青郎'], b: ['沈青'], value: aliasSimilarity(['沈青', '青郎'], ['沈青']) }],
  groups: twoPassAssetGroups([{ name: '甲', aliases: [] }, { name: '甲乙', aliases: [] }], { name: (x) => x.name, aliases: (x) => x.aliases }),
  weights: goldenEntities, graph: { input: samples, result: buildChapterTimeline(samples.lines, samples.nodes, samples.chapters) },
})
const hashes = []
for (const file of srcFiles) hashes.push({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') })
await fs.writeFile(path.join(out, 'evidence/source-hashes.json'), JSON.stringify(hashes, null, 2))
console.log(JSON.stringify({ schemas: Object.keys(dictionary).length, tools: Object.fromEntries(Object.entries(tools).map(([p, t]) => [p, (t as unknown[]).length])), modules: Object.keys(signatures).length, uiModules: Object.keys(ui).length, sourceFiles: hashes.length }))
