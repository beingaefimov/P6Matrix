import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, Filter, Search, Check } from 'lucide-react'
import type { ResourceOut } from '../types'
import type { ActivityDisplay } from '../engine/useScheduler'
import type { Assignment } from '../engine/cpmEngine'

type FilterMode = 'all' | 'overloaded' | 'underloaded'

interface Props {
  resources: ResourceOut[]
  assignments: Assignment[]
  activities: ActivityDisplay[]
  resourceLoad: Record<string, number[]>
  startDate: string
}

export default function AssignmentsTab({ resources, assignments, activities, resourceLoad }: Props) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FilterMode>('all')
  const [search, setSearch] = useState('')
  const [selectedResIds, setSelectedResIds] = useState<Set<string>>(new Set())
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(resources.map(r => r.id)))
  const dropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  const actById = useMemo(() => new Map(activities.map(a => [a.id, a])), [activities])

  const resStatus = useMemo(() => {
    const m = new Map<string, { overloaded: boolean; underloaded: boolean; peak: number }>()
    for (const r of resources) {
      const load = resourceLoad[r.id] || []
      const peak = Math.max(...load, 0)
      m.set(r.id, { overloaded: load.some(v => v > r.max_units), underloaded: peak > 0 && peak < r.max_units, peak })
    }
    return m
  }, [resources, resourceLoad])

  const byResource = useMemo(() => {
    const m = new Map<string, Assignment[]>()
    for (const r of resources) m.set(r.id, [])
    for (const a of assignments) { if (m.has(a.resource_id)) m.get(a.resource_id)!.push(a) }
    return m
  }, [resources, assignments])

  const categoryFiltered = useMemo(() => resources.filter(r => {
    const st = resStatus.get(r.id)!
    if (filter === 'overloaded'  && !st.overloaded)  return false
    if (filter === 'underloaded' && !st.underloaded) return false
    if (search) { const q = search.toLowerCase(); if (!r.name.toLowerCase().includes(q) && !r.id.toLowerCase().includes(q)) return false }
    return true
  }), [resources, resStatus, filter, search])

  const filteredResources = useMemo(() =>
    selectedResIds.size === 0 ? categoryFiltered : categoryFiltered.filter(r => selectedResIds.has(r.id)),
    [categoryFiltered, selectedResIds])

  const counts = useMemo(() => ({
    all: resources.length,
    overloaded:  resources.filter(r => resStatus.get(r.id)?.overloaded).length,
    underloaded: resources.filter(r => resStatus.get(r.id)?.underloaded).length,
  }), [resources, resStatus])

  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAll = (open: boolean) => setExpanded(open ? new Set(resources.map(r => r.id)) : new Set())
  const toggleResId = (id: string) => setSelectedResIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const handleFilterChange = (f: FilterMode) => { setFilter(f); setSelectedResIds(new Set()); setDropdownOpen(false) }

  if (resources.length === 0)
    return <div className="text-steel-500 text-sm p-8 text-center">{t('no_project')}</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-steel-500" />
          {(['all', 'overloaded', 'underloaded'] as FilterMode[]).map(id => (
            <button key={id} onClick={() => handleFilterChange(id)}
              className={`px-3 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                filter === id ? 'bg-amber-400/15 border-amber-500/40 text-amber-400' : 'bg-steel-900 border-steel-700 text-steel-400 hover:bg-steel-800 hover:text-steel-300'
              }`}>
              {t(`filter_${id}` as any)}
              <span className={`ml-1.5 text-[10px] font-mono ${filter === id ? 'text-amber-400/70' : 'text-steel-600'}`}>{counts[id]}</span>
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-steel-500 pointer-events-none" />
          <input value={search} onChange={e => { setSearch(e.target.value); setSelectedResIds(new Set()) }}
            placeholder={t('search_resource')}
            className="pl-7 pr-3 py-1.5 text-[11px] bg-steel-900 border border-steel-700 rounded-lg text-steel-300 placeholder-steel-600 focus:outline-none focus:border-steel-500 w-44" />
        </div>

        {categoryFiltered.length > 0 && (
          <div className="relative" ref={dropRef}>
            <button onClick={() => setDropdownOpen(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                selectedResIds.size > 0 ? 'bg-emerald-400/10 border-emerald-500/40 text-emerald-400' : 'bg-steel-900 border-steel-700 text-steel-400 hover:bg-steel-800 hover:text-steel-300'
              }`}>
              <ChevronDown className={`w-3 h-3 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
              {t('select_resources')}
              {selectedResIds.size > 0 && <span className="ml-1 text-[10px] font-mono bg-emerald-400/20 px-1.5 py-0.5 rounded">{selectedResIds.size}</span>}
            </button>
            {dropdownOpen && (
              <div className="absolute top-full left-0 mt-1 z-30 w-72 max-h-64 overflow-auto rounded-xl border border-steel-600 bg-steel-900 shadow-xl">
                <div className="flex items-center justify-between px-3 py-2 border-b border-steel-700 sticky top-0 bg-steel-900 z-10">
                  <button onClick={() => setSelectedResIds(new Set(categoryFiltered.map(r => r.id)))} className="text-[10px] text-amber-400 hover:text-amber-300 font-medium">{t('select_all_res')}</button>
                  <button onClick={() => setSelectedResIds(new Set())} className="text-[10px] text-steel-400 hover:text-steel-200 font-medium">{t('clear_selection')}</button>
                </div>
                <div className="py-1">
                  {categoryFiltered.map(r => {
                    const st = resStatus.get(r.id)!; const isSel = selectedResIds.has(r.id)
                    return (
                      <button key={r.id} onClick={() => toggleResId(r.id)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${isSel ? 'bg-emerald-400/10 text-emerald-300' : 'text-steel-300 hover:bg-steel-800'}`}>
                        <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${isSel ? 'bg-emerald-400/20 border-emerald-400/60' : 'border-steel-600'}`}>
                          {isSel && <Check className="w-2.5 h-2.5 text-emerald-400" />}
                        </span>
                        <span className="font-mono text-steel-500 flex-shrink-0">{r.id}</span>
                        <span className="truncate">{r.name}</span>
                        {st.overloaded && <span className="ml-auto flex-shrink-0 px-1 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[9px] font-semibold">!</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => toggleAll(true)} className="px-2 py-1 text-[10px] text-steel-400 hover:text-steel-200 border border-steel-700 rounded hover:bg-steel-800 transition-colors">{t('expand_all')}</button>
          <button onClick={() => toggleAll(false)} className="px-2 py-1 text-[10px] text-steel-400 hover:text-steel-200 border border-steel-700 rounded hover:bg-steel-800 transition-colors">{t('collapse_all')}</button>
        </div>
      </div>

      {filteredResources.length === 0 && (
        <div className="text-steel-500 text-sm p-6 text-center border border-steel-700 rounded-xl">{t('no_resources_match')}</div>
      )}

      {filteredResources.map(res => {
        const st = resStatus.get(res.id)!
        const resAssignments = byResource.get(res.id) || []
        const isOpen = expanded.has(res.id)
        return (
          <div key={res.id} className="rounded-xl border border-steel-700 bg-steel-950 overflow-hidden">
            <button onClick={() => toggle(res.id)} className="w-full flex items-center gap-3 px-4 py-3 bg-steel-900 hover:bg-steel-800 transition-colors text-left">
              {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-steel-500 flex-shrink-0" />}
              <span className="font-mono text-xs text-steel-400 flex-shrink-0">{res.id}</span>
              <span className="text-sm text-steel-200 font-medium flex-1">{res.name}</span>
              <div className="flex items-center gap-3 text-xs font-mono flex-shrink-0">
                <span className="text-steel-400">{t('max_units')}: <span className="text-amber-400">{res.max_units}</span></span>
                <span className="text-steel-400">{t('peak_load')}: <span className={st.peak > res.max_units ? 'text-rose-400' : 'text-emerald-400'}>{st.peak.toFixed(1)}</span></span>
                <span className="text-steel-500">{resAssignments.length} {t('activities_count').toLowerCase()}</span>
                {st.overloaded
                  ? <span className="px-2 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-sans font-semibold">{t('overloaded')}</span>
                  : st.peak > 0 && <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded text-[10px] font-sans font-semibold">{t('ok')}</span>}
              </div>
            </button>

            {isOpen && (resAssignments.length === 0
              ? <div className="px-4 py-3 text-xs text-steel-500">{t('no_assignments')}</div>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="border-b border-steel-800 bg-steel-900/40">
                        {[t('col_id'), t('col_name'), t('planned_units'), t('actual_qty'), t('remaining_qty'), t('col_es'), t('col_ef'), t('col_dur'), t('col_tf'), t('col_crit')].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-steel-500 font-medium whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {resAssignments.map((asgn, idx) => {
                        const act = actById.get(asgn.activity_id)
                        return (
                          <tr key={asgn.activity_id}
                            className={`border-b border-steel-800/60 hover:bg-steel-800/30 transition-colors ${idx % 2 === 0 ? '' : 'bg-steel-900/20'} ${act?.on_critical ? 'border-l-2 border-l-rose-500' : ''}`}>
                            <td className="px-3 py-2">
                              <span className="flex items-center gap-1.5">
                                {act?.on_critical && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 flex-shrink-0" />}
                                <span className="text-steel-400">{asgn.activity_id}</span>
                              </span>
                            </td>
                            <td className="px-3 py-2 text-steel-200 max-w-xs truncate">{act?.name ?? '-'}</td>
                            <td className="px-3 py-2 text-right text-amber-400">{asgn.units}</td>
                            <td className="px-3 py-2 text-right text-steel-400">{asgn.actual_qty ?? '-'}</td>
                            <td className="px-3 py-2 text-right text-steel-400">{asgn.remaining_qty ?? '-'}</td>
                            <td className="px-3 py-2 text-steel-300">{act?.es_date ?? '-'}</td>
                            <td className="px-3 py-2 text-steel-300">{act?.ef_date ?? '-'}</td>
                            <td className="px-3 py-2 text-right text-steel-300">{act != null ? Math.round(act.duration) : '-'}</td>
                            <td className={`px-3 py-2 text-right font-medium ${act?.tf === 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{act != null ? act.tf.toFixed(1) : '-'}</td>
                            <td className="px-3 py-2">{act?.on_critical && <span className="px-1.5 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-sans font-semibold">{t('critical_badge')}</span>}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
        )
      })}
    </div>
  )
}
