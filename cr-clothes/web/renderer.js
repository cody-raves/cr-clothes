const root = document.querySelector('#textureRoot');
const textLayersRoot = document.querySelector('#textLayers');
const defaultText = { id:'text-1', text:'', color:'#ffffff', x:512, y:512, size:190, rotation:0, opacity:1, flipX:false, flipY:false, blendMode:'normal' };
const defaultDesign = { background:'#1d4ed8', texts:[], images:[], draws:[], layerOrder:[] };
const blendModes = new Set([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
]);
let design = structuredClone(defaultDesign);
const imageElements = new Map();
const drawElements = new Map();
const pixelPercent = value => `${(Number(value)||0)/10.24}%`;
const safeBlendMode = mode => blendModes.has(String(mode || '').toLowerCase()) ? String(mode).toLowerCase() : 'normal';

function normalizeLayerOrder(existingOrder, texts, images, draws) {
  const validIds=[...texts.map(t=>t.id),...images.map(image=>image.id),...draws.map(draw=>draw.id)];
  const result=[];
  if(Array.isArray(existingOrder)) for(const id of existingOrder) if(validIds.includes(id)&&!result.includes(id)) result.push(id);
  for(const id of validIds) if(!result.includes(id)) result.push(id);
  return result;
}

function normalizePoints(points) {
  if(!Array.isArray(points)) return [];
  return points.slice(0,700).map(point => Array.isArray(point)
    ? { x:Number(point[0])||0, y:Number(point[1])||0 }
    : { x:Number(point?.x)||0, y:Number(point?.y)||0 });
}

function normalizeStrokes(strokes) {
  if(!Array.isArray(strokes)) return [];
  return strokes.slice(0,400).map(stroke => ({
    color:/^#[0-9a-f]{6}$/i.test(stroke?.color || '') ? stroke.color : '#ffffff',
    size:Math.max(1, Math.min(160, Number(stroke?.size) || 24)),
    eraser:stroke?.eraser === true,
    points:normalizePoints(stroke?.points)
  })).filter(stroke => stroke.points.length);
}

function normalize(next={}) {
  const texts=Array.isArray(next.texts)?next.texts.map((t,i)=>({
    ...defaultText,
    ...t,
    id:String(t.id || `text-${i}`),
    text:String(t.text || ''),
    color:/^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '#ffffff',
    blendMode:safeBlendMode(t.blendMode)
  })):(next.text?[{
    ...defaultText,text:next.text??defaultText.text,color:next.textColor??defaultText.color,
    x:next.x??512,y:next.y??512,size:next.size??190,rotation:next.rotation??0,
    flipX:Boolean(next.flipTextX),flipY:Boolean(next.flipTextY)
  }]:[]);
  const images=Array.isArray(next.images)?next.images.map((image,i)=>({
    ...image,
    id:String(image.id || `image-${i}`),
    name:String(image.name || 'Image'),
    blendMode:safeBlendMode(image.blendMode)
  })):(next.image?[{...next.image,id:next.image.id||'image-legacy',blendMode:safeBlendMode(next.image.blendMode)}]:[]);
  const draws=Array.isArray(next.draws)?next.draws.map((draw,i)=>({
    id:String(draw.id || `draw-${i}`),
    name:String(draw.name || `Draw ${i + 1}`),
    opacity:Math.max(0,Math.min(1,Number(draw.opacity ?? 1))),
    blendMode:safeBlendMode(draw.blendMode),
    strokes:normalizeStrokes(draw.strokes)
  })):[];
  return {background:next.background||defaultDesign.background,texts,images,draws,layerOrder:normalizeLayerOrder(next.layerOrder,texts,images,draws)};
}

function imageElementFor(image) {
  let el=imageElements.get(image.id);
  if(!el){
    el=document.createElement('img');
    el.className='runtime-image-layer';
    el.alt='';
    root.insertBefore(el,textLayersRoot);
    imageElements.set(image.id,el);
  }
  if(el.dataset.src!==image.src){el.dataset.src=image.src||'';el.src=image.src||'';}
  el.style.left=pixelPercent(image.x);el.style.top=pixelPercent(image.y);
  el.style.width=`${image.width}px`;el.style.height=`${image.height}px`;
  el.style.opacity=String(image.opacity??1);
  el.style.mixBlendMode=safeBlendMode(image.blendMode);
  el.style.transform=`translate(-50%, -50%) rotate(${image.rotation||0}deg) scale(${image.flipX?-1:1}, ${image.flipY?-1:1})`;
  el.style.display=image.src?'block':'none';
  return el;
}

function drawStrokePath(context, stroke) {
  const points=stroke.points || [];
  if(!points.length) return;
  context.save();
  context.lineCap='round';
  context.lineJoin='round';
  context.lineWidth=Math.max(1, Number(stroke.size) || 1);
  context.strokeStyle=stroke.color || '#ffffff';
  context.fillStyle=stroke.color || '#ffffff';
  context.globalCompositeOperation=stroke.eraser ? 'destination-out' : 'source-over';
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for(let i=1;i<points.length;i+=1){
    const prev=points[i-1], point=points[i];
    context.quadraticCurveTo(prev.x, prev.y, (prev.x+point.x)/2, (prev.y+point.y)/2);
  }
  context.stroke();
  if(points.length===1){
    context.beginPath();
    context.arc(points[0].x, points[0].y, context.lineWidth/2, 0, Math.PI*2);
    context.fill();
  }
  context.restore();
}

function drawElementFor(drawLayer) {
  let el=drawElements.get(drawLayer.id);
  if(!el){
    el=document.createElement('canvas');
    el.className='runtime-draw-layer';
    el.width=1024;
    el.height=1024;
    root.insertBefore(el,textLayersRoot);
    drawElements.set(drawLayer.id,el);
  }
  const context=el.getContext('2d');
  context.clearRect(0,0,el.width,el.height);
  for(const stroke of drawLayer.strokes || []) drawStrokePath(context, stroke);
  el.style.opacity=String(drawLayer.opacity??1);
  el.style.mixBlendMode=safeBlendMode(drawLayer.blendMode);
  return el;
}

function renderDesign(){
  root.style.background=design.background;
  textLayersRoot.innerHTML='';
  const validImageIds=new Set(design.images.map(image=>image.id));
  const validDrawIds=new Set(design.draws.map(draw=>draw.id));
  for(const [id,el] of imageElements){if(!validImageIds.has(id)){el.remove();imageElements.delete(id);}}
  for(const [id,el] of drawElements){if(!validDrawIds.has(id)){el.remove();drawElements.delete(id);}}
  let z=2;
  for(const layerId of design.layerOrder){
    const draw=design.draws.find(entry=>entry.id===layerId);
    if(draw){const el=drawElementFor(draw);el.style.zIndex=String(z++);continue;}
    const image=design.images.find(entry=>entry.id===layerId);
    if(image){const el=imageElementFor(image);el.style.zIndex=String(z++);continue;}
    const t=design.texts.find(entry=>entry.id===layerId);if(!t)continue;
    const el=document.createElement('div');el.className='runtime-text-layer';el.textContent=t.text||'';
    el.style.left=pixelPercent(t.x);el.style.top=pixelPercent(t.y);el.style.color=t.color||'#fff';
    el.style.fontSize=`${t.size||190}px`;el.style.opacity=String(t.opacity??1);
    el.style.mixBlendMode=safeBlendMode(t.blendMode);
    el.style.transform=`translate(-50%, -50%) rotate(${t.rotation||0}deg) scale(${t.flipX?-1:1}, ${t.flipY?-1:1})`;
    el.style.zIndex=String(z++);textLayersRoot.appendChild(el);
  }
}
window.addEventListener('message',e=>{if(e.data?.action!=='render')return;design=normalize(e.data.design||{});renderDesign();});
renderDesign();
