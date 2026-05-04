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

export interface ActivityOut {
  id: string
  name: string
  duration: number
  es_date: string
  ef_date: string
  ls_date: string
  lf_date: string
  tf: number
  ff: number
  on_critical: boolean
  parent_id?: string | null
  constraint_es?: number | null
  wbs_id?: string | null
  activity_type?: string
  duration_type?: string
  constraint_type?: string
  constraint_date?: string | null
  actual_start?: string | null
  actual_finish?: string | null
  percent_complete?: number
  priority?: number
  notes?: string
  udf_values?: Record<string, string | number | null>
  actual_duration?: number | null
  remaining_duration?: number | null
}

export interface ResourceOut {
  id: string
  name: string
  max_units: number
  cost_per_unit?: number
}

export interface ProjectData {
  project_id: string
  project_name: string
  start_date: string
  finish_date?: string
  duration_days: number
  activities: ActivityOut[]
  resources: ResourceOut[]
  resource_load: Record<string, number[]>
  wbs: WBSNode[]
  pxp_text: string
}

export interface ScheduleResult {
  projects: ProjectData[]
  active_project_idx: number
  warnings: string[]
}