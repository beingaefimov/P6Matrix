import axios from 'axios'
import type { ScheduleResult } from '../types'

const BASE = '/api'

// Нормализация ответа бэкенда: формат плоский в мультипроектный.
// Бэкенд может вернуть как формат с полями project_id/activities/...,
// так и формат с массивом projects. Это приводит всё к одному формату
function normalizeResult(raw: any): ScheduleResult {
  if (raw.projects && Array.isArray(raw.projects) && raw.projects.length > 0) {
    return raw as ScheduleResult
  }
  return {
    projects: [{
      project_id: raw.project_id || '',
      project_name: raw.project_name || '',
      start_date: raw.start_date || '',
      finish_date: raw.finish_date,
      duration_days: raw.duration_days || 0,
      activities: raw.activities || [],
      resources: raw.resources || [],
      resource_load: raw.resource_load || {},
      wbs: raw.wbs || [],
      pxp_text: raw.pxp_text || '',
    }],
    active_project_idx: 0,
    warnings: raw.warnings || [],
  }
}

export async function uploadFile(
  file: File,
  level = false
): Promise<ScheduleResult> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await axios.post(`${BASE}/upload?level=${level}`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return normalizeResult(data)
}

export async function scheduleProject(
  pxp_text: string,
  level_within_float_only = true,
  max_overload_pct = 100
): Promise<ScheduleResult> {
  const { data } = await axios.post(`${BASE}/schedule`, {
    pxp_text,
    level_within_float_only,
    max_overload_pct,
  })
  return normalizeResult(data)
}

export async function levelResources(
  pxp_text: string,
  level_within_float_only = true,
  max_overload_pct = 100
): Promise<ScheduleResult> {
  const { data } = await axios.post(`${BASE}/level`, {
    pxp_text,
    level_within_float_only,
    max_overload_pct,
  })
  return normalizeResult(data)
}