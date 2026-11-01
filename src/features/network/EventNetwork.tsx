import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Chapter } from '../../lib/storage/workspace'
import type { EventLine, EventNode } from '../assets/types'
import { fitNetwork, layoutNetwork, lineColors, nodeHeight, nodeWidth, type NetworkView } from './layout'
import './EventNetwork.css'

interface SavedView { query: string; chapter: string; orphans: boolean; lineId: string; view: NetworkView }
const views = new Map<string, SavedView>()
const shorten = (value: string, count: number) => Array.from(value).length > count ? `${Array.from(value).slice(0, count).join('')}…` : value

export function EventNetwork({ bookId, nodes, lines, chapters, active, selectedId, onSelectNode, onEditLine }: {
  bookId: string; nodes: EventNode[]; lines: EventLine[]; chapters: Chapter[]; active: boolean; selectedId?: string
  onSelectNode: (id: string) => void; onEditLine: (id: string) => void
}) {
  const cached = views.get(bookId)
  const [query, setQuery] = useState(cached?.query ?? '')
  const [chapter, setChapter] = useState(cached?.chapter ?? '')
  const [orphans, setOrphans] = useState(cached?.orphans ?? false)
  const [lineId, setLineId] = useState(cached?.lineId ?? '')
  const [view, setView] = useState<NetworkView>(cached?.view ?? { x: 0, y: 0, zoom: 1 })
  const [size, setSize] = useState({ width: 800, height: 400 })
  const frame = useRef<HTMLDivElement>(null)
  const markerId = useId().replace(/:/g, '')
  const fitted = useRef(!!cached)
  const dragging = useRef<{ x: number; y: number; view: NetworkView } | null>(null)
  const layout = useMemo(() => layoutNetwork(nodes, lines, chapters), [nodes, lines, chapters])
  const byId = useMemo(() => new Map(layout.nodes.map(row => [row.id, row])), [layout])
  const lineById = useMemo(() => new Map(lines.map(row => [row.id, row])), [lines])
  const selectedX = selectedId ? byId.get(selectedId)?.x : undefined, selectedY = selectedId ? byId.get(selectedId)?.y : undefined
  const line = lines.find(row => row.id === lineId)
  const currentChapter = chapters.some(row => row.chapterIndex === chapter) ? chapter : ''
  const normalized = query.trim().toLowerCase()
  const filtered = layout.nodes.filter(row => (!currentChapter || row.node.chapterIndex === currentChapter) && (!orphans || !row.lineIds.length) && (!normalized || `${row.node.name} ${row.node.summary} ${row.id} ${row.node.actors.join(' ')}`.toLowerCase().includes(normalized)))
  const visibleIds = new Set(filtered.map(row => row.id))
  const inView = (x: number, y: number, width = nodeWidth, height = nodeHeight) => x + width >= view.x - 100 && y + height >= view.y - 100 && x <= view.x + size.width / view.zoom + 100 && y <= view.y + size.height / view.zoom + 100
  const drawn = filtered.filter(row => inView(row.x, row.y))
  useEffect(() => { views.set(bookId, { query, chapter, orphans, lineId, view }) }, [bookId, query, chapter, orphans, lineId, view])
  useEffect(() => {
    const element = frame.current
    if (!element || !active) return
    const resize = () => { const rect = element.getBoundingClientRect(); if (rect.width && rect.height) setSize({ width: rect.width, height: rect.height }) }
    resize(); const observer = new ResizeObserver(resize); observer.observe(element)
    return () => observer.disconnect()
  }, [active])
  useEffect(() => {
    const rect = frame.current?.getBoundingClientRect()
    if (active && !fitted.current && layout.nodes.length && rect?.width && rect.height) { fitted.current = true; setView(fitNetwork(layout.nodes, rect.width, rect.height)) }
  }, [active, layout, size.width, size.height])
  useEffect(() => {
    if (!active || selectedX === undefined || selectedY === undefined) return
    const timer = requestAnimationFrame(() => setView(previous => { const zoom = Math.max(previous.zoom, 0.7); return { zoom, x: selectedX + nodeWidth / 2 - size.width / zoom / 2, y: selectedY + nodeHeight / 2 - size.height / zoom / 2 } }))
    return () => cancelAnimationFrame(timer)
  }, [selectedX, selectedY, active, size.width, size.height])
  const zoomBy = (factor: number) => setView(previous => {
    const zoom = Math.min(2, Math.max(0.001, previous.zoom * factor))
    return { zoom, x: previous.x + size.width / previous.zoom / 2 - size.width / zoom / 2, y: previous.y + size.height / previous.zoom / 2 - size.height / zoom / 2 }
  })
  const locate = (id: string) => {
    const row = byId.get(id)
    if (!row) return
    setView({ zoom: 1, x: row.x + nodeWidth / 2 - size.width / 2, y: row.y + nodeHeight / 2 - size.height / 2 })
    onSelectNode(id)
  }
  return <section className="network-panel" hidden={!active} aria-label="事件网络">
    <div className="network-filters">
      <input aria-label="搜索事件网络" placeholder="搜索节点名称、概述或编号" value={query} onChange={event => { const value = event.target.value; setQuery(value); setView(fitNetwork(layout.nodes.filter(row => (!currentChapter || row.node.chapterIndex === currentChapter) && (!orphans || !row.lineIds.length) && `${row.node.name} ${row.node.summary} ${row.id} ${row.node.actors.join(' ')}`.toLowerCase().includes(value.trim().toLowerCase())), size.width, size.height)) }} />
      <select aria-label="筛选网络章节" value={currentChapter} onChange={event => { setChapter(event.target.value); setView(fitNetwork(layout.nodes.filter(row => !event.target.value || row.node.chapterIndex === event.target.value), size.width, size.height)) }}><option value="">全部章节</option>{layout.chapters.map(row => <option key={row.id} value={row.id}>{row.id} · {shorten(row.title, 28)}</option>)}</select>
      <label><input type="checkbox" checked={orphans} onChange={event => { setOrphans(event.target.checked); setLineId(''); setView(fitNetwork(event.target.checked ? layout.nodes.filter(row => !row.lineIds.length) : layout.nodes, size.width, size.height)) }} />只看孤立节点</label>
    </div>
    <div className="network-lines" aria-label="高亮事件线"><button className="text-button" aria-pressed={!line} onClick={() => setLineId('')}>全部事件线</button>{lines.map((row, index) => <button key={row.id} style={{ borderLeftColor: lineColors[index % lineColors.length] }} aria-pressed={lineId === row.id} onClick={() => { setLineId(lineId === row.id ? '' : row.id); setOrphans(false) }} title={row.title}>{shorten(row.title, 24)} · {new Set(row.nodeIds).size}节点</button>)}</div>
    <div className="network-controls"><button className="secondary-button" aria-label="放大事件网络" onClick={() => zoomBy(1.25)}>＋</button><button className="secondary-button" aria-label="缩小事件网络" onClick={() => zoomBy(0.8)}>－</button><span aria-label="网络缩放比例">{Math.round(view.zoom * 1000) / 10}%</span><button className="secondary-button" onClick={() => setView(fitNetwork(filtered, size.width, size.height))}>查看全图</button><button className="secondary-button" onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>回到起点</button>
      <select aria-label="定位事件节点" value="" onChange={event => locate(event.target.value)}><option value="">定位节点…</option>{filtered.slice(0, 200).map(row => <option key={row.id} value={row.id}>{shorten(row.node.name, 20)} · {row.id}</option>)}{filtered.length > 200 && <option disabled>请先搜索缩小范围</option>}</select>
      {line && <button className="text-button" onClick={() => onEditLine(line.id)}>查看事件线详情</button>}
    </div>
    <p className="network-count" role="status">显示 {filtered.length} / {layout.nodes.length} 个节点 · {lines.length} 条事件线 · {layout.nodes.filter(row => !row.lineIds.length).length} 个孤立节点 · {layout.nodes.filter(row => row.lineIds.length > 1).length} 个共享节点</p>
    {!layout.nodes.length ? <p className="network-empty">还没有事件节点，提取或新增节点后可查看网络。</p> : !filtered.length ? <p className="network-empty">没有匹配节点，请调整搜索或章节筛选。</p> : <div ref={frame} className="network-canvas">
      <svg role="group" aria-label="事件网络画布，方向键移动，加减键缩放" tabIndex={0} viewBox={`${view.x} ${view.y} ${size.width / view.zoom} ${size.height / view.zoom}`} onKeyDown={event => {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25) }
        else if (event.key === '-') { event.preventDefault(); zoomBy(0.8) }
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setView(previous => ({ ...previous, x: previous.x + (event.key === 'ArrowLeft' ? -80 : event.key === 'ArrowRight' ? 80 : 0) / previous.zoom, y: previous.y + (event.key === 'ArrowUp' ? -80 : event.key === 'ArrowDown' ? 80 : 0) / previous.zoom })) }
      }} onPointerDown={event => { if ((event.target as Element).closest('[data-network-node]')) return; dragging.current = { x: event.clientX, y: event.clientY, view }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { const start = dragging.current; if (start) setView({ ...start.view, x: start.view.x - (event.clientX - start.x) / start.view.zoom, y: start.view.y - (event.clientY - start.y) / start.view.zoom }) }} onPointerUp={() => { dragging.current = null }} onPointerCancel={() => { dragging.current = null }}>
        <defs>{lineColors.map((color, index) => <marker key={color} id={`${markerId}-${index}`} viewBox="0 0 8 8" refX={8} refY={4} markerWidth={7} markerHeight={7} orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill={color} /></marker>)}</defs>
        {layout.chapters.filter(row => inView(row.x, view.y, row.width, 30)).map(row => <g key={row.id} className="network-chapter" pointerEvents="none"><line x1={row.x - 15} x2={row.x - 15} y1={view.y} y2={view.y + size.height / view.zoom} /></g>)}
        {layout.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map(edge => {
          const source = byId.get(edge.source)!, target = byId.get(edge.target)!
          if (!inView(Math.min(source.x, target.x), Math.min(source.y, target.y), Math.abs(source.x - target.x) + nodeWidth + 80, Math.abs(source.y - target.y) + nodeHeight)) return null
          const sx = source.x + nodeWidth, sy = source.y + nodeHeight / 2, tx = target.x + (source.x === target.x ? nodeWidth : 0), ty = target.y + nodeHeight / 2, bend = source.x === target.x ? sx + 70 : (sx + tx) / 2
          return <path key={edge.id} data-network-edge={edge.id} d={`M ${sx} ${sy} C ${bend} ${sy}, ${bend} ${ty}, ${tx} ${ty}`} fill="none" stroke={edge.color} markerEnd={`url(#${markerId}-${lineColors.indexOf(edge.color)})`} strokeWidth={lineId === edge.lineId ? 3 : 1.5} opacity={line && line.id !== edge.lineId ? 0.12 : 0.8}><title>{lineById.get(edge.lineId)?.title} · 事件线顺序</title></path>
        })}
        {drawn.map(row => <g key={row.id} data-network-node={row.id} className={`network-node${selectedId === row.id ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={`查看节点 ${row.node.name} ${row.id}`} transform={`translate(${row.x},${row.y})`} opacity={line && !row.lineIds.includes(line.id) ? 0.3 : 1} onClick={() => onSelectNode(row.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelectNode(row.id) } }}>
          <title>{[row.node.name, row.node.summary, row.id].join('\n')}</title><rect width={nodeWidth} height={nodeHeight} rx={7} strokeDasharray={row.lineIds.length ? undefined : '5 3'} /><text x={12} y={23} className="network-node-title">{shorten(row.node.name, 13)}</text><text x={12} y={44}>{row.lineIds.length > 1 ? `共享 · ${row.lineIds.length}条事件线` : row.lineIds.length ? '已归入事件线' : '孤立节点'}</text><text x={12} y={66}>{shorten(row.id, 28)}</text>
        </g>)}
        <g className="network-chapter" pointerEvents="none"><rect x={view.x} y={view.y} width={size.width / view.zoom} height={28 / view.zoom} fill="white" opacity={0.95} />{layout.chapters.filter(row => inView(row.x, view.y, row.width, 30)).map(row => <text key={row.id} x={row.x} y={view.y + 20 / view.zoom} fontSize={12 / view.zoom}>第 {row.id} 章</text>)}</g>
      </svg>
    </div>}
    <p className="network-help">拖动画布移动，点击节点查看详情；也可用方向键和加减键操作。</p>
  </section>
}
