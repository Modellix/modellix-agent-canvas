import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Excalidraw,
  exportToBlob,
  exportToSvg
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDollarSign,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FileImage,
  ImagePlus,
  KeyRound,
  Layers3,
  ListTodo,
  LoaderCircle,
  Maximize2,
  Moon,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Sparkles,
  Sun,
  Trash2,
  WandSparkles,
  X
} from 'lucide-react'
import html2canvas from 'html2canvas'
import { strToU8, zipSync } from 'fflate'

import {
  finalizeImageTask,
  getCanvasStatus,
  getImageTask,
  listImageTasks,
  loadProject,
  prepareImageTask,
  requestFullscreen,
  saveAsset,
  saveProject,
  startApiKeySetup,
  submitImageTask
} from './canvasClient'
import {
  businessKindOf,
  createCanvasImage,
  createHtmlDraft,
  createImageHolder,
  duplicateSlideForDeck,
  createSlideForDeck,
  createSlideDeck,
  modelId,
  objectIdOf,
  persistableAppState,
  selectedBusinessObject,
  selectedElements,
  selectedImages,
  SLIDE_TEMPLATE_OPTIONS,
  slideDimensions,
  viewportCenter
} from './canvasDomain'
import './styles.css'

const EMPTY_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Modellix HTML Draft</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 Inter, system-ui, sans-serif; color: #19191d; background: #f7f8f8; }
    main { width: min(720px, calc(100% - 48px)); padding: 48px; border-radius: 24px; background: white; box-shadow: 0 24px 80px rgba(25,25,29,.1); }
    strong { color: #605aff; }
  </style>
</head>
<body><main><p><strong>Modellix Agent Canvas</strong></p><h1>从这里开始你的 HTML 草稿</h1><p>在右侧编辑源码，预览会自动更新。</p></main></body>
</html>`

const SIZE_OPTIONS = [
  ['1024x1024', '1:1 · 1024'],
  ['1536x1024', '3:2 · 横向'],
  ['1024x1536', '2:3 · 纵向'],
  ['2048x1152', '16:9 · 横屏'],
  ['1152x2048', '9:16 · 竖屏'],
  ['2048x2048', '1:1 · 2K'],
  ['3840x2160', '16:9 · 4K']
]

const HOLDER_RATIO_OPTIONS = [
  ['1:1', 512, 512],
  ['4:3', 640, 480],
  ['3:4', 480, 640],
  ['16:9', 768, 432],
  ['9:16', 432, 768]
]

const DEFAULT_FORM = {
  prompt: '', size: '1024x1024', count: 1, quality: 'medium', background: 'opaque', inputFidelity: 'standard', fitPolicy: 'contain'
}

const EXCALIDRAW_UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: false, export: false, clearCanvas: true, toggleTheme: false },
  tools: { image: true }
}

export default function App() {
  const [project, setProject] = useState(null)
  const [status, setStatus] = useState(null)
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [activePanel, setActivePanel] = useState('ai')
  const [panelOpen, setPanelOpen] = useState(true)
  const [theme, setTheme] = useState('light')
  const [saveState, setSaveState] = useState('saved')
  const [toast, setToast] = useState(null)
  const [selectionVersion, setSelectionVersion] = useState(0)
  const [presentation, setPresentation] = useState(null)
  const [deckCreateOpen, setDeckCreateOpen] = useState(false)
  const [holderCreateOpen, setHolderCreateOpen] = useState(false)
  const [canvasRevision, setCanvasRevision] = useState(0)
  const [historyVersion, setHistoryVersion] = useState(0)
  const apiRef = useRef(null)
  const sceneRef = useRef({ elements: [], appState: {}, files: {} })
  const saveTimerRef = useRef(null)
  const loadedRef = useRef(false)
  const projectRef = useRef(null)
  const themeRef = useRef('light')
  const historyByPageRef = useRef(new Map())
  const applyingHistoryRef = useRef(false)
  const deckDialogReturnFocusRef = useRef(null)
  const holderDialogReturnFocusRef = useRef(null)
  const selectionSignatureRef = useRef('')
  const sceneSignatureRef = useRef('')

  const activePage = useMemo(() => project?.pages.find(page => page.id === project.activePageId) || project?.pages[0], [project])
  const selected = useMemo(() => selectedElements(sceneRef.current.elements, sceneRef.current.appState), [selectionVersion])
  const businessObject = useMemo(() => selectedBusinessObject(sceneRef.current.elements, sceneRef.current.appState), [selectionVersion])
  const missingAssetCount = useMemo(() => project?.pages.reduce((total, page) => total + Object.values(page.files || {}).filter(file => file.missing).length, 0) || 0, [project])
  const excalidrawInitialData = useMemo(() => activePage ? ({
    elements: activePage.elements || [],
    appState: { ...(activePage.appState || {}), theme },
    files: activePage.files || {}
  }) : undefined, [activePage?.id, canvasRevision])

  useEffect(() => { projectRef.current = project }, [project])
  useEffect(() => { themeRef.current = theme }, [theme])
  useEffect(() => {
    const improveCanvasAccessibility = () => {
      const mainMenu = document.querySelector('[data-testid="main-menu-trigger"]')
      if (mainMenu && !mainMenu.getAttribute('aria-label')) mainMenu.setAttribute('aria-label', '画布菜单')
      const resetZoom = document.querySelector('button.reset-zoom-button')
      const zoomText = resetZoom?.textContent?.trim()
      if (resetZoom && zoomText) resetZoom.setAttribute('aria-label', `重置缩放 ${zoomText}`)
    }
    improveCanvasAccessibility()
    const observer = new MutationObserver(improveCanvasAccessibility)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])

  const refreshProject = useCallback(async () => {
    const data = await loadProject()
    const previous = projectRef.current
    const nextPage = data.pages.find(page => page.id === data.activePageId) || data.pages[0]
    const canUpdateInPlace = Boolean(apiRef.current && previous?.activePageId === data.activePageId && nextPage)
    setProject(data)
    projectRef.current = data
    setTheme(data.settings?.theme || 'light')
    themeRef.current = data.settings?.theme || 'light'
    if (canUpdateInPlace) {
      apiRef.current.addFiles(Object.values(nextPage.files || {}))
      apiRef.current.updateScene({ elements: nextPage.elements || [], appState: nextPage.appState || {}, captureUpdate: 'IMMEDIATELY' })
      sceneRef.current = { elements: nextPage.elements || [], appState: nextPage.appState || {}, files: nextPage.files || {} }
      sceneSignatureRef.current = scenePersistenceSignature(sceneRef.current)
    } else setCanvasRevision(value => value + 1)
    return data
  }, [])

  const refreshStatus = useCallback(async (refresh = false) => {
    try {
      const next = await getCanvasStatus(refresh)
      setStatus(next)
      return next
    } catch (error) {
      setStatus({ credentialState: 'missing', recoveryActions: [error.message], ok: false })
      return null
    }
  }, [])

  const refreshTasks = useCallback(async () => {
    try {
      const result = await listImageTasks()
      setTasks(result.operations || [])
    } catch {
      setTasks([])
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([loadProject(controller.signal), getCanvasStatus(false).catch(() => null), listImageTasks().catch(() => ({ operations: [] }))])
      .then(([data, nextStatus, taskData]) => {
        setProject(data)
        projectRef.current = data
        setTheme(data.settings?.theme || 'light')
        themeRef.current = data.settings?.theme || 'light'
        setStatus(nextStatus)
        setTasks(taskData.operations || [])
        const initialPage = data.pages.find(page => page.id === data.activePageId) || data.pages[0]
        sceneRef.current = { elements: initialPage?.elements || [], appState: initialPage?.appState || {}, files: initialPage?.files || {} }
        sceneSignatureRef.current = scenePersistenceSignature(sceneRef.current)
        seedPageHistories(data)
        loadedRef.current = true
      })
      .catch(error => { if (!controller.signal.aborted) setLoadError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => () => window.clearTimeout(saveTimerRef.current), [])

  const persist = useCallback(async ({ immediate = false } = {}) => {
    if (!projectRef.current || !loadedRef.current) return
    window.clearTimeout(saveTimerRef.current)
    const commit = async () => {
      const current = projectRef.current
      const currentPage = current?.pages.find(page => page.id === current.activePageId)
      if (!current || !currentPage) return
      setSaveState('saving')
      const snapshot = sceneRef.current
      const next = {
        ...current,
        settings: { ...(current.settings || {}), theme: themeRef.current },
        pages: current.pages.map(page => page.id === currentPage.id
          ? { ...page, elements: snapshot.elements, appState: persistableAppState(snapshot.appState), files: snapshot.files }
          : page)
      }
      try {
        const saved = await saveProject(next)
        const committed = { ...next, revision: saved.revision || next.revision }
        projectRef.current = committed
        setProject(committed)
        setSaveState('saved')
      } catch (error) {
        setSaveState('error')
        showToast(error.message, 'error')
      }
    }
    if (immediate) await commit()
    else saveTimerRef.current = window.setTimeout(commit, 700)
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    setSaveState('dirty')
    persist()
  }, [theme, persist])

  useEffect(() => {
    const saveBeforeExit = () => { void persist({ immediate: true }) }
    window.addEventListener('pagehide', saveBeforeExit)
    return () => window.removeEventListener('pagehide', saveBeforeExit)
  }, [persist])

  useEffect(() => {
    const handleHistoryShortcut = event => {
      const target = event.target
      if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const redo = event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)
      const undo = event.key.toLowerCase() === 'z' && !event.shiftKey
      if (!undo && !redo) return
      event.preventDefault()
      event.stopImmediatePropagation()
      restorePageHistory(redo ? 1 : -1)
    }
    window.addEventListener('keydown', handleHistoryShortcut, true)
    return () => window.removeEventListener('keydown', handleHistoryShortcut, true)
  }, [])

  const onSceneChange = useCallback((elements, appState, files) => {
    sceneRef.current = { elements: [...elements], appState, files }
    const nextSelectionSignature = elements
      .filter(element => appState.selectedElementIds?.[element.id])
      .map(element => `${element.id}:${element.version || 0}`)
      .join('|')
    if (selectionSignatureRef.current !== nextSelectionSignature) {
      selectionSignatureRef.current = nextSelectionSignature
      setSelectionVersion(value => value + 1)
    }
    const nextSceneSignature = scenePersistenceSignature(sceneRef.current)
    if (sceneSignatureRef.current === nextSceneSignature) return
    sceneSignatureRef.current = nextSceneSignature
    if (!applyingHistoryRef.current) recordPageHistory({ elements: [...elements], appState, files })
    if (loadedRef.current) {
      setSaveState('dirty')
      persist()
    }
  }, [persist])

  const addElements = useCallback(elements => {
    const api = apiRef.current
    if (!api) return
    const current = api.getSceneElementsIncludingDeleted()
    const ids = Object.fromEntries(elements.map(element => [element.id, true]))
    api.updateScene({ elements: [...current, ...elements], appState: { selectedElementIds: ids }, captureUpdate: 'IMMEDIATELY' })
    api.scrollToContent(elements, { fitToContent: true, animate: true, maxZoom: 1.25 })
  }, [])

  const openHolderCreator = useCallback(() => {
    holderDialogReturnFocusRef.current = document.activeElement
    setHolderCreateOpen(true)
  }, [])

  const createHolder = useCallback(options => {
    const center = viewportCenter(apiRef.current)
    const { width, height } = options
    const { elements } = createImageHolder({ ...options, x: center.x - width / 2, y: center.y - height / 2 })
    addElements(elements)
    setHolderCreateOpen(false)
    setActivePanel('ai')
    setPanelOpen(true)
  }, [addElements])

  const createDraft = useCallback(() => {
    const center = viewportCenter(apiRef.current)
    const draft = createHtmlDraft({ x: center.x - 480, y: center.y - 270 })
    addElements(draft.elements)
    updatePageAppData(data => ({ ...data, htmlDrafts: { ...(data.htmlDrafts || {}), [draft.objectId]: { source: EMPTY_HTML, revision: 1, title: 'HTML Draft', entryFile: 'index.html' } } }))
    setActivePanel('html')
    setPanelOpen(true)
  }, [addElements, project, activePage])

  const openDeckCreator = useCallback(() => {
    deckDialogReturnFocusRef.current = document.activeElement
    setDeckCreateOpen(true)
  }, [])

  const createDeck = useCallback(options => {
    const center = viewportCenter(apiRef.current)
    const dimensions = slideDimensions(options)
    const result = createSlideDeck({ ...options, x: center.x - dimensions.width / 2, y: center.y - dimensions.height / 2 })
    addElements(result.elements)
    updatePageAppData(data => ({ ...data, decks: { ...(data.decks || {}), [result.deckId]: result.deck } }))
    setDeckCreateOpen(false)
    setActivePanel('slides')
    setPanelOpen(true)
  }, [addElements])

  function updatePageAppData(updater) {
    const next = {
      ...projectRef.current,
      pages: projectRef.current.pages.map(page => page.id === projectRef.current.activePageId ? { ...page, appData: updater(page.appData || {}) } : page)
    }
    projectRef.current = next
    setProject(next)
    const updatedPage = next.pages.find(page => page.id === next.activePageId)
    recordPageHistory({ ...sceneRef.current, appData: updatedPage?.appData || {} })
    setSaveState('dirty')
    persist()
  }

  function seedPageHistories(value) {
    for (const page of value?.pages || []) {
      if (historyByPageRef.current.has(page.id)) continue
      const snapshot = historySnapshot(page)
      historyByPageRef.current.set(page.id, { entries: [snapshot], index: 0, signature: historySignature(snapshot) })
    }
  }

  function recordPageHistory(snapshot) {
    const current = projectRef.current
    const page = current?.pages.find(item => item.id === current.activePageId)
    if (!page) return
    const value = historySnapshot({ ...page, ...snapshot, appData: snapshot.appData ?? page.appData })
    const signature = historySignature(value)
    let history = historyByPageRef.current.get(page.id)
    if (!history) {
      history = { entries: [], index: -1, signature: '' }
      historyByPageRef.current.set(page.id, history)
    }
    if (history.signature === signature) return
    const entries = history.entries.slice(0, history.index + 1)
    entries.push(value)
    if (entries.length > 40) entries.shift()
    history.entries = entries
    history.index = entries.length - 1
    history.signature = signature
    setHistoryVersion(version => version + 1)
  }

  function restorePageHistory(direction) {
    const current = projectRef.current
    const pageId = current?.activePageId
    const history = historyByPageRef.current.get(pageId)
    if (!history) return
    const targetIndex = history.index + direction
    if (targetIndex < 0 || targetIndex >= history.entries.length) return
    const snapshot = structuredClone(history.entries[targetIndex])
    history.index = targetIndex
    history.signature = historySignature(snapshot)
    applyingHistoryRef.current = true
    const next = {
      ...current,
      pages: current.pages.map(page => page.id === pageId ? { ...page, ...snapshot } : page)
    }
    projectRef.current = next
    setProject(next)
    sceneRef.current = { elements: snapshot.elements, appState: snapshot.appState, files: snapshot.files }
    sceneSignatureRef.current = scenePersistenceSignature(sceneRef.current)
    if (apiRef.current) {
      apiRef.current.addFiles(Object.values(snapshot.files || {}))
      apiRef.current.updateScene({ elements: snapshot.elements, appState: snapshot.appState, captureUpdate: 'NEVER' })
    }
    setHistoryVersion(version => version + 1)
    window.requestAnimationFrame(() => { applyingHistoryRef.current = false })
    setSaveState('dirty')
    persist()
  }

  function canRestoreHistory(direction) {
    void historyVersion
    const history = historyByPageRef.current.get(projectRef.current?.activePageId)
    const target = Number(history?.index ?? -1) + direction
    return Boolean(history && target >= 0 && target < history.entries.length)
  }

  async function switchPage(pageId) {
    if (pageId === project.activePageId) return
    await persist({ immediate: true })
    const next = { ...projectRef.current, activePageId: pageId }
    projectRef.current = next
    setProject(next)
    const nextPage = next.pages.find(page => page.id === pageId)
    sceneRef.current = { elements: nextPage?.elements || [], appState: nextPage?.appState || {}, files: nextPage?.files || {} }
    sceneSignatureRef.current = scenePersistenceSignature(sceneRef.current)
    setCanvasRevision(value => value + 1)
    setHistoryVersion(value => value + 1)
    await saveProjectAndRefreshRevision(next)
  }

  async function addPage() {
    await persist({ immediate: true })
    const page = emptyPage(`page_${crypto.randomUUID().replaceAll('-', '')}`, `Page ${project.pages.length + 1}`)
    const next = { ...projectRef.current, activePageId: page.id, pages: [...projectRef.current.pages, page] }
    projectRef.current = next
    setProject(next)
    sceneRef.current = { elements: [], appState: {}, files: {} }
    sceneSignatureRef.current = scenePersistenceSignature(sceneRef.current)
    setCanvasRevision(value => value + 1)
    seedPageHistories(next)
    setHistoryVersion(value => value + 1)
    await saveProjectAndRefreshRevision(next)
  }

  async function duplicatePage(page) {
    await persist({ immediate: true })
    const clone = duplicatePageData(page)
    const next = { ...projectRef.current, activePageId: clone.id, pages: [...projectRef.current.pages, clone] }
    projectRef.current = next
    setProject(next)
    sceneRef.current = { elements: clone.elements, appState: clone.appState, files: clone.files }
    sceneSignatureRef.current = scenePersistenceSignature(sceneRef.current)
    setCanvasRevision(value => value + 1)
    seedPageHistories(next)
    setHistoryVersion(value => value + 1)
    await saveProjectAndRefreshRevision(next)
  }

  async function renamePage(page) {
    const name = window.prompt('页面名称', page.name)?.trim()
    if (!name) return
    const next = { ...projectRef.current, pages: projectRef.current.pages.map(item => item.id === page.id ? { ...item, name: name.slice(0, 120) } : item) }
    projectRef.current = next
    setProject(next)
    await saveProjectAndRefreshRevision(next)
  }

  async function deletePage(page) {
    if (project.pages.length === 1) return showToast('项目至少保留一个页面。', 'warning')
    if (!window.confirm(`删除“${page.name}”？页面任务记录仍会保留。`)) return
    const index = project.pages.findIndex(item => item.id === page.id)
    const pages = project.pages.filter(item => item.id !== page.id)
    const activePageId = project.activePageId === page.id ? pages[Math.min(index, pages.length - 1)].id : project.activePageId
    const next = { ...projectRef.current, pages, activePageId }
    projectRef.current = next
    setProject(next)
    const selectedPage = pages.find(item => item.id === activePageId)
    sceneRef.current = { elements: selectedPage?.elements || [], appState: selectedPage?.appState || {}, files: selectedPage?.files || {} }
    sceneSignatureRef.current = scenePersistenceSignature(sceneRef.current)
    setCanvasRevision(value => value + 1)
    setHistoryVersion(value => value + 1)
    await saveProjectAndRefreshRevision(next)
  }

  async function movePage(page, direction) {
    await persist({ immediate: true })
    const pages = [...projectRef.current.pages]
    const index = pages.findIndex(item => item.id === page.id)
    const target = index + direction
    if (target < 0 || target >= pages.length) return
    ;[pages[index], pages[target]] = [pages[target], pages[index]]
    await saveProjectAndRefreshRevision({ ...projectRef.current, pages })
  }

  async function reorderPage(sourceId, targetId) {
    if (!sourceId || sourceId === targetId) return
    await persist({ immediate: true })
    const pages = [...projectRef.current.pages]
    const sourceIndex = pages.findIndex(page => page.id === sourceId)
    const targetIndex = pages.findIndex(page => page.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const [moved] = pages.splice(sourceIndex, 1)
    pages.splice(targetIndex, 0, moved)
    await saveProjectAndRefreshRevision({ ...projectRef.current, pages })
  }

  async function saveProjectAndRefreshRevision(value) {
    const saved = await saveProject(value)
    const committed = { ...value, revision: saved.revision || value.revision }
    projectRef.current = committed
    setProject(committed)
    return committed
  }

  async function exportScene(format = 'png', selectionOnly = false, scale = 2) {
    const api = apiRef.current
    if (!api) return
    const sceneElements = api.getSceneElements()
    const chosen = selectionOnly ? selectedElements(sceneElements, api.getAppState()) : sceneElements
    const chosenIds = new Set(chosen.map(element => element.id))
    const selectedFrameIds = new Set(chosen.filter(element => element.type === 'frame').map(element => element.id))
    const elements = selectionOnly
      ? sceneElements.filter(element => chosenIds.has(element.id) || selectedFrameIds.has(element.frameId))
      : sceneElements
    if (!elements.length) return showToast('没有可导出的内容。', 'warning')
    try {
      if (format === 'svg') {
        const svg = await exportToSvg({ elements, appState: { ...api.getAppState(), exportBackground: true }, files: api.getFiles(), exportPadding: 24 })
        downloadBlob(new Blob([svg.outerHTML], { type: 'image/svg+xml' }), `${activePage.name}.svg`)
      } else {
        const exportScale = [1, 2, 4].includes(Number(scale)) ? Number(scale) : 2
        const blob = await exportToBlob({ elements, appState: { ...api.getAppState(), exportBackground: true, exportScale }, files: api.getFiles(), mimeType: 'image/png', exportPadding: 24 })
        downloadBlob(blob, `${activePage.name}@${exportScale}x.png`)
      }
      showToast('导出完成。', 'success')
    } catch (error) {
      showToast(`导出失败：${error.message}`, 'error')
    }
  }

  async function exportProjectJson() {
    await persist({ immediate: true })
    const current = projectRef.current
    downloadBlob(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }), `${safeName(current.name)}.modellix-canvas.json`)
  }

  async function beginPresentation(deck) {
    const api = apiRef.current
    const frames = deck.slides.map(slide => api.getSceneElements().find(element => element.id === slide.id)).filter(Boolean)
    if (!frames.length) return showToast('演示文稿没有可播放的页面。', 'warning')
    setPresentation({ deck, frames, index: 0 })
  }

  function showToast(message, type = 'info') {
    setToast({ id: Date.now(), message, type })
    window.setTimeout(() => setToast(current => current?.message === message ? null : current), 3600)
  }

  function beginApiKeySetup() {
    setActivePanel('ai')
    setPanelOpen(true)
    showToast('请在右侧安全输入并保存 API Key。')
  }

  if (loading) return <LoadingScreen />
  if (loadError || !project || !activePage) return <ErrorScreen message={loadError || '项目无法打开。'} onRetry={() => window.location.reload()} />

  return (
    <div className={`modellix-app theme-${theme}`}>
      <AppHeader
        project={project}
        page={activePage}
        status={status}
        saveState={saveState}
        theme={theme}
        onTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}
        onStatus={() => refreshStatus(true)}
        onSetup={beginApiKeySetup}
        onFullscreen={() => requestFullscreen()}
        onExport={(format, scale) => exportScene(format, false, scale)}
        onExportProject={exportProjectJson}
        canUndo={canRestoreHistory(-1)}
        canRedo={canRestoreHistory(1)}
        onUndo={() => restorePageHistory(-1)}
        onRedo={() => restorePageHistory(1)}
      />

      <div className="workspace">
        <QuickRail
          active={activePanel}
          onPanel={panel => { setActivePanel(panel); setPanelOpen(true) }}
          onHolder={openHolderCreator}
          onHtml={createDraft}
          onSlides={openDeckCreator}
        />

        <main className="canvas-stage" aria-label="Modellix infinite canvas">
          {missingAssetCount > 0 && <div className="missing-assets-banner" role="alert"><AlertTriangle size={15} /><span>{missingAssetCount} 个项目图片资产缺失。画布已保留占位；恢复 `.modellix/canvas/assets/images/` 中对应文件后刷新。</span></div>}
          <Excalidraw
            key={`${activePage.id}:${canvasRevision}`}
            excalidrawAPI={api => { apiRef.current = api }}
            initialData={excalidrawInitialData}
            onChange={onSceneChange}
            langCode={project.settings?.language === 'en' ? 'en' : 'zh-CN'}
            theme={theme}
            name={project.name}
            autoFocus
            handleKeyboardGlobally
            objectsSnapModeEnabled
            UIOptions={EXCALIDRAW_UI_OPTIONS}
          />
          <SelectionActions
            selection={selected}
            businessObject={businessObject}
            onEdit={() => { setActivePanel('ai'); setPanelOpen(true) }}
            onHtml={() => { setActivePanel('html'); setPanelOpen(true) }}
            onExport={() => exportScene('png', true)}
          />
        </main>

        {panelOpen && (
          <Inspector
            panel={activePanel}
            project={project}
            page={activePage}
            status={status}
            tasks={tasks}
            api={apiRef.current}
            businessObject={businessObject}
            onClose={() => setPanelOpen(false)}
            onSetup={beginApiKeySetup}
            onRefreshStatus={() => refreshStatus(true)}
            onRefreshTasks={refreshTasks}
            onProjectReload={refreshProject}
            onToast={showToast}
            onUpdateAppData={updatePageAppData}
            onPresent={beginPresentation}
          />
        )}
        {!panelOpen && <button className="panel-reopen" onClick={() => setPanelOpen(true)} aria-label="打开侧边面板"><PanelRightOpen size={18} /></button>}
      </div>

      <PageBar
        pages={project.pages}
        activePageId={project.activePageId}
        onSwitch={switchPage}
        onAdd={addPage}
        onDuplicate={duplicatePage}
        onRename={renamePage}
        onDelete={deletePage}
        onMove={movePage}
        onReorder={reorderPage}
      />

      {presentation && <PresentationOverlay value={presentation} api={apiRef.current} onChange={setPresentation} onClose={() => setPresentation(null)} />}
      {holderCreateOpen && <HolderCreateDialog returnFocus={holderDialogReturnFocusRef.current} onCancel={() => setHolderCreateOpen(false)} onCreate={createHolder} />}
      {deckCreateOpen && <DeckCreateDialog returnFocus={deckDialogReturnFocusRef.current} onCancel={() => setDeckCreateOpen(false)} onCreate={createDeck} />}
      {toast && <Toast value={toast} />}
    </div>
  )
}

function AppHeader({ project, page, status, saveState, theme, onTheme, onStatus, onSetup, onFullscreen, onExport, onExportProject, canUndo, canRedo, onUndo, onRedo }) {
  const [menu, setMenu] = useState(false)
  const credential = status?.credentialState || 'missing'
  return (
    <header className="app-header">
      <div className="brand-block">
        <BrandIcon className="brand-icon" />
        <div><strong>Modellix Agent Canvas</strong><span>{project.name} / {page.name}</span></div>
      </div>
      <div className="header-actions">
        <span className={`save-indicator state-${saveState}`}>{saveState === 'saving' ? <LoaderCircle size={14} className="spin" /> : saveState === 'error' ? <AlertTriangle size={14} /> : <Check size={14} />}{saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : saveState === 'dirty' ? '待保存' : '已保存'}</span>
        <div className="history-actions" aria-label="页面历史"><button className="icon-button" disabled={!canUndo} onClick={onUndo} aria-label="撤销" title="撤销（Ctrl/Cmd+Z）"><RotateCcw size={17} /></button><button className="icon-button" disabled={!canRedo} onClick={onRedo} aria-label="重做" title="重做（Ctrl/Cmd+Shift+Z）"><RotateCw size={17} /></button></div>
        <button className={`credential-pill state-${credential}`} onClick={credential === 'valid' ? onStatus : onSetup}><KeyRound size={15} />{credential === 'valid' ? 'API Key 已配置' : credential === 'invalid' ? 'API Key 失效' : '配置 API Key'}</button>
        <button className="icon-button" onClick={onTheme} aria-label="切换主题" title="切换主题">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
        <button className="icon-button" onClick={onFullscreen} aria-label="全屏" title="全屏"><Maximize2 size={18} /></button>
        <button className="primary-button" onClick={() => onExport('png', 2)}><Download size={16} />导出</button>
        <div className="menu-anchor">
          <button className="icon-button" onClick={() => setMenu(value => !value)} aria-label="更多" title="更多"><MoreHorizontal size={18} /></button>
          {menu && <div className="dropdown"><button onClick={() => { onExport('png', 1); setMenu(false) }}><Download size={16} />当前页 PNG · 1x</button><button onClick={() => { onExport('png', 2); setMenu(false) }}><Download size={16} />当前页 PNG · 2x</button><button onClick={() => { onExport('png', 4); setMenu(false) }}><Download size={16} />当前页 PNG · 4x</button><button onClick={() => { onExport('svg'); setMenu(false) }}><FileImage size={16} />当前页 SVG</button><button onClick={() => { onExportProject(); setMenu(false) }}><Save size={16} />导出项目备份</button><a href="https://www.modellix.ai/console/api-key" target="_blank" rel="noreferrer"><ExternalLink size={16} />Modellix 控制台</a></div>}
        </div>
      </div>
    </header>
  )
}

function QuickRail({ active, onPanel, onHolder, onHtml, onSlides }) {
  return <aside className="quick-rail" aria-label="Modellix tools">
    <RailButton active={active === 'ai'} icon={Sparkles} label="AI 图片" onClick={() => onPanel('ai')} />
    <RailButton icon={ImagePlus} label="图片占位" onClick={onHolder} />
    <RailButton icon={Code2} label="HTML" onClick={onHtml} />
    <RailButton icon={Layers3} label="演示文稿" onClick={onSlides} />
    <RailButton active={active === 'tasks'} icon={ListTodo} label="任务" onClick={() => onPanel('tasks')} />
  </aside>
}

function RailButton({ active, icon: Icon, label, onClick }) {
  return <button className={active ? 'active' : ''} onClick={onClick}><Icon size={20} /><span>{label}</span></button>
}

function SelectionActions({ selection, businessObject, onEdit, onHtml, onExport }) {
  if (!selection.length) return null
  const hasImage = selection.some(element => element.type === 'image')
  const kind = businessKindOf(businessObject)
  return <div className="selection-actions">
    {hasImage && <button onClick={onEdit}><WandSparkles size={15} />编辑图片</button>}
    {kind === 'html-draft' && <button onClick={onHtml}><Code2 size={15} />编辑 HTML</button>}
    <button onClick={onExport}><Download size={15} />导出选择</button>
  </div>
}

function Inspector(props) {
  return <aside className="inspector">
    <div className="inspector-header"><div><span className="eyebrow">MODELLIX</span><h2>{panelTitle(props.panel)}</h2></div><button className="icon-button" onClick={props.onClose} aria-label="关闭面板"><PanelRightClose size={18} /></button></div>
    {props.panel === 'ai' && <ImagePanel {...props} />}
    {props.panel === 'html' && <HtmlPanel {...props} />}
    {props.panel === 'slides' && <SlidesPanel {...props} />}
    {props.panel === 'tasks' && <TasksPanel {...props} />}
  </aside>
}

function ImagePanel({ status, api, page, businessObject, onSetup, onRefreshStatus, onProjectReload, onRefreshTasks, onToast }) {
  const [form, setForm] = useState(DEFAULT_FORM)
  const [busy, setBusy] = useState(false)
  const [prepared, setPrepared] = useState(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [progress, setProgress] = useState('')
  const [referenceOrder, setReferenceOrder] = useState([])
  const confirmationReturnFocusRef = useRef(null)
  const scene = api ? { elements: api.getSceneElements(), appState: api.getAppState() } : { elements: [], appState: {} }
  const selection = selectedElements(scene.elements, scene.appState)
  const selectedReferenceElements = selectedImages(scene.elements, scene.appState)
  const selectedReferenceIds = selectedReferenceElements.map(element => element.id)
  const selectedReferenceSignature = selectedReferenceIds.join('|')
  useEffect(() => {
    setReferenceOrder(current => [...current.filter(id => selectedReferenceIds.includes(id)), ...selectedReferenceIds.filter(id => !current.includes(id))])
  }, [selectedReferenceSignature])
  const orderedIds = [...referenceOrder.filter(id => selectedReferenceIds.includes(id)), ...selectedReferenceIds.filter(id => !referenceOrder.includes(id))]
  const selectedReferenceMap = new Map(selectedReferenceElements.map(element => [element.id, element]))
  const references = orderedIds.map(id => selectedReferenceMap.get(id)).filter(Boolean).slice(0, 10)
  const holder = businessKindOf(businessObject) === 'image-holder' ? businessObject : null
  const mode = references.length ? 'edit' : 'generate'

  useEffect(() => {
    if (!holder) return
    const suggestedSize = closestCanvasImageSize(holder.width, holder.height)
    setForm(current => current.prompt || current.size === suggestedSize ? current : { ...current, size: suggestedSize })
  }, [holder?.id, holder?.width, holder?.height])

  function update(key, value) { setForm(current => ({ ...current, [key]: value })); setPrepared(null) }
  function moveReference(index, direction) {
    const target = index + direction
    if (target < 0 || target >= references.length) return
    const ids = references.map(element => element.id)
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    setReferenceOrder(ids)
    setPrepared(null)
  }

  async function prepare({ annotated = false } = {}) {
    if (!form.prompt.trim()) return onToast('请输入图片描述。', 'warning')
    if (status?.credentialState !== 'valid') return onSetup()
    setBusy(true)
    confirmationReturnFocusRef.current = document.activeElement
    setProgress('正在校验模型、规格与费用…')
    try {
      let sourceAssetIds = []
      let sourceObjectIds = references.map(objectIdOf)
      if (annotated && scene.elements.filter(element => scene.appState.selectedElementIds?.[element.id]).length > selectedReferenceElements.length) {
        const selected = selectedElements(scene.elements, scene.appState)
        const blob = await exportToBlob({ elements: selected, appState: { ...scene.appState, exportBackground: false }, files: api.getFiles(), mimeType: 'image/png', exportPadding: 32 })
        const asset = await saveAsset(blob, `annotation-${Date.now()}.png`)
        sourceAssetIds = [asset.assetId]
        sourceObjectIds = []
      }
      const intent = {
        ...form,
        mode: sourceObjectIds.length || sourceAssetIds.length ? 'edit' : 'generate',
        prompt: form.prompt.trim(),
        sourceObjectIds,
        sourceAssetIds,
        pageId: page.id,
        targetObjectId: objectIdOf(holder || references[0]),
        placementX: viewportCenter(api).x,
        placementY: viewportCenter(api).y
      }
      const result = await prepareImageTask(intent)
      setPrepared({ result, intent })
      setConfirmOpen(true)
      setProgress('')
    } catch (error) {
      onToast(error.message, 'error')
      setProgress('')
    } finally { setBusy(false) }
  }

  async function submit() {
    setConfirmOpen(false)
    setBusy(true)
    setProgress('正在提交付费任务，请勿重复操作…')
    try {
      const operationId = `op_${crypto.randomUUID().replaceAll('-', '')}`
      const submitted = await submitImageTask({
        ...prepared.intent,
        operationId,
        routeFingerprint: prepared.result.routeFingerprint,
        confirmedPaidSubmission: true
      })
      for (const task of submitted.tasks) {
        // Sequential polling keeps request volume predictable and preserves result order.
        // eslint-disable-next-line no-await-in-loop
        await pollAndFinalize(task.taskId, setProgress)
      }
      await onProjectReload()
      await onRefreshTasks()
      setForm(DEFAULT_FORM)
      setPrepared(null)
      onToast('图片已生成并保存到项目。', 'success')
    } catch (error) {
      onToast(error.code === 'SUBMISSION_UNKNOWN' ? `${error.message} 请在任务中心继续查询，不要重新提交。` : error.message, 'error')
      await onRefreshTasks()
    } finally { setBusy(false); setProgress('') }
  }

  return <div className="panel-body">
    {status?.credentialState !== 'valid' && <CredentialCard status={status} onRefresh={onRefreshStatus} />}
    <div className="context-card"><div><span>当前模式</span><strong>{mode === 'edit' ? `图片编辑 · ${references.length} 张参考图` : holder ? '占位符生成' : '文生图'}</strong></div>{references.length > 0 && <div className="reference-strip">{references.map((element, index) => <div key={element.id}><span>{index === 0 ? '主图' : `参考 ${index + 1}`}</span><button disabled={index === 0} onClick={() => moveReference(index, -1)} aria-label={`将参考图 ${index + 1} 前移`}>←</button><button disabled={index === references.length - 1} onClick={() => moveReference(index, 1)} aria-label={`将参考图 ${index + 1} 后移`}>→</button></div>)}</div>}{selectedReferenceElements.length > 10 && <small className="context-warning">一次最多使用 10 张，已按当前顺序取前 10 张。</small>}</div>
    <label className="field"><span>描述你想要的图片</span><textarea name="image-prompt" value={form.prompt} onChange={event => update('prompt', event.target.value)} rows={5} placeholder={mode === 'edit' ? '例如：保留主体与构图，把背景改成清晨的雪山…' : '例如：一张高级、克制的 AI 创作工作台产品主视觉…'} maxLength={32000} /></label>
    <div className="field-row">
      <label className="field"><span>尺寸</span><select name="image-size" value={form.size} onChange={event => update('size', event.target.value)}>{SIZE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label className="field"><span>数量</span><select name="image-count" value={form.count} onChange={event => update('count', Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    <details className="advanced"><summary>高级设置<ChevronDown size={16} /></summary><div className="field-row"><label className="field"><span>背景</span><select name="image-background" value={form.background} onChange={event => update('background', event.target.value)}><option value="opaque">不透明</option><option value="transparent">透明</option><option value="auto">自动</option></select></label><label className="field"><span>质量</span><select name="image-quality" value={form.quality} onChange={event => update('quality', event.target.value)}><option value="low">快速</option><option value="medium">标准</option><option value="high">高质量</option></select></label></div>{holder && <label className="field"><span>占位适配</span><select name="holder-fit-policy" value={form.fitPolicy} onChange={event => update('fitPolicy', event.target.value)}><option value="contain">完整显示（保持比例）</option><option value="exact">铺满占位区（可能拉伸）</option></select></label>}{mode === 'edit' && <label className="switch-row"><input name="strict-input-fidelity" type="checkbox" checked={form.inputFidelity === 'strict'} onChange={event => update('inputFidelity', event.target.checked ? 'strict' : 'standard')} /><span><strong>严格输入保真</strong><small>尽量保留主体身份、结构与细节</small></span></label>}</details>
    {progress && <div className="progress-line"><LoaderCircle size={16} className="spin" />{progress}</div>}
    <div className="panel-actions">
      {mode === 'edit' && selection.length > selectedReferenceElements.length && <button className="secondary-button" disabled={busy} onClick={() => prepare({ annotated: true })}>按标注编辑</button>}
      <button className="primary-button grow" disabled={busy || !form.prompt.trim()} onClick={() => prepare()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{mode === 'edit' ? '准备编辑' : '准备生成'}</button>
    </div>
    {confirmOpen && prepared && <PaidConfirmation prepared={prepared.result} returnFocus={confirmationReturnFocusRef.current} onCancel={() => setConfirmOpen(false)} onConfirm={submit} />}
  </div>
}

function PaidConfirmation({ prepared, returnFocus, onCancel, onConfirm }) {
  const price = prepared.pricing || {}
  const total = price.estimatedTotalUsd ?? price.total ?? price.price
  const unit = price.unitPriceUsd
  const dialogRef = useRef(null)
  const [submitting, setSubmitting] = useState(false)
  useModalFocus(dialogRef, () => { if (!submitting) onCancel() }, returnFocus)
  function confirmOnce() {
    if (submitting) return
    setSubmitting(true)
    onConfirm()
  }
  return <div className="modal-backdrop"><section ref={dialogRef} className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" tabIndex={-1}><div className="confirm-icon"><CircleDollarSign size={24} /></div><h3 id="confirm-title">确认付费图片任务</h3><p>提交后会创建 {prepared.taskCount} 个付费任务。模型、输入或规格变化时必须重新确认。</p><dl><div><dt>实际模型</dt><dd>{prepared.modelDisplayName || prepared.modelSlug}</dd></div><div><dt>路由原因</dt><dd>{routeReason(prepared.routeReasonCode)}</dd></div><div><dt>输入图片</dt><dd>{prepared.referenceCount ? `${prepared.referenceCount} 张（第 1 张为主图）` : '无 · 文生图'}</dd></div><div><dt>请求规格</dt><dd>{formatOutputSpec(prepared.requestedOutput, prepared.taskCount)}</dd></div><div><dt>实际规格</dt><dd>{formatOutputSpec(prepared.effectiveOutput, prepared.taskCount)}</dd></div><div><dt>单价</dt><dd>{unit === undefined || unit === null ? '暂无法估算' : `$${Number(unit).toFixed(4)} ${price.currency || 'USD'}`}</dd></div><div><dt>预计总价</dt><dd>{total === undefined || total === null ? '以 Modellix 实际计费为准' : `$${Number(total).toFixed(4)} ${price.currency || 'USD'}`}</dd></div><div><dt>确认有效期</dt><dd>{formatExpiry(prepared.expiresAt)}</dd></div></dl>{prepared.capabilityWarnings?.map(item => <div className="warning-note" key={item}><AlertTriangle size={15} />{item}</div>)}<div className="modal-actions"><button className="secondary-button" disabled={submitting} onClick={onCancel}>返回修改</button><button className="primary-button" disabled={submitting} onClick={confirmOnce}>{submitting ? <LoaderCircle size={16} className="spin" /> : null}确认并提交</button></div></section></div>
}

function HolderCreateDialog({ returnFocus, onCancel, onCreate }) {
  const dialogRef = useRef(null)
  const [form, setForm] = useState({ ratio: '1:1', width: 512, height: 512 })
  useModalFocus(dialogRef, onCancel, returnFocus)
  function updateRatio(ratio) {
    const preset = HOLDER_RATIO_OPTIONS.find(item => item[0] === ratio)
    setForm(current => preset ? { ratio, width: preset[1], height: preset[2] } : { ...current, ratio })
  }
  function submit(event) {
    event.preventDefault()
    const width = Math.max(160, Math.min(4096, Number(form.width) || 512))
    const height = Math.max(160, Math.min(4096, Number(form.height) || 512))
    onCreate({ ratio: form.ratio === 'custom' ? `${width}:${height}` : form.ratio, width, height })
  }
  return <div className="modal-backdrop"><form ref={dialogRef} className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="holder-create-title" tabIndex={-1} onSubmit={submit}><span className="eyebrow">AI 图片占位</span><h3 id="holder-create-title">选择目标画幅</h3><p>模型会参考该画幅选择尺寸；生成后默认完整显示并保持原图比例。</p><label className="field"><span>比例</span><select name="holder-ratio" autoFocus value={form.ratio} onChange={event => updateRatio(event.target.value)}>{HOLDER_RATIO_OPTIONS.map(([value]) => <option key={value} value={value}>{value}</option>)}<option value="custom">自定义</option></select></label>{form.ratio === 'custom' && <div className="field-row"><label className="field"><span>宽度</span><input name="holder-width" type="number" min="160" max="4096" value={form.width} onChange={event => setForm(current => ({ ...current, width: event.target.value }))} /></label><label className="field"><span>高度</span><input name="holder-height" type="number" min="160" max="4096" value={form.height} onChange={event => setForm(current => ({ ...current, height: event.target.value }))} /></label></div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button type="submit" className="primary-button"><ImagePlus size={16} />创建占位</button></div></form></div>
}

function DeckCreateDialog({ returnFocus, onCancel, onCreate }) {
  const dialogRef = useRef(null)
  const [form, setForm] = useState({ title: 'Untitled Deck', ratio: '16:9', customWidth: 1600, customHeight: 900, template: 'starter', count: 5 })
  useModalFocus(dialogRef, onCancel, returnFocus)
  function update(key, value) { setForm(current => ({ ...current, [key]: value })) }
  function submit(event) {
    event.preventDefault()
    const title = form.title.trim()
    if (!title) return
    onCreate({ ...form, title, count: Number(form.count), customWidth: Number(form.customWidth), customHeight: Number(form.customHeight) })
  }
  return <div className="modal-backdrop"><form ref={dialogRef} className="confirm-modal deck-create-modal" role="dialog" aria-modal="true" aria-labelledby="deck-create-title" tabIndex={-1} onSubmit={submit}><span className="eyebrow">演示文稿</span><h3 id="deck-create-title">快速创建一套可编辑幻灯片</h3><p>选择比例和模板后即可开始；所有内容仍是普通画布元素。</p><label className="field"><span>标题</span><input name="deck-title" autoFocus value={form.title} maxLength={120} onChange={event => update('title', event.target.value)} /></label><div className="field-row"><label className="field"><span>比例</span><select name="deck-ratio" value={form.ratio} onChange={event => update('ratio', event.target.value)}><option value="16:9">16:9</option><option value="4:3">4:3</option><option value="custom">自定义</option></select></label><label className="field"><span>页数</span><input name="deck-count" type="number" min="1" max="12" value={form.count} onChange={event => update('count', event.target.value)} /></label></div>{form.ratio === 'custom' && <div className="field-row"><label className="field"><span>宽度</span><input name="deck-width" type="number" min="320" max="7680" value={form.customWidth} onChange={event => update('customWidth', event.target.value)} /></label><label className="field"><span>高度</span><input name="deck-height" type="number" min="240" max="7680" value={form.customHeight} onChange={event => update('customHeight', event.target.value)} /></label></div>}<label className="field"><span>布局模板</span><select name="deck-template" value={form.template} onChange={event => update('template', event.target.value)}>{SLIDE_TEMPLATE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button type="submit" className="primary-button" disabled={!form.title.trim()}><Layers3 size={16} />创建演示文稿</button></div></form></div>
}

function CredentialCard({ status, onRefresh }) {
  const [setupUrl, setSetupUrl] = useState('')
  const [setupError, setSetupError] = useState('')
  const [loading, setLoading] = useState(true)
  const requestIdRef = useRef(0)

  const createSetup = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setSetupUrl('')
    setSetupError('')
    try {
      const result = await startApiKeySetup()
      if (requestId !== requestIdRef.current) return
      const separator = result.setupUrl.includes('?') ? '&' : '?'
      setSetupUrl(`${result.setupUrl}${separator}embedded=1`)
    } catch (error) {
      if (requestId === requestIdRef.current) setSetupError(error.message)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    createSetup()
    return () => { requestIdRef.current += 1 }
  }, [createSetup])

  return <section className="credential-card">
    <div className="credential-card-icon"><KeyRound size={20} /></div>
    <div className="credential-card-body">
      <strong>{status?.credentialState === 'invalid' ? 'API Key 已失效，请重新配置' : '配置 Modellix API Key'}</strong>
      <p>Key 仅提交给本机 CLI 并保存到系统凭证库，不进入画布或 MCP 参数。</p>
      {loading && <div className="credential-setup-loading"><LoaderCircle size={16} className="spin" />正在准备安全输入框…</div>}
      {setupError && <div className="credential-setup-error" role="alert"><AlertTriangle size={15} /><span>{setupError}</span></div>}
      {setupUrl && !loading && <iframe
        className="credential-setup-frame"
        title="安全配置 Modellix API Key"
        src={setupUrl}
        sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        onLoad={() => { window.setTimeout(() => onRefresh(), 250) }}
      />}
      <div className="credential-setup-actions">
        <button className="link-button" onClick={createSetup}><RefreshCw size={14} />输入框失效？重新生成</button>
      </div>
    </div>
  </section>
}

function HtmlPanel({ page, businessObject, onUpdateAppData, onToast, api }) {
  const objectId = businessKindOf(businessObject) === 'html-draft' ? objectIdOf(businessObject) : null
  const draft = objectId ? page.appData?.htmlDrafts?.[objectId] : null
  const [source, setSource] = useState(draft?.source || EMPTY_HTML)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [capturing, setCapturing] = useState(false)
  useEffect(() => setSource(draft?.source || EMPTY_HTML), [objectId, draft?.revision])
  if (!objectId) return <EmptyPanel icon={Code2} title="选择一个 HTML 草稿" description="使用左侧 HTML 工具创建草稿，或在画布中选择已有草稿。" />
  function save() {
    const revision = Number(draft?.revision || 0) + 1
    onUpdateAppData(data => ({ ...data, htmlDrafts: { ...(data.htmlDrafts || {}), [objectId]: { ...(draft || {}), source, revision } } }))
    onToast('HTML 草稿已保存。', 'success')
  }
  async function capture() {
    setCapturing(true)
    try {
      const blob = await captureHtmlDraft(source)
      const dataURL = await blobToDataUrl(blob)
      const fileId = modelId('file')
      const center = viewportCenter(api)
      const width = 960
      const height = 540
      api.addFiles([{ id: fileId, dataURL, mimeType: 'image/png', created: Date.now(), lastRetrieved: Date.now() }])
      const { element } = createCanvasImage({ fileId, x: center.x - width / 2, y: center.y - height / 2, width, height, kind: 'html-screenshot' })
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], appState: { selectedElementIds: { [element.id]: true } }, captureUpdate: 'IMMEDIATELY' })
      api.scrollToContent([element], { fitToContent: true, animate: true, maxZoom: 1.2 })
      onToast('HTML 截图已插入画布。', 'success')
    } catch (error) {
      onToast(`截图失败：${error.message}`, 'error')
    } finally { setCapturing(false) }
  }
  function exportZip() {
    const archive = zipSync({ 'index.html': strToU8(source) }, { level: 6 })
    downloadBlob(new Blob([archive], { type: 'application/zip' }), `${safeName(draft?.title || 'html-draft')}.zip`)
  }
  const safeSource = withPreviewCsp(source)
  return <div className="panel-body html-panel"><div className="html-tabs"><span>源码</span><div><button onClick={() => setPreviewRevision(value => value + 1)}><RefreshCw size={14} />刷新</button><button onClick={save}><Save size={15} />保存</button></div></div><textarea name="html-source" className="code-editor" value={source} onChange={event => setSource(event.target.value)} spellCheck="false" aria-label="HTML source" /><div className="preview-header"><span>安全预览</span><small>沙箱 · 无脚本与外部网络</small></div><iframe key={previewRevision} title="HTML 草稿预览" sandbox="" srcDoc={safeSource} /><div className="panel-actions"><button className="secondary-button" disabled={capturing || !api} onClick={capture}>{capturing ? <LoaderCircle size={16} className="spin" /> : <FileImage size={16} />}生成截图</button><button className="secondary-button grow" onClick={exportZip}><Download size={16} />导出源码 ZIP</button></div></div>
}

function SlidesPanel({ page, businessObject, onPresent, api, onUpdateAppData, onToast }) {
  const [newTemplate, setNewTemplate] = useState('title-content')
  const meta = businessObject?.customData?.modellix
  const deckId = meta?.deckId || (meta?.kind === 'slide-deck' ? meta.objectId : null)
  const deck = deckId ? page.appData?.decks?.[deckId] : null
  if (!deck) return <EmptyPanel icon={Layers3} title="选择一套演示文稿" description="使用左侧演示文稿工具创建，然后选择任意幻灯片。" />
  const selectedSlideId = meta?.kind === 'slide' || meta?.kind === 'slide-content' ? businessObject?.frameId || businessObject?.id : null
  function updateDeck(updater) {
    onUpdateAppData(data => ({ ...data, decks: { ...(data.decks || {}), [deckId]: { ...updater(deck), revision: Number(deck.revision || 0) + 1 } } }))
  }
  function addSlide() {
    const frames = deck.slides.map(slide => api.getSceneElements().find(element => element.id === slide.id)).filter(Boolean)
    const right = frames.length ? Math.max(...frames.map(frame => frame.x + frame.width)) + 80 : 120
    const top = frames[0]?.y || 120
    const result = createSlideForDeck({ deckId, x: right, y: top, order: deck.slides.length, ratio: deck.ratio, customWidth: deck.customWidth, customHeight: deck.customHeight, template: newTemplate })
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...result.elements], appState: { selectedElementIds: { [result.slide.id]: true } }, captureUpdate: 'IMMEDIATELY' })
    api.scrollToContent(result.elements, { fitToContent: true, animate: true, maxZoom: 1.1 })
    updateDeck(value => ({ ...value, slides: [...value.slides, result.slide] }))
  }
  function duplicateSlide(slide) {
    const frames = deck.slides.map(item => api.getSceneElements().find(element => element.id === item.id)).filter(Boolean)
    const right = Math.max(...frames.map(frame => frame.x + frame.width)) + 80
    const top = frames[0]?.y || 120
    const result = duplicateSlideForDeck({ deckId, slide, elements: api.getSceneElements(), x: right, y: top, order: deck.slides.length, ratio: deck.ratio, customWidth: deck.customWidth, customHeight: deck.customHeight })
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...result.elements], appState: { selectedElementIds: { [result.slide.id]: true } }, captureUpdate: 'IMMEDIATELY' })
    api.scrollToContent(result.elements, { fitToContent: true, animate: true, maxZoom: 1.1 })
    updateDeck(value => ({ ...value, slides: [...value.slides, result.slide] }))
  }
  function removeSlide(slide) {
    if (deck.slides.length === 1) return onToast('演示文稿至少保留一张幻灯片。', 'warning')
    if (!window.confirm(`删除“${slide.name}”？`)) return
    const now = Date.now()
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(element => element.id === slide.id || element.frameId === slide.id ? { ...element, isDeleted: true, updated: now, version: Number(element.version || 1) + 1 } : element), captureUpdate: 'IMMEDIATELY' })
    updateDeck(value => ({ ...value, slides: value.slides.filter(item => item.id !== slide.id).map((item, order) => ({ ...item, order })) }))
  }
  function moveSlide(index, direction) {
    const target = index + direction
    if (target < 0 || target >= deck.slides.length) return
    const slides = [...deck.slides]
    ;[slides[index], slides[target]] = [slides[target], slides[index]]
    const ordered = slides.map((slide, order) => ({ ...slide, order }))
    const orderByFrame = new Map(ordered.map(slide => [slide.id, slide.order]))
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(element => {
      const frameId = element.type === 'frame' ? element.id : element.frameId
      if (!orderByFrame.has(frameId)) return element
      return { ...element, customData: { ...(element.customData || {}), modellix: { ...(element.customData?.modellix || {}), order: orderByFrame.get(frameId) } }, updated: Date.now(), version: Number(element.version || 1) + 1 }
    }), captureUpdate: 'IMMEDIATELY' })
    updateDeck(value => ({ ...value, slides: ordered }))
  }
  function renameDeck(title) {
    const value = title.trim().slice(0, 120)
    if (value && value !== deck.title) updateDeck(current => ({ ...current, title: value }))
  }
  function renameSlide(slide, name) {
    const value = name.trim().slice(0, 120)
    if (!value || value === slide.name) return
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map(element => element.id === slide.id ? { ...element, name: value, updated: Date.now(), version: Number(element.version || 1) + 1 } : element), captureUpdate: 'IMMEDIATELY' })
    updateDeck(current => ({ ...current, slides: current.slides.map(item => item.id === slide.id ? { ...item, name: value } : item) }))
  }
  async function exportDeck() {
    try {
      const files = {}
      for (const [index, slide] of deck.slides.entries()) {
        const frame = api.getSceneElements().find(element => element.id === slide.id)
        if (!frame) continue
        const elements = api.getSceneElements().filter(element => element.id === frame.id || element.frameId === frame.id)
        // eslint-disable-next-line no-await-in-loop
        const blob = await exportToBlob({ elements, appState: { ...api.getAppState(), exportBackground: true }, files: api.getFiles(), mimeType: 'image/png', exportingFrame: frame, exportPadding: 0 })
        // eslint-disable-next-line no-await-in-loop
        files[`${String(index + 1).padStart(3, '0')}-${safeName(slide.name)}.png`] = new Uint8Array(await blob.arrayBuffer())
      }
      downloadBlob(new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), `${safeName(deck.title)}-png.zip`)
      onToast('演示文稿 PNG 序列已导出。', 'success')
    } catch (error) { onToast(`导出失败：${error.message}`, 'error') }
  }
  return <div className="panel-body"><section className="deck-card"><span className="eyebrow">{deck.ratio === 'custom' ? `${deck.customWidth}:${deck.customHeight}` : deck.ratio}</span><input name="deck-title-editor" className="deck-title-input" defaultValue={deck.title} key={`${deck.id}:${deck.title}`} onBlur={event => renameDeck(event.target.value)} aria-label="演示文稿标题" /><p>{deck.slides.length} 张幻灯片 · revision {deck.revision}</p><div className="panel-actions"><button className="primary-button" onClick={() => onPresent(deck)}><Play size={16} />播放</button><button className="secondary-button" onClick={exportDeck}><Download size={16} />PNG 序列</button></div><div className="add-slide-row"><select name="new-slide-template" value={newTemplate} onChange={event => setNewTemplate(event.target.value)} aria-label="新幻灯片模板">{SLIDE_TEMPLATE_OPTIONS.filter(([value]) => value !== 'starter').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="secondary-button" onClick={addSlide}><Plus size={16} />新增</button></div></section><div className="slide-list">{deck.slides.map((slide, index) => <div key={slide.id} className={slide.id === selectedSlideId ? 'active' : ''}><button className="slide-thumbnail" onClick={() => { const frame = api.getSceneElements().find(element => element.id === slide.id); if (frame) { api.updateScene({ appState: { selectedElementIds: { [frame.id]: true } } }); api.scrollToContent([frame], { fitToContent: true, animate: true }) } }} aria-label={`选择第 ${index + 1} 张幻灯片`}><span>{index + 1}</span><SlideThumbnail api={api} slide={slide} signature={slideSceneSignature(api, slide.id)} /></button><div className="slide-details"><input name={`slide-${index + 1}-name`} defaultValue={slide.name} key={`${slide.id}:${slide.name}`} onBlur={event => renameSlide(slide, event.target.value)} aria-label={`第 ${index + 1} 张幻灯片名称`} /><small>{slide.template || '自定义布局'}</small></div><div className="slide-actions"><button disabled={index === 0} onClick={() => moveSlide(index, -1)} aria-label="前移幻灯片">↑</button><button disabled={index === deck.slides.length - 1} onClick={() => moveSlide(index, 1)} aria-label="后移幻灯片">↓</button><button onClick={() => duplicateSlide(slide)} aria-label="复制幻灯片"><Copy size={13} /></button><button onClick={() => removeSlide(slide)} aria-label="删除幻灯片"><Trash2 size={13} /></button></div></div>)}</div></div>
}

function SlideThumbnail({ api, slide, signature }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!api) return undefined
    let active = true
    let objectUrl = ''
    const timer = window.setTimeout(async () => {
      const frame = api.getSceneElements().find(element => element.id === slide.id)
      if (!frame) return
      const elements = api.getSceneElements().filter(element => element.id === frame.id || element.frameId === frame.id)
      try {
        const blob = await exportToBlob({ elements, appState: { ...api.getAppState(), exportBackground: true, exportScale: 0.3 }, files: api.getFiles(), mimeType: 'image/png', exportingFrame: frame, exportPadding: 0 })
        objectUrl = URL.createObjectURL(blob)
        if (active) setUrl(objectUrl)
      } catch { /* Keep the numbered fallback when preview generation fails. */ }
    }, 120)
    return () => { active = false; window.clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [api, slide.id, signature])
  return url ? <img src={url} alt="" /> : <span className="slide-thumbnail-placeholder">{slide.name.slice(0, 1)}</span>
}

function TasksPanel({ tasks, onRefreshTasks, onProjectReload, onToast }) {
  const [busyTaskId, setBusyTaskId] = useState('')
  async function resume(task) {
    if (!task.taskId) return
    setBusyTaskId(task.taskId)
    try {
      const state = await getImageTask(task.taskId)
      if (state.status === 'success') {
        await finalizeImageTask(task.taskId)
        await onProjectReload()
        onToast('任务结果已恢复并保存到画布。', 'success')
      } else if (state.status === 'failed') onToast('任务已明确失败，不会重新提交。', 'error')
      else onToast(`任务仍在${statusText(state.status)}，稍后可继续查询。`, 'info')
      await onRefreshTasks()
    } catch (error) { onToast(error.message, 'error') } finally { setBusyTaskId('') }
  }
  return <div className="panel-body"><div className="task-toolbar"><span>{tasks.length} 个操作</span><button className="icon-button" onClick={onRefreshTasks} aria-label="刷新任务" title="刷新任务"><RefreshCw size={16} /></button></div>{tasks.length === 0 ? <EmptyPanel icon={ListTodo} title="暂无图片任务" description="生成或编辑图片后，可在这里查看状态并恢复。" /> : <div className="task-list">{tasks.map(operation => <article key={operation.operationId}><div><strong>{operation.modelSlug}</strong><StatusBadge value={operation.status} /></div><small>{operation.operationId}</small><div className="task-resources">{operation.tasks.map(task => <div key={task.ordinal}><span>#{task.ordinal} {statusText(task.status)}</span>{task.taskId && !['cancelled', 'failed', 'finalized'].includes(task.status) && <button disabled={busyTaskId === task.taskId} onClick={() => resume(task)}>{busyTaskId === task.taskId ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}查询并恢复</button>}</div>)}</div></article>)}</div>}</div>
}

function PageBar({ pages, activePageId, onSwitch, onAdd, onDuplicate, onRename, onDelete, onMove, onReorder }) {
  return <nav className="page-bar" aria-label="Canvas pages"><div className="page-scroll">{pages.map((page, index) => <PageTab key={page.id} page={page} index={index} count={pages.length} active={page.id === activePageId} onSwitch={onSwitch} onDuplicate={onDuplicate} onRename={onRename} onDelete={onDelete} onMove={onMove} onReorder={onReorder} />)}</div><button className="add-page" onClick={onAdd}><Plus size={17} />新页面</button></nav>
}

function PageTab({ page, index, count, active, onSwitch, onDuplicate, onRename, onDelete, onMove, onReorder }) {
  const [menu, setMenu] = useState(false)
  return <div className={`page-tab ${active ? 'active' : ''}`} draggable onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/modellix-page-id', page.id) }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDrop={event => { event.preventDefault(); onReorder(event.dataTransfer.getData('text/modellix-page-id'), page.id) }}><button onClick={() => onSwitch(page.id)}><PageThumbnail page={page} /><span className="page-number">{index + 1}</span><span className="page-name">{page.name}</span></button><button className="page-menu" onClick={() => setMenu(value => !value)} aria-label="页面菜单" title="页面菜单"><MoreHorizontal size={15} /></button>{menu && <div className="dropdown page-dropdown"><button onClick={() => { onRename(page); setMenu(false) }}>重命名</button><button onClick={() => { onDuplicate(page); setMenu(false) }}><Copy size={14} />复制页面</button><button disabled={index === 0} onClick={() => { onMove(page, -1); setMenu(false) }}>向前移动</button><button disabled={index === count - 1} onClick={() => { onMove(page, 1); setMenu(false) }}>向后移动</button><button className="danger" onClick={() => { onDelete(page); setMenu(false) }}><Trash2 size={14} />删除页面</button></div>}</div>
}

function PageThumbnail({ page }) {
  const [url, setUrl] = useState('')
  const signature = (page.elements || []).map(element => `${element.id}:${element.version || 0}:${element.isDeleted ? 1 : 0}`).join('|')
  useEffect(() => {
    let active = true
    let objectUrl = ''
    const timer = window.setTimeout(async () => {
      const elements = (page.elements || []).filter(element => !element.isDeleted)
      if (!elements.length) return
      try {
        const blob = await exportToBlob({ elements, appState: { ...(page.appState || {}), exportBackground: true, exportScale: 0.12 }, files: page.files || {}, mimeType: 'image/png', exportPadding: 8 })
        objectUrl = URL.createObjectURL(blob)
        if (active) setUrl(objectUrl)
      } catch { /* The numbered placeholder remains usable when a thumbnail cannot be rendered. */ }
    }, 180)
    return () => { active = false; window.clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [page.id, signature])
  return <span className="page-thumbnail" aria-hidden="true">{url ? <img src={url} alt="" /> : <FileImage size={15} />}</span>
}

function PresentationOverlay({ value, api, onChange, onClose }) {
  const frame = value.frames[value.index]
  const [url, setUrl] = useState('')
  const dialogRef = useRef(null)
  useModalFocus(dialogRef, onClose)
  useEffect(() => {
    let active = true
    let objectUrl = ''
    const children = api.getSceneElements().filter(element => element.id === frame.id || element.frameId === frame.id)
    exportToBlob({ elements: children, appState: { ...api.getAppState(), exportBackground: true }, files: api.getFiles(), mimeType: 'image/png', exportingFrame: frame, exportPadding: 0 })
      .then(blob => { objectUrl = URL.createObjectURL(blob); if (active) setUrl(objectUrl) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [frame.id])
  useEffect(() => {
    const handler = event => {
      if (event.key === 'ArrowRight') onChange(current => ({ ...current, index: Math.min(current.frames.length - 1, current.index + 1) }))
      if (event.key === 'ArrowLeft') onChange(current => ({ ...current, index: Math.max(0, current.index - 1) }))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onChange])
  return <div ref={dialogRef} className="presentation" role="dialog" aria-modal="true" aria-label="幻灯片播放" tabIndex={-1}><button className="presentation-close" onClick={onClose} aria-label="退出播放" title="退出播放（Esc）"><X size={20} /></button><div className="presentation-canvas">{url ? <img src={url} alt={`Slide ${value.index + 1}`} /> : <LoaderCircle className="spin" />}</div><div className="presentation-controls"><button disabled={value.index === 0} onClick={() => onChange({ ...value, index: value.index - 1 })}>上一页</button><span>{value.index + 1} / {value.frames.length}</span><button disabled={value.index === value.frames.length - 1} onClick={() => onChange({ ...value, index: value.index + 1 })}>下一页</button></div></div>
}

function EmptyPanel({ icon: Icon, title, description }) { return <div className="empty-panel"><div><Icon size={24} /></div><h3>{title}</h3><p>{description}</p></div> }
function StatusBadge({ value }) { return <span className={`status-badge status-${value}`}>{statusText(value)}</span> }
function Toast({ value }) { return <div className={`toast toast-${value.type}`} role={value.type === 'error' ? 'alert' : 'status'} aria-live={value.type === 'error' ? 'assertive' : 'polite'}>{value.type === 'error' || value.type === 'warning' ? <AlertTriangle size={17} /> : <Check size={17} />}{value.message}</div> }
function BrandIcon({ className = '' }) { return <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M7.24776 2.14111C7.56867 2.18876 7.72758 2.81129 7.90712 3.10753C8.79035 4.56465 10.344 6.75443 11.4241 8.07286C11.4563 8.11206 12.4111 9.28371 14.2885 11.5878C10.3977 16.7247 7.94428 20.0667 6.92819 21.6137C6.44815 21.9052 5.82367 21.954 5.29133 21.9814C4.30723 22.0321 3.05888 21.9713 2.08765 21.8625C1.37577 21.7827 1.41062 21.2729 1.67039 20.7384C4.04588 17.649 6.7121 14.7744 9.04892 11.6535C7.95851 10.6355 7.11091 9.35171 6.14795 8.20582C5.67371 7.64153 3.95406 5.50583 3.39811 5.35456C2.96035 5.23553 2.30233 5.4273 2.15735 4.90055C2.13763 4.8288 2.05231 4.40561 2.05231 4.36772V2.14111H7.24776Z" fill="#605AFF"/><path fillRule="evenodd" clipRule="evenodd" d="M12.9937 7.06477C14.7553 5.02952 15.7433 3.42524 16.7497 2.12349C16.7838 2.08277 16.8918 2 16.929 2H22.0184C22.1772 2 22.1295 2.85601 22.1237 3.02424C22.1135 3.32296 22.0776 3.77732 22.0446 4.07611C22.0273 4.23304 21.8925 5.12806 21.8298 5.16962C21.2543 5.3187 20.3834 5.18751 19.8975 5.53394C19.7807 5.61721 18.6555 7.16611 15.7299 10.3091L12.9937 7.06477Z" fill="currentColor"/><path fillRule="evenodd" clipRule="evenodd" d="M12.9937 16.0059C15.2729 18.3659 16.5441 20.231 17.6255 21.6142C18.1055 21.9057 18.73 21.9545 19.2624 21.982C20.2464 22.0326 21.4948 21.9718 22.466 21.863C23.1779 21.7832 23.1431 21.2735 22.8833 20.7389C21.2996 18.6793 19.1614 16.4987 15.6502 12.9919L12.9937 16.0059Z" fill="currentColor"/></svg> }
function LoadingScreen() { return <div className="loading-screen"><BrandIcon className="brand-icon" /><LoaderCircle className="spin" /><strong>正在打开 Modellix Agent Canvas</strong><span>加载项目、凭证与任务状态…</span></div> }
function ErrorScreen({ message, onRetry }) { return <div className="loading-screen error"><AlertTriangle size={32} /><strong>画布无法打开</strong><span>{message}</span><button className="primary-button" onClick={onRetry}><RefreshCw size={16} />重新加载</button></div> }

async function pollAndFinalize(taskId, onProgress) {
  const started = Date.now()
  let retryDelay = 2500
  while (Date.now() - started < 30 * 60 * 1000) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const task = await getImageTask(taskId)
      retryDelay = 2500
      onProgress(`任务 ${taskId.slice(0, 10)}… ${statusText(task.status)}`)
      if (task.status === 'success') return finalizeImageTask(taskId)
      if (task.status === 'failed' || task.status === 'cancelled') throw new Error(`图片任务 ${taskId} ${task.status === 'cancelled' ? '已取消' : '失败'}。`)
    } catch (error) {
      if (!error.retryable && !['RATE_LIMITED', 'DOWNLOAD_FAILED'].includes(error.code)) throw error
      retryDelay = Math.min(15000, Math.round(retryDelay * 1.7))
      onProgress(`任务查询暂时失败，将在 ${Math.ceil(retryDelay / 1000)} 秒后继续。`)
    }
    const jitter = Math.round(retryDelay * (0.85 + Math.random() * 0.3))
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => window.setTimeout(resolve, jitter))
  }
  throw new Error('图片任务查询超时，可在任务中心继续恢复。')
}

function emptyPage(id, name) {
  const now = new Date().toISOString()
  return { schemaVersion: 1, id, name, elements: [], files: {}, appState: { viewBackgroundColor: '#F7F8F8', currentItemRoughness: 0, selectedElementIds: {}, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }, appData: { htmlDrafts: {}, decks: {} }, createdAt: now, updatedAt: now }
}

function duplicatePageData(page) {
  const clone = structuredClone(page)
  const pageId = `page_${crypto.randomUUID().replaceAll('-', '')}`
  const idMap = new Map(clone.elements.map(element => [element.id, modelId(element.type || 'el')]))
  const groupMap = new Map(clone.elements.flatMap(element => element.groupIds || []).map(id => [id, modelId('group')]))
  const objectMap = new Map(clone.elements.map(element => element.customData?.modellix?.objectId).filter(Boolean).map(id => [id, modelId('obj')]))
  const deckMap = new Map(clone.elements.map(element => element.customData?.modellix?.deckId).filter(Boolean).map(id => [id, modelId('deck')]))
  clone.elements = clone.elements.map(element => ({
    ...element,
    id: idMap.get(element.id),
    groupIds: (element.groupIds || []).map(id => groupMap.get(id) || id),
    frameId: idMap.get(element.frameId) || element.frameId || null,
    containerId: idMap.get(element.containerId) || element.containerId || null,
    boundElements: element.boundElements?.map(item => ({ ...item, id: idMap.get(item.id) || item.id })) || element.boundElements,
    startBinding: element.startBinding ? { ...element.startBinding, elementId: idMap.get(element.startBinding.elementId) || element.startBinding.elementId } : null,
    endBinding: element.endBinding ? { ...element.endBinding, elementId: idMap.get(element.endBinding.elementId) || element.endBinding.elementId } : null,
    seed: Math.floor(Math.random() * 2_000_000_000) + 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000) + 1,
    customData: element.customData?.modellix ? { ...element.customData, modellix: { ...element.customData.modellix, objectId: objectMap.get(element.customData.modellix.objectId) || modelId('obj'), deckId: deckMap.get(element.customData.modellix.deckId) || element.customData.modellix.deckId } } : element.customData
  }))
  clone.appData = { ...(clone.appData || {}) }
  clone.appData.htmlDrafts = Object.fromEntries(Object.entries(clone.appData.htmlDrafts || {}).map(([objectId, draft]) => [objectMap.get(objectId) || modelId('obj'), { ...draft, revision: 1 }]))
  clone.appData.decks = Object.fromEntries(Object.entries(clone.appData.decks || {}).map(([deckId, deck]) => {
    const nextDeckId = deckMap.get(deckId) || modelId('deck')
    return [nextDeckId, {
      ...deck,
      id: nextDeckId,
      revision: 1,
      slides: (deck.slides || []).map((slide, order) => ({ ...slide, id: idMap.get(slide.id) || slide.id, objectId: objectMap.get(slide.objectId) || modelId('obj'), order }))
    }]
  }))
  clone.id = pageId
  clone.name = `${page.name} Copy`
  clone.appState.selectedElementIds = {}
  return clone
}

function withPreviewCsp(source) {
  const documentNode = new DOMParser().parseFromString(String(source || ''), 'text/html')
  documentNode.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(node => node.remove())
  documentNode.querySelectorAll('script,iframe,object,embed,link,base,form').forEach(node => node.remove())
  documentNode.querySelectorAll('*').forEach(node => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase()
      if (/^on/iu.test(name) || ['srcdoc', 'formaction'].includes(name)) node.removeAttribute(attribute.name)
    }
    if (node.hasAttribute('src') && !/^(?:data:image\/|blob:)/iu.test(node.getAttribute('src') || '')) node.removeAttribute('src')
    if (node.hasAttribute('href')) node.removeAttribute('href')
    if (node.hasAttribute('style')) node.setAttribute('style', sanitizeInlineCss(node.getAttribute('style') || ''))
  })
  documentNode.querySelectorAll('style').forEach(node => { node.textContent = sanitizeInlineCss(node.textContent || '') })
  const policy = documentNode.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'")
  documentNode.head.prepend(policy)
  return `<!doctype html>\n${documentNode.documentElement.outerHTML}`
}

function sanitizeInlineCss(value) {
  return String(value).replace(/@import[^;]+;/giu, '').replace(/url\((?!["']?(?:data:|blob:))[^)]+\)/giu, 'none')
}

async function captureHtmlDraft(source) {
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  parsed.querySelectorAll('script,iframe,object,embed,link,base,form').forEach(node => node.remove())
  parsed.querySelectorAll('*').forEach(node => {
    for (const attribute of [...node.attributes]) {
      if (/^on/iu.test(attribute.name) || ['srcdoc', 'formaction'].includes(attribute.name.toLowerCase())) node.removeAttribute(attribute.name)
    }
    if (node.hasAttribute('src') && !/^(?:data:image\/|blob:)/iu.test(node.getAttribute('src') || '')) node.removeAttribute('src')
    if (node.hasAttribute('href')) node.removeAttribute('href')
  })
  const root = document.createElement('div')
  root.setAttribute('aria-hidden', 'true')
  Object.assign(root.style, { position: 'fixed', left: '-12000px', top: '0', width: '960px', height: '540px', overflow: 'hidden', background: '#fff', zIndex: '-1' })
  const style = document.createElement('style')
  style.textContent = [...parsed.querySelectorAll('style')].map(node => node.textContent || '').join('\n')
    .replace(/@import[^;]+;/giu, '')
    .replace(/url\((?!["']?(?:data:|blob:))[^)]+\)/giu, 'none')
  root.append(style)
  const content = document.createElement('div')
  content.innerHTML = parsed.body?.innerHTML || ''
  Object.assign(content.style, { width: '960px', minHeight: '540px' })
  root.append(content)
  document.body.append(root)
  try {
    const canvas = await html2canvas(root, { width: 960, height: 540, scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: false, allowTaint: false })
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('浏览器未能生成截图。')), 'image/png'))
  } finally {
    root.remove()
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('文件读取失败。'))
    reader.readAsDataURL(blob)
  })
}

function useModalFocus(dialogRef, onCancel, returnFocus) {
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => {
    const fallback = document.activeElement
    const restoreTarget = returnFocus instanceof HTMLElement ? returnFocus : fallback
    const dialog = dialogRef.current
    const focusable = () => [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') || [])]
    window.requestAnimationFrame(() => (focusable()[0] || dialog)?.focus())
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (restoreTarget instanceof HTMLElement && restoreTarget.isConnected) restoreTarget.focus()
    }
  }, [dialogRef, returnFocus])
}

function historySnapshot(page) {
  return {
    elements: structuredClone(page.elements || []),
    files: { ...(page.files || {}) },
    appState: structuredClone(persistableAppState(page.appState || {})),
    appData: structuredClone(page.appData || {})
  }
}

function historySignature(snapshot) {
  const elements = (snapshot.elements || []).map(element => `${element.id}:${element.version || 0}:${element.isDeleted ? 1 : 0}`).join('|')
  return `${elements}::${JSON.stringify(snapshot.appData || {})}`
}

function scenePersistenceSignature({ elements = [], appState = {}, files = {} }) {
  const elementSignature = elements.map(element => `${element.id}:${element.version || 0}:${element.isDeleted ? 1 : 0}`).join('|')
  const fileSignature = Object.entries(files || {}).sort(([left], [right]) => left.localeCompare(right)).map(([fileId, file]) => `${fileId}:${file?.assetId || ''}:${file?.mimeType || ''}:${file?.dataURL?.length || 0}:${file?.missing ? 1 : 0}`).join('|')
  return `${elementSignature}::${fileSignature}::${JSON.stringify(persistableAppState(appState))}`
}

function slideSceneSignature(api, frameId) {
  if (!api) return ''
  return api.getSceneElementsIncludingDeleted().filter(element => element.id === frameId || element.frameId === frameId).map(element => `${element.id}:${element.version || 0}:${element.isDeleted ? 1 : 0}`).join('|')
}

function closestCanvasImageSize(width, height) {
  const ratio = Math.max(1, Number(width) || 1) / Math.max(1, Number(height) || 1)
  return SIZE_OPTIONS
    .map(([value]) => {
      const [candidateWidth, candidateHeight] = value.split('x').map(Number)
      return { value, distance: Math.abs(Math.log(ratio / (candidateWidth / candidateHeight))) }
    })
    .sort((left, right) => left.distance - right.distance)[0]?.value || '1024x1024'
}

function formatOutputSpec(output = {}, count = 1) {
  const parts = [output?.size || '由模型决定', `${count} 张`]
  if (output?.background === 'transparent') parts.push('透明背景')
  if (output?.quality && output.quality !== 'not_applicable') parts.push(`质量 ${output.quality}`)
  return parts.join(' · ')
}

function formatExpiry(value) {
  if (!value) return '短时有效'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '短时有效' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function panelTitle(panel) { return ({ ai: '图片生成与编辑', html: 'HTML 草稿', slides: '演示文稿', tasks: '任务中心' })[panel] || '属性' }
function routeReason(code) { return ({ DEFAULT_OPAQUE_GENERATE: '普通图片生成', TRANSPARENT_GENERATE: '透明背景生成', DEFAULT_SINGLE_EDIT: '单图标准编辑', TRANSPARENT_OR_STRICT_EDIT: '透明或严格保真编辑', MULTI_REFERENCE_STANDARD_EDIT: '多参考图标准编辑', MULTI_REFERENCE_HIGH_RES_EDIT: '多参考图高分辨率编辑' })[code] || code }
function statusText(value) { return ({ preparing: '准备中', submitting: '提交中', submitted: '已提交', pending: '排队中', processing: '生成中', success: '已完成', cancelled: '已取消', failed: '失败', finalized: '已保存', active: '进行中', needs_attention: '需要处理', submission_unknown: '提交状态未知' })[value] || value }
function safeName(value) { return String(value || 'canvas').replace(/[\\/:*?"<>|]/gu, '-').slice(0, 100) }
function downloadBlob(blob, fileName) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }
