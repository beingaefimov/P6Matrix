import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Download, RefreshCw, Layers, Globe } from 'lucide-react'
import clsx from 'clsx'
import UploadZone from './components/UploadZone'
import GanttChart from './components/GanttChart'
import ActivityTable from './components/ActivityTable'
import ResourceChart from './components/ResourceChart'
import ProjectStats from './components/ProjectStats'
import ActivityDetailPanel from './components/ActivityDetailPanel'
import { uploadFile, scheduleProject, levelResources } from './utils/api'
import { setActivityDuration, setActivityConstraint, clearActivityConstraint,
  setActivityActualDuration, setActivityRemainingDuration,
  setActivityActualStart, setActivityActualFinish, setActivityPctComplete,
  getActivityField, getActivityExtra, getAssignmentsForActivity,
  setAssignmentUnits, setAssignmentActual, setAssignmentRemaining,
  addAssignment, removeAssignment,
  addRelation, removeRelation, updateRelationType, updateRelationLag,
  lockCompletedActivities, parseCompletedIds, getAllRelations,
} from './utils/pxpUtils'
import type { ScheduleResult } from './types'

type Tab = 'gantt' | 'table' | 'resources' | 'pxp'

export default function App() {
  const { t, i18n } = useTranslation()
  const [result, setResult] = useState<ScheduleResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('gantt')
  const [levelWithinFloat, setLevelWithinFloat] = useState(true)
  const [activeProjectIdx, setActiveProjectIdx] = useState(0)
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  const [showConnections, setShowConnections] = useState(true)
  const [hardStarts, setHardStarts] = useState<Set<string>>(new Set())
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())

  const toggleLang = () => { i18n.changeLanguage(i18n.language === 'ru' ? 'en' : 'ru') }
  const activeProject = result ? result.projects[activeProjectIdx] || result.projects[0] : null

  const updateResult = useCallback((prev: ScheduleResult | null, idx: number, r: ScheduleResult) => {
    const newProjects = [...prev!.projects]; newProjects[idx] = r.projects[0]
    const updated = { ...prev!, projects: newProjects, warnings: r.warnings }
    setResult(updated)
    setCompletedIds(parseCompletedIds(r.projects[0].pxp_text))
    return updated
  }, [])

  const applyPxpChange = useCallback(async (pxpText: string) => {
    if (!result || !activeProject) return
    setLoading(true); setError(null)
    try {
      const locked = lockCompletedActivities(pxpText, activeProject.activities, activeProject.start_date)
      const r = await scheduleProject(locked, levelWithinFloat)
      updateResult(result, activeProjectIdx, r)
    } catch (e: any) { setError(e?.response?.data?.detail || e?.message || 'Unknown error') }
    finally { setLoading(false) }
  }, [result, activeProjectIdx, activeProject, levelWithinFloat, updateResult])

  const handleFile = async (file: File) => {
    setLoading(true); setError(null); setSelectedActivityId(null)
    setHardStarts(new Set()); setCompletedIds(new Set())
    try {
      const r = await uploadFile(file, false)
      setResult(r); setActiveProjectIdx(0); setActiveTab('gantt')
      setCompletedIds(parseCompletedIds(r.projects[0].pxp_text))
    } catch (e: any) { setError(e?.response?.data?.detail || e?.message || 'Unknown error') }
    finally { setLoading(false) }
  }

  const handleRecalculate = async () => {
    if (!activeProject) return
    setLoading(true); setError(null)
    try {
      const locked = lockCompletedActivities(activeProject.pxp_text, activeProject.activities, activeProject.start_date)
      const r = await scheduleProject(locked, levelWithinFloat)
      updateResult(result!, activeProjectIdx, r)
    } catch (e: any) { setError(e?.response?.data?.detail || e?.message || 'Unknown error') }
    finally { setLoading(false) }
  }

  const handleLevel = async () => {
    if (!activeProject) return
    setLoading(true); setError(null)
    try {
      const locked = lockCompletedActivities(activeProject.pxp_text, activeProject.activities, activeProject.start_date)
      const r = await levelResources(locked, levelWithinFloat)
      updateResult(result!, activeProjectIdx, r); setHardStarts(new Set())
    } catch (e: any) { setError(e?.response?.data?.detail || e?.message || 'Unknown error') }
    finally { setLoading(false) }
  }

  const handleActivityMove = useCallback((id: string, newEsDays: number) => {
    if (!activeProject) return
    setLoading(true); setError(null)
    let newPxp = setActivityConstraint(activeProject.pxp_text, id, newEsDays)
    newPxp = lockCompletedActivities(newPxp, activeProject.activities, activeProject.start_date)
    scheduleProject(newPxp, levelWithinFloat)
      .then(r => { updateResult(result!, activeProjectIdx, r); setHardStarts(prev => { const next = new Set(prev); next.add(id); return next }) })
      .catch(e => { setError(e?.response?.data?.detail || e?.message || 'Unknown error') })
      .finally(() => setLoading(false))
  }, [activeProject, activeProjectIdx, result, levelWithinFloat, updateResult])

  // Перетаскивание на другой бар - создаём связь FS:
  // toId (цель, на которую кинули) → fromId (перетаскиваемая) по FS
  const handleDropRelation = useCallback((fromId: string, toId: string) => {
    if (!activeProject) return
    setLoading(true); setError(null)
    try {
      // Связь: toId (предшественник) → fromId (последователь)
      const existing = getAllRelations(activeProject.pxp_text)
      const dup = existing.find(r => r.pred === toId && r.succ === fromId && r.type === 'FS' && r.lag === 0)
      if (dup) { setLoading(false); return }
      let newPxp = addRelation(activeProject.pxp_text, toId, fromId, 'FS', 0)
      const locked = lockCompletedActivities(newPxp, activeProject.activities, activeProject.start_date)
      scheduleProject(locked, levelWithinFloat)
        .then((r: ScheduleResult) => updateResult(result!, activeProjectIdx, r))
        .catch((e: Error) => setError(e?.message || 'Unknown error'))
        .finally(() => setLoading(false))
    } catch (e: unknown) {
      setError('Unknown error')
      setLoading(false)
    }
  }, [activeProject, activeProjectIdx, result, levelWithinFloat, updateResult])

  const handleSetDuration = useCallback((a: string, d: number) => { if (!activeProject) return; applyPxpChange(setActivityDuration(activeProject.pxp_text, a, d)) }, [activeProject, applyPxpChange])
  const handleSetActualDuration = useCallback((a: string, v: number | null) => {
    if (!activeProject) return
    let p = setActivityActualDuration(activeProject.pxp_text, a, v)
    if (v !== null && v > 0) { const { remainingDuration } = getActivityExtra(p, a); if (remainingDuration !== null && remainingDuration > 0) p = setActivityDuration(p, a, v + remainingDuration) }
    applyPxpChange(p)
  }, [activeProject, applyPxpChange])
  const handleSetRemainingDuration = useCallback((a: string, v: number | null) => {
    if (!activeProject) return
    let p = setActivityRemainingDuration(activeProject.pxp_text, a, v)
    if (v !== null && v > 0) { const { actualDuration } = getActivityExtra(p, a); if (actualDuration !== null && actualDuration > 0) p = setActivityDuration(p, a, actualDuration + v) }
    applyPxpChange(p)
  }, [activeProject, applyPxpChange])

  const handleSetCompleted = useCallback((actId: string, done: boolean) => {
    if (!activeProject) return
    const act = activeProject.activities.find(a => a.id === actId); if (!act) return
    let p = activeProject.pxp_text
    if (done) {
      p = setActivityActualDuration(p, actId, Math.round(act.duration)); p = setActivityRemainingDuration(p, actId, 0)
      p = setActivityPctComplete(p, actId, 100)
      if (!act.actual_start) p = setActivityActualStart(p, actId, act.es_date)
      if (!act.actual_finish) p = setActivityActualFinish(p, actId, act.ef_date)
      const esDays = Math.round((new Date(act.es_date).getTime() - new Date(activeProject.start_date).getTime()) / 86400000)
      if (!getActivityField(p, actId, 6)) p = setActivityConstraint(p, actId, esDays)
      const assignments = getAssignmentsForActivity(p, actId, activeProject.resources)
      for (const asgn of assignments) p = setAssignmentRemaining(p, actId, asgn.resource_id, 0)
      setCompletedIds(prev => { const next = new Set(prev); next.add(actId); return next })
    } else {
      p = setActivityActualDuration(p, actId, null); p = setActivityRemainingDuration(p, actId, null)
      p = setActivityPctComplete(p, actId, 0); p = setActivityActualStart(p, actId, null); p = setActivityActualFinish(p, actId, null)
      if (!hardStarts.has(actId)) p = clearActivityConstraint(p, actId)
      setCompletedIds(prev => { const next = new Set(prev); next.delete(actId); return next })
    }
    applyPxpChange(p)
  }, [activeProject, applyPxpChange, hardStarts])

  const handleSetResourceCompleted = useCallback((a: string, r: string, done: boolean) => {
    if (!activeProject) return
    applyPxpChange(setAssignmentRemaining(activeProject.pxp_text, a, r, done ? 0 : null))
  }, [activeProject, applyPxpChange])

  const handleSetHardStart = useCallback((a: string, v: boolean) => {
    if (!activeProject) return
    if (v) {
      const act = activeProject.activities.find(x => x.id === a); if (!act) return
      const esDays = Math.round((new Date(act.es_date).getTime() - new Date(activeProject.start_date).getTime()) / 86400000)
      applyPxpChange(setActivityConstraint(activeProject.pxp_text, a, esDays)).then(() => setHardStarts(prev => { const n = new Set(prev); n.add(a); return n }))
    } else {
      applyPxpChange(clearActivityConstraint(activeProject.pxp_text, a)).then(() => setHardStarts(prev => { const n = new Set(prev); n.delete(a); return n }))
    }
  }, [activeProject, applyPxpChange])

  const handleSetAssignmentUnits = useCallback((a: string, r: string, u: number) => { if (!activeProject) return; applyPxpChange(setAssignmentUnits(activeProject.pxp_text, a, r, u)) }, [activeProject, applyPxpChange])
  const handleSetAssignmentActual = useCallback((a: string, r: string, v: number | null) => { if (!activeProject) return; applyPxpChange(setAssignmentActual(activeProject.pxp_text, a, r, v)) }, [activeProject, applyPxpChange])
  const handleSetAssignmentRemaining = useCallback((a: string, r: string, v: number | null) => { if (!activeProject) return; applyPxpChange(setAssignmentRemaining(activeProject.pxp_text, a, r, v)) }, [activeProject, applyPxpChange])
  const handleAddAssignment = useCallback((a: string, r: string, u: number) => { if (!activeProject) return; applyPxpChange(addAssignment(activeProject.pxp_text, a, r, u)) }, [activeProject, applyPxpChange])
  const handleRemoveAssignment = useCallback((a: string, r: string) => { if (!activeProject) return; applyPxpChange(removeAssignment(activeProject.pxp_text, a, r)) }, [activeProject, applyPxpChange])
  const handleAddRelation = useCallback((p: string, s: string, ty: string, l: number) => { if (!activeProject) return; applyPxpChange(addRelation(activeProject.pxp_text, p, s, ty, l)) }, [activeProject, applyPxpChange])
  const handleRemoveRelation = useCallback((p: string, s: string) => { if (!activeProject) return; applyPxpChange(removeRelation(activeProject.pxp_text, p, s)) }, [activeProject, applyPxpChange])
  const handleUpdateRelationType = useCallback((p: string, s: string, ty: string) => { if (!activeProject) return; applyPxpChange(updateRelationType(activeProject.pxp_text, p, s, ty)) }, [activeProject, applyPxpChange])
  const handleUpdateRelationLag = useCallback((p: string, s: string, l: number) => { if (!activeProject) return; applyPxpChange(updateRelationLag(activeProject.pxp_text, p, s, l)) }, [activeProject, applyPxpChange])

  const downloadPxp = () => {
    if (!activeProject) return
    const blob = new Blob([activeProject.pxp_text], { type: 'text/plain' }); const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${activeProject.project_id || 'project'}.pxp`; a.click(); URL.revokeObjectURL(url)
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'gantt', label: t('tab_gantt') }, { id: 'table', label: t('tab_table') },
    { id: 'resources', label: t('tab_resources') }, { id: 'pxp', label: t('tab_pxp') },
  ]
  const selectedActivity = selectedActivityId && activeProject ? activeProject.activities.find(a => a.id === selectedActivityId) || null : null

  return (
    <div className="min-h-screen bg-steel-950 text-steel-200 font-sans">
      <header className="border-b border-steel-800 bg-steel-900/80 backdrop-blur sticky top-0 z-30">
        <div className="mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center flex-shrink-0"><Layers className="w-4 h-4 text-steel-950" /></div>
            <div>
              <span className="font-display font-bold text-steel-100 text-lg leading-none">{t('app_title')}</span>
              <div className="text-[10px] text-steel-500 font-mono leading-none mt-0.5">{t('app_subtitle')}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {result && (<>
              <label className="flex items-center gap-1.5 text-xs text-steel-400 cursor-pointer select-none mr-2">
                <input type="checkbox" checked={levelWithinFloat} onChange={e => setLevelWithinFloat(e.target.checked)} className="accent-amber-400" />
                {t('level_within_float')}
              </label>
              <button onClick={handleRecalculate} disabled={loading} className="btn-secondary flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" />{t('btn_recalculate')}</button>
              <button onClick={handleLevel} disabled={loading} className="btn-secondary flex items-center gap-1.5"><Layers className="w-3.5 h-3.5" />{t('btn_level')}</button>
              <button onClick={downloadPxp} className="btn-secondary flex items-center gap-1.5"><Download className="w-3.5 h-3.5" />{t('btn_download_pxp')}</button>
            </>)}
            <button onClick={toggleLang} className="btn-secondary flex items-center gap-1.5 ml-2"><Globe className="w-3.5 h-3.5" />{t('lang_switch')}</button>
          </div>
        </div>
      </header>
      <main className="mx-auto px-4 sm:px-6 py-6 space-y-6">
        {!result && <UploadZone onFile={handleFile} loading={loading} />}
        {error && (<div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3 animate-slide-in"><AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 flex-shrink-0" /><div><div className="text-xs font-semibold text-rose-400 mb-1">{t('error_title')}</div><div className="text-xs text-rose-300 font-mono">{error}</div></div></div>)}
        {result?.warnings && result.warnings.length > 0 && (<div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 animate-slide-in"><div className="flex items-center gap-2 text-xs font-semibold text-amber-400 mb-2"><AlertTriangle className="w-3.5 h-3.5" />{t('warnings')}</div><ul className="space-y-1">{result.warnings.map((w, i) => <li key={i} className="text-xs font-mono text-amber-300">• {w}</li>)}</ul></div>)}
        {result && activeProject && (<div className="space-y-5 animate-fade-in">
          {result.projects.length > 1 && (<div className="flex gap-1 border-b border-steel-800">{result.projects.map((p, idx) => (<button key={p.project_id} onClick={() => { setActiveProjectIdx(idx); setSelectedActivityId(null); setHardStarts(new Set()) }} className={clsx('px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px', idx === activeProjectIdx ? 'border-emerald-400 text-emerald-400' : 'border-transparent text-steel-500 hover:text-steel-300')}>{p.project_name || p.project_id}<span className="ml-2 text-steel-600 font-mono text-xs">{p.project_id}</span></button>))}</div>)}
          <div>
            <h2 className="font-display font-semibold text-steel-300 text-sm mb-3 truncate">{activeProject.project_name}<span className="ml-2 text-steel-600 font-mono font-normal text-xs">{activeProject.project_id}</span></h2>
            <div className="w-full flex gap-4">
              <div className="flex-1 min-w-0"><ProjectStats activities={activeProject.activities} duration_days={activeProject.duration_days} finish_date={activeProject.finish_date} /></div>
              <div className="flex-shrink-0"><UploadZone onFile={handleFile} loading={loading} /></div>
            </div>
          </div>
          <div>
            <div className="flex gap-1 border-b border-steel-800 mb-4">
              {tabs.map(tab => (<button key={tab.id} onClick={() => { setActiveTab(tab.id); setSelectedActivityId(null) }} className={clsx('px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px', activeTab === tab.id ? 'border-amber-400 text-amber-400' : 'border-transparent text-steel-500 hover:text-steel-300')}>{tab.label}</button>))}
            </div>
            {activeTab === 'gantt' && (<GanttChart activities={activeProject.activities} startDate={activeProject.start_date} totalDays={activeProject.duration_days} onActivityMove={handleActivityMove} onDropRelation={handleDropRelation} onSelectActivity={setSelectedActivityId} selectedActivityId={selectedActivityId} wbs={activeProject.wbs} pxpText={activeProject.pxp_text} showConnections={showConnections} onToggleConnections={() => setShowConnections(v => !v)} hardStarts={hardStarts} completedIds={completedIds} />)}
            {activeTab === 'table' && <ActivityTable activities={activeProject.activities} hardStarts={hardStarts} completedIds={completedIds} />}
            {activeTab === 'resources' && <ResourceChart resources={activeProject.resources} resourceLoad={activeProject.resource_load} startDate={activeProject.start_date} />}
            {activeTab === 'pxp' && (<div className="rounded-xl border border-steel-700 bg-steel-950 overflow-auto"><pre className="text-xs font-mono text-steel-300 p-5 leading-relaxed whitespace-pre-wrap">{activeProject.pxp_text}</pre></div>)}
          </div>
        </div>)}
        {!result && !loading && !error && (<div className="text-center py-16 text-steel-600"><Layers className="w-12 h-12 mx-auto mb-4 opacity-30" /><p className="font-display font-semibold text-lg">{t('no_project')}</p><p className="text-sm mt-1">{t('no_project_hint')}</p></div>)}
      </main>
      {selectedActivity && activeProject && (<ActivityDetailPanel activity={selectedActivity} onClose={() => setSelectedActivityId(null)} pxpText={activeProject.pxp_text} activities={activeProject.activities} resources={activeProject.resources} hardStart={hardStarts.has(selectedActivity.id)} completed={completedIds.has(selectedActivity.id)} onSetDuration={handleSetDuration} onSetActualDuration={handleSetActualDuration} onSetRemainingDuration={handleSetRemainingDuration} onSetCompleted={handleSetCompleted} onSetResourceCompleted={handleSetResourceCompleted} onSetHardStart={handleSetHardStart} onSetAssignmentUnits={handleSetAssignmentUnits} onSetAssignmentActual={handleSetAssignmentActual} onSetAssignmentRemaining={handleSetAssignmentRemaining} onAddAssignment={handleAddAssignment} onRemoveAssignment={handleRemoveAssignment} onAddRelation={handleAddRelation} onRemoveRelation={handleRemoveRelation} onUpdateRelationType={handleUpdateRelationType} onUpdateRelationLag={handleUpdateRelationLag} loading={loading} />)}
    </div>
  )
}