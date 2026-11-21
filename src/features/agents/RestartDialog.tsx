import { useEffect, useRef } from 'react'
import type { RestartMode } from '../world/reuse'

export function RestartDialog({ title, onChoose, onClose, storyReview = false }: { title: string; storyReview?: boolean; onChoose: (mode: RestartMode) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  return <dialog ref={dialog} className="merge-dialog" aria-label="选择整理范围" onCancel={onClose}><div className="merge-dialog-body">
    <h2>{title}</h2><p>复用同一步骤中已完成且内容未变的结果；新增、有变更、失败和待核对的内容继续处理。</p>
    <p>{storyReview ? '两种方式都保留已保存的大纲，并使用新的复核会话。' : '已保存的资产、事件线和人工合并结论都会保留。'}</p>
    <div className="merge-dialog-actions">
      <button className="primary-button" autoFocus onClick={() => onChoose('reuse')}>{storyReview ? '复核变更' : '复用已完成结果'}</button>
      <button className="secondary-button" onClick={() => onChoose('all')}>{storyReview ? '完整重新复核' : '全部重新整理'}</button>
      <button className="text-button" onClick={onClose}>取消</button>
    </div>
  </div></dialog>
}
