/** Мутации PXP-текста - функции без сетевых запросов.
 * После мутации текста useScheduler запускает CPM на клиенте */

function ensureParts(parts: string[], minLen: number): string[] {
  const p = [...parts]
  while (p.length < minLen) p.push('')
  return p
}

// Activities

export function pxpGetActivityField(pxp: string, actId: string, fieldIdx: number): string {
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('@')) continue
    const parts = t.split('|').map(s => s.trim())
    if (parts[0] === actId) return parts[fieldIdx] ?? ''
  }
  return ''
}

export function pxpSetActivityField(pxp: string, actId: string, fieldIdx: number, value: string): string {
  let inSection = false
  return pxp.split('\n').map(line => {
    const t = line.trim()
    if (t === '@ACTIVITIES') { inSection = true; return line }
    if (inSection && t.startsWith('@')) { inSection = false; return line }
    if (!inSection || t.startsWith('#') || !t) return line
    const parts = t.split('|').map(s => s.trim())
    if (parts[0] !== actId) return line
    const p = ensureParts(parts, fieldIdx + 1)
    p[fieldIdx] = value
    return p.join(' | ')
  }).join('\n')
}

export function pxpSetConstraint(pxp: string, actId: string, days: number): string {
  return pxpSetActivityField(pxp, actId, 6, String(Math.round(days)))
}

export function pxpClearConstraint(pxp: string, actId: string): string {
  return pxpSetActivityField(pxp, actId, 6, '')
}

// Relations 

export function pxpAddRelation(pxp: string, predId: string, succId: string, type: string, lag: number): string {
  const newLine = `  ${predId} | ${succId} | ${type} | ${lag}`
  const lines = pxp.split('\n')
  const result: string[] = []
  let inserted = false
  for (const line of lines) {
    result.push(line)
    if (line.trim() === '@RELATIONS' && !inserted) { inserted = true; result.push(newLine) }
  }
  if (!inserted) { result.push('@RELATIONS'); result.push(newLine) }
  return result.join('\n')
}

export function pxpRemoveRelation(pxp: string, predId: string, succId: string): string {
  let inSection = false
  return pxp.split('\n').filter(line => {
    const t = line.trim()
    if (t === '@RELATIONS') { inSection = true; return true }
    if (inSection && t.startsWith('@')) { inSection = false; return true }
    if (!inSection || t.startsWith('#') || !t) return true
    const parts = t.split('|').map(s => s.trim())
    return !(parts[0] === predId && parts[1] === succId)
  }).join('\n')
}

export function pxpUpdateRelationType(pxp: string, predId: string, succId: string, newType: string): string {
  let inSection = false
  return pxp.split('\n').map(line => {
    const t = line.trim()
    if (t === '@RELATIONS') { inSection = true; return line }
    if (inSection && t.startsWith('@')) { inSection = false; return line }
    if (!inSection || t.startsWith('#') || !t) return line
    const parts = t.split('|').map(s => s.trim())
    if (parts[0] === predId && parts[1] === succId) {
      const p = ensureParts(parts, 4); p[2] = newType; return p.join(' | ')
    }
    return line
  }).join('\n')
}

export function pxpUpdateRelationLag(pxp: string, predId: string, succId: string, lag: number): string {
  let inSection = false
  return pxp.split('\n').map(line => {
    const t = line.trim()
    if (t === '@RELATIONS') { inSection = true; return line }
    if (inSection && t.startsWith('@')) { inSection = false; return line }
    if (!inSection || t.startsWith('#') || !t) return line
    const parts = t.split('|').map(s => s.trim())
    if (parts[0] === predId && parts[1] === succId) {
      const p = ensureParts(parts, 4); p[3] = String(lag); return p.join(' | ')
    }
    return line
  }).join('\n')
}

// Assignments

export function pxpAddAssignment(pxp: string, actId: string, resId: string, units: number): string {
  const newLine = `  ${actId} | ${resId} |  | ${units} |  |  |  | `
  const lines = pxp.split('\n'); const result: string[] = []; let inserted = false
  for (const line of lines) {
    result.push(line)
    if (line.trim() === '@ASSIGNMENTS' && !inserted) { inserted = true; result.push(newLine) }
  }
  if (!inserted) { result.push('@ASSIGNMENTS'); result.push(newLine) }
  return result.join('\n')
}

