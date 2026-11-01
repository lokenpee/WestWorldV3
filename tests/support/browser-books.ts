import type { Page } from '@playwright/test'

export async function addEmptyBook(page: Page, id: string, title: string) {
  const previous = await page.locator('.page-heading h1').textContent()
  await page.evaluate(async ({ id, title }) => {
    const request = indexedDB.open('westworld_settings')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('books', 'readwrite')
      tx.objectStore('books').put({ id, title, sourceFileName: `${title}.txt`, createdAt: new Date().toISOString() })
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, { id, title })
  await page.reload()
  if (previous) await page.getByRole('button', { name: `进入 ${previous}`, exact: true }).click()
}
