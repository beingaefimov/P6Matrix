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
  cpmEngine, levelResources,
  type ActivityMin, type Relation, type Resource,
  type Assignment, type ScheduleResult, type LevelingOptions,
} from './cpmEngine'
import { uploadFileRaw, fetchActivityDetail } from '../utils/api'
import { pxpSetConstraint, pxpAddRelation, pxpSetActivityField, pxpAddResource,
  pxpRemoveResource, pxpRemoveResourceAssignments, pxpUpdateResource } from '../utils/pxpMutations'

export interface ActivityDisplay extends ActivityMin {
  es_days: number; ef_days: number; ls_days: number; lf_days: number
  tf: number; ff: number; on_critical: boolean
  es_date: string; ef_date: string; ls_date: string; lf_date: string
}

export interface ProjectState {
  project_id: string; project_name: string; start_date: string
  data_date: string; must_finish: string
  activities: ActivityDisplay[]
  resources: Resource[]
  assignments: Assignment[]
  resource_load: Record<string, number[]>
  duration_days: number; finish_date: string; pxp_text: string
}

export interface SchedulerState {
  project: ProjectState | null
  loading: boolean; gpuActive: boolean
  error: string | null; warnings: string[]
}

function daysToDate(startDate: string, days: number): string {
  const d = new Date(startDate)
  d.setDate(d.getDate() + Math.floor(days))
  return d.toISOString().slice(0, 10)
}

function calcResourceLoad(
  activities: ActivityMin[], schedResult: ScheduleResult,
  assignments: Assignment[], resources: Resource[],
): Record<string, number[]> {
  const maxDay = Math.ceil(Math.max(...(Array.from(schedResult.ef) as number[]), 0))
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
  activities: ActivityMin[], schedResult: ScheduleResult, startDate: string,
): ActivityDisplay[] {
  return activities.map((a, i) => {
    const es = schedResult.es[i], ef = schedResult.ef[i]
    const ls = schedResult.ls[i], lf = schedResult.lf[i]
    const isMilestone = a.duration === 0
    return {
      ...a,
      es_days: es, ef_days: ef, ls_days: ls, lf_days: lf,
      tf: schedResult.tf[i], ff: schedResult.ff[i],
      on_critical: schedResult.on_critical[i] === 1,
      es_date: daysToDate(startDate, es),
      ef_date: daysToDate(startDate, isMilestone ? es : ef - 1),
      ls_date: daysToDate(startDate, ls),
      lf_date: daysToDate(startDate, isMilestone ? ls : lf - 1),
    }
  })
}

function parseAssignmentsFromPxp(pxp: string): Assignment[] {
  const result: Assignment[] = []
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@ASSIGNMENTS') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || t.startsWith('#') || !t) continue
    const parts = t.split('|').map(s => s.trim())
    if (!parts[0] || !parts[1]) continue
    const isNew = parts.length >= 4 && (parts[2] === '' || isNaN(Number(parts[2])))
    const units = isNew ? (parseFloat(parts[3]) || 0) : (parseFloat(parts[2]) || 0)
    const actual_qty    = (isNew && parts[5]) ? parseFloat(parts[5]) || null : null
    const remaining_qty = (isNew && parts[7]) ? parseFloat(parts[7]) || null : null
    result.push({ activity_id: parts[0], resource_id: parts[1], units, actual_qty, remaining_qty })
  }
  return result
}

function parseRelationsFromPxp(pxp: string): Relation[] {
  const result: Relation[] = []
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@RELATIONS') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || t.startsWith('#') || !t) continue
    const parts = t.split('|').map(s => s.trim())
    if (parts.length >= 2 && parts[0] && parts[1]) {
      result.push({
        pred: parts[0], succ: parts[1],
        type: parts[2] || 'FS',
        lag: parseFloat(parts[3]) || 0,
      })
    }
  }
  return result
}

