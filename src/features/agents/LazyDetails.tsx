import { useState, type ReactNode } from 'react'

/** 关闭时不执行内容函数；浏览器details折叠本身不会跳过React子节点计算。 */
export function LazyDetails({ summary, children, open = false, className, summaryClassName, ...attributes }: {
  summary: ReactNode; children: () => ReactNode; open?: boolean; className?: string; summaryClassName?: string; 'aria-label'?: string
}) {
  const [expanded, setExpanded] = useState(open)
  return <details {...attributes} className={className} open={expanded} onToggle={event => {
    if (event.target === event.currentTarget) setExpanded(event.currentTarget.open)
  }}><summary className={summaryClassName}>{summary}</summary>{expanded ? children() : null}</details>
}
