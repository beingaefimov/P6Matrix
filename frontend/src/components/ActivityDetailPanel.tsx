import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Plus, Trash2, Lock, CheckCircle2 } from 'lucide-react'
import type { ActivityOut, ResourceOut } from '../types'
import { getAssignmentsForActivity, getRelationsForActivity, getActivityExtra } from '../utils/pxpUtils'

interface Props {
  activity: ActivityOut
  onClose: () => void
  pxpText: string
  activities: ActivityOut[]
  resources: ResourceOut[]
  hardStart: boolean
  completed: boolean
  onSetDuration: (actId: string, duration: number) => void
  onSetActualDuration: (actId: string, value: number | null) => void
  onSetRemainingDuration: (actId: string, value: number | null) => void
  onSetCompleted: (actId: string, completed: boolean) => void
  onSetResourceCompleted: (actId: string, resId: string, completed: boolean) => void
  onSetHardStart: (actId: string, value: boolean) => void
  onSetAssignmentUnits: (actId: string, resId: string, units: number) => void
  onSetAssignmentActual: (actId: string, resId: string, value: number | null) => void
  onSetAssignmentRemaining: (actId: string, resId: string, value: number | null) => void
  onAddAssignment: (actId: string, resId: string, units: number) => void
  onRemoveAssignment: (actId: string, resId: string) => void
  onAddRelation: (predId: string, succId: string, type: string, lag: number) => void
  onRemoveRelation: (predId: string, succId: string) => void
  onUpdateRelationType: (predId: string, succId: string, type: string) => void
  onUpdateRelationLag: (predId: string, succId: string, lag: number) => void
  loading?: boolean
}

const RELATION_TYPES = ['FS', 'SS', 'FF', 'SF']

