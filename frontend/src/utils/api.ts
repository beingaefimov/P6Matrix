/** Только два реальных запроса к бэкенду:
 * 1. uploadFileRaw - загрузка файла, парсинг, минимальные данные
 * 2. fetchActivityDetail - lazy-загрузка деталей задачи при клике.
 * Все расчёты (CPM, leveling) происходят на клиенте в cpmEngine.ts */

import axios from 'axios'
import type { ActivityMin, Relation, Resource, Assignment } from '../engine/cpmEngine'

const BASE = '/api'

export interface RawProjectData {
  project: {
    project_id: string
    project_name: string
    start_date: string
    data_date: string
    must_finish: string
    calendar: string
    duration_unit: string
  }
  activities: ActivityMin[]
  relations: Relation[]
  resources: Resource[]
  assignments: Assignment[]
  pxp_text: string
  warnings: string[]
}

// Загружает файл, возвращает минимальные данные для клиентского движка
export async function uploadFileRaw(file: File): Promise<RawProjectData> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await axios.post<RawProjectData>(`${BASE}/upload`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}

export interface ActivityDetail {
  id: string
  name: string
  duration: number
  act_type: string
  cal_id: string
  parent_id: string | null
  constraint_es: number | null
  constraint_type: string
  actual_start: string | null
  actual_finish: string | null
  pct_complete: number
  priority: number
  notes: string
  actual_duration: number | null
  remaining_duration: number | null
  assignments: Array<{
    resource_id: string
    units: number
    actual_qty: number | null
    remaining_qty: number | null
  }>
  predecessors: Array<{ pred: string; type: string; lag: number }>
  successors: Array<{ succ: string; type: string; lag: number }>
}

// Lazy-загрузка деталей задачи - только при клике.
// Не вызывается при загрузке файла или интерактивных операциях
export async function fetchActivityDetail(pxpText: string, activityId: string): Promise<ActivityDetail> {
  const { data } = await axios.post<ActivityDetail>(`${BASE}/activity/detail`, {
    pxp_text: pxpText,
    activity_id: activityId,
  })
  return data
}
