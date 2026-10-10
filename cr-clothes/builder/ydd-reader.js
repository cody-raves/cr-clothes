// builder/ydd-reader.js
// Reads garment meshes straight out of GTA V .ydd files, in pure JavaScript.
//
// A .ydd is an RSC7 container (the same wrapper the texture baker already
// handles) holding a dictionary of drawables. This walks
//
//   dictionary -> drawable -> LOD model list -> model -> geometry
//              -> vertex buffer (+ its declaration) and index buffer
//
// and returns positions, UVs, normals and triangles. That is everything the
// editor's 3D preview and UV guide need, so preparing a garment no longer
// depends on CodeWalker, Windows or .NET, and it can run inside the server.
//
// The files are owner-supplied, so every pointer, count and offset is bounds
// checked and a malformed file fails with a clear error instead of a crash.
//
// Offsets are for the legacy PC (gen8) drawable layout FiveM uses.

'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

const RSC7_MAGIC = 0x37435352;
const BASE_PAGE_SIZE = 0x2000;
const YDD_VERSION = 165;

// Sanity limits. A ped garment is a few thousand vertices; anything far past
// these is a corrupt or hostile file, not clothing.
const MAX_DRAWABLES = 64;
const MAX_MODELS = 64;
const MAX_GEOMETRIES = 256;
const MAX_VERTICES = 1000000;
const MAX_INDICES = 6000000;

// Vertex semantics, by bit index in the declaration's flags.
const SEMANTICS = [
    'position', 'blendWeights', 'blendIndices', 'normal', 'colour0', 'colour1',
    'texcoord0', 'texcoord1', 'texcoord2', 'texcoord3', 'texcoord4', 'texcoord5',
    'texcoord6', 'texcoord7', 'tangent', 'binormal'
];

// Component storage types (4 bits per semantic in the declaration's types).
const TYPE = { HALF2: 1, FLOAT: 2, HALF4: 3, FLOAT2: 5, FLOAT3: 6, FLOAT4: 7, UBYTE4: 8, COLOUR: 9, DEC3N: 10 };
const TYPE_SIZE = { 0: 0, 1: 4, 2: 4, 3: 8, 4: 0, 5: 8, 6: 12, 7: 16, 8: 4, 9: 4, 10: 4 };

function fail(message) {
    const error = new Error(message);
    error.code = 'bad_ydd';
    return error;
}

function pageSize(flags) {
    const base = BASE_PAGE_SIZE << (flags & 0xF);
    return (base * ((flags >>> 27) & 1) / 16) + (base * ((flags >>> 26) & 1) / 8)
        + (base * ((flags >>> 25) & 1) / 4) + (base * ((flags >>> 24) & 1) / 2)
        + (base * ((flags >>> 17) & 0x7F)) + (base * ((flags >>> 11) & 0x3F) * 2)
        + (base * ((flags >>> 7) & 0xF) * 4) + (base * ((flags >>> 5) & 0x3) * 8)
        + (base * ((flags >>> 4) & 0x1) * 16);
}

function openResource(input) {
    const raw = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    if (raw.length < 16 || raw.readUInt32LE(0) !== RSC7_MAGIC) {
        throw fail('not an RSC7 resource (is this really a .ydd?)');
    }
    const version = raw.readInt32LE(4);
    const systemSize = pageSize(raw.readUInt32LE(8));
    const graphicsSize = pageSize(raw.readUInt32LE(12));
    let inflated;
    try {
        inflated = zlib.inflateRawSync(raw.subarray(16), { maxOutputLength: 512 * 1024 * 1024 });
    } catch (error) {
        throw fail('could not decompress resource: ' + error.message);
    }
    if (inflated.length < systemSize) throw fail('resource is truncated');
    return {
        version,
        system: inflated.subarray(0, systemSize),
        graphics: inflated.subarray(systemSize, Math.min(inflated.length, systemSize + graphicsSize))
    };
}

// A cursor over the two resource segments. Pointers carry their segment in the
// top nibble: 5 = system, 6 = graphics.
function createView(resource) {
    function resolve(pointer, length, what) {
        const segment = pointer >>> 28;
        const offset = pointer & 0x0FFFFFFF;
        const buffer = segment === 5 ? resource.system : segment === 6 ? resource.graphics : null;
        if (!buffer) throw fail(what + ': pointer 0x' + pointer.toString(16) + ' is not inside the resource');
        if (offset + length > buffer.length) throw fail(what + ': runs past the end of the resource');
        return { buffer, offset };
    }
    // Reads the pointer stored at `offset` in the system segment; 0 means null.
    function pointerAt(offset, what) {
        if (offset + 8 > resource.system.length) throw fail(what + ': pointer field out of range');
        return resource.system.readUInt32LE(offset);
    }
    function u16(offset) { return resource.system.readUInt16LE(offset); }
    return { resolve, pointerAt, u16, system: resource.system };
}

function halfToFloat(h) {
    const sign = (h & 0x8000) ? -1 : 1;
    const exponent = (h >> 10) & 0x1F;
    const mantissa = h & 0x3FF;
    if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}

function readDeclaration(view, pointer) {
    const { buffer, offset } = view.resolve(pointer, 16, 'vertex declaration');
    const flags = buffer.readUInt32LE(offset);
    const stride = buffer.readUInt16LE(offset + 4);
    const types = buffer.readBigUInt64LE(offset + 8);

    const components = {};
    let cursor = 0;
    for (let bit = 0; bit < 16; bit++) {
        if (!((flags >>> bit) & 1)) continue;
        const type = Number((types >> BigInt(bit * 4)) & 0xFn);
        const size = TYPE_SIZE[type];
        if (size === undefined) throw fail('vertex declaration uses unknown component type ' + type);
        components[SEMANTICS[bit]] = { type, offset: cursor, size };
        cursor += size;
    }
    if (cursor > stride) throw fail('vertex declaration is larger than its stride');
    return { flags, stride, components };
}

function readVec3(buffer, at, component) {
    switch (component.type) {
        case TYPE.FLOAT3:
        case TYPE.FLOAT4:
            return [buffer.readFloatLE(at), buffer.readFloatLE(at + 4), buffer.readFloatLE(at + 8)];
        case TYPE.HALF4:
            return [halfToFloat(buffer.readUInt16LE(at)), halfToFloat(buffer.readUInt16LE(at + 2)), halfToFloat(buffer.readUInt16LE(at + 4))];
        case TYPE.DEC3N: {
            // Packed 10:10:10 signed, normalised.
            const packed = buffer.readUInt32LE(at);
            const unpack = shift => {
                let v = (packed >>> shift) & 0x3FF;
                if (v & 0x200) v -= 0x400;
                return Math.max(-1, v / 511);
            };
            return [unpack(0), unpack(10), unpack(20)];
        }
        default:
            return null;
    }
}

function readVec2(buffer, at, component) {
    switch (component.type) {
        case TYPE.FLOAT2:
        case TYPE.FLOAT3:
        case TYPE.FLOAT4:
            return [buffer.readFloatLE(at), buffer.readFloatLE(at + 4)];
        case TYPE.HALF2:
        case TYPE.HALF4:
            return [halfToFloat(buffer.readUInt16LE(at)), halfToFloat(buffer.readUInt16LE(at + 2))];
        default:
            return null;
    }
}

function readGeometry(view, geometryOffset) {
    const vertexBufferPointer = view.pointerAt(geometryOffset + 0x18, 'geometry');
    const indexBufferPointer = view.pointerAt(geometryOffset + 0x38, 'geometry');
    if (!vertexBufferPointer || !indexBufferPointer) throw fail('geometry has no vertex or index buffer');

    // Vertex buffer: stride @0x08, data @0x10, count @0x18, declaration @0x30.
    const vb = view.resolve(vertexBufferPointer, 0x38, 'vertex buffer');
    const stride = vb.buffer.readUInt16LE(vb.offset + 0x08);
    const vertexCount = vb.buffer.readUInt32LE(vb.offset + 0x18);
    const dataPointer = vb.buffer.readUInt32LE(vb.offset + 0x10) || vb.buffer.readUInt32LE(vb.offset + 0x20);
    const declarationPointer = vb.buffer.readUInt32LE(vb.offset + 0x30);
    if (!dataPointer || !declarationPointer) throw fail('vertex buffer has no data or declaration');
    if (vertexCount === 0 || vertexCount > MAX_VERTICES) throw fail('implausible vertex count ' + vertexCount);

    const declaration = readDeclaration(view, declarationPointer);
    if (declaration.stride !== stride || stride === 0) throw fail('vertex stride does not match its declaration');
    const position = declaration.components.position;
    if (!position) throw fail('geometry has no positions');

    const data = view.resolve(dataPointer, vertexCount * stride, 'vertex data');
    const uv = declaration.components.texcoord0;
    const normal = declaration.components.normal;

    const positions = new Float32Array(vertexCount * 3);
    const uvs = uv ? new Float32Array(vertexCount * 2) : null;
    let normals = normal ? new Float32Array(vertexCount * 3) : null;

    for (let i = 0; i < vertexCount; i++) {
        const at = data.offset + i * stride;
        const p = readVec3(data.buffer, at + position.offset, position);
        if (!p) throw fail('unsupported position format (type ' + position.type + ')');
        positions.set(p, i * 3);
        if (uvs) {
            const t = readVec2(data.buffer, at + uv.offset, uv);
            if (!t) throw fail('unsupported UV format (type ' + uv.type + ')');
            uvs.set(t, i * 2);
        }
        if (normals) {
            const n = readVec3(data.buffer, at + normal.offset, normal);
            if (n) normals.set(n, i * 3);
            else normals = null;          // unknown normal packing: drop them, they are optional
        }
    }

    // Index buffer: count @0x08, data @0x10, 16-bit indices.
    const ib = view.resolve(indexBufferPointer, 0x18, 'index buffer');
    const indexCount = ib.buffer.readUInt32LE(ib.offset + 0x08);
    const indexPointer = ib.buffer.readUInt32LE(ib.offset + 0x10);
    if (!indexPointer) throw fail('index buffer has no data');
    if (indexCount === 0 || indexCount > MAX_INDICES || indexCount % 3 !== 0) throw fail('implausible index count ' + indexCount);
    const indexData = view.resolve(indexPointer, indexCount * 2, 'index data');
    const indices = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i++) {
        const index = indexData.buffer.readUInt16LE(indexData.offset + i * 2);
        if (index >= vertexCount) throw fail('index buffer references a vertex that does not exist');
        indices[i] = index;
    }

    return { vertexCount, indexCount, stride, declaration, positions, uvs, normals, indices };
}

// A pointer list is { pointer @0, count u16 @8 } and points at an array of
// 8-byte pointers.
function readPointerList(view, listOffset, limit, what) {
    const arrayPointer = view.pointerAt(listOffset, what);
    const count = view.u16(listOffset + 8);
    if (!arrayPointer || count === 0) return [];
    if (count > limit) throw fail(what + ': implausible count ' + count);
    const array = view.resolve(arrayPointer, count * 8, what);
    const out = [];
    for (let i = 0; i < count; i++) {
        const pointer = array.buffer.readUInt32LE(array.offset + i * 8);
        if (pointer) out.push(pointer);
    }
    return out;
}

function readModels(view, listPointer) {
    if (!listPointer) return [];
    const list = view.resolve(listPointer, 16, 'model list');
    const models = [];
    for (const modelPointer of readPointerList(view, list.offset, MAX_MODELS, 'model list')) {
        const model = view.resolve(modelPointer, 0x30, 'model');
        // Model: geometry pointer list starts at +0x08.
        const geometries = readPointerList(view, model.offset + 0x08, MAX_GEOMETRIES, 'geometry list')
            .map(pointer => readGeometry(view, view.resolve(pointer, 0x78, 'geometry').offset));
        models.push({ geometries });
    }
    return models;
}

const LOD_OFFSETS = { high: 0x50, med: 0x58, low: 0x60, vlow: 0x68 };

function readDrawable(view, drawableOffset) {
    const s = view.system;
    const bounds = {
        center: [s.readFloatLE(drawableOffset + 0x20), s.readFloatLE(drawableOffset + 0x24), s.readFloatLE(drawableOffset + 0x28)],
        radius: s.readFloatLE(drawableOffset + 0x2C),
        min: [s.readFloatLE(drawableOffset + 0x30), s.readFloatLE(drawableOffset + 0x34), s.readFloatLE(drawableOffset + 0x38)],
        max: [s.readFloatLE(drawableOffset + 0x40), s.readFloatLE(drawableOffset + 0x44), s.readFloatLE(drawableOffset + 0x48)]
    };
    const lods = {};
    for (const [name, offset] of Object.entries(LOD_OFFSETS)) {
        lods[name] = readModels(view, view.pointerAt(drawableOffset + offset, name + ' LOD'));
    }
    return { bounds, lods };
}

// readYdd(pathOrBuffer) -> { version, drawables: [{ hash, bounds, lods }] }
function readYdd(input) {
    const resource = openResource(input);
    if (resource.version !== YDD_VERSION) {
        throw fail('resource version ' + resource.version + ' is not a drawable dictionary (expected ' + YDD_VERSION + ')');
    }
    const view = createView(resource);
    if (resource.system.length < 0x40) throw fail('dictionary header is truncated');

    // Dictionary: hashes list @0x20, drawables list @0x30.
    const count = view.u16(0x38);
    if (count === 0) throw fail('dictionary contains no drawables');
    if (count > MAX_DRAWABLES) throw fail('implausible drawable count ' + count);

    const hashesPointer = view.pointerAt(0x20, 'dictionary');
    const hashes = hashesPointer ? view.resolve(hashesPointer, count * 4, 'dictionary hashes') : null;
    const drawables = readPointerList(view, 0x30, MAX_DRAWABLES, 'dictionary').map((pointer, index) => {
        const drawable = readDrawable(view, view.resolve(pointer, 0x70, 'drawable').offset);
        drawable.hash = hashes ? hashes.buffer.readUInt32LE(hashes.offset + index * 4) : 0;
        return drawable;
    });
    return { version: resource.version, drawables };
}

// extractMesh(pathOrBuffer) -> one merged mesh for the garment's best LOD.
//
// Output is Y-up with the game's untransformed UVs (top-left origin), the same
// convention the existing previews use: game (x, y, z) becomes (x, z, -y).
function extractMesh(input, options = {}) {
    const ydd = readYdd(input);
    const drawable = ydd.drawables[options.drawableIndex || 0];
    if (!drawable) throw fail('requested drawable does not exist');

    const lod = ['high', 'med', 'low', 'vlow'].find(name => drawable.lods[name].some(model => model.geometries.length));
    if (!lod) throw fail('drawable has no geometry in any LOD');
    const geometries = drawable.lods[lod].flatMap(model => model.geometries);

    const vertexCount = geometries.reduce((sum, g) => sum + g.vertexCount, 0);
    const indexCount = geometries.reduce((sum, g) => sum + g.indexCount, 0);
    const hasUvs = geometries.every(g => g.uvs);
    const hasNormals = geometries.every(g => g.normals);
    if (!hasUvs) throw fail('garment has no UV coordinates, so there is nothing to design on');

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const normals = hasNormals ? new Float32Array(vertexCount * 3) : null;
    const indices = new Uint32Array(indexCount);

    let vertexBase = 0;
    let indexBase = 0;
    for (const geometry of geometries) {
        for (let i = 0; i < geometry.vertexCount; i++) {
            const out = (vertexBase + i) * 3;
            positions[out] = geometry.positions[i * 3];
            positions[out + 1] = geometry.positions[i * 3 + 2];
            positions[out + 2] = -geometry.positions[i * 3 + 1];
            if (normals) {
                normals[out] = geometry.normals[i * 3];
                normals[out + 1] = geometry.normals[i * 3 + 2];
                normals[out + 2] = -geometry.normals[i * 3 + 1];
            }
        }
        uvs.set(geometry.uvs, vertexBase * 2);
        for (let i = 0; i < geometry.indexCount; i++) indices[indexBase + i] = geometry.indices[i] + vertexBase;
        vertexBase += geometry.vertexCount;
        indexBase += geometry.indexCount;
    }

    return {
        lod,
        drawableCount: ydd.drawables.length,
        geometryCount: geometries.length,
        vertexCount,
        triangleCount: indexCount / 3,
        positions,
        uvs,
        normals,
        indices,
        bounds: drawable.bounds
    };
}

module.exports = { readYdd, extractMesh };
