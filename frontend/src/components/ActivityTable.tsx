import { useState, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, ChevronsUpDown, Plus, Trash2, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, X, Pencil } from 'lucide-react'
import type { ActivityOut } from '../types'
import clsx from 'clsx'

interface Props {
  activities: ActivityOut[]
  hardStarts?: Set<string>
  completedIds?: Set<string>
  onAddActivity?: (afterId: string | null) => void
  onRemoveActivity?: (id: string) => void
  onMoveActivity?: (id: string, direction: 'up' | 'down' | 'left' | 'right') => void
  onRenameActivity?: (id: string, newName: string) => void
  onSelectActivity?: (id: string | null) => void
  selectedActivityId?: string | null
}

interface FlatNode extends ActivityOut { level: number; hasChildren: boolean }

function ConfirmModal({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-steel-950/80 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-steel-900 border border-steel-700 rounded-2xl shadow-2xl px-6 py-5 w-80 animate-slide-in">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-steel-200">{t('confirm_delete_title')}</span>
          <button onClick={onCancel} className="p-1 rounded hover:bg-steel-700 text-steel-400"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-steel-400 mb-4">
          {t('confirm_delete_body')}<br />
          <span className="text-steel-200 font-mono mt-1 block truncate">{name}</span>
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-steel-400 border border-steel-700 rounded-lg hover:bg-steel-800 transition-colors">{t('cancel')}</button>
          <button onClick={onConfirm} className="px-3 py-1.5 text-xs text-rose-400 border border-rose-500/40 rounded-lg hover:bg-rose-500/10 transition-colors">{t('delete')}</button>
        </div>
      </div>
    </div>
  )
}

function EditNameModal({ name, onConfirm, onCancel }: { name: string; onConfirm: (n: string) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState(name)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-steel-950/80 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-steel-900 border border-steel-700 rounded-2xl shadow-2xl px-6 py-5 w-96 animate-slide-in">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-steel-200">{t('rename_activity')}</span>
          <button onClick={onCancel} className="p-1 rounded hover:bg-steel-700 text-steel-400"><X className="w-4 h-4" /></button>
        </div>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && value.trim()) onConfirm(value.trim()); if (e.key === 'Escape') onCancel() }}
          className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 focus:outline-none focus:border-amber-400/60 transition-colors mb-4"
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-steel-400 border border-steel-700 rounded-lg hover:bg-steel-800 transition-colors">{t('cancel')}</button>
          <button onClick={() => value.trim() && onConfirm(value.trim())} className="px-3 py-1.5 text-xs text-amber-400 border border-amber-500/40 rounded-lg hover:bg-amber-400/10 transition-colors">{t('save')}</button>
        </div>
      </div>
    </div>
  )
}

