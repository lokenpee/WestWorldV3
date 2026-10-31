import { useEffect, useRef } from 'react'
import './ChapterTextDialog.css'

export function ChapterTextDialog({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog className="chapter-dialog" ref={dialog} onCancel={event => event.preventDefault()} aria-labelledby="reader-title">
    <header><div><h2 id="reader-title">{title}</h2><p>{text.length.toLocaleString('zh-CN')} 字符 · 原文只读</p></div><button className="secondary-button" onClick={onClose} autoFocus>关闭原文</button></header>
    <pre tabIndex={0}>{text}</pre>
  </dialog>
}