export default function ActivityDetailPanel({
  activity, onClose, pxpText, activities, resources, hardStart, completed,
  onSetDuration, onSetActualDuration, onSetRemainingDuration, onSetCompleted,
  onSetResourceCompleted, onSetHardStart,
  onSetAssignmentUnits, onSetAssignmentActual, onSetAssignmentRemaining,
  onAddAssignment, onRemoveAssignment,
  onAddRelation, onRemoveRelation, onUpdateRelationType, onUpdateRelationLag,
  loading,
}: Props) {
  const { t } = useTranslation()

  const [editDuration, setEditDuration] = useState(String(Math.round(activity.duration)))
  const [editActualDur, setEditActualDur] = useState('')
  const [editRemainDur, setEditRemainDur] = useState('')
  const [newPredId, setNewPredId] = useState('')
  const [newRelType, setNewRelType] = useState('FS')
  const [newRelLag, setNewRelLag] = useState('0')
  const [newResId, setNewResId] = useState('')
  const [newResUnits, setNewResUnits] = useState('1')

  const extra = useMemo(() => getActivityExtra(pxpText, activity.id), [pxpText, activity.id])
  const assignments = useMemo(() => getAssignmentsForActivity(pxpText, activity.id, resources), [pxpText, activity.id, resources])
  const predecessors = useMemo(() => getRelationsForActivity(pxpText, activity.id).asSucc, [pxpText, activity.id])
  const successors = useMemo(() => getRelationsForActivity(pxpText, activity.id).asPred, [pxpText, activity.id])

  useEffect(() => {
    setEditDuration(String(Math.round(activity.duration)))
    setEditActualDur(extra.actualDuration !== null ? String(extra.actualDuration) : '')
    setEditRemainDur(extra.remainingDuration !== null ? String(extra.remainingDuration) : '')
    setNewPredId('')
    setNewRelType('FS')
    setNewRelLag('0')
    setNewResId('')
    setNewResUnits('1')
  }, [activity.id, activity.duration, extra.actualDuration, extra.remainingDuration])

  const availablePreds = useMemo(() => {
    const existingPredIds = new Set(predecessors.map(r => r.pred))
    return activities.filter(a => a.id !== activity.id && !existingPredIds.has(a.id))
  }, [activities, activity.id, predecessors])

  const availableResources = useMemo(() => {
    const assignedResIds = new Set(assignments.map(a => a.resource_id))
    return resources.filter(r => !assignedResIds.has(r.id))
  }, [resources, assignments])

  const actById = useMemo(() => {
    const m = new Map<string, ActivityOut>()
    activities.forEach(a => m.set(a.id, a))
    return m
  }, [activities])

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
    if (val === null || (!isNaN(val) && val >= 0)) {
      onSetActualDuration(activity.id, val)
    } else {
      setEditActualDur(extra.actualDuration !== null ? String(extra.actualDuration) : '')
    }
  }

  const handleRemainDurBlur = () => {
    const val = editRemainDur.trim() === '' ? null : parseFloat(editRemainDur)
    if (val === null || (!isNaN(val) && val >= 0)) {
      onSetRemainingDuration(activity.id, val)
    } else {
      setEditRemainDur(extra.remainingDuration !== null ? String(extra.remainingDuration) : '')
    }
  }

  const handleAddPred = () => {
    if (!newPredId) return
    onAddRelation(newPredId, activity.id, newRelType, parseInt(newRelLag) || 0)
  }

  const handleAddResource = () => {
    if (!newResId) return
    onAddAssignment(activity.id, newResId, parseFloat(newResUnits) || 1)
  }

  const inputCls = 'w-20 px-2 py-1 text-xs font-mono bg-steel-800 border border-steel-600 rounded text-steel-200 focus:outline-none focus:border-amber-400/60 transition-colors'
  const selectCls = 'px-2 py-1 text-xs font-mono bg-steel-800 border border-steel-600 rounded text-steel-200 focus:outline-none focus:border-amber-400/60 transition-colors'
  const labelCls = 'text-[10px] text-steel-500 font-medium whitespace-nowrap'
  const valueCls = 'text-xs text-steel-200 font-mono'

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-steel-700 shadow-2xl animate-slide-up"
      style={{
        backgroundColor: 'rgba(15,35,51,0.97)',
        backdropFilter: 'blur(12px)',
        maxHeight: '52vh',
      }}
    >
      <div className="flex items-center justify-between px-5 py-2 border-b border-steel-700/60 flex-shrink-0">
        <span className="text-xs font-semibold text-steel-300">
          {t('detail_panel_title')}: <span className="text-amber-400 font-mono">{activity.id}</span>
          <span className="text-steel-500 mx-2">-</span>
          <span className="text-steel-200">{activity.name}</span>
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-steel-700 text-steel-400 hover:text-steel-200 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="overflow-auto px-5 py-3" style={{ maxHeight: 'calc(52vh - 40px)' }}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 min-w-0">
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">
              {t('detail_section_duration')}
            </div>
            <label className={`flex items-center gap-2 cursor-pointer select-none px-2 py-1.5 rounded-lg border transition-colors ${
              completed
                ? 'bg-emerald-400/10 border-emerald-500/40'
                : 'border-steel-700 hover:border-steel-500'
            }`}>
              <input
                type="checkbox"
                checked={completed}
                onChange={e => onSetCompleted(activity.id, e.target.checked)}
                className="accent-emerald-400 w-3.5 h-3.5"
                disabled={loading}
              />
              <CheckCircle2 className={`w-3.5 h-3.5 ${completed ? 'text-emerald-400' : 'text-steel-600'}`} />
              <span className={`text-xs font-medium ${completed ? 'text-emerald-400' : 'text-steel-400'}`}>
                {t('completed')}
              </span>
            </label>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('planned_duration')}</span>
              <input
                type="number"
                min={0}
                value={editDuration}
                onChange={e => setEditDuration(e.target.value)}
                onBlur={handleDurationBlur}
                onKeyDown={e => e.key === 'Enter' && handleDurationBlur()}
                className={inputCls}
                disabled={loading || completed}
              />
              <span className="text-xs text-steel-500">{t('days_suffix')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('actual_duration')}</span>
              <input
                type="number"
                min={0}
                placeholder="-"
                value={editActualDur}
                onChange={e => setEditActualDur(e.target.value)}
                onBlur={handleActualDurBlur}
                onKeyDown={e => e.key === 'Enter' && handleActualDurBlur()}
                className={inputCls}
                disabled={loading || completed}
              />
              <span className="text-xs text-steel-500">{t('days_suffix')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('remaining_duration')}</span>
              <input
                type="number"
                min={0}
                placeholder="-"
                value={editRemainDur}
                onChange={e => setEditRemainDur(e.target.value)}
                onBlur={handleRemainDurBlur}
                onKeyDown={e => e.key === 'Enter' && handleRemainDurBlur()}
                className={inputCls}
                disabled={loading || completed}
              />
              <span className="text-xs text-steel-500">{t('days_suffix')}</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">
              {t('detail_section_dates')}
            </div>
            {[
              [t('col_es'), activity.es_date],
              [t('col_ef'), activity.ef_date],
              [t('col_ls'), activity.ls_date],
              [t('col_lf'), activity.lf_date],
              [t('detail_actual_start'), activity.actual_start || '-'],
              [t('detail_actual_finish'), activity.actual_finish || '-'],
            ].map(([label, value], i) => (
              <div key={i} className="flex items-center gap-2">
                <span className={labelCls}>{label}</span>
                <span className={valueCls}>{value}</span>
              </div>
            ))}
          </div>
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
                <input
                  type="checkbox"
                  checked={hardStart}
                  onChange={e => onSetHardStart(activity.id, e.target.checked)}
                  className="accent-amber-400 w-3.5 h-3.5"
                  disabled={loading}
                />
                <Lock className={`w-3 h-3 ${hardStart ? 'text-amber-400' : 'text-steel-600'}`} />
                <span className="text-xs text-steel-300 font-medium">{t('hard_start')}</span>
              </label>
              {activity.constraint_type && (
                <div className="mt-1 text-[10px] text-steel-500 font-mono">
                  {activity.constraint_type}{' '}
                  {activity.constraint_date || (activity.constraint_es != null ? `${activity.constraint_es}${t('days_suffix')}` : '')}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('detail_type')}</span>
              <span className={valueCls}>{activity.activity_type || '-'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={labelCls}>{t('detail_complete')}</span>
              <span className={valueCls}>{activity.percent_complete != null ? `${activity.percent_complete}%` : '-'}</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">
              {t('detail_section_notes')}
            </div>
            <div className="text-xs text-steel-300 break-all max-h-24 overflow-auto">
              {activity.notes || '-'}
            </div>
            {activity.udf_values && Object.keys(activity.udf_values).length > 0 && (
              <>
                <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider mt-3">
                  {t('detail_section_udf')}
                </div>
                {Object.entries(activity.udf_values).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className={labelCls}>{k}</span>
                    <span className={valueCls}>{v != null ? String(v) : '-'}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="mt-4">
          <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider mb-2">
            {t('resources_title')}
          </div>
          {assignments.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono border border-steel-700 rounded">
                <thead>
                  <tr className="bg-steel-900">
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium w-6"></th>
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('col_id')}</th>
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('col_name')}</th>
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('planned_units')}</th>
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('actual_qty')}</th>
                    <th className="px-2 py-1.5 text-left text-steel-500 font-medium">{t('remaining_qty')}</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map(asgn => {
                    const resCompleted = asgn.remaining_qty != null && asgn.remaining_qty === 0
                    return (
                      <tr key={asgn.resource_id} className={`border-t border-steel-800 ${resCompleted ? 'opacity-50' : ''}`}>
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            checked={resCompleted}
                            onChange={e => onSetResourceCompleted(activity.id, asgn.resource_id, e.target.checked)}
                            className="accent-emerald-400 w-3 h-3"
                            disabled={loading}
                            title={t('completed')}
                          />
                        </td>
                        <td className="px-2 py-1 text-steel-400">{asgn.resource_id}</td>
                        <td className="px-2 py-1 text-steel-300">{asgn.resource_name}</td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            value={asgn.planned_units}
                            onChange={e => {
                              const v = parseFloat(e.target.value)
                              if (!isNaN(v) && v >= 0) onSetAssignmentUnits(activity.id, asgn.resource_id, v)
                            }}
                            className={inputCls + ' w-16'}
                            disabled={loading}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            placeholder="-"
                            value={asgn.actual_qty ?? ''}
                            onChange={e => {
                              const v = e.target.value.trim() === '' ? null : parseFloat(e.target.value)
                              if (v === null || (!isNaN(v) && v >= 0)) onSetAssignmentActual(activity.id, asgn.resource_id, v)
                            }}
                            className={inputCls + ' w-16'}
                            disabled={loading}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            min={0}
                            step={0.5}
                            placeholder="-"
                            value={asgn.remaining_qty ?? ''}
                            onChange={e => {
                              const v = e.target.value.trim() === '' ? null : parseFloat(e.target.value)
                              if (v === null || (!isNaN(v) && v >= 0)) onSetAssignmentRemaining(activity.id, asgn.resource_id, v)
                            }}
                            className={inputCls + ' w-16'}
                            disabled={loading || resCompleted}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <button
                            onClick={() => onRemoveAssignment(activity.id, asgn.resource_id)}
                            className="p-0.5 rounded hover:bg-rose-500/20 text-steel-500 hover:text-rose-400 transition-colors"
                            disabled={loading}
                            title={t('remove')}
                          >
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
          {availableResources.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <select
                value={newResId}
                onChange={e => setNewResId(e.target.value)}
                className={selectCls + ' w-40'}
                disabled={loading}
              >
                <option value="">{t('select_resource')}</option>
                {availableResources.map(r => (
                  <option key={r.id} value={r.id}>{r.id} - {r.name}</option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                step={0.5}
                value={newResUnits}
                onChange={e => setNewResUnits(e.target.value)}
                className={inputCls + ' w-16'}
                placeholder={t('planned_units')}
                disabled={loading}
              />
              <button
                onClick={handleAddResource}
                disabled={!newResId || loading}
                className="flex items-center gap-1 px-2 py-1 text-[10px] bg-steel-800 border border-steel-600 rounded text-steel-300 hover:bg-steel-700 hover:border-steel-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-3 h-3" />
                {t('add_resource')}
              </button>
            </div>
          )}
        </div>
        <div className="mt-4">
          <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider mb-2">
            {t('predecessors')}
          </div>
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
                          <select
                            value={rel.type}
                            onChange={e => onUpdateRelationType(rel.pred, activity.id, e.target.value)}
                            className={selectCls + ' w-16'}
                            disabled={loading}
                          >
                            {RELATION_TYPES.map(rt => (
                              <option key={rt} value={rt}>{rt}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            min={0}
                            value={rel.lag}
                            onChange={e => onUpdateRelationLag(rel.pred, activity.id, parseInt(e.target.value) || 0)}
                            className={inputCls + ' w-14'}
                            disabled={loading}
                          />
                        </td>
                        <td className="px-2 py-1">
                          <button
                            onClick={() => onRemoveRelation(rel.pred, activity.id)}
                            className="p-0.5 rounded hover:bg-rose-500/20 text-steel-500 hover:text-rose-400 transition-colors"
                            disabled={loading}
                            title={t('remove')}
                          >
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
              <select
                value={newPredId}
                onChange={e => setNewPredId(e.target.value)}
                className={selectCls + ' w-44'}
                disabled={loading}
              >
                <option value="">{t('select_activity')}</option>
                {availablePreds.map(a => (
                  <option key={a.id} value={a.id}>{a.id} - {a.name}</option>
                ))}
              </select>
              <select
                value={newRelType}
                onChange={e => setNewRelType(e.target.value)}
                className={selectCls + ' w-14'}
                disabled={loading}
              >
                {RELATION_TYPES.map(rt => (
                  <option key={rt} value={rt}>{rt}</option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                value={newRelLag}
                onChange={e => setNewRelLag(e.target.value)}
                className={inputCls + ' w-14'}
                placeholder={t('lag_days')}
                disabled={loading}
              />
              <button
                onClick={handleAddPred}
                disabled={!newPredId || loading}
                className="flex items-center gap-1 px-2 py-1 text-[10px] bg-steel-800 border border-steel-600 rounded text-steel-300 hover:bg-steel-700 hover:border-steel-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-3 h-3" />
                {t('add_predecessor')}
              </button>
            </div>
          )}
          {successors.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider mb-1.5">
                {t('successors')}
              </div>
              <div className="flex flex-wrap gap-2">
                {successors.map(rel => {
                  const succAct = actById.get(rel.succ)
                  return (
                    <span
                      key={rel.succ}
                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-steel-800 border border-steel-700 rounded text-[10px] font-mono"
                    >
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