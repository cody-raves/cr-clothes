const app = document.querySelector('#app');
const resourceName = (typeof GetParentResourceName === 'function') ? GetParentResourceName() : 'cr-clothes';
const designerStudio = document.querySelector('#designerStudio');
const builderStudio = document.querySelector('#builderStudio');
const canvas = document.querySelector('#designerCanvas');
const ctx = canvas.getContext('2d');
const backgroundInput = document.querySelector('#background');
const textInput = document.querySelector('#text');
const textColorInput = document.querySelector('#textColor');
const sizeInput = document.querySelector('#size');
const rotationInput = document.querySelector('#rotation');
const status = document.querySelector('#status');
const coordinates = document.querySelector('#coordinates');
const layerList = document.querySelector('#layerList');
const selectToolButton = document.querySelector('#selectToolButton');
const addTextToolButton = document.querySelector('#addTextToolButton');
const drawToolButton = document.querySelector('#drawToolButton');
const textLayerActions = document.querySelector('#textLayerActions');
const fillSwatch = document.querySelector('#fillSwatch');
const publishButton = document.querySelector('#publishButton');
const exportButton = document.querySelector('#exportButton');
const exportTargetSelect = document.querySelector('#exportTargetSelect');
const exportTextureIndex = document.querySelector('#exportTextureIndex');
const imageUrlInput = document.querySelector('#imageUrl');
const imageControls = document.querySelector('#imageControls');

const imageHelp = document.querySelector('#imageHelp');
const imageScaleInput = document.querySelector('#imageScale');
const imageRotationInput = document.querySelector('#imageRotation');
const imageOpacityInput = document.querySelector('#imageOpacity');
const imageScaleValue = document.querySelector('#imageScaleValue');
const imageRotationValue = document.querySelector('#imageRotationValue');
const imageOpacityValue = document.querySelector('#imageOpacityValue');
const layerCount = document.querySelector('#layerCount');
const imageDialog = document.querySelector('#imageDialog');
const imageDialogError = document.querySelector('#imageDialogError');
const imageToolButton = document.querySelector('#imageToolButton');
const garmentSelect = document.querySelector('#garmentSelect');
const garmentMeta = document.querySelector('#garmentMeta');
const activeGarmentLabel = document.querySelector('#activeGarmentLabel');
const garmentCountPill = document.querySelector('#garmentCountPill');
const garmentPreviewCanvas = document.querySelector('#garmentPreviewCanvas');
const garmentPreviewContext = null;
let exactUvImage = null;
let exactUvSource = null;
const previewGarmentType = document.querySelector('#previewGarmentType');
const toggleUvGuideButton = document.querySelector('#toggleUvGuide');
const uvCalibrationButton = document.querySelector('#uvCalibrationButton');
const fillProperties = document.querySelector('#fillProperties');
const textProperties = document.querySelector('#textProperties');
const imageProperties = document.querySelector('#imageProperties');
const drawProperties = document.querySelector('#drawProperties');
const commonLayerProperties = document.querySelector('#commonLayerProperties');
const blendModeInput = document.querySelector('#blendMode');
const drawColorInput = document.querySelector('#drawColor');
const drawSizeInput = document.querySelector('#drawSize');
const drawSizeValue = document.querySelector('#drawSizeValue');
const drawBrushModeButton = document.querySelector('#drawBrushMode');
const drawEraserModeButton = document.querySelector('#drawEraserMode');
const drawUndoButton = document.querySelector('#drawUndoButton');
const drawRedoButton = document.querySelector('#drawRedoButton');
const clearDrawButton = document.querySelector('#clearDrawButton');
const fillLayerRow = document.querySelector('#fillLayerRow');
const layerContextMenu = document.querySelector('#layerContextMenu');
const layerAdjustPopover = document.querySelector('#layerAdjustPopover');
const layerAdjustTitle = document.querySelector('#layerAdjustTitle');
const layerAdjustValue = document.querySelector('#layerAdjustValue');
const layerAdjustRange = document.querySelector('#layerAdjustRange');

let design = {
    background: '#1d4ed8',
    texts: [],
    images: [],
    draws: [],
    layerOrder: []
};

let dragging = false;
let drawing = false;
let activeTool = 'select';
let drawMode = 'brush';
let activeStroke = null;
let activeDragLayer = 'fill';
let contextLayerId = null;
let adjustMode = null;
let dragOffset = { x: 0, y: 0 };
let previewTimer;
const imageCache = new Map();
let imageLoadToken = 0;
let builderCatalog = { templates: [] };
let builderRegistry = { slots: [] };
let selectedBuilderTemplateId = null;
let builderFilter = 'all';
let browserPayload = { categories: [], items: [] };
let browserItems = [];
let browserIndex = 0;
let browserSelections = [];
let browserTextureCount = 1;
let editorGarments = [];
let activeEditorGarment = null;
let activeExportTargetId = '';
let previewRotation = 0;
let uvGuideVisible = true;
let exportPending = false;

function resourcePost(endpoint, payload = {}) {
    if (typeof GetParentResourceName !== 'function') {
        return Promise.resolve({ ok: true, endpoint, payload });
    }

    return fetch(`https://${GetParentResourceName()}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload)
    }).then((response) => response.json());
}

const BLEND_MODES = new Set([
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'hard-light', 'soft-light',
    'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
]);

function safeBlendMode(mode) {
    return BLEND_MODES.has(String(mode || '').toLowerCase()) ? String(mode).toLowerCase() : 'normal';
}

function canvasCompositeMode(mode) {
    const blendMode = safeBlendMode(mode);
    return blendMode === 'normal' ? 'source-over' : blendMode;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function cleanDrawPoints(points) {
    if (!Array.isArray(points)) return [];
    return points.slice(0, 700).map((point) => {
        if (Array.isArray(point)) return { x: clamp(point[0], -canvas.width, canvas.width * 2), y: clamp(point[1], -canvas.height, canvas.height * 2) };
        return { x: clamp(point?.x, -canvas.width, canvas.width * 2), y: clamp(point?.y, -canvas.height, canvas.height * 2) };
    });
}

function cleanDrawStrokes(strokes) {
    if (!Array.isArray(strokes)) return [];
    return strokes.slice(0, 400).map((stroke) => {
        const color = /^#[0-9a-f]{6}$/i.test(stroke?.color || '') ? stroke.color : '#ffffff';
        return {
            color,
            size: clamp(stroke?.size ?? 24, 1, 160),
            eraser: stroke?.eraser === true,
            points: cleanDrawPoints(stroke?.points)
        };
    }).filter((stroke) => stroke.points.length > 0);
}

function setActiveTool(tool) {
    activeTool = tool === 'draw' ? 'draw' : 'select';
    selectToolButton?.classList.toggle('is-active', activeTool === 'select');
    drawToolButton?.classList.toggle('is-active', activeTool === 'draw');
    canvas.classList.toggle('is-draw-mode', activeTool === 'draw');
    canvas.classList.toggle('is-eraser-mode', activeTool === 'draw' && drawMode === 'eraser');
}

function setDrawMode(mode) {
    drawMode = mode === 'eraser' ? 'eraser' : 'brush';
    drawBrushModeButton?.classList.toggle('is-active', drawMode === 'brush');
    drawEraserModeButton?.classList.toggle('is-active', drawMode === 'eraser');
    canvas.classList.toggle('is-eraser-mode', activeTool === 'draw' && drawMode === 'eraser');
}


function ensureDesignSchema(input = design) {
    let sourceTexts = [];
    if (Array.isArray(input.texts)) {
        sourceTexts = input.texts;
    } else if (typeof input.text === 'string' && input.text.length > 0) {
        sourceTexts = [{
            id: 'text-1', text: input.text, color: input.textColor ?? '#ffffff',
            x: input.x ?? 512, y: input.y ?? 512, size: input.size ?? 190,
            rotation: input.rotation ?? 0, opacity: input.opacity ?? 1,
            flipX: Boolean(input.flipTextX), flipY: Boolean(input.flipTextY)
        }];
    }
    const texts = sourceTexts.map((t, i) => ({
        id: String(t.id || `text-${Date.now()}-${i}`), text: String(t.text ?? '').slice(0, 40),
        color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#ffffff',
        x: Number(t.x ?? 512), y: Number(t.y ?? 512), size: Number(t.size ?? 190),
        rotation: Number(t.rotation ?? 0), opacity: Math.max(0, Math.min(1, Number(t.opacity ?? 1))),
        flipX: Boolean(t.flipX), flipY: Boolean(t.flipY),
        blendMode: safeBlendMode(t.blendMode)
    }));
    const sourceImages = Array.isArray(input.images)
        ? input.images
        : (input.image ? [{ ...input.image, id: input.image.id || 'image-legacy' }] : []);
    const images = sourceImages.map((image, i) => ({
        ...image,
        id: String(image.id || `image-${Date.now()}-${i}`),
        name: String(image.name || `Image ${i + 1}`).slice(0, 80),
        x: Number(image.x ?? 512), y: Number(image.y ?? 512),
        width: Number(image.width ?? 420), height: Number(image.height ?? 420),
        rotation: Number(image.rotation ?? 0), opacity: Math.max(0, Math.min(1, Number(image.opacity ?? 1))),
        flipX: Boolean(image.flipX), flipY: Boolean(image.flipY),
        blendMode: safeBlendMode(image.blendMode)
    }));
    const sourceDraws = Array.isArray(input.draws) ? input.draws : [];
    const draws = sourceDraws.map((draw, i) => ({
        id: String(draw.id || `draw-${Date.now()}-${i}`),
        name: String(draw.name || `Draw ${i + 1}`).slice(0, 80),
        opacity: Math.max(0, Math.min(1, Number(draw.opacity ?? 1))),
        blendMode: safeBlendMode(draw.blendMode),
        strokes: cleanDrawStrokes(draw.strokes),
        redoStack: []
    }));
    return {
        background: input.background || '#1d4ed8',
        texts,
        images,
        draws,
        layerOrder: normalizeLayerOrder(input.layerOrder, texts, images, draws)
    };
}
function normalizeLayerOrder(existingOrder, texts, images, draws = []) {
    const validIds = [...texts.map(t => t.id), ...images.map(image => image.id), ...draws.map(draw => draw.id)];
    const result = [];
    if (Array.isArray(existingOrder)) {
        for (const id of existingOrder) {
            if (validIds.includes(id) && !result.includes(id)) result.push(id);
        }
    }
    for (const id of validIds) {
        if (!result.includes(id)) result.push(id);
    }
    return result;
}
function syncLayerOrder() {
    design.layerOrder = normalizeLayerOrder(design.layerOrder, design.texts, design.images, design.draws);
    return design.layerOrder;
}
function ensureLayerOnTop(layerId) {
    const order = syncLayerOrder();
    const index = order.indexOf(layerId);
    if (index >= 0) {
        order.splice(index, 1);
        order.push(layerId);
    }
}
function activeText() { return design.texts.find(t => t.id === activeDragLayer) || null; }
function activeImage() { return design.images.find(image => image.id === activeDragLayer) || null; }
function activeDraw() { return design.draws.find(draw => draw.id === activeDragLayer) || null; }
function isTextLayerId(layerId) { return design.texts.some(text => text.id === layerId); }
function isImageLayerId(layerId) { return design.images.some(image => image.id === layerId); }
function isDrawLayerId(layerId) { return design.draws.some(draw => draw.id === layerId); }
function getLayerById(layerId) {
    return design.texts.find(t => t.id === layerId)
        || design.images.find(image => image.id === layerId)
        || design.draws.find(draw => draw.id === layerId)
        || null;
}
function getLayerKind(layerId) {
    if (isTextLayerId(layerId)) return 'text';
    if (isImageLayerId(layerId)) return 'image';
    if (isDrawLayerId(layerId)) return 'draw';
    return layerId === 'fill' ? 'fill' : null;
}
function hitSpecificText(layer, point) {
    if (!layer) return false;
    ctx.save();
    ctx.font = `900 ${layer.size}px Arial, sans-serif`;
    const width = Math.min(ctx.measureText(layer.text || '').width, canvas.width * .9);
    ctx.restore();
    return point.x >= layer.x - width / 2 && point.x <= layer.x + width / 2 && point.y >= layer.y - layer.size / 2 && point.y <= layer.y + layer.size / 2;
}
function hitSpecificImage(image, point) {
    if (!image) return false;
    const halfWidth = image.width / 2;
    const halfHeight = image.height / 2;
    return point.x >= image.x - halfWidth && point.x <= image.x + halfWidth
        && point.y >= image.y - halfHeight && point.y <= image.y + halfHeight;
}
function hitLayer(point) {
    for (const layerId of [...syncLayerOrder()].reverse()) {
        const layer = getLayerById(layerId);
        if (!layer) continue;
        if (isDrawLayerId(layerId)) continue;
        if (isImageLayerId(layerId) ? hitSpecificImage(layer, point) : hitSpecificText(layer, point)) return layerId;
    }
    return null;
}
function moveLayer(layerId, direction) {
    const order = syncLayerOrder();
    const index = order.indexOf(layerId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return false;
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    return true;
}
function selectLayer(id) {
    activeDragLayer=id;
    if (isDrawLayerId(id)) setActiveTool('draw');
    syncInputs();
    render();
}
function addTextLayer() {
    const id=`text-${Date.now()}`;
    design.texts.push({ id, text:'New text', color:'#ffffff', x:512, y:512, size:140, rotation:0, opacity:1, flipX:false, flipY:false, blendMode:'normal' });
    syncLayerOrder(); ensureLayerOnTop(id);
    activeDragLayer=id; setActiveTool('select'); syncInputs(); queuePreview();
}
function addDrawLayer() {
    const id=`draw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    design.draws.push({ id, name:`Draw layer ${design.draws.length + 1}`, opacity:1, blendMode:'normal', strokes:[], redoStack:[] });
    syncLayerOrder(); ensureLayerOnTop(id);
    activeDragLayer=id; setActiveTool('draw'); syncInputs(); queuePreview();
}
function removeActiveText() {
    if (!activeDragLayer.startsWith('text-')) return;
    const removedId = activeDragLayer;
    design.texts=design.texts.filter(t=>t.id!==removedId);
    syncLayerOrder();
    activeDragLayer=[...syncLayerOrder()].reverse()[0] || 'fill';
    syncInputs(); queuePreview();
}
function removeImageLayer(layerId = activeDragLayer) {
    design.images = design.images.filter(image => image.id !== layerId);
    imageCache.delete(layerId);
    syncLayerOrder();
    activeDragLayer=[...syncLayerOrder()].reverse()[0] || 'fill';
    imageHelp.textContent = design.images.length
        ? 'Select an image layer to edit it.'
        : 'Paste a direct HTTPS link to a PNG, JPEG, WebP, or animated GIF.';
    queuePreview();
}
function removeDrawLayer(layerId = activeDragLayer) {
    design.draws = design.draws.filter(draw => draw.id !== layerId);
    syncLayerOrder();
    activeDragLayer=[...syncLayerOrder()].reverse()[0] || 'fill';
    syncInputs(); queuePreview();
}
function removeLayer(layerId = activeDragLayer) {
    if (isImageLayerId(layerId)) return removeImageLayer(layerId);
    if (isDrawLayerId(layerId)) return removeDrawLayer(layerId);
    if (isTextLayerId(layerId)) { activeDragLayer = layerId; return removeActiveText(); }
}
function insertLayerAbove(sourceId, newId) {
    const order = syncLayerOrder();
    const sourceIndex = order.indexOf(sourceId);
    const existingIndex = order.indexOf(newId);
    if (existingIndex >= 0) order.splice(existingIndex, 1);
    order.splice(sourceIndex >= 0 ? sourceIndex + 1 : order.length, 0, newId);
}
function duplicateLayer(layerId = activeDragLayer) {
    const kind = getLayerKind(layerId);
    const layer = getLayerById(layerId);
    if (!layer || kind === 'fill') return;
    const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (kind === 'text') {
        design.texts.push({ ...layer, id, text: layer.text || 'Text copy', x: layer.x + 32, y: layer.y + 32 });
    } else if (kind === 'image') {
        design.images.push({ ...layer, id, name: `${layer.name || 'Image'} copy`, x: layer.x + 32, y: layer.y + 32 });
    } else if (kind === 'draw') {
        design.draws.push({
            ...layer,
            id,
            name: `${layer.name || 'Draw layer'} copy`,
            strokes: cleanDrawStrokes(structuredClone(layer.strokes || [])),
            redoStack: []
        });
    }
    syncLayerOrder();
    insertLayerAbove(layerId, id);
    activeDragLayer = id;
    syncInputs(); queuePreview();
}
function ensureImageLoaded(imageLayer) {
    if (!imageLayer?.src) return null;
    const cached = imageCache.get(imageLayer.id);
    if (cached?.src === imageLayer.src) return cached.image;
    const token = ++imageLoadToken;
    const image = new Image();
    imageCache.set(imageLayer.id, { src: imageLayer.src, image, token });
    image.onload = () => {
        const current = imageCache.get(imageLayer.id);
        if (!current || current.token !== token) return;
        const target = design.images.find(entry => entry.id === imageLayer.id);
        if (target) {
            const ratio = image.naturalHeight / image.naturalWidth || 1;
            target.aspectRatio = ratio;
            target.height = target.width * ratio;
        }
        imageHelp.textContent = /\.gif(?:$|[?#])/i.test(image.src)
            ? 'Animated GIF loaded. The garment renderer redraws every frame.'
            : 'Image loaded. Drag it directly on the texture.';
        queuePreview();
    };
    image.onerror = () => {
        const current = imageCache.get(imageLayer.id);
        if (!current || current.token !== token) return;
        imageCache.delete(imageLayer.id);
        imageHelp.textContent = 'Could not load that image.';
    };
    image.src = imageLayer.src;
    return image;
}
function ensureAllImagesLoaded() {
    for (const image of design.images) ensureImageLoaded(image);
    for (const id of [...imageCache.keys()]) {
        if (!design.images.some(image => image.id === id)) imageCache.delete(id);
    }
}

function drawStrokePath(targetContext, stroke) {
    const points = stroke.points || [];
    if (!points.length) return;
    targetContext.save();
    targetContext.lineCap = 'round';
    targetContext.lineJoin = 'round';
    targetContext.lineWidth = Math.max(1, Number(stroke.size) || 1);
    targetContext.strokeStyle = stroke.color || '#ffffff';
    targetContext.fillStyle = stroke.color || '#ffffff';
    targetContext.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over';
    targetContext.beginPath();
    targetContext.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1];
        const point = points[i];
        targetContext.quadraticCurveTo(prev.x, prev.y, (prev.x + point.x) / 2, (prev.y + point.y) / 2);
    }
    targetContext.stroke();
    if (points.length === 1) {
        targetContext.beginPath();
        targetContext.arc(points[0].x, points[0].y, targetContext.lineWidth / 2, 0, Math.PI * 2);
        targetContext.fill();
    }
    targetContext.restore();
}

function drawPaintLayer(targetContext, drawLayer) {
    const width = targetContext.canvas.width;
    const height = targetContext.canvas.height;
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = width;
    layerCanvas.height = height;
    const layerContext = layerCanvas.getContext('2d');
    for (const stroke of drawLayer.strokes || []) drawStrokePath(layerContext, stroke);
    targetContext.save();
    targetContext.globalAlpha = Math.max(0, Math.min(1, Number(drawLayer.opacity ?? 1)));
    targetContext.globalCompositeOperation = canvasCompositeMode(drawLayer.blendMode);
    targetContext.drawImage(layerCanvas, 0, 0);
    targetContext.restore();
}

function drawTexture(targetContext, state) {
    const width = targetContext.canvas.width;
    const height = targetContext.canvas.height;
    targetContext.clearRect(0, 0, width, height);
    targetContext.fillStyle = state.background;
    targetContext.fillRect(0, 0, width, height);
    const order = normalizeLayerOrder(state.layerOrder, state.texts || [], state.images || [], state.draws || []);
    for (const layerId of order) {
        const drawLayer = (state.draws || []).find(draw => draw.id === layerId);
        if (drawLayer) {
            drawPaintLayer(targetContext, drawLayer);
            continue;
        }
        const imageLayer = (state.images || []).find(image => image.id === layerId);
        if (imageLayer) {
            const image = ensureImageLoaded(imageLayer);
            if (image?.complete && image.naturalWidth > 0) {
                targetContext.save();
                targetContext.translate(imageLayer.x, imageLayer.y);
                targetContext.rotate((imageLayer.rotation || 0) * Math.PI / 180);
                targetContext.globalAlpha = Math.max(0, Math.min(1, Number(imageLayer.opacity ?? 1)));
                targetContext.globalCompositeOperation = canvasCompositeMode(imageLayer.blendMode);
                targetContext.scale(imageLayer.flipX ? -1 : 1, imageLayer.flipY ? -1 : 1);
                targetContext.drawImage(image, -imageLayer.width / 2, -imageLayer.height / 2, imageLayer.width, imageLayer.height);
                targetContext.restore();
            }
            continue;
        }
        const text = (state.texts || []).find(entry => entry.id === layerId);
        if (!text) continue;
        targetContext.save();
        targetContext.translate(text.x, text.y);
        targetContext.rotate((text.rotation || 0) * Math.PI / 180);
        targetContext.globalAlpha = Math.max(0, Math.min(1, Number(text.opacity ?? 1)));
        targetContext.globalCompositeOperation = canvasCompositeMode(text.blendMode);
        targetContext.scale(text.flipX ? -1 : 1, text.flipY ? -1 : 1);
        targetContext.fillStyle = text.color || '#ffffff';
        targetContext.textAlign = 'center'; targetContext.textBaseline = 'middle';
        targetContext.font = `900 ${text.size || 190}px Arial, sans-serif`;
        targetContext.fillText(text.text || '', 0, 0, width * 0.9);
        targetContext.restore();
    }
}

function designPayload(includeImageSource = false) {
    return {
        background: design.background,
        texts: design.texts.map(t => ({ ...t })),
        images: design.images.map(image => ({ ...image })),
        draws: design.draws.map(draw => ({
            id: draw.id,
            name: draw.name,
            opacity: draw.opacity,
            blendMode: draw.blendMode,
            strokes: cleanDrawStrokes(draw.strokes)
        })),
        layerOrder: [...syncLayerOrder()]
    };
}

function bytesToBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode(...bytes.subarray(index, index + step));
    }
    return btoa(binary);
}

function captureRawDesignTexture() {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const exportContext = exportCanvas.getContext('2d', { willReadFrequently: true });
    drawTexture(exportContext, design);
    return exportContext.getImageData(0, 0, exportCanvas.width, exportCanvas.height);
}

function generatedExportTargets() {
    return editorGarments.filter(garment => garment?.assetMode === 'generated');
}

function activeExportTarget() {
    const targets = generatedExportTargets();
    if (!targets.length) return null;
    return targets.find(garment => garment.id === activeExportTargetId) || targets[0];
}

function populateExportTargetOptions(preferredId = activeExportTargetId) {
    if (!exportTargetSelect) return;
    const targets = generatedExportTargets();
    exportTargetSelect.innerHTML = '';

    if (!targets.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No prepared addon target';
        exportTargetSelect.appendChild(option);
        exportTargetSelect.disabled = true;
        activeExportTargetId = '';
        refreshExportVariantOptions(null);
        return;
    }

    exportTargetSelect.disabled = false;
    for (const target of targets) {
        const option = document.createElement('option');
        option.value = target.id;
        option.textContent = target.label || target.displayName || target.id;
        exportTargetSelect.appendChild(option);
    }

    const selected = targets.find(target => target.id === preferredId) || targets[0];
    activeExportTargetId = selected.id;
    exportTargetSelect.value = selected.id;
    refreshExportVariantOptions(selected);
}

function refreshExportVariantOptions(garment = activeExportTarget()) {
    if (!exportTextureIndex) return;
    const previous = Number(exportTextureIndex.value || 0);
    const preferred = Number.isFinite(Number(garment?.textureId)) ? Number(garment.textureId) : previous;
    const textureCount = Math.max(1, Math.min(26, Number(garment?.textureCount || 20)));
    exportTextureIndex.innerHTML = '';
    for (let index = 0; index < textureCount; index += 1) {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `${index} / ${String.fromCharCode(97 + index)}`;
        exportTextureIndex.appendChild(option);
    }
    exportTextureIndex.value = String(Math.min(Math.max(0, preferred), textureCount - 1));
}

async function setActiveTextureVariantFromUi() {
    if (!exportTextureIndex) return;
    const target = activeExportTarget();
    if (!target?.id) {
        status.textContent = 'No prepared addon export target is available.';
        return;
    }
    const textureId = Math.max(0, Math.min(25, Number(exportTextureIndex.value || 0)));
    target.textureId = textureId;

    if (activeEditorGarment?.id === target.id) {
        const response = await resourcePost('setTextureVariant', { textureId });
        if (!response?.ok) {
            status.textContent = response?.message || 'Could not equip that texture variant.';
            return;
        }
        activeEditorGarment.textureId = textureId;
    }

    status.textContent = `Export target ${target.label || target.id} variant ${textureId} / ${String.fromCharCode(97 + textureId)} selected.`;
}

exportTextureIndex?.addEventListener('change', setActiveTextureVariantFromUi);
exportTargetSelect?.addEventListener('change', () => {
    activeExportTargetId = exportTargetSelect.value;
    const target = activeExportTarget();
    refreshExportVariantOptions(target);
    status.textContent = target
        ? `Bake target set to ${target.label || target.id}. You can keep editing the current preview garment.`
        : 'No prepared addon export target is available.';
});


function inferGarmentCategory(garment) {
    if (!garment) return 'tops';
    if (garment.category) return garment.category;
    if (garment.kind === 'prop') return garment.propId === 0 ? 'hats' : 'glasses';
    const map = { 1: 'masks', 4: 'pants', 5: 'bags', 6: 'shoes', 7: 'accessories', 8: 'undershirts', 11: 'tops' };
    return map[Number(garment.componentId)] || 'tops';
}

function garmentPath(context, category, width, height) {
    const cx = width / 2;
    context.beginPath();
    if (category === 'pants') {
        context.moveTo(cx - width * .22, height * .18);
        context.lineTo(cx + width * .22, height * .18);
        context.lineTo(cx + width * .17, height * .48);
        context.lineTo(cx + width * .27, height * .9);
        context.lineTo(cx + width * .04, height * .9);
        context.lineTo(cx, height * .53);
        context.lineTo(cx - width * .04, height * .9);
        context.lineTo(cx - width * .27, height * .9);
        context.lineTo(cx - width * .17, height * .48);
    } else if (category === 'shoes') {
        context.roundRect(cx - width*.38, height*.36, width*.34, height*.22, 28);
        context.roundRect(cx + width*.04, height*.36, width*.34, height*.22, 28);
    } else if (category === 'masks') {
        context.moveTo(cx, height*.14);
        context.bezierCurveTo(cx+width*.24,height*.15,cx+width*.28,height*.45,cx+width*.18,height*.72);
        context.bezierCurveTo(cx+width*.08,height*.9,cx-width*.08,height*.9,cx-width*.18,height*.72);
        context.bezierCurveTo(cx-width*.28,height*.45,cx-width*.24,height*.15,cx,height*.14);
    } else if (category === 'hats') {
        context.ellipse(cx, height*.43, width*.27, height*.20, 0, Math.PI, Math.PI*2);
        context.moveTo(cx-width*.34,height*.45);
        context.quadraticCurveTo(cx,height*.55,cx+width*.36,height*.48);
        context.quadraticCurveTo(cx+width*.12,height*.62,cx-width*.34,height*.45);
    } else if (category === 'glasses') {
        context.roundRect(cx-width*.34,height*.34,width*.28,height*.20,22);
        context.roundRect(cx+width*.06,height*.34,width*.28,height*.20,22);
        context.moveTo(cx-width*.06,height*.41); context.lineTo(cx+width*.06,height*.41);
    } else if (category === 'bags') {
        context.roundRect(cx-width*.25,height*.25,width*.5,height*.52,36);
        context.moveTo(cx-width*.14,height*.27); context.quadraticCurveTo(cx,height*.05,cx+width*.14,height*.27);
    } else {
        context.moveTo(cx-width*.16,height*.17);
        context.quadraticCurveTo(cx,height*.27,cx+width*.16,height*.17);
        context.lineTo(cx+width*.38,height*.31);
        context.lineTo(cx+width*.30,height*.48);
        context.lineTo(cx+width*.20,height*.42);
        context.lineTo(cx+width*.19,height*.88);
        context.quadraticCurveTo(cx,height*.94,cx-width*.19,height*.88);
        context.lineTo(cx-width*.20,height*.42);
        context.lineTo(cx-width*.30,height*.48);
        context.lineTo(cx-width*.38,height*.31);
        context.closePath();
    }
}

function drawIsolatedGarmentPreview() {
    // exact-preview.js overrides this after it loads and renders the real
    // prepared garment model with the live design canvas. Keep the fallback
    // empty here so the editor never draws a fake silhouette preview.
}


function loadExactUvForGarment(garment) {
    const source = garment?.preview?.uvGuide || null;
    if (!source) { exactUvImage = null; exactUvSource = null; return; }
    if (source === exactUvSource && exactUvImage) return;
    exactUvSource = source;
    exactUvImage = new Image();
    exactUvImage.onload = () => render();
    exactUvImage.onerror = () => { exactUvImage = null; };
    exactUvImage.src = `https://cfx-nui-${resourceName}/${source}?v=${Date.now()}`;
}

function resolvedEditorGuideTransform(garment) {
    // Preview assets are regenerated with RAW game UVs (manifest version 7,
    // uvTransform 'none'), so the guide needs NO correction: canvas pixel
    // (x, y) IS game UV (u, v). The old per-category/per-garment rotate/flip
    // stack compensated for a transform the exporter no longer bakes in.
    // (Proven against in-game truth via magenta marker calibration.)
    return 'identity';
}

function applyEditorGuideTransform(context, image, transformName) {
    const w = context.canvas.width;
    const h = context.canvas.height;
    const value = String(transformName || 'identity').toLowerCase();
    if (value === 'rotatecw' || value === 'rotate-90-cw') {
        context.translate(w, 0);
        context.rotate(Math.PI / 2);
        context.drawImage(image, 0, 0, w, h);
        return;
    }
    if (value === 'rotatecw-flipx' || value === 'rotate-90-cw-flip-x') {
        context.transform(0, 1, 1, 0, 0, 0);
        context.drawImage(image, 0, 0, w, h);
        return;
    }
    if (value === 'rotateccw' || value === 'rotate-90-ccw') {
        context.translate(0, h);
        context.rotate(-Math.PI / 2);
        context.drawImage(image, 0, 0, w, h);
        return;
    }
    if (value === 'flipx' || value === 'flip-x') {
        context.translate(w, 0);
        context.scale(-1, 1);
        context.drawImage(image, 0, 0, w, h);
        return;
    }
    if (value === 'flipy' || value === 'flip-y') {
        context.translate(0, h);
        context.scale(1, -1);
        context.drawImage(image, 0, 0, w, h);
        return;
    }
    context.drawImage(image, 0, 0, w, h);
}

function drawUvGuide(context, garment) {
    if (!uvGuideVisible) return;
    const category = inferGarmentCategory(garment);
    if (exactUvImage && exactUvImage.complete) {
        context.save();
        context.globalAlpha = 0.9;
        applyEditorGuideTransform(context, exactUvImage, resolvedEditorGuideTransform(garment));
        context.restore();
        return;
    }
    const w=context.canvas.width,h=context.canvas.height;
    context.save();
    context.strokeStyle='rgba(230,238,255,.38)'; context.lineWidth=1.25;
    const cols=category==='masks'?12:16, rows=category==='pants'?18:14;
    for(let y=0;y<rows;y++){
        for(let x=0;x<cols;x++){
            const x0=x*w/cols, x1=(x+1)*w/cols, y0=y*h/rows, y1=(y+1)*h/rows;
            context.beginPath();context.moveTo(x0,y0);context.lineTo(x1,y1);context.lineTo(x0,y1);context.closePath();context.stroke();
            if((x+y)%2===0){context.beginPath();context.moveTo(x0,y0);context.lineTo(x1,y0);context.lineTo(x1,y1);context.stroke();}
        }
    }
    context.strokeStyle='rgba(183,255,51,.75)';context.lineWidth=3;context.setLineDash([12,8]);
    if(category==='tops'||category==='undershirts'){context.strokeRect(w*.22,h*.18,w*.56,h*.68);context.strokeRect(w*.03,h*.18,w*.18,h*.32);context.strokeRect(w*.79,h*.18,w*.18,h*.32);}
    else if(category==='pants'){context.strokeRect(w*.18,h*.08,w*.64,h*.22);context.strokeRect(w*.18,h*.32,w*.28,h*.62);context.strokeRect(w*.54,h*.32,w*.28,h*.62);}
    else if(category==='masks'){context.beginPath();context.ellipse(w*.5,h*.5,w*.30,h*.43,0,0,Math.PI*2);context.stroke();}
    else {context.strokeRect(w*.16,h*.16,w*.68,h*.68);}
    context.restore();
}

function openLayerContext(event, layerId) {
    event.preventDefault();
    contextLayerId = layerId;
    selectLayer(layerId);
    const kind = getLayerKind(layerId);
    layerContextMenu.querySelectorAll('[data-layer-action="scale"],[data-layer-action="rotate"],[data-layer-action="flip-horizontal"],[data-layer-action="flip-vertical"]').forEach((button) => {
        button.disabled = kind === 'draw';
    });
    layerContextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
    layerContextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 260)}px`;
    layerContextMenu.classList.remove('is-hidden');
    layerAdjustPopover.classList.add('is-hidden');
}

function renderLayers() {
    layerList.innerHTML = '';
    for (const layerId of [...syncLayerOrder()].reverse()) {
        const draw = design.draws.find(entry => entry.id === layerId);
        if (draw) {
            const row=document.createElement('div');
            row.className='layer-row'+(activeDragLayer===draw.id?' is-selected':'');
            row.tabIndex=0; row.setAttribute('role','button');
            row.innerHTML=`<span class="layer-icon">✎</span><span><strong>${escapeHtml(draw.name || 'Draw layer')}</strong><small>Draw layer · paint, erase, undo/redo</small></span><button class="layer-delete" type="button" aria-label="Delete">×</button>`;
            row.addEventListener('click', e=>{ if(e.target.closest('.layer-delete')) removeDrawLayer(draw.id); else selectLayer(draw.id); });
            row.addEventListener('contextmenu', e=>openLayerContext(e,draw.id));
            layerList.appendChild(row);
            continue;
        }
        const image = design.images.find(entry => entry.id === layerId);
        if (image) {
            const row=document.createElement('div');
            row.className='layer-row'+(activeDragLayer===image.id?' is-selected':'');
            row.tabIndex=0; row.setAttribute('role','button');
            row.innerHTML=`<span class="layer-icon">▧</span><span><strong>${escapeHtml(image.name||'Image')}</strong><small>Image layer · right-click in list or canvas</small></span><button class="layer-delete" type="button" aria-label="Delete">×</button>`;
            row.addEventListener('click', e=>{ if(e.target.closest('.layer-delete')) removeImageLayer(image.id); else selectLayer(image.id); });
            row.addEventListener('contextmenu', e=>openLayerContext(e,image.id));
            layerList.appendChild(row);
            continue;
        }
        const text = design.texts.find(entry => entry.id === layerId);
        if (!text) continue;
        const row=document.createElement('div');
        row.className='layer-row'+(activeDragLayer===text.id?' is-selected':'');
        row.tabIndex=0; row.setAttribute('role','button');
        row.innerHTML=`<span class="layer-icon">T</span><span><strong>${escapeHtml(text.text||'Empty text')}</strong><small>Text layer · right-click in list or canvas</small></span><button class="layer-delete" type="button" aria-label="Delete">×</button>`;
        row.addEventListener('click', e=>{ if(e.target.closest('.layer-delete')){ activeDragLayer=text.id; removeActiveText(); } else selectLayer(text.id); });
        row.addEventListener('contextmenu', e=>openLayerContext(e,text.id));
        layerList.appendChild(row);
    }
}
// Small live copy of the design for the card in the left panel.
const designThumb = document.querySelector('#designThumb');
const designThumbCtx = designThumb ? designThumb.getContext('2d') : null;
function drawDesignThumb() {
    if (!designThumbCtx) return;
    designThumbCtx.clearRect(0, 0, designThumb.width, designThumb.height);
    designThumbCtx.drawImage(canvas, 0, 0, designThumb.width, designThumb.height);
}

function render() {
    // The thumbnail is copied before the UV guide is drawn, so it shows the
    // design itself rather than the editing overlay.
    ensureAllImagesLoaded(); drawTexture(ctx, design); drawDesignThumb(); drawUvGuide(ctx, activeEditorGarment); drawIsolatedGarmentPreview();
    const t=activeText();
    const image=activeImage();
    const draw=activeDraw();
    coordinates.textContent = image ? `IMAGE X ${Math.round(image.x)} · Y ${Math.round(image.y)}`
        : t ? `TEXT X ${Math.round(t.x)} · Y ${Math.round(t.y)}`
            : draw ? `DRAW · ${draw.strokes.length} strokes`
                : 'NO LAYER SELECTED';
    fillSwatch.style.background = design.background;
    layerCount.textContent = String(design.texts.length + design.images.length + design.draws.length + 1);
    fillProperties.classList.toggle('is-hidden', activeDragLayer !== 'fill');
    textProperties.classList.toggle('is-hidden', !t);
    imageProperties.classList.toggle('is-hidden', !image);
    drawProperties.classList.toggle('is-hidden', !draw);
    commonLayerProperties.classList.toggle('is-hidden', activeDragLayer === 'fill' || !getLayerById(activeDragLayer));
    imageControls.classList.add('is-hidden');
    textLayerActions.classList.add('is-hidden');
    fillLayerRow.classList.toggle('is-selected', activeDragLayer === 'fill');
    if (blendModeInput && getLayerById(activeDragLayer)) blendModeInput.value = safeBlendMode(getLayerById(activeDragLayer).blendMode);
    drawSizeValue.textContent = `${drawSizeInput.value}px`;
    drawUndoButton.disabled = !draw || !draw.strokes.length;
    drawRedoButton.disabled = !draw || !(draw.redoStack || []).length;
    clearDrawButton.disabled = !draw || !draw.strokes.length;
    renderLayers();
    if (image) {
        const scale=Math.round((image.width/420)*100); imageScaleInput.value=Math.max(10,Math.min(300,scale));
        imageRotationInput.value=image.rotation; imageOpacityInput.value=Math.round(image.opacity*100);
        imageScaleValue.textContent=`${imageScaleInput.value}%`; imageRotationValue.textContent=`${Math.round(image.rotation)}°`; imageOpacityValue.textContent=`${imageOpacityInput.value}%`;
    }
}
function queuePreview() {
    render();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => resourcePost('preview', designPayload(false)), 50);
}

function syncInputs() {
    backgroundInput.value = design.background;
    const t=activeText();
    const textSelected=Boolean(t);
    for (const input of [textInput,textColorInput,sizeInput,rotationInput]) input.disabled=!textSelected;
    if(t){ textInput.value=t.text; textColorInput.value=t.color; sizeInput.value=t.size; rotationInput.value=t.rotation; }
    const layer = getLayerById(activeDragLayer);
    if (blendModeInput && layer) blendModeInput.value = safeBlendMode(layer.blendMode);
}

function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
}

function openImageDialog() {
    imageDialogError.textContent = '';
    imageUrlInput.value = '';
    imageDialog.classList.remove('is-hidden');
    imageToolButton.classList.add('is-active');
    window.setTimeout(() => imageUrlInput.focus(), 0);
}

function closeImageDialog() {
    imageDialog.classList.add('is-hidden');
    imageToolButton.classList.remove('is-active');
    imageDialogError.textContent = '';
}

function hitImage(point) {
    const image = activeImage();
    return hitSpecificImage(image, point);
}


function hitText(point) {
    const layerId = hitLayer(point);
    return layerId === 'image' ? null : layerId;
}
async function setImageSource(src, name) {
    const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // Place new images with a visible offset so a newly added layer does not
    // perfectly cover the previous one and appear to replace it.
    const offsetStep = ((design.images.length % 6) + 1) * 42;
    const imageLayer = {
        id, src, name: name || `Image ${design.images.length + 1}`,
        x: Math.min(860, 470 + offsetStep),
        y: Math.min(860, 470 + offsetStep),
        width: 420, height: 420,
        rotation: 0, opacity: 1, flipX: false, flipY: false, blendMode: 'normal'
    };
    design.images.push(imageLayer);
    syncLayerOrder(); ensureLayerOnTop(id);
    activeDragLayer = id;
    imageHelp.textContent = 'Loading image…';
    ensureImageLoaded(imageLayer);
    queuePreview();
}

backgroundInput.addEventListener('input', () => {
    design.background = backgroundInput.value;
    queuePreview();
});

textInput.addEventListener('input', () => { const t=activeText(); if(!t)return; t.text=textInput.value.slice(0,40); queuePreview(); });
textColorInput.addEventListener('input', () => { const t=activeText(); if(!t)return; t.color=textColorInput.value; queuePreview(); });
sizeInput.addEventListener('input', () => { const t=activeText(); if(!t)return; t.size=Number(sizeInput.value); queuePreview(); });
rotationInput.addEventListener('input', () => { const t=activeText(); if(!t)return; t.rotation=Number(rotationInput.value); queuePreview(); });

imageScaleInput.addEventListener('input', () => {
    const image=activeImage(); if (!image) return;
    const scale = Number(imageScaleInput.value) / 100;
    const cached=imageCache.get(image.id)?.image;
    const aspectRatio = image.aspectRatio || (cached ? cached.naturalHeight / cached.naturalWidth : 1) || 1;
    image.width = 420 * scale;
    image.height = image.width * aspectRatio;
    image.aspectRatio = aspectRatio;
    imageScaleValue.textContent = `${imageScaleInput.value}%`;
    queuePreview();
});

imageRotationInput.addEventListener('input', () => {
    const image=activeImage(); if (!image) return;
    image.rotation = Number(imageRotationInput.value);
    imageRotationValue.textContent = `${imageRotationInput.value}°`;
    queuePreview();
});

imageOpacityInput.addEventListener('input', () => {
    const image=activeImage(); if (!image) return;
    image.opacity = Number(imageOpacityInput.value) / 100;
    imageOpacityValue.textContent = `${imageOpacityInput.value}%`;
    queuePreview();
});

function clampLayerPosition(layer, point) {
    if (isImageLayerId(layer.id)) {
        return {
            x: clamp(point.x, -layer.width / 2, canvas.width + layer.width / 2),
            y: clamp(point.y, -layer.height / 2, canvas.height + layer.height / 2)
        };
    }
    const margin = Math.max(80, Number(layer.size || 140));
    return {
        x: clamp(point.x, -margin, canvas.width + margin),
        y: clamp(point.y, -margin, canvas.height + margin)
    };
}

function ensureActiveDrawLayer() {
    const draw = activeDraw();
    if (draw) return draw;
    addDrawLayer();
    return activeDraw();
}

function startDrawStroke(point) {
    const draw = ensureActiveDrawLayer();
    if (!draw) return;
    draw.redoStack = [];
    activeStroke = {
        color: drawColorInput.value || '#ffffff',
        size: Number(drawSizeInput.value) || 24,
        eraser: drawMode === 'eraser',
        points: [{ x: point.x, y: point.y }]
    };
    draw.strokes.push(activeStroke);
    drawing = true;
}

function addPointToActiveStroke(point) {
    if (!activeStroke) return;
    const last = activeStroke.points[activeStroke.points.length - 1];
    const distance = Math.hypot(point.x - last.x, point.y - last.y);
    if (distance < 1.5) return;
    activeStroke.points.push({ x: point.x, y: point.y });
}

canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const point=canvasPoint(event);
    canvas.setPointerCapture(event.pointerId);
    if (activeTool === 'draw') {
        startDrawStroke(point);
        syncInputs(); queuePreview();
        return;
    }
    const hitId = hitLayer(point);
    if (!hitId) {
        dragging = false;
        return;
    }
    activeDragLayer=hitId;
    const layer=getLayerById(hitId);
    dragOffset = { x: point.x - layer.x, y: point.y - layer.y };
    dragging=true;
    syncInputs(); queuePreview();
});
canvas.addEventListener('pointermove', (event) => {
    const point=canvasPoint(event);
    if(drawing){
        addPointToActiveStroke(point);
        queuePreview();
        return;
    }
    if(!dragging)return;
    const layer = getLayerById(activeDragLayer);
    if (!layer) return;
    const next = clampLayerPosition(layer, { x: point.x - dragOffset.x, y: point.y - dragOffset.y });
    layer.x = next.x;
    layer.y = next.y;
    queuePreview();
});
canvas.addEventListener('pointerup',()=>{
    dragging=false;
    drawing=false;
    activeStroke=null;
});
canvas.addEventListener('pointercancel',()=>{
    dragging=false;
    drawing=false;
    activeStroke=null;
});
canvas.addEventListener('contextmenu', (event) => {
    const hitId = hitLayer(canvasPoint(event));
    if (!hitId) return;
    openLayerContext(event, hitId);
});

fillLayerRow.addEventListener('click', () => { setActiveTool('select'); selectLayer('fill'); });

function currentContextLayer() { return getLayerById(contextLayerId); }

function updateAdjustValue() {
    const suffix = adjustMode === 'opacity' || adjustMode === 'scale-image' ? '%' : adjustMode === 'rotate' ? '°' : 'px';
    layerAdjustValue.textContent = `${layerAdjustRange.value}${suffix}`;
}

function openAdjustPopover(mode) {
    const layer = currentContextLayer();
    if (!layer) return;
    adjustMode = mode;
    let min=0,max=100,step=1,value=0,title='Adjust';
    if (mode === 'scale') {
        if (isImageLayerId(contextLayerId)) { min=10; max=300; value=Math.round((layer.width/420)*100); title='Image scale'; adjustMode='scale-image'; }
        else { min=24; max=420; value=Math.round(layer.size); title='Text size'; adjustMode='scale-text'; }
    } else if (mode === 'rotate') { min=-180; max=180; value=Math.round(layer.rotation||0); title='Rotation'; }
    else if (mode === 'opacity') { min=0; max=100; value=Math.round((layer.opacity??1)*100); title='Opacity'; }
    layerAdjustRange.min=String(min); layerAdjustRange.max=String(max); layerAdjustRange.step=String(step); layerAdjustRange.value=String(value);
    layerAdjustTitle.textContent=title; updateAdjustValue();
    const left=parseFloat(layerContextMenu.style.left)||20, top=parseFloat(layerContextMenu.style.top)||20;
    layerAdjustPopover.style.left=`${Math.min(left+180,window.innerWidth-300)}px`;
    layerAdjustPopover.style.top=`${Math.min(top,window.innerHeight-150)}px`;
    layerContextMenu.classList.add('is-hidden');
    layerAdjustPopover.classList.remove('is-hidden');
}

layerContextMenu.addEventListener('click', (event) => {
    const action=event.target.closest('[data-layer-action]')?.dataset.layerAction;
    if(!action)return;
    if (event.target.closest('[data-layer-action]')?.disabled) return;
    const layer=currentContextLayer(); if(!layer)return;
    if(action==='scale'||action==='rotate'||action==='opacity'){openAdjustPopover(action);return;}
    if(action==='duplicate') {
        duplicateLayer(contextLayerId);
        layerContextMenu.classList.add('is-hidden');
        return;
    }
    if(action==='move-up') {
        if (moveLayer(contextLayerId, 1)) { layerContextMenu.classList.add('is-hidden'); queuePreview(); }
        return;
    }
    if(action==='move-down') {
        if (moveLayer(contextLayerId, -1)) { layerContextMenu.classList.add('is-hidden'); queuePreview(); }
        return;
    }
    if(action==='flip-horizontal') layer.flipX=!layer.flipX;
    if(action==='flip-vertical') layer.flipY=!layer.flipY;
    if(action==='delete') {
        removeLayer(contextLayerId);
        layerContextMenu.classList.add('is-hidden'); return;
    }
    layerContextMenu.classList.add('is-hidden'); queuePreview();
});

layerAdjustRange.addEventListener('input',()=>{
    const layer=currentContextLayer(); if(!layer)return;
    const value=Number(layerAdjustRange.value);
    if(adjustMode==='scale-text') layer.size=value;
    else if(adjustMode==='scale-image') { const cached=imageCache.get(layer.id)?.image; const ratio=layer.aspectRatio || (cached ? cached.naturalHeight/cached.naturalWidth : layer.height/layer.width) || 1; layer.width=420*(value/100); layer.height=layer.width*ratio; }
    else if(adjustMode==='rotate') layer.rotation=value;
    else if(adjustMode==='opacity') layer.opacity=value/100;
    updateAdjustValue(); queuePreview();
});

document.querySelector('#closeLayerAdjust').addEventListener('click',()=>layerAdjustPopover.classList.add('is-hidden'));
document.addEventListener('pointerdown',(event)=>{
    if(!event.target.closest('#layerContextMenu')&&!event.target.closest('.layer-row')) layerContextMenu.classList.add('is-hidden');
    if(!event.target.closest('#layerAdjustPopover')&&!event.target.closest('#layerContextMenu')) layerAdjustPopover.classList.add('is-hidden');
});

selectToolButton?.addEventListener('click', () => setActiveTool('select'));
addTextToolButton.addEventListener('click', addTextLayer);
drawToolButton?.addEventListener('click', addDrawLayer);
drawBrushModeButton?.addEventListener('click', () => setDrawMode('brush'));
drawEraserModeButton?.addEventListener('click', () => setDrawMode('eraser'));
drawSizeInput?.addEventListener('input', () => {
    drawSizeValue.textContent = `${drawSizeInput.value}px`;
});
drawUndoButton?.addEventListener('click', () => {
    const draw = activeDraw();
    if (!draw || !draw.strokes.length) return;
    draw.redoStack = draw.redoStack || [];
    draw.redoStack.push(draw.strokes.pop());
    queuePreview();
});
drawRedoButton?.addEventListener('click', () => {
    const draw = activeDraw();
    if (!draw || !(draw.redoStack || []).length) return;
    draw.strokes.push(draw.redoStack.pop());
    queuePreview();
});
clearDrawButton?.addEventListener('click', () => {
    const draw = activeDraw();
    if (!draw || !draw.strokes.length) return;
    draw.redoStack = draw.strokes.splice(0);
    queuePreview();
});
blendModeInput?.addEventListener('change', () => {
    const layer = getLayerById(activeDragLayer);
    if (!layer) return;
    layer.blendMode = safeBlendMode(blendModeInput.value);
    queuePreview();
});
document.querySelector('#removeTextButton').addEventListener('click', removeActiveText);
document.querySelector('#flipTextHorizontal').addEventListener('click',()=>{const t=activeText();if(t){t.flipX=!t.flipX;queuePreview();}});
document.querySelector('#flipTextVertical').addEventListener('click',()=>{const t=activeText();if(t){t.flipY=!t.flipY;queuePreview();}});
document.querySelector('#flipImageHorizontal').addEventListener('click',()=>{const image=activeImage();if(image){image.flipX=!image.flipX;queuePreview();}});
document.querySelector('#flipImageVertical').addEventListener('click',()=>{const image=activeImage();if(image){image.flipY=!image.flipY;queuePreview();}});
imageToolButton.addEventListener('click', openImageDialog);
document.querySelector('#openImageDialogButton').addEventListener('click', openImageDialog);
document.querySelector('#closeImageDialogButton').addEventListener('click', closeImageDialog);
document.querySelector('#cancelImageDialogButton').addEventListener('click', closeImageDialog);

document.querySelector('#loadUrlButton').addEventListener('click', () => {
    const url = imageUrlInput.value.trim();
    if (!url.startsWith('https://')) {
        imageDialogError.textContent = 'Enter a public HTTPS image URL.';
        return;
    }

    imageDialogError.textContent = '';
    setImageSource(url, url.split('/').pop()?.split('?')[0] || 'URL image');
    closeImageDialog();
});

imageUrlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        document.querySelector('#loadUrlButton').click();
    }
});

document.querySelector('#removeImageButton').addEventListener('click', () => removeImageLayer(activeDragLayer));

function populateEditorGarments(garments, activeId) {
    editorGarments = Array.isArray(garments) ? garments : [];
    garmentSelect.innerHTML = '';

    if (!editorGarments.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No garments installed';
        garmentSelect.appendChild(option);
        garmentSelect.disabled = true;
        garmentMeta.textContent = 'Open /clothbuilder, save garments, run clothbuilder_prepare, then reopen this editor.';
        activeGarmentLabel.textContent = 'No garment selected';
        garmentCountPill.textContent = 'NO GARMENTS INSTALLED';
        populateExportTargetOptions('');
        return;
    }

    garmentSelect.disabled = false;
    const groups = new Map();
    for (const garment of editorGarments) {
        const gender = garment.requiredPedModel === 'mp_m_freemode_01' ? 'Male' : 'Female';
        const kind = garment.kind === 'prop' ? 'Props' : 'Clothing';
        const key = `${gender} — ${kind}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(garment);
    }

    for (const [label, garmentsInGroup] of groups) {
        const group = document.createElement('optgroup');
        group.label = label;
        for (const garment of garmentsInGroup) {
            const option = document.createElement('option');
            option.value = garment.id;
            option.textContent = garment.label || garment.id;
            group.appendChild(option);
        }
        garmentSelect.appendChild(group);
    }

    const selected = editorGarments.find(item => item.id === activeId) || editorGarments[0];
    garmentSelect.value = selected.id;
    activeEditorGarment = selected;
    loadExactUvForGarment(selected);
    populateExportTargetOptions(activeExportTargetId || (selected.assetMode === 'generated' ? selected.id : ''));
    activeGarmentLabel.textContent = selected.label || selected.id;
    garmentMeta.textContent = `${selected.collection} · drawable ${selected.drawableId} · ${selected.kind}`;
    garmentCountPill.textContent = `${editorGarments.length} GARMENT${editorGarments.length === 1 ? '' : 'S'}`;
}

garmentSelect.addEventListener('change', async () => {
    const id = garmentSelect.value;
    const selected = editorGarments.find(item => item.id === id);
    if (!selected) return;

    garmentSelect.disabled = true;
    status.textContent = `Equipping ${selected.label || selected.id}…`;
    const response = await resourcePost('selectGarment', { id });
    garmentSelect.disabled = false;

    if (!response.ok) {
        status.textContent = response.message || 'Could not equip selected garment';
        return;
    }

    activeEditorGarment = selected;
    loadExactUvForGarment(selected);
    if (selected.assetMode === 'generated') {
        populateExportTargetOptions(selected.id);
    } else {
        populateExportTargetOptions(activeExportTargetId);
    }
    activeGarmentLabel.textContent = selected.label || selected.id;
    garmentMeta.textContent = `${selected.collection} · drawable ${selected.drawableId} · ${selected.kind}`;
    status.textContent = `${selected.label || selected.id} equipped and ready to edit`;
    render();
});

document.querySelector('#wearButton').addEventListener('click', async () => {
    const response = await resourcePost('wear');
    status.textContent = response.ok ? 'Test garment equipped' : 'Could not equip configured garment';
});

document.querySelector('#rotateLeftButton').addEventListener('click', () => { previewRotation -= 15; drawIsolatedGarmentPreview(); });

document.querySelector('#rotateRightButton').addEventListener('click', () => { previewRotation += 15; drawIsolatedGarmentPreview(); });


toggleUvGuideButton?.addEventListener('click', () => {
    uvGuideVisible = !uvGuideVisible;
    toggleUvGuideButton.classList.toggle('is-active', uvGuideVisible);
    toggleUvGuideButton.textContent = uvGuideVisible ? 'UV GUIDE ON' : 'UV GUIDE OFF';
    render();
});

function addUvCalibrationPattern() {
    const isCalibrationId = id => String(id || '').startsWith('calib-');
    design.texts = design.texts.filter(text => !isCalibrationId(text.id));
    design.draws = design.draws.filter(draw => !isCalibrationId(draw.id));
    design.layerOrder = syncLayerOrder().filter(id => !isCalibrationId(id));

    const drawId = `calib-draw-${Date.now()}`;
    const stroke = (color, size, points) => ({ color, size, eraser: false, points });
    design.draws.push({
        id: drawId,
        name: 'UV calibration grid',
        opacity: 0.92,
        blendMode: 'normal',
        redoStack: [],
        strokes: [
            stroke('#ff1744', 12, [{x:16,y:16},{x:1008,y:16},{x:1008,y:1008},{x:16,y:1008},{x:16,y:16}]),
            stroke('#00e5ff', 8, [{x:512,y:0},{x:512,y:1024}]),
            stroke('#ffff00', 8, [{x:0,y:512},{x:1024,y:512}]),
            stroke('#00ff6a', 5, [{x:0,y:0},{x:1024,y:1024}]),
            stroke('#ff8a00', 5, [{x:1024,y:0},{x:0,y:1024}]),
            stroke('#ffffff', 16, [{x:492,y:512},{x:532,y:512}]),
            stroke('#ffffff', 16, [{x:512,y:492},{x:512,y:532}])
        ]
    });

    const labels = [
        ['TOP', 512, 58, 0],
        ['BOTTOM', 512, 966, 0],
        ['LEFT', 70, 512, -90],
        ['RIGHT', 954, 512, 90],
        ['CENTER', 512, 512, 0],
        ['TL', 86, 86, 0],
        ['TR', 938, 86, 0],
        ['BL', 86, 938, 0],
        ['BR', 938, 938, 0]
    ];
    for (const [text, x, y, rotation] of labels) {
        design.texts.push({
            id: `calib-text-${text.toLowerCase()}-${Date.now()}`,
            text,
            color: '#ffffff',
            x, y,
            size: text.length > 2 ? 72 : 58,
            rotation,
            opacity: 1,
            flipX: false,
            flipY: false,
            blendMode: 'normal'
        });
    }

    syncLayerOrder();
    ensureLayerOnTop(drawId);
    for (const text of design.texts.filter(entry => isCalibrationId(entry.id))) ensureLayerOnTop(text.id);
    activeDragLayer = drawId;
    setActiveTool('select');
    syncInputs();
    status.textContent = 'UV calibration pattern added. Publish it to compare editor, 3D preview, and in-game.';
    queuePreview();
}

uvCalibrationButton?.addEventListener('click', addUvCalibrationPattern);

publishButton.addEventListener('click', async () => {
    publishButton.disabled = true;
    publishButton.textContent = 'Opening…';
    status.textContent = 'Waiting for server confirmation…';

    // LOCAL ONLY: 'preview' pushes the design to this client's runtime texture
    // (the ped is already wearing it live while editing). Nothing is broadcast
    // to other players — use the admin publish command for that.
    const response = await resourcePost('preview', designPayload(false));

    if (!response.ok) {
        publishButton.disabled = false;
        publishButton.textContent = 'View on my character';
        status.textContent = response.message || 'Could not show the preview.';
        return;
    }

    // Get the interface out of the way so the design can be seen on the ped.
    // The client watches for ESC/BACKSPACE and sends 'endPeek' to bring us back.
    await resourcePost('peekInWorld', {});
});

async function exportCurrentDesign() {
    if (exportPending) return;
    if (!activeEditorGarment?.id) {
        status.textContent = 'Choose a garment before exporting.';
        return;
    }
    const exportTarget = activeExportTarget();
    if (!exportTarget?.id) {
        status.textContent = 'No prepared addon bake target exists in the registry. Add a generated template pack before exporting.';
        return;
    }

    exportPending = true;
    exportButton.disabled = true;
    exportButton.textContent = 'Preparing…';

    try {
        const textureIndex = Math.max(0, Math.min(25, Number(exportTextureIndex?.value || 0)));
        const imageData = captureRawDesignTexture();
        const bytes = imageData.data;
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const byteChunkSize = 12 * 1024;
        const totalChunks = Math.ceil(bytes.length / byteChunkSize);
        const exportName = `${exportTarget.label || exportTarget.id} variant ${textureIndex}`;

        status.textContent = `Preparing current canvas for ${exportTarget.label || exportTarget.id} variant ${textureIndex} in ${totalChunks} local chunks…`;

        const begin = await resourcePost('exportBegin', {
            uploadId,
            totalChunks,
            meta: {
                slotId: exportTarget.id,
                textureIndex,
                width: imageData.width,
                height: imageData.height,
                exportName,
                garment: exportTarget,
                previewGarment: activeEditorGarment,
                design: designPayload(false)
            }
        });
        if (!begin?.ok) throw new Error(begin?.message || 'Export upload could not start.');

        for (let index = 0; index < totalChunks; index += 1) {
            const start = index * byteChunkSize;
            const end = Math.min(bytes.length, start + byteChunkSize);
            const chunk = bytes.subarray(start, end);
            const response = await resourcePost('exportChunk', {
                uploadId,
                index,
                totalChunks,
                chunk: bytesToBase64(chunk)
            });
            if (!response?.ok) throw new Error(response?.message || `Export chunk ${index + 1} failed.`);
            if (index % 12 === 0 || index === totalChunks - 1) {
                status.textContent = `Packing baked texture ${index + 1}/${totalChunks} for ${exportTarget.label || exportTarget.id}…`;
            }
            if (index % 20 === 19) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        exportButton.textContent = 'Baking…';
        status.textContent = 'Sending your design to the server…';
        const finish = await resourcePost('exportFinish', { uploadId });
        if (!finish?.ok) throw new Error(finish?.message || 'Export finish failed.');
    } catch (error) {
        exportPending = false;
        exportButton.disabled = false;
        exportButton.textContent = 'Export clothing pack';
        status.textContent = error?.message || 'Export failed.';
    }
}

exportButton?.addEventListener('click', exportCurrentDesign);

function closeEditor() {
    resourcePost('close');
}

document.querySelector('#closeButton').addEventListener('click', closeEditor);
document.querySelector('#closeBuilderButton').addEventListener('click', () => {
    builderStudio.classList.add('is-hidden');
    designerStudio.classList.remove('is-hidden');
    window.PreparedGarmentPreview?.stop();
});
document.querySelector('#openGarmentBrowserButton').addEventListener('click', async () => {
    const button = document.querySelector('#openGarmentBrowserButton');
    button.disabled = true;
    button.textContent = 'Opening browser…';
    status.textContent = 'Loading garments…';
    const response = await resourcePost('openGarmentBrowser');
    button.disabled = false;
    button.textContent = 'Browse garments';
    if (!response?.ok) {
        status.textContent = response?.message || 'Could not open garment browser.';
        return;
    }
    openPreparedGarmentBrowser(response.garments || editorGarments, response.activeGarmentId || activeEditorGarment?.id);
});

function preparedGender(garment) {
    return garment?.requiredPedModel === 'mp_m_freemode_01' ? 'male' : 'female';
}

function preparedCategory(garment) {
    if (garment?.category) return garment.category;
    if (garment?.kind === 'prop') return Number(garment.propId) === 0 ? 'hats' : 'glasses';
    const map = { 1:'masks', 4:'pants', 5:'bags', 6:'shoes', 7:'accessories', 8:'undershirts', 11:'tops' };
    return map[Number(garment?.componentId)] || 'other';
}

function preparedCategoryLabel(category) {
    const labels = {
        masks:'Masks', pants:'Pants', bags:'Bags', shoes:'Shoes', accessories:'Accessories',
        undershirts:'Undershirts', tops:'Tops', hats:'Hats', glasses:'Glasses', other:'Other'
    };
    return labels[category] || category;
}

function preparedBrowserItems(garments) {
    return (Array.isArray(garments) ? garments : [])
        .map(garment => ({
            ...garment,
            gender: preparedGender(garment),
            category: preparedCategory(garment),
            categoryLabel: preparedCategoryLabel(preparedCategory(garment))
        }));
}

function currentBrowserItem() {
    return browserItems[browserIndex] || null;
}

function openPreparedGarmentBrowser(garments, activeId) {
    browserPayload = { items: preparedBrowserItems(garments) };
    const preferred = browserPayload.items.find(item => item.id === activeId) || browserPayload.items[0] || null;
    document.querySelector('#browserGender').value = preferred?.gender || 'male';
    document.querySelector('#browserCategory').value = preferred?.category || 'tops';
    document.querySelector('#browserSearch').value = '';
    browserIndex = 0;
    populatePreparedBrowserControls();
    refreshPreparedBrowser();
    designerStudio.classList.add('is-hidden');
    builderStudio.classList.remove('is-hidden');
    app.classList.remove('is-hidden');
    app.setAttribute('aria-hidden', 'false');
}

function populatePreparedBrowserControls() {
    const items = browserPayload.items || [];
    const genders = new Set(items.map(item => item.gender));
    document.querySelectorAll('#browserGenderSwitch .browser-toggle').forEach(button => {
        button.disabled = !genders.has(button.dataset.gender);
        button.classList.toggle('is-active', button.dataset.gender === document.querySelector('#browserGender').value);
    });

    const categoryTabs = document.querySelector('#browserCategoryTabs');
    const gender = document.querySelector('#browserGender').value;
    const categories = [...new Set(items.filter(item => item.gender === gender).map(item => item.category))];
    if (!categories.includes(document.querySelector('#browserCategory').value)) {
        document.querySelector('#browserCategory').value = categories[0] || '';
    }
    categoryTabs.innerHTML = '';
    categories.forEach(category => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `browser-category-tab${category === document.querySelector('#browserCategory').value ? ' is-active' : ''}`;
        button.dataset.category = category;
        button.textContent = preparedCategoryLabel(category);
        button.addEventListener('click', () => {
            document.querySelector('#browserCategory').value = category;
            categoryTabs.querySelectorAll('.browser-category-tab').forEach(tab => tab.classList.toggle('is-active', tab.dataset.category === category));
            refreshPreparedBrowser();
        });
        categoryTabs.appendChild(button);
    });
}

function refreshPreparedBrowser() {
    const gender = document.querySelector('#browserGender').value;
    const category = document.querySelector('#browserCategory').value;
    const search = document.querySelector('#browserSearch').value.trim().toLowerCase();
    browserItems = (browserPayload.items || []).filter(item => {
        if (item.gender !== gender || item.category !== category) return false;
        if (search && !`${item.label || item.id} ${item.collection || ''} ${item.modelFile || ''}`.toLowerCase().includes(search)) return false;
        return true;
    });
    browserIndex = Math.min(browserIndex, Math.max(0, browserItems.length - 1));
    renderPreparedBrowserGrid();
    renderPreparedBrowserItem();
}

function renderPreparedBrowserGrid() {
    const grid = document.querySelector('#browserGrid');
    grid.innerHTML = '';
    document.querySelector('#browserGridCount').textContent = `${browserItems.length} item${browserItems.length === 1 ? '' : 's'}`;
    document.querySelector('#browserCounter').textContent = browserItems.length ? `${browserIndex + 1} / ${browserItems.length}` : '0 / 0';

    if (!browserItems.length) {
        // Two very different situations wear the same empty grid. A fresh
        // install genuinely has no garments (owners supply their own), and
        // telling that person "nothing in this category" sends them hunting
        // through filters for something that was never there.
        const catalogueEmpty = !(browserPayload.items || []).length;
        grid.innerHTML = catalogueEmpty
            ? '<div class="browser-empty-state"><strong>No garments installed yet</strong>'
              + '<span>This designer ships without clothing. Add your own garment templates, '
              + 'then restart the resource.</span>'
              + '<span class="browser-empty-hint">See the README section &quot;Preparing your own garments&quot;.</span></div>'
            : '<div class="browser-empty-state"><strong>Nothing matches</strong>'
              + '<span>No garments in this gender and category. Try another tab or clear the search.</span></div>';
        return;
    }

    browserItems.forEach((item, index) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `prepared-garment-card${index === browserIndex ? ' is-active' : ''}`;
        const canvasId = `prepared-thumb-${index}`;
        card.innerHTML = `
            <canvas id="${canvasId}" class="prepared-card-canvas" width="320" height="240"></canvas>
            <div class="prepared-card-copy">
                <strong>${item.label || item.id}</strong>
                <small>${item.categoryLabel} · drawable ${item.drawableId}</small>
            </div>`;
        card.addEventListener('click', () => {
            browserIndex = index;
            renderPreparedBrowserGrid();
            renderPreparedBrowserItem();
        });
        // Double-click jumps straight into the editor; single click keeps the
        // preview/inspect step for anyone comparing garments.
        card.addEventListener('dblclick', () => {
            browserIndex = index;
            useSelectedGarment(item);
        });
        grid.appendChild(card);
        const canvas = card.querySelector('canvas');
        window.PreparedGarmentPreview?.renderThumbnail(canvas, item);
    });
}

function renderPreparedSlots() {
    const grid = document.querySelector('#browserSlotGrid');
    grid.innerHTML = '';
    // Slot count comes from the selected garment's texture variants rather
    // than the old hardcoded 20 (that was the single test vault's size).
    const item = currentBrowserItem();
    const slotCount = Math.max(1, Number(item?.textureCount) || Number(item?.textures) || 1);
    const label = document.querySelector('#browserSlotCount');
    if (label) label.textContent = `${slotCount} slot${slotCount === 1 ? '' : 's'}`;
    for (let index = 0; index < slotCount; index += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `prepared-slot${index === 0 ? ' is-active' : ''}`;
        button.textContent = String(index + 1).padStart(2, '0');
        button.addEventListener('click', () => {
            grid.querySelectorAll('.prepared-slot').forEach(slot => slot.classList.remove('is-active'));
            button.classList.add('is-active');
        });
        grid.appendChild(button);
    }
}

function renderPreparedBrowserItem() {
    const item = currentBrowserItem();
    document.querySelector('#browserCounter').textContent = browserItems.length ? `${browserIndex + 1} / ${browserItems.length}` : '0 / 0';
    document.querySelector('#browserSelect').disabled = !item;
    const empty = document.querySelector('#browserPreviewEmpty');

    if (!item) {
        document.querySelector('#browserDetailTitle').textContent = 'No garment selected';
        document.querySelector('#browserDetailSubtitle').textContent = 'No garments match this filter.';
        document.querySelector('#browserStatModel').textContent = '—';
        document.querySelector('#browserStatCollection').textContent = '—';
        document.querySelector('#browserStatDrawable').textContent = '—';
        empty.classList.remove('is-hidden');
        window.PreparedGarmentPreview?.clear();
        return;
    }

    empty.classList.add('is-hidden');
    document.querySelector('#browserDetailTitle').textContent = item.label || item.id;
    document.querySelector('#browserDetailSubtitle').textContent = `${item.gender === 'female' ? 'Female' : 'Male'} · ${item.categoryLabel}`;
    document.querySelector('#browserStatModel').textContent = item.modelFile || item.preview?.model?.split('/').pop() || 'Prepared model';
    document.querySelector('#browserStatCollection').textContent = item.collection || item.collectionHint || '—';
    document.querySelector('#browserStatDrawable').textContent = String(item.drawableId ?? 0);
    renderPreparedSlots();
    window.PreparedGarmentPreview?.show(item);
}

document.querySelectorAll('#browserGenderSwitch .browser-toggle').forEach(button => {
    button.addEventListener('click', () => {
        if (button.disabled) return;
        document.querySelector('#browserGender').value = button.dataset.gender;
        document.querySelectorAll('#browserGenderSwitch .browser-toggle').forEach(entry => entry.classList.toggle('is-active', entry === button));
        populatePreparedBrowserControls();
        browserIndex = 0;
        refreshPreparedBrowser();
    });
});

document.querySelector('#browserSearch').addEventListener('input', refreshPreparedBrowser);
document.querySelector('#browserRotateLeft').addEventListener('click', () => window.PreparedGarmentPreview?.rotate(-18));
document.querySelector('#browserRotateRight').addEventListener('click', () => window.PreparedGarmentPreview?.rotate(18));
document.querySelector('#browserResetCamera').addEventListener('click', () => window.PreparedGarmentPreview?.reset());
async function useSelectedGarment(item) {
    if (!item) return;
    const response = await resourcePost('selectGarment', { id: item.id });
    if (!response?.ok) {
        document.querySelector('#builderStatus').textContent = response?.message || 'Could not select that garment.';
        return;
    }
    activeEditorGarment = editorGarments.find(garment => garment.id === item.id) || item;
    garmentSelect.value = item.id;
    activeGarmentLabel.textContent = item.label || item.id;
    garmentMeta.textContent = `${item.collection} · drawable ${item.drawableId} · ${item.kind}`;
    loadExactUvForGarment(activeEditorGarment);
    if (activeEditorGarment.assetMode === 'generated') {
        populateExportTargetOptions(activeEditorGarment.id);
    } else {
        populateExportTargetOptions(activeExportTargetId);
    }
    builderStudio.classList.add('is-hidden');
    designerStudio.classList.remove('is-hidden');
    window.PreparedGarmentPreview?.stop();
    render();
    status.textContent = `Designing ${item.label || item.id}.`;
}

document.querySelector('#browserSelect').addEventListener('click', () => useSelectedGarment(currentBrowserItem()));

document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && activeDraw()) {
        const key = event.key.toLowerCase();
        if (key === 'z') {
            event.preventDefault();
            if (event.shiftKey) drawRedoButton?.click();
            else drawUndoButton?.click();
            return;
        }
        if (key === 'y') {
            event.preventDefault();
            drawRedoButton?.click();
            return;
        }
    }

    if (event.key === 'Escape' && !imageDialog.classList.contains('is-hidden')) {
        closeImageDialog();
        return;
    }

    if (event.key === 'Escape') closeEditor();
});

window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.action === 'open') {
        design = ensureDesignSchema(message.design || design);
        activeDragLayer = 'fill';
        canvas.width = message.canvasSize || 1024;
        canvas.height = message.canvasSize || 1024;
        imageCache.clear();
        populateEditorGarments(message.garments, message.activeGarmentId);
        syncInputs();
        render();
        app.classList.remove('is-hidden');
        app.setAttribute('aria-hidden', 'false');

        // Open into the garment browser: picking what to design is always the
        // first step, and dropping straight into the editor on whatever garment
        // happened to be active is disorienting. `message.skipBrowser` lets the
        // resource jump straight to the editor when a garment is already chosen.
        if (message.skipBrowser) {
            designerStudio.classList.remove('is-hidden');
            builderStudio.classList.add('is-hidden');
        } else {
            openPreparedGarmentBrowser(editorGarments, activeEditorGarment?.id);
        }
    }

    if (message.action === 'openBuilder') {
        const browserButton = document.querySelector('#openGarmentBrowserButton');
        if (browserButton) { browserButton.disabled = false; browserButton.textContent = 'Browse garments'; }
        const preparedGarments = Array.isArray(message.garments) ? message.garments : editorGarments;
        if (preparedGarments.length) {
            editorGarments = preparedGarments;
            activeEditorGarment = preparedGarments.find(garment => garment.id === message.activeGarmentId) || activeEditorGarment || preparedGarments[0];
        }
        openPreparedGarmentBrowser(preparedGarments, message.activeGarmentId || activeEditorGarment?.id);
        document.querySelector('#builderStatus').textContent = message.message || 'Browse the catalogue and pick a garment to design.';
    }

    if (message.action === 'beginPeek') {
        app.classList.add('is-peeking');
    }

    if (message.action === 'endPeek') {
        app.classList.remove('is-peeking');
        publishButton.disabled = false;
        publishButton.textContent = 'View on my character';
        status.textContent = 'Back in the editor — your design is exactly as you left it.';
    }

    if (message.action === 'close') {
        app.classList.add('is-hidden');
        app.setAttribute('aria-hidden', 'true');
    }

    if (message.action === 'publishResult') {
        publishButton.disabled = false;
        publishButton.textContent = message.ok
            ? `Published r${message.revision || ''}`
            : 'View on my character';
        status.textContent = message.message || (message.ok ? 'Published' : 'Publish failed');
    }

    if (message.action === 'exportResult') {
        exportPending = false;
        exportButton.disabled = false;
        exportButton.textContent = 'Export clothing pack';
        status.textContent = `${message.message || (message.ok ? 'Export complete.' : 'Export failed.')}${message.restartRequired ? ' Restart required for streamed clothing.' : ''}`;
    }

    if (message.action === 'builderResult') {
        const builderStatus = document.querySelector('#builderStatus');
        if (builderStatus) {
            builderStatus.textContent = (message.message || 'Builder finished.')
                + (message.restartRequired ? ' Restart the local server before testing generated slots.' : '');
        }
    }
});

function animationLoop() {
    if (!app.classList.contains('is-hidden') && design.images.length) {
        render();
    }
    requestAnimationFrame(animationLoop);
}

render();
requestAnimationFrame(animationLoop);

if (new URLSearchParams(window.location.search).has('preview')) {
    app.classList.remove('is-hidden');
    app.setAttribute('aria-hidden', 'false');
}
