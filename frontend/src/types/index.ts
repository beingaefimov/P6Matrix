/** ActivityDisplay - основной тип задачи, приходит из useScheduler
 * (содержит результаты CPM: es_date, ef_date, tf, ff, on_critical и т.д).
 * Для обратной совместимости с компонентами экспортируем ActivityOut = ActivityDisplay */

export type { ActivityDisplay as ActivityOut } from '../engine/useScheduler'

export interface WBSNode {
  id: string
  name: string
  code?: string
  parent_id?: string | null
}

export interface AssignmentOut {
  resource_id: string
  resource_name: string
  planned_units: number
  actual_qty: number | null
  remaining_qty: number | null
}

export interface RelationOut {
  pred: string
  succ: string
  type: string
  lag: number
}

export interface ResourceOut {
  id: string
  name: string
  max_units: number
  cost_per_unit?: number
}

// ProjectData и ScheduleResult больше не используются напрямую -
// состояние проекта живёт в useScheduler.ProjectState
// Оставляем для совместимости если где-то ещё есть импорт
export interface ProjectData {
  project_id: string
  project_name: string
  start_date: string
  finish_date?: string
  duration_days: number
  activities: import('../engine/useScheduler').ActivityDisplay[]
  resources: ResourceOut[]
  resource_load: Record<string, number[]>
  wbs: WBSNode[]
  pxp_text: string
}
