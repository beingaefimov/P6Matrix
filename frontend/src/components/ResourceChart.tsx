import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Filter, ChevronDown, Check, Plus, X, Trash2, Pencil } from 'lucide-react'
import type { ResourceOut } from '../types'
import type { ActivityDisplay } from '../engine/useScheduler'
import type { Assignment } from '../engine/cpmEngine'

type FilterMode = 'all' | 'overloaded' | 'underloaded'

interface Props {
  resources: ResourceOut[]
  resourceLoad: Record<string, number[]>
  startDate: string
  activities?: ActivityDisplay[]
  assignments?: Assignment[]
  onAddResource?: (resId: string, name: string, maxUnits: number, costPerUnit: number) => void
  onRemoveResource?: (resId: string) => void
  onUpdateResource?: (resId: string, name: string, maxUnits: number, costPerUnit: number) => void
}

export default function ResourceChart({ resources, resourceLoad, startDate, activities = [], assignments = [], onAddResource, onRemoveResource, onUpdateResource }: Props) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FilterMode>('all')
  const [selectedResIds, setSelectedResIds] = useState<Set<string>>(new Set())
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [showNewResModal, setShowNewResModal] = useState(false)
  const [newResId, setNewResId] = useState('R' + String(Date.now()).slice(-5))
  const [newResName, setNewResName] = useState('')
  const [newResMax, setNewResMax] = useState('1')
  const [newResCost, setNewResCost] = useState('0')
  const [deleteResTarget, setDeleteResTarget] = useState<{ id: string; name: string } | null>(null)
  const [editResTarget, setEditResTarget] = useState<{ id: string; name: string; maxUnits: string; costPerUnit: string } | null>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{
    x: number; y: number; label: string; load: string; acts: Array<{id:string;name:string}>
  } | null>(null)

  const openNewResModal = () => {
    setNewResId('R' + String(Date.now()).slice(-5))
    setNewResName('')
    setNewResMax('1')
    setNewResCost('0')
    setShowNewResModal(true)
  }

  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  const resourceStatus = useMemo(() => {
    return resources.map(res => {
      const load = resourceLoad[res.id] || []
      const peak = Math.max(...load, 0)
      const overloaded = load.some(v => v > res.max_units)
      const underloaded = peak > 0 && peak < res.max_units
      return { res, load, peak, overloaded, underloaded }
    })
  }, [resources, resourceLoad])

  const categoryFiltered = useMemo(() => {
    switch (filter) {
      case 'overloaded':  return resourceStatus.filter(r => r.overloaded)
      case 'underloaded': return resourceStatus.filter(r => r.underloaded)
      default: return resourceStatus
    }
  }, [resourceStatus, filter])

  const filtered = useMemo(() => {
    if (selectedResIds.size === 0) return categoryFiltered
    return categoryFiltered.filter(r => selectedResIds.has(r.res.id))
  }, [categoryFiltered, selectedResIds])

  const actsByResource = useMemo(() => {
    const actById = new Map(activities.map(a => [a.id, a]))
    const m = new Map<string, Array<{ id: string; name: string; es: number; ef: number }>>()
    for (const r of resources) m.set(r.id, [])
    for (const asgn of assignments) {
      const list = m.get(asgn.resource_id)
      if (!list) continue
      const act = actById.get(asgn.activity_id)
      if (act) list.push({ id: act.id, name: act.name, es: act.es_days, ef: act.ef_days })
    }
    return m
  }, [resources, assignments, activities])

  const counts = {
    all: resourceStatus.length,
    overloaded: resourceStatus.filter(r => r.overloaded).length,
    underloaded: resourceStatus.filter(r => r.underloaded).length,
  }

  const filterButtons: { id: FilterMode; label: string; count: number }[] = [
    { id: 'all', label: t('filter_all'), count: counts.all },
    { id: 'overloaded', label: t('filter_overloaded'), count: counts.overloaded },
    { id: 'underloaded',label: t('filter_underloaded'),count: counts.underloaded },
  ]

  const toggleRes = (resId: string) => {
    setSelectedResIds(prev => {
      const next = new Set(prev)
      next.has(resId) ? next.delete(resId) : next.add(resId)
      return next
    })
  }

  const handleFilterChange = (newFilter: FilterMode) => {
    setFilter(newFilter)
    setSelectedResIds(new Set())
    setDropdownOpen(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Фильтр по категории */}
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-steel-500" />
          {filterButtons.map(btn => (
            <button
              key={btn.id}
              onClick={() => handleFilterChange(btn.id)}
              className={`px-3 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                filter === btn.id
                  ? 'bg-amber-400/15 border-amber-500/40 text-amber-400'
                  : 'bg-steel-900 border-steel-700 text-steel-400 hover:bg-steel-800 hover:text-steel-300'
              }`}
            >
              {btn.label}
              <span className={`ml-1.5 text-[10px] font-mono ${filter === btn.id ? 'text-amber-400/70' : 'text-steel-600'}`}>
                {btn.count}
              </span>
            </button>
          ))}
        </div>

        {/* Кнопка добавления ресурса */}
        {onAddResource && (
          <button onClick={openNewResModal}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-emerald-500/40 bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20 transition-colors">
            <Plus className="w-3 h-3" />{t('btn_new_resource')}
          </button>
        )}

        {/* Выпадающий список */}
        {categoryFiltered.length > 0 && (
          <div className="relative" ref={dropRef}>
            <button
              onClick={() => setDropdownOpen(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                selectedResIds.size > 0
                  ? 'bg-emerald-400/10 border-emerald-500/40 text-emerald-400'
                  : 'bg-steel-900 border-steel-700 text-steel-400 hover:bg-steel-800 hover:text-steel-300'
              }`}
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
              {t('select_resources')}
              {selectedResIds.size > 0 && (
                <span className="ml-1 text-[10px] font-mono bg-emerald-400/20 px-1.5 py-0.5 rounded">
                  {selectedResIds.size}
                </span>
              )}
            </button>
            {dropdownOpen && (
              <div className="absolute top-full left-0 mt-1 z-30 w-72 max-h-64 overflow-auto rounded-xl border border-steel-600 bg-steel-900 shadow-xl">
                <div className="flex items-center justify-between px-3 py-2 border-b border-steel-700 sticky top-0 bg-steel-900 z-10">
                  <button
                    onClick={() => setSelectedResIds(new Set(categoryFiltered.map(r => r.res.id)))}
                    className="text-[10px] text-amber-400 hover:text-amber-300 font-medium"
                  >
                    {t('select_all_res')}
                  </button>
                  <button
                    onClick={() => setSelectedResIds(new Set())}
                    className="text-[10px] text-steel-400 hover:text-steel-200 font-medium"
                  >
                    {t('clear_selection')}
                  </button>
                </div>
                <div className="py-1">
                  {categoryFiltered.map(({ res, overloaded }) => {
                    const isSelected = selectedResIds.has(res.id)
                    return (
                      <div key={res.id} onClick={() => toggleRes(res.id)} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && toggleRes(res.id)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer ${isSelected ? 'bg-emerald-400/10 text-emerald-300' : 'text-steel-300 hover:bg-steel-800'}`}>
                        <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                          isSelected ? 'bg-emerald-400/20 border-emerald-400/60' : 'border-steel-600'
                        }`}>
                          {isSelected && <Check className="w-2.5 h-2.5 text-emerald-400" />}
                        </span>
                        <span className="font-mono text-steel-500 flex-shrink-0">{res.id}</span>
                        <span className="truncate">{res.name}</span>
                        {overloaded && <span className="flex-shrink-0 px-1 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[9px] font-semibold">!</span>}
                        <div className="flex items-center gap-0.5 ml-auto flex-shrink-0">
                          {onUpdateResource && (
                            <button
                              onClick={e => { e.stopPropagation(); setEditResTarget({ id: res.id, name: res.name, maxUnits: String(res.max_units), costPerUnit: String(res.cost_per_unit ?? 0) }) }}
                              className="p-0.5 rounded hover:bg-emerald-500/20 text-steel-600 hover:text-emerald-400 transition-colors"
                              title={t('rename_activity')}
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          )}
                          {onRemoveResource && (
                            <button
                              onClick={e => { e.stopPropagation(); setDeleteResTarget({ id: res.id, name: res.name }) }}
                              className="p-0.5 rounded hover:bg-rose-500/20 text-steel-600 hover:text-rose-400 transition-colors"
                              title={t('delete')}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Нет ресурсов */}
      {!resources.length && (
        <div className="text-steel-500 text-sm p-8 text-center">{t('no_project')}</div>
      )}

      {/* Нет подходящих под фильтр */}
      {resources.length > 0 && filtered.length === 0 && (
        <div className="text-steel-500 text-sm p-6 text-center border border-steel-700 rounded-xl">
          {t('no_resources_match')}
        </div>
      )}

      {/* Список ресурсов */}
      {filtered.map(({ res, load, peak, overloaded }) => {
        const dayCount = load.length
        const barW = Math.max(4, Math.min(20, 800 / Math.max(dayCount, 1)))
        return (
          <div key={res.id} className="rounded-xl border border-steel-700 bg-steel-950 p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="font-mono text-xs text-steel-400 mr-2">{res.id}</span>
                <span className="font-sans text-sm text-steel-200 font-medium">{res.name}</span>
              </div>
              <div className="flex items-center gap-3 text-xs font-mono">
                <span className="text-steel-400">
                  {t('max_units')}: <span className="text-amber-400">{res.max_units}</span>
                </span>
                <span className="text-steel-400">
                  {t('peak_load')}: <span className={peak > res.max_units ? 'text-rose-400' : 'text-emerald-400'}>{peak.toFixed(1)}</span>
                </span>
                {overloaded
                  ? <span className="px-2 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-sans font-semibold">{t('overloaded')}</span>
                  : load.length > 0 && <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded text-[10px] font-sans font-semibold">{t('ok')}</span>}
              </div>
            </div>
            <div className="overflow-x-auto" style={{ overflowY: 'visible' }}>
              <div className="flex items-end gap-px" style={{ minHeight: 80 }}>
                {load.map((v, i) => {
                  const pct = res.max_units > 0 ? v / res.max_units : 0
                  const h = Math.max(2, Math.min(76, pct * 76))
                  const over = v > res.max_units
                  if (v === 0) return <div key={i} className="flex-shrink-0 bg-steel-800 rounded-t" style={{ width: barW, height: 2 }} />
                  const sd = new Date(startDate)
                  sd.setDate(sd.getDate() + i)
                  const label = sd.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })
                  const dayActs = (actsByResource.get(res.id) || []).filter(a => i >= Math.floor(a.es) && i < Math.ceil(a.ef))
                  return (
                    <div key={i} className="flex-shrink-0 cursor-default" style={{ width: barW }}
                      onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY, label, load: `${v.toFixed(1)}/${res.max_units}`, acts: dayActs })}
                      onMouseLeave={() => setTooltip(null)}>
                      <div style={{ height: h }} className={`rounded-t ${over ? 'bg-rose-500/80' : 'bg-steel-500/80'}`} />
                    </div>
                  )
                })}
              </div>
              <div className="mt-1 text-[10px] font-mono text-steel-600 text-right">max: {res.max_units}</div>
            </div>
          </div>
        )
      })}

      {/* Тултип */}
      {tooltip && (
        <div className="fixed z-50 pointer-events-none"
          style={{ left: tooltip.x + 14, top: tooltip.y - 8 }}>
          <div className="bg-steel-900 border border-steel-600 rounded px-2 py-1.5 text-[10px] font-mono text-steel-200 shadow-xl" style={{ minWidth: 160, maxWidth: 280 }}>
            <div className="font-semibold text-amber-400 mb-1 whitespace-nowrap">{tooltip.label} · {tooltip.load}</div>
            {tooltip.acts.map(a => (
              <div key={a.id} className="text-steel-300 truncate">
                <span className="text-steel-500 mr-1">{a.id}</span>{a.name}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Модалка создания ресурса */}
      {showNewResModal && onAddResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-steel-950/80 backdrop-blur-sm" onClick={() => setShowNewResModal(false)} />
          <div className="relative bg-steel-900 border border-steel-700 rounded-2xl shadow-2xl px-6 py-5 w-96 animate-slide-in">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold text-steel-200">{t('new_resource_title')}</span>
              <button onClick={() => setShowNewResModal(false)} className="p-1 rounded hover:bg-steel-700 text-steel-400"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] text-steel-500 font-medium mb-1">{t('resource_id_label')}</label>
                <input value={newResId} onChange={e => setNewResId(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 font-mono focus:outline-none focus:border-amber-400/60 transition-colors" />
              </div>
              <div>
                <label className="block text-[10px] text-steel-500 font-medium mb-1">{t('resource_name_label')}</label>
                <input value={newResName} onChange={e => setNewResName(e.target.value)} placeholder={t('new_project_placeholder')}
                  className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 focus:outline-none focus:border-amber-400/60 transition-colors" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-steel-500 font-medium mb-1">{t('max_units_label')}</label>
                  <input type="number" min={0} step={0.5} value={newResMax} onChange={e => setNewResMax(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 font-mono focus:outline-none focus:border-amber-400/60 transition-colors" />
                </div>
                <div>
                  <label className="block text-[10px] text-steel-500 font-medium mb-1">{t('cost_per_unit_label')}</label>
                  <input type="number" min={0} step={0.01} value={newResCost} onChange={e => setNewResCost(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 font-mono focus:outline-none focus:border-amber-400/60 transition-colors" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <button onClick={() => setShowNewResModal(false)} className="px-3 py-1.5 text-xs text-steel-400 border border-steel-700 rounded-lg hover:bg-steel-800 transition-colors">{t('cancel')}</button>
              <button onClick={() => {
                if (!newResId.trim()) return
                onAddResource(newResId.trim(), newResName.trim() || newResId.trim(), parseFloat(newResMax) || 1, parseFloat(newResCost) || 0)
                setShowNewResModal(false)
              }}
                className="px-3 py-1.5 text-xs text-emerald-400 border border-emerald-500/40 rounded-lg hover:bg-emerald-400/10 transition-colors">{t('create')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка редактирования ресурса */}
      {editResTarget && onUpdateResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-steel-950/80 backdrop-blur-sm" onClick={() => setEditResTarget(null)} />
          <div className="relative bg-steel-900 border border-steel-700 rounded-2xl shadow-2xl px-6 py-5 w-96 animate-slide-in">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold text-steel-200">{t('edit_resource_title')}</span>
              <button onClick={() => setEditResTarget(null)} className="p-1 rounded hover:bg-steel-700 text-steel-400"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] text-steel-500 font-medium mb-1">{t('resource_name_label')}</label>
                <input value={editResTarget.name} onChange={e => setEditResTarget(prev => prev ? { ...prev, name: e.target.value } : null)}
                  className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 focus:outline-none focus:border-amber-400/60 transition-colors" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-steel-500 font-medium mb-1">{t('max_units_label')}</label>
                  <input type="number" min={0} step={0.5} value={editResTarget.maxUnits} onChange={e => setEditResTarget(prev => prev ? { ...prev, maxUnits: e.target.value } : null)}
                    className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 font-mono focus:outline-none focus:border-amber-400/60 transition-colors" />
                </div>
                <div>
                  <label className="block text-[10px] text-steel-500 font-medium mb-1">{t('cost_per_unit_label')}</label>
                  <input type="number" min={0} step={0.01} value={editResTarget.costPerUnit} onChange={e => setEditResTarget(prev => prev ? { ...prev, costPerUnit: e.target.value } : null)}
                    className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 font-mono focus:outline-none focus:border-amber-400/60 transition-colors" />
                </div>
              </div>
            </div>
            <div className="text-[10px] text-amber-400/80 mt-3">{t('edit_resource_warning')}</div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setEditResTarget(null)} className="px-3 py-1.5 text-xs text-steel-400 border border-steel-700 rounded-lg hover:bg-steel-800 transition-colors">{t('cancel')}</button>
              <button onClick={() => {
                if (!editResTarget.name.trim()) return
                onUpdateResource(editResTarget.id, editResTarget.name.trim(), parseFloat(editResTarget.maxUnits) || 1, parseFloat(editResTarget.costPerUnit) || 0)
                setEditResTarget(null)
              }}
                className="px-3 py-1.5 text-xs text-emerald-400 border border-emerald-500/40 rounded-lg hover:bg-emerald-400/10 transition-colors">{t('save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка подтверждения удаления ресурса */}
      {deleteResTarget && onRemoveResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-steel-950/80 backdrop-blur-sm" onClick={() => setDeleteResTarget(null)} />
          <div className="relative bg-steel-900 border border-steel-700 rounded-2xl shadow-2xl px-6 py-5 w-80 animate-slide-in">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-steel-200">{t('delete_resource_title')}</span>
              <button onClick={() => setDeleteResTarget(null)} className="p-1 rounded hover:bg-steel-700 text-steel-400"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-steel-400 mb-4">
              {t('delete_resource_body')}
            </p>
            <p className="text-xs text-steel-200 font-mono mb-4 truncate">
              {deleteResTarget.id} — {deleteResTarget.name}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteResTarget(null)} className="px-3 py-1.5 text-xs text-steel-400 border border-steel-700 rounded-lg hover:bg-steel-800 transition-colors">{t('cancel')}</button>
              <button onClick={() => { onRemoveResource(deleteResTarget.id); setDeleteResTarget(null) }}
                className="px-3 py-1.5 text-xs text-rose-400 border border-rose-500/40 rounded-lg hover:bg-rose-500/10 transition-colors">{t('delete')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}