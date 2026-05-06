import type { AssignmentOut, RelationOut } from '../types'

function ensureParts(parts: string[], minLen: number): string[] {
  const p = [...parts]
  while (p.length < minLen) p.push('')
  return p
}

// ACTIVITIES
// Индексы полей в строке @ACTIVITIES:
// 0=id | 1=name | 2=duration | 3=type | 4=cal_id | 5=parent_id/wbs_id |
// 6=constraint_es | 7=constraint_type | 8=actual_start | 9=actual_finish |
// 10=pct_complete | 11=priority | 12=notes | 13=actual_duration | 14=remaining_duration

export function getActivityField(pxp: string, actId: string, fieldIdx: number): string {
  const lines = pxp.split('\n')
  let inSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@ACTIVITIES') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === actId) return parts.length > fieldIdx ? parts[fieldIdx] : ''
  }
  return ''
}

export function setActivityField(pxp: string, actId: string, fieldIdx: number, value: string): string {
  const lines = pxp.split('\n')
  let inSection = false
  return lines.map(line => {
    const trimmed = line.trim()
    if (trimmed === '@ACTIVITIES') { inSection = true; return line }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return line }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return line
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === actId) {
      const p = ensureParts(parts, fieldIdx + 1)
      p[fieldIdx] = value
      return p.join(' | ')
    }
    return line
  }).join('\n')
}

export function setActivityDuration(pxp: string, actId: string, duration: number): string {
  return setActivityField(pxp, actId, 2, String(duration))
}

export function setActivityConstraint(pxp: string, actId: string, days: number): string {
  return setActivityField(pxp, actId, 6, String(days))
}

export function clearActivityConstraint(pxp: string, actId: string): string {
  return setActivityField(pxp, actId, 6, '')
}

export function setActivityActualStart(pxp: string, actId: string, value: string | null): string {
  return setActivityField(pxp, actId, 8, value ?? '')
}

export function setActivityActualFinish(pxp: string, actId: string, value: string | null): string {
  return setActivityField(pxp, actId, 9, value ?? '')
}

export function setActivityPctComplete(pxp: string, actId: string, value: number): string {
  return setActivityField(pxp, actId, 10, String(value))
}

export function setActivityActualDuration(pxp: string, actId: string, value: number | null): string {
  return setActivityField(pxp, actId, 13, value !== null ? String(value) : '')
}

export function setActivityRemainingDuration(pxp: string, actId: string, value: number | null): string {
  return setActivityField(pxp, actId, 14, value !== null ? String(value) : '')
}

export function getActivityExtra(pxp: string, actId: string): {
  actualDuration: number | null
  remainingDuration: number | null
} {
  const ad = getActivityField(pxp, actId, 13)
  const rd = getActivityField(pxp, actId, 14)
  return {
    actualDuration: ad ? parseFloat(ad) || null : null,
    remainingDuration: rd ? parseFloat(rd) || null : null,
  }
}

export function getAllActivitiesExtra(pxp: string): Map<string, {
  actualDuration: number | null
  remainingDuration: number | null
}> {
  const lines = pxp.split('\n')
  let inSection = false
  const result = new Map<string, { actualDuration: number | null; remainingDuration: number | null }>()
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@ACTIVITIES') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0]) {
      const ad = parts.length > 13 ? parts[13] : ''
      const rd = parts.length > 14 ? parts[14] : ''
      result.set(parts[0], {
        actualDuration: ad ? parseFloat(ad) || null : null,
        remainingDuration: rd ? parseFloat(rd) || null : null,
      })
    }
  }
  return result
}

// Определение завершённых и начатых работ по PXP-тексту

// Работы, отображаемые как завершённые в UI (приглушённые, галочка)
export function parseCompletedIds(pxp: string): Set<string> {
  const ids = new Set<string>()
  const lines = pxp.split('\n')
  let inSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@ACTIVITIES') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (!parts[0]) continue
    const pct = parts.length > 10 ? parts[10] : ''
    const af  = parts.length > 9  ? parts[9]  : ''
    const ad  = parts.length > 13 ? parts[13] : ''
    const rd  = parts.length > 14 ? parts[14] : ''
    const done =
      (pct !== '' && parseFloat(pct) >= 100) ||
      af !== '' ||
      (ad !== '' && parseFloat(ad) > 0 && (rd === '' || parseFloat(rd) === 0))
    if (done) ids.add(parts[0])
  }
  return ids
}

/** Работы, заблокированные от сдвига при выравнивании:
 * завершённые ИЛИ начатые (есть actual_start).
 * Бэкенд тоже проверяет это, но дублируем на фронте,
 * чтобы не давать перетаскивать такие работы */
