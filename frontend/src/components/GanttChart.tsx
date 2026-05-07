import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, ChevronsUpDown } from 'lucide-react'
import type { ActivityOut, WBSNode } from '../types'
import { getAllActivitiesExtra } from '../utils/pxpUtils'

interface Props {
  activities: ActivityOut[]
  startDate: string
  totalDays: number
  onActivityMove?: (id: string, newEsDays: number) => void
  onDropRelation?: (fromId: string, toId: string) => void
  onSelectActivity?: (id: string | null) => void
  selectedActivityId?: string | null
  wbs?: WBSNode[]
  pxpText?: string
  showConnections?: boolean
  onToggleConnections?: () => void
  hardStarts?: Set<string>
  completedIds?: Set<string>
  // Начатые + завершённые - нельзя перетаскивать
  lockedIds?: Set<string>
}

const BAR_H = 28
const ROW_H = 38
const DEF_LABEL_W = 220
const MIN_CHART_W = 700
const MAX_VISIBLE_ROWS = 40
const CLICK_DELAY = 250
const DRAG_THRESHOLD = 4

function dateOffset(start: string, dateStr: string): number {
  return Math.max(0, (new Date(dateStr).getTime() - new Date(start).getTime()) / 86400000)
}
function addDays(start: string, days: number): string {
  const d = new Date(start); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10)
}

function monthTicks(startDate: string, totalDays: number, locale: string) {
  const ticks: { label: string; offset: number }[] = []
  const sd = new Date(startDate)
  let cur = new Date(sd.getFullYear(), sd.getMonth(), 1)
  while (true) {
    const off = (cur.getTime() - sd.getTime()) / 86400000
    if (off > totalDays + 31) break
    if (off >= -31) {
      ticks.push({
        label: cur.toLocaleDateString(locale, { month: 'short', year: '2-digit' }),
        offset: Math.max(0, off),
      })
    }
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
  }
  return ticks
}

interface RelationData { pred: string; succ: string; type: string; lag: number }

function parseRelationsFromPxp(pxpText: string): RelationData[] {
  const lines = pxpText.split('\n'); const relations: RelationData[] = []; let inSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts.length >= 3 && parts[0] && parts[1]) relations.push({ pred: parts[0], succ: parts[1], type: parts[2] || 'FS', lag: parseFloat(parts[3]) || 0 })
  }
  return relations
}

function buildArrowPath(x1: number, y1: number, x2: number, y2: number, isNonFS: boolean): string {
  if (isNonFS) { const routeY = Math.max(0, Math.min(y1, y2) - 16); return `M${x1},${y1} V${routeY} H${x2} V${y2}` }
  const gap = 8; const dy = Math.abs(y2 - y1)
  if (dy < 2) { if (x2 > x1 + 4) return `M${x1},${y1} H${x2}`; const detour = ROW_H * 0.65; return `M${x1},${y1} H${x1 + gap} V${y1 + detour} H${x2 - gap} V${y2} H${x2}` }
  if (x2 > x1 + 4) { const midX = (x1 + x2) / 2; return `M${x1},${y1} H${midX} V${y2} H${x2}` }
  const rightX = Math.max(x1, x2) + gap * 3; return `M${x1},${y1} H${rightX} V${y2} H${x2}`
}

function clsx(...args: (string | boolean | undefined | null)[]) { return args.filter(Boolean).join(' ') }