export function pxpRemoveAssignment(pxp: string, actId: string, resId: string): string {
  let inSection = false
  return pxp.split('\n').filter(line => {
    const t = line.trim()
    if (t === '@ASSIGNMENTS') { inSection = true; return true }
    if (inSection && t.startsWith('@')) { inSection = false; return true }
    if (!inSection || t.startsWith('#') || !t) return true
    const parts = t.split('|').map(s => s.trim())
    return !(parts[0] === actId && parts[1] === resId)
  }).join('\n')
}

export function pxpSetAssignmentField(pxp: string, actId: string, resId: string, fieldIdx: number, value: string): string {
  let inSection = false
  return pxp.split('\n').map(line => {
    const t = line.trim()
    if (t === '@ASSIGNMENTS') { inSection = true; return line }
    if (inSection && t.startsWith('@')) { inSection = false; return line }
    if (!inSection || t.startsWith('#') || !t) return line
    const parts = t.split('|').map(s => s.trim())
    if (parts[0] === actId && parts[1] === resId) {
      const p = ensureParts(parts, fieldIdx + 1); p[fieldIdx] = value; return p.join(' | ')
    }
    return line
  }).join('\n')
}

// Locked detection (для UI - не трогаем заблокированных)

export function pxpParseLockedIds(pxp: string): Set<string> {
  const ids = new Set<string>()
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@ACTIVITIES') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || t.startsWith('#') || !t) continue
    const parts = t.split('|').map(s => s.trim())
    if (!parts[0]) continue
    const pct = parts[10] ?? '', as_ = parts[8] ?? '', af = parts[9] ?? ''
    const ad = parts[13] ?? '', rd = parts[14] ?? ''
    const completed = (pct && parseFloat(pct) >= 100) || af !== '' ||
      (ad && parseFloat(ad) > 0 && (!rd || parseFloat(rd) === 0))
    const started = as_ !== ''
    if (completed || started) ids.add(parts[0])
  }
  return ids
}

export function pxpParseCompletedIds(pxp: string): Set<string> {
  const ids = new Set<string>()
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@ACTIVITIES') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || t.startsWith('#') || !t) continue
    const parts = t.split('|').map(s => s.trim())
    if (!parts[0]) continue
    const pct = parts[10] ?? '', af = parts[9] ?? ''
    const ad = parts[13] ?? '', rd = parts[14] ?? ''
    const done = (pct && parseFloat(pct) >= 100) || af !== '' ||
      (ad && parseFloat(ad) > 0 && (!rd || parseFloat(rd) === 0))
    if (done) ids.add(parts[0])
  }
  return ids
}

export function pxpGetAllRelations(pxp: string): Array<{ pred: string; succ: string; type: string; lag: number }> {
  const result: Array<{ pred: string; succ: string; type: string; lag: number }> = []
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@RELATIONS') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || t.startsWith('#') || !t) continue
    const parts = t.split('|').map(s => s.trim())
    if (parts.length >= 2 && parts[0] && parts[1]) {
      result.push({ pred: parts[0], succ: parts[1], type: parts[2] || 'FS', lag: parseFloat(parts[3]) || 0 })
    }
  }
  return result
}

/** Парсит все назначения ресурсов для одной задачи прямо из pxp_text.
 *  Всегда актуален - используется вместо detail.assignments чтобы
 *  изменения отображались мгновенно без перезагрузки деталей */
export function pxpGetAssignmentsForActivity(
  pxp: string,
  actId: string,
  resources: Array<{ id: string; name: string }>,
): Array<{
  resource_id: string
  resource_name: string
  planned_units: number
  actual_qty: number | null
  remaining_qty: number | null
}> {
  const resMap = new Map(resources.map(r => [r.id, r.name]))
  const result: Array<{
    resource_id: string; resource_name: string
    planned_units: number; actual_qty: number | null; remaining_qty: number | null
  }> = []
  let inSection = false
  for (const line of pxp.split('\n')) {
    const t = line.trim()
    if (t === '@ASSIGNMENTS') { inSection = true; continue }
    if (inSection && t.startsWith('@')) break
    if (!inSection || t.startsWith('#') || !t) continue
    const parts = t.split('|').map(s => s.trim())
    if (parts[0] !== actId || !parts[1]) continue
    // Определяем формат: новый (act|res|role|units|...) или старый (act|res|units)
    const isNew = parts.length >= 4 && (parts[2] === '' || isNaN(Number(parts[2])))
    const units        = isNew ? (parseFloat(parts[3]) || 0) : (parseFloat(parts[2]) || 0)
    const actual_qty   = isNew && parts[5] ? parseFloat(parts[5]) || null : null
    const remaining_qty = isNew && parts[7] ? parseFloat(parts[7]) || null : null
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