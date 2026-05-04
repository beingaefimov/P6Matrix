import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Flag, AlertCircle, List } from 'lucide-react'
import type { ActivityOut } from '../types'

interface Props {
  activities: ActivityOut[]
  duration_days: number
  finish_date?: string
}

export default function ProjectStats({ activities, duration_days, finish_date }: Props) {
  const { t } = useTranslation()

  const criticalCount = useMemo(
    () => activities.filter((a) => a.on_critical).length,
    [activities]
  )

  const computedFinishDate = useMemo(() => {
    if (finish_date) return finish_date.slice(0, 10)
    if (activities.length === 0) return '-'
    const maxLf = Math.max(
      ...activities.map((a) => new Date(a.lf_date).getTime())
    )
    return new Date(maxLf).toISOString().slice(0, 10)
  }, [activities, finish_date])

  const stats = [
    {
      icon: Clock,
      label: t('project_duration'),
      value: `${duration_days} ${t('days')}`,
      color: 'text-amber-400',
      bg: 'bg-amber-400/10',
    },
    {
      icon: Flag,
      label: t('finish_date'),
      value: computedFinishDate,
      color: 'text-steel-300',
      bg: 'bg-steel-500/10',
    },
    {
      icon: AlertCircle,
      label: t('critical_path'),
      value: `${criticalCount} ${t('activities_count').toLowerCase()}`,
      color: 'text-rose-400',
      bg: 'bg-rose-500/10',
    },
    {
      icon: List,
      label: t('activities_count'),
      value: String(activities.length),
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
  ]

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {stats.map((s) => (
        <div
          key={s.label}
          className="rounded-xl border border-steel-700 bg-steel-900/50 p-4 flex items-center gap-3"
        >
          <div
            className={`w-10 h-10 rounded-lg ${s.bg} flex items-center justify-center flex-shrink-0`}
          >
            <s.icon className={`w-5 h-5 ${s.color}`} />
          </div>
          <div>
            <div className="text-[10px] text-steel-500 font-medium uppercase tracking-wider">
              {s.label}
            </div>
            <div className={`text-sm font-bold font-mono ${s.color}`}>
              {s.value}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}