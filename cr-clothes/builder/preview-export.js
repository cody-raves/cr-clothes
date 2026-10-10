// builder/preview-export.js
// Turns a mesh read by builder/ydd-reader.js into the three files the editor
// loads for a garment:
//
//   model.obj       the 3D preview mesh (Y-up, raw game UVs, top-left origin)
//   uv.svg          the UV wireframe drawn over the design canvas
//   manifest.json   what the files are and how they were made
//
// The format matches the previews already in generated/previews/ (manifest
// version 7, uvTransform 'none'), so the NUI viewer, the server-side card
// renderer and the bot need no changes to use them.

'use strict';

const GUIDE_SIZE = 1024;

// Shortest decimal that survives a float32 round trip closely enough for a
// preview mesh, without trailing zeros.
function num(value) {
    return String(Number(value.toFixed(6)));
}

function buildObj(mesh) {
    const lines = ['# raw-UV garment preview (no transforms; vt = game UVs, top-left origin)'];
    for (let i = 0; i < mesh.vertexCount; i++) {
        lines.push('v ' + num(mesh.positions[i * 3]) + ' ' + num(mesh.positions[i * 3 + 1]) + ' ' + num(mesh.positions[i * 3 + 2]));
    }
    for (let i = 0; i < mesh.vertexCount; i++) {
        lines.push('vt ' + num(mesh.uvs[i * 2]) + ' ' + num(mesh.uvs[i * 2 + 1]));
    }
    if (mesh.normals) {
        for (let i = 0; i < mesh.vertexCount; i++) {
            lines.push('vn ' + num(mesh.normals[i * 3]) + ' ' + num(mesh.normals[i * 3 + 1]) + ' ' + num(mesh.normals[i * 3 + 2]));
        }
    }
    for (let t = 0; t < mesh.triangleCount; t++) {
        const corners = [];
        for (let k = 0; k < 3; k++) {
            const index = mesh.indices[t * 3 + k] + 1;
            corners.push(mesh.normals ? index + '/' + index + '/' + index : index + '/' + index);
        }
        lines.push('f ' + corners.join(' '));
    }
    lines.push('');
    return lines.join('\n');
}

// One path per triangle, in canvas pixels. A triangle whose UVs sit in a
// neighbouring tile (u or v outside 0..1) samples the same texture through
// wrapping, so it is shifted back by whole tiles: the guide then shows where
// on the canvas that part of the garment actually reads from.
function buildUvSvg(mesh) {
    const parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + GUIDE_SIZE + ' ' + GUIDE_SIZE + '">'
        + '<g fill="none" stroke="#dff3ff" stroke-opacity=".72" stroke-width="1">'
    ];
    for (let t = 0; t < mesh.triangleCount; t++) {
        const uv = [];
        for (let k = 0; k < 3; k++) {
            const index = mesh.indices[t * 3 + k];
            uv.push([mesh.uvs[index * 2], mesh.uvs[index * 2 + 1]]);
        }
        const shiftU = Math.floor((uv[0][0] + uv[1][0] + uv[2][0]) / 3);
        const shiftV = Math.floor((uv[0][1] + uv[1][1] + uv[2][1]) / 3);
        const p = uv.map(([u, v]) => ((u - shiftU) * GUIDE_SIZE).toFixed(3) + ' ' + ((v - shiftV) * GUIDE_SIZE).toFixed(3));
        parts.push('<path d="M ' + p[0] + ' L ' + p[1] + ' L ' + p[2] + ' Z"/>');
    }
    parts.push('</g></svg>');
    return parts.join('\n') + '\n';
}

function buildManifest(mesh, info) {
    return {
        version: 7,
        source: 'cr-clothes ydd-reader',
        exactUv: true,
        uvOrigin: 'top-left',
        uvTransform: 'none',
        hasNormals: Boolean(mesh.normals),
        lod: mesh.lod,
        model: 'model.obj',
        uvGuide: 'uv.svg',
        label: info.label,
        sourceFile: info.sourceFile || null,
        geometries: mesh.geometryCount,
        vertices: mesh.vertexCount,
        triangles: mesh.triangleCount,
        generatedAt: new Date().toISOString()
    };
}

// buildPreview(mesh, { label, sourceFile }) -> [{ name, data }]
function buildPreview(mesh, info) {
    return [
        { name: 'model.obj', data: Buffer.from(buildObj(mesh), 'utf8') },
        { name: 'uv.svg', data: Buffer.from(buildUvSvg(mesh), 'utf8') },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(buildManifest(mesh, info), null, 2), 'utf8') }
    ];
}

// Folder name under generated/previews/, e.g. female_pants_<collection>_048.
function previewNameFor(entry) {
    const collection = String(entry.collection || 'custom').replace(/[^A-Za-z0-9_]+/g, '_');
    return entry.gender + '_' + entry.category + '_' + collection + '_' + String(entry.drawableId).padStart(3, '0');
}

// The registry fields the editor reads to load an exact preview.
function previewRegistryFields(previewName) {
    const base = 'generated/previews/' + previewName;
    return {
        exact: true,
        source: 'cr-clothes ydd-reader',
        model: base + '/model.obj',
        uvGuide: base + '/uv.svg',
        manifest: base + '/manifest.json',
        guideUvTransform: 'none',
        renderUvTransform: 'none',
        yawOffset: 0
    };
}

module.exports = { buildObj, buildUvSvg, buildManifest, buildPreview, previewNameFor, previewRegistryFields };
