'use strict';

// ---------------------------------------------------------------------------
// resource-pack-exporter.js (v2) -- assemble installable clothing pack ZIPs
// ---------------------------------------------------------------------------
// On the production host the resource tree is READ-ONLY to the server process
// (both fs and SaveResourceFile), so the old fs-write-based exporter that
// assembled a resource folder inside the resource cannot work there. This
// version reads templates from the (readable) resource tree, bakes the design
// YTD out to the writable output dir via hosted-ytd-baker, and assembles the
// whole installable resource in memory as a single flat ZIP file in the
// output dir (/tmp/clothdesigner by default) -- the one place the existing
// bakerListOutputs / bakerReadOutputB64 exports and builder/http-download.lua
// can serve downloads from. Those exports only list flat [A-Za-z0-9_.-]+
// filenames (no subdirectories, no '^'), so the caret-named override file
// exists ONLY INSIDE the zip; the zip filename itself stays sanitizer-safe.
//
// Two pack modes (see PLAN.md):
//   createReplacePack  -- caret file `collection^texture.ytd` overrides an
//                         existing vanilla garment texture globally. Needs NO
//                         entitlement. Default offering.
//   createAddonPack    -- full addon collection (YMT + YDD + all texture
//                         variants) with the baked YTD swapped in. Needs the
//                         clothing (`subdir_file_mapping`) entitlement.
//
// Pure Node module (no FiveM globals) loaded via require(), so no IIFE needed.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const HostedYtdBaker = require('./hosted-ytd-baker.js');
const ZipWriter = require('./zip-writer.js');
const OutputDir = require('./output-dir.js');

const DEFAULT_OUTPUT_DIR = '/tmp/clothdesigner';
const DEFAULT_REPLACE_COLLECTION = 'mp_f_freemode_01_mp_f_2023_01';
const DEFAULT_REPLACE_TEXTURE = 'jbib_diff_000_a_uni';
const PACK_MANIFEST_VERSION = 2;

function safeSlug(value, fallback = 'design', max = 40) {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, max);
    return normalized || fallback;
}

function cleanFileSegment(value, label) {
    const text = String(value || '').trim();
    if (!text || text !== path.basename(text) || text.includes('..') ||
        !/^[A-Za-z0-9_.\-^]+$/.test(text)) {
        throw new Error(`Invalid ${label}: '${value}'`);
    }
    return text;
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function loadGeneratedSlot(registryPath, slotId) {
    const registry = readJson(registryPath);
    if (!registry) {
        throw new Error(`Could not read/parse registry at ${registryPath}.`);
    }
    const slots = Array.isArray(registry.slots) ? registry.slots : [];
    const slot = slots.find(item => item && item.id === slotId);
    if (!slot) {
        throw new Error(`Generated slot '${slotId}' was not found in ${registryPath}.`);
    }
    if (String(slot.assetMode || '').toLowerCase() !== 'generated') {
        throw new Error(`Slot '${slotId}' is assetMode '${slot.assetMode}'; pack export needs a prepared (assetMode=generated) slot.`);
    }
    return slot;
}

function fullCollectionForSlot(slot) {
    if (slot.fullCollection) return cleanFileSegment(slot.fullCollection, 'collection folder');
    const gender = slot.gender === 'male' ? 'male' : 'female';
    const ped = gender === 'male' ? 'mp_m_freemode_01' : 'mp_f_freemode_01';
    const prefix = gender === 'male' ? 'mp_m_' : 'mp_f_';
    return cleanFileSegment(`${ped}_${prefix}${slot.collection || ''}`, 'collection folder');
}

function pedFolderForSlot(slot) {
    return slot.gender === 'male' ? 'ped_male.rpf' : 'ped_female.rpf';
}

function validateCommonOptions(options) {
    const resourceRoot = path.resolve(String(options.resourceRoot || ''));
    if (!options.resourceRoot || !fs.existsSync(resourceRoot)) {
        throw new Error(`resourceRoot does not exist: '${options.resourceRoot}'`);
    }
    const registryPath = path.resolve(String(options.registryPath || path.join(resourceRoot, 'generated', 'registry.json')));

    const slotId = String(options.slotId || '').trim();
    if (!slotId) throw new Error('Pack export is missing a slotId.');
    const slot = loadGeneratedSlot(registryPath, slotId);

    const textureFiles = Array.isArray(slot.textureFiles) ? slot.textureFiles : [];
    if (!textureFiles.length) {
        throw new Error(`Slot '${slotId}' has no textureFiles.`);
    }

    const textureIndex = Math.floor(Number(options.textureIndex) || 0);
    if (textureIndex < 0 || textureIndex >= textureFiles.length) {
        throw new Error(`textureIndex ${options.textureIndex} is out of range for slot '${slotId}' (0..${textureFiles.length - 1}).`);
    }

    const width = Math.floor(Number(options.width) || 1024);
    const height = Math.floor(Number(options.height) || 1024);
    const rawRgba = Buffer.isBuffer(options.rawRgba) ? options.rawRgba : Buffer.from(options.rawRgba || []);
    const expected = width * height * 4;
    if (rawRgba.length !== expected) {
        throw new Error(`rawRgba was ${rawRgba.length} bytes; expected ${expected} for ${width}x${height} RGBA.`);
    }

    const exportName = String(options.exportName || slot.label || slot.displayName || slot.id || 'design');
    const packName = `cd_${safeSlug(exportName, 'design', 40)}`;

    // No fixed default: where a pack can be written depends on the host, and
    // it has to be the same folder the download endpoint serves from.
    const outputDir = path.resolve(String(options.outputDir || OutputDir.resolveOutputDir(resourceRoot)));

    return { resourceRoot, registryPath, slot, slotId, textureIndex, width, height, rawRgba, exportName, packName, outputDir };
}

// Bake the design into a temp YTD file in the (writable) output dir, read the
// bytes back, and always delete the temp file. hosted-ytd-baker's outputPath
// mode skips in-place write-permission checks, so this works on the read-only
// host.
function bakeToBuffer(ctx) {
    fs.mkdirSync(ctx.outputDir, { recursive: true });
    const tempBakePath = path.join(ctx.outputDir, `.tmp-bake-${process.pid}-${Date.now()}.ytd`);
    try {
        const bakeResult = HostedYtdBaker.bake({
            resourceRoot: ctx.resourceRoot,
            registryPath: ctx.registryPath,
            slotId: ctx.slotId,
            textureIndex: ctx.textureIndex,
            width: ctx.width,
            height: ctx.height,
            rawRgba: ctx.rawRgba,
            exportName: ctx.exportName,
            outputPath: tempBakePath,
            skipRegistry: true
        });
        const bakedBytes = fs.readFileSync(tempBakePath);
        return { bakedBytes, bakeResult };
    } finally {
        try { fs.rmSync(tempBakePath, { force: true }); } catch {}
    }
}

function writeZip(ctx, entries) {
    const zip = ZipWriter.createZip(entries);
    const zipName = `${ctx.packName}.zip`;
    if (!/^[A-Za-z0-9_.-]+$/.test(zipName)) {
        throw new Error(`Internal error: zip filename '${zipName}' is not download-sanitizer safe.`);
    }
    const zipPath = path.join(ctx.outputDir, zipName);
    fs.writeFileSync(zipPath, zip);
    return { zipPath, zipBytes: zip.length };
}

function buildFxManifest(descriptionLine, extraLines) {
    const lines = [
        "fx_version 'cerulean'",
        "game 'gta5'",
        '',
        "author 'cr-clothes'",
        `description '${descriptionLine}'`,
        "version '1.0.0'",
        '',
        '-- Generated in-game by cr-clothes. Streamed assets are auto-scanned',
        '-- from the stream/ folder; a stream-only resource needs nothing else.'
    ];
    if (Array.isArray(extraLines) && extraLines.length) {
        lines.push('', ...extraLines);
    }
    lines.push('');
    return Buffer.from(lines.join('\n'), 'utf8');
}

// Resolves a slot-recorded template path, refusing anything that would leave
// the resource folder.
function insideResource(resourceRoot, relative) {
    const root = path.resolve(resourceRoot);
    const resolved = path.resolve(root, String(relative));
    if (!resolved.startsWith(root + path.sep)) {
        throw new Error('Template file path escapes the resource folder.');
    }
    return resolved;
}

/**
 * Build a REPLACE-mode pack: a tiny resource whose stream/ folder holds a
 * caret-named YTD (`<collection>^<texture>.ytd`) that makes FiveM override
 * that collection's texture dictionary globally. No entitlement needed.
 */
function createReplacePack(options) {
    const ctx = validateCommonOptions(options);
    // An owner-prepared garment is replaced in its own collection; the vanilla
    // defaults only apply to the built-in test template.
    const prepared = ctx.slot && ctx.slot.templateFiles ? ctx.slot : null;
    const preparedTexture = prepared && Array.isArray(prepared.textureFiles) ? prepared.textureFiles[ctx.textureIndex] : null;
    const replaceCollection = cleanFileSegment(options.replaceCollection || (prepared ? fullCollectionForSlot(prepared) : DEFAULT_REPLACE_COLLECTION), 'replaceCollection');
    const replaceTexture = cleanFileSegment(options.replaceTexture || (preparedTexture ? path.basename(preparedTexture, '.ytd') : DEFAULT_REPLACE_TEXTURE), 'replaceTexture');
    if (replaceCollection.includes('^') || replaceTexture.includes('^')) {
        throw new Error("replaceCollection/replaceTexture must not themselves contain '^'.");
    }

    const { bakedBytes, bakeResult } = bakeToBuffer(ctx);
    const caretFile = `${replaceCollection}^${replaceTexture}.ytd`;

    const packManifest = {
        version: PACK_MANIFEST_VERSION,
        mode: 'replace',
        exportName: ctx.exportName,
        packName: ctx.packName,
        slotId: ctx.slotId,
        slotUsedAsTemplate: true,
        textureIndex: ctx.textureIndex,
        replaceCollection,
        replaceTexture,
        caretFile,
        width: ctx.width,
        height: ctx.height,
        format: 'A8R8G8B8',
        mipLevels: bakeResult.mipLevels,
        generatedAt: new Date().toISOString(),
        note: `Install: drop the '${ctx.packName}' folder into your server's resources/ folder, add 'ensure ${ctx.packName}' to server.cfg, and do a full server restart. The caret-named YTD in stream/ overrides texture '${replaceTexture}' of collection '${replaceCollection}' for everyone -- no entitlement needed.`
    };

    const entries = [
        {
            name: `${ctx.packName}/fxmanifest.lua`,
            data: buildFxManifest('Replace-mode clothing pack generated in-game by cr-clothes')
        },
        {
            name: `${ctx.packName}/stream/${caretFile}`,
            data: bakedBytes
        },
        {
            name: `${ctx.packName}/pack-manifest.json`,
            data: Buffer.from(JSON.stringify(packManifest, null, 2), 'utf8')
        }
    ];

    const { zipPath, zipBytes } = writeZip(ctx, entries);
    return {
        ok: true,
        mode: 'replace',
        packName: ctx.packName,
        zipPath,
        zipBytes,
        caretFile,
        entryCount: entries.length,
        message: `Replace pack '${ctx.packName}.zip' written (${zipBytes} bytes). Extract, drop '${ctx.packName}' into resources/, ensure ${ctx.packName}, full restart.`
    };
}

/**
 * Build an ADDON-mode pack: the full streamed collection (YMT + model YDD +
 * every texture variant, copied from this resource's stream/ folder) with the
 * baked YTD replacing the variant at textureIndex. Streaming an addon ped
 * collection requires the clothing entitlement on the server key.
 */
function createAddonPack(options) {
    const ctx = validateCommonOptions(options);
    const slot = ctx.slot;
    const pedFolder = pedFolderForSlot(slot);
    const fullCollection = fullCollectionForSlot(slot);
    const modelFile = cleanFileSegment(slot.modelFile, 'modelFile');
    const textureFiles = slot.textureFiles.map(name => cleanFileSegment(name, 'texture file'));

    const templateStreamRoot = path.join(ctx.resourceRoot, 'stream', pedFolder);
    const templateCollectionDir = path.join(templateStreamRoot, fullCollection);
    // Owner-prepared garments record each file's location on the slot;
    // built-in templates live in stream/.
    const mappedFiles = slot.templateFiles && typeof slot.templateFiles === 'object' ? slot.templateFiles : null;
    const templateFile = file => {
        const mapped = mappedFiles && typeof mappedFiles[file] === 'string' ? mappedFiles[file] : null;
        return mapped ? insideResource(ctx.resourceRoot, mapped) : path.join(templateCollectionDir, file);
    };
    const templateYmt = mappedFiles
        ? (slot.templateYmt ? insideResource(ctx.resourceRoot, slot.templateYmt) : null)
        : path.join(templateStreamRoot, `${fullCollection}.ymt`);
    if (!templateYmt) {
        const error = new Error('This clothing pack does not include its collection .ymt, so the garment cannot be exported as a new addon item yet.');
        error.code = 'NO_TEMPLATE_YMT';
        throw error;
    }
    const templateModel = templateFile(modelFile);

    for (const required of [templateYmt, templateModel]) {
        if (!fs.existsSync(required)) {
            throw new Error(`Addon template file is missing: ${required}`);
        }
    }
    for (const textureFile of textureFiles) {
        const abs = templateFile(textureFile);
        if (!fs.existsSync(abs)) {
            throw new Error(`Addon template texture is missing: ${abs}`);
        }
    }

    const { bakedBytes, bakeResult } = bakeToBuffer(ctx);

    // Stream layout. 'flat' (default) is the convention modern community
    // packs and tooling ship: every file directly in stream/, the collection
    // encoded in the FILENAME -- `<collection>.ymt` plus caret-named assets
    // `<collection>^<file>`. The caret mapping is engine-proven on this
    // project (the replace-pack magenta test streamed through it). 'rpf'
    // keeps the older stream/<ped>.rpf/<collection>/ subdir-mapping form.
    const layout = options.layout === 'rpf' ? 'rpf' : 'flat';

    const packManifest = {
        version: PACK_MANIFEST_VERSION,
        mode: 'addon',
        layout,
        exportName: ctx.exportName,
        packName: ctx.packName,
        slotId: ctx.slotId,
        textureIndex: ctx.textureIndex,
        pedFolder,
        fullCollection,
        modelFile,
        textureFiles,
        bakedTextureFile: textureFiles[ctx.textureIndex],
        width: ctx.width,
        height: ctx.height,
        format: 'A8R8G8B8',
        mipLevels: bakeResult.mipLevels,
        generatedAt: new Date().toISOString(),
        note: `Install: drop the '${ctx.packName}' folder into your server's resources/ folder, add 'ensure ${ctx.packName}' to server.cfg, and do a full server restart. Streaming an addon ped collection requires the Cfx.re "Stream Custom Clothing" entitlement on the server key.`
    };

    const assetName = layout === 'flat'
        ? file => `${ctx.packName}/stream/${fullCollection}^${file}`
        : file => `${ctx.packName}/stream/${pedFolder}/${fullCollection}/${file}`;
    const ymtName = layout === 'flat'
        ? `${ctx.packName}/stream/${fullCollection}.ymt`
        : `${ctx.packName}/stream/${pedFolder}/${fullCollection}.ymt`;

    // The SHOP_PED_APPAREL_META_FILE registers the collection with the game.
    // Without it NOTHING registers -- the ymt alone only describes contents.
    // (Empirically proven 2026-08-15: this one declaration was the difference
    // between silent nothing and the item appearing in-game.)
    const pedName = slot.gender === 'male' ? 'mp_m_freemode_01' : 'mp_f_freemode_01';
    const dlcName = fullCollection.replace(`${pedName}_`, '');
    const metaFileName = `${fullCollection}.meta`;
    const shopMeta = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ShopPedApparel>',
        `  <pedName>${pedName}</pedName>`,
        `  <dlcName>${dlcName}</dlcName>`,
        `  <fullDlcName>${fullCollection}</fullDlcName>`,
        `  <eCharacter>${slot.gender === 'male' ? 'SCR_CHAR_MULTIPLAYER' : 'SCR_CHAR_MULTIPLAYER_F'}</eCharacter>`,
        `  <creatureMetaData>MP_CreatureMetadata_${dlcName.replace(/^mp_[mf]_/, '')}</creatureMetaData>`,
        '  <pedOutfits />',
        '  <pedComponents />',
        '  <pedProps />',
        '</ShopPedApparel>',
        ''
    ].join('\n');

    const manifestText = [
        "fx_version 'cerulean'",
        "game 'gta5'",
        '',
        "author 'cr-clothes'",
        `description 'Addon clothing pack generated in-game by cr-clothes'`,
        "version '1.0.0'",
        '',
        'files {',
        `    '${metaFileName}'`,
        '}',
        '',
        '-- Registers the addon collection with the game. Without this line the',
        '-- pack streams but never appears -- do not remove it.',
        `data_file 'SHOP_PED_APPAREL_META_FILE' '${metaFileName}'`,
        ''
    ].join('\n');

    const entries = [
        {
            name: `${ctx.packName}/fxmanifest.lua`,
            data: Buffer.from(manifestText, 'utf8')
        },
        {
            name: `${ctx.packName}/${metaFileName}`,
            data: Buffer.from(shopMeta, 'utf8')
        },
        {
            name: `${ctx.packName}/pack-manifest.json`,
            data: Buffer.from(JSON.stringify(packManifest, null, 2), 'utf8')
        },
        {
            name: ymtName,
            data: fs.readFileSync(templateYmt)
        },
        {
            name: assetName(modelFile),
            data: fs.readFileSync(templateModel)
        }
    ];

    textureFiles.forEach((textureFile, index) => {
        const data = index === ctx.textureIndex
            ? bakedBytes
            : fs.readFileSync(templateFile(textureFile));
        entries.push({
            name: assetName(textureFile),
            data
        });
    });

    const { zipPath, zipBytes } = writeZip(ctx, entries);
    return {
        ok: true,
        mode: 'addon',
        packName: ctx.packName,
        zipPath,
        zipBytes,
        caretFile: null,
        entryCount: entries.length,
        message: `Addon pack '${ctx.packName}.zip' written (${zipBytes} bytes, ${entries.length} entries). Extract, drop '${ctx.packName}' into resources/, ensure ${ctx.packName}, full restart. Requires the clothing entitlement.`
    };
}

// The v1 fs-write-based create() cannot work on the read-only production host
// and was removed. A shim keeps not-yet-migrated callers (builder/server.js)
// failing with a clear message instead of a TypeError.
function create() {
    throw new Error("resource-pack-exporter v2: create() was replaced by createReplacePack()/createAddonPack(), which assemble a zip in the writable output dir instead of writing into the read-only resource tree.");
}

module.exports = {
    create,
    createReplacePack,
    createAddonPack,
    safeSlug,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_REPLACE_COLLECTION,
    DEFAULT_REPLACE_TEXTURE
};
