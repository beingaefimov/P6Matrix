import type { AssignmentOut, RelationOut } from '../types'

function ensureParts(parts: string[], minLen: number): string[] {
  const p = [...parts]
  while (p.length < minLen) p.push('')
  return p
}

// ACTIVITIES
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

// ID выполненных работ - для UI-отображения (приглушённые бары, галочка)
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
    const af = parts.length > 9 ? parts[9] : ''
    const ad = parts.length > 13 ? parts[13] : ''
    const rd = parts.length > 14 ? parts[14] : ''
    const done =
      (pct !== '' && parseFloat(pct) >= 100) ||
      af !== '' ||
      (ad !== '' && parseFloat(ad) > 0 && (rd === '' || parseFloat(rd) === 0))
    if (done) ids.add(parts[0])
  }
  return ids
}

// ID работ, которые не могут сдвигаться при выравнивании:
// завершённые или начатые (есть actual_start)
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
    const as = parts.length > 8 ? parts[8] : '' // actual_start
    const af = parts.length > 9 ? parts[9] : '' // actual_finish
    const ad = parts.length > 13 ? parts[13] : '' // actual_duration
    const rd = parts.length > 14 ? parts[14] : '' // remaining_duration
    const completed =
      (pct !== '' && parseFloat(pct) >= 100) ||
      af !== '' ||
      (ad !== '' && parseFloat(ad) > 0 && (rd === '' || parseFloat(rd) === 0))
    const started = as !== ''
    if (completed || started) ids.add(parts[0])
  }
  return ids
}

// Блокировка выполненных и начатых работ перед пересчётом/выравниванием.
// Ставит ограничение (constraint) на текущий ES, чтобы работа не могла
// сдвинуться назад. Если уже есть constraint — берём максимум из
// существующего и текущего ES
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
      // Если существующий constraint уже не слабее текущего ES — не трогаем
      if (!isNaN(existingDays) && existingDays >= esDays) continue
    }
    // Иначе ставим constraint на текущий ES (или более строгий)
    modified = setActivityConstraint(modified, actId, esDays)
  }
  return modified
}

// ASSIGNMENTS
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
    if (parts[0] === actId && parts[1]) {
      const p = ensureParts(parts, 8)
      result.push({
        resource_id: p[1], resource_name: resMap.get(p[1]) || p[1],
        planned_units: parseFloat(p[3]) || 0,
        actual_qty: p[5] ? parseFloat(p[5]) || null : null,
        remaining_qty: p[7] ? parseFloat(p[7]) || null : null,
      })
    }
  }
  return result
}

export function setAssignmentField(pxp: string, actId: string, resId: string, fieldIdx: number, value: string): string {
  const lines = pxp.split('\n'); let inSection = false
  return lines.map(line => {
    const trimmed = line.trim()
    if (trimmed === '@ASSIGNMENTS') { inSection = true; return line }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return line }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return line
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === actId && parts[1] === resId) { const p = ensureParts(parts, fieldIdx + 1); p[fieldIdx] = value; return p.join(' | ') }
    return line
  }).join('\n')
}

export function setAssignmentUnits(pxp: string, actId: string, resId: string, units: number): string { return setAssignmentField(pxp, actId, resId, 3, String(units)) }
export function setAssignmentActual(pxp: string, actId: string, resId: string, value: number | null): string { return setAssignmentField(pxp, actId, resId, 5, value !== null ? String(value) : '') }
export function setAssignmentRemaining(pxp: string, actId: string, resId: string, value: number | null): string { return setAssignmentField(pxp, actId, resId, 7, value !== null ? String(value) : '') }

export function addAssignment(pxp: string, actId: string, resId: string, units: number): string {
  const lines = pxp.split('\n'); const newLine = `  ${actId} | ${resId} |  | ${units} |  |  |  | `
  const result: string[] = []; let inserted = false
  for (const line of lines) { result.push(line); if (line.trim() === '@ASSIGNMENTS' && !inserted) { inserted = true; result.push(newLine) } }
  if (!inserted) { result.push('@ASSIGNMENTS'); result.push(newLine) }
  return result.join('\n')
}

export function removeAssignment(pxp: string, actId: string, resId: string): string {
  const lines = pxp.split('\n'); let inSection = false
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
  const lines = pxp.split('\n'); let inSection = false; const result: RelationOut[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; continue }
    if (inSection && trimmed.startsWith('@')) break
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts.length >= 2 && parts[0] && parts[1]) result.push({ pred: parts[0], succ: parts[1], type: (parts[2] || 'FS').trim(), lag: parseFloat(parts[3]) || 0 })
  }
  return result
}

export function getRelationsForActivity(pxp: string, actId: string): { asPred: RelationOut[]; asSucc: RelationOut[] } {
  const all = getAllRelations(pxp)
  return { asPred: all.filter(r => r.pred === actId), asSucc: all.filter(r => r.succ === actId) }
}

export function addRelation(pxp: string, predId: string, succId: string, type: string, lag: number): string {
  const lines = pxp.split('\n'); const newLine = `  ${predId} | ${succId} | ${type} | ${lag} |  | `
  const result: string[] = []; let inserted = false
  for (const line of lines) { result.push(line); if (line.trim() === '@RELATIONS' && !inserted) { inserted = true; result.push(newLine) } }
  if (!inserted) { result.push('@RELATIONS'); result.push(newLine) }
  return result.join('\n')
}

export function removeRelation(pxp: string, predId: string, succId: string): string {
  const lines = pxp.split('\n'); let inSection = false
  return lines.filter(line => {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; return true }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return true }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return true
    const parts = trimmed.split('|').map(s => s.trim())
    return !(parts[0] === predId && parts[1] === succId)
  }).join('\n')
}

export function updateRelationType(pxp: string, predId: string, succId: string, newType: string): string {
  const lines = pxp.split('\n'); let inSection = false
  return lines.map(line => {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; return line }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return line }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return line
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === predId && parts[1] === succId) { const p = ensureParts(parts, 4); p[2] = newType; return p.join(' | ') }
    return line
  }).join('\n')
}

export function updateRelationLag(pxp: string, predId: string, succId: string, newLag: number): string {
  const lines = pxp.split('\n'); let inSection = false
  return lines.map(line => {
    const trimmed = line.trim()
    if (trimmed === '@RELATIONS') { inSection = true; return line }
    if (inSection && trimmed.startsWith('@')) { inSection = false; return line }
    if (!inSection || trimmed.startsWith('#') || !trimmed) return line
    const parts = trimmed.split('|').map(s => s.trim())
    if (parts[0] === predId && parts[1] === succId) { const p = ensureParts(parts, 4); p[3] = String(newLag); return p.join(' | ') }
    return line
  }).join('\n')
}