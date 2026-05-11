// Файл - POST /upload - бэкенд парсит PXP/XER - минимальные данные
//                                                     ↓
//                                            useScheduler (клиент)
//                                                     ↓
//                                         cpmEngine.ts (WebGPU/CPU)
//                                       CPM + Resource Leveling на клиенте
//                                                     ↓
//                                               Гант реагирует мгновенно
// Клик на задачу - POST /activity/detail - только одна запись (lazy)
// Скачать PXP - Blob URL, без бэкенда

import { useState, useCallback, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Download, RefreshCw, Layers, Globe, Share2,
  Plus, X, FileJson } from 'lucide-react'
import clsx from 'clsx'
import UploadZone from './components/UploadZone'
import GanttChart from './components/GanttChart'
import ActivityTable from './components/ActivityTable'
import ResourceChart from './components/ResourceChart'
import AssignmentsTab from './components/AssignmentsTab'
import ProjectStats from './components/ProjectStats'
import ActivityDetailPanel from './components/ActivityDetailPanel'
import { useScheduler } from './engine/useScheduler'
import { pxpParseLockedIds, pxpParseCompletedIds, pxpGetAllRelations,
  pxpBuildScheduleResults } from './utils/pxpMutations'
import type { ActivityDetail } from './utils/api'

type Tab = 'gantt' | 'table' | 'resources' | 'assignments' | 'pxp'

// Размеры для Excalidraw
const EDRAW_SCALE = 30; // пикселей на день
const EDRAW_ROW_H = 80;
const EDRAW_BAR_H = 50;
const EDRAW_START_X = 250; // отступ для текста слева

function generateExcalidrawJson(activities: any[], startDate: string, locale: string): object {
  if (startDate) {}
  const elements: any[] = [];
  let seed = 1;

  // Хелпер для форматирования дат
  const fmtDate = (d: string | null) => {
    if (!d) return "-";
    if (locale === 'ru') {
      // Преобразуем YYYY-MM-DD в DD.MM.YYYY
      const parts = d.split('-');
      if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
    }
    return d; // Для английской локали оставляем как есть (YYYY-MM-DD)
  };

  activities.forEach((act, idx) => {
    const y = idx * EDRAW_ROW_H + 20;
    const x = act.es_days * EDRAW_SCALE + EDRAW_START_X;
    const w = Math.max(act.duration, 1) * EDRAW_SCALE;

    const isMilestone = act.duration === 0 || act.act_type === 'milestone';
    const baseColor = act.on_critical ? '#c92a2a' : '#1971c2';
    const bgColor = act.on_critical ? '#ffc9c9' : '#a5d8ff';

    if (isMilestone) {
      // Веха (Ромб) 
      const size = 40;
      const diamondId = `diamond-${Date.now()}-${idx}`;
      const textId = `text-${Date.now()}-${idx}`;
      elements.push({
        type: 'diamond',
        version: 1,
        versionNonce: seed++,
        isDeleted: false,
        id: diamondId,
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        angle: 0,
        x: x - size / 2, // Центрируем ромб по точке начала
        y: y + (EDRAW_BAR_H / 2) - size / 2, // Вертикальное центрирование
        strokeColor: baseColor,
        backgroundColor: bgColor,
        width: size,
        height: size,
        seed: Math.floor(Math.random() * 100000),
        groupIds: [],
        frameId: null,
        roundness: null,
        boundElements: [], // Текст не привязан к ромбу
        updated: Date.now(),
        link: null,
        locked: false,
      });

      // Текст справа от ромба
      const textContent = `${act.name}\n${fmtDate(act.es_date)}`;
      
      elements.push({
        type: 'text',
        version: 1,
        versionNonce: seed++,
        isDeleted: false,
        id: textId,
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        angle: 0,
        x: x + size / 2 + 10, // Отступ справа от ромба
        y: y + (EDRAW_BAR_H / 2) - 10, 
        strokeColor: '#1e293b',
        backgroundColor: 'transparent',
        width: 200,
        height: 25,
        seed: Math.floor(Math.random() * 100000),
        groupIds: [],
        frameId: null,
        roundness: null,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
        fontSize: 16,
        fontFamily: 1,
        text: textContent,
        textAlign: 'left',
        verticalAlign: 'middle',
        containerId: null, // Не привязан к контейнеру
        originalText: textContent,
        lineHeight: 1.25,
      });

    } else {
      // Обычная работа (Прямоугольник)
      const rectId = `rect-${Date.now()}-${idx}`;
      const textId = `text-${Date.now()}-${idx}`;

      elements.push({
        type: 'rectangle',
        version: 1,
        versionNonce: seed++,
        isDeleted: false,
        id: rectId,
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        angle: 0,
        x: x,
        y: y,
        strokeColor: baseColor,
        backgroundColor: bgColor,
        width: w,
        height: EDRAW_BAR_H,
        seed: Math.floor(Math.random() * 100000),
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        boundElements: [{ type: 'text', id: textId }],
        updated: Date.now(),
        link: null,
        locked: false,
      });

      const textContent = `${act.name}\n${fmtDate(act.es_date)} — ${fmtDate(act.ef_date)}`;
      
      elements.push({
        type: 'text',
        version: 1,
        versionNonce: seed++,
        isDeleted: false,
        id: textId,
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        angle: 0,
        x: x + 8,
        y: y + 8,
        strokeColor: '#1e293b',
        backgroundColor: 'transparent',
        width: w - 16,
        height: EDRAW_BAR_H - 16,
        seed: Math.floor(Math.random() * 100000),
        groupIds: [],
        frameId: null,
        roundness: null,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
        fontSize: 16,
        fontFamily: 1,
        text: textContent,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: rectId,
        originalText: textContent,
        lineHeight: 1.25,
      });
    }
  });

  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: '#ffffff'
    },
    files: {}
  };
}

export default function App() {
  const { t, i18n } = useTranslation()
  const toggleLang = () => i18n.changeLanguage(i18n.language === 'ru' ? 'en' : 'ru')
  const {
    state,
    loadFile,
    recalculate,
    levelResourcesAction,
    moveActivity,
    addRelation,
    updateActivityField,
    applyPxpText,
    addActivity,
    removeActivity,
    reorderActivity,
    renameActivity,
    addResource,
    removeResource,
    updateResource,
    fetchDetail,
    getPxpText,
  } = useScheduler()

  const { project, loading, gpuActive, error, warnings } = state
  const [activeTab, setActiveTab] = useState<Tab>('gantt')
  const [levelWithinFloat, setLevelWithinFloat] = useState(true)
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null)
  const [showConnections, setShowConnections] = useState(true)
  const [hardStarts, setHardStarts] = useState<Set<string>>(new Set())
  // Детали задачи подгружаются лениво при клике
  const [detailData, setDetailData] = useState<ActivityDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const pxpText = project?.pxp_text ?? ''
  const lockedIds = useMemo(() => pxpParseLockedIds(pxpText), [pxpText])
  const completedIds = useMemo(() => pxpParseCompletedIds(pxpText), [pxpText])

  const handleFile = useCallback((file: File) => {
    setSelectedActivityId(null)
    setSelectedGanttIds([]) // Сброс мультивыбора
    setDetailData(null)
    setHardStarts(new Set())
    loadFile(file)
  }, [loadFile])

  const handleRecalculate = useCallback(() => {
    recalculate()
  }, [recalculate])

  const handleLevel = useCallback(() => {
    levelResourcesAction({ level_within_float_only: levelWithinFloat, max_overload_pct: 100 })
    setHardStarts(new Set())
  }, [levelResourcesAction, levelWithinFloat])

  // Drag bar на Ганте - пересчёт на клиенте, никакого бэкенда
  const handleActivityMove = useCallback((id: string, newEsDays: number) => {
    if (lockedIds.has(id)) return  // начатые/завершённые не двигаются
    moveActivity(id, newEsDays)
    setHardStarts(prev => { const n = new Set(prev); n.add(id); return n })
  }, [moveActivity, lockedIds])

  // Drag bar на другой bar - создаём FS связь
  const handleDropRelation = useCallback((fromId: string, toId: string) => {
    addRelation(toId, fromId)  // toId = predecessor, fromId = successor
  }, [addRelation])

  // Клик на задачу - lazy-загрузка деталей с бэкенда (только name/notes/UDF)
  const handleSelectActivity = useCallback(async (id: string | null) => {
    setSelectedActivityId(id)
    if (!id) { setDetailData(null); return }
    setDetailLoading(true)
    try {
      const detail = await fetchDetail(id)
      setDetailData(detail)
    } catch {
      setDetailData(null)
    } finally {
      setDetailLoading(false)
    }
  }, [fetchDetail])

  // Изменение длительности задачи
  const handleSetDuration = useCallback((actId: string, duration: number) => {
    updateActivityField(actId, 2, String(duration))
  }, [updateActivityField])

  // Actual duration (поле 13)
  const handleSetActualDuration = useCallback((actId: string, value: number | null) => {
    updateActivityField(actId, 13, value != null ? String(value) : '')
  }, [updateActivityField])

  // Remaining duration (поле 14)
  const handleSetRemainingDuration = useCallback((actId: string, value: number | null) => {
    updateActivityField(actId, 14, value != null ? String(value) : '')
  }, [updateActivityField])

  // Завершение задачи
  const handleSetCompleted = useCallback((actId: string, done: boolean) => {
    const act = project?.activities.find(a => a.id === actId)
    if (!act) return
    if (done) {
      updateActivityField(actId, 13, String(Math.round(act.duration)))
      updateActivityField(actId, 14, '0')
      updateActivityField(actId, 10, '100')
      if (!act.actual_start) updateActivityField(actId, 8, act.es_date)
      if (!act.actual_finish) updateActivityField(actId, 9, act.ef_date)
      const esDays = act.es_days
      updateActivityField(actId, 6, String(Math.round(esDays)))
    } else {
      updateActivityField(actId, 13, '')
      updateActivityField(actId, 14, '')
      updateActivityField(actId, 10, '0')
      updateActivityField(actId, 8, '')
      updateActivityField(actId, 9, '')
      if (!hardStarts.has(actId)) updateActivityField(actId, 6, '')
    }
  }, [project, updateActivityField, hardStarts])

  // Hard start (constraint)
  const handleSetHardStart = useCallback((actId: string, value: boolean) => {
    const act = project?.activities.find(a => a.id === actId)
    if (!act) return
    if (value) {
      updateActivityField(actId, 6, String(Math.round(act.es_days)))
      setHardStarts(prev => { const n = new Set(prev); n.add(actId); return n })
    } else {
      // Если у работы нет связей - при снятии жёсткого старта ставим ES=0 (начало проекта)
      // иначе без constraint_es и без связей работа зависнет на месте
      const rels = pxpGetAllRelations(pxpText)
      const hasPreds = rels.some(r => r.succ === actId)
      const newConstraint = hasPreds ? '' : '0'
      updateActivityField(actId, 6, newConstraint)
      setHardStarts(prev => { const n = new Set(prev); n.delete(actId); return n })
    }
  }, [project, updateActivityField, pxpText])

  const [shareStatus, setShareStatus] = useState<'idle' | 'sharing' | 'ok' | 'err'>('idle')
  const [showNewProjectModal, setShowNewProjectModal] = useState(false)
  const [selectedGanttIds, setSelectedGanttIds] = useState<string[]>([])
  const [isExporting, setIsExporting] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const selectedActivityDisplay = selectedActivityId && project
    ? project.activities.find(a => a.id === selectedActivityId) ?? null
    : null

  const tabs: { id: Tab; label: string }[] = [
    { id: 'gantt', label: t('tab_gantt') },
    { id: 'table', label: t('tab_table') },
    { id: 'resources', label: t('tab_resources') },
    { id: 'assignments', label: t('tab_assignments') },
    { id: 'pxp', label: t('tab_pxp') },
  ]

  const handleExportEdraw = useCallback(async () => {
    if (!project || selectedGanttIds.length === 0) return
    setIsExporting(true)

    try {
      // Берем до 20 работ, сортируем по дате начала
      const selected = project.activities
        .filter(a => selectedGanttIds.includes(a.id))
        .sort((a, b) => a.es_days - b.es_days)
        .slice(0, 20)

      const json = generateExcalidrawJson(selected, project.start_date, i18n.language)
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `schedule-${Date.now()}.excalidraw`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setIsExporting(false)
    }
  }, [project, selectedGanttIds])

  // Когда панель деталей открыта - добавляем scroll-padding-bottom на html
  // чтобы якорные прокрутки и клавиатурная навигация учитывали высоту панели
  useEffect(() => {
    const root = document.documentElement
    if (selectedActivityDisplay) {
      root.style.scrollPaddingBottom = 'calc(52vh + 2rem)'
    } else {
      root.style.scrollPaddingBottom = ''
    }
    return () => { root.style.scrollPaddingBottom = '' }
  }, [selectedActivityDisplay])

  const handleCreateProject = useCallback(() => {
    const isRu = i18n.language === 'ru'
    const startName = isRu ? t('activity_start_name') : t('activity_start_name')
    const finishName = isRu ? t('activity_finish_name') : t('activity_finish_name')
    const projId = 'P' + String(Date.now()).slice(-5)
    const today = new Date().toISOString().slice(0, 10)
    const pxp = [
      `# Created by P6Matrix`,
      ``,
      `@META`,
      `project_id   = ${projId}`,
      `project_name = ${newProjectName.trim()}`,
      `start_date   = ${today}`,
      `data_date    = ${today}`,
      `must_finish  = NULL`,
      `calendar     = 5d8h`,
      `duration_unit = days`,
      ``,
      `@ACTIVITIES`,
      `# id | name | duration | type`,
      `  START | ${startName} | 0 | milestone |  |  |  |  |  |  | 0 | 0 |  `,
      `  FINISH | ${finishName} | 0 | milestone |  |  |  |  |  |  | 0 | 0 |  `,
      ``,
      `@RELATIONS`,
      `# pred | succ | type | lag`,
      `  START | FINISH | FS | 0`,
      ``,
    ].join('\n')
    setSelectedActivityId(null)
    setDetailData(null)
    setHardStarts(new Set())
    setShowNewProjectModal(false)
    setNewProjectName('')
    setActiveTab('gantt')
    applyPxpText(pxp)
  }, [newProjectName, i18n.language, t, applyPxpText])
  
  const shareProject = useCallback(async () => {
    const text = getPxpText()
    if (!text || !project) return
    setShareStatus('sharing')
    try {
      const scheduleSection = pxpBuildScheduleResults(project.activities)
      const textWithResults = text + scheduleSection
      await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pxp_text: textWithResults }),
      })
      setShareStatus('ok')
      setTimeout(() => setShareStatus('idle'), 2500)
    } catch {
      setShareStatus('err')
      setTimeout(() => setShareStatus('idle'), 3000)
    }
  }, [getPxpText, project])

  const downloadPxp = useCallback(() => {
    const text = getPxpText()
    if (!text) return
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project?.project_id || 'project'}.pxp`
    a.click()
    URL.revokeObjectURL(url)
  }, [getPxpText, project?.project_id])

  // Панель деталей работает с pxpMutations через updateActivityField,
  // но для assignments/relations нужен доступ к полным данным из detailData

  return (
    <div className="min-h-screen bg-steel-950 text-steel-200 font-sans">
      {/* Header */}
      <header className="border-b border-steel-800 bg-steel-900/80 backdrop-blur sticky top-0 z-30">
        <div className="mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center flex-shrink-0">
              <Layers className="w-4 h-4 text-steel-950" />
            </div>
            <div>
              <span className="font-display font-bold text-steel-100 text-lg leading-none">{t('app_title')}</span>
              <div className="text-[10px] text-steel-500 font-mono leading-none mt-0.5 flex items-center gap-2">
                {t('app_subtitle')}
                {/* Индикатор WebGPU */}
                <span className={clsx(
                  'px-1.5 py-0.5 rounded text-[9px] font-semibold',
                  gpuActive
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-steel-700/60 text-steel-500'
                )}>
                  {gpuActive ? '⚡ WebGPU' : 'CPU'}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {project && (<>
              <label className="flex items-center gap-1.5 text-xs text-steel-400 cursor-pointer select-none mr-2">
                <input
                  type="checkbox"
                  checked={levelWithinFloat}
                  onChange={e => setLevelWithinFloat(e.target.checked)}
                  className="accent-amber-400"
                />
                {t('level_within_float')}
              </label>
              <button onClick={handleRecalculate} disabled={loading} className="btn-secondary flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5" />{t('btn_recalculate')}
              </button>
              <button onClick={handleLevel} disabled={loading} className="btn-secondary flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />{t('btn_level')}
              </button>
              <button onClick={downloadPxp} className="btn-secondary flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5" />{t('btn_download_pxp')}
              </button>
              <button onClick={shareProject} disabled={loading || shareStatus === 'sharing'}
                className={`btn-secondary flex items-center gap-1.5 ${shareStatus === 'ok' ? 'text-emerald-400 border-emerald-500/40' : shareStatus === 'err' ? 'text-rose-400 border-rose-500/40' : ''}`}
                title={t('btn_share')}>
                <Share2 className="w-3.5 h-3.5" />
                {shareStatus === 'sharing' ? '…' : shareStatus === 'ok' ? '✓' : shareStatus === 'err' ? '✗' : t('btn_share')}
              </button>
              <button onClick={handleExportEdraw} disabled={loading || isExporting || selectedGanttIds.length === 0}
                className="btn-secondary flex items-center gap-1.5"
                title={t('btn_edraw_title')}>
                <FileJson className="w-3.5 h-3.5" />
                {isExporting ? '...' : 'edraw'}
              </button>
              <button onClick={() => setShowNewProjectModal(true)} disabled={loading}
                className="btn-secondary flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" />{t('btn_new_project')}
              </button>
            </>)}
            <button onClick={toggleLang} className="btn-secondary flex items-center gap-1.5 ml-2">
              <Globe className="w-3.5 h-3.5" />{t('lang_switch')}
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto px-4 sm:px-6 py-6 space-y-6" style={{ paddingBottom: selectedActivityDisplay ? "calc(52vh + 2rem)" : undefined }}>
        {!project && <UploadZone onFile={handleFile} loading={loading} />}

        {error && (
          <div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3 animate-slide-in">
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-xs font-semibold text-rose-400 mb-1">{t('error_title')}</div>
              <div className="text-xs text-rose-300 font-mono">{error}</div>
            </div>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 animate-slide-in">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 mb-2">
              <AlertTriangle className="w-3.5 h-3.5" />{t('warnings')}
            </div>
            <ul className="space-y-1">
              {warnings.map((w, i) => <li key={i} className="text-xs font-mono text-amber-300">• {w}</li>)}
            </ul>
          </div>
        )}

        {project && (
          <div className="space-y-5 animate-fade-in">
            {/* Project header */}
            <div>
              <h2 className="font-display font-semibold text-steel-300 text-sm mb-3 truncate">
                {project.project_name}
                <span className="ml-2 text-steel-600 font-mono font-normal text-xs">{project.project_id}</span>
              </h2>
              <div className="w-full flex gap-4">
                <div className="flex-1 min-w-0">
                  <ProjectStats
                    activities={project.activities}
                    duration_days={project.duration_days}
                    finish_date={project.finish_date}
                  />
                </div>
                <div className="flex-shrink-0">
                  <UploadZone onFile={handleFile} loading={loading} />
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div>
              <div className="flex gap-1 border-b border-steel-800 mb-4">
                {tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => { setActiveTab(tab.id); setSelectedActivityId(null); setDetailData(null) }}
                    className={clsx(
                      'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
                      activeTab === tab.id
                        ? 'border-amber-400 text-amber-400'
                        : 'border-transparent text-steel-500 hover:text-steel-300'
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {activeTab === 'gantt' && (
                <GanttChart
                  activities={project.activities}
                  startDate={project.start_date}
                  totalDays={project.duration_days}
                  onActivityMove={handleActivityMove}
                  onDropRelation={handleDropRelation}
                  onSelectActivity={handleSelectActivity}
                  selectedActivityId={selectedActivityId}
                  // Новые пропсы
                  selectedIds={selectedGanttIds}
                  onSelectedIdsChange={setSelectedGanttIds}
                  // Конец новых пропсов
                  pxpText={pxpText}
                  showConnections={showConnections}
                  onToggleConnections={() => setShowConnections(v => !v)}
                  hardStarts={hardStarts}
                  completedIds={completedIds}
                  lockedIds={lockedIds}
                />
              )}

              {activeTab === 'table' && (
                <ActivityTable
                  activities={project.activities}
                  hardStarts={hardStarts}
                  completedIds={completedIds}
                  selectedActivityId={selectedActivityId}
                  onSelectActivity={setSelectedActivityId}
                  onAddActivity={addActivity}
                  onRemoveActivity={removeActivity}
                  onMoveActivity={reorderActivity}
                  onRenameActivity={renameActivity}
                />
              )}

              {activeTab === 'resources' && (
                <ResourceChart
                  resources={project.resources}
                  resourceLoad={project.resource_load}
                  startDate={project.start_date}
                  activities={project.activities}
                  assignments={project.assignments}
                  onAddResource={addResource}
                  onRemoveResource={removeResource}
                  onUpdateResource={updateResource}
                />
              )}

              {activeTab === 'assignments' && (
                <AssignmentsTab
                  resources={project.resources}
                  assignments={project.assignments}
                  activities={project.activities}
                  resourceLoad={project.resource_load}
                  startDate={project.start_date}
                />
              )}

              {activeTab === 'pxp' && (
                <div className="rounded-xl border border-steel-700 bg-steel-950 overflow-auto">
                  <pre className="text-xs font-mono text-steel-300 p-5 leading-relaxed whitespace-pre-wrap">
                    {pxpText}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}

        {!project && !loading && !error && (
          <div className="text-center py-16 text-steel-600 space-y-6">
            <Layers className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p className="font-display font-semibold text-lg">{t('no_project')}</p>
            <p className="text-sm">{t('no_project_hint')}</p>
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => setShowNewProjectModal(true)}
                className="px-4 py-3 rounded-xl border border-dashed border-steel-600 hover:border-amber-400/60 bg-steel-900/40 hover:bg-amber-400/5 transition-all duration-300 flex items-center gap-2">
                <Plus className="w-5 h-5 text-steel-400" />
                <span className="text-sm font-medium text-steel-400">{t('btn_new_project')}</span>
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Activity detail panel - появляется при клике, данные загружаются лениво */}
      {selectedActivityDisplay && (
        <ActivityDetailPanel
          activity={selectedActivityDisplay}
          detail={detailData}
          detailLoading={detailLoading}
          onClose={() => { setSelectedActivityId(null); setDetailData(null) }}
          pxpText={pxpText}
          activities={project!.activities}
          resources={project!.resources}
          hardStart={hardStarts.has(selectedActivityDisplay.id)}
          completed={completedIds.has(selectedActivityDisplay.id)}
          onSetDuration={handleSetDuration}
          onSetActualDuration={handleSetActualDuration}
          onSetRemainingDuration={handleSetRemainingDuration}
          onSetCompleted={handleSetCompleted}
          onSetHardStart={handleSetHardStart}
          onUpdateActivityField={updateActivityField}
          onApplyPxpText={applyPxpText}
          loading={loading || detailLoading}
        />
      )}

      {showNewProjectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-steel-950/80 backdrop-blur-sm" onClick={() => setShowNewProjectModal(false)} />
          <div className="relative bg-steel-900 border border-steel-700 rounded-2xl shadow-2xl px-6 py-5 w-96 animate-slide-in">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-steel-200">{t('new_project_title')}</span>
              <button onClick={() => setShowNewProjectModal(false)} className="p-1 rounded hover:bg-steel-700 text-steel-400"><X className="w-4 h-4" /></button>
            </div>
            <label className="block text-xs text-steel-500 mb-1">{t('new_project_name_label')}</label>
            <input
              autoFocus
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newProjectName.trim()) handleCreateProject(); if (e.key === 'Escape') setShowNewProjectModal(false) }}
              placeholder={t('new_project_placeholder')}
              className="w-full px-3 py-2 text-sm bg-steel-800 border border-steel-600 rounded-lg text-steel-100 focus:outline-none focus:border-amber-400/60 transition-colors mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowNewProjectModal(false)} className="px-3 py-1.5 text-xs text-steel-400 border border-steel-700 rounded-lg hover:bg-steel-800 transition-colors">{t('cancel')}</button>
              <button onClick={handleCreateProject} disabled={!newProjectName.trim()} className="px-3 py-1.5 text-xs text-amber-400 border border-amber-500/40 rounded-lg hover:bg-amber-400/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">{t('create')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
