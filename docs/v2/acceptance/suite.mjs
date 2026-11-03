/** 可移植断言：不导入原应用，也不使用原算法计算预期。 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

function at(value, path) { return path.reduce((v, k) => v == null ? undefined : v[k], value) }
function resolve(value, context) {
  if (Array.isArray(value)) return value.map((v) => resolve(v, context))
  if (value && typeof value === 'object') {
    if ('$ref' in value) return at(context, value.$ref)
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,resolve(v,context)]))
  }
  return value
}
export async function runSuite(createHarness, definitions) {
  const cases = definitions ?? JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'))
  const report = { passed: 0, failed: 0, cases: [] }
  for (const test of cases) {
    const h = await createHarness()
    const context = {}
    try {
      await h.reset()
      if (test.seed) await h.load(structuredClone(test.seed))
      for (const [index, step] of test.steps.entries()) {
        if (step.command) {
          try { context.last = await h.execute(step.command, resolve(step.args ?? {}, context)); context.error = null }
          catch (error) { context.error = { message: error.message }; context.last = undefined; if (!step.allowError) throw error }
          if (step.saveAs) context[step.saveAs] = context.last
        }
        if (step.snapshot) context.snapshot = await h.snapshot(step.snapshot)
        for (const c of step.checks ?? []) {
          const actual = at(context, c.path)
          const label = `${test.id}/step${index+1}/${c.path.join('.')}`
          if ('equals' in c) assert.deepEqual(actual, resolve(c.equals, context), label)
          if ('length' in c) assert.equal(actual?.length, c.length, label)
          if ('match' in c) assert.match(String(actual), new RegExp(c.match, 'u'), label)
          if ('exists' in c) assert.equal(actual !== undefined, c.exists, label)
          if ('includes' in c) assert.ok(actual?.includes(c.includes), label)
        }
      }
      report.passed++
      report.cases.push({ id:test.id, status:'passed', requirement:test.requirement })
    } catch (error) {
      report.failed++
      report.cases.push({ id:test.id, status:'failed', requirement:test.requirement, error:error.message })
    } finally { await h.close?.() }
  }
  return report
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  const i=process.argv.indexOf('--adapter')
  if(i<0) throw new Error('用法：node acceptance/suite.mjs --adapter /absolute/path/rebuilt-adapter.mjs')
  const {createHarness}=await import(pathToFileURL(process.argv[i+1]).href)
  const report=await runSuite(createHarness)
  process.stdout.write(JSON.stringify(report,null,2)+'\n')
  process.exitCode=report.failed?1:0
}
