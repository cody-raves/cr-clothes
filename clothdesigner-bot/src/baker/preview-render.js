// builder/preview-render.js
// Software 3D renderer for pack-card previews: draws the garment's real OBJ
// mesh (CodeWalker export shipped in generated/previews/) wearing the baked
// design texture. Pure JS rasterizer -- no GPU, no native deps, safe on hosted
// fivem-node. Yields to the event loop every few thousand triangles so a
// render never hitches the server tick.

const fs = require('node:fs');

// --- OBJ ---------------------------------------------------------------

function parseObj(text) {
    const positions = [];
    const uvs = [];
    const triangles = []; // {p:[i,i,i], t:[i,i,i]}

    const resolveIndex = (raw, count) => {
        const n = parseInt(raw, 10);
        if (Number.isNaN(n)) return -1;
        return n > 0 ? n - 1 : count + n;
    };

    for (const line of text.split('\n')) {
        if (line.startsWith('v ')) {
            const [, x, y, z] = line.trim().split(/\s+/);
            positions.push([parseFloat(x), parseFloat(y), parseFloat(z)]);
        } else if (line.startsWith('vt ')) {
            const [, u, v] = line.trim().split(/\s+/);
            uvs.push([parseFloat(u), parseFloat(v)]);
        } else if (line.startsWith('f ')) {
            const verts = line.trim().split(/\s+/).slice(1).map(part => {
                const [vi, ti] = part.split('/');
                return {
                    p: resolveIndex(vi, positions.length),
                    t: ti !== undefined && ti !== '' ? resolveIndex(ti, uvs.length) : -1
                };
            });
            for (let i = 2; i < verts.length; i++) { // fan-triangulate
                triangles.push({
                    p: [verts[0].p, verts[i - 1].p, verts[i].p],
                    t: [verts[0].t, verts[i - 1].t, verts[i].t]
                });
            }
        }
    }
    return { positions, uvs, triangles };
}

// --- rendering ---------------------------------------------------------

// Auto-orients the mesh: view along the axis with the smallest extent (a
// garment's depth), screen-up along the largest (its height). This makes the
// renderer independent of the exporter's axis convention.
function chooseAxes(positions) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of positions) {
        for (let a = 0; a < 3; a++) {
            if (p[a] < min[a]) min[a] = p[a];
            if (p[a] > max[a]) max[a] = p[a];
        }
    }
    const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    // CodeWalker's OBJ export converts to the OBJ-standard Y-up convention
    // (verified empirically against the shipped garment previews). A T-posed
    // top's arm-span beats its height, which is why a naive largest-extent-up
    // heuristic lays shirts sideways. Depth is whichever horizontal axis is
    // thinner; we view along it (the garment's front).
    const upAxis = 1;
    const depthAxis = extent[0] <= extent[2] ? 0 : 2;
    const rightAxis = 3 - depthAxis - upAxis;
    return { min, max, extent, depthAxis, upAxis, rightAxis };
}

// Garment previews carry a per-mesh UV calibration (generated/previews/*/
// manifest.json `uvTransform`) that the NUI applies when texturing; the
// rasterizer must match it or markers land on the wrong panels.
function makeUvTransform(name) {
    switch (String(name || 'none')) {
        case 'swap-uv-flip-v': return (u, v) => [v, 1 - u];
        case 'swap-uv':        return (u, v) => [v, u];
        case 'rotateCW':       return (u, v) => [1 - v, u];
        case 'rotateCCW':      return (u, v) => [v, 1 - u];
        case 'rotateCW-flipX': return (u, v) => [1 - (1 - v), u]; // rotateCW then flip u
        case 'flip-v':         return (u, v) => [u, 1 - v];
        case 'flip-u':         return (u, v) => [1 - u, v];
        default:               return (u, v) => [u, v];
    }
}

function sampleTexture(rgba, texW, texH, u, v) {
    const x = Math.max(0, Math.min(texW - 1, Math.round(u * (texW - 1))));
    const y = Math.max(0, Math.min(texH - 1, Math.round(v * (texH - 1))));
    const i = (y * texW + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

// renderPreview({ objPath, textureRgba, texWidth, texHeight, size, mirrorX })
//   -> Promise<{ rgba, width, height, triangles }>
// Transparent background; simple double-sided lambert lit from the camera.
async function renderPreview(options) {
    const size = Math.max(64, Math.floor(options.size || 1024));
    const objText = fs.readFileSync(options.objPath, 'utf8');
    const mesh = parseObj(objText);
    if (!mesh.triangles.length) throw new Error('Preview OBJ contains no faces.');

    const { min, max, extent, depthAxis, upAxis, rightAxis } = chooseAxes(mesh.positions);
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const fit = Math.max(extent[rightAxis], extent[upAxis]);
    const scale = (size * 0.9) / (fit || 1);
    // In-game truth (frontal screenshot 2026-08-15): no X mirror. The NUI
    // editor mirrors X for its own reasons; cards should match the world.
    const mirror = options.mirrorX === true ? -1 : 1;

    // Optional view rotation (degrees). yaw spins the garment about its
    // vertical axis (used for turntable/GIF frames), pitch tips it toward the
    // camera, roll rotates in the image plane. Props such as caps are authored
    // in attachment-bone space and usually need a roll to sit upright.
    const rad = d => (Number(d) || 0) * Math.PI / 180;
    const yaw = rad(options.yaw);
    const pitch = rad(options.pitch);
    const roll = rad(options.roll);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);

    const toScreen = p => {
        // Canonical frame: X right, Y up, Z toward camera.
        let x = mirror * (p[rightAxis] - center[rightAxis]);
        let y = p[upAxis] - center[upAxis];
        let z = p[depthAxis] - center[depthAxis];

        let nx = x * cy + z * sy;            // yaw about Y
        let nz = -x * sy + z * cy;
        let ny = y * cp - nz * sp;           // pitch about X
        nz = y * sp + nz * cp;
        const rx = nx * cr - ny * sr;        // roll about Z
        const ry = nx * sr + ny * cr;

        return [size / 2 + rx * scale, size / 2 - ry * scale, nz * scale];
    };

    const color = new Uint8ClampedArray(size * size * 4); // starts transparent
    // options.background: [r,g,b] paints a solid ground so the garment is never
    // invisible against an unknown host background (Discord light/dark theme).
    const bg = Array.isArray(options.background) ? options.background : null;
    if (bg) {
        for (let i = 0; i < color.length; i += 4) {
            color[i] = bg[0]; color[i + 1] = bg[1]; color[i + 2] = bg[2]; color[i + 3] = 255;
        }
    }
    const depth = new Float32Array(size * size).fill(-Infinity);
    const tex = options.textureRgba;
    const texW = options.texWidth;
    const texH = options.texHeight;
    const uvTransform = makeUvTransform(options.uvTransform);

    let processed = 0;
    for (const tri of mesh.triangles) {
        if (++processed % 3000 === 0) {
            await new Promise(resolve => setImmediate(resolve)); // don't hitch the tick
        }

        const a = toScreen(mesh.positions[tri.p[0]] || [0, 0, 0]);
        const b = toScreen(mesh.positions[tri.p[1]] || [0, 0, 0]);
        const c = toScreen(mesh.positions[tri.p[2]] || [0, 0, 0]);

        const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(area) < 1e-6) continue;

        // Face normal z (screen space) for double-sided lambert shading.
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nz = ux * vy - uy * vx;
        const nlen = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz) || 1;
        const facing = Math.abs(nz / nlen);
        const light = 0.26 + 0.60 * Math.pow(facing, 1.25);

        const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
        const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
        const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));

        const ta = tri.t[0] >= 0 ? mesh.uvs[tri.t[0]] : [0, 0];
        const tb = tri.t[1] >= 0 ? mesh.uvs[tri.t[1]] : [0, 0];
        const tc = tri.t[2] >= 0 ? mesh.uvs[tri.t[2]] : [0, 0];

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const w0 = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / area;
                const w1 = ((c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0])) / area;
                const w2 = 1 - w0 - w1;
                // Weights are normalized by the signed area, so "inside" is
                // all-nonnegative regardless of the triangle's winding.
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;

                // Edge-function -> vertex weight mapping: E_ab->c, E_bc->a, remainder->b.
                const la = w1, lb = w2, lc = w0;
                const z = la * a[2] + lb * b[2] + lc * c[2];
                const idx = y * size + x;
                if (z <= depth[idx]) continue;
                depth[idx] = z;

                const u = la * ta[0] + lb * tb[0] + lc * tc[0];
                const v = la * ta[1] + lb * tb[1] + lc * tc[1];
                const [su, sv] = uvTransform(u, v);
                const [r, g, bl] = sampleTexture(tex, texW, texH, su, sv);

                const o = idx * 4;
                color[o] = r * light;
                color[o + 1] = g * light;
                color[o + 2] = bl * light;
                color[o + 3] = 255;
            }
        }
    }

    return { rgba: Buffer.from(color.buffer), width: size, height: size, triangles: mesh.triangles.length };
}

module.exports = { renderPreview, parseObj };
