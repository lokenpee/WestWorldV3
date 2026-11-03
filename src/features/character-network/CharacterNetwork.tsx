import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Character, CharacterPairResult } from '../assets/types'
import { characterNetworkCacheKey, saveCharacterNetworkCache } from './cache'
import { searchCharacters } from '../assets/search'
import { segmentDistance, vacantPosition, PositionIndex, type Point } from './geometry'
import './CharacterNetwork.css'

interface View { x: number; y: number; zoom: number }
interface Cache { version: 1; positions: Record<string, Point>; view: View }
const radiusOf = (role?: string) => role === '主要人物' ? 32 : role === '重要配角' ? 26 : role === 'NPC' ? 20 : 16
const roleLabel = (role?: string) => role ?? 'NPC'
const colorOf = (role?: string) => role === '主要人物' ? '#f2c14e' : role === '重要配角' ? '#7fb3ff' : role === 'NPC' ? '#9ad0a0' : '#9a8fb5'

function loadCache(bookId: string): Cache | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(characterNetworkCacheKey(bookId)) ?? 'null') as Cache | null
    if (!value || value.version !== 1 || !value.positions || !value.view) return undefined
    if (!Number.isFinite(value.view.x) || !Number.isFinite(value.view.y) || !Number.isFinite(value.view.zoom) || value.view.zoom < 0.1 || value.view.zoom > 4) return undefined
    const index = new PositionIndex()
    for (const point of Object.values(value.positions)) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !index.free(point)) return undefined
      index.add(point)
    }
    return value
  } catch { return undefined }
}

export function CharacterNetwork({ bookId, characters, pairs, selectedId, onSelect }: {
  bookId: string; characters: Character[]; pairs: CharacterPairResult[]; selectedId?: string; onSelect: (id: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const workerRef = useRef<Worker | undefined>(undefined)
  const generation = useRef(0)
  const [positions, setPositions] = useState<Record<string, Point>>(() => loadCache(bookId)?.positions ?? {})
  const [view, setView] = useState<View>(() => loadCache(bookId)?.view ?? { x: 0, y: 0, zoom: 1 })
  const [size, setSize] = useState({ width: 800, height: 600 })
  const [hover, setHover] = useState<{ kind: 'person' | 'pair'; id: string }>()
  const [layoutCount, setLayoutCount] = useState(0)
  const [search, setSearch] = useState('')
  const [searchPage, setSearchPage] = useState(1)
  const [layoutRunning, setLayoutRunning] = useState(false)
  const [warning, setWarning] = useState('')
  const drag = useRef<{ id?: string; startX: number; startY: number; origin?: Point; view: View; moved: boolean } | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingCache = useRef<Cache | undefined>(undefined)
  const activeLayoutIds = useRef('')
  const characterMap = useMemo(() => new Map(characters.map(row => [row.id, row])), [characters])
  const edges = useMemo(() => {
    const seen = new Set<string>()
    return pairs.filter(pair => pair.state === 'active' && characterMap.has(pair.fromId) && characterMap.has(pair.toId))
      .filter(pair => { if (seen.has(pair.pairKey)) return false; seen.add(pair.pairKey); return true })
  }, [pairs, characterMap])
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>(characters.map(row => [row.id, new Set<string>()]))
    for (const pair of edges) { map.get(pair.fromId)?.add(pair.toId); map.get(pair.toId)?.add(pair.fromId) }
    return map
  }, [edges, characters])
  const matched = useMemo(() => {
    return search.trim() ? searchCharacters(characters, search) : []
  }, [search, characters])

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const resize = () => setSize({ width: Math.max(320, element.clientWidth), height: Math.max(320, element.clientHeight) })
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    clearTimeout(saveTimer.current)
    if (!Object.keys(positions).length) return
    const known = new Set(characters.map(row => row.id))
    pendingCache.current = { version: 1, positions: Object.fromEntries(Object.entries(positions).filter(([id]) => known.has(id))), view }
    saveTimer.current = setTimeout(() => {
      try {
        saveCharacterNetworkCache(bookId, pendingCache.current)
        setWarning('')
      } catch { setWarning('本次布局未能保存在本机，资产数据不受影响。') }
    }, 300)
    return () => clearTimeout(saveTimer.current)
  }, [positions, view, bookId, characters])

  const fit = useCallback((points: Record<string, Point>) => {
    const values = Object.values(points)
    if (!values.length) return
    const minX = Math.min(...values.map(point => point.x)), maxX = Math.max(...values.map(point => point.x))
    const minY = Math.min(...values.map(point => point.y)), maxY = Math.max(...values.map(point => point.y))
    const zoom = Math.max(0.1, Math.min(4, Math.min(size.width / Math.max(1, maxX - minX + 160), size.height / Math.max(1, maxY - minY + 160))))
    setView({ zoom, x: size.width / 2 - ((minX + maxX) / 2) * zoom, y: size.height / 2 - ((minY + maxY) / 2) * zoom })
  }, [size])
  const latestFit = useRef(fit)
  useEffect(() => { latestFit.current = fit }, [fit])

  const cancelLayout = useCallback(() => {
    generation.current++
    workerRef.current?.terminate(); workerRef.current = undefined
    setLayoutRunning(false)
    setPositions(previous => {
      if (Object.keys(previous).length || !characters.length) return previous
      const columns = Math.ceil(Math.sqrt(characters.length))
      return Object.fromEntries(characters.map((row, i) => [row.id, { x: 60 + i % columns * 90, y: 80 + Math.floor(i / columns) * 90 }]))
    })
  }, [characters])

  const startLayout = useCallback(() => {
    workerRef.current?.terminate()
    const generationId = ++generation.current
    const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    activeLayoutIds.current = characters.map(row => row.id).sort().join('\u0000')
    setLayoutRunning(true); setLayoutCount(value => value + 1)
    worker.onmessage = (event: MessageEvent<{ type: string; positions?: Record<string, Point> }>) => {
      if (generationId !== generation.current || !event.data.positions) return
      if (event.data.type === 'initial') setPositions(previous => Object.keys(previous).length ? previous : event.data.positions!)
      if (event.data.type === 'done') {
        setPositions(event.data.positions); setLayoutRunning(false); latestFit.current(event.data.positions)
        worker.terminate(); workerRef.current = undefined
      }
    }
    worker.onerror = () => { if (generationId === generation.current) { cancelLayout(); setWarning('布局计算失败，可重新布局；当前图和资产数据已保留。') } }
    worker.postMessage({ type: 'layout', nodes: characters.map(row => ({ id: row.id, role: roleLabel(row.roleWeight) })), edges: edges.map(edge => ({ a: edge.fromId, b: edge.toId })), width: size.width, height: size.height, seed: 7 })
  }, [characters, edges, size, cancelLayout])

  useEffect(() => {
    const ids = characters.map(row => row.id).sort().join('\u0000')
    if (workerRef.current && activeLayoutIds.current !== ids) cancelLayout()
    if (!characters.length) { if (Object.keys(positions).length) setPositions({}); return }
    const missing = characters.filter(row => !positions[row.id])
    const removed = Object.keys(positions).some(id => !characterMap.has(id))
    if (!missing.length && !removed) return
    if (!Object.keys(positions).length) { if (!workerRef.current) startLayout(); return }
    const next = Object.fromEntries(Object.entries(positions).filter(([id]) => characterMap.has(id)))
    const index = new PositionIndex()
    for (const point of Object.values(next)) index.add(point)
    for (const row of missing) {
      const anchor = edges.find(edge => edge.fromId === row.id)?.toId ?? edges.find(edge => edge.toId === row.id)?.fromId
      const point = anchor ? next[anchor] : undefined
      next[row.id] = index.place(point ?? { x: size.width / 2, y: size.height / 2 })
    }
    setPositions(next)
  }, [characters, characterMap, positions, edges, size, startLayout, cancelLayout])

  useEffect(() => () => {
    generation.current++; workerRef.current?.terminate(); workerRef.current = undefined
    // 视图卸载前提交尚未到300ms的本机视角，避免快速切换丢失位置。
    if (pendingCache.current) try {
      if (localStorage.getItem(characterNetworkCacheKey(bookId)) !== null) saveCharacterNetworkCache(bookId, pendingCache.current)
    } catch { /* 资产数据独立保存。 */ }
  }, [bookId])

  const screen = useCallback((point: Point) => ({ x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y }), [view])
  const world = (x: number, y: number) => ({ x: (x - view.x) / view.zoom, y: (y - view.y) / view.zoom })
  function hitTest(clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect()
    const point = world(clientX - rect.left, clientY - rect.top)
    for (const row of [...characters].reverse()) {
      const position = positions[row.id]
      if (!position) continue
      const radius = radiusOf(row.roleWeight)
      if (Math.hypot(position.x - point.x, position.y - point.y) <= radius + 4) return row.id
    }
    return undefined
  }

  function hoverAt(clientX: number, clientY: number) {
    const person = hitTest(clientX, clientY)
    if (person) return { kind: 'person' as const, id: person }
    const rect = canvasRef.current!.getBoundingClientRect(), point = world(clientX - rect.left, clientY - rect.top)
    let closest = 6 / view.zoom, match: string | undefined
    for (const edge of edges) {
      const a = positions[edge.fromId], b = positions[edge.toId]
      if (!a || !b) continue
      const distance = segmentDistance(point, a, b)
      if (distance < closest) { closest = distance; match = edge.pairKey }
    }
    return match ? { kind: 'pair' as const, id: match } : undefined
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(size.width * dpr)) canvas.width = Math.round(size.width * dpr)
    if (canvas.height !== Math.round(size.height * dpr)) canvas.height = Math.round(size.height * dpr)
    const context = canvas.getContext('2d')!
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = '#0b0d10'; context.fillRect(0, 0, size.width, size.height)
    const selected = selectedId ? neighbours.get(selectedId) : undefined
    // 同样式连线合成路径；线宽使用屏幕像素，缩小时不放大成大片白线。
    for (const highlighted of selectedId ? [false, true] : [false]) {
      context.strokeStyle = highlighted ? 'rgba(255,255,255,.65)' : selectedId ? 'rgba(255,255,255,.045)' : 'rgba(255,255,255,.12)'
      context.lineWidth = highlighted ? 2 : 1
      context.beginPath()
      for (const pair of edges) {
        if (highlighted !== (!!selectedId && (pair.fromId === selectedId || pair.toId === selectedId))) continue
        const a = positions[pair.fromId], b = positions[pair.toId]
        if (!a || !b) continue
        const from = screen(a), to = screen(b)
        if (Math.max(from.x, to.x) < 0 || Math.min(from.x, to.x) > size.width || Math.max(from.y, to.y) < 0 || Math.min(from.y, to.y) > size.height) continue
        context.moveTo(from.x, from.y); context.lineTo(to.x, to.y)
      }
      context.stroke()
    }
    for (const row of characters) {
      const point = positions[row.id]
      if (!point) continue
      const { x, y } = screen(point)
      const radius = radiusOf(row.roleWeight) * view.zoom
      if (x + radius < 0 || x - radius > size.width || y + radius < 0 || y - radius > size.height) continue
      const active = row.id === selectedId
      const related = !selectedId || active || selected?.has(row.id)
      context.globalAlpha = related ? 1 : 0.35
      context.fillStyle = active ? '#ffffff' : colorOf(row.roleWeight)
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill()
      context.globalAlpha = 1
      if (radius >= 10) {
        context.fillStyle = '#11151b'; context.font = `${Math.max(9, Math.min(12, radius * 0.42))}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle'
        const name = row.name.length > 5 ? `${row.name.slice(0, 5)}…` : row.name
        context.fillText(name, x, y)
      }
    }
  }, [characters, edges, positions, view, size, selectedId, neighbours, screen])

  function locate(id: string) {
    const point = positions[id]
    if (!point) return
    setView(previous => ({ ...previous, x: size.width / 2 - point.x * previous.zoom, y: size.height / 2 - point.y * previous.zoom }))
    onSelect(id); setSearch('')
  }

  function onWheel(event: React.WheelEvent<HTMLCanvasElement>) {
    event.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const px = event.clientX - rect.left, py = event.clientY - rect.top
    const next = Math.max(0.1, Math.min(4, view.zoom * (event.deltaY > 0 ? 0.9 : 1.1)))
    setView({ zoom: next, x: px - (px - view.x) * next / view.zoom, y: py - (py - view.y) * next / view.zoom })
  }

  const hoverPerson = hover?.kind === 'person' ? characterMap.get(hover.id) : undefined
  const hoverPair = hover?.kind === 'pair' ? edges.find(pair => pair.pairKey === hover.id) : undefined
  const fromPerson = hoverPair ? characterMap.get(hoverPair.fromId) : undefined
  const toPerson = hoverPair ? characterMap.get(hoverPair.toId) : undefined

  return <div className="character-network" ref={wrapRef} data-layout-count={layoutCount} data-layout-running={layoutRunning} data-node-count={characters.length}>
    <canvas ref={canvasRef} aria-label="人物关系网络" style={{ width: size.width, height: size.height }}
      onWheel={onWheel}
      onPointerDown={event => {
        const id = hitTest(event.clientX, event.clientY)
        drag.current = { id, startX: event.clientX, startY: event.clientY, origin: id ? positions[id] : undefined, view, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const current = drag.current
        if (!current) { const next = hoverAt(event.clientX, event.clientY); setHover(previous => previous?.kind === next?.kind && previous?.id === next?.id ? previous : next); return }
        const dx = event.clientX - current.startX, dy = event.clientY - current.startY
        if (Math.abs(dx) + Math.abs(dy) > 5) current.moved = true
        if (!current.moved) return
        if (layoutRunning) cancelLayout()
        if (current.id && current.origin) {
          const position = { x: current.origin.x + dx / current.view.zoom, y: current.origin.y + dy / current.view.zoom }
          setPositions(previous => ({ ...previous, [current.id!]: vacantPosition(previous, position, current.id) }))
        } else setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy })
      }}
      onPointerUp={event => {
        const current = drag.current
        drag.current = undefined
        if (!current) return
        if (!current.moved && current.id) onSelect(current.id)
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { drag.current = undefined }}
      onLostPointerCapture={() => { drag.current = undefined }}
      onPointerLeave={() => setHover(undefined)}
    />
    <div className="character-network-tools">
      <input aria-label="搜索人物网络" placeholder="搜索姓名或别名" value={search} onChange={event => { setSearch(event.target.value); setSearchPage(1) }} />
      <button type="button" className="secondary-button" disabled={layoutRunning} onClick={startLayout}>{layoutRunning ? '重新布局中…' : '重新布局'}</button>
      {layoutRunning && <button type="button" className="secondary-button" onClick={cancelLayout}>取消布局</button>}
      {matched.length > 0 && <ul className="character-network-search">{matched.slice(0, searchPage * 50).map(row => <li key={row.id}><button type="button" onClick={() => locate(row.id)}><strong>{row.name}</strong><small>{row.identity ? `${row.identity} · ` : ''}{row.id}</small></button></li>)}{matched.length > searchPage * 50 && <li><button type="button" onClick={() => setSearchPage(value => value + 1)}>更多网络人物（共 {matched.length} 人）</button></li>}</ul>}
    </div>
    {warning && <p className="character-network-warning" role="status">{warning}</p>}
    {hoverPerson && <div className="character-network-hover" role="tooltip"><strong>{hoverPerson.name}</strong><small>{hoverPerson.identity ? `${hoverPerson.identity} · ` : ''}{hoverPerson.id} · {roleLabel(hoverPerson.roleWeight)}</small></div>}
    {hoverPair && <div className="character-network-hover" role="tooltip"><strong>{fromPerson?.name}（{hoverPair.fromId}） ↔ {toPerson?.name}（{hoverPair.toId}）</strong>{hoverPair.forwardLabels.length > 0 && <p>{fromPerson?.name} → {toPerson?.name}：{hoverPair.forwardLabels.join('、')}</p>}{hoverPair.reverseLabels.length > 0 && <p>{toPerson?.name} → {fromPerson?.name}：{hoverPair.reverseLabels.join('、')}</p>}{hoverPair.directionUnclear && <p>方向未明确</p>}</div>}
  </div>
}