function parseActivitiesFromPxp(pxp: string, existing: Map<string, ActivityMin>): ActivityMin[] {
  const result: ActivityMin[] = []
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@ACTIVITIES') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || t.startsWith('#') || !t) continue
    const parts = t.split('|').map(s => s.trim())
    const id = parts[0]
    if (!id) continue
    const base = existing.get(id)
    result.push({
      id,
      name: parts[1] ?? base?.name ?? id,
      duration: parts[2] ? parseFloat(parts[2]) : (base?.duration ?? 0),
      act_type: parts[3] ?? base?.act_type ?? 'task_dependent',
      parent_id: parts[5] || null,
      constraint_es: parts[6] ? parseFloat(parts[6]) : null,
      actual_start: parts[8]  || null,
      actual_finish: parts[9]  || null,
      pct_complete: parts[10] ? parseFloat(parts[10]) : 0,
      actual_duration: parts[13] ? parseFloat(parts[13]) : null,
      remaining_duration: parts[14] ? parseFloat(parts[14]) : null,
    })
  }
  return result
}

function parseMetaFromPxp(pxp: string) {
  const meta = { project_id: '', project_name: '', start_date: '2024-01-01', data_date: '2024-01-01', must_finish: 'NULL' }
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@META') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || !t || t.startsWith('#')) continue
    if (t.includes('=')) {
      const [k, v] = t.split('=', 2)
      const key = k.trim()
      const val = v.trim()
      if (key === 'project_id' || key === 'project_name' || key === 'start_date' || key === 'data_date' || key === 'must_finish') {
        (meta as any)[key] = val
      }
    }
  }
  return meta
}

function parseResourcesFromPxp(pxp: string): Resource[] {
  const result: Resource[] = []
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@RESOURCES') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || t.startsWith('#') || !t) continue
    const parts = t.split('|').map(s => s.trim())
    if (!parts[0] || !parts[1]) continue
    result.push({
      id: parts[0],
      name: parts[1],
      max_units: parseFloat(parts[2]) || 1,
      cost_per_unit: parseFloat(parts[3]) || 0,
    })
  }
  return result
}

function actIsLocked(a: ActivityMin): boolean {
  if (a.actual_start || a.actual_finish) return true
  if (a.pct_complete >= 100) return true
  if (a.actual_duration != null && a.actual_duration > 0 &&
      (a.remaining_duration == null || a.remaining_duration === 0)) return true
  return false
}

