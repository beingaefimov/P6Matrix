import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, ChevronDown, ChevronsUpDown } from 'lucide-react'
import type { ActivityOut } from '../types'
import clsx from 'clsx'

interface Props {
  activities: ActivityOut[]
  hardStarts?: Set<string>
  completedIds?: Set<string>
}

interface FlatNode extends ActivityOut {
  level: number
  hasChildren: boolean
}

export default function ActivityTable({ activities, hardStarts, completedIds }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { rows, hasHierarchy } = useMemo(() => {
    const byId = new Map<string, ActivityOut>()
    const children = new Map<string, ActivityOut[]>()

    activities.forEach((a) => {
      byId.set(a.id, a)
      if (a.parent_id) {
        if (!children.has(a.parent_id)) children.set(a.parent_id, [])
        children.get(a.parent_id)!.push(a)
      }
    })

    const hierarchyExists = activities.some((a) => a.parent_id && byId.has(a.parent_id))
    const roots = activities.filter((a) => !a.parent_id || !byId.has(a.parent_id))

    const result: FlatNode[] = []

    function walk(node: ActivityOut, level: number) {
      const ch = children.get(node.id) || []
      result.push({ ...node, level, hasChildren: ch.length > 0 })
      if (expanded.has(node.id)) {
        ch.forEach((c) => walk(c, level + 1))
      }
    }

    roots.forEach((r) => walk(r, 0))
    return { rows: result, hasHierarchy: hierarchyExists }
  }, [activities, expanded])

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allExpanded = expanded.size >= activities.length
  const toggleAll = () => {
    if (allExpanded) setExpanded(new Set())
    else setExpanded(new Set(activities.map((a) => a.id)))
  }

  const display = hasHierarchy
    ? rows
    : activities.map((a) => ({ ...a, level: 0, hasChildren: false }))

  return (
    <div className="space-y-3">
      {hasHierarchy && (
        <button
          onClick={toggleAll}
          className={clsx(
            'flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-lg border transition-colors',
            allExpanded
              ? 'border-steel-600 text-steel-400 hover:bg-steel-800 hover:text-steel-200'
              : 'border-amber-500/40 text-amber-400 hover:bg-amber-400/10'
          )}
        >
          <ChevronsUpDown className="w-3.5 h-3.5" />
          {allExpanded ? t('collapse_all') : t('expand_all')}
        </button>
      )}
      <div className="overflow-x-auto rounded-xl border border-steel-700">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="bg-steel-900 border-b border-steel-700">
              {[
                t('col_id'), t('col_name'), t('col_dur'),
                t('col_es'), t('col_ef'), t('col_ls'), t('col_lf'),
                t('col_tf'), t('col_ff'), t('col_crit'),
              ].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-steel-400 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {display.map((a, i) => {
              const isHardStart = hardStarts?.has(a.id) ?? false
              const completed = completedIds?.has(a.id) ?? false
              return (
                <tr
                  key={`${a.id}-${i}`}
                  className={clsx(
                    'border-b border-steel-800 transition-colors hover:bg-steel-800/40',
                    i % 2 === 0 ? 'bg-steel-950' : 'bg-steel-900/30',
                    a.on_critical && 'border-l-2 border-l-rose-500',
                    !a.on_critical && isHardStart && 'border-l-2 border-l-amber-400',
                    completed && 'opacity-50'
                  )}
                >
                  <td className="px-3 py-1.5 text-steel-400">
                    <span className="inline-flex items-center gap-1.5">
                      {a.on_critical && (
                        <span className="w-2 h-2 rounded-full bg-rose-500 inline-block flex-shrink-0" />
                      )}
                      {!a.on_critical && isHardStart && (
                        <span className="w-2 h-2 rounded-full bg-amber-400 inline-block flex-shrink-0" />
                      )}
                      {a.id}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-steel-200 min-w-[240px]">
                    <div className="flex items-center">
                      <div className="flex items-center" style={{ marginLeft: a.level * 20 }}>
                        {a.hasChildren ? (
                          <button
                            onClick={() => toggle(a.id)}
                            className="mr-1 p-0.5 rounded hover:bg-steel-700 focus:outline-none"
                          >
                            {expanded.has(a.id) ? (
                              <ChevronDown className="w-3.5 h-3.5 text-amber-400" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 text-steel-500" />
                            )}
                          </button>
                        ) : (
                          <span className="w-5 inline-block" />
                        )}
                        <span className="truncate" title={a.name}>
                          {a.name}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-amber-400 text-right">{Math.round(a.duration)}</td>
                  <td className="px-3 py-1.5 text-steel-300">{a.es_date}</td>
                  <td className="px-3 py-1.5 text-steel-300">{a.ef_date}</td>
                  <td className="px-3 py-1.5 text-steel-500">{a.ls_date}</td>
                  <td className="px-3 py-1.5 text-steel-500">{a.lf_date}</td>
                  <td className={clsx(
                    'px-3 py-1.5 text-right font-medium',
                    a.tf === 0 ? 'text-rose-400' : 'text-emerald-400'
                  )}>
                    {a.tf.toFixed(1)}
                  </td>
                  <td className="px-3 py-1.5 text-steel-400 text-right">{a.ff.toFixed(1)}</td>
                  <td className="px-3 py-1.5">
                    {a.on_critical && (
                      <span className="inline-block px-1.5 py-0.5 bg-rose-500/20 text-rose-400 rounded text-[10px] font-sans font-semibold tracking-wide">
                        {t('critical_badge')}
                      </span>
                    )}
                    {!a.on_critical && isHardStart && (
                      <span className="inline-block px-1.5 py-0.5 bg-amber-400/20 text-amber-400 rounded text-[10px] font-sans font-semibold tracking-wide">
                        {t('hard_start_badge')}
                      </span>
                    )}
                    {completed && !a.on_critical && !isHardStart && (
                      <span className="inline-block px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 rounded text-[10px] font-sans font-semibold tracking-wide">
                        {t('completed_badge')}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}