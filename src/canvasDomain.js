import { convertToExcalidrawElements } from '@excalidraw/excalidraw'

const BRAND = '#605AFF'
const INK = '#19191D'

export function createImageHolder({ x = 120, y = 120, width = 512, height = 512, ratio = '1:1' } = {}) {
  const objectId = modelId('obj')
  const groupId = modelId('group')
  const skeleton = [
    {
      id: modelId('holder'),
      type: 'rectangle',
      x,
      y,
      width,
      height,
      strokeColor: BRAND,
      backgroundColor: '#F0EFFF',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'dashed',
      roughness: 0,
      roundness: { type: 3 },
      groupIds: [groupId],
      customData: { modellix: { schemaVersion: 1, kind: 'image-holder', objectId, ratio, fitPolicy: 'contain' } }
    },
    {
      id: modelId('label'),
      type: 'text',
      text: `AI 图片 · ${ratio}`,
      x: x + 24,
      y: y + height / 2 - 14,
      width: Math.max(120, width - 48),
      height: 28,
      fontSize: 20,
      fontFamily: 2,
      textAlign: 'center',
      verticalAlign: 'middle',
      strokeColor: BRAND,
      roughness: 0,
      groupIds: [groupId],
      customData: { modellix: { schemaVersion: 1, kind: 'holder-label', objectId } }
    }
  ]
  return { objectId, elements: convert(skeleton) }
}

export function createHtmlDraft({ x = 120, y = 120, width = 960, height = 540, title = 'HTML Draft' } = {}) {
  const objectId = modelId('obj')
  const groupId = modelId('group')
  const skeleton = [
    {
      id: modelId('html'),
      type: 'rectangle', x, y, width, height,
      strokeColor: '#D7D6E0', backgroundColor: '#FFFFFF', fillStyle: 'solid',
      strokeWidth: 1, roughness: 0, roundness: { type: 3 }, groupIds: [groupId],
      customData: { modellix: { schemaVersion: 1, kind: 'html-draft', objectId, revision: 1 } }
    },
    {
      id: modelId('html_title'),
      type: 'text', text: title, x: x + 24, y: y + 20, width: width - 48, height: 32,
      fontSize: 22, fontFamily: 2, strokeColor: INK, roughness: 0, groupIds: [groupId],
      customData: { modellix: { schemaVersion: 1, kind: 'html-title', objectId } }
    },
    {
      id: modelId('html_hint'),
      type: 'text', text: '在右侧面板编辑并安全预览 HTML', x: x + 24, y: y + 76, width: width - 48, height: 28,
      fontSize: 16, fontFamily: 2, strokeColor: '#68686B', roughness: 0, groupIds: [groupId],
      customData: { modellix: { schemaVersion: 1, kind: 'html-hint', objectId } }
    }
  ]
  return { objectId, elements: convert(skeleton) }
}

export const SLIDE_TEMPLATE_OPTIONS = [
  ['starter', '入门组合'],
  ['title', '标题'],
  ['title-content', '标题 + 内容'],
  ['image', '图片重点'],
  ['comparison', '双栏对比'],
  ['blank', '空白']
]

export function slideDimensions({ ratio = '16:9', customWidth = 1600, customHeight = 900 } = {}) {
  const width = 960
  if (ratio === '4:3') return { width, height: 720 }
  if (ratio === 'custom') {
    const sourceWidth = clampNumber(customWidth, 320, 7680, 1600)
    const sourceHeight = clampNumber(customHeight, 240, 7680, 900)
    return { width, height: Math.round(Math.min(1440, Math.max(360, width * sourceHeight / sourceWidth))) }
  }
  return { width, height: 540 }
}

export function createSlideDeck({ x = 120, y = 120, count = 5, ratio = '16:9', customWidth = 1600, customHeight = 900, template = 'starter', title = 'Untitled Deck' } = {}) {
  const deckId = modelId('deck')
  const { width: frameWidth, height: frameHeight } = slideDimensions({ ratio, customWidth, customHeight })
  const elements = []
  const slides = []
  for (let index = 0; index < count; index += 1) {
    const frameX = x + index * (frameWidth + 80)
    const slideTemplate = index === 0 ? 'title' : template === 'starter' ? ['title-content', 'image', 'comparison', 'blank'][(index - 1) % 4] : template
    const result = createSlideForDeck({ deckId, x: frameX, y, order: index, ratio, customWidth, customHeight, template: slideTemplate, title: index === 0 ? title : `Slide ${index + 1}` })
    elements.push(...result.elements)
    slides.push(result.slide)
  }
  return { deckId, elements, deck: { id: deckId, title, ratio, customWidth, customHeight, defaultTemplate: template, slides, revision: 1 } }
}

export function createSlideForDeck({ deckId, x = 120, y = 120, order = 0, ratio = '16:9', customWidth = 1600, customHeight = 900, template = 'title-content', title } = {}) {
  const { width: frameWidth, height: frameHeight } = slideDimensions({ ratio, customWidth, customHeight })
  const frameId = modelId('slide')
  const objectId = modelId('obj')
  const slideTitle = title || `Slide ${order + 1}`
  const childSkeleton = slideTemplate({ template, title: slideTitle, x, y, width: frameWidth, height: frameHeight, frameId, objectId, deckId, order })
  const frameSkeleton = { id: frameId, type: 'frame', x, y, width: frameWidth, height: frameHeight, name: slideTitle, children: childSkeleton.map(item => item.id), strokeColor: '#D7D6E0', backgroundColor: '#FFFFFF', roughness: 0, customData: { modellix: { schemaVersion: 1, kind: 'slide', objectId, deckId, order, ratio, template } } }
  // Convert the frame and its children together. Excalidraw resolves frameId/children
  // relationships while converting; separate calls leave the generated ids unmapped.
  const elements = convert([frameSkeleton, ...childSkeleton])
  return { elements, slide: { id: frameId, objectId, name: slideTitle, order, template } }
}

export function duplicateSlideForDeck({ deckId, slide, elements, x, y, order, ratio = '16:9', customWidth = 1600, customHeight = 900 } = {}) {
  const sourceFrame = elements.find(element => element.id === slide.id)
  if (!sourceFrame) return createSlideForDeck({ deckId, x, y, order, ratio, customWidth, customHeight, template: slide.template, title: `${slide.name} 副本` })
  const sourceChildren = elements.filter(element => element.frameId === sourceFrame.id)
  const frameId = modelId('slide')
  const objectId = modelId('obj')
  const idMap = new Map(sourceChildren.map(element => [element.id, modelId(element.type || 'element')]))
  const offsetX = x - sourceFrame.x
  const offsetY = y - sourceFrame.y
  const cloneValue = element => ({
    ...structuredClone(element),
    id: idMap.get(element.id),
    x: element.x + offsetX,
    y: element.y + offsetY,
    frameId,
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    updated: Date.now(),
    boundElements: element.boundElements?.map(item => ({ ...item, id: idMap.get(item.id) || item.id })) || null,
    containerId: idMap.get(element.containerId) || null,
    customData: { ...(element.customData || {}), modellix: { ...(element.customData?.modellix || {}), objectId, deckId, order } }
  })
  const children = sourceChildren.map(cloneValue)
  const frame = {
    ...structuredClone(sourceFrame),
    id: frameId,
    x,
    y,
    name: `${slide.name} 副本`,
    children: children.map(item => item.id),
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    updated: Date.now(),
    customData: { ...(sourceFrame.customData || {}), modellix: { ...(sourceFrame.customData?.modellix || {}), objectId, deckId, order } }
  }
  return { elements: [frame, ...children], slide: { id: frameId, objectId, name: frame.name, order, template: slide.template || sourceFrame.customData?.modellix?.template || 'title-content' } }
}

function slideTemplate({ template, title, x, y, width, height, frameId, objectId, deckId, order }) {
  const meta = { customData: { modellix: { schemaVersion: 1, kind: 'slide-content', objectId, deckId, order } }, frameId, roughness: 0 }
  const text = (id, value, left, top, textWidth, fontSize, color = INK, align = 'left') => ({
    id: modelId(id), type: 'text', text: value, x: left, y: top, width: textWidth, height: Math.ceil(fontSize * 1.5),
    fontSize, fontFamily: 2, strokeColor: color, textAlign: align, verticalAlign: 'middle', ...meta
  })
  const box = (id, left, top, boxWidth, boxHeight, backgroundColor = '#F7F8F8') => ({
    id: modelId(id), type: 'rectangle', x: left, y: top, width: boxWidth, height: boxHeight,
    strokeColor: '#D7D6E0', backgroundColor, fillStyle: 'solid', strokeWidth: 1, roundness: { type: 3 }, ...meta
  })
  if (template === 'blank') return []
  if (template === 'title') return [
    text('slide_title', title, x + 72, y + height * 0.32, width - 144, 46, INK, 'center'),
    text('slide_subtitle', 'Created with Modellix Agent Canvas', x + 96, y + height * 0.50, width - 192, 22, '#68686B', 'center')
  ]
  if (template === 'image') return [
    text('slide_title', title, x + 56, y + 42, width - 112, 32),
    box('slide_image', x + 56, y + 118, width - 112, height - 174, '#F0EFFF'),
    text('slide_image_hint', '拖入图片或使用 AI 图片生成', x + 96, y + height * 0.52, width - 192, 22, BRAND, 'center')
  ]
  if (template === 'comparison') {
    const columnWidth = (width - 168) / 2
    return [
      text('slide_title', title, x + 56, y + 42, width - 112, 32),
      box('slide_left', x + 56, y + 126, columnWidth, height - 184),
      box('slide_right', x + 112 + columnWidth, y + 126, columnWidth, height - 184),
      text('slide_left_title', '方案 A', x + 80, y + 154, columnWidth - 48, 24),
      text('slide_right_title', '方案 B', x + 136 + columnWidth, y + 154, columnWidth - 48, 24)
    ]
  }
  return [
    text('slide_title', title, x + 56, y + 48, width - 112, 34),
    text('slide_content', '• 在这里添加关键观点\n• 支持普通画布元素与图片\n• 可直接标注并进入图片编辑流程', x + 72, y + 152, width - 144, 24, '#4A4A50')
  ]
}

export function createCanvasImage({ fileId, x = 120, y = 120, width = 960, height = 540, kind = 'source-image', assetId } = {}) {
  const objectId = modelId('obj')
  const now = Date.now()
  return {
    objectId,
    element: {
      id: modelId('image'), type: 'image', x, y, width, height, angle: 0,
      strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
      groupIds: [], frameId: null, roundness: null, seed: randomInt(), version: 1,
      versionNonce: randomInt(), isDeleted: false, boundElements: null, updated: now,
      link: null, locked: false, fileId, status: 'saved', scale: [1, 1], crop: null,
      customData: { modellix: { schemaVersion: 1, kind, objectId, ...(assetId ? { assetId } : {}) } }
    }
  }
}

export function selectedElements(elements, appState) {
  const ids = appState?.selectedElementIds || {}
  return elements.filter(element => !element.isDeleted && ids[element.id])
}

export function selectedBusinessObject(elements, appState) {
  const selected = selectedElements(elements, appState)
  const direct = selected.find(element => element.customData?.modellix?.objectId)
  if (direct) return direct
  const groupIds = new Set(selected.flatMap(element => element.groupIds || []))
  return elements.find(element => !element.isDeleted && element.groupIds?.some(id => groupIds.has(id)) && element.customData?.modellix?.objectId) || null
}

export function selectedImages(elements, appState) {
  return selectedElements(elements, appState).filter(element => element.type === 'image')
}

export function objectIdOf(element) {
  return element?.customData?.modellix?.objectId || element?.id || null
}

export function businessKindOf(element) {
  return element?.customData?.modellix?.kind || null
}

export function sceneBounds(elements) {
  if (!elements.length) return { x: 0, y: 0, width: 0, height: 0 }
  const minX = Math.min(...elements.map(element => element.x))
  const minY = Math.min(...elements.map(element => element.y))
  const maxX = Math.max(...elements.map(element => element.x + element.width))
  const maxY = Math.max(...elements.map(element => element.y + element.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function viewportCenter(api) {
  const state = api?.getAppState?.()
  if (!state) return { x: 120, y: 120 }
  const zoom = state.zoom?.value || 1
  return {
    x: (-state.scrollX + state.width / 2) / zoom,
    y: (-state.scrollY + state.height / 2) / zoom
  }
}

export function persistableAppState(appState = {}) {
  const keys = [
    'viewBackgroundColor', 'scrollX', 'scrollY', 'zoom', 'gridSize', 'gridStep', 'gridModeEnabled',
    'objectsSnapModeEnabled', 'theme', 'currentItemStrokeColor', 'currentItemBackgroundColor',
    'currentItemFillStyle', 'currentItemStrokeWidth', 'currentItemStrokeStyle', 'currentItemRoughness',
    'currentItemOpacity', 'currentItemFontFamily', 'currentItemFontSize', 'currentItemTextAlign',
    'selectedElementIds', 'selectedGroupIds', 'name'
  ]
  return Object.fromEntries(keys.filter(key => appState[key] !== undefined).map(key => [key, appState[key]]))
}

function convert(skeleton) {
  return convertToExcalidrawElements(skeleton, { regenerateIds: false })
}

export function modelId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

function randomInt() {
  return Math.floor(Math.random() * 2_000_000_000) + 1
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}