export default function GanttChart({
  activities, startDate, totalDays, onActivityMove, onDropRelation,
  onSelectActivity, selectedActivityId, wbs, pxpText,
  showConnections = true, onToggleConnections, hardStarts, completedIds, lockedIds,
}: Props) {
  if (wbs) {}
  const baseScale = useMemo(() => Math.max(MIN_CHART_W, totalDays * 14) / Math.max(totalDays, 1), [totalDays])
  const [scale, setScale] = useState(baseScale)
  useEffect(() => setScale(baseScale), [baseScale])
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US'
  const [labelW, setLabelW] = useState(DEF_LABEL_W)
  const [resizeState, setResizeState] = useState<{ startX: number; startW: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activities.map(a => a.id)))
  useEffect(() => { setExpanded(prev => { const next = new Set(prev); activities.forEach(a => next.add(a.id)); return next }) }, [activities])

  const [drag, setDragState] = useState<{
    id: string; startX: number; currentX: number; origEs: number; hasMoved: boolean
  } | null>(null)
  const dropTargetRef = useRef<string | null>(null)

  const dragWithTarget = useMemo(() => {
    if (!drag) return null
    return { ...drag, dropTargetId: dropTargetRef.current }
  }, [drag])

  const [zoom, setZoom] = useState<{ startX: number; startScale: number } | null>(null)
  const [pan, setPan] = useState<{ startX: number; startScrollLeft: number } | null>(null)
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)

  const chartW = Math.max(MIN_CHART_W, totalDays * scale)
  const ticks = useMemo(() => monthTicks(startDate, totalDays, locale), [startDate, totalDays, locale])

  const clickStateRef = useRef<{ timer: ReturnType<typeof setTimeout>; activityId: string } | null>(null)
  useEffect(() => { return () => { if (clickStateRef.current) clearTimeout(clickStateRef.current.timer) } }, [])

  const handleLabelClick = useCallback((actId: string) => {
    if (clickStateRef.current) { clearTimeout(clickStateRef.current.timer); if (clickStateRef.current.activityId === actId) { clickStateRef.current = null; return } }
    clickStateRef.current = { timer: setTimeout(() => { onSelectActivity?.(actId); clickStateRef.current = null }, CLICK_DELAY), activityId: actId }
  }, [onSelectActivity])

  useEffect(() => {
    if (!resizeState) return
    const onMove = (e: MouseEvent) => setLabelW(Math.max(120, Math.min(600, resizeState.startW + (e.clientX - resizeState.startX))))
    const onUp = () => setResizeState(null)
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [resizeState])

  const { visible, hasHierarchy, childrenMap } = useMemo(() => {
    const byId = new Map(activities.map(a => [a.id, a]))
    const children = new Map<string, ActivityOut[]>()
    activities.forEach(a => { if (a.parent_id && byId.has(a.parent_id)) { if (!children.has(a.parent_id)) children.set(a.parent_id, []); children.get(a.parent_id)!.push(a) } })
    const roots = activities.filter(a => !a.parent_id || !byId.has(a.parent_id))
    const out: Array<ActivityOut & { level: number }> = []
    function walk(node: ActivityOut, level: number) { out.push({ ...node, level }); if (expanded.has(node.id)) (children.get(node.id) || []).forEach(c => walk(c, level + 1)) }
    roots.forEach(r => walk(r, 0))
    return { visible: out, hasHierarchy: activities.some(a => a.parent_id && byId.has(a.parent_id)), childrenMap: children }
  }, [activities, expanded])

  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allExpanded = expanded.size >= activities.length
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(activities.map(a => a.id)))

  const rowAtPoint = useCallback((clientX: number, clientY: number): number | null => {
    const c = scrollRef.current; if (!c) return null
    const rect = c.getBoundingClientRect()
    const mx = clientX - rect.left + c.scrollLeft - labelW
    const my = clientY - rect.top + c.scrollTop - 36
    if (mx < 0 || my < 0) return null
    const idx = Math.floor(my / ROW_H)
    return idx >= 0 && idx < visible.length ? idx : null
  }, [labelW, visible])

  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      setDragState(prev => {
        if (!prev) return null
        const moved = Math.abs(e.clientX - prev.startX) > DRAG_THRESHOLD
        const hasMoved = prev.hasMoved || moved
        let target: string | null = null
        if (hasMoved) {
          const ri = rowAtPoint(e.clientX, e.clientY)
          if (ri !== null) {
            const targetAct = visible[ri]
            if (targetAct && targetAct.id !== prev.id) target = targetAct.id
          }
        }
        dropTargetRef.current = target
        return { ...prev, currentX: e.clientX, hasMoved }
      })
    }
    const onUp = (e: MouseEvent) => {
      if (drag.hasMoved) {
        const target = dropTargetRef.current
        if (target && onDropRelation) {
          onDropRelation(drag.id, target)
          dropTargetRef.current = null
          setDragState(null)
          return
        }
        const dx = e.clientX - drag.startX
        const newEs = drag.origEs + dx / scale
        onActivityMove?.(drag.id, Math.max(0, Math.round(newEs)))
      }
      dropTargetRef.current = null
      setDragState(null)
    }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [drag, scale, onActivityMove, onDropRelation, rowAtPoint])

  useEffect(() => {
    if (!zoom) return
    const onMove = (e: MouseEvent) => setScale(Math.max(2, Math.min(250, zoom.startScale * (1 + (e.clientX - zoom.startX) / 300))))
    const onUp = () => setZoom(null)
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [zoom])

  useEffect(() => {
    if (!pan) return
    const onMove = (e: MouseEvent) => { if (scrollRef.current) scrollRef.current.scrollLeft = pan.startScrollLeft - (e.clientX - pan.startX) }
    const onUp = () => setPan(null)
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [pan])

  const dragInfo = useMemo(() => {
    if (!dragWithTarget || !dragWithTarget.hasMoved) return null
    const shiftDays = Math.round((dragWithTarget.currentX - dragWithTarget.startX) / scale)
    return { shiftDays, newDate: addDays(startDate, Math.max(0, dragWithTarget.origEs + shiftDays)) }
  }, [dragWithTarget, scale, startDate])

  const extrasMap = useMemo(() => {
    if (!pxpText) return new Map<string, { actualDuration: number | null; remainingDuration: number | null }>()
    return getAllActivitiesExtra(pxpText)
  }, [pxpText])

  const arrowPaths = useMemo(() => {
    if (!pxpText || !showConnections) return []
    const relations = parseRelationsFromPxp(pxpText)
    const visibleIds = new Set(visible.map(a => a.id))
    const posMap = new Map<string, { es: number; ef: number; row: number; critical: boolean }>()
    visible.forEach((act, idx) => posMap.set(act.id, { es: dateOffset(startDate, act.es_date), ef: dateOffset(startDate, act.ef_date), row: idx, critical: act.on_critical }))
    const barTop = (ROW_H - BAR_H) / 2
    return relations.filter(r => r.pred !== r.succ && visibleIds.has(r.pred) && visibleIds.has(r.succ)).map(r => {
      const from = posMap.get(r.pred)!; const to = posMap.get(r.succ)!; const isNonFS = r.type !== 'FS'
      let fromX: number, fromY: number, toX: number, toY: number
      switch (r.type) {
        case 'SS': fromX = from.es * scale; fromY = from.row * ROW_H + barTop; toX = to.es * scale; toY = to.row * ROW_H + barTop; break
        case 'FF': fromX = from.ef * scale; fromY = from.row * ROW_H + barTop; toX = to.ef * scale; toY = to.row * ROW_H + barTop; break
        case 'SF': fromX = from.es * scale; fromY = from.row * ROW_H + barTop; toX = to.ef * scale; toY = to.row * ROW_H + barTop; break
        default: fromX = (from.ef + r.lag) * scale; fromY = from.row * ROW_H + ROW_H / 2; toX = to.es * scale; toY = to.row * ROW_H + ROW_H / 2; break
      }
      return { d: buildArrowPath(fromX, fromY, toX, toY, isNonFS), critical: from.critical && to.critical }
    })
  }, [pxpText, visible, scale, startDate, showConnections])

  const handleNameDoubleClick = useCallback((es: number) => { scrollRef.current?.scrollTo({ left: Math.max(0, es * scale), behavior: 'smooth' }) }, [scale])
  const handleTimeScaleDoubleClick = useCallback(() => {
    const c = scrollRef.current; if (!c) return
    setScale(Math.min(250, Math.max(2, (c.clientWidth - labelW) / Math.max(totalDays, 1)))); c.scrollTo({ left: 0, behavior: 'smooth' })
  }, [labelW, totalDays])

  const HEADER_H = 36
  const maxScrollH = HEADER_H + MAX_VISIBLE_ROWS * ROW_H
  const bgEven = '#09121a'; const bgOdd = '#112638'

  const dropTargetName = useMemo(() => {
    if (!dragWithTarget?.dropTargetId) return null
    const act = visible.find(a => a.id === dragWithTarget.dropTargetId)
    return act?.name ?? null
  }, [dragWithTarget?.dropTargetId, visible])

  return (
    <div ref={scrollRef} className="overflow-auto rounded-xl border border-steel-700 bg-steel-950 select-none"
      style={{ maxHeight: maxScrollH, cursor: pan ? 'grabbing' : 'default' }}>
      <div style={{ minWidth: labelW + chartW, position: 'relative' }}>
        <div className="sticky top-0 z-10 bg-steel-900">
          <div className="flex border-b border-steel-700" style={{ height: HEADER_H, cursor: zoom ? 'ew-resize' : 'default' }}>
            <div className="sticky left-0 bg-steel-900 relative px-3 py-2 text-xs font-mono text-steel-400 border-r border-steel-700 flex-shrink-0 flex items-center justify-between"
              style={{ width: labelW, minWidth: labelW, zIndex: 20 }}>
              <span>{t('task')}</span>
              <div className="flex items-center gap-1.5">
                {hasHierarchy && (
                  <button onClick={toggleAll} className={clsx('flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors',
                    allExpanded ? 'border-steel-600 text-steel-400 hover:bg-steel-800 hover:text-steel-200' : 'border-amber-500/40 text-amber-400 hover:bg-amber-400/10')}
                    title={allExpanded ? t('collapse_all') : t('expand_all')}>
                    <ChevronsUpDown className="w-3 h-3" />{allExpanded ? t('collapse_all') : t('expand_all')}
                  </button>
                )}
                <label className="flex items-center gap-1 text-[10px] text-steel-500 cursor-pointer select-none whitespace-nowrap">
                  <input type="checkbox" checked={showConnections} onChange={onToggleConnections} className="accent-amber-400 w-3 h-3" />
                  {t('show_connections')}
                </label>
              </div>
              <div className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-amber-400/40 transition-colors"
                style={{ transform: 'translateX(50%)', zIndex: 25 }}
                onMouseDown={e => { e.stopPropagation(); e.preventDefault(); setResizeState({ startX: e.clientX, startW: labelW }) }} />
            </div>
            <div className="relative flex-1 overflow-hidden" style={{ height: HEADER_H }}
              onMouseDown={e => { if (e.button === 0) setZoom({ startX: e.clientX, startScale: scale }) }}
              onDoubleClick={e => { e.preventDefault(); handleTimeScaleDoubleClick() }}>
              <svg width={chartW} height={HEADER_H}>
                {ticks.map((tk, i) => <g key={i}>
                  <line x1={tk.offset * scale} y1={0} x2={tk.offset * scale} y2={HEADER_H} stroke="#334e68" strokeWidth={1} />
                  <text x={tk.offset * scale + 4} y={22} fill="#627d98" fontSize={10} fontFamily="JetBrains Mono">{tk.label}</text>
                </g>)}
              </svg>
            </div>
          </div>
        </div>
        {arrowPaths.length > 0 && (
          <div style={{ position: 'absolute', left: labelW, top: HEADER_H, width: chartW, height: visible.length * ROW_H, overflow: 'hidden', pointerEvents: 'none', zIndex: 1 }}>
            <svg width={chartW} height={visible.length * ROW_H}>
              <defs>
                <marker id="arrowGray" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse"><polygon points="0,0.5 7,3 0,5.5" fill="rgba(98,125,152,0.55)" /></marker>
                <marker id="arrowRed" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse"><polygon points="0,0.5 7,3 0,5.5" fill="rgba(244,63,94,0.55)" /></marker>
              </defs>
              {arrowPaths.map((arrow, i) => <path key={i} d={arrow.d} fill="none" stroke={arrow.critical ? 'rgba(244,63,94,0.4)' : 'rgba(98,125,152,0.3)'} strokeWidth={arrow.critical ? 1.5 : 1.2} markerEnd={arrow.critical ? 'url(#arrowRed)' : 'url(#arrowGray)'} />)}
            </svg>
          </div>
        )}
        {dragInfo && (
          <div className="fixed top-20 right-6 z-50 bg-steel-900 border border-amber-500/40 rounded-lg px-3 py-2 shadow-xl text-xs font-mono">
            <div className="text-amber-400 font-semibold mb-0.5">
              {dropTargetName ? `${t('create_relation')}: ${dropTargetName} → ${dragWithTarget?.id} (FS)` : t('dragging')}
            </div>
            {!dropTargetName && (
              <>
                <div className="text-steel-300">{t('shift')}: <span className="text-steel-100">{dragInfo.shiftDays > 0 ? '+' : ''}{dragInfo.shiftDays} {t('days_suffix')}</span></div>
                <div className="text-steel-300">{t('new_start')}: <span className="text-steel-100">{dragInfo.newDate}</span></div>
              </>
            )}
            {dropTargetName && (
              <div className="text-emerald-400 text-[10px] mt-0.5">{t('drop_to_link_hint')}</div>
            )}
          </div>
        )}
        {tooltip && (
          <div className="fixed z-50 pointer-events-none bg-steel-800 border border-steel-600 text-steel-100 text-xs font-sans px-2.5 py-1.5 rounded shadow-lg max-w-sm whitespace-normal"
            style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}>{tooltip.text}</div>
        )}
        <div>
          {visible.map((act, rowIdx) => {
            const es = dateOffset(startDate, act.es_date)
            const ef = dateOffset(startDate, act.ef_date)
            const lf = dateOffset(startDate, act.lf_date)
            let displayEs = es, displayEf = ef, isDragging = false
            if (dragWithTarget && dragWithTarget.id === act.id && dragWithTarget.hasMoved) {
              const dayShift = (dragWithTarget.currentX - dragWithTarget.startX) / scale
              displayEs = es + dayShift; displayEf = ef + dayShift; isDragging = true
            }
            const barW = Math.max(2, (displayEf - displayEs) * scale)
            const floatW = Math.max(0, (lf - ef) * scale)
            const isMilestone = act.duration === 0
            const hasChildren = (childrenMap.get(act.id)?.length || 0) > 0
            const isSelected = selectedActivityId === act.id
            const isHardStart = hardStarts?.has(act.id) ?? false
            const completed = completedIds?.has(act.id) ?? false
            // Заблокировано = нельзя двигать (начата или завершена)
            const isLocked = lockedIds?.has(act.id) ?? false
            const isDropTarget = dragWithTarget?.dropTargetId === act.id && dragWithTarget.id !== act.id
            const rowBg = rowIdx % 2 === 0 ? bgEven : bgOdd
            const selectedBg = '#131f2e'
            const extras = extrasMap.get(act.id)
            const hasActual = extras?.actualDuration != null && extras.actualDuration > 0
            const hasRemain = extras?.remainingDuration != null && extras.remainingDuration > 0
            const showExtra = hasActual || hasRemain
            // Если остаток = 0 (100% выполнено) - показываем только факт, без "+?"
            const remainIsZero = extras?.remainingDuration != null && extras.remainingDuration === 0
            const extraText = showExtra
              ? remainIsZero || !hasRemain
                ? `${extras!.actualDuration ?? '?'}d`
                : `${extras!.actualDuration ?? '?'}+${extras!.remainingDuration ?? '?'}d`
              : ''
            const actualLineX = hasActual && !isMilestone && act.duration > 0
              ? Math.min(barW, (extras!.actualDuration! / act.duration) * barW) : null
            let barFill: string; let barOpacity: number; let textOpacity: number
            if (completed) { barFill = act.on_critical ? 'url(#critGradMuted)' : 'url(#normalGradMuted)'; barOpacity = 0.85; textOpacity = 0.55 }
            else { barFill = act.on_critical ? 'url(#critGrad)' : 'url(#normalGrad)'; barOpacity = isDragging ? 0.7 : 0.92; textOpacity = 0.9 }
            let barStroke: string; let barStrokeWidth: number
            if (isDropTarget) { barStroke = '#34d399'; barStrokeWidth = 2.5 }
            else if (isDragging) { barStroke = 'rgba(255,255,255,0.6)'; barStrokeWidth = 1 }
            else if (isLocked && !completed) { barStroke = '#60a5fa'; barStrokeWidth = 1.5 }
            else if (isHardStart) { barStroke = '#fbbf24'; barStrokeWidth = 2 }
            else { barStroke = 'none'; barStrokeWidth = 0 }
            // Курсор для заблокированных работ
            const barCursor = isLocked ? 'not-allowed' : (dragWithTarget?.id === act.id ? 'grabbing' : 'grab')
            const handleBarMouseDown = (e: React.MouseEvent) => {
              // Начатые и завершённые работы нельзя перетаскивать
              if (isLocked) return
              e.stopPropagation()
              setDragState({ id: act.id, startX: e.clientX, currentX: e.clientX, origEs: es, hasMoved: false })
              dropTargetRef.current = null
            }
            return (
              <div key={act.id} className="relative flex items-center border-b border-steel-800 transition-colors"
                style={{ height: ROW_H, background: isSelected ? selectedBg : rowBg }}>
                <div className="sticky left-0 flex items-center gap-1 px-3 border-r border-steel-700 flex-shrink-0 overflow-hidden cursor-default transition-colors self-stretch"
                  style={{ width: labelW, minWidth: labelW, zIndex: 20, background: isSelected ? selectedBg : rowBg, boxShadow: isSelected ? 'inset 0 0 0 1px rgba(251,191,36,0.3)' : undefined }}
                  onClick={e => { if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('label')) return; handleLabelClick(act.id) }}
                  onDoubleClick={e => {
                    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('label')) return
                    e.preventDefault(); e.stopPropagation()
                    if (clickStateRef.current) { clearTimeout(clickStateRef.current.timer); clickStateRef.current = null }
                    if (hasChildren) { const ch = childrenMap.get(act.id) || []; if (ch.length > 0) { if (!expanded.has(act.id)) toggle(act.id); const earliest = ch.reduce((a, b) => new Date(a.es_date) < new Date(b.es_date) ? a : b); handleNameDoubleClick(dateOffset(startDate, earliest.es_date)); return } }
                    handleNameDoubleClick(es)
                  }}>
                  <div className="flex items-center min-w-0" style={{ marginLeft: act.level * 16 }}>
                    {hasChildren ? (
                      <button onClick={e => { e.stopPropagation(); toggle(act.id) }} onDoubleClick={e => e.stopPropagation()}
                        className="mr-1 p-0.5 rounded hover:bg-steel-700 focus:outline-none flex-shrink-0">
                        {expanded.has(act.id) ? <ChevronDown className="w-3.5 h-3.5 text-amber-400" /> : <ChevronRight className="w-3.5 h-3.5 text-steel-500" />}
                      </button>
                    ) : <span className="w-5 inline-block flex-shrink-0" />}
                    {act.on_critical && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 flex-shrink-0 mr-1.5" />}
                    <span className={`font-mono text-xs truncate ${completed ? 'text-steel-500' : 'text-steel-300'}`} title={act.name}>
                      <span className="text-steel-500 mr-1">{act.id}</span>{act.name}
                    </span>
                  </div>
                </div>
                <div className="flex-1" style={{ height: ROW_H, cursor: pan ? 'grabbing' : 'default' }}
                  onMouseDown={e => { if (e.button === 0) { e.preventDefault(); if (scrollRef.current) setPan({ startX: e.clientX, startScrollLeft: scrollRef.current.scrollLeft }) } }}>
                  <svg width={chartW} height={ROW_H}>
                    {ticks.map((tk, i) => <line key={i} x1={tk.offset * scale} y1={0} x2={tk.offset * scale} y2={ROW_H} stroke="#1a3347" strokeWidth={1} />)}
                    {isMilestone ? (
                      <g style={{ cursor: barCursor }}
                        onMouseDown={handleBarMouseDown}
                        onMouseEnter={e => setTooltip({ text: act.name + (showExtra ? `  [${Math.round(act.duration)}d${extraText ? ' · ' + extraText : ''}]` : ''), x: e.clientX, y: e.clientY })}
                        onMouseMove={e => setTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null)}
                        onMouseLeave={() => setTooltip(null)}>
                        <rect x={displayEs * scale - 12} y={ROW_H / 2 - 12} width={24} height={24} fill="transparent" />
                        <polygon points={`${displayEs * scale},${ROW_H / 2 - 8} ${displayEs * scale + 8},${ROW_H / 2} ${displayEs * scale},${ROW_H / 2 + 8} ${displayEs * scale - 8},${ROW_H / 2}`}
                          fill={completed ? '#6b5060' : act.on_critical ? '#f43f5e' : '#fbbf24'} opacity={isDragging ? 0.7 : 1} stroke={isDragging ? '#fff' : 'none'} strokeWidth={1} />
                      </g>
                    ) : (
                      <g style={{ cursor: barCursor }}
                        onMouseDown={handleBarMouseDown}
                        onMouseEnter={e => setTooltip({ text: act.name + (showExtra ? `  [${Math.round(act.duration)}d${extraText ? ' · ' + extraText : ''}]` : ''), x: e.clientX, y: e.clientY })}
                        onMouseMove={e => setTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null)}
                        onMouseLeave={() => setTooltip(null)}>
                        {floatW > 0 && <rect x={displayEf * scale} y={(ROW_H - BAR_H * 0.4) / 2} width={floatW} height={BAR_H * 0.4} rx={2} fill="#1e3a52" opacity={completed ? 0.3 : 0.7} />}
                        <rect x={displayEs * scale} y={(ROW_H - BAR_H) / 2} width={barW} height={BAR_H} rx={4} fill={barFill} opacity={barOpacity} stroke={barStroke} strokeWidth={barStrokeWidth} />
                        {actualLineX != null && actualLineX > 2 && (
                          <line x1={displayEs * scale + actualLineX} y1={(ROW_H - BAR_H) / 2 + 2} x2={displayEs * scale + actualLineX} y2={(ROW_H - BAR_H) / 2 + BAR_H - 2}
                            stroke={completed ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.85)'} strokeWidth={2} strokeLinecap="round" />
                        )}
                        {barW > 12 && (
                          <text
                            x={displayEs * scale + barW / 2}
                            y={ROW_H / 2 + 4}
                            fill="white" fontSize={9} fontFamily="JetBrains Mono"
                            textAnchor="middle" opacity={textOpacity}
                            clipPath={`url(#clip-${act.id})`}
                          >
                            {Math.round(act.duration)}d{showExtra ? ` ${extraText}` : ''}
                          </text>
                        )}
                        <clipPath id={`clip-${act.id}`}>
                          <rect x={displayEs * scale} y={(ROW_H - BAR_H) / 2} width={barW} height={BAR_H} />
                        </clipPath>
                      </g>
                    )}
                  </svg>
                </div>
              </div>
            )
          })}
          <svg width={0} height={0} style={{ position: 'absolute' }}>
            <defs>
              <linearGradient id="critGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#fb7185" /><stop offset="100%" stopColor="#be123c" /></linearGradient>
              <linearGradient id="critGradMuted" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7a5560" /><stop offset="100%" stopColor="#4a2a35" /></linearGradient>
              <linearGradient id="normalGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#486581" /><stop offset="100%" stopColor="#243b53" /></linearGradient>
              <linearGradient id="normalGradMuted" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3a4a56" /><stop offset="100%" stopColor="#1e2e3a" /></linearGradient>
            </defs>
          </svg>
        </div>
      </div>
    </div>
  )
}