export function useScheduler() {
  const [state, setState] = useState<SchedulerState>({
    project: null, loading: false, gpuActive: false, error: null, warnings: [],
  })

  const activitiesRef = useRef<ActivityMin[]>([])
  const relationsRef = useRef<Relation[]>([])
  const resourcesRef = useRef<Resource[]>([])
  const assignmentsRef = useRef<Assignment[]>([])
  const pxpTextRef = useRef<string>('')
  const metaRef = useRef({ project_id: '', project_name: '', start_date: '2024-01-01', data_date: '2024-01-01', must_finish: 'NULL' })

  useEffect(() => {
    cpmEngine.init().then(ok => { if (ok) setState(s => ({ ...s, gpuActive: true })) })
  }, [])

  const _run = useCallback(async (
    activities: ActivityMin[],
    applyLevel = false,
    levelOpts?: LevelingOptions,
  ): Promise<ScheduleResult | null> => {
    try {
      let result = await cpmEngine.schedule(activities, relationsRef.current)
      if (applyLevel && levelOpts) {
        const { es: newES } = levelResources(
          activities, relationsRef.current, resourcesRef.current,
          assignmentsRef.current, result, levelOpts,
        )
        const leveled = activities.map((a, i) => ({ ...a, constraint_es: newES[i] }))
        result = await cpmEngine.schedule(leveled, relationsRef.current)
      }
      return result
    } catch (e: unknown) {
      setState(s => ({ ...s, error: e instanceof Error ? e.message : String(e) }))
      return null
    }
  }, [])

  const _apply = useCallback((
    activities: ActivityMin[], result: ScheduleResult,
    pxpText: string, warnings: string[],
  ) => {
    const parsed = parseAssignmentsFromPxp(pxpText)
    assignmentsRef.current = parsed
    const meta = metaRef.current
    const display = buildDisplay(activities, result, meta.start_date)
    const load = calcResourceLoad(activities, result, parsed, resourcesRef.current)
    const maxEF = Math.max(...(Array.from(result.ef) as number[]), 0)
    setState(s => ({
      ...s, loading: false, error: null, warnings,
      project: {
        ...meta,
        activities: display, resources: resourcesRef.current,
        assignments: parsed, resource_load: load,
        duration_days: Math.ceil(maxEF),
        finish_date: daysToDate(meta.start_date, Math.ceil(maxEF) - 1),
        pxp_text: pxpText,
      },
    }))
  }, [])

  const loadFile = useCallback(async (file: File) => {
    setState(s => ({ ...s, loading: true, error: null, warnings: [] }))
    try {
      const raw = await uploadFileRaw(file)
      activitiesRef.current = raw.activities
      relationsRef.current = raw.relations
      resourcesRef.current = raw.resources
      assignmentsRef.current = raw.assignments
      pxpTextRef.current = raw.pxp_text
      metaRef.current = raw.project
      const result = await _run(raw.activities)
      if (!result) return
      _apply(raw.activities, result, raw.pxp_text, raw.warnings ?? [])
    } catch (e: unknown) {
      setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [_run, _apply])

  const recalculate = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }))
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const levelResourcesAction = useCallback(async (opts: LevelingOptions) => {
    setState(s => ({ ...s, loading: true, error: null }))
    const result = await _run(activitiesRef.current, true, opts)
    if (!result) return
    let pxp = pxpTextRef.current
    activitiesRef.current.forEach((a, i) => {
      if (!actIsLocked(a)) pxp = pxpSetConstraint(pxp, a.id, result.es[i])
    })
    pxpTextRef.current = pxp
    _apply(activitiesRef.current, result, pxp, [])
  }, [_run, _apply])

  const moveActivity = useCallback(async (actId: string, newEsDays: number) => {
    const acts = activitiesRef.current
    const idx = acts.findIndex(a => a.id === actId)
    if (idx < 0 || actIsLocked(acts[idx])) return
    setState(s => ({ ...s, loading: true }))
    const updated = acts.map((a, i) => i === idx ? { ...a, constraint_es: newEsDays } : a)
    activitiesRef.current = updated
    pxpTextRef.current = pxpSetConstraint(pxpTextRef.current, actId, newEsDays)
    const result = await _run(updated)
    if (!result) return
    _apply(updated, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const addRelation = useCallback(async (predId: string, succId: string) => {
    if (relationsRef.current.find(r => r.pred === predId && r.succ === succId)) return
    setState(s => ({ ...s, loading: true }))
    relationsRef.current = [...relationsRef.current, { pred: predId, succ: succId, type: 'FS', lag: 0 }]
    pxpTextRef.current = pxpAddRelation(pxpTextRef.current, predId, succId, 'FS', 0)
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const updateActivityField = useCallback(async (actId: string, fieldIdx: number, value: string) => {
    setState(s => ({ ...s, loading: true }))
    pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, fieldIdx, value)
    activitiesRef.current = activitiesRef.current.map(a => {
      if (a.id !== actId) return a
      const u = { ...a }
      if (fieldIdx === 2) u.duration = parseFloat(value) || a.duration
      if (fieldIdx === 6) u.constraint_es = value ? parseFloat(value) : null
      if (fieldIdx === 8) u.actual_start = value || null
      if (fieldIdx === 9) u.actual_finish = value || null
      if (fieldIdx === 10) u.pct_complete = parseFloat(value) || 0
      if (fieldIdx === 13) u.actual_duration = value ? parseFloat(value) : null
      if (fieldIdx === 14) u.remaining_duration = value ? parseFloat(value) : null
      if (fieldIdx === 13 || fieldIdx === 14) {
        const ad = fieldIdx === 13 ? u.actual_duration    : a.actual_duration
        const rd = fieldIdx === 14 ? u.remaining_duration : a.remaining_duration
        if (ad != null && ad >= 0 && rd != null && rd >= 0) {
          const newDur = ad + rd
          if (newDur > 0) {
            u.duration = newDur
            pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, 2, String(newDur))
          }
          const pct = newDur > 0 ? Math.round(ad / newDur * 100) : 0
          u.pct_complete = pct
          pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, 10, String(pct))
        }
      }
      return u
    })
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const applyPxpText = useCallback(async (newPxp: string) => {
    setState(s => ({ ...s, loading: true }))
    const prevSuccsSet = new Set(relationsRef.current.map(r => r.succ))
    const newRels = parseRelationsFromPxp(newPxp)
    const newSuccsSet = new Set(newRels.map(r => r.succ))
    relationsRef.current = newRels
    resourcesRef.current = parseResourcesFromPxp(newPxp)

    const existingMap = new Map<string, ActivityMin>(activitiesRef.current.map(a => [a.id, a]))
    let activities = parseActivitiesFromPxp(newPxp, existingMap)
    let pxpFixed = newPxp
    activities = activities.map(a => {
      if (prevSuccsSet.has(a.id) && !newSuccsSet.has(a.id) && a.constraint_es == null) {
        pxpFixed = pxpSetActivityField(pxpFixed, a.id, 6, '0')
        return { ...a, constraint_es: 0 }
      }
      return a
    })
    pxpTextRef.current = pxpFixed
    metaRef.current = parseMetaFromPxp(pxpFixed)
    activitiesRef.current = activities

    const result = await _run(activities)
    if (!result) return
    _apply(activities, result, pxpFixed, [])
  }, [_run, _apply])

  const addActivity = useCallback(async (afterId: string | null) => {
    const acts = activitiesRef.current
    const newId = 'A' + String(Date.now()).slice(-5)
    const newAct: ActivityMin = {
      id: newId, name: 'Новая работа ' + newId, duration: 5,
      constraint_es: null, actual_start: null, actual_finish: null,
      pct_complete: 0, actual_duration: null, remaining_duration: null,
      parent_id: null, act_type: 'task_dependent',
    }
    const newLine = '  ' + newId + ' | ' + newAct.name + ' | 5 | task_dependent |  |  |  |  |  |  | 0 | 0 |  |  | '
    const pxpLines = pxpTextRef.current.split('\n')
    const out: string[] = []
    let inAct = false, inserted = false
    for (const line of pxpLines) {
      const t = line.trim()
      if (t === '@ACTIVITIES') { inAct = true; out.push(line); continue }
      if (inAct && t.startsWith('@')) {
        if (!inserted) { out.push(newLine); inserted = true }
        inAct = false; out.push(line); continue
      }
      out.push(line)
      if (inAct && !inserted && afterId && t.split('|')[0]?.trim() === afterId) {
        out.push(newLine); inserted = true
      }
    }
    if (!inserted) out.push(newLine)
    pxpTextRef.current = out.join('\n')

    const idx = afterId ? acts.findIndex(a => a.id === afterId) : -1
    activitiesRef.current = idx >= 0
      ? [...acts.slice(0, idx + 1), newAct, ...acts.slice(idx + 1)]
      : [...acts, newAct]

    setState(s => ({ ...s, loading: true }))
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const removeActivity = useCallback(async (actId: string) => {
    let inAct = false, inRel = false, inAsgn = false
    pxpTextRef.current = pxpTextRef.current.split('\n').filter(line => {
      const t = line.trim()
      if (t === '@ACTIVITIES') { inAct = true; inRel = false; inAsgn = false; return true }
      if (t === '@RELATIONS') { inRel = true; inAct = false; inAsgn = false; return true }
      if (t === '@ASSIGNMENTS') { inAsgn = true; inAct = false; inRel = false;  return true }
      if (t.startsWith('@')) { inAct = false; inRel = false; inAsgn = false; return true }
      if (!t || t.startsWith('#')) return true
      const parts = t.split('|').map(s => s.trim())
      if (inAct && parts[0] === actId) return false
      if (inRel && (parts[0] === actId || parts[1] === actId)) return false
      if (inAsgn && parts[0] === actId) return false
      return true
    }).join('\n')

    activitiesRef.current = activitiesRef.current.filter(a => a.id !== actId)
    relationsRef.current = relationsRef.current.filter(r => r.pred !== actId && r.succ !== actId)

    setState(s => ({ ...s, loading: true }))
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const reorderActivity = useCallback(async (actId: string, direction: 'up' | 'down' | 'left' | 'right') => {
    const acts = activitiesRef.current
    const idx = acts.findIndex(a => a.id === actId)
    if (idx < 0) return
    const updated = [...acts]
    if (direction === 'up' && idx > 0) {
      [updated[idx - 1], updated[idx]] = [updated[idx], updated[idx - 1]]
    } else if (direction === 'down' && idx < acts.length - 1) {
      [updated[idx], updated[idx + 1]] = [updated[idx + 1], updated[idx]]
    } else if (direction === 'right' && idx > 0) {
      updated[idx] = { ...updated[idx], parent_id: updated[idx - 1].id }
      pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, 5, updated[idx - 1].id)
    } else if (direction === 'left' && updated[idx].parent_id) {
      const gp = acts.find(a => a.id === updated[idx].parent_id)?.parent_id ?? null
      updated[idx] = { ...updated[idx], parent_id: gp }
      pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, 5, gp ?? '')
    }

    const orderMap = new Map(updated.map((a, i) => [a.id, i]))
    const pxpLines = pxpTextRef.current.split('\n')
    const actLines: Array<{ id: string; line: string }> = []
    const out: string[] = []
    let inActSort = false
    for (const line of pxpLines) {
      const t = line.trim()
      if (t === '@ACTIVITIES') { inActSort = true; out.push(line); continue }
      if (inActSort && t.startsWith('@')) {
        actLines.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999))
        for (const al of actLines) out.push(al.line)
        inActSort = false; out.push(line); continue
      }
      if (inActSort && t && !t.startsWith('#')) {
        const id = t.split('|')[0]?.trim()
        if (id) { actLines.push({ id, line }); continue }
      }
      out.push(line)
    }
    if (inActSort) {
      actLines.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999))
      for (const al of actLines) out.push(al.line)
    }
    pxpTextRef.current = out.join('\n')
    activitiesRef.current = updated

    setState(s => ({ ...s, loading: true }))
    const result = await _run(updated)
    if (!result) return
    _apply(updated, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const renameActivity = useCallback(async (actId: string, newName: string) => {
    pxpTextRef.current = pxpSetActivityField(pxpTextRef.current, actId, 1, newName)
    activitiesRef.current = activitiesRef.current.map(a =>
      a.id === actId ? { ...a, name: newName } : a
    )
    setState(s => ({ ...s, loading: true }))
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const addResource = useCallback(async (resId: string, name: string, maxUnits: number, costPerUnit: number) => {
    pxpTextRef.current = pxpAddResource(pxpTextRef.current, resId, name, maxUnits, costPerUnit)
    resourcesRef.current = [...resourcesRef.current, { id: resId, name, max_units: maxUnits, cost_per_unit: costPerUnit }]
    setState(s => ({ ...s, loading: true }))
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const removeResource = useCallback(async (resId: string) => {
    pxpTextRef.current = pxpRemoveResource(pxpTextRef.current, resId)
    pxpTextRef.current = pxpRemoveResourceAssignments(pxpTextRef.current, resId)
    resourcesRef.current = resourcesRef.current.filter(r => r.id !== resId)
    assignmentsRef.current = parseAssignmentsFromPxp(pxpTextRef.current)
    setState(s => ({ ...s, loading: true }))
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const updateResource = useCallback(async (resId: string, name: string, maxUnits: number, costPerUnit: number) => {
    pxpTextRef.current = pxpUpdateResource(pxpTextRef.current, resId, name, maxUnits, costPerUnit)
    resourcesRef.current = resourcesRef.current.map(r =>
      r.id === resId ? { ...r, name, max_units: maxUnits, cost_per_unit: costPerUnit } : r
    )
    setState(s => ({ ...s, loading: true }))
    const result = await _run(activitiesRef.current)
    if (!result) return
    _apply(activitiesRef.current, result, pxpTextRef.current, [])
  }, [_run, _apply])

  const fetchDetail = useCallback(async (actId: string) => {
    return fetchActivityDetail(pxpTextRef.current, actId)
  }, [])

  const getPxpText = useCallback(() => pxpTextRef.current, [])

  return {
    state, loadFile, recalculate, levelResourcesAction,
    renameActivity,
    moveActivity, addRelation, updateActivityField, applyPxpText,
    addActivity, removeActivity, reorderActivity,
    fetchDetail, getPxpText, addResource, removeResource, updateResource,
  }
}