export function parseLockedIds(pxp: string): Set<string> {
  const ids = new Set<string>()
  const lines = pxp.split('\n')
  let inSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@ACTIVITIES') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (!parts[0]) continue
    const pct = parts.length > 10 ? parts[10] : ''
    const as_ = parts.length > 8  ? parts[8]  : ''  // actual_start
    const af  = parts.length > 9  ? parts[9]  : ''  // actual_finish
    const ad  = parts.length > 13 ? parts[13] : ''
    const rd  = parts.length > 14 ? parts[14] : ''
    const completed =
      (pct !== '' && parseFloat(pct) >= 100) ||
      af !== '' ||
      (ad !== '' && parseFloat(ad) > 0 && (rd === '' || parseFloat(rd) === 0))
    const started = as_ !== ''
    if (completed || started) ids.add(parts[0])
  }
  return ids
}

/** Блокировка начатых/завершённых работ перед пересчётом.
 * Ставит constraint_es на текущий ES, чтобы работа не уходила левее.
 * Если constraint уже строже - не трогаем */
export function lockCompletedActivities(
  pxp: string,
  activities: { id: string; es_date: string }[],
  startDate: string
): string {
  const lockedIds = parseLockedIds(pxp)
  if (lockedIds.size === 0) return pxp

  const actMap = new Map(activities.map(a => [a.id, a]))
  let modified = pxp

  for (const actId of lockedIds) {
    const act = actMap.get(actId)
    if (!act) continue
    const esDays = Math.round(
      (new Date(act.es_date).getTime() - new Date(startDate).getTime()) / 86400000
    )
    const existing = getActivityField(modified, actId, 6)
    if (existing) {
      const existingDays = parseInt(existing)
      if (!isNaN(existingDays) && existingDays >= esDays) continue
    }
    modified = setActivityConstraint(modified, actId, esDays)
  }
  return modified
}

// ASSIGNMENTS
// Индексы полей в строке @ASSIGNMENTS:
// 0=activity | 1=resource | 2=role | 3=units | 4=budget |
// 5=actual_qty | 6=rate_type | 7=remaining_qty
// Старый формат (без role/budget): 0=activity | 1=resource | 2=units
// Для совместимости определяем формат динамически

function detectAssignmentFormat(parts: string[]): 'new' | 'old' {
  // Если 3+ частей и parts[2] выглядит как число - старый формат (act|res|units)
  // Если parts[2] - строка (role id) или пустая - новый формат
  if (parts.length <= 3) return 'old'
  const third = parts[2]
  // Если третье поле - число, скорее всего старый формат
  if (third === '' || isNaN(parseFloat(third))) return 'new'
  // Если четвёртое поле тоже число - новый (act|res|role|units)
  if (parts.length > 3 && parts[3] !== '' && !isNaN(parseFloat(parts[3]))) return 'new'
  return 'old'
}

export function getAssignmentsForActivity(
  pxp: string, actId: string, resources: { id: string; name: string }[]
): AssignmentOut[] {
  const lines = pxp.split('\n')
  let inSection = false
  const resMap = new Map(resources.map(r => [r.id, r.name]))
  const result: AssignmentOut[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@ASSIGNMENTS') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] !== actId || !parts[1]) continue

    const fmt = detectAssignmentFormat(parts)
    let units: number
    let actual_qty: number | null = null
    let remaining_qty: number | null = null

    if (fmt === 'new') {
      // 0=act | 1=res | 2=role | 3=units | 4=budget | 5=actual_qty | 6=rate_type | 7=remaining_qty
      units = parseFloat(parts[3] || '0') || 0
      if (parts.length > 5 && parts[5]) actual_qty = parseFloat(parts[5]) || null
      if (parts.length > 7 && parts[7]) remaining_qty = parseFloat(parts[7]) || null
    } else {
      // 0=act | 1=res | 2=units  (старый компактный формат)
      units = parseFloat(parts[2] || '0') || 0
    }

    result.push({
      resource_id: parts[1],
      resource_name: resMap.get(parts[1]) || parts[1],
      planned_units: units,
      actual_qty,
      remaining_qty,
    })
  }
  return result
}

export function setAssignmentField(
  pxp: string, actId: string, resId: string, fieldIdx: number, value: string
): string {
  const lines = pxp.split('\n')
  let inSection = false
  return lines.map(line => {
    const trimmed = line.trim()
    if (trimmed === '@ASSIGNMENTS') { inSection = true; return line }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return line }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return line
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === actId && parts[1] === resId) {
      const p = ensureParts(parts, fieldIdx + 1)
      p[fieldIdx] = value
      return p.join(' | ')
    }
    return line
  }).join('\n')
}

