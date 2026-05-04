import { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Filter, ChevronDown, Check } from 'lucide-react'
import type { ResourceOut } from '../types'

type FilterMode = 'all' | 'overloaded' | 'underloaded'

interface Props {
  resources: ResourceOut[]
  resourceLoad: Record<string, number[]>
  startDate: string
}

export default function ResourceChart({ resources, resourceLoad, startDate }: Props) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FilterMode>('all')
  const [selectedResIds, setSelectedResIds] = useState<Set<string>>(new Set())
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

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
      case 'overloaded': return resourceStatus.filter(r => r.overloaded)
      case 'underloaded': return resourceStatus.filter(r => r.underloaded)
      default: return resourceStatus
    }
  }, [resourceStatus, filter])

  const filtered = useMemo(() => {
    if (selectedResIds.size === 0) return categoryFiltered
    return categoryFiltered.filter(r => selectedResIds.has(r.res.id))
  }, [categoryFiltered, selectedResIds])

  if (resources.length === 0) {
    return (
      <div className="text-steel-500 text-sm p-8 text-center">
        {t('no_project')}
      </div>
    )
  }

  const counts = {
    all: resourceStatus.length,
    overloaded: resourceStatus.filter(r => r.overloaded).length,
    underloaded: resourceStatus.filter(r => r.underloaded).length,
  }

  const filterButtons: { id: FilterMode; label: string; count: number }[] = [
    { id: 'all', label: t('filter_all'), count: counts.all },
    { id: 'overloaded', label: t('filter_overloaded'), count: counts.overloaded },
    { id: 'underloaded', label: t('filter_underloaded'), count: counts.underloaded },
  ]

  const toggleRes = (resId: string) => {
    setSelectedResIds(prev => {
      const next = new Set(prev)
      if (next.has(resId)) next.delete(resId)
      else next.add(resId)
      return next
    })
  }

  const selectAllRes = () => {
    setSelectedResIds(new Set(categoryFiltered.map(r => r.res.id)))
  }

  const clearResSelection = () => {
    setSelectedResIds(new Set())
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-steel-500" />
          {filterButtons.map(btn => (
            <button
              key={btn.id}
              onClick={() => setFilter(btn.id)}
              className={`px-3 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
                filter === btn.id
                  ? 'bg-amber-400/15 border-amber-500/40 text-amber-400'
                  : 'bg-steel-900 border-steel-700 text-steel-400 hover:bg-steel-800 hover:text-steel-300'
              }`}
            >
              {btn.label}
              <span className={`ml-1.5 text-[10px] font-mono ${
                filter === btn.id ? 'text-amber-400/70' : 'text-steel-600'
              }`}>
                {btn.count}
              </span>
            </button>
          ))}
        </div>
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
                  onClick={selectAllRes}
                  className="text-[10px] text-amber-400 hover:text-amber-300 font-medium"
                >
                  {t('select_all_res')}
                </button>
                <button
                  onClick={clearResSelection}
                  className="text-[10px] text-steel-400 hover:text-steel-200 font-medium"
                >
                  {t('clear_selection')}
                </button>
              </div>
              <div className="py-1">
                {categoryFiltered.map(({ res }) => {
                  const isSelected = selectedResIds.has(res.id)
                  return (
                    <button
                      key={res.id}
                      onClick={() => toggleRes(res.id)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                        isSelected
                          ? 'bg-emerald-400/10 text-emerald-300'
                          : 'text-steel-300 hover:bg-steel-800'
                      }`}
                    >
                      <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                        isSelected
                          ? 'bg-emerald-400/20 border-emerald-400/60'
                          : 'border-steel-600'
                      }`}>
                        {isSelected && <Check className="w-2.5 h-2.5 text-emerald-400" />}
                      </span>
                      <span className="font-mono text-steel-500">{res.id}</span>
                      <span className="truncate">{res.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      {filtered.length === 0 && (
        <div className="text-steel-500 text-sm p-6 text-center border border-steel-700 rounded-xl">
          {t('no_resources_match')}
        </div>
      )}
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
                {overloaded && (
                  <span className="px-2 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-sans font-semibold">
                    {t('overloaded')}
                  </span>
                )}
                {!overloaded && load.length > 0 && (
                  <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded text-[10px] font-sans font-semibold">
                    {t('ok')}
                  </span>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <div className="flex items-end gap-px" style={{ minHeight: 80 }}>
                {load.map((v, i) => {
                  const pct = res.max_units > 0 ? (v / res.max_units) : 0
                  const h = Math.max(2, Math.min(76, pct * 76))
                  const over = v > res.max_units
                  const sd = new Date(startDate)
                  sd.setDate(sd.getDate() + i)
                  const label = sd.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })
                  return (
                    <div
                      key={i}
                      className="relative group flex-shrink-0"
                      style={{ width: barW }}
                    >
                      <div
                        style={{ height: h }}
                        className={`rounded-t transition-all ${
                          over
                            ? 'bg-rose-500/80'
                            : v > 0
                            ? 'bg-steel-500/80'
                            : 'bg-steel-800'
                        }`}
                      />
                      {v > 0 && (
                        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-20 pointer-events-none">
                          <div className="bg-steel-800 border border-steel-600 rounded px-2 py-1 text-[10px] font-mono text-steel-200 whitespace-nowrap shadow-lg">
                            {label}<br />{v.toFixed(1)}/{res.max_units}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-1 text-[10px] font-mono text-steel-600 text-right">
                max: {res.max_units}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}