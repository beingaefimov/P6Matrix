/**Панель деталей задачи.
 * - Базовые поля (duration, dates, float) - из ActivityDisplay (всегда доступны)
 * - Расширенные поля (notes, UDF, predecessors, assignments) - из ActivityDetail
 *   (загружается лениво при клике, показываем skeleton пока грузится) */
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Trash2, Lock, CheckCircle2, Loader2 } from 'lucide-react'
import type { ActivityDisplay } from '../engine/useScheduler'
import type { ActivityDetail } from '../utils/api'
import type { ResourceOut } from '../types'
import { pxpGetAllRelations,
  pxpAddAssignment, pxpRemoveAssignment, pxpSetAssignmentField,
  pxpAddRelation, pxpRemoveRelation, pxpUpdateRelationType, pxpUpdateRelationLag,
} from '../utils/pxpMutations'

interface Props {
  activity: ActivityDisplay
  detail: ActivityDetail | null
  detailLoading: boolean
  onClose: () => void
  pxpText: string
  activities: ActivityDisplay[]
  resources: ResourceOut[]
  hardStart: boolean
  completed: boolean
  onSetDuration: (actId: string, duration: number) => void
  onSetActualDuration: (actId: string, value: number | null) => void
  onSetRemainingDuration: (actId: string, value: number | null) => void
  onSetCompleted: (actId: string, completed: boolean) => void
  onSetHardStart: (actId: string, value: boolean) => void
  /** Универсальное обновление поля задачи по индексу */
  onUpdateActivityField: (actId: string, fieldIdx: number, value: string) => void
  loading?: boolean
}

const RELATION_TYPES = ['FS', 'SS', 'FF', 'SF']

export default function ActivityDetailPanel({
  activity, detail, detailLoading, onClose,
  pxpText, activities, resources, hardStart, completed,
  onSetDuration, onSetActualDuration, onSetRemainingDuration,
  onSetCompleted, onSetHardStart, onUpdateActivityField, loading,
}: Props) {
  const { t } = useTranslation()
  const [editDuration, setEditDuration]   = useState(String(Math.round(activity.duration)))
  const [editActualDur, setEditActualDur] = useState('')
  const [editRemainDur, setEditRemainDur] = useState('')
  const [newPredId, setNewPredId]         = useState('')
  const [newRelType, setNewRelType]       = useState('FS')
  const [newRelLag, setNewRelLag]         = useState('0')
  const [newResId, setNewResId]           = useState('')
  const [newResUnits, setNewResUnits]     = useState('1')

  useEffect(() => {
    setEditDuration(String(Math.round(activity.duration)))
    setEditActualDur(activity.actual_duration != null ? String(activity.actual_duration) : '')
    setEditRemainDur(activity.remaining_duration != null ? String(activity.remaining_duration) : '')
    setNewPredId(''); setNewRelType('FS'); setNewRelLag('0')
    setNewResId(''); setNewResUnits('1')
  }, [activity.id, activity.duration, activity.actual_duration, activity.remaining_duration])

  // Связи берём из pxp_text (всегда актуальны, т.к. pxp_text обновляется синхронно)
  const allRels = useMemo(() => pxpGetAllRelations(pxpText), [pxpText])
  const predecessors = useMemo(() => allRels.filter(r => r.succ === activity.id), [allRels, activity.id])
  const successors   = useMemo(() => allRels.filter(r => r.pred === activity.id), [allRels, activity.id])

  // Assignments берём из detail (lazy) или из pxp_text напрямую
  const assignments = useMemo(() => {
    if (detail?.assignments) {
      const resMap = new Map(resources.map(r => [r.id, r.name]))
      return detail.assignments.map(a => ({
        resource_id: a.resource_id,
        resource_name: resMap.get(a.resource_id) || a.resource_id,
        planned_units: a.units,
        actual_qty: a.actual_qty,
        remaining_qty: a.remaining_qty,
      }))
    }
    return []
  }, [detail, resources])

  const actById = useMemo(() => new Map(activities.map(a => [a.id, a])), [activities])
  const existingPredIds = useMemo(() => new Set(predecessors.map(r => r.pred)), [predecessors])
  const existingResIds  = useMemo(() => new Set(assignments.map(a => a.resource_id)), [assignments])

  const availablePreds = useMemo(
    () => activities.filter(a => a.id !== activity.id && !existingPredIds.has(a.id)),
    [activities, activity.id, existingPredIds]
  )
  const availableResources = useMemo(
    () => resources.filter(r => !existingResIds.has(r.id)),
    [resources, existingResIds]
  )

  const handleDurationBlur = () => {
    const val = parseInt(editDuration)
    if (!isNaN(val) && val >= 0 && val !== Math.round(activity.duration)) {
      onSetDuration(activity.id, val)
    } else {
      setEditDuration(String(Math.round(activity.duration)))
    }
  }

  const handleActualDurBlur = () => {
    const val = editActualDur.trim() === '' ? null : parseFloat(editActualDur)
    if (val === null || (!isNaN(val) && val >= 0)) onSetActualDuration(activity.id, val)
    else setEditActualDur(activity.actual_duration != null ? String(activity.actual_duration) : '')
  }

  const handleRemainDurBlur = () => {
    const val = editRemainDur.trim() === '' ? null : parseFloat(editRemainDur)
    if (val === null || (!isNaN(val) && val >= 0)) onSetRemainingDuration(activity.id, val)
    else setEditRemainDur(activity.remaining_duration != null ? String(activity.remaining_duration) : '')
  }

  // Мутации assignments и relations - обновляем pxp_text напрямую,
  // затем запускаем пересчёт через onUpdateActivityField с фиктивным полем
  // (реальный перезапуск происходит в useScheduler при любом вызове updateActivityField)
  // TODO: вынести addAssignment/addRelation в useScheduler как отдельные методы
  // Пока: вызываем onUpdateActivityField с fieldIdx=-1 как триггер пересчёта

  const inputCls = 'w-20 px-2 py-1 text-xs font-mono bg-steel-800 border border-steel-600 rounded text-steel-200 focus:outline-none focus:border-amber-400/60 transition-colors'
  const selectCls = 'px-2 py-1 text-xs font-mono bg-steel-800 border border-steel-600 rounded text-steel-200 focus:outline-none focus:border-amber-400/60 transition-colors'
  const labelCls = 'text-[10px] text-steel-500 font-medium whitespace-nowrap'
  const valueCls = 'text-xs text-steel-200 font-mono'

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-steel-700 shadow-2xl animate-slide-up"
      style={{ backgroundColor: 'rgba(15,35,51,0.97)', backdropFilter: 'blur(12px)', maxHeight: '52vh' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-steel-700/60 flex-shrink-0">
        <span className="text-xs font-semibold text-steel-300">
          {t('detail_panel_title')}: <span className="text-amber-400 font-mono">{activity.id}</span>
          <span className="text-steel-500 mx-2">-</span>
          <span className="text-steel-200">{activity.name}</span>
          {detailLoading && <Loader2 className="inline w-3 h-3 ml-2 text-steel-500 animate-spin" />}
        </span>
        <button onClick={onClose} className="p-1 rounded hover:bg-steel-700 text-steel-400 hover:text-steel-200 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="overflow-auto px-5 py-3" style={{ maxHeight: 'calc(52vh - 40px)' }}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 min-w-0">

          {/* Длительность */}
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">{t('detail_section_duration')}</div>
            <label className={`flex items-center gap-2 cursor-pointer select-none px-2 py-1.5 rounded-lg border transition-colors ${
              completed ? 'bg-emerald-400/10 border-emerald-500/40' : 'border-steel-700 hover:border-steel-500'
            }`}>
              <input type="checkbox" checked={completed} onChange={e => onSetCompleted(activity.id, e.target.checked)} className="accent-emerald-400 w-3.5 h-3.5" disabled={loading} />
              <CheckCircle2 className={`w-3.5 h-3.5 ${completed ? 'text-emerald-400' : 'text-steel-600'}`} />
              <span className={`text-xs font-medium ${completed ? 'text-emerald-400' : 'text-steel-400'}`}>{t('completed')}</span>
            </label>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('planned_duration')}</span>
              <input type="number" min={0} value={editDuration} onChange={e => setEditDuration(e.target.value)}
                onBlur={handleDurationBlur} onKeyDown={e => e.key === 'Enter' && handleDurationBlur()}
                className={inputCls} disabled={loading || completed} />
              <span className="text-xs text-steel-500">{t('days_suffix')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('actual_duration')}</span>
              <input type="number" min={0} placeholder="-" value={editActualDur}
                onChange={e => setEditActualDur(e.target.value)}
                onBlur={handleActualDurBlur} onKeyDown={e => e.key === 'Enter' && handleActualDurBlur()}
                className={inputCls} disabled={loading || completed} />
              <span className="text-xs text-steel-500">{t('days_suffix')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('remaining_duration')}</span>
              <input type="number" min={0} placeholder="-" value={editRemainDur}
                onChange={e => setEditRemainDur(e.target.value)}
                onBlur={handleRemainDurBlur} onKeyDown={e => e.key === 'Enter' && handleRemainDurBlur()}
                className={inputCls} disabled={loading || completed} />
              <span className="text-xs text-steel-500">{t('days_suffix')}</span>
            </div>
          </div>

          {/* Даты */}
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">{t('detail_section_dates')}</div>
            {([
              [t('col_es'), activity.es_date],
              [t('col_ef'), activity.ef_date],
              [t('col_ls'), activity.ls_date],
              [t('col_lf'), activity.lf_date],
              [t('detail_actual_start'), activity.actual_start || '-'],
              [t('detail_actual_finish'), activity.actual_finish || '-'],
            ] as [string, string][]).map(([label, value], i) => (
              <div key={i} className="flex items-center gap-2">
                <span className={labelCls}>{label}</span>
                <span className={valueCls}>{value}</span>
              </div>
            ))}
          </div>

          {/* Резервы и ограничения */}
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">
              {t('detail_section_float')} / {t('detail_section_constraints')}
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('col_tf')}</span>
              <span className={`text-xs font-mono font-medium ${activity.tf === 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {activity.tf.toFixed(1)} {t('days_suffix')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('col_ff')}</span>
              <span className={valueCls}>{activity.ff.toFixed(1)} {t('days_suffix')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('col_crit')}</span>
              <span className={valueCls}>{activity.on_critical ? t('yes') : t('no')}</span>
            </div>
            <div className="border-t border-steel-700/40 pt-2 mt-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={hardStart} onChange={e => onSetHardStart(activity.id, e.target.checked)} className="accent-amber-400 w-3.5 h-3.5" disabled={loading} />
                <Lock className={`w-3 h-3 ${hardStart ? 'text-amber-400' : 'text-steel-600'}`} />
                <span className="text-xs text-steel-300 font-medium">{t('hard_start')}</span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('detail_type')}</span>
              <span className={valueCls}>{activity.act_type || '-'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('detail_complete')}</span>
              <span className={valueCls}>{activity.pct_complete != null ? `${activity.pct_complete}%` : '-'}</span>
            </div>
          </div>

          {/* Примечания / UDF - из lazy detail */}
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">{t('detail_section_notes')}</div>
            {detailLoading ? (
              <div className="flex items-center gap-2 text-steel-500 text-xs">
                <Loader2 className="w-3 h-3 animate-spin" />{t('loading')}
              </div>
            ) : (
              <div className="text-xs text-steel-300 break-all max-h-24 overflow-auto">
                {detail?.notes || '-'}
              </div>
            )}
            {detail?.constraint_type && (
              <div className="text-[10px] text-steel-500 font-mono">
                {t('detail_constraint_type')}: {detail.constraint_type}
                {detail.constraint_es != null && ` (${detail.constraint_es}d)`}
              </div>
            )}
          </div>
        </div>

        {/* Назначения ресурсов */}
        <div className="mt-4">
          <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider mb-2">{t('resources_title')}</div>
          {detailLoading ? (
            <div className="flex items-center gap-2 text-steel-500 text-xs py-2">
              <Loader2 className="w-3 h-3 animate-spin" />{t('loading')}
            </div>
          ) : (
            <>
              {assignments.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono border border-steel-700 rounded">
                    <thead>
                      <tr className="bg-steel-900">
                        <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('col_id')}</th>
                        <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('col_name')}</th>
                        <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('planned_units')}</th>
                        <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('actual_qty')}</th>
                        <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('remaining_qty')}</th>
                        <th className="px-2 py-1.5 w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.map(asgn => (
                        <tr key={asgn.resource_id} className="border-t border-steel-800">
                          <td className="px-2 py-1 text-steel-400">{asgn.resource_id}</td>
                          <td className="px-2 py-1 text-steel-300">{asgn.resource_name}</td>
                          <td className="px-2 py-1">
                            <input type="number" min={0} step={0.5} value={asgn.planned_units}
                              onChange={e => {
                                const v = parseFloat(e.target.value)
                                if (!isNaN(v) && v >= 0)
                                  onUpdateActivityField(activity.id, -1,
                                    pxpSetAssignmentField(pxpText, activity.id, asgn.resource_id, 3, String(v)))
                              }}
                              className={inputCls + ' w-16'} disabled={loading} />
                          </td>
                          <td className="px-2 py-1">
                            <input type="number" min={0} step={0.5} placeholder="-"
                              value={asgn.actual_qty ?? ''}
                              onChange={e => {
                                const v = e.target.value.trim() === '' ? '' : String(parseFloat(e.target.value))
                                onUpdateActivityField(activity.id, -1,
                                  pxpSetAssignmentField(pxpText, activity.id, asgn.resource_id, 5, v))
                              }}
                              className={inputCls + ' w-16'} disabled={loading} />
                          </td>
                          <td className="px-2 py-1">
                            <input type="number" min={0} step={0.5} placeholder="-"
                              value={asgn.remaining_qty ?? ''}
                              onChange={e => {
                                const v = e.target.value.trim() === '' ? '' : String(parseFloat(e.target.value))
                                onUpdateActivityField(activity.id, -1,
                                  pxpSetAssignmentField(pxpText, activity.id, asgn.resource_id, 7, v))
                              }}
                              className={inputCls + ' w-16'} disabled={loading} />
                          </td>
                          <td className="px-2 py-1">
                            <button
                              onClick={() => onUpdateActivityField(activity.id, -1,
                                pxpRemoveAssignment(pxpText, activity.id, asgn.resource_id))}
                              className="p-0.5 rounded hover:bg-rose-500/20 text-steel-500 hover:text-rose-400 transition-colors"
                              disabled={loading} title={t('remove')}>
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {availableResources.length > 0 && (
                <div className="flex items-center gap-2 mt-2">
                  <select value={newResId} onChange={e => setNewResId(e.target.value)} className={selectCls + ' w-40'} disabled={loading}>
                    <option value="">{t('select_resource')}</option>
                    {availableResources.map(r => <option key={r.id} value={r.id}>{r.id} - {r.name}</option>)}
                  </select>
                  <input type="number" min={0} step={0.5} value={newResUnits} onChange={e => setNewResUnits(e.target.value)} className={inputCls + ' w-16'} disabled={loading} />
                  <button
                    onClick={() => {
                      if (!newResId) return
                      onUpdateActivityField(activity.id, -1, pxpAddAssignment(pxpText, activity.id, newResId, parseFloat(newResUnits) || 1))
                      setNewResId(''); setNewResUnits('1')
                    }}
                    disabled={!newResId || loading}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] bg-steel-800 border border-steel-600 rounded text-steel-300 hover:bg-steel-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    <Plus className="w-3 h-3" />{t('add_resource')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Предшественники */}
        <div className="mt-4">
          <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider mb-2">{t('predecessors')}</div>
          {predecessors.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono border border-steel-700 rounded">
                <thead>
                  <tr className="bg-steel-900">
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('col_id')}</th>
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('col_name')}</th>
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('relation_type')}</th>
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('lag_days')}</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {predecessors.map(rel => {
                    const predAct = actById.get(rel.pred)
                    return (
                      <tr key={rel.pred} className="border-t border-steel-800">
                        <td className="px-2 py-1 text-steel-400">{rel.pred}</td>
                        <td className="px-2 py-1 text-steel-300 max-w-[200px] truncate">{predAct?.name || '-'}</td>
                        <td className="px-2 py-1">
                          <select value={rel.type}
                            onChange={e => onUpdateActivityField(activity.id, -1, pxpUpdateRelationType(pxpText, rel.pred, activity.id, e.target.value))}
                            className={selectCls + ' w-16'} disabled={loading}>
                            {RELATION_TYPES.map(rt => <option key={rt} value={rt}>{rt}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <input type="number" min={0} value={rel.lag}
                            onChange={e => onUpdateActivityField(activity.id, -1, pxpUpdateRelationLag(pxpText, rel.pred, activity.id, parseInt(e.target.value) || 0))}
                            className={inputCls + ' w-14'} disabled={loading} />
                        </td>
                        <td className="px-2 py-1">
                          <button onClick={() => onUpdateActivityField(activity.id, -1, pxpRemoveRelation(pxpText, rel.pred, activity.id))}
                            className="p-0.5 rounded hover:bg-rose-500/20 text-steel-500 hover:text-rose-400 transition-colors"
                            disabled={loading} title={t('remove')}>
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {availablePreds.length > 0 && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <select value={newPredId} onChange={e => setNewPredId(e.target.value)} className={selectCls + ' w-44'} disabled={loading}>
                <option value="">{t('select_activity')}</option>
                {availablePreds.map(a => <option key={a.id} value={a.id}>{a.id} - {a.name}</option>)}
              </select>
              <select value={newRelType} onChange={e => setNewRelType(e.target.value)} className={selectCls + ' w-14'} disabled={loading}>
                {RELATION_TYPES.map(rt => <option key={rt} value={rt}>{rt}</option>)}
              </select>
              <input type="number" min={0} value={newRelLag} onChange={e => setNewRelLag(e.target.value)} className={inputCls + ' w-14'} disabled={loading} />
              <button
                onClick={() => {
                  if (!newPredId) return
                  onUpdateActivityField(activity.id, -1, pxpAddRelation(pxpText, newPredId, activity.id, newRelType, parseInt(newRelLag) || 0))
                  setNewPredId('')
                }}
                disabled={!newPredId || loading}
                className="flex items-center gap-1 px-2 py-1 text-[10px] bg-steel-800 border border-steel-600 rounded text-steel-300 hover:bg-steel-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                <Plus className="w-3 h-3" />{t('add_predecessor')}
              </button>
            </div>
          )}

          {/* Последователи (только отображение) */}
          {successors.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider mb-1.5">{t('successors')}</div>
              <div className="flex flex-wrap gap-2">
                {successors.map(rel => {
                  const succAct = actById.get(rel.succ)
                  return (
                    <span key={rel.succ} className="inline-flex items-center gap-1 px-2 py-0.5 bg-steel-800 border border-steel-700 rounded text-[10px] font-mono">
                      <span className="text-steel-400">{rel.succ}</span>
                      <span className="text-steel-300">{succAct?.name || ''}</span>
                      <span className="text-amber-400/70">{rel.type}</span>
                      {rel.lag > 0 && <span className="text-steel-500">+{rel.lag}</span>}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
