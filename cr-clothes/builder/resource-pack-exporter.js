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
// filenames (no subdirectories, no '^'), so the caret-named stream files
// exist ONLY INSIDE the zip; the zip filename itself stays sanitizer-safe.
//
// Two pack modes:
//   createReplacePack  -- caret file `collection^texture.ytd` overrides the
//                         texture of a garment the server already streams.
//   createAddonPack    -- a new clothing item in a collection of its own: a
//                         generated YMT, the garment's model as drawable 000
//                         and the baked design as texture a, all named for a
//                         collection that exists only in this pack.
//
// Both modes put caret-named files in stream/, and FiveM only maps the caret
// to a collection folder under its clothing-streaming policy
// (`subdir_file_mapping`, the "Stream Custom Clothing" entitlement on the
// server key). A replace pack needs it exactly as an addon pack does.
//
// Pure Node module (no FiveM globals) loaded via require(), so no IIFE needed.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HostedYtdBaker = require('./hosted-ytd-baker.js');
const ZipWriter = require('./zip-writer.js');
const OutputDir = require('./output-dir.js');
const YmtWriter = require('./ymt-writer.js');

const DEFAULT_OUTPUT_DIR = '/tmp/clothdesigner';
const DEFAULT_REPLACE_COLLECTION = 'mp_f_freemode_01_mp_f_2023_01';
const DEFAULT_REPLACE_TEXTURE = 'jbib_diff_000_a_uni';
// The two manifests are versioned apart: a replace pack is what it always
// was, an addon pack's manifest now describes the new item and its source.
const REPLACE_MANIFEST_VERSION = 2;
const ADDON_MANIFEST_VERSION = 3;

// Every addon export gets its own id, and with it its own collection and its
// own resource folder name. 12 hex digits = 48 random bits. Hex only, so an id
// can never spell 'mp_f', 'male' or anything else a name is parsed for.
const EXPORT_ID_RE = /^[0-9a-f]{12}$/;
const TEXTURE_POLICIES = ['design', 'all'];
const DEFAULT_YMT_LAYOUT = 'codewalker';

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

// `shownPath` is how the registry is named in a message. These messages are
// shown to the player who exported, and where the resource lies on the
// server's disk is not theirs to know.
function loadGeneratedSlot(registryPath, slotId, shownPath) {
    const registry = readJson(registryPath);
    if (!registry) {
        throw new Error(`Could not read/parse registry at ${shownPath}.`);
    }
    const slots = Array.isArray(registry.slots) ? registry.slots : [];
    const slot = slots.find(item => item && item.id === slotId);
    if (!slot) {
        throw new Error(`Generated slot '${slotId}' was not found in ${shownPath}.`);
    }
    if (String(slot.assetMode || '').toLowerCase() !== 'generated') {
        throw new Error(`Slot '${slotId}' is assetMode '${slot.assetMode}'; pack export needs a prepared (assetMode=generated) slot.`);
    }
    return slot;
}

// The folder a garment's own files are grouped under. It finds the source
// files and names a replace pack's target; an addon pack is never named
// after it.
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

function newExportId() {
    return crypto.randomBytes(6).toString('hex');
}

// The names of the collection an addon export creates. Nothing here comes
// from the garment the design was made on, so two exports with different ids
// never share a collection or a file name. A drawn id is new every time; an
// id passed in by the caller is checked against the garment's own collection
// in createAddonPack.
//
//   dlcName         mp_f_cd_<id>                     what the game calls the collection
//   fullCollection  mp_f_freemode_01_mp_f_cd_<id>    .ymt / .meta name, folder of component files
//   propCollection  mp_f_freemode_01_p_mp_f_cd_<id>  folder of prop files
function exportCollectionNames(gender, exportId) {
    if (!EXPORT_ID_RE.test(String(exportId))) {
        throw new Error(`Invalid exportId '${exportId}': expected 12 lowercase hex digits.`);
    }
    const letter = gender === 'male' ? 'm' : 'f';
    const pedName = `mp_${letter}_freemode_01`;
    const dlcName = `mp_${letter}_cd_${exportId}`;
    return {
        pedName,
        dlcName,
        fullCollection: `${pedName}_${dlcName}`,
        propCollection: `${pedName}_p_${dlcName}`
    };
}

// cd_<slug>_<id>. The slug is cut to 40 characters so the name stays within
// 56: webhook delivery appends 21 more to the zip name, the bot accepts file
// names of at most 80, and deliveryName() cuts at 60, which must never reach
// into the id.
function addonPackName(exportName, exportId) {
    return `cd_${safeSlug(exportName, 'design', 40).replace(/_+$/, '')}_${exportId}`;
}

