/** React hook - единственная точка управления расписанием.
 * Все взаимодействия с графиком (drag, level, recalc) здесь.
 * Никаких запросов к бэкенду при интерактивных операциях.
 * Поток данных:
 *   Upload -> бэкенд парсит -> минимальные данные ->
 *   useScheduler хранит activities/relations/resources/assignments + pxp_text ->
 *   при любом изменении -> запускает CPM на клиенте (WebGPU/CPU) ->
 *   возвращает готовые dates для Ганта.
 * Детали задачи (name, notes, UDF для формы) -> lazy GET /activity/detail
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  cpmEngine, _scheduleCPU, levelResources,
  type ActivityMin, type Relation, type Resource,
  type Assignment, type ScheduleResult, type LevelingOptions,
} from './cpmEngine'
import { uploadFileRaw, fetchActivityDetail } from '../utils/api'
import {
  pxpSetConstraint, pxpAddRelation, pxpSetActivityField,
} from '../utils/pxpMutations'

export interface ActivityDisplay extends ActivityMin {
  // Результаты CPM в днях
  es_days: number
  ef_days: number
  ls_days: number
  lf_days: number
  tf: number
  ff: number
  on_critical: boolean
  es_date: string
  ef_date: string
  ls_date: string
  lf_date: string
}

export interface ProjectState {
  project_id: string
  project_name: string
  start_date: string
  data_date: string
  must_finish: string
  activities: ActivityDisplay[]
  resources: Resource[]
  assignments: Assignment[]
  resource_load: Record<string, number[]>
  duration_days: number
  finish_date: string
  pxp_text: string
}

export interface SchedulerState {
  project: ProjectState | null
  loading: boolean
  gpuActive: boolean
  error: string | null
  warnings: string[]
}

function daysToDate(startDate: string, days: number): string {
  const d = new Date(startDate)
  d.setDate(d.getDate() + Math.floor(days))
  return d.toISOString().slice(0, 10)
}

function calcResourceLoad(
  activities: ActivityMin[],
  schedResult: ScheduleResult,
  assignments: Assignment[],
  resources: Resource[],
): Record<string, number[]> {
  const maxDay = Math.ceil(Math.max(...Array.from(schedResult.ef), 0))
  if (maxDay <= 0) return {}
  const load: Record<string, number[]> = {}
  for (const r of resources) load[r.id] = new Array(maxDay).fill(0)
  const idxMap = new Map(activities.map((a, i) => [a.id, i]))
  for (const asgn of assignments) {
    const i = idxMap.get(asgn.activity_id)
    if (i == null || !(asgn.resource_id in load)) continue
    const s = Math.floor(schedResult.es[i])
    const e = Math.ceil(schedResult.ef[i])
    for (let d = s; d < e && d < maxDay; d++) load[asgn.resource_id][d] += asgn.units
  }
  return load
}

function buildDisplay(
  activities: ActivityMin[],
  schedResult: ScheduleResult,
  startDate: string,
): ActivityDisplay[] {
  return activities.map((a, i) => {
    const es = schedResult.es[i], ef = schedResult.ef[i]
    const ls = schedResult.ls[i], lf = schedResult.lf[i]
    const tf = schedResult.tf[i], ff = schedResult.ff[i]
    const isMilestone = a.duration === 0
    return {
      ...a,
      es_days: es, ef_days: ef, ls_days: ls, lf_days: lf,
      tf, ff, on_critical: schedResult.on_critical[i] === 1,
      es_date: daysToDate(startDate, es),
      ef_date: daysToDate(startDate, isMilestone ? es : ef - 1),
      ls_date: daysToDate(startDate, ls),
      lf_date: daysToDate(startDate, isMilestone ? ls : lf - 1),
    }
  })
}

export function useScheduler() {
  const [state, setState] = useState<SchedulerState>({
    project: null, loading: false, gpuActive: false, error: null, warnings: [],
  })

  // Исходные данные (не меняются при пересчёте)
  const activitiesRef = useRef<ActivityMin[]>([])
  const relationsRef = useRef<Relation[]>([])
  const resourcesRef = useRef<Resource[]>([])
  const assignmentsRef = useRef<Assignment[]>([])
  const pxpTextRef = useRef<string>('')
  const projectMetaRef = useRef<{ project_id: string; project_name: string; start_date: string; data_date: string; must_finish: string }>({
    project_id: '', project_name: '', start_date: '2024-01-01', data_date: '2024-01-01', must_finish: 'NULL',
  })

  // Инициализация WebGPU при монтировании
  useEffect(() => {
    cpmEngine.init().then(ok => {
      if (ok) setState(s => ({ ...s, gpuActive: true }))
    })
  }, [])

  // Основной метод пересчёта - только на клиенте.
  // activities могут быть переданы с новыми constraint_es
  const _runSchedule = useCallback(async (
    activities: ActivityMin[],
    applyLevel = false,
    levelOpts?: LevelingOptions,
  ): Promise<ScheduleResult | null> => {
    try {
      const relations = relationsRef.current
      let result = await cpmEngine.schedule(activities, relations)

      if (applyLevel && levelOpts) {
        const { es: newES, ef: newEF } = levelResources(
          activities, relations, resourcesRef.current, assignmentsRef.current,
          result, levelOpts
        )
        if (newEF) {};
        // Применяем новые ES как constraints и пересчитываем
        const leveled = activities.map((a, i) => ({
          ...a,
          constraint_es: newES[i],
        }))
        result = await cpmEngine.schedule(leveled, relations)
      }

      return result
    } catch (e: any) {
      setState(s => ({ ...s, error: String(e?.message || e) }))
      return null
    }
  }, [])

  const _applyResult = useCallback((
    activities: ActivityMin[],
    result: ScheduleResult,
    pxpText: string,
    warnings: string[],
  ) => {
    const meta = projectMetaRef.current
    const startDate = meta.start_date
    const display = buildDisplay(activities, result, startDate)
    const resource_load = calcResourceLoad(activities, result, assignmentsRef.current, resourcesRef.current)
    const maxEF = Math.max(...Array.from(result.ef), 0)
    const finishDate = daysToDate(startDate, Math.ceil(maxEF) - 1)

    setState(s => ({
      ...s,
      loading: false,
      error: null,
      warnings,
      project: {
        ...meta,
        activities: display,
        resources: resourcesRef.current,
        assignments: assignmentsRef.current,
        resource_load,
        duration_days: Math.ceil(maxEF),
        finish_date: finishDate,
        pxp_text: pxpText,
      },
    }))
  }, [])

  // Загрузка файла - единственный запрос к бэкенду
  const loadFile = useCallback(async (file: File) => {
    setState(s => ({ ...s, loading: true, error: null, warnings: [] }))
    try {
      const raw = await uploadFileRaw(file)
      activitiesRef.current  = raw.activities
      relationsRef.current   = raw.relations
      resourcesRef.current   = raw.resources
      assignmentsRef.current = raw.assignments
      pxpTextRef.current     = raw.pxp_text
      projectMetaRef.current = raw.project
      const result = await _runSchedule(raw.activities)
      if (!result) return
      _applyResult(raw.activities, result, raw.pxp_text, raw.warnings ?? [])
    } catch (e: any) {
      setState(s => ({ ...s, loading: false, error: e?.response?.data?.detail || e?.message || 'Upload failed' }))
    }
  }, [_runSchedule, _applyResult])

  // Пересчёт без изменений (кнопка Пересчитать)
  const recalculate = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }))
    const result = await _runSchedule(activitiesRef.current)
    if (!result) return
    _applyResult(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_runSchedule, _applyResult])

  // Выравнивание ресурсов - только клиент
  const levelResourcesAction = useCallback(async (opts: LevelingOptions) => {
    setState(s => ({ ...s, loading: true, error: null }))
    const result = await _runSchedule(activitiesRef.current, true, opts)
    if (!result) return

    // Обновляем constraint_es в pxp_text для заблокированных и сдвинутых работ
    let newPxp = pxpTextRef.current
    activitiesRef.current.forEach((a, i) => {
      if (!_isLocked(a)) {
        newPxp = pxpSetConstraint(newPxp, a.id, result.es[i])
      }
    })
    pxpTextRef.current = newPxp

    _applyResult(activitiesRef.current, result, newPxp, [])
  }, [_runSchedule, _applyResult])

  // Перемещение задачи на Ганте (drag) - только клиент, мгновенный отклик
  const moveActivity = useCallback(async (actId: string, newEsDays: number) => {
    const activities = activitiesRef.current
    const idx = activities.findIndex(a => a.id === actId)
    if (idx === -1) return
    if (_isLocked(activities[idx])) return  // начатые/завершённые не двигаются

    setState(s => ({ ...s, loading: true }))

    // Обновляем constraint_es только для этой задачи
    const updated = activities.map((a, i) =>
      i === idx ? { ...a, constraint_es: newEsDays } : a
    )
    activitiesRef.current = updated

    // Обновляем pxp_text
    pxpTextRef.current = pxpSetConstraint(pxpTextRef.current, actId, newEsDays)

    const result = await _runSchedule(updated)
    if (!result) return
    _applyResult(updated, result, pxpTextRef.current, [])
  }, [_runSchedule, _applyResult])

  // Добавление связи (drag bar на bar)
  const addRelation = useCallback(async (predId: string, succId: string) => {
    const existing = relationsRef.current
    if (existing.find(r => r.pred === predId && r.succ === succId)) return

    setState(s => ({ ...s, loading: true }))
    relationsRef.current = [...existing, { pred: predId, succ: succId, type: 'FS', lag: 0 }]
    pxpTextRef.current = pxpAddRelation(pxpTextRef.current, predId, succId, 'FS', 0)

    const result = await _runSchedule(activitiesRef.current)
    if (!result) return
    _applyResult(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_runSchedule, _applyResult])

  // Обновление поля задачи (duration, actual_start, etc.)
  const updateActivityField = useCallback(async (
    actId: string, fieldIdx: number, value: string
  ) => {
    setState(s => ({ ...s, loading: true }))
    pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, fieldIdx, value)

    // Обновляем локальные данные и пересчитываем duration если изменились actual/remaining
    activitiesRef.current = activitiesRef.current.map(a => {
      if (a.id !== actId) return a
      const updated = { ...a }
      if (fieldIdx === 2)  updated.duration = parseFloat(value) || a.duration
      if (fieldIdx === 6)  updated.constraint_es = value ? parseFloat(value) : null
      if (fieldIdx === 8)  updated.actual_start = value || null
      if (fieldIdx === 9)  updated.actual_finish = value || null
      if (fieldIdx === 10) updated.pct_complete = parseFloat(value) || 0
      if (fieldIdx === 13) updated.actual_duration = value ? parseFloat(value) : null
      if (fieldIdx === 14) updated.remaining_duration = value ? parseFloat(value) : null

      // Если изменилась фактическая или остаточная длительность -
      // пересчитываем плановую длительность и % выполнения
      if (fieldIdx === 13 || fieldIdx === 14) {
        const ad = fieldIdx === 13 ? updated.actual_duration : a.actual_duration
        const rd = fieldIdx === 14 ? updated.remaining_duration : a.remaining_duration
        if (ad != null && ad >= 0 && rd != null && rd >= 0) {
          const newDur = ad + rd
          if (newDur > 0) {
            updated.duration = newDur
            pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, 2, String(newDur))
          }
          // % выполнения = actual / (actual + remaining) * 100
          const pct = (ad + rd) > 0 ? Math.round(ad / (ad + rd) * 100) : 0
          updated.pct_complete = pct
          pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, 10, String(pct))
        }
      }
      return updated
    })

    const result = await _runSchedule(activitiesRef.current)
    if (!result) return
    _applyResult(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_runSchedule, _applyResult])

  /** Применяеv готовый pxp_text напрямую и перезапускаеv CPM.
   * Используется когда мутация затрагивает несколько полей сразу
   * (assignments, relations) и проще передать новый текст целиком */
  const applyPxpText = useCallback(async (newPxp: string) => {
    setState(s => ({ ...s, loading: true }))
    pxpTextRef.current = newPxp

    // Перепарсим activities из нового pxp чтобы подхватить любые изменения
    const lines = newPxp.split('\n')
    let inAct = false
    const updatedMap = new Map(activitiesRef.current.map(a => [a.id, { ...a }]))
    for (const line of lines) {
      const t = line.trim()
      if (t === '@ACTIVITIES') { inAct = true; continue }
      if (inAct && t.startsWith('@')) break
      if (!inAct || t.startsWith('#') || !t) continue
      const parts = t.split('|').map(s => s.trim())
      const id = parts[0]; if (!id || !updatedMap.has(id)) continue
      const a = updatedMap.get(id)!
      if (parts[2]) a.duration = parseFloat(parts[2]) || a.duration
      if (parts[6] !== undefined) a.constraint_es = parts[6] ? parseFloat(parts[6]) : null
      if (parts[8] !== undefined) a.actual_start = parts[8] || null
      if (parts[9] !== undefined) a.actual_finish = parts[9] || null
      if (parts[10] !== undefined) a.pct_complete = parts[10] ? parseFloat(parts[10]) : 0
      if (parts[13] !== undefined) a.actual_duration = parts[13] ? parseFloat(parts[13]) : null
      if (parts[14] !== undefined) a.remaining_duration = parts[14] ? parseFloat(parts[14]) : null
    }
    activitiesRef.current = Array.from(updatedMap.values())

    const result = await _runSchedule(activitiesRef.current)
    if (!result) return
    _applyResult(activitiesRef.current, result, newPxp, [])
  }, [_runSchedule, _applyResult])

  // Lazy-загрузка деталей задачи при клике - единственный лёгкий запрос к бэкенду
  const fetchDetail = useCallback(async (actId: string) => {
    return fetchActivityDetail(pxpTextRef.current, actId)
  }, [])

  // Скачать PXP - просто возвращает текущий pxp_text
  const getPxpText = useCallback(() => pxpTextRef.current, [])

  return {
    state,
    loadFile,
    recalculate,
    levelResourcesAction,
    moveActivity,
    addRelation,
    updateActivityField,
    applyPxpText,
    fetchDetail,
    getPxpText,
  }
}

function _isLocked(a: ActivityMin): boolean {
  if (a.actual_start) return true
  if (a.actual_finish) return true
  if (a.pct_complete >= 100) return true
  if (a.actual_duration != null && a.actual_duration > 0 &&
      (a.remaining_duration == null || a.remaining_duration === 0)) return true
  return false
}
