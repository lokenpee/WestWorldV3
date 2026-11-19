import { expect, test, type Browser } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
let directory: string
const reopenedBrowsers: Browser[] = []
const entry = resolve('scripts/local-service.ps1')
function service(action: string) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry, '-Action', action, '-Port', '5189', '-DataDirectory', directory, '-NoBrowser'], { windowsHide: true, stdio: 'ignore', timeout: 60000 })
}
test.beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'westworld-browser-storage-')); service('start') })
test.afterAll(async () => { for (const browser of reopenedBrowsers) await browser.close(); if (directory) { service('stop'); rmSync(directory, { recursive: true, force: true }) } })

test('disk library and encrypted key survive browser close, service restart and site-data clearing', async ({ browser, baseURL }, info) => {
  let context = await browser.newContext()
  let page = await context.newPage()
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  await page.goto(baseURL!)
  await expect(page.getByRole('heading', { name: '本机书库已就绪' })).toBeVisible()
  await page.getByRole('button', { name: '进入磁盘书库' }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: '磁盘保存样本.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 书信\n沈青收到信。\n第二章 归还\n沈青归还信。') })
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '磁盘保存样本', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('API Key（密钥）', { exact: true }).fill('fake-storage-browser-key')
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click()
  await expect(page.getByText(/当前服务 deepseek：密钥已配置/)).toBeVisible()
  await page.getByRole('button', { name: '立即生成恢复副本' }).click()
  await expect(page.getByText('恢复副本已生成。', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('disk-settings.png'), fullPage: true })
  // Leave an uncommitted write behind, then terminate the process: it must never become visible.
  await page.evaluate(async () => {
    const rpc = async (body: object) => (await (await fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).result
    const transaction = await rpc({ action: 'begin', scope: 'settings', tables: ['appSettings'], write: true })
    await rpc({ action: 'put', scope: 'settings', table: 'appSettings', key: 'interrupted', value: { key: 'interrupted', value: 'must roll back' }, transaction })
  })
  await context.close()
  await browser.close()
  service('stop'); service('start')
  const reopenedBrowser = await browser.browserType().launch({ channel: 'msedge', headless: true }); reopenedBrowsers.push(reopenedBrowser)
  context = await reopenedBrowser.newContext(); page = await context.newPage()
  await page.goto(baseURL!)
  await expect(page.getByRole('heading', { name: '磁盘保存样本', exact: true })).toBeVisible()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Storage.clearDataForOrigin', { origin: baseURL!, storageTypes: 'all' })
  await page.reload()
  await expect(page.getByRole('heading', { name: '磁盘保存样本', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByText(/当前服务 deepseek：密钥已配置/)).toBeVisible()
  await expect(page.getByRole('region', { name: '磁盘存储' })).toContainText(directory)
  const stored = await page.evaluate(async () => {
    const response = await fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get', scope: 'settings', table: 'credentials', key: 'deepseek' }) })
    return (await response.json()).result.value.key
  })
  expect(stored).toBe('fake-storage-browser-key')
  expect(await page.evaluate(async () => (await (await fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get', scope: 'settings', table: 'appSettings', key: 'interrupted' }) })).json()).result)).toBeNull()
  const forbidden = await context.request.post(baseURL + '/api/storage', { headers: { Origin: 'https://untrusted.invalid' }, data: { action: 'get', scope: 'settings', table: 'credentials', key: 'deepseek' } })
  expect(forbidden.status()).toBe(403)
  expect(await forbidden.text()).not.toContain(stored)
  expect(readFileSync(join(directory, 'workspace.sqlite')).includes(Buffer.from(stored))).toBe(false)
  const backups = readdirSync(join(directory, 'backups')).filter(file => file.endsWith('.sqlite'))
  expect(backups.length).toBeGreaterThan(0)
  for (const file of backups) expect(readFileSync(join(directory, 'backups', file)).includes(Buffer.from(stored))).toBe(false)
  expect(failures).toEqual([])
  await context.close()
  await reopenedBrowser.close()
})