// A garment the addon form cannot carry as a new item. Its texture can still
// be replaced, so a caller that wants to fall back to a replace pack tells
// this refusal from a failure by its code. `reason` is 'props-off' when props
// are simply not switched on, 'item' when the garment's file names describe
// something a generated .ymt cannot say.
function addonUnsupported(message, reason) {
    const error = new Error(message);
    error.code = 'ADDON_UNSUPPORTED';
    error.reason = reason;
    return error;
}

// '<prefix>_<NNN>_<u|r>.ydd' for components, 'p_<anchor>_<NNN>.ydd' for props.
function parseModelName(fileName) {
    const match = /^(p_[a-z]+|[a-z]+)_(\d{3})(?:_([a-z]))?\.ydd$/i.exec(String(fileName).split('^').pop());
    if (!match) throw addonUnsupported(`Cannot read the garment slot from model file name '${fileName}'.`, 'item');
    return { prefix: match[1].toLowerCase(), meshSuffix: (match[3] || '').toLowerCase() };
}

// '<prefix>_diff_<NNN>_<letter>_<race>.ytd' for components,
// 'p_<anchor>_diff_<NNN>_<letter>.ytd' for props. The tail is read whatever
// its length (crclothes_prepare registers any), so that an unknown one is
// refused by name as a race suffix and not as an unreadable file name.
function parseTextureName(fileName) {
    const match = /^(p_[a-z]+|[a-z]+)_diff_(\d{3})_([a-z])(?:_([a-z]+))?\.ytd$/i.exec(String(fileName).split('^').pop());
    if (!match) throw addonUnsupported(`Cannot read the texture slot from texture file name '${fileName}'.`, 'item');
    return { prefix: match[1].toLowerCase(), race: (match[4] || '').toLowerCase() };
}

// What the exported item is, worked out from the model's file name: the
// registry's prefix / componentId / anchorId fields were written by whatever
// prepared the slot (older registries carry a wrong wrist table), the file
// name is what the game itself goes by. The prefix tables are the .ymt
// writer's, so the item and its .ymt cannot disagree about a slot number.
function describeExportItem(model) {
    if (model.prefix.startsWith('p_')) {
        const anchor = Object.entries(YmtWriter.PROP_ANCHORS).find(([, info]) => info.prefix === model.prefix);
        if (!anchor) throw addonUnsupported(`'${model.prefix}' is not a prop slot this exporter knows.`, 'item');
        return { kind: 'prop', prefix: model.prefix, anchorId: Number(anchor[0]) };
    }
    const componentId = YmtWriter.COMPONENT_PREFIXES.indexOf(model.prefix);
    if (componentId < 0) throw addonUnsupported(`'${model.prefix}' is not a clothing slot this exporter knows.`, 'item');
    // Only _r says something about the mesh (it shows skin); every other
    // spelling, including none, is the plain _u form.
    return { kind: 'component', prefix: model.prefix, componentId, meshSuffix: model.meshSuffix === 'r' ? 'r' : 'u' };
}

// The race suffix a component texture ships under. It is the source file's
// own; a name without one gets the suffix its mesh pairs with in the game's
// files (_r meshes ship with _whi textures, _u meshes with _uni).
function componentTextureRace(sourceName, sourceRace, meshSuffix) {
    const race = sourceRace || (meshSuffix === 'r' ? 'whi' : 'uni');
    if (!Object.prototype.hasOwnProperty.call(YmtWriter.RACE_TEX_ID, race)) {
        throw addonUnsupported(`Texture '${sourceName}' has the race suffix '${race}', which cannot be exported (known: ${Object.keys(YmtWriter.RACE_TEX_ID).join(', ')}).`, 'item');
    }
    return race;
}

function validateCommonOptions(options) {
    const resourceRoot = path.resolve(String(options.resourceRoot || ''));
    if (!options.resourceRoot || !fs.existsSync(resourceRoot)) {
        throw new Error(`resourceRoot does not exist: '${options.resourceRoot}'`);
    }
    const registryPath = path.resolve(String(options.registryPath || path.join(resourceRoot, 'generated', 'registry.json')));

    const slotId = String(options.slotId || '').trim();
    if (!slotId) throw new Error('Pack export is missing a slotId.');
    const slot = loadGeneratedSlot(registryPath, slotId, path.relative(resourceRoot, registryPath).split(path.sep).join('/'));

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
 * that collection's texture dictionary globally. It needs the same
 * clothing-streaming entitlement as an addon pack.
 */
function createReplacePack(options) {
    const ctx = validateCommonOptions(options);
    // An owner-prepared garment is replaced in its own collection; the vanilla
    // defaults only apply to the built-in test template.
    const prepared = ctx.slot && ctx.slot.templateFiles ? ctx.slot : null;
    const preparedTexture = prepared && Array.isArray(prepared.textureFiles) ? prepared.textureFiles[ctx.textureIndex] : null;
    const replaceCollection = cleanFileSegment(options.replaceCollection || (prepared ? fullCollectionForSlot(prepared) : DEFAULT_REPLACE_COLLECTION), 'replaceCollection');
    // The extension is taken off whatever its case: crclothes_prepare registers
    // '.YTD' files too, and a name that kept it would become '<name>.YTD.ytd',
    // which replaces nothing.
    const replaceTexture = cleanFileSegment(options.replaceTexture || (preparedTexture ? path.basename(preparedTexture).replace(/\.ytd$/i, '') : DEFAULT_REPLACE_TEXTURE), 'replaceTexture');
    if (replaceCollection.includes('^') || replaceTexture.includes('^')) {
        throw new Error("replaceCollection/replaceTexture must not themselves contain '^'.");
    }

    const { bakedBytes, bakeResult } = bakeToBuffer(ctx);
    const caretFile = `${replaceCollection}^${replaceTexture}.ytd`;

    const packManifest = {
        version: REPLACE_MANIFEST_VERSION,
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
        note: `Install: drop the '${ctx.packName}' folder into your server's resources/ folder, add 'ensure ${ctx.packName}' to server.cfg, and do a full server restart. The caret-named YTD in stream/ overrides texture '${replaceTexture}' of collection '${replaceCollection}' for everyone. Like any clothing pack it requires the Cfx.re "Stream Custom Clothing" entitlement on the server key.`
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
 * Build an ADDON-mode pack: one new clothing item in a collection that exists
 * only in this pack. The collection's .ymt is generated, the garment's model
 * is shipped as drawable 000 and the baked design as texture a. Nothing in the
 * pack is named after the collection the garment came from, so it installs
 * next to that pack, and next to any other export, without colliding. The
 * source pack's own .ymt is never read: whether it shipped one makes no
 * difference. Streaming an addon ped collection requires the clothing
 * entitlement on the server key.
 *
 *   options.textures   'design' (default): ship only the baked design.
 *                      'all': ship every texture of the source garment, in
 *                      order, with the design in place of the one at
 *                      textureIndex.
 *   options.props      true: export props (hats, glasses, ...) as new items
 *                      too. Anything else refuses a prop.
 *   options.ymtLayout  'codewalker' (default) or 'ragelib': how the generated
 *                      .ymt is arranged (see builder/ymt-writer.js).
 *   options.exportId   12 hex digits; drawn at random when absent.
 *
 * A garment that cannot become a new item (a prop while props are off, a file
 * name the generated .ymt has no value for) is refused with error code
 * ADDON_UNSUPPORTED before anything is baked or written, so the caller can
 * fall back to a replace pack.
 */
function createAddonPack(options) {
    const ctx = validateCommonOptions(options);
    const slot = ctx.slot;
    const gender = slot.gender === 'male' ? 'male' : 'female';
    const sourceModelName = cleanFileSegment(slot.modelFile, 'modelFile');
    const model = parseModelName(sourceModelName);
    // The switch is asked first and of the file name alone: with props off a
    // prop is refused as a prop whatever its anchor, also one the tables do
    // not know (registries written by 1.0.0 can hold p_lhand / p_rhand slots).
    if (model.prefix.startsWith('p_') && options.props !== true) {
        throw addonUnsupported('Props are not exported as new addon items unless that is switched on.', 'props-off');
    }
    const item = describeExportItem(model);

    const texturePolicy = options.textures ?? 'design';
    if (!TEXTURE_POLICIES.includes(texturePolicy)) {
        throw new Error(`Invalid textures option '${options.textures}': expected 'design' or 'all'.`);
    }
    // Not checked here: the writer knows its layouts and refuses any other.
    const ymtLayout = options.ymtLayout ?? DEFAULT_YMT_LAYOUT;

    // Callers may pass an id (tests, or a caller that wants to know the names
    // before the pack exists); otherwise each export draws a fresh one. A
    // malformed id is refused here, before anything is baked or written.
    const exportId = String(options.exportId ?? newExportId());
    const names = exportCollectionNames(gender, exportId);
    // A drawn id is new. A passed one may be the id of the very pack this
    // garment was prepared from (an export dropped back into garments/); the
    // new pack would then carry that pack's own file names and the two would
    // override each other.
    const ownFolder = String(slot.fullCollection || '').toLowerCase();
    if (ownFolder === names.fullCollection || ownFolder === names.propCollection) {
        throw new Error(`exportId '${exportId}' is the id of the pack this garment came from; an export needs a collection of its own.`);
    }
    // The resource folder is named for the export too: two designs of one
    // garment would otherwise unzip into the same folder.
    ctx.packName = addonPackName(ctx.exportName, exportId);

    // Where the garment's own files are. Owner-prepared garments record each
    // file's location on the slot; built-in templates live in stream/. Only
    // the built-in kind is looked up by its collection's name, so only there
    // does that name have to be a safe path segment: an owner's folder may be
    // called anything crclothes_prepare registered, and here it merely goes
    // into the manifest as the place the garment came from.
    const mappedFiles = slot.templateFiles && typeof slot.templateFiles === 'object' ? slot.templateFiles : null;
    const sourceCollection = mappedFiles && slot.fullCollection ? String(slot.fullCollection) : fullCollectionForSlot(slot);
    const sourceFile = file => {
        const mapped = mappedFiles && typeof mappedFiles[file] === 'string' ? mappedFiles[file] : null;
        return mapped
            ? insideResource(ctx.resourceRoot, mapped)
            : path.join(ctx.resourceRoot, 'stream', pedFolderForSlot(slot), fullCollectionForSlot(slot), file);
    };
    const sourceTextureNames = slot.textureFiles.map(name => cleanFileSegment(name, 'texture file'));

    // What the pack calls them. The files are only renamed (drawable 000,
    // letters from a), never rewritten. Clothing tools move garments between
    // drawable numbers the same way, so the names stored inside a .ydd / .ytd
    // commonly differ from the file name already.
    const shippedIndexes = texturePolicy === 'all'
        ? sourceTextureNames.map((name, index) => index)
        : [ctx.textureIndex];
    if (shippedIndexes.length > YmtWriter.MAX_TEXTURES) {
        throw new Error(`A clothing item can carry at most ${YmtWriter.MAX_TEXTURES} textures; this garment has ${shippedIndexes.length}.`);
    }
    const textures = shippedIndexes.map((sourceIndex, position) => {
        const sourceName = sourceTextureNames[sourceIndex];
        const parsed = parseTextureName(sourceName);
        if (parsed.prefix !== item.prefix) {
            throw addonUnsupported(`Slot '${slot.id}' mixes '${item.prefix}' and '${parsed.prefix}' files.`, 'item');
        }
        const letter = String.fromCharCode(97 + position);
        // Prop textures carry no race suffix; a stray one on the source is dropped.
        const race = item.kind === 'prop' ? null : componentTextureRace(sourceName, parsed.race, item.meshSuffix);
        return {
            sourceName,
            baked: sourceIndex === ctx.textureIndex,
            race,
            fileName: race ? `${item.prefix}_diff_000_${letter}_${race}.ytd` : `${item.prefix}_diff_000_${letter}.ytd`
        };
    });
    const modelFileName = item.kind === 'prop'
        ? `${item.prefix}_000.ydd`
        : `${item.prefix}_000_${item.meshSuffix}.ydd`;
    const bakedTextureFile = textures.find(texture => texture.baked).fileName;

    // Named relative to the resource, like the registry: see loadGeneratedSlot.
    const shown = absolute => path.relative(ctx.resourceRoot, absolute).split(path.sep).join('/');
    const sourceModel = sourceFile(sourceModelName);
    if (!fs.existsSync(sourceModel)) {
        throw new Error(`Garment model is missing: ${shown(sourceModel)}`);
    }
    for (const texture of textures) {
        const abs = sourceFile(texture.sourceName);
        if (!fs.existsSync(abs)) {
            throw new Error(`Garment texture is missing: ${shown(abs)}`);
        }
    }

    // The .ymt is built from the same values the file names above were, and
    // before anything is baked, so an item the writer refuses leaves nothing
    // behind. Everything the writer is not told here stays at its defaults.
    const ymtBytes = YmtWriter.buildYmt(item.kind === 'prop'
        ? { gender, dlcName: names.dlcName, kind: 'prop', anchorId: item.anchorId, textures: textures.map(() => ({})) }
        : {
            gender,
            dlcName: names.dlcName,
            kind: 'component',
            componentId: item.componentId,
            meshSuffix: item.meshSuffix,
            textures: textures.map(texture => ({ race: texture.race }))
        }, { layout: ymtLayout });

    const { bakedBytes, bakeResult } = bakeToBuffer(ctx);

    // A prop's files go under '<ped>_p_<dlc>' while the collection's .ymt and
    // .meta are '<ped>_<dlc>'. Using one name for both is a known way to end
    // up with a prop that never shows.
    const assetCollection = item.kind === 'prop' ? names.propCollection : names.fullCollection;
    const packManifest = {
        version: ADDON_MANIFEST_VERSION,
        mode: 'addon',
        layout: 'flat',
        ymtLayout,
        exportName: ctx.exportName,
        packName: ctx.packName,
        exportId,
        // The item this pack adds.
        pedName: names.pedName,
        dlcName: names.dlcName,
        fullCollection: names.fullCollection,
        propCollection: item.kind === 'prop' ? names.propCollection : null,
        kind: item.kind,
        componentId: item.kind === 'component' ? item.componentId : null,
        anchorId: item.kind === 'prop' ? item.anchorId : null,
        drawableId: 0,
        modelFile: modelFileName,
        textureFiles: textures.map(texture => texture.fileName),
        bakedTextureFile,
        // The garment the design was made on.
        slotId: ctx.slotId,
        textureIndex: ctx.textureIndex,
        source: {
            fullCollection: sourceCollection,
            drawableId: Number(slot.drawableId) || 0,
            modelFile: sourceModelName,
            textureFile: sourceTextureNames[ctx.textureIndex]
        },
        width: ctx.width,
        height: ctx.height,
        format: 'A8R8G8B8',
        mipLevels: bakeResult.mipLevels,
        generatedAt: new Date().toISOString(),
        note: `Install: drop the '${ctx.packName}' folder into your server's resources/ folder, add 'ensure ${ctx.packName}' to server.cfg, and do a full server restart. The pack adds the clothing collection '${names.dlcName}'. Streaming an addon ped collection requires the Cfx.re "Stream Custom Clothing" entitlement on the server key, and each installed pack uses one of the few clothing collection slots a server has.`
    };

    // The stream layout is flat: every file directly in stream/, the
    // collection encoded in the FILE NAME -- `<collection>.ymt` plus
    // caret-named assets `<collection>^<file>`. FiveM registers a stream file
    // by its base name only, so a folder cannot carry the collection.
    const assetName = file => `${ctx.packName}/stream/${assetCollection}^${file}`;

    // The SHOP_PED_APPAREL_META_FILE registers the collection with the game.
    // Without it NOTHING registers -- the ymt alone only describes contents.
    // (Empirically proven 2026-08-15: this one declaration was the difference
    // between silent nothing and the item appearing in-game.)
    // <dlcName> must be the string the .ymt carries, and <fullDlcName> the
    // .ymt's file name: all three come from `names`.
    const metaFileName = `${names.fullCollection}.meta`;
    const shopMeta = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ShopPedApparel>',
        `  <pedName>${names.pedName}</pedName>`,
        `  <dlcName>${names.dlcName}</dlcName>`,
        `  <fullDlcName>${names.fullCollection}</fullDlcName>`,
        `  <eCharacter>${gender === 'male' ? 'SCR_CHAR_MULTIPLAYER' : 'SCR_CHAR_MULTIPLAYER_F'}</eCharacter>`,
        `  <creatureMetaData>MP_CreatureMetadata_${names.dlcName.replace(/^mp_[mf]_/, '')}</creatureMetaData>`,
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
            name: `${ctx.packName}/stream/${names.fullCollection}.ymt`,
            data: ymtBytes
        },
        {
            name: assetName(modelFileName),
            data: fs.readFileSync(sourceModel)
        }
    ];

    for (const texture of textures) {
        entries.push({
            name: assetName(texture.fileName),
            data: texture.baked ? bakedBytes : fs.readFileSync(sourceFile(texture.sourceName))
        });
    }

    const { zipPath, zipBytes } = writeZip(ctx, entries);
    return {
        ok: true,
        mode: 'addon',
        packName: ctx.packName,
        exportId,
        dlcName: names.dlcName,
        collection: names.fullCollection,
        kind: item.kind,
        zipPath,
        zipBytes,
        caretFile: null,
        entryCount: entries.length,
        message: `Addon pack '${ctx.packName}.zip' written (${zipBytes} bytes, ${entries.length} entries): new clothing collection '${names.dlcName}'. Extract, drop '${ctx.packName}' into resources/, ensure ${ctx.packName}, full restart. Requires the clothing entitlement.`
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
    exportCollectionNames,
    newExportId,
    safeSlug,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_REPLACE_COLLECTION,
    DEFAULT_REPLACE_TEXTURE
};