// units - поле 3 в новом формате, поле 2 в старом.
// Определяем по структуре строки
export function setAssignmentUnits(pxp: string, actId: string, resId: string, units: number): string {
  const lines = pxp.split('\n')
  let inSection = false
  let fieldIdx = 3
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@ASSIGNMENTS') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === actId && parts[1] === resId) {
      fieldIdx = detectAssignmentFormat(parts) === 'new' ? 3 : 2
      break
    }
  }
  return setAssignmentField(pxp, actId, resId, fieldIdx, String(units))
}

export function setAssignmentActual(pxp: string, actId: string, resId: string, value: number | null): string {
  return setAssignmentField(pxp, actId, resId, 5, value !== null ? String(value) : '')
}

export function setAssignmentRemaining(pxp: string, actId: string, resId: string, value: number | null): string {
  return setAssignmentField(pxp, actId, resId, 7, value !== null ? String(value) : '')
}

export function addAssignment(pxp: string, actId: string, resId: string, units: number): string {
  const lines = pxp.split('\n')
  // Новый формат: act | res | role | units | budget | actual_qty | rate_type | remaining_qty
  const newLine = `  ${actId} | ${resId} |  | ${units} |  |  |  | `
  const result: string[] = []
  let inserted = false
  for (const line of lines) {
    result.push(line)
    if (line.trim() === '@ASSIGNMENTS' && !inserted) {
      inserted = true
      result.push(newLine)
    }
  }
  if (!inserted) { result.push('@ASSIGNMENTS'); result.push(newLine) }
  return result.join('\n')
}

export function removeAssignment(pxp: string, actId: string, resId: string): string {
  const lines = pxp.split('\n')
  let inSection = false
  return lines.filter(line => {
    const trimmed = line.trim()
    if (trimmed === '@ASSIGNMENTS') { inSection = true; return true }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return true }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return true
    const parts = trimmed.split('|').map(s => s.trim())
    return !(parts[0] === actId && parts[1] === resId)
  }).join('\n')
}

// RELATIONS

export function getAllRelations(pxp: string): RelationOut[] {
  const lines = pxp.split('\n')
  let inSection = false
  const result: RelationOut[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts.length >= 2 && parts[0] && parts[1]) {
      result.push({
        pred: parts[0], succ: parts[1],
        type: (parts[2] || 'FS').trim(),
        lag: parseFloat(parts[3]) || 0,
      })
    }
  }
  return result
}

export function getRelationsForActivity(
  pxp: string, actId: string
): { asPred: RelationOut[]; asSucc: RelationOut[] } {
  const all = getAllRelations(pxp)
  return {
    asPred: all.filter(r => r.pred === actId),
    asSucc: all.filter(r => r.succ === actId),
  }
}

export function addRelation(
  pxp: string, predId: string, succId: string, type: string, lag: number
): string {
  const lines = pxp.split('\n')
  const newLine = `  ${predId} | ${succId} | ${type} | ${lag}`
  const result: string[] = []
  let inserted = false
  for (const line of lines) {
    result.push(line)
    if (line.trim() === '@RELATIONS' && !inserted) {
      inserted = true
      result.push(newLine)
    }
  }
  if (!inserted) { result.push('@RELATIONS'); result.push(newLine) }
  return result.join('\n')
}

export function removeRelation(pxp: string, predId: string, succId: string): string {
  const lines = pxp.split('\n')
  let inSection = false
  return lines.filter(line => {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; return true }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return true }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return true
    const parts = trimmed.split('|').map(s => s.trim())
    return !(parts[0] === predId && parts[1] === succId)
  }).join('\n')
}

export function updateRelationType(
  pxp: string, predId: string, succId: string, newType: string
): string {
  const lines = pxp.split('\n')
  let inSection = false
  return lines.map(line => {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; return line }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return line }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return line
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === predId && parts[1] === succId) {
      const p = ensureParts(parts, 4); p[2] = newType; return p.join(' | ')
    }
    return line
  }).join('\n')
}

export function updateRelationLag(
  pxp: string, predId: string, succId: string, newLag: number
): string {
  const lines = pxp.split('\n')
  let inSection = false
  return lines.map(line => {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; return line }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return line }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return line
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === predId && parts[1] === succId) {
      const p = ensureParts(parts, 4); p[3] = String(newLag); return p.join(' | ')
    }
    return line
  }).join('\n')
}
