(() => {
    const mainCanvas = document.querySelector('#browserPreviewCanvas');
    if (!mainCanvas) return;

    const modelCache = new Map();
    let mainRenderer = null;
    let activeItem = null;
    const DEFAULT_VIEW = Object.freeze({ yaw: 180, pitch: -0.12, distance: 1.75, roll: 0 });
    let baseView = { ...DEFAULT_VIEW };
    let view = { ...DEFAULT_VIEW };
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    function resourceUrl(path) {
        const cleanPath = String(path || '').replace(/^\/+/, '');
        const name = (typeof GetParentResourceName === 'function')
            ? GetParentResourceName()
            : (typeof resourceName === 'string' ? resourceName : 'cr-clothes');
        return `https://cfx-nui-${name}/${cleanPath}?v=3`;
    }

    function parseObj(text) {
        const sourcePositions = [[0, 0, 0]];
        const sourceNormals = [[0, 1, 0]];
        const positions = [];
        const normals = [];

        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(/\s+/);
            const tag = parts.shift();
            if (tag === 'v') sourcePositions.push(parts.slice(0, 3).map(Number));
            else if (tag === 'vn') sourceNormals.push(parts.slice(0, 3).map(Number));
            else if (tag === 'f') {
                const refs = parts.map(part => part.split('/').map(value => Number(value || 0)));
                for (let i = 1; i + 1 < refs.length; i++) {
                    const triangle = [refs[0], refs[i], refs[i + 1]];
                    const pa = sourcePositions[triangle[0][0]] || sourcePositions[0];
                    const pb = sourcePositions[triangle[1][0]] || sourcePositions[0];
                    const pc = sourcePositions[triangle[2][0]] || sourcePositions[0];
                    const ux = pb[0]-pa[0], uy = pb[1]-pa[1], uz = pb[2]-pa[2];
                    const vx = pc[0]-pa[0], vy = pc[1]-pa[1], vz = pc[2]-pa[2];
                    let fnx = uy*vz-uz*vy, fny = uz*vx-ux*vz, fnz = ux*vy-uy*vx;
                    const fl = Math.hypot(fnx,fny,fnz) || 1;
                    fnx/=fl; fny/=fl; fnz/=fl;
                    for (const ref of triangle) {
                        const p = sourcePositions[ref[0]] || sourcePositions[0];
                        const n = ref[2] > 0 && sourceNormals[ref[2]] ? sourceNormals[ref[2]] : [fnx,fny,fnz];
                        positions.push(p[0], p[1], p[2]);
                        normals.push(n[0], n[1], n[2]);
                    }
                }
            }
        }
        if (!positions.length) throw new Error('Prepared OBJ contained no triangles');

        let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
        for (let i=0;i<positions.length;i+=3) {
            minX=Math.min(minX,positions[i]); maxX=Math.max(maxX,positions[i]);
            minY=Math.min(minY,positions[i+1]); maxY=Math.max(maxY,positions[i+1]);
            minZ=Math.min(minZ,positions[i+2]); maxZ=Math.max(maxZ,positions[i+2]);
        }
        const center=[(minX+maxX)/2,(minY+maxY)/2,(minZ+maxZ)/2];
        const size=Math.max(maxX-minX,maxY-minY,maxZ-minZ)||1;
        for(let i=0;i<positions.length;i+=3){
            positions[i]=(positions[i]-center[0])/size;
            positions[i+1]=(positions[i+1]-center[1])/size;
            positions[i+2]=(positions[i+2]-center[2])/size;
        }
        return { positions:new Float32Array(positions), normals:new Float32Array(normals), count:positions.length/3 };
    }

    async function loadModel(item) {
        const path = item?.preview?.model;
        if (!path) throw new Error('Prepared model path missing');
        if (modelCache.has(path)) return modelCache.get(path);
        const promise = fetch(resourceUrl(path)).then(response => {
            if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
            return response.text();
        }).then(parseObj);
        modelCache.set(path, promise);
        return promise;
    }

    function compile(gl, type, source) {
        const shader=gl.createShader(type);
        gl.shaderSource(shader,source);
        gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)||'Shader failed');
        return shader;
    }

    function createRenderer(canvas) {
        const gl=canvas.getContext('webgl',{alpha:true,antialias:true,preserveDrawingBuffer:true});
        if(!gl) return null;
        const vs=`attribute vec3 aPosition;attribute vec3 aNormal;uniform mat4 uProjection;uniform mat4 uModelView;varying vec3 vNormal;void main(){vNormal=mat3(uModelView)*aNormal;gl_Position=uProjection*uModelView*vec4(aPosition,1.0);}`;
        const fs=`precision mediump float;varying vec3 vNormal;void main(){vec3 n=normalize(vNormal);vec3 a=normalize(vec3(.45,.75,.65));vec3 b=normalize(vec3(-.65,.15,.45));float lit=.40+abs(dot(n,a))*.44+abs(dot(n,b))*.14;vec3 white=vec3(.94,.96,1.0);gl_FragColor=vec4(white*lit,1.0);}`;
        const program=gl.createProgram();
        gl.attachShader(program,compile(gl,gl.VERTEX_SHADER,vs));
        gl.attachShader(program,compile(gl,gl.FRAGMENT_SHADER,fs));
        gl.linkProgram(program);
        gl.useProgram(program);
        return {
            canvas,gl,program,
            position:gl.getAttribLocation(program,'aPosition'),
            normal:gl.getAttribLocation(program,'aNormal'),
            projection:gl.getUniformLocation(program,'uProjection'),
            modelView:gl.getUniformLocation(program,'uModelView'),
            currentPath:null,
            model:null
        };
    }

    function drawFallbackThumbnail(canvas, item) {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const width = canvas.width || 320;
        const height = canvas.height || 240;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#080c12';
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = '#cdff3b';
        ctx.lineWidth = 4;
        ctx.beginPath();
        const cx = width / 2;
        const cy = height / 2;
        const category = item?.category || 'tops';
        if (category === 'pants') {
            ctx.moveTo(cx - 42, cy - 72); ctx.lineTo(cx + 42, cy - 72); ctx.lineTo(cx + 58, cy + 84);
            ctx.lineTo(cx + 16, cy + 84); ctx.lineTo(cx, cy - 2); ctx.lineTo(cx - 16, cy + 84);
            ctx.lineTo(cx - 58, cy + 84); ctx.closePath();
        } else if (category === 'shoes') {
            ctx.roundRect(cx - 92, cy - 20, 76, 40, 18);
            ctx.roundRect(cx + 16, cy - 20, 76, 40, 18);
        } else if (category === 'hats') {
            ctx.ellipse(cx, cy - 12, 64, 36, 0, Math.PI, Math.PI * 2);
            ctx.moveTo(cx - 88, cy + 4); ctx.quadraticCurveTo(cx - 18, cy + 34, cx + 90, cy + 12);
        } else if (category === 'masks') {
            ctx.ellipse(cx, cy, 52, 74, 0, 0, Math.PI * 2);
        } else if (category === 'gloves') {
            ctx.moveTo(cx - 98, cy + 70); ctx.lineTo(cx - 44, cy - 52); ctx.lineTo(cx - 16, cy - 38);
            ctx.moveTo(cx + 98, cy + 70); ctx.lineTo(cx + 44, cy - 52); ctx.lineTo(cx + 16, cy - 38);
        } else {
            ctx.moveTo(cx - 38, cy - 76); ctx.quadraticCurveTo(cx, cy - 52, cx + 38, cy - 76);
            ctx.lineTo(cx + 88, cy - 36); ctx.lineTo(cx + 66, cy + 4); ctx.lineTo(cx + 42, cy - 12);
            ctx.lineTo(cx + 38, cy + 82); ctx.quadraticCurveTo(cx, cy + 96, cx - 38, cy + 82);
            ctx.lineTo(cx - 42, cy - 12); ctx.lineTo(cx - 66, cy + 4); ctx.lineTo(cx - 88, cy - 36);
            ctx.closePath();
        }
        ctx.stroke();
        ctx.fillStyle = '#dce4f4';
        ctx.font = '700 12px Arial, sans-serif';
        ctx.fillText(item?.modelFile || 'garment', 14, height - 16);
    }

    function perspective(fovy,aspect,near,far){const f=1/Math.tan(fovy/2);return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,(2*far*near)/(near-far),0]);}
    function multiply(a,b){const r=new Float32Array(16);for(let row=0;row<4;row++)for(let col=0;col<4;col++)r[col*4+row]=a[row]*b[col*4]+a[4+row]*b[col*4+1]+a[8+row]*b[col*4+2]+a[12+row]*b[col*4+3];return r;}
    function translation(x,y,z){return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]);}
    function rotationY(rad){const c=Math.cos(rad),s=Math.sin(rad);return new Float32Array([c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1]);}
    function rotationX(rad){const c=Math.cos(rad),s=Math.sin(rad);return new Float32Array([1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1]);}
    function rotationZ(rad){const c=Math.cos(rad),s=Math.sin(rad);return new Float32Array([c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1]);}

    function clamp(value,min,max){return Math.max(min,Math.min(max,Number(value)));}

    function viewForItem(item){
        const preview=item?.preview||{};
        const browserView=preview.browserView||{};
        const category=String(item?.category||'').toLowerCase();
        const initial={...DEFAULT_VIEW};

        if (['tops','pants','shoes','masks','gloves','undershirts','bags','accessories','other'].includes(category)) {
            // Browser-only front-facing view. The editor preview uses its own
            // orientation system and is intentionally left unchanged.
            initial.yaw = 0;
        }
        if (category === 'hats') {
            initial.yaw = 180;
            initial.roll = 90;
            initial.distance = 1.55;
        }

        if (Number.isFinite(Number(browserView.yaw))) initial.yaw = Number(browserView.yaw);
        if (Number.isFinite(Number(browserView.pitch))) initial.pitch = clamp(browserView.pitch, -1.2, 1.2);
        if (Number.isFinite(Number(browserView.distance))) initial.distance = clamp(browserView.distance, 0.8, 4);
        if (Number.isFinite(Number(browserView.roll))) initial.roll = Number(browserView.roll);

        return initial;
    }

    function bindModel(renderer, model, path) {
        const {gl}=renderer;
        if (renderer.model?.p) gl.deleteBuffer(renderer.model.p);
        if (renderer.model?.n) gl.deleteBuffer(renderer.model.n);
        const p=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,p); gl.bufferData(gl.ARRAY_BUFFER,model.positions,gl.STATIC_DRAW);
        const n=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,n); gl.bufferData(gl.ARRAY_BUFFER,model.normals,gl.STATIC_DRAW);
        renderer.model={...model,p,n}; renderer.currentPath=path;
    }

    function draw(renderer, viewYaw, viewPitch, viewDistance, viewRoll = 0) {
        if(!renderer?.model) return;
        const {canvas,gl,model}=renderer;
        const width=Math.max(1,Math.floor(canvas.clientWidth||canvas.width));
        const height=Math.max(1,Math.floor(canvas.clientHeight||canvas.height));
        if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
        gl.viewport(0,0,canvas.width,canvas.height);
        gl.clearColor(.025,.035,.055,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
        gl.bindBuffer(gl.ARRAY_BUFFER,model.p); gl.enableVertexAttribArray(renderer.position); gl.vertexAttribPointer(renderer.position,3,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ARRAY_BUFFER,model.n); gl.enableVertexAttribArray(renderer.normal); gl.vertexAttribPointer(renderer.normal,3,gl.FLOAT,false,0,0);
        const proj=perspective(Math.PI/4,canvas.width/Math.max(1,canvas.height),.1,100);
        const rotY = rotationY(viewYaw*Math.PI/180);
        const rotX = rotationX(viewPitch);
        const rotZ = rotationZ(viewRoll*Math.PI/180);
        const rot=multiply(multiply(rotY,rotX),rotZ);
        const mv=multiply(translation(0,0,-viewDistance),rot);
        gl.uniformMatrix4fv(renderer.projection,false,proj); gl.uniformMatrix4fv(renderer.modelView,false,mv);
        gl.drawArrays(gl.TRIANGLES,0,model.count);
    }

    async function attach(renderer,item) {
        if(!renderer||!item?.preview?.model) return;
        const model=await loadModel(item);
        if(renderer.currentPath!==item.preview.model) bindModel(renderer,model,item.preview.model);
    }

    mainRenderer=createRenderer(mainCanvas);
    const sharedThumbnailCanvas=document.createElement('canvas');
    sharedThumbnailCanvas.width=320;
    sharedThumbnailCanvas.height=240;
    const sharedThumbnailRenderer=createRenderer(sharedThumbnailCanvas);
    let thumbnailQueue=Promise.resolve();
    let frame=0;
    function animate(){
        frame=requestAnimationFrame(animate);
        if (!document.querySelector('#builderStudio')?.classList.contains('is-hidden')) {
            draw(mainRenderer,view.yaw,view.pitch,view.distance,view.roll);
        }
    }
    animate();

    window.PreparedGarmentPreview={
        async show(item){
            activeItem=item;
            baseView=viewForItem(item);
            view={...baseView};
            if(!item?.preview?.model){
                if(mainRenderer){mainRenderer.model=null;mainRenderer.currentPath=null;}
                return;
            }
            await attach(mainRenderer,item);
        },
        clear(){activeItem=null;if(mainRenderer){mainRenderer.model=null;mainRenderer.currentPath=null;}},
        rotate(delta){view.yaw+=(Number(delta)||0);},
        reset(){view={...baseView};},
        stop(){dragging=false;},
        async renderThumbnail(canvas,item){
            if(!item?.preview?.model){drawFallbackThumbnail(canvas,item);return;}
            thumbnailQueue=thumbnailQueue.then(async()=>{
                try{
                    if(!sharedThumbnailRenderer){drawFallbackThumbnail(canvas,item);return;}
                    sharedThumbnailCanvas.width=Math.max(1,canvas.width||320);
                    sharedThumbnailCanvas.height=Math.max(1,canvas.height||240);
                    await attach(sharedThumbnailRenderer,item);
                    const thumbnailView=viewForItem(item);
                    draw(sharedThumbnailRenderer,thumbnailView.yaw,thumbnailView.pitch,thumbnailView.distance,thumbnailView.roll);
                    const ctx=canvas.getContext('2d');
                    if(!ctx)return;
                    ctx.clearRect(0,0,canvas.width,canvas.height);
                    ctx.drawImage(sharedThumbnailCanvas,0,0,canvas.width,canvas.height);
                }catch(error){
                    console.warn('[cr-clothes] Browser thumbnail failed',error);
                    drawFallbackThumbnail(canvas,item);
                }
            });
            return thumbnailQueue;
        }
    };

    mainCanvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;dragging=true;lastX=event.clientX;lastY=event.clientY;mainCanvas.setPointerCapture(event.pointerId);});
    mainCanvas.addEventListener('pointermove',event=>{if(!dragging)return;const dx=event.clientX-lastX,dy=event.clientY-lastY;lastX=event.clientX;lastY=event.clientY;view.yaw+=dx*.6;view.pitch=Math.max(-1.2,Math.min(1.2,view.pitch+dy*.01));});
    mainCanvas.addEventListener('pointerup',()=>{dragging=false;});
    mainCanvas.addEventListener('pointercancel',()=>{dragging=false;});
    mainCanvas.addEventListener('wheel',event=>{event.preventDefault();view.distance=Math.max(.8,Math.min(4,view.distance+Math.sign(event.deltaY)*.12));},{passive:false});
    mainCanvas.addEventListener('dblclick',()=>window.PreparedGarmentPreview.reset());
})();
