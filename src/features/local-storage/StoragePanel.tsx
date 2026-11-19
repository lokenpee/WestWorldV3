import { useCallback, useEffect, useState } from 'react'
import { useLiveResult } from '../../hooks/useLiveResult'
import type { StorageStatus } from './contracts'
import { storageChanged, type StorageCall } from './client'
import { legacyBooks, migrateBrowserData } from './migration'

export function StoragePanel({ call, onContinue }: { call: StorageCall; onContinue?: () => void | Promise<void> }) {
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [oldCount, setOldCount] = useState<number>()
  const query = useCallback(() => call<StorageStatus & { lastBackupAt?: string; backupError?: string }>({ action: 'status' }), [call])
  const status = useLiveResult(query, attempt)
  useEffect(() => { void legacyBooks().then(rows => setOldCount(rows.length)).catch(() => setMessage('浏览器旧数据暂时无法读取，可重试或使用已有整书备份。')) }, [attempt])
  async function migrate() {
    setBusy(true)
    try { await migrateBrowserData(call, setMessage); setAttempt(value => value + 1) }
    catch (error) { setMessage(error instanceof Error ? error.message : '迁移失败，源数据已保留，可重试。') }
    finally { setBusy(false) }
  }
  async function backup() {
    setBusy(true)
    try { await call({ action: 'backup' }); setMessage('恢复副本已生成。'); storageChanged() }
    catch (error) { setMessage(error instanceof Error ? error.message : '备份失败。') }
    finally { setBusy(false) }
  }
  async function enter() {
    setBusy(true)
    try { await onContinue?.() }
    catch (error) { setMessage(error instanceof Error ? error.message : '无法进入磁盘书库，请重试。') }
    finally { setBusy(false) }
  }
  return <section className="backup-panel" aria-label="磁盘存储">
    <h2>磁盘存储</h2>
    {status.status === 'loading' && <p role="status">正在连接本机书库…</p>}
    {status.status === 'error' && <p role="alert">{status.message}</p>}
    {status.status === 'ready' && <>
      <p>保存目录：{status.value.dataDirectory}</p>
      <p>最近保存：{status.value.lastSavedAt ? new Date(status.value.lastSavedAt).toLocaleString('zh-CN') : '尚无保存记录'} · 自动保留最近 5 份恢复副本</p>
      <p>最近备份：{status.value.lastBackupAt ? new Date(status.value.lastBackupAt).toLocaleString('zh-CN') : '尚未生成'}</p>
      {status.value.backupError && <p role="alert">{status.value.backupError}</p>}
      <p>{oldCount === undefined ? '正在检查浏览器旧数据…' : `浏览器旧书架有 ${oldCount} 本书。`}迁移会复制书籍、进度和模型设置，保留源数据及已有磁盘结果。</p>
      <button className="primary-button" disabled={busy || oldCount === undefined} onClick={() => void migrate()}>迁移浏览器旧数据</button>{' '}
      <button className="secondary-button" disabled={busy} onClick={() => void backup()}>立即生成恢复副本</button>{' '}
      {onContinue && <button className="secondary-button" disabled={busy} onClick={() => void enter()}>进入磁盘书库</button>}
    </>}
    <button className="secondary-button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新检查</button>
    {message && <p role="status">{message}</p>}
  </section>
}
