import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))
const pick = (page: Page, name: string) => page.getByLabel('小说TXT文件').setInputFiles(fixture(name))

test('底层连续触发文件选择时，旧文件错误不能覆盖新文件预览', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('小说TXT文件')).toBeAttached()
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    for (const [name, text] of [['错误.csv', '旧内容'], ['最新.txt', '第一章 最新\n新内容']]) {
      const transfer = new DataTransfer()
      transfer.items.add(new File([text], name))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  await expect(page.getByRole('region', { name: '分章预览' })).toContainText('最新.txt')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '仅导入', exact: true })).toBeEnabled()
})

test('完整导入、序文预览、刷新后原文、同名独立导入并选中新书', async ({ page }) => {
  await page.goto('/')
  await pick(page, 'A-三章短篇.txt')
  await expect(page.getByRole('region', { name: '分章预览' })).toContainText('4 章 / 块')
  await page.getByRole('button', { name: '预览 序文', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('这封信的去向，后来成为青石镇的一段旧事。')
  await page.getByRole('button', { name: '关闭原文' }).click()
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'A-三章短篇', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '资产书架 1' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '查看原文 第三章 信件归还', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('顾衡确认信封完好，向掌柜道谢。')
  await page.getByRole('button', { name: '关闭原文' }).click()
  await page.getByRole('button', { name: '导入小说', exact: true }).click()
  await pick(page, 'A-三章短篇.txt')
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'A-三章短篇（1）', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '资产书架 2' })).toBeVisible()
})

test('GBK自动识别可重读，长章小数编号和末尾原文完整', async ({ page }) => {
  await page.goto('/')
  await pick(page, 'B-GBK.txt')
  await expect(page.getByRole('region', { name: '分章预览' })).toContainText('GBK')
  await page.getByRole('button', { name: '预览 第一章 编码' }).click()
  await expect(page.getByRole('dialog')).toContainText('中文样本。')
  await page.getByRole('button', { name: '关闭原文' }).click()
  await page.getByRole('button', { name: '按 UTF-8 重读' }).click()
  await expect(page.getByRole('region', { name: '分章预览' })).toContainText('UTF-8')
  await page.getByRole('button', { name: '按 GBK 重读' }).click()
  await expect(page.getByRole('region', { name: '分章预览' })).toContainText('GBK')
  await pick(page, 'B-长章.txt')
  await expect(page.getByRole('region', { name: '分章预览' })).toContainText('10,008 字符')
  await expect(page.getByRole('cell', { name: '1.2', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '预览 第一章 长章（第 2 块）' }).click()
  await expect(page.getByRole('dialog').locator('pre')).toHaveText('长'.repeat(8))
})

test('正则修改使旧预览过期，错误/空文件清空可导入结果', async ({ page }) => {
  await page.goto('/')
  await pick(page, 'A-三章短篇.txt')
  await expect(page.getByRole('button', { name: '仅导入', exact: true })).toBeEnabled()
  await page.getByLabel('章节分隔正则').fill('[')
  await expect(page.getByRole('button', { name: '仅导入', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '应用正则并重新预览' }).click()
  await expect(page.getByRole('alert')).toContainText('分章正则无效')
  await expect(page.getByRole('button', { name: '仅导入', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect(page.getByRole('button', { name: '仅导入', exact: true })).toBeEnabled()
  await pick(page, 'B-空文本.txt')
  await expect(page.getByRole('alert')).toContainText('空白')
  await expect(page.getByRole('region', { name: '分章预览' })).toHaveCount(0)
  await pick(page, 'B-错误类型.csv')
  await expect(page.getByRole('alert')).toContainText('仅支持 TXT')
  await expect(page.getByRole('heading', { name: '资产书架 0' })).toBeVisible()
})

test('拖放也检查单个TXT；合法文件按同一链路预览', async ({ page }) => {
  await page.goto('/')
  const multiple = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['甲'], 'a.txt'))
    data.items.add(new File(['乙'], 'b.txt'))
    return data
  })
  await page.getByLabel('TXT文件拖放区').dispatchEvent('drop', { dataTransfer: multiple })
  await expect(page.getByRole('alert')).toContainText('一个 TXT')
  const single = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.items.add(new File(['第一章 拖放\n正文'], '拖放.TXT', { type: 'application/octet-stream' }))
    return data
  })
  await page.getByLabel('TXT文件拖放区').dispatchEvent('drop', { dataTransfer: single })
  await expect(page.getByRole('region', { name: '分章预览' })).toContainText('第一章 拖放')
  await page.reload()
  await expect(page.getByRole('heading', { name: '资产书架 0' })).toBeVisible()
})

test('书库写入后模拟失败不发布半本书，原预览可重试成功', async ({ page }) => {
  await page.goto('/?acceptance=stage2')
  await page.getByRole('button', { name: '模拟下次导入失败' }).click()
  await pick(page, 'A-三章短篇.txt')
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('临时资料已清理')
  await expect(page.getByRole('heading', { name: '资产书架 0' })).toBeVisible()
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '资产书架 1' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'A-三章短篇', exact: true })).toBeVisible()
  const bookNames = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name).filter(name => name?.startsWith('westworld_acceptance_stage2_book_')))
  expect(bookNames).toHaveLength(1)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '资产书架 0' })).toBeVisible()
})

test('超过200章仍可查看最后一章，375px下预览与导入按钮可操作', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  const text = Array.from({ length: 201 }, (_, i) => `第${i + 1}章 测试\n第${i + 1}段正文\n`).join('')
  await page.getByLabel('小说TXT文件').setInputFiles({ name: '长书.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
  await expect(page.getByRole('region', { name: '分章预览' })).toContainText('201 章 / 块')
  await page.getByRole('button', { name: '预览 第201章 测试', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('第201段正文')
  await page.getByRole('button', { name: '关闭原文' }).click()
  await page.getByRole('button', { name: '仅导入', exact: true }).click()
  await page.getByRole('button', { name: '查看原文 第201章 测试', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('第201段正文')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
