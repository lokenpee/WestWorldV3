import { expect, test } from '@playwright/test'

test('代码扫描可取消并重试，切书不会显示旧扫描结果', async ({ page }) => {
  let release: (() => void) | undefined, hold = true
  await page.route('**/*candidates.worker*', async route => {
    if (hold) await new Promise<void>(resolve => { release = resolve })
    await route.continue().catch(() => {})
  })
  await page.goto('/?acceptance=world')
  await page.getByRole('button', { name: '装载世界资产样本', exact: true }).click()
  await page.getByRole('button', { name: '进入 世界资产整理样本', exact: true }).click()
  const start = page.getByRole('button', { name: '代码整理', exact: true })
  await start.click()
  await expect.poll(() => !!release).toBe(true)
  await page.getByRole('button', { name: '取消候选扫描', exact: true }).click()
  await expect(page.getByRole('region', { name: '世界资产整理', exact: true })).toContainText('候选扫描已取消')
  hold = false; release!(); release = undefined
  await start.click()
  await expect(page.getByText(/其余候选可继续核对/)).toBeVisible()
  await expect(page.getByRole('button', { name: '取消候选扫描', exact: true })).toHaveCount(0)
  hold = true
  await start.click()
  await expect.poll(() => !!release).toBe(true)
  await page.getByRole('button', { name: '进入 山城来客', exact: true }).click()
  hold = false; release!()
  await expect(page.getByRole('heading', { name: '山城来客', exact: true })).toBeVisible()
  await expect(page.getByText(/候选扫描已取消/)).toHaveCount(0)
  await expect(page.getByText(/其余候选可继续核对/)).toHaveCount(0)
})
