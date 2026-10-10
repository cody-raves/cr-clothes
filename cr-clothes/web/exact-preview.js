(() => {
    const glCanvas = garmentPreviewCanvas;
    const fallback = document.querySelector('#garmentPreviewFallback');

    function setPreviewFallback(title, detail = '', visible = true) {
        if (!fallback) return;
        fallback.classList.toggle('is-hidden', !visible);
        const strong = fallback.querySelector('strong');
        const span = fallback.querySelector('span');
        if (strong) strong.textContent = title || 'Loading 3D garment mesh…';
        if (span) span.textContent = detail || 'Prepared OBJ preview';
    }

    setPreviewFallback('Loading 3D garment mesh…', 'Prepared OBJ preview', true);

    const gl = glCanvas.getContext('webgl', { alpha: false, antialias: true, preserveDrawingBuffer: false });
    if (!gl) {
        console.warn('[cr-clothes] WebGL unavailable; exact garment preview disabled.');
        setPreviewFallback('WebGL unavailable', 'Cannot render the prepared garment OBJ in this NUI session.', true);
        return;
    }

    const offscreenTextureCanvas = document.createElement('canvas');
    offscreenTextureCanvas.width = 1024;
    offscreenTextureCanvas.height = 1024;
    const offscreenTextureContext = offscreenTextureCanvas.getContext('2d');

    let activePreviewKey = '';
    let model = null;
    let uvGuideImage = null;
    let uvGuideSource = '';
    let loadingKey = '';
    let animationFrame = 0;
    let statusMessage = 'Loading exact garment preview…';
    let previewPitch = -0.12;
    let previewDistance = 1.75;
    let isDragging = false;
    let lastPointerX = 0;
    let lastPointerY = 0;

    const vertexShaderSource = `
        attribute vec3 aPosition;
        attribute vec3 aNormal;
        attribute vec2 aUv;
        uniform mat4 uProjection;
        uniform mat4 uModelView;
        uniform mat3 uUvTransform;
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
            vNormal = mat3(uModelView) * aNormal;
            // v9.6 preview assets were generated as (V, 1-U). Undo that
            // preview-only transform here so the NUI model samples the exact
            // same canvas coordinates used by the working in-game DUI texture.
            // model.obj and uv.svg already contain the calibrated garment UVs.
            // Use them directly; another remap moves bottom-right content to top-left.
            vUv = (uUvTransform * vec3(aUv, 1.0)).xy;
            gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
        }
    `;
    const fragmentShaderSource = `
        precision mediump float;
        varying vec3 vNormal;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        void main() {
            vec3 n = normalize(vNormal);
            // Clothing surfaces are thin and can be viewed from either side in
            // the isolated editor. Light both sides while retaining the real
            // CodeWalker vertex normals for dimensional shading.
            vec3 lightA = normalize(vec3(0.45, 0.75, 0.65));
            vec3 lightB = normalize(vec3(-0.65, 0.15, 0.45));
            float key = abs(dot(n, lightA));
            float fill = abs(dot(n, lightB));
            float rim = pow(1.0 - abs(n.z), 2.0);
            float lit = 0.34 + key * 0.48 + fill * 0.14 + rim * 0.10;
            vec4 tex = texture2D(uTexture, vUv);
            gl_FragColor = vec4(tex.rgb * lit, max(tex.a, 0.98));
        }
    `;

    function compile(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed');
        }
        return shader;
    }

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexShaderSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentShaderSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Shader link failed');
    }
    gl.useProgram(program);

    const locations = {
        position: gl.getAttribLocation(program, 'aPosition'),
        normal: gl.getAttribLocation(program, 'aNormal'),
        uv: gl.getAttribLocation(program, 'aUv'),
        projection: gl.getUniformLocation(program, 'uProjection'),
        modelView: gl.getUniformLocation(program, 'uModelView'),
        uvTransform: gl.getUniformLocation(program, 'uUvTransform'),
        texture: gl.getUniformLocation(program, 'uTexture')
    };

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(locations.texture, 0);

    function resourceUrl(path) {
        const cleanPath = String(path || '').replace(/^\/+/, '');
        const name = (typeof GetParentResourceName === 'function')
            ? GetParentResourceName()
            : (typeof resourceName === 'string' ? resourceName : 'cr-clothes');
        return `https://cfx-nui-${name}/${cleanPath}?v=36`;
    }

    function parseObj(text, previewOptions = {}) {
        // Default OFF: the in-game garment is the truth reference and it is
        // not mirrored (validated 2026-08-15). Explicit opt-in only.
        const mirrorGeometryX = previewOptions.mirrorGeometryX === true;
        const sourcePositions = [[0, 0, 0]];
        const sourceUvs = [[0, 0]];
        const sourceNormals = [[0, 1, 0]];
        const positions = [];
        const uvs = [];
        const normals = [];

        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(/\s+/);
            const tag = parts.shift();
            if (tag === 'v') sourcePositions.push(parts.slice(0, 3).map(Number));
            else if (tag === 'vt') sourceUvs.push(parts.slice(0, 2).map(Number));
            else if (tag === 'vn') sourceNormals.push(parts.slice(0, 3).map(Number));
            else if (tag === 'f') {
                const refs = parts.map(part => part.split('/').map(value => Number(value || 0)));
                for (let i = 1; i + 1 < refs.length; i++) {
                    const triangle = [refs[0], refs[i], refs[i + 1]];
                    const pa = sourcePositions[triangle[0][0]] || sourcePositions[0];
                    const pb = sourcePositions[triangle[1][0]] || sourcePositions[0];
                    const pc = sourcePositions[triangle[2][0]] || sourcePositions[0];
                    const ux=pb[0]-pa[0], uy=pb[1]-pa[1], uz=pb[2]-pa[2];
                    const vx=pc[0]-pa[0], vy=pc[1]-pa[1], vz=pc[2]-pa[2];
                    let fnx=uy*vz-uz*vy, fny=uz*vx-ux*vz, fnz=ux*vy-uy*vx;
                    const fl=Math.hypot(fnx,fny,fnz)||1; fnx/=fl; fny/=fl; fnz/=fl;
                    for (const ref of triangle) {
                        const p = sourcePositions[ref[0]] || sourcePositions[0];
                        const uv = sourceUvs[ref[1]] || sourceUvs[0];
                        const hasNormal = ref[2] > 0 && sourceNormals[ref[2]];
                        const n = hasNormal ? sourceNormals[ref[2]] : [fnx,fny,fnz];
                        // Mirror only the displayed preview geometry across X by
                        // default. Some props, especially caps, already match
                        // GTA's handedness and must opt out via preview metadata.
                        positions.push(mirrorGeometryX ? -p[0] : p[0], p[1], p[2]);
                        uvs.push(uv[0], uv[1]);
                        normals.push(mirrorGeometryX ? -n[0] : n[0], n[1], n[2]);
                    }
                }
            }
        }
        if (!positions.length) throw new Error('OBJ contained no triangles');

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
            minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
            minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
        }
        const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
        const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
        for (let i = 0; i < positions.length; i += 3) {
            positions[i] = (positions[i] - center[0]) / size;
            positions[i + 1] = (positions[i + 1] - center[1]) / size;
            positions[i + 2] = (positions[i + 2] - center[2]) / size;
        }
        return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), count: positions.length / 3 };
    }

    function bufferData(attributeLocation, values, size) {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(attributeLocation);
        gl.vertexAttribPointer(attributeLocation, size, gl.FLOAT, false, 0, 0);
        return buffer;
    }

    function setModel(parsed) {
        if (model) {
            if (model.positionBuffer) gl.deleteBuffer(model.positionBuffer);
            if (model.normalBuffer) gl.deleteBuffer(model.normalBuffer);
            if (model.uvBuffer) gl.deleteBuffer(model.uvBuffer);
        }
        model = {
            ...parsed,
            positionBuffer: bufferData(locations.position, parsed.positions, 3),
            normalBuffer: bufferData(locations.normal, parsed.normals, 3),
            uvBuffer: bufferData(locations.uv, parsed.uvs, 2)
        };
    }

    async function loadPreviewForGarment(garment) {
        const preview = garment?.preview;
        const key = `${garment?.id || ''}:${preview?.model || ''}:mirror=${preview?.mirrorGeometryX === true}`;
        if (key === activePreviewKey || key === loadingKey) return;
        activePreviewKey = '';
        loadingKey = key;
        model = null;
        uvGuideImage = null;
        uvGuideSource = '';
        setPreviewFallback('Loading 3D garment mesh…', garment?.label || garment?.id || 'Prepared OBJ preview', true);

        if (!preview?.exact || !preview?.model || !preview?.uvGuide) {
            statusMessage = 'Preview not prepared — run crclothes_prepare';
            setPreviewFallback('Preview not prepared', 'This garment has no generated OBJ/UV preview.', true);
            loadingKey = '';
            return;
        }

        statusMessage = 'Loading garment mesh…';
        try {
            const response = await fetch(resourceUrl(preview.model));
            if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
            setModel(parseObj(await response.text(), preview));

            uvGuideSource = resourceUrl(preview.uvGuide);
            uvGuideImage = new Image();
            uvGuideImage.onload = () => render();
            uvGuideImage.onerror = () => { uvGuideImage = null; };
            uvGuideImage.src = uvGuideSource;

            activePreviewKey = key;
            statusMessage = garment.label || garment.id || 'Exact garment';
            setPreviewFallback('', '', false);
        } catch (error) {
            console.error('[cr-clothes] Exact preview load failed', error);
            statusMessage = `Exact preview failed: ${error.message}`;
            setPreviewFallback('3D preview failed', `${garment?.label || garment?.id || 'Garment'} · ${error.message}`, true);
        } finally {
            loadingKey = '';
        }
    }

    function perspective(out, fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy / 2);
        out.set([f / aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,(2*far*near)/(near-far),0]);
        return out;
    }
    function multiply(out, a, b) {
        const r = new Float32Array(16);
        for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
            r[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
        }
        out.set(r); return out;
    }
    function translation(x, y, z) { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]); }
    function rotationY(rad) { const c=Math.cos(rad),s=Math.sin(rad); return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]); }
    function rotationX(rad) { const c=Math.cos(rad),s=Math.sin(rad); return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]); }
    function rotationZ(rad) { const c=Math.cos(rad),s=Math.sin(rad); return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]); }

    function uvTransformMatrix(name) {
        const value = String(name || 'identity').toLowerCase();
        if (value === 'rotatecw' || value === 'rotate-90-cw') {
            // u' = 1 - v, v' = u. This undoes the exporter-wide swap/flip for
            // pieces whose in-game diffuse mapping uses the raw CodeWalker UVs.
            return new Float32Array([0,1,0, -1,0,0, 1,0,1]);
        }
        if (value === 'rotatecw-flipx' || value === 'rotate-90-cw-flip-x') {
            // Apply the existing 90° clockwise editor alignment, then mirror
            // horizontally only in the isolated WebGL preview. This keeps the
            // placement aligned with the guide while making lettering read the
            // same way as the in-game garment.
            // u' = v, v' = u
            return new Float32Array([0,1,0, 1,0,0, 0,0,1]);
        }
        if (value === 'rotateccw' || value === 'rotate-90-ccw') {
            // u' = v, v' = 1 - u.
            return new Float32Array([0,-1,0, 1,0,0, 0,1,1]);
        }
        if (value === 'flipx' || value === 'flip-x') {
            return new Float32Array([-1,0,0, 0,1,0, 1,0,1]);
        }
        if (value === 'flipy' || value === 'flip-y') {
            return new Float32Array([1,0,0, 0,-1,0, 0,1,1]);
        }
        return new Float32Array([1,0,0, 0,1,0, 0,0,1]);
    }

    function resolvedFrontYaw(garment) {
        const explicit = garment?.preview?.yawOffset;
        if (explicit !== undefined && explicit !== null && explicit !== '') return Number(explicit);
        const category = String(garment?.category || '').toLowerCase();
        const label = String(garment?.label || garment?.displayName || '').toLowerCase();
        const prefix = String(garment?.prefix || '').toLowerCase();
        const affected = ['tops','undershirts','pants','shoes'].includes(category)
            || ['jbib','uppr','lowr','feet'].includes(prefix)
            || /shirt|hoodie|jacket|pants|trouser|shoe|sneaker/.test(label);
        return affected ? 0 : 180;
    }

    function resolvedPreviewRoll(garment) {
        const explicit = garment?.preview?.rollOffset;
        if (explicit !== undefined && explicit !== null && explicit !== '') return Number(explicit);
        return String(garment?.category || '').toLowerCase() === 'hats' ? 90 : 0;
    }

    function applyGuideTransform(context, image, transformName) {
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

    function resolvedUvTransform(garment, mode) {
        // Preview assets are regenerated with RAW game UVs (manifest v7,
        // uvTransform 'none'): the mesh's vt ARE the game's texture coords,
        // so both the guide and the WebGL render sample with identity. The
        // per-garment/per-category correction stack below is retired -- it
        // compensated for an exporter transform that no longer exists.
        // (Truth-validated 2026-08-15 via magenta marker calibration.)
        return 'identity';

        /* retired legacy resolution:
        const explicit = mode === 'guide'
            ? garment?.preview?.guideUvTransform
            : garment?.preview?.renderUvTransform;
        if (explicit) return explicit;

        const category = String(garment?.category || '').toLowerCase();
        const label = String(garment?.label || garment?.displayName || '').toLowerCase();
        const prefix = String(garment?.prefix || '').toLowerCase();
        const requiresClockwiseRotation =
            ['tops', 'undershirts', 'pants', 'shoes'].includes(category)
            || ['jbib', 'uppr', 'lowr', 'feet'].includes(prefix)
            || /shirt|hoodie|jacket|pants|trouser|shoe|sneaker/.test(label);

        // Hats/caps use the same 90-degree clockwise correction. The exported
        // cap OBJ/SVG can look internally aligned while GTA samples the diffuse
        // atlas rotated relative to that raw preview export.
        if (category === 'hats' || prefix === 'p_head') return 'rotateCW';

        // Masks keep the same 90-degree clockwise guide orientation, but
        // the isolated 3D preview also needs a horizontal correction so text
        // reads the same way as the published in-game garment.
        if (category === 'masks') return mode === 'render' ? 'rotateCW-flipX' : 'rotateCW';
        return requiresClockwiseRotation ? 'rotateCW' : 'identity';
        */
    }

    function drawScene() {
        cancelAnimationFrame(animationFrame);
        animationFrame = requestAnimationFrame(drawScene);
        const garment = activeEditorGarment;
        loadPreviewForGarment(garment);

        const displayWidth = glCanvas.clientWidth || glCanvas.width;
        const displayHeight = glCanvas.clientHeight || glCanvas.height;
        if (glCanvas.width !== displayWidth || glCanvas.height !== displayHeight) {
            glCanvas.width = displayWidth;
            glCanvas.height = displayHeight;
        }
        gl.viewport(0, 0, glCanvas.width, glCanvas.height);
        gl.clearColor(0.025, 0.035, 0.055, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        // Render both sides of thin clothing pieces such as bandanas and
        // masks; culling can make the prepared model look like an open mesh.
        gl.disable(gl.CULL_FACE);

        if (!model) {
            setPreviewFallback(statusMessage || 'Loading 3D garment mesh…', activeEditorGarment?.label || activeEditorGarment?.id || 'Prepared OBJ preview', true);
            return;
        }

        setPreviewFallback('', '', false);

        drawTexture(offscreenTextureContext, design);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Generated UVs are already calibrated for the editor canvas.
        // Do not vertically flip the uploaded canvas a second time.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenTextureCanvas);
        gl.generateMipmap(gl.TEXTURE_2D);

        gl.bindBuffer(gl.ARRAY_BUFFER, model.positionBuffer);
        gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, model.normalBuffer);
        gl.vertexAttribPointer(locations.normal, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, model.uvBuffer);
        gl.vertexAttribPointer(locations.uv, 2, gl.FLOAT, false, 0, 0);

        const projection = perspective(new Float32Array(16), Math.PI / 4, glCanvas.width / Math.max(1, glCanvas.height), 0.1, 100);
        // CodeWalker garment meshes face GTA ped-forward (+Y). The OBJ conversion
        // places that front side opposite the WebGL camera at rotation 0, so the
        // preview was showing the inside/back of masks and mirrored-looking UV
        // placement. Start 180 degrees around Y so the NUI matches the surface
        // visible on the player's face. Garment metadata can override this later.
        // Keep the calibrated UVs untouched. The previous preview was reading the
        // correct texture location from the reverse-facing side of the mesh,
        // which made lettering appear mirrored. Start from the opposite physical
        // side instead of mirroring or remapping the texture coordinates.
        const frontYaw = resolvedFrontYaw(activeEditorGarment);
        const previewRoll = resolvedPreviewRoll(activeEditorGarment);
        const yawPitch = multiply(
            new Float32Array(16),
            rotationY((previewRotation + frontYaw) * Math.PI / 180),
            rotationX(previewPitch)
        );
        const rotate = multiply(
            new Float32Array(16),
            yawPitch,
            rotationZ(previewRoll * Math.PI / 180)
        );
        const modelView = multiply(new Float32Array(16), translation(0, 0, -previewDistance), rotate);
        gl.uniformMatrix4fv(locations.projection, false, projection);
        gl.uniformMatrix4fv(locations.modelView, false, modelView);
        gl.uniformMatrix3fv(locations.uvTransform, false, uvTransformMatrix(resolvedUvTransform(activeEditorGarment, 'render')));
        gl.drawArrays(gl.TRIANGLES, 0, model.count);
    }

    drawIsolatedGarmentPreview = function () {
        loadPreviewForGarment(activeEditorGarment);
        if (previewGarmentType) previewGarmentType.textContent = activeEditorGarment?.preview?.exact ? 'LIVE 3D PREVIEW' : 'NO 3D PREVIEW';
    };

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function resetPreviewCamera() {
        previewRotation = 0;
        previewPitch = -0.12;
        previewDistance = 1.75;
        loadPreviewForGarment(activeEditorGarment);
    }

    glCanvas.addEventListener('mousedown', (event) => {
        isDragging = true;
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
    });

    window.addEventListener('mousemove', (event) => {
        if (!isDragging) return;
        const dx = event.clientX - lastPointerX;
        const dy = event.clientY - lastPointerY;
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        previewRotation += dx * 0.6;
        previewPitch = clamp(previewPitch + dy * 0.01, -1.2, 1.2);
    });

    glCanvas.addEventListener('mouseleave', () => {
        isDragging = false;
    });

    glCanvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        previewDistance = clamp(previewDistance + Math.sign(event.deltaY) * 0.12, 0.8, 4.0);
    }, { passive: false });

    glCanvas.addEventListener('dblclick', () => {
        resetPreviewCamera();
    });

    const resetPreviewButton = document.querySelector('#resetPreviewButton');
    if (resetPreviewButton) resetPreviewButton.addEventListener('click', () => resetPreviewCamera());


    drawUvGuide = function (context) {
        if (!uvGuideVisible || !uvGuideImage?.complete) return;
        context.save();
        context.globalAlpha = 0.86;
        // The generated guide and model share the same calibrated UV space.
        // Draw it directly without another rotation or flip.
        applyGuideTransform(context, uvGuideImage, resolvedUvTransform(activeEditorGarment, 'guide'));
        context.restore();
    };

    const badge = document.querySelector('.preview-badge small');
    window.setInterval(() => {
        if (badge) badge.textContent = statusMessage || 'Drag to rotate · wheel to zoom · double-click to reset';
    }, 250);

    drawScene();
})();
