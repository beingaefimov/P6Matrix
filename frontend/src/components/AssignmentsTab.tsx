import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, Filter, Search } from 'lucide-react'
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

export default function AssignmentsTab({
  resources, assignments, activities, resourceLoad, startDate,
}: Props) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FilterMode>('all')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set(resources.map(r => r.id)))

  const actById = useMemo(() => new Map(activities.map(a => [a.id, a])), [activities])

  // Статус перегрузки по ресурсам
  const resStatus = useMemo(() => {
    const m = new Map<string, { overloaded: boolean; underloaded: boolean; peak: number }>()
    for (const r of resources) {
      const load = resourceLoad[r.id] || []
      const peak = Math.max(...load, 0)
      m.set(r.id, {
        overloaded: load.some(v => v > r.max_units),
        underloaded: peak > 0 && peak < r.max_units,
        peak,
      })
    }
    return m
  }, [resources, resourceLoad])

  // Назначения сгруппированные по ресурсу
  const byResource = useMemo(() => {
    const m = new Map<string, Assignment[]>()
    for (const r of resources) m.set(r.id, [])
    for (const a of assignments) {
      if (m.has(a.resource_id)) m.get(a.resource_id)!.push(a)
    }
    return m
  }, [resources, assignments])

  const filteredResources = useMemo(() => {
    return resources.filter(r => {
      const s = resStatus.get(r.id)!
      if (filter === 'overloaded'  && !s.overloaded)  return false
      if (filter === 'underloaded' && !s.underloaded) return false
      if (search) {
        const q = search.toLowerCase()
        if (!r.name.toLowerCase().includes(q) && !r.id.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [resources, resStatus, filter, search])

  const counts = useMemo(() => ({
    all:         resources.length,
    overloaded:  resources.filter(r => resStatus.get(r.id)?.overloaded).length,
    underloaded: resources.filter(r => resStatus.get(r.id)?.underloaded).length,
  }), [resources, resStatus])

  const toggle = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const toggleAll = (open: boolean) =>
    setExpanded(open ? new Set(resources.map(r => r.id)) : new Set())

  const filterBtns: { id: FilterMode; label: string }[] = [
    { id: 'all',         label: t('filter_all') },
    { id: 'overloaded',  label: t('filter_overloaded') },
    { id: 'underloaded', label: t('filter_underloaded') },
  ]

  if (resources.length === 0)
    return <div className="text-steel-500 text-sm p-8 text-center">{t('no_project')}</div>

  return (
    <div className="space-y-4">
      {/* Панель фильтров */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-steel-500" />
          {filterBtns.map(btn => (
            <button key={btn.id} onClick={() => setFilter(btn.id)}
              className={`px-3 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                filter === btn.id
                  ? 'bg-amber-400/15 border-amber-500/40 text-amber-400'
                  : 'bg-steel-900 border-steel-700 text-steel-400 hover:bg-steel-800 hover:text-steel-300'
              }`}>
              {btn.label}
              <span className={`ml-1.5 text-[10px] font-mono ${filter === btn.id ? 'text-amber-400/70' : 'text-steel-600'}`}>
                {counts[btn.id]}
              </span>
            </button>
          ))}
        </div>

        {/* Поиск по названию ресурса */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-steel-500 pointer-events-none" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('search_resource')}
            className="pl-7 pr-3 py-1.5 text-[11px] bg-steel-900 border border-steel-700 rounded-lg text-steel-300 placeholder-steel-600 focus:outline-none focus:border-steel-500 w-48"
          />
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => toggleAll(true)}
            className="px-2 py-1 text-[10px] text-steel-400 hover:text-steel-200 border border-steel-700 rounded hover:bg-steel-800 transition-colors">
            {t('expand_all')}
          </button>
          <button onClick={() => toggleAll(false)}
            className="px-2 py-1 text-[10px] text-steel-400 hover:text-steel-200 border border-steel-700 rounded hover:bg-steel-800 transition-colors">
            {t('collapse_all')}
          </button>
        </div>
      </div>

      {filteredResources.length === 0 && (
        <div className="text-steel-500 text-sm p-6 text-center border border-steel-700 rounded-xl">
          {t('no_resources_match')}
        </div>
      )}

      {/* Список ресурсов */}
      {filteredResources.map(res => {
        const st = resStatus.get(res.id)!
        const resAssignments = byResource.get(res.id) || []
        const isOpen = expanded.has(res.id)

        return (
          <div key={res.id} className="rounded-xl border border-steel-700 bg-steel-950 overflow-hidden">
            {/* Заголовок ресурса */}
            <button
              onClick={() => toggle(res.id)}
              className="w-full flex items-center gap-3 px-4 py-3 bg-steel-900 hover:bg-steel-800 transition-colors text-left"
            >
              {isOpen
                ? <ChevronDown className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 text-steel-500 flex-shrink-0" />}
              <span className="font-mono text-xs text-steel-400">{res.id}</span>
              <span className="text-sm text-steel-200 font-medium flex-1">{res.name}</span>
              <div className="flex items-center gap-3 text-xs font-mono">
                <span className="text-steel-400">
                  {t('max_units')}: <span className="text-amber-400">{res.max_units}</span>
                </span>
                <span className="text-steel-400">
                  {t('peak_load')}: <span className={st.peak > res.max_units ? 'text-rose-400' : 'text-emerald-400'}>
                    {st.peak.toFixed(1)}
                  </span>
                </span>
                <span className="text-steel-500 font-mono">{resAssignments.length} {t('activities_count').toLowerCase()}</span>
                {st.overloaded && (
                  <span className="px-2 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-sans font-semibold">
                    {t('overloaded')}
                  </span>
                )}
                {!st.overloaded && st.peak > 0 && (
                  <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded text-[10px] font-sans font-semibold">
                    {t('ok')}
                  </span>
                )}
              </div>
            </button>

            {/* Таблица работ */}
            {isOpen && (
              resAssignments.length === 0
                ? <div className="px-4 py-3 text-xs text-steel-500">{t('no_assignments')}</div>
                : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="border-b border-steel-800 bg-steel-900/40">
                          <th className="px-4 py-2 text-left text-steel-500 font-medium w-24">{t('col_id')}</th>
                          <th className="px-3 py-2 text-left text-steel-500 font-medium">{t('col_name')}</th>
                          <th className="px-3 py-2 text-right text-steel-500 font-medium w-16">{t('planned_units')}</th>
                          <th className="px-3 py-2 text-right text-steel-500 font-medium w-16">{t('actual_qty')}</th>
                          <th className="px-3 py-2 text-right text-steel-500 font-medium w-16">{t('remaining_qty')}</th>
                          <th className="px-3 py-2 text-left text-steel-500 font-medium w-28">{t('col_es')}</th>
                          <th className="px-3 py-2 text-left text-steel-500 font-medium w-28">{t('col_ef')}</th>
                          <th className="px-3 py-2 text-right text-steel-500 font-medium w-14">{t('col_dur')}</th>
                          <th className="px-3 py-2 text-right text-steel-500 font-medium w-14">{t('col_tf')}</th>
                          <th className="px-3 py-2 text-left text-steel-500 font-medium w-16">{t('col_crit')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resAssignments.map((asgn, idx) => {
                          const act = actById.get(asgn.activity_id)
                          return (
                            <tr key={asgn.activity_id}
                              className={`border-b border-steel-800/60 transition-colors hover:bg-steel-800/30 ${
                                idx % 2 === 0 ? '' : 'bg-steel-900/20'
                              } ${act?.on_critical ? 'border-l-2 border-l-rose-500' : ''}`}
                            >
                              <td className="px-4 py-2">
                                <span className="flex items-center gap-1.5">
                                  {act?.on_critical && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 flex-shrink-0" />}
                                  <span className="text-steel-400">{asgn.activity_id}</span>
                                </span>
                              </td>
                              <td className="px-3 py-2 text-steel-200 max-w-xs truncate">
                                {act?.name ?? <span className="text-steel-600">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right text-amber-400">{asgn.units}</td>
                              <td className="px-3 py-2 text-right text-steel-400">
                                {asgn.actual_qty != null ? asgn.actual_qty : '—'}
                              </td>
                              <td className="px-3 py-2 text-right text-steel-400">
                                {asgn.remaining_qty != null ? asgn.remaining_qty : '—'}
                              </td>
                              <td className="px-3 py-2 text-steel-300">{act?.es_date ?? '—'}</td>
                              <td className="px-3 py-2 text-steel-300">{act?.ef_date ?? '—'}</td>
                              <td className="px-3 py-2 text-right text-steel-300">
                                {act != null ? Math.round(act.duration) : '—'}
                              </td>
                              <td className={`px-3 py-2 text-right font-medium ${
                                act?.tf === 0 ? 'text-rose-400' : 'text-emerald-400'
                              }`}>
                                {act != null ? act.tf.toFixed(1) : '—'}
                              </td>
                              <td className="px-3 py-2">
                                {act?.on_critical && (
                                  <span className="px-1.5 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-sans font-semibold">
                                    {t('critical_badge')}
                                  </span>
                                )}
                              </td>
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
