// builder/garment-prepare.js
// Turns clothing an owner already has into bakeable garments.
//
// Owners drop clothing packs into cr-clothes/garments/ and run
// `crclothes_prepare`. This walks what they dropped, reads the caret-named
// stream files that every addon clothing pack uses, and produces the registry
// entries and pack descriptors the baker needs.
//
// The key realisation: a clothing pack's filenames already carry everything.
//
//   mp_f_freemode_01_mp_f_popcornclothing1^lowr_048_u.ydd
//   `------------- collection -----------'  `--'  `-' `'
//                                          prefix  id  mesh
//   mp_f_freemode_01_mp_f_popcornclothing1^lowr_diff_048_a_uni.ytd
//                                                        `- variant
//
// So gender, collection, component slot, drawable id and the variant list are
// all derivable without CodeWalker, without parsing RSC7, and without the
// owner telling us anything. Preview meshes still need CodeWalker, but they
// are optional -- a garment without one falls back to a flat texture preview.
//
// Pure Node: no FiveM globals, no filesystem writes of its own. The caller
// supplies readDir/readFile/writeFile so this runs identically in the game
// server, on a VPS, and in an offline test.

'use strict';

const path = require('node:path');
const YmtWriter = require('./ymt-writer.js');

// What the designer files each slot under, keyed by the prefix GTA uses in
// clothing filenames.
const CATEGORY_BY_PREFIX = {
    head: 'head',
    berd: 'masks',
    hair: 'hair',
    uppr: 'arms',
    lowr: 'pants',
    hand: 'bags',
    feet: 'shoes',
    teef: 'teeth',
    accs: 'accessories',
    task: 'armor',
    decl: 'decals',
    jbib: 'tops',
    p_head: 'hats',
    p_eyes: 'glasses',
    p_ears: 'ears',
    p_lwrist: 'watches',
    p_rwrist: 'bracelets'
};

// Component slots and prop anchors by prefix. The prefixes and their numbers
// are the .ymt writer's tables, so a garment is recognised here by the same
// names an export of it is written with (watches and bracelets are p_lwrist
// and p_rwrist, anchors 6 and 7). For a prop, componentId is the anchor id.
const COMPONENT_BY_PREFIX = {};
YmtWriter.COMPONENT_PREFIXES.forEach((prefix, componentId) => {
    COMPONENT_BY_PREFIX[prefix] = { componentId, category: CATEGORY_BY_PREFIX[prefix], kind: 'component' };
});
for (const [anchorId, anchor] of Object.entries(YmtWriter.PROP_ANCHORS)) {
    COMPONENT_BY_PREFIX[anchor.prefix] = { componentId: Number(anchorId), category: CATEGORY_BY_PREFIX[anchor.prefix], kind: 'prop' };
}

// Prefixes are matched longest-first so p_head wins over head.
const PREFIXES = Object.keys(COMPONENT_BY_PREFIX).sort((a, b) => b.length - a.length);

// Clothing packs ship in one of two layouts, and both are common:
//
//   flat/caret:  <collection>^<prefix>_<id>_<suffix>.ydd
//   nested:      <collection>/<prefix>_<id>_<suffix>.ydd
//
// The caret and the directory separator play the same role, so normalising the
// caret to a slash lets one pair of patterns read both.
const MESH_RE = /^(?<collection>.+)\/(?<prefix>[a-z_]+)_(?<drawable>\d{3})(?:_(?<suffix>[a-z]))?\.ydd$/i;
const TEX_RE = /^(?<collection>.+)\/(?<prefix>[a-z_]+)_diff_(?<drawable>\d{3})_(?<variant>[a-z])(?:_(?<kind>[a-z]+))?\.ytd$/i;

function genderFromCollection(collection) {
    const lower = String(collection).toLowerCase();
    if (/(^|_)mp_f|female/.test(lower)) return 'female';
    if (/(^|_)mp_m|male/.test(lower)) return 'male';
    return null;
}

function matchPrefix(rawPrefix) {
    const lower = String(rawPrefix).toLowerCase();
    for (const prefix of PREFIXES) {
        if (lower === prefix) return prefix;
    }
    return null;
}

// `filePath` may be a bare filename, a caret name, or a path relative to the
// drop folder. Everything is reduced to "<collection>/<file>" first.
function normaliseStreamPath(filePath) {
    const unixish = String(filePath).split('\\').join('/');
    const caretNormalised = unixish.split('^').join('/');
    const parts = caretNormalised.split('/').filter(Boolean);
    if (parts.length < 2) return null;              // no collection to attribute it to
    // Keep only the final directory: packs are often nested a few levels deep
    // (MyPack/stream/<collection>/file.ydd) and only the last part names the
    // collection.
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function parseStreamFile(filePath) {
    const fileName = normaliseStreamPath(filePath);
    if (!fileName) return null;
    const mesh = MESH_RE.exec(fileName);
    if (mesh) {
        const prefix = matchPrefix(mesh.groups.prefix);
        if (!prefix) return null;
        return {
            type: 'mesh',
            fileName: path.basename(fileName),
            sourcePath: filePath,
            collection: mesh.groups.collection,
            prefix,
            drawable: Number(mesh.groups.drawable),
            suffix: (mesh.groups.suffix || 'u').toLowerCase()
        };
    }
    const tex = TEX_RE.exec(fileName);
    if (tex) {
        const prefix = matchPrefix(tex.groups.prefix);
        if (!prefix) return null;
        return {
            type: 'texture',
            fileName: path.basename(fileName),
            sourcePath: filePath,
            collection: tex.groups.collection,
            prefix,
            drawable: Number(tex.groups.drawable),
            variant: tex.groups.variant.toLowerCase(),
            kind: (tex.groups.kind || '').toLowerCase()
        };
    }
    return null;
}

// Group parsed stream files into one garment per (collection, prefix, drawable).
function groupGarments(parsedFiles) {
    const garments = new Map();
    for (const entry of parsedFiles) {
        const key = `${entry.collection}|${entry.prefix}|${entry.drawable}`;
        if (!garments.has(key)) {
            garments.set(key, {
                collection: entry.collection,
                prefix: entry.prefix,
                drawable: entry.drawable,
                mesh: null,
                textures: []
            });
        }
        const garment = garments.get(key);
        if (entry.type === 'mesh') {
            // One drawable has one mesh. Should a pack carry both spellings,
            // prefer _u; _r is the form of a mesh that shows skin.
            if (!garment.mesh || entry.suffix === 'u') garment.mesh = entry;
        } else {
            garment.textures.push(entry);
        }
    }
    for (const garment of garments.values()) {
        garment.textures.sort((a, b) => a.variant.localeCompare(b.variant));
    }
    return [...garments.values()];
}

// A pack's component files are grouped under the collection's own name,
// '<ped>_<dlc>' (mp_f_freemode_01_mp_f_mypack). Its prop files are grouped
// under '<ped>_p_<dlc>' (mp_f_freemode_01_p_mp_f_mypack) and still belong to
// that same collection: there is one .ymt, '<ped>_<dlc>.ymt', for both. Only
// a prop folder carries the extra 'p_', so it is only taken off for a prop; a
// component collection may be called 'p_...' in its own right.
function collectionOfFolder(folder, kind) {
    return kind === 'prop'
        ? String(folder).replace(/^(mp_[fm]_freemode_01_)p_/i, '$1')
        : String(folder);
}

// In game the collection is known by its dlc name. The client matches on this
// short name, so it has to be recorded separately from the folder name.
function shortCollectionName(folder, kind) {
    return collectionOfFolder(folder, kind)
        .replace(/^mp_[fm]_freemode_01_/i, '')
        .replace(/^mp_[fm]_/i, '');
}

function slotIdFor(garment, gender) {
    const collection = String(garment.collection).replace(/[^A-Za-z0-9_]+/g, '_');
    return `${gender}:${collection}:${garment.prefix}:${String(garment.drawable).padStart(3, '0')}`;
}

// A readable default name. Owners rename these later; the point is that nothing
// is labelled by a bare drawable id, which is what produced earlier mislabels.
function displayNameFor(garment, gender, component) {
    const collection = collectionOfFolder(garment.collection, component.kind)
        .replace(/^mp_[fm]_freemode_01_mp_[fm]_/i, '')
        .replace(/[_^]+/g, ' ')
        .trim();
    const genderWord = gender === 'female' ? 'Female' : 'Male';
    const categoryWord = component.category.replace(/s$/, '');
    const pretty = collection ? collection.replace(/\b\w/g, c => c.toUpperCase()) : 'Custom';
    return `${genderWord} ${pretty} ${categoryWord} ${String(garment.drawable).padStart(3, '0')}`;
}

// Build the registry entry + pack descriptor for one garment.
function buildGarmentRecords(garment, options) {
    const component = COMPONENT_BY_PREFIX[garment.prefix];
    const gender = genderFromCollection(garment.collection);

    const problems = [];
    if (!gender) problems.push('cannot tell male/female from the collection name');
    if (!garment.mesh) problems.push('no .ydd mesh found for this drawable');
    if (!garment.textures.length) problems.push('no .ytd textures found for this drawable');
    if (problems.length) {
        return { ok: false, problems, collection: garment.collection, prefix: garment.prefix, drawable: garment.drawable };
    }

    const slotId = slotIdFor(garment, gender);
    const streamDir = options.streamDir || 'stream';
    const textureFiles = garment.textures.map(t => t.fileName);

    const registryEntry = {
        id: slotId,
        templateId: slotId,
        displayName: displayNameFor(garment, gender, component),
        // 'generated' is what makes a slot bakeable: the baker has real .ytd
        // files to patch pixels into.
        assetMode: 'generated',
        gender,
        kind: component.kind,
        category: component.category,
        ...(component.kind === 'prop' ? { anchorId: component.componentId } : { componentId: component.componentId }),
        prefix: garment.prefix,
        collection: shortCollectionName(garment.collection, component.kind),
        // The folder the files are in. For a prop that is '<ped>_p_<dlc>',
        // the name its texture dictionaries go by, so it is kept as it is.
        fullCollection: garment.collection,
        drawableId: garment.drawable,
        textureCount: textureFiles.length,
        sourceTextureName: path.basename(textureFiles[0], '.ytd').split('^').pop(),
        // The client only lists slots that name their texture dictionary.
        sourceTextureDictionary: garment.collection + '\\' + path.basename(textureFiles[0], '.ytd').split('^').pop(),
        modelFile: path.basename(garment.mesh.fileName).split('^').pop(),
        textureFiles,
        // Owner-supplied garments have no extracted preview mesh, so the editor
        // falls back to the flat design texture. labelVerified marks that the
        // name was derived, not confirmed by a human looking at it.
        preview: { exact: false, source: 'owner-supplied', fallback: 'flat-texture' },
        labelVerified: false,
        preparedAt: new Date().toISOString(),
        source: options.sourceName || 'garments/'
    };

    // Where the baker finds this garment's real files. They stay in the drop
    // folder: the baker only needs to read them, so nothing is copied into
    // stream/ and the resource tree can stay read-only.
    const sourceRoot = String(options.sourceRoot || 'garments').replace(/[\/]+$/, '');
    const templateFiles = {};
    templateFiles[registryEntry.modelFile] = sourceRoot + '/' + garment.mesh.sourcePath;
    for (const texture of garment.textures) templateFiles[texture.fileName] = sourceRoot + '/' + texture.sourcePath;
    registryEntry.templateFiles = templateFiles;
    // The pack's own .ymt is not recorded: an export describes its one item
    // with a .ymt of its own, so it makes no difference whether the pack
    // shipped one.

    const packDescriptor = {
        version: 1,
        id: slotId,
        displayName: registryEntry.displayName,
        assetMode: 'generated',
        gender,
        kind: component.kind,
        category: component.category,
        componentId: component.componentId,
        collection: shortCollectionName(garment.collection, component.kind),
        fullCollection: garment.collection,
        drawableId: garment.drawable,
        textureCount: textureFiles.length,
        internalTextureName: registryEntry.sourceTextureName,
        streamRoot: streamDir,
        modelFile: garment.mesh.fileName,
        textureFiles,
        registrySlotId: slotId
    };

    return { ok: true, slotId, registryEntry, packDescriptor, meshSourcePath: garment.mesh.sourcePath, files: [garment.mesh.fileName, ...textureFiles] };
}

// prepare({ files, sourceName, streamDir }) -> { garments, skipped, summary }
// `files` is a flat list of stream filenames the owner dropped in.
function prepare(options) {
    const files = Array.isArray(options.files) ? options.files : [];
    const parsed = [];
    const unrecognised = [];

    for (const file of files) {
        // Pass the whole relative path: the collection may come from a caret in
        // the filename or from the parent directory. Anything else in the drop
        // folder (readme, fxmanifest, .fxap) is simply not a garment.
        const entry = parseStreamFile(file);
        if (entry) parsed.push(entry);
        else if (/\.(ydd|ytd)$/i.test(file)) unrecognised.push(path.basename(file));
    }

    const garments = [];
    const skipped = [];
    for (const group of groupGarments(parsed)) {
        const built = buildGarmentRecords(group, options);
        if (built.ok) garments.push(built);
        else skipped.push(built);
    }

    garments.sort((a, b) => a.slotId.localeCompare(b.slotId));

    return {
        garments,
        skipped,
        unrecognised,
        summary: {
            filesSeen: files.length,
            garmentsPrepared: garments.length,
            garmentsSkipped: skipped.length,
            unrecognisedAssets: unrecognised.length
        }
    };
}

// Merge prepared entries into an existing registry, replacing by slot id so
// re-running prepare is idempotent rather than duplicating garments.
function mergeIntoRegistry(registry, preparedGarments) {
    const base = registry && typeof registry === 'object' ? registry : {};
    const slots = Array.isArray(base.slots) ? [...base.slots] : [];
    const byId = new Map(slots.map((slot, index) => [slot && slot.id, index]));

    let added = 0;
    let replaced = 0;
    for (const garment of preparedGarments) {
        const existing = byId.get(garment.slotId);
        if (existing === undefined) {
            slots.push(garment.registryEntry);
            byId.set(garment.slotId, slots.length - 1);
            added++;
        } else {
            slots[existing] = garment.registryEntry;
            replaced++;
        }
    }

    return { registry: { ...base, slots }, added, replaced };
}

module.exports = {
    prepare,
    mergeIntoRegistry,
    parseStreamFile,
    groupGarments,
    buildGarmentRecords,
    COMPONENT_BY_PREFIX
};
