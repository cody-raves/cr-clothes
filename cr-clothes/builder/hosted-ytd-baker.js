const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const RSC7_MAGIC = 0x37435352;
const BASE_PAGE_SIZE = 0x2000;
const SYSTEM_BASE = 0x50000000;
const GRAPHICS_BASE = 0x60000000;
const TEXTURE_STRUCT_LENGTH = 0x90;
const FORMAT_A8R8G8B8 = 21;

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function inside(root, candidate) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(candidate);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Refusing to write outside the resource folder: ${resolved}`);
    }
    return resolved;
}

function relativeResourcePath(resourceRoot, filePath) {
    return path.relative(resourceRoot, filePath).replace(/\\/g, '/');
}

function cleanPathSegment(value, label) {
    const text = String(value || '').trim();
    if (!text || text.includes('/') || text.includes('\\') || text.includes('..') || text.includes(':')) {
        throw new Error(`Invalid ${label}.`);
    }
    return text;
}

function fullCollectionForSlot(slot) {
    if (slot.fullCollection) return cleanPathSegment(slot.fullCollection, 'collection folder');

    const gender = slot.gender === 'male' ? 'male' : 'female';
    const ped = gender === 'male' ? 'mp_m_freemode_01' : 'mp_f_freemode_01';
    const prefix = gender === 'male' ? 'mp_m_' : 'mp_f_';
    return cleanPathSegment(`${ped}_${prefix}${slot.collection || ''}`, 'collection folder');
}

function decodePageFlags(flags) {
    const sizeShift = flags & 0xF;
    const baseSize = BASE_PAGE_SIZE << sizeShift;
    const fields = {
        versionNibble: (flags >>> 28) & 0xF,
        div16: (flags >>> 27) & 0x1,
        div8: (flags >>> 26) & 0x1,
        div4: (flags >>> 25) & 0x1,
        div2: (flags >>> 24) & 0x1,
        mul1: (flags >>> 17) & 0x7F,
        mul2: (flags >>> 11) & 0x3F,
        mul4: (flags >>> 7) & 0xF,
        mul8: (flags >>> 5) & 0x3,
        mul16: (flags >>> 4) & 0x1,
        sizeShift
    };

    const size =
        (baseSize * fields.div16 / 16) +
        (baseSize * fields.div8 / 8) +
        (baseSize * fields.div4 / 4) +
        (baseSize * fields.div2 / 2) +
        (baseSize * fields.mul1) +
        (baseSize * fields.mul2 * 2) +
        (baseSize * fields.mul4 * 4) +
        (baseSize * fields.mul8 * 8) +
        (baseSize * fields.mul16 * 16);

    return { ...fields, baseSize, size };
}

function encodePageFlags(versionNibble, layout) {
    return (
        ((versionNibble & 0xF) << 28) |
        ((layout.div16 || 0) << 27) |
        ((layout.div8 || 0) << 26) |
        ((layout.div4 || 0) << 25) |
        ((layout.div2 || 0) << 24) |
        ((layout.mul1 || 0) << 17) |
        ((layout.mul2 || 0) << 11) |
        ((layout.mul4 || 0) << 7) |
        ((layout.mul8 || 0) << 5) |
        ((layout.mul16 || 0) << 4) |
        (layout.sizeShift || 0)
    ) >>> 0;
}

function singleBlockPageLayout(byteLength) {
    let sizeShift = 0;
    let pageSize = BASE_PAGE_SIZE;
    while (pageSize < byteLength) {
        pageSize *= 2;
        sizeShift++;
        if (sizeShift > 15) {
            throw new Error(`Texture payload is too large for a single RSC7 graphics page (${byteLength} bytes).`);
        }
    }

    return {
        pageSize,
        pageCount: byteLength > 0 ? 1 : 0,
        flags: {
            div16: 0,
            div8: 0,
            div4: 0,
            div2: 0,
            mul1: byteLength > 0 ? 1 : 0,
            mul2: 0,
            mul4: 0,
            mul8: 0,
            mul16: 0,
            sizeShift
        }
    };
}

function readRsc7(filePath) {
    const raw = fs.readFileSync(filePath);
    if (raw.length < 16 || raw.readUInt32LE(0) !== RSC7_MAGIC) {
        throw new Error(`${path.basename(filePath)} is not an RSC7 resource file.`);
    }

    const version = raw.readInt32LE(4);
    const systemFlags = raw.readUInt32LE(8);
    const graphicsFlags = raw.readUInt32LE(12);
    const systemLayout = decodePageFlags(systemFlags);
    const graphicsLayout = decodePageFlags(graphicsFlags);
    const inflated = zlib.inflateRawSync(raw.subarray(16));
    const expectedLength = systemLayout.size + graphicsLayout.size;
    if (inflated.length < expectedLength) {
        throw new Error(`${path.basename(filePath)} ended early while reading RSC7 pages.`);
    }

    return {
        raw,
        version,
        systemFlags,
        graphicsFlags,
        systemLayout,
        graphicsLayout,
        systemData: Buffer.from(inflated.subarray(0, systemLayout.size)),
        graphicsData: Buffer.from(inflated.subarray(systemLayout.size, expectedLength))
    };
}

// Persist a buffer to disk. On hosted FiveM servers the Node fs write is jailed
// (EACCES), so the FiveM caller passes a `saveFile(relPath, buffer)` that routes
// through SaveResourceFile (see builder/fs-bridge.lua). Offline/dev callers omit
// it and get the atomic temp-file + rename fs path.
function persist(resourceRoot, absPath, buffer, saveFile) {
    if (typeof saveFile === 'function') {
        const rel = path.relative(resourceRoot, absPath).replace(/\\/g, '/');
        const ok = saveFile(rel, buffer);
        if (ok === false) {
            throw new Error(`Hosted save via SaveResourceFile refused '${rel}'. The FXServer process could not write it.`);
        }
        return;
    }

    const tempPath = `${absPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tempPath, buffer);
        fs.renameSync(tempPath, absPath);
    } catch (error) {
        try { fs.rmSync(tempPath, { force: true }); } catch {}
        if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
            throw new Error(`Hosted bake cannot write '${absPath}'. On a hosted server this must go through SaveResourceFile (pass options.saveFile). Original error: ${error.message}`);
        }
        throw error;
    }
}