export default function ActivityTable({
  activities, hardStarts, completedIds,
  onAddActivity, onRemoveActivity, onMoveActivity, onRenameActivity,
  onSelectActivity, selectedActivityId,
}: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [editTarget, setEditTarget] = useState<{ id: string; name: string } | null>(null)
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())

  const handleRowClick = useCallback((id: string | null) => {
    onSelectActivity?.(id)
    // Прокручиваем строку в видимую область с учётом высоты панели свойств рааботы
    setTimeout(() => {
      const row = rowRefs.current.get(id ?? '')
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }, [onSelectActivity])

  const { rows, hasHierarchy } = useMemo(() => {
    const byId = new Map<string, ActivityOut>()
    const children = new Map<string, ActivityOut[]>()
    activities.forEach(a => {
      byId.set(a.id, a)
      if (a.parent_id) {
        if (!children.has(a.parent_id)) children.set(a.parent_id, [])
        children.get(a.parent_id)!.push(a)
      }
    })
    const hierarchyExists = activities.some(a => a.parent_id && byId.has(a.parent_id))
    const roots = activities.filter(a => !a.parent_id || !byId.has(a.parent_id))
    const result: FlatNode[] = []
    function walk(node: ActivityOut, level: number) {
      const ch = children.get(node.id) || []
      result.push({ ...node, level, hasChildren: ch.length > 0 })
      if (expanded.has(node.id)) ch.forEach(c => walk(c, level + 1))
    }
    roots.forEach(r => walk(r, 0))
    return { rows: result, hasHierarchy: hierarchyExists }
  }, [activities, expanded])

  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allExpanded = expanded.size >= activities.length
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(activities.map(a => a.id)))

  const display = hasHierarchy ? rows : activities.map(a => ({ ...a, level: 0, hasChildren: false }))
  const flatIds = display.map(a => a.id)

  return (
    <div className="space-y-3">
      {deleteTarget && (
        <ConfirmModal
          name={deleteTarget.name}
          onConfirm={() => { onRemoveActivity?.(deleteTarget.id); setDeleteTarget(null) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {editTarget && (
        <EditNameModal
          name={editTarget.name}
          onConfirm={newName => { onRenameActivity?.(editTarget.id, newName); setEditTarget(null) }}
          onCancel={() => setEditTarget(null)}
        />
      )}
      {hasHierarchy && (
        <button onClick={toggleAll}
          className={clsx('flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-lg border transition-colors',
            allExpanded ? 'border-steel-600 text-steel-400 hover:bg-steel-800 hover:text-steel-200' : 'border-amber-500/40 text-amber-400 hover:bg-amber-400/10')}>
          <ChevronsUpDown className="w-3.5 h-3.5" />
          {allExpanded ? t('collapse_all') : t('expand_all')}
        </button>
      )}
      <div className="overflow-x-auto rounded-xl border border-steel-700">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="bg-steel-900 border-b border-steel-700">
              {[t('col_id'), t('col_name'), t('col_dur'), t('col_es'), t('col_ef'), t('col_ls'), t('col_lf'), t('col_tf'), t('col_ff'), t('col_crit')].map(h => (
                <th key={h} className="px-3 py-2 text-left text-steel-400 font-medium whitespace-nowrap">{h}</th>
              ))}
              <th className="px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {display.map((a, i) => {
              const isHardStart = hardStarts?.has(a.id) ?? false
              const completed = completedIds?.has(a.id) ?? false
              const isSelected = selectedActivityId === a.id
              const isFirst = i === 0
              const isLast = i === display.length - 1

              return (
                <tr key={`${a.id}-${i}`}
                  ref={el => { if (el) rowRefs.current.set(a.id, el); else rowRefs.current.delete(a.id) }}
                  onClick={() => handleRowClick(isSelected ? null : a.id)}
                  className={clsx(
                    'border-b border-steel-800 transition-colors cursor-pointer',
                    isSelected ? 'bg-amber-400/5 border-l-2 border-l-amber-400' : i % 2 === 0 ? 'bg-steel-950 hover:bg-steel-800/30' : 'bg-steel-900/30 hover:bg-steel-800/30',
                    a.on_critical && !isSelected && 'border-l-2 border-l-rose-500',
                    !a.on_critical && isHardStart && !isSelected && 'border-l-2 border-l-amber-400',
                    completed && 'opacity-50'
                  )}>
                  {/* ID */}
                  <td className="px-3 py-1.5 text-steel-400">
                    <span className="inline-flex items-center gap-1.5">
                      {a.on_critical && <span className="w-2 h-2 rounded-full bg-rose-500 inline-block flex-shrink-0" />}
                      {!a.on_critical && isHardStart && <span className="w-2 h-2 rounded-full bg-amber-400 inline-block flex-shrink-0" />}
                      {a.id}
                    </span>
                  </td>
                  {/* Name + action buttons when selected */}
                  <td className="px-3 py-1.5 text-steel-200 min-w-[240px]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center min-w-0" style={{ marginLeft: a.level * 20 }}>
                        {a.hasChildren
                          ? <button onClick={e => { e.stopPropagation(); toggle(a.id) }} className="mr-1 p-0.5 rounded hover:bg-steel-700 focus:outline-none">
                              {expanded.has(a.id) ? <ChevronDown className="w-3.5 h-3.5 text-amber-400" /> : <ChevronRight className="w-3.5 h-3.5 text-steel-500" />}
                            </button>
                          : <span className="w-5 inline-block" />}
                        <span className="truncate" title={a.name}>{a.name}</span>
                      </div>
                      {/* Кнопки действий - показываем только для выбранной строки */}
                      {isSelected && (
                        <div className="flex items-center gap-0.5 flex-shrink-0 ml-2" onClick={e => e.stopPropagation()}>
                          <button onClick={e => { e.stopPropagation(); setEditTarget({ id: a.id, name: a.name }) }} title={t('rename_activity')}
                            className="p-1 rounded hover:bg-amber-400/20 text-steel-500 hover:text-amber-400 transition-colors">
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button onClick={() => onAddActivity?.(a.id)} title={t('add_activity')}
                            className="p-1 rounded hover:bg-emerald-500/20 text-steel-500 hover:text-emerald-400 transition-colors">
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => setDeleteTarget({ id: a.id, name: a.name })} title={t('delete')}
                            className="p-1 rounded hover:bg-rose-500/20 text-steel-500 hover:text-rose-400 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                          <div className="w-px h-4 bg-steel-700 mx-0.5" />
                          <button onClick={() => onMoveActivity?.(a.id, 'left')} title={t('move_left')}
                            className="p-1 rounded hover:bg-steel-700 text-steel-500 hover:text-steel-300 transition-colors">
                            <ArrowLeft className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => onMoveActivity?.(a.id, 'right')} title={t('move_right')}
                            className="p-1 rounded hover:bg-steel-700 text-steel-500 hover:text-steel-300 transition-colors">
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => onMoveActivity?.(a.id, 'up')} disabled={isFirst} title={t('move_up')}
                            className="p-1 rounded hover:bg-steel-700 text-steel-500 hover:text-steel-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => onMoveActivity?.(a.id, 'down')} disabled={isLast} title={t('move_down')}
                            className="p-1 rounded hover:bg-steel-700 text-steel-500 hover:text-steel-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-amber-400 text-right">{Math.round(a.duration)}</td>
                  <td className="px-3 py-1.5 text-steel-300">{a.es_date}</td>
                  <td className="px-3 py-1.5 text-steel-300">{a.ef_date}</td>
                  <td className="px-3 py-1.5 text-steel-500">{a.ls_date}</td>
                  <td className="px-3 py-1.5 text-steel-500">{a.lf_date}</td>
                  <td className={clsx('px-3 py-1.5 text-right font-medium', a.tf === 0 ? 'text-rose-400' : 'text-emerald-400')}>{a.tf.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-steel-400 text-right">{a.ff.toFixed(1)}</td>
                  <td className="px-3 py-1.5">
                    {a.on_critical && <span className="inline-block px-1.5 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-sans font-semibold">{t('critical_badge')}</span>}
                    {!a.on_critical && isHardStart && <span className="inline-block px-1.5 py-0.5 bg-amber-400/20 text-amber-400 rounded text-[10px] font-sans font-semibold">{t('hard_start_badge')}</span>}
                    {completed && !a.on_critical && !isHardStart && <span className="inline-block px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 rounded text-[10px] font-sans font-semibold">{t('completed_badge')}</span>}
                  </td>
                  <td className="px-3 py-1.5" />
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {/* Кнопка добавить в конец */}
      {onAddActivity && (
        <button onClick={() => onAddActivity(null)}
          className="flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-lg border border-dashed border-steel-600 text-steel-500 hover:border-steel-400 hover:text-steel-300 transition-colors">
          <Plus className="w-3 h-3" />{t('add_activity')}
        </button>
      )}
    </div>
  )
}