// Probe whether the directory holding `targetPath` is writable, using the same
// write path that the real bake will use (SaveResourceFile when hosted, fs
// otherwise) so the capability check can't disagree with the actual bake.
function probeWritable(resourceRoot, targetPath, saveFile, deleteFile) {
    const directory = path.dirname(targetPath);
    if (typeof saveFile === 'function') {
        const markerAbs = path.join(directory, `.hosted-baker-write-test-${process.pid}-${Date.now()}`);
        const rel = path.relative(resourceRoot, markerAbs).replace(/\\/g, '/');
        const ok = saveFile(rel, Buffer.from('ok'));
        if (typeof deleteFile === 'function') { try { deleteFile(rel); } catch {} }
        if (ok === false) {
            const error = new Error(`SaveResourceFile refused a probe write in '${path.relative(resourceRoot, directory).replace(/\\/g, '/')}'.`);
            error.code = 'SAVE_REFUSED';
            throw error;
        }
        return;
    }

    const testPath = path.join(directory, `.hosted-baker-write-test-${process.pid}-${Date.now()}.tmp`);
    try {
        fs.accessSync(directory, fs.constants.W_OK);
        fs.writeFileSync(testPath, 'ok');
        fs.rmSync(testPath, { force: true });
    } catch (error) {
        try { fs.rmSync(testPath, { force: true }); } catch {}
        throw error;
    }
}

function writeRsc7(resourceRoot, filePath, resource, saveFile) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(RSC7_MAGIC, 0);
    header.writeInt32LE(resource.version, 4);
    header.writeUInt32LE(resource.systemFlags >>> 0, 8);
    header.writeUInt32LE(resource.graphicsFlags >>> 0, 12);

    const payload = Buffer.concat([resource.systemData, resource.graphicsData]);
    const compressed = zlib.deflateRawSync(payload, { level: 6 });
    persist(resourceRoot, filePath, Buffer.concat([header, compressed]), saveFile);
}

function readStringZ(buffer, offset, maxLength = 128) {
    if (offset < 0 || offset >= buffer.length) return '';
    const end = buffer.indexOf(0, offset);
    const limit = end >= 0 ? end : Math.min(buffer.length, offset + maxLength);
    return buffer.subarray(offset, Math.min(limit, offset + maxLength)).toString('utf8');
}

function virtualSystemOffset(pointer) {
    if (pointer < SYSTEM_BASE || pointer >= GRAPHICS_BASE) return -1;
    return pointer - SYSTEM_BASE;
}

function virtualGraphicsOffset(pointer) {
    if (pointer < GRAPHICS_BASE) return -1;
    return pointer - GRAPHICS_BASE;
}

function isKnownTextureFormat(format) {
    return format === FORMAT_A8R8G8B8 ||
        format === 25 ||
        format === 28 ||
        format === 32 ||
        format === 50 ||
        format === 0x31545844 ||
        format === 0x33545844 ||
        format === 0x35545844 ||
        format === 0x31495441 ||
        format === 0x32495441 ||
        format === 0x20374342;
}

function findTextureCandidates(systemData, graphicsDataLength) {
    const candidates = [];
    for (let offset = 0; offset <= systemData.length - TEXTURE_STRUCT_LENGTH; offset += 4) {
        const namePointer = Number(systemData.readBigUInt64LE(offset + 0x28));
        const nameOffset = virtualSystemOffset(namePointer);
        if (nameOffset < 0 || nameOffset >= systemData.length) continue;

        const name = readStringZ(systemData, nameOffset, 128);
        if (!/^[a-z0-9_]{3,96}$/i.test(name)) continue;

        const width = systemData.readUInt16LE(offset + 0x50);
        const height = systemData.readUInt16LE(offset + 0x52);
        const stride = systemData.readUInt16LE(offset + 0x56);
        const format = systemData.readUInt32LE(offset + 0x58);
        const levels = systemData.readUInt8(offset + 0x5D);
        const dataPointer = Number(systemData.readBigUInt64LE(offset + 0x70));
        const dataOffset = virtualGraphicsOffset(dataPointer);

        if (width < 1 || width > 8192 || height < 1 || height > 8192) continue;
        if (levels < 1 || levels > 16) continue;
        if (!isKnownTextureFormat(format)) continue;
        if (dataOffset < 0 || dataOffset >= Math.max(1, graphicsDataLength)) continue;
        if (stride < 1 && format === FORMAT_A8R8G8B8) continue;

        candidates.push({ offset, name, width, height, stride, format, levels, dataOffset });
    }

    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const key = `${candidate.offset}:${candidate.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate);
    }
    return deduped;
}

function findTexture(systemData, graphicsDataLength, preferredName) {
    const candidates = findTextureCandidates(systemData, graphicsDataLength);
    if (!candidates.length) {
        throw new Error('The selected YTD does not contain an editable texture.');
    }

    const wanted = String(preferredName || '').trim().toLowerCase();
    if (wanted) {
        const exact = candidates.find(candidate => candidate.name.toLowerCase() === wanted);
        if (exact) return { texture: exact, candidates };
    }

    return { texture: candidates[0], candidates };
}

function calculateMaxMipLevels(width, height) {
    let levels = 1;
    let w = width;
    let h = height;
    while (w > 1 || h > 1) {
        w = Math.max(1, Math.floor(w / 2));
        h = Math.max(1, Math.floor(h / 2));
        levels++;
    }
    return levels;
}

function downsampleRgba(source, width, height) {
    const nextWidth = Math.max(1, Math.floor(width / 2));
    const nextHeight = Math.max(1, Math.floor(height / 2));
    const output = Buffer.alloc(nextWidth * nextHeight * 4);

    for (let y = 0; y < nextHeight; y++) {
        for (let x = 0; x < nextWidth; x++) {
            const acc = [0, 0, 0, 0];
            let count = 0;
            for (let oy = 0; oy < 2; oy++) {
                for (let ox = 0; ox < 2; ox++) {
                    const sx = Math.min(width - 1, x * 2 + ox);
                    const sy = Math.min(height - 1, y * 2 + oy);
                    const index = (sy * width + sx) * 4;
                    acc[0] += source[index];
                    acc[1] += source[index + 1];
                    acc[2] += source[index + 2];
                    acc[3] += source[index + 3];
                    count++;
                }
            }
            const out = (y * nextWidth + x) * 4;
            output[out] = Math.round(acc[0] / count);
            output[out + 1] = Math.round(acc[1] / count);
            output[out + 2] = Math.round(acc[2] / count);
            output[out + 3] = Math.round(acc[3] / count);
        }
    }

    return { data: output, width: nextWidth, height: nextHeight };
}

function rgbaToBgra(source) {
    const output = Buffer.alloc(source.length);
    for (let index = 0; index < source.length; index += 4) {
        output[index] = source[index + 2];
        output[index + 1] = source[index + 1];
        output[index + 2] = source[index];
        output[index + 3] = source[index + 3];
    }
    return output;
}

function buildBgraMipChain(rgba, width, height, levels) {
    const chunks = [];
    let current = Buffer.from(rgba);
    let currentWidth = width;
    let currentHeight = height;

    for (let level = 0; level < levels; level++) {
        chunks.push(rgbaToBgra(current));
        if (level === levels - 1) break;
        const next = downsampleRgba(current, currentWidth, currentHeight);
        current = next.data;
        currentWidth = next.width;
        currentHeight = next.height;
    }

    return Buffer.concat(chunks);
}

function patchPagesInfo(systemData, graphicsPageCount) {
    if (systemData.length < 16) return;
    const pagesPointer = Number(systemData.readBigUInt64LE(8));
    const pagesOffset = virtualSystemOffset(pagesPointer);
    if (pagesOffset < 0 || pagesOffset + 10 > systemData.length) return;
    systemData.writeUInt8(1, pagesOffset + 8);
    systemData.writeUInt8(Math.max(0, Math.min(127, graphicsPageCount)), pagesOffset + 9);
}

function patchTextureStruct(systemData, textureOffset, width, height, levels) {
    // Match RageLib's TextureWrapper_GTA5_pc.UpdateClass() output for normal
    // streamed PC textures, then apply the Reset(...) fields.
    systemData.writeUInt32LE(0x40619638, textureOffset + 0x00);
    systemData.writeUInt32LE(0x00000001, textureOffset + 0x04);
    for (const fieldOffset of [
        0x08, 0x0C, 0x10, 0x14, 0x18, 0x1C, 0x20, 0x24,
        0x34, 0x38, 0x3C, 0x40, 0x44, 0x48, 0x4C,
        0x60, 0x64, 0x68, 0x6C, 0x78, 0x7C, 0x80, 0x84, 0x88, 0x8C
    ]) {
        systemData.writeUInt32LE(0, textureOffset + fieldOffset);
    }
    systemData.writeUInt32LE(0x00800001, textureOffset + 0x30);
    systemData.writeUInt16LE(width, textureOffset + 0x50);
    systemData.writeUInt16LE(height, textureOffset + 0x52);
    systemData.writeUInt16LE(1, textureOffset + 0x54);
    systemData.writeUInt16LE(width * 4, textureOffset + 0x56);
    systemData.writeUInt32LE(FORMAT_A8R8G8B8, textureOffset + 0x58);
    systemData.writeUInt8(0, textureOffset + 0x5C);
    systemData.writeUInt8(levels, textureOffset + 0x5D);
    systemData.writeUInt16LE(0, textureOffset + 0x5E);
    systemData.writeBigUInt64LE(BigInt(GRAPHICS_BASE), textureOffset + 0x70);
}

function resolveSlotYtdPath(resourceRoot, slot, textureIndex) {
    const gender = slot.gender === 'male' ? 'male' : 'female';
    const pedFolder = gender === 'male' ? 'ped_male.rpf' : 'ped_female.rpf';
    const collectionFolder = fullCollectionForSlot(slot);
    const textureFiles = Array.isArray(slot.textureFiles) ? slot.textureFiles : [];
    if (!textureFiles.length) {
        throw new Error('The selected generated slot has no texture files.');
    }

    const index = Math.max(0, Math.min(textureFiles.length - 1, Math.floor(Number(textureIndex) || 0)));
    const requestedTextureFile = String(textureFiles[index] || '');
    if (path.basename(requestedTextureFile) !== requestedTextureFile) {
        throw new Error('Invalid texture file.');
    }
    const textureFile = cleanPathSegment(requestedTextureFile, 'texture file');
    if (!textureFile.toLowerCase().endsWith('.ytd')) {
        throw new Error('The selected texture variant is not a YTD file.');
    }

    // Owner-prepared garments keep their files in the drop folder and the slot
    // records where each one is (builder/garment-prepare.js). Built-in
    // templates use the stream/<ped>.rpf/<collection>/ layout.
    const mapped = slot.templateFiles && typeof slot.templateFiles[textureFile] === 'string' ? slot.templateFiles[textureFile] : null;
    const ytdPath = mapped
        ? inside(resourceRoot, path.join(resourceRoot, mapped))
        : inside(resourceRoot, path.join(resourceRoot, 'stream', pedFolder, collectionFolder, textureFile));
    return { ytdPath, textureFile, textureIndex: index };
}

function assertCanWriteYtd(resourceRoot, ytdPath, saveFile, deleteFile) {
    const relative = relativeResourcePath(resourceRoot, ytdPath);
    const directory = path.dirname(ytdPath);
    const relativeDirectory = relativeResourcePath(resourceRoot, directory);

    try {
        probeWritable(resourceRoot, ytdPath, saveFile, deleteFile);
    } catch (error) {
        const how = typeof saveFile === 'function'
            ? `SaveResourceFile was refused for '${relativeDirectory}' (is builder/fs-bridge.lua loaded?)`
            : `the FXServer user cannot write '${relativeDirectory}'`;
        const wrapped = new Error(`Hosted bake cannot write '${relative}'. ${how}. Original error: ${error.message}`);
        wrapped.code = error.code || 'WRITE_TEST_FAILED';
        wrapped.path = error.path || relative;
        wrapped.relative = relative;
        wrapped.directory = relativeDirectory;
        wrapped.causeMessage = error.message;
        throw wrapped;
    }
}

function bake(options) {
    const resourceRoot = path.resolve(options.resourceRoot);
    const registryPath = inside(resourceRoot, options.registryPath || path.join(resourceRoot, 'generated', 'registry.json'));
    const registry = readJson(registryPath, { version: 2, slots: [] });
    const slots = Array.isArray(registry.slots) ? registry.slots : [];
    const slotId = String(options.slotId || '').trim();
    const slot = slots.find(item => item && item.id === slotId);
    if (!slot) {
        throw new Error(`Generated slot '${slotId || '(blank)'}' was not found in generated/registry.json.`);
    }
    if (String(slot.assetMode || '').toLowerCase() !== 'generated') {
        throw new Error('This is a stock/runtime-preview garment. Select a prepared addon garment before exporting a baked YTD.');
    }

    const width = Math.floor(Number(options.width) || 1024);
    const height = Math.floor(Number(options.height) || 1024);
    if (width < 16 || width > 4096 || height < 16 || height > 4096) {
        throw new Error('Bake texture dimensions must be between 16 and 4096 pixels.');
    }

    const rgba = Buffer.from(options.rawRgba || []);
    const expectedLength = width * height * 4;
    if (rgba.length !== expectedLength) {
        throw new Error(`Raw RGBA payload was ${rgba.length} bytes; expected ${expectedLength} for ${width}x${height}.`);
    }

    const resolved = resolveSlotYtdPath(resourceRoot, slot, options.textureIndex);
    if (!fs.existsSync(resolved.ytdPath)) {
        throw new Error(`Prepared YTD variant is missing: ${path.relative(resourceRoot, resolved.ytdPath).replace(/\\/g, '/')}`);
    }
    // `outputPath` sends the baked YTD somewhere outside the resource (e.g. /tmp).
    // Hosted servers mount the resource tree read-only, so this is the only way
    // to produce a file there: read the template in place, write the result out.
    const outputPath = options.outputPath ? path.resolve(options.outputPath) : null;
    if (!outputPath) {
        assertCanWriteYtd(resourceRoot, resolved.ytdPath, options.saveFile, options.deleteFile);
    }

    const resource = readRsc7(resolved.ytdPath);
    const preferredTextureName = slot.sourceTextureName || path.basename(resolved.textureFile, '.ytd');
    const { texture, candidates } = findTexture(resource.systemData, resource.graphicsData.length, preferredTextureName);
    if (candidates.length !== 1) {
        throw new Error(`Hosted baker supports prepared single-texture YTD variants right now; '${resolved.textureFile}' has ${candidates.length}.`);
    }

    const levels = Math.min(Math.max(1, texture.levels || 1), calculateMaxMipLevels(width, height));
    const textureData = buildBgraMipChain(rgba, width, height, levels);
    const graphicsLayout = singleBlockPageLayout(textureData.length);
    const graphicsData = Buffer.alloc(graphicsLayout.pageSize * graphicsLayout.pageCount);
    textureData.copy(graphicsData, 0);

    patchTextureStruct(resource.systemData, texture.offset, width, height, levels);
    patchPagesInfo(resource.systemData, graphicsLayout.pageCount);

    const systemVersionNibble = (resource.version >> 4) & 0xF;
    const graphicsVersionNibble = resource.version & 0xF;
    const systemFlags = encodePageFlags(systemVersionNibble, resource.systemLayout);
    const graphicsFlags = encodePageFlags(graphicsVersionNibble, graphicsLayout.flags);
    // Writing outside the resource uses plain fs; in-place writing uses the
    // injected SaveResourceFile bridge when the caller supplied one.
    writeRsc7(resourceRoot, outputPath || resolved.ytdPath, {
        version: resource.version,
        systemFlags,
        graphicsFlags,
        systemData: resource.systemData,
        graphicsData
    }, outputPath ? undefined : options.saveFile);

    const now = new Date().toISOString();
    slot.textureCount = Math.max(Number(slot.textureCount) || 0, (slot.textureFiles || []).length);
    slot.bakedVariants = Array.isArray(slot.bakedVariants) ? slot.bakedVariants : [];
    slot.bakedVariants = slot.bakedVariants.filter(item => Number(item?.textureIndex) !== resolved.textureIndex);
    slot.bakedVariants.push({
        textureIndex: resolved.textureIndex,
        textureFile: resolved.textureFile,
        label: String(options.exportName || `Variant ${resolved.textureIndex}`).trim().slice(0, 64),
        width,
        height,
        format: 'A8R8G8B8',
        mipLevels: levels,
        bakedAt: now
    });
    registry.generatedAt = now;
    registry.assetMode = slots.some(item => String(item?.assetMode || '').toLowerCase() === 'existing') ? 'mixed' : 'generated';

    // Bookkeeping only. On a read-only host this write fails; that must not throw
    // away a bake that already succeeded, so record the failure and carry on.
    let registryWriteError = null;
    if (options.skipRegistry !== true) {
        try {
            persist(resourceRoot, registryPath, Buffer.from(JSON.stringify(registry, null, 2)), options.saveFile);
        } catch (error) {
            registryWriteError = error?.message || String(error);
        }
    } else {
        registryWriteError = 'skipped by caller';
    }

    return {
        ok: true,
        message: outputPath
            ? `Baked design to ${outputPath}. Install it into the streamed collection to use it.`
            : `Baked design into ${resolved.textureFile}. Restart the server/resource for streamed clothing clients to load it.`,
        restartRequired: true,
        registry,
        outputPath,
        registryWriteError,
        bakedTextureFile: path.relative(resourceRoot, resolved.ytdPath).replace(/\\/g, '/'),
        bakedTextureIndex: resolved.textureIndex,
        bakedSlotId: slot.id,
        textureName: texture.name,
        mipLevels: levels,
        graphicsPageSize: graphicsLayout.pageSize
    };
}

function checkCapability(options) {
    const resourceRoot = path.resolve(options.resourceRoot);
    const saveFile = options.saveFile;
    const deleteFile = options.deleteFile;
    const result = {
        ok: false,
        nodeVersion: process.versions.node,
        nodeMajor: Number(String(process.versions.node || '0').split('.')[0]) || 0,
        writable: false,
        registryFound: false,
        generatedSlots: 0,
        preparedTextureFiles: 0,
        writableTextureFiles: 0,
        writeErrors: [],
        message: ''
    };

    if (result.nodeMajor < 22) {
        result.message = `Hosted baking needs FiveM Node 22; current Node is ${process.versions.node}.`;
        return result;
    }

    try {
        probeWritable(resourceRoot, path.join(resourceRoot, '.hosted-baker-write-test'), saveFile, deleteFile);
        result.writable = true;
    } catch (error) {
        result.message = `Hosted bake unavailable: resource folder is not writable (${error.message}).`;
        return result;
    }

    const registryPath = inside(resourceRoot, options.registryPath || path.join(resourceRoot, 'generated', 'registry.json'));
    const registry = readJson(registryPath, null);
    result.registryFound = !!registry;
    const slots = Array.isArray(registry?.slots) ? registry.slots : [];
    const generated = slots.filter(slot => String(slot?.assetMode || '').toLowerCase() === 'generated');
    result.generatedSlots = generated.length;

    for (const slot of generated) {
        try {
            const resolved = resolveSlotYtdPath(resourceRoot, slot, 0);
            if (fs.existsSync(resolved.ytdPath)) {
                result.preparedTextureFiles++;
                try {
                    assertCanWriteYtd(resourceRoot, resolved.ytdPath, saveFile, deleteFile);
                    result.writableTextureFiles++;
                } catch (error) {
                    result.writeErrors.push({
                        slotId: slot.id || '',
                        textureFile: resolved.textureFile,
                        relative: error.relative || relativeResourcePath(resourceRoot, resolved.ytdPath),
                        directory: error.directory || relativeResourcePath(resourceRoot, path.dirname(resolved.ytdPath)),
                        code: error.code || '',
                        error: error.causeMessage || error.message
                    });
                }
            } else {
                result.writeErrors.push({
                    slotId: slot.id || '',
                    textureFile: resolved.textureFile,
                    relative: relativeResourcePath(resourceRoot, resolved.ytdPath),
                    directory: relativeResourcePath(resourceRoot, path.dirname(resolved.ytdPath)),
                    code: 'ENOENT',
                    error: 'Prepared YTD variant is missing.'
                });
            }
        } catch (error) {
            result.writeErrors.push({
                slotId: slot?.id || '',
                textureFile: '',
                relative: '',
                directory: '',
                code: error.code || 'CHECK_FAILED',
                error: error.message
            });
        }
    }

    if (!result.registryFound) {
        result.message = 'Hosted bake unavailable: generated/registry.json is missing.';
        return result;
    }
    if (!result.generatedSlots) {
        result.message = 'Hosted bake ready for runtime previews. Add a prepared addon template pack before baking streamable YTD variants.';
        return result;
    }
    if (!result.preparedTextureFiles) {
        result.message = 'Hosted bake unavailable: generated addon slots exist, but their prepared YTD files are missing.';
        return result;
    }
    if (!result.writableTextureFiles) {
        const first = result.writeErrors[0];
        const detail = first
            ? ` First failure: ${first.relative || first.directory || first.textureFile || first.slotId} (${first.code || 'ERR'}: ${first.error}).`
            : '';
        result.message = `Hosted bake unavailable: prepared YTD files exist, but the FXServer process cannot write to the stream folder. Fix Linux ownership/permissions on the resource directory.${detail}`;
        return result;
    }

    result.ok = true;
    result.message = `Hosted bake ready: ${result.generatedSlots} generated slot(s), ${result.writableTextureFiles}/${result.preparedTextureFiles} writable prepared YTD seed file(s).`;
    return result;
}

module.exports = {
    bake,
    checkCapability,
    readRsc7,
    decodePageFlags,
    buildBgraMipChain
};
