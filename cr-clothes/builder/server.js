const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resourceName = GetCurrentResourceName();
const resourceRoot = GetResourcePath(resourceName);
const HostedYtdBaker = require(path.join(resourceRoot, 'builder', 'hosted-ytd-baker.js'));
const ResourcePackExporter = require(path.join(resourceRoot, 'builder', 'resource-pack-exporter.js'));
const BotUploader = require(path.join(resourceRoot, 'builder', 'bot-uploader.js'));
const WebhookDelivery = require(path.join(resourceRoot, 'builder', 'webhook-delivery.js'));
const PngEncoder = require(path.join(resourceRoot, 'builder', 'png-encoder.js'));
const PreviewRender = require(path.join(resourceRoot, 'builder', 'preview-render.js'));

// Locate the shipped preview OBJ for a registry slot: the generated/previews
// folder whose gender matches and which carries <modelFile>.xml next to its
// model.obj (e.g. jbib_000_u.ydd -> female_tops_jbib_000_u/). Cached per slot.
const previewObjCache = new Map();
function findPreviewObj(slot) {
    const cacheKey = `${slot.gender}:${slot.modelFile}`;
    if (previewObjCache.has(cacheKey)) return previewObjCache.get(cacheKey);

    let found = null;
    // Garments prepared by crclothes_prepare record their mesh directly.
    const recorded = slot.preview && slot.preview.exact && typeof slot.preview.model === 'string' ? slot.preview.model : null;
    if (recorded) {
        const direct = path.resolve(resourceRoot, recorded);
        if (direct.startsWith(path.resolve(resourceRoot) + path.sep) && fs.existsSync(direct)) {
            found = { objPath: direct, uvTransform: 'none' };
            previewObjCache.set(cacheKey, found);
            return found;
        }
    }
    try {
        const previewsRoot = path.join(resourceRoot, 'generated', 'previews');
        const wantedXml = `${slot.modelFile}.xml`;
        const genderPrefix = slot.gender === 'male' ? 'male_' : 'female_';
        for (const dir of fs.readdirSync(previewsRoot)) {
            if (!dir.startsWith(genderPrefix)) continue;
            const objPath = path.join(previewsRoot, dir, 'model.obj');
            if (fs.existsSync(path.join(previewsRoot, dir, wantedXml)) && fs.existsSync(objPath)) {
                // uvTransform comes from the preview's own manifest: raw-UV
                // regens (v7) say 'none'; any legacy export declares what it
                // baked in so the renderer can compensate.
                let uvTransform = 'none';
                try {
                    const manifest = JSON.parse(fs.readFileSync(path.join(previewsRoot, dir, 'manifest.json'), 'utf8'));
                    uvTransform = manifest.version >= 7 ? 'none' : (manifest.uvTransform === 'swap-uv-flip-v' ? 'rotateCW' : 'none');
                } catch {}
                found = { objPath, uvTransform };
                break;
            }
        }
    } catch {}
    previewObjCache.set(cacheKey, found);
    return found;
}
const registryPath = path.join(resourceRoot, 'generated', 'registry.json');
const exportUploads = new Map();
const EXPORT_UPLOAD_TTL_MS = 10 * 60 * 1000;
const EXPORT_UPLOADS_PER_PLAYER = 2;

const botUploader = BotUploader.createUploader({
    getConvar: name => GetConvar(name, ''),
    log: message => console.log(`[cr-clothes] ${message}`)
});

// Webhook delivery: no bot, no external service. The pack stays on this server
// and Discord receives only a capability link to it. This is the default
// delivery path for owners who do not want to run anything extra.
const webhookDelivery = WebhookDelivery.createWebhookDelivery({
    getConvar: name => GetConvar(name, ''),
    log: message => console.log(`[cr-clothes] ${message}`),
    resourceName
});

let bakerCapability = null;

// Hosted write path: raw fs writes are jailed (EACCES), so the baker's final
// write goes through builder/fs-bridge.lua's SaveResourceFile export. FiveM's
// cross-runtime export table may live on global.exports, globalThis.exports, or
// an injected script-scope `exports`; pick whichever exposes our resource.
function fivemBridge() {
    const tables = [];
    if (typeof global !== 'undefined' && global.exports) tables.push(global.exports);
    if (typeof globalThis !== 'undefined' && globalThis.exports) tables.push(globalThis.exports);
    try { if (typeof exports !== 'undefined' && exports) tables.push(exports); } catch {}
    for (const table of tables) {
        try { if (table[resourceName]) return table[resourceName]; } catch {}
    }
    throw new Error('FiveM exports table not found -- is builder/fs-bridge.lua loaded before builder/server.js?');
}
function bakerSaveFile(rel, buffer) {
    return fivemBridge().bakerSaveFileB64(rel, Buffer.from(buffer).toString('base64')) !== false;
}
function bakerDeleteFile(rel) {
    try { return fivemBridge().bakerDeleteFile(rel) !== false; } catch { return false; }
}

function safeJsonRead(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function safeSlug(value, fallback = 'design', max = 48) {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, max);
    return normalized || `${fallback}_${Date.now()}`;
}

function textureVariantLetter(index) {
    return String.fromCharCode(97 + Math.max(0, Math.min(25, Math.floor(Number(index) || 0))));
}

function playerUploadKey(playerSource, uploadId) {
    return `${playerSource}:${String(uploadId || '').slice(0, 80)}`;
}

// Export rights: admins (ACE) always; otherwise the grant system decides —
// a Tebex purchase, an admin grant, or a job/gang rule (see grants.lua).
function hasBuilderAccess(playerSource, template) {
    if (playerSource === 0) return true;
    if (IsPlayerAceAllowed(String(playerSource), 'command.clothbuilder')) return true;
    try {
        return fivemBridge().CanDesign(playerSource, template || '*') === true;
    } catch {
        return false; // grants unavailable -> fail closed
    }
}

function sendResult(playerSource, result) {
    emitNet('cr-clothes:builderResult', playerSource, result);
}

function exportResult(playerSource, result) {
    emitNet('cr-clothes:exportResult', playerSource, result);
}

function loadRegistry() {
    const registry = safeJsonRead(registryPath, { version: 2, assetMode: 'empty', slots: [] });
    registry.slots = Array.isArray(registry.slots) ? registry.slots : [];
    return registry;
}

function refreshBakerCapability(logResult = false) {
    bakerCapability = HostedYtdBaker.checkCapability({ resourceRoot, registryPath, saveFile: bakerSaveFile, deleteFile: bakerDeleteFile });
    if (logResult) {
        const level = bakerCapability.ok ? 'log' : 'warn';
        console[level](`[cr-clothes] ${bakerCapability.message}`);
    }
    return bakerCapability;
}

function hostedBuilderMessage() {
    const capability = refreshBakerCapability(false);
    const registry = loadRegistry();
    const generatedCount = registry.slots.filter(slot => String(slot?.assetMode || '').toLowerCase() === 'generated').length;
    const existingCount = registry.slots.length - generatedCount;
    return {
        ok: true,
        hostedMode: true,
        capability,
        registry,
        message: `${capability.message}${existingCount > 0 ? ` ${existingCount} stock runtime-preview item(s) are bake-disabled.` : ''}`
    };
}

function openBuilder(playerSource) {
    if (!hasBuilderAccess(playerSource)) {
        sendResult(playerSource, { ok: false, message: 'You do not have command.clothbuilder permission.' });
        return;
    }

    emitNet('cr-clothes:builderOpen', playerSource, hostedBuilderMessage());
}

function hostedToolingDisabled(action) {
    return {
        ok: false,
        hostedMode: true,
        message: `${action} is disabled in hosted production mode. Install prepared template packs instead; external asset-prep helpers are dev/offline tooling only.`
    };
}

RegisterCommand('clothbuilder', playerSource => {
    if (playerSource > 0) {
        openBuilder(playerSource);
    } else {
        console.log(`[cr-clothes] ${hostedBuilderMessage().message}`);
    }
}, true);

RegisterCommand('clothbuilder_pending', playerSource => {
    if (playerSource !== 0) return;
    const registry = loadRegistry();
    const generatedCount = registry.slots.filter(slot => String(slot?.assetMode || '').toLowerCase() === 'generated').length;
    console.log(`[cr-clothes] Registry has ${registry.slots.length} slot(s), ${generatedCount} generated addon slot(s). ${refreshBakerCapability(false).message}`);
}, true);

RegisterCommand('clothbuilder_perms', playerSource => {
    if (playerSource !== 0) return;
    const capability = refreshBakerCapability(false);
    console.log(`[cr-clothes] Hosted bake permission diagnostics:\n${JSON.stringify(capability, null, 2)}`);
}, true);

RegisterCommand('clothbot_test', playerSource => {
    if (playerSource !== 0) {
        console.log('[cr-clothes] clothbot_test is a server-console command.');
        return;
    }
    if (!botUploader.enabled()) {
        console.log('[cr-clothes] clothbot_test: set the clothdesigner_bot_url and clothdesigner_bot_token convars in server.cfg first.');
        return;
    }
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clothdesigner-bot-test-'));
    const testFile = path.join(testDir, 'hello.txt');
    fs.writeFileSync(testFile, 'clothdesigner pairing ok');
    botUploader.uploadPack({
        zipPath: testFile,
        name: 'pairing test',
        mode: 'test',
        meta: { kind: 'pairing-test', sentAt: new Date().toISOString() }
    }).then(result => {
        console.log(`[cr-clothes] clothbot_test result: ${JSON.stringify(result)}`);
    }).catch(error => {
        console.warn(`[cr-clothes] clothbot_test error: ${error?.message || error}`);
    }).finally(() => {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    });
}, true);

// Verify webhook delivery without baking a design: posts a real message to the
// configured Discord webhook using a throwaway file, so an owner can confirm
// both convars (webhook URL and public URL) before trusting the pipeline.
RegisterCommand('clothwebhook_test', playerSource => {
    if (playerSource !== 0) return;

    const { webhookUrl, publicUrl } = webhookDelivery.settings();
    if (!webhookDelivery.enabled()) {
        console.log(`[cr-clothes] webhook delivery is off. Set clothdesigner_webhook_url to a https://discord.com/api/webhooks/... URL.${webhookUrl ? ' (current value is not a Discord webhook URL)' : ''}`);
        return;
    }
    if (!publicUrl) {
        console.log("[cr-clothes] set clothdesigner_public_url to the address players reach this server on, e.g. \"http://1.2.3.4:30120\".");
        return;
    }

    // Write the probe into the same directory packs are served from, so a
    // successful test proves the whole path: file -> HTTP route -> Discord.
    let probePath = null;
    try {
        const capability = webhookDelivery.deliveryName('webhook_test', '.txt');
        const outDir = require(path.join(resourceRoot, 'builder', 'output-dir.js')).resolveOutputDir(resourceRoot);
        probePath = path.join(outDir, capability);
        fs.writeFileSync(probePath, 'cr-clothes webhook delivery test\n');
    } catch (error) {
        console.warn(`[cr-clothes] could not write the test file: ${error?.message || error}`);
        return;
    }

    webhookDelivery.deliver({
        zipPath: probePath,
        name: 'Webhook delivery test',
        mode: 'test',
        packName: 'cr_clothes_webhook_test'
    }).then(result => {
        if (result.ok) {
            console.log(`[cr-clothes] webhook test posted. Open the link in Discord to confirm the download works: ${result.url}`);
        } else {
            console.warn(`[cr-clothes] webhook test failed (${result.status}): ${result.detail}`);
        }
    }).catch(error => {
        console.warn(`[cr-clothes] webhook test error: ${error?.message || error}`);
    });
}, true);

// Catalog universe scan (client crclothes_scan): writes the full list of
// clothing collections/drawables this game build exposes, so catalog expansion
// picks real garments instead of guessing drawable ids.
RegisterCommand('crclothes_scan_all', playerSource => {
    if (playerSource !== 0) return;
    const players = getPlayers();
    if (!players.length) {
        console.log('[cr-clothes] catalog scan needs a connected player — the data lives on the client.');
        return;
    }
    for (const id of players) emitNet('cr-clothes:runScan', id);
    console.log(`[cr-clothes] catalog scan requested from ${players.length} player(s).`);
}, true);

// Curation tags (client-curate.lua): garments a human looked at in-game and
// judged worth adding. Accumulated server-side and written out on dump, so a
// curation session survives a client crash.
const curationTags = new Map();
onNet('cr-clothes:tagGarment', record => {
    if (!record || typeof record !== 'object') return;
    const key = [record.gender, record.category, record.collection, record.drawableId].join('|');
    curationTags.set(key, record);
});
onNet('cr-clothes:dumpTags', list => {
    try {
        if (Array.isArray(list)) {
            for (const record of list) {
                if (!record) continue;
                const key = [record.gender, record.category, record.collection, record.drawableId].join('|');
                curationTags.set(key, record);
            }
        }
        const outDir = path.join(os.tmpdir(), 'clothdesigner');
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, 'curated-garments.json');
        const records = [...curationTags.values()];
        fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), count: records.length, garments: records }, null, 2));
        console.log(`[cr-clothes] curation: ${records.length} tagged garment(s) -> ${file}`);
        for (const r of records) {
            console.log(`[cr-clothes]   ${r.gender} ${r.category} ${r.collection} drawable ${r.drawableId} (${r.textures} tex)`);
        }
    } catch (error) {
        console.warn(`[cr-clothes] curation dump failed: ${error?.message || error}`);
    }
});

RegisterCommand('crclothes_curate_all', playerSource => {
    if (playerSource !== 0) return;
    const players = getPlayers();
    if (!players.length) { console.log('[cr-clothes] curation needs a connected player.'); return; }
    for (const id of players) emitNet('cr-clothes:runCurate', id);
    console.log('[cr-clothes] curation mode requested.');
}, true);

onNet('cr-clothes:scanResult', report => {
    try {
        const outDir = path.join(os.tmpdir(), 'clothdesigner');
        fs.mkdirSync(outDir, { recursive: true });
        const model = String(report?.model || 'unknown').replace(/[^a-z0-9_]/gi, '');
        const file = path.join(outDir, `catalog-universe-${model}.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
        console.log(`[cr-clothes] catalog scan: ${report?.totalDrawables || 0} drawables, ` +
            `${(report?.collections || []).length} collections -> ${file}`);
    } catch (error) {
        console.warn(`[cr-clothes] catalog scan write failed: ${error?.message || error}`);
    }
});

onNet('cr-clothes:diagNote', note => {
    console.log(`[clothdesigner-diag] NOTE from player ${global.source}: ${String(note).slice(0, 300)}`);
});

// Client auto-diagnostic (client-equip-test.lua) reports its collection scan
// here so local/headless testing can read the verdict from the server console.
onNet('cr-clothes:diagReport', report => {
    const player = global.source;
    const matches = Array.isArray(report?.cdMatches) ? report.cdMatches : [];
    const tail = Array.isArray(report?.lastFew) ? report.lastFew : [];
    console.log('[clothdesigner-diag] ======================================');
    console.log(`[clothdesigner-diag] player ${player} (${GetPlayerName(String(player)) || '?'}) via ${report?.source || '?'}`);
    console.log(`[clothdesigner-diag] collections on ped: ${Number(report?.collections) || 0}`);
    console.log(`[clothdesigner-diag] 'cd' matches: ${matches.length ? matches.join(', ') : 'NONE'}`);
    console.log(`[clothdesigner-diag] last few: ${tail.join(', ')}`);
    const globals = report?.globalCounts || {};
    console.log(`[clothdesigner-diag] GLOBAL drawable counts: legs(4)=${globals['4']} undershirt(8)=${globals['8']} tops(11)=${globals['11']}`);
    console.log(`[clothdesigner-diag] (vanilla b3258 female baselines: legs=173, tops=587 per earlier menu screenshot -- higher = addon items registered globally)`);
    console.log(`[clothdesigner-diag] auto-equipped addon item: ${report?.equipped ? 'YES' : 'no'}`);
    console.log(`[clothdesigner-diag] VERDICT: ${matches.length ? 'ADDON COLLECTION REGISTERED 🎉' : 'addon collection NOT registered'}`);
    console.log('[clothdesigner-diag] ======================================');
});

onNet('cr-clothes:builderRequestOpen', () => {
    openBuilder(global.source);
});

onNet('cr-clothes:builderSeed', () => {
    sendResult(global.source, hostedToolingDisabled('Template seeding'));
});

onNet('cr-clothes:builderBuild', () => {
    sendResult(global.source, hostedToolingDisabled('Addon slot generation'));
});

onNet('cr-clothes:builderSaveSelections', () => {
    sendResult(global.source, hostedToolingDisabled('Saving/extracting stock GTA selections'));
});

onNet('cr-clothes:builderExtractSelections', () => {
    sendResult(global.source, hostedToolingDisabled('Stock GTA extraction'));
});

function writeExportSidecar(meta, rawBytes, uploadId) {
    const garment = meta?.garment || {};
    const textureIndex = Math.max(0, Math.min(25, Math.floor(Number(meta?.textureIndex) || 0)));
    const baseName = safeSlug(meta?.exportName || garment.label || garment.id || 'baked_design', 'baked_design');
    // Debug sidecars go under the system temp dir: the resource tree is
    // read-only on hosted servers, so nothing may ever be written inside it.
    const exportDir = path.join(os.tmpdir(), 'clothdesigner', 'sidecars', `${new Date().toISOString().replace(/[:.]/g, '-')}_${baseName}`);
    fs.mkdirSync(exportDir, { recursive: true });

    const manifest = {
        version: 2,
        mode: 'hosted-ytd-bake',
        exportedAt: new Date().toISOString(),
        uploadId,
        slotId: String(meta?.slotId || garment.id || ''),
        textureIndex,
        textureLetter: textureVariantLetter(textureIndex),
        width: Number(meta?.width) || 1024,
        height: Number(meta?.height) || 1024,
        garment,
        design: meta?.design || null,
        note: 'The hosted Node baker wrote the captured in-game design into a prepared streamable YTD variant.'
    };

    fs.writeFileSync(path.join(exportDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (meta?.design) {
        fs.writeFileSync(path.join(exportDir, 'design.json'), JSON.stringify(meta.design, null, 2));
    }
    fs.writeFileSync(path.join(exportDir, 'texture.raw.rgba'), rawBytes);
    return exportDir;
}

function cleanupExportUpload(key) {
    exportUploads.delete(key);
}

AddEventHandler('playerDropped', () => {
    const droppedPrefix = `${global.source}:`;
    for (const key of exportUploads.keys()) {
        if (key.startsWith(droppedPrefix)) exportUploads.delete(key);
    }
});

setInterval(() => {
    const now = Date.now();
    for (const [key, upload] of exportUploads) {
        if (now - upload.startedAt > EXPORT_UPLOAD_TTL_MS) exportUploads.delete(key);
    }
}, 60 * 1000);

function validateUploadMeta(meta) {
    const slotId = String(meta?.slotId || meta?.garment?.id || '').trim();
    if (!slotId) throw new Error('Export is missing a generated slot id.');

    const textureIndex = Math.floor(Number(meta?.textureIndex) || 0);
    if (!Number.isFinite(textureIndex) || textureIndex < 0 || textureIndex > 25) {
        throw new Error('Export texture variant must be between 0 and 25.');
    }

    const width = Math.floor(Number(meta?.width) || 1024);
    const height = Math.floor(Number(meta?.height) || 1024);
    if (width < 16 || width > 4096 || height < 16 || height > 4096) {
        throw new Error('Export texture dimensions must be between 16 and 4096 pixels.');
    }

    return { slotId, textureIndex, width, height };
}

onNet('cr-clothes:exportBegin', request => {
    const playerSource = global.source;
    if (!hasBuilderAccess(playerSource)) {
        exportResult(playerSource, { ok: false, message: 'Export permission denied.' });
        return;
    }

    try {
        const uploadId = String(request?.uploadId || '').slice(0, 80);
        const totalChunks = Math.floor(Number(request?.totalChunks) || 0);
        if (!uploadId || !Number.isFinite(totalChunks) || totalChunks < 1 || totalChunks > 1000) {
            throw new Error('Invalid export upload request.');
        }

        validateUploadMeta(request?.meta || {});
        const key = playerUploadKey(playerSource, uploadId);

        let activeUploads = 0;
        const playerPrefix = `${playerSource}:`;
        for (const existingKey of exportUploads.keys()) {
            if (existingKey !== key && existingKey.startsWith(playerPrefix)) activeUploads += 1;
        }
        if (activeUploads >= EXPORT_UPLOADS_PER_PLAYER) {
            throw new Error('Too many active export uploads. Wait for the current export to finish.');
        }

        exportUploads.set(key, {
            startedAt: Date.now(),
            totalChunks,
            chunks: new Array(totalChunks),
            received: 0,
            meta: request?.meta || {}
        });
    } catch (error) {
        exportResult(playerSource, { ok: false, message: error?.message || 'Invalid export upload request.' });
    }
});

onNet('cr-clothes:exportChunk', request => {
    const playerSource = global.source;
    if (!hasBuilderAccess(playerSource)) return;

    const uploadId = String(request?.uploadId || '').slice(0, 80);
    const key = playerUploadKey(playerSource, uploadId);
    const upload = exportUploads.get(key);
    if (!upload) return;

    const index = Math.floor(Number(request?.index));
    const chunk = String(request?.chunk || '');
    if (index < 0 || index >= upload.totalChunks || chunk.length > 80000) {
        cleanupExportUpload(key);
        exportResult(playerSource, { ok: false, message: 'Invalid export chunk. Upload cancelled.' });
        return;
    }

    if (!upload.chunks[index]) {
        upload.received++;
    }
    upload.chunks[index] = chunk;
});

// Latent payload chunk lists arrive either as a JS array (0-based) or as a
// msgpack'd Lua table with 1-based (possibly string) numeric keys. Decide the
// indexing base ONCE for the whole payload, then extract strictly with that
// base -- no per-element fallback, so a genuinely missing chunk stays '' and
// fails the completeness check in bakeExportUpload instead of silently
// borrowing its neighbour.
function normalizeChunkArray(chunks, totalChunks) {
    const normalized = new Array(totalChunks).fill('');
    if (!chunks || typeof chunks !== 'object') return normalized;

    const readKey = key => chunks[key] ?? chunks[String(key)];
    let base = null;
    if (readKey(0) != null) {
        base = 0;
    } else if (readKey(1) != null && readKey(totalChunks) != null) {
        base = 1;
    }
    if (base === null) return normalized;

    for (let index = 0; index < totalChunks; index += 1) {
        const value = readKey(index + base);
        normalized[index] = value == null ? '' : String(value);
    }
    return normalized;
}

function bakeExportUpload(playerSource, uploadId, upload, cleanupKey = null) {
    try {
        if (Date.now() - upload.startedAt > EXPORT_UPLOAD_TTL_MS) {
            throw new Error('Export upload expired. Try exporting again.');
        }
        if (!Array.isArray(upload.chunks) || upload.chunks.length !== upload.totalChunks) {
            throw new Error('Export upload chunks were not decoded correctly.');
        }
        if (upload.received !== upload.totalChunks || upload.chunks.some(chunk => !chunk || chunk.length > 80000)) {
            throw new Error(`Upload incomplete: received ${upload.received}/${upload.totalChunks} chunks.`);
        }

        const { slotId, textureIndex, width, height } = validateUploadMeta(upload.meta);
        const rawBytes = Buffer.concat(upload.chunks.map(chunk => Buffer.from(chunk, 'base64')));
        const expectedLength = width * height * 4;
        if (rawBytes.length !== expectedLength) {
            throw new Error(`Raw texture was ${rawBytes.length} bytes; expected ${expectedLength} for ${width}x${height}.`);
        }

        // Debug copy of the raw design; only written with clothdesigner_debug on.
        let sidecarDir = null;
        if (GetConvar('clothdesigner_debug', 'false') === 'true') try {
            sidecarDir = writeExportSidecar(upload.meta, rawBytes, uploadId);
        } catch (error) {
            console.warn(`[cr-clothes] export sidecar skipped: ${error?.message || error}`);
        }

        const exportName = String(upload.meta?.exportName || upload.meta?.garment?.label || 'Baked design');
        // Product output is an ADDON pack: a real new clothing item (YMT +
        // YDD + texture variants), written OUTSIDE the read-only resource
        // tree and downloadable via clothbake_get / the /out endpoint.
        // Runtime AddReplaceTexture previews are unrelated to this file; the
        // caret replace pack remains available as a dev/test mode via convar.
        const exportMode = GetConvar('clothdesigner_export_mode', 'addon') === 'replace' ? 'replace' : 'addon';
        const packOptions = {
            resourceRoot,
            registryPath,
            slotId,
            textureIndex,
            width,
            height,
            rawRgba: rawBytes,
            exportName
        };
        let resourcePack;
        let exportModeNote = '';
        if (exportMode === 'replace') {
            resourcePack = ResourcePackExporter.createReplacePack(packOptions);
        } else {
            try {
                resourcePack = ResourcePackExporter.createAddonPack(packOptions);
            } catch (error) {
                // A dropped pack without its collection .ymt cannot become a new
                // addon item, but its texture can still be replaced. Say so
                // rather than failing the export or switching modes silently.
                if (!error || error.code !== 'NO_TEMPLATE_YMT') throw error;
                resourcePack = ResourcePackExporter.createReplacePack(packOptions);
                exportModeNote = ' NOTE: this garment was prepared from a pack without a .ymt, so the export REPLACES the texture of the existing garment instead of creating a new item.';
            }
        }

        let inPlaceBake = null;
        let inPlaceBakeSkipped = null;
        const capability = refreshBakerCapability(false);
        // In-place baking overwrites the slot's source .ytd. For an
        // owner-prepared garment that file is the owner's own clothing in
        // garments/, which must never be modified.
        const exportSlot = loadRegistry().slots.find(item => item && item.id === slotId) || {};
        if (exportSlot.templateFiles) {
            inPlaceBakeSkipped = 'Skipped: owner-prepared garments are never baked over in place.';
        } else if (capability.ok) {
            try {
                inPlaceBake = HostedYtdBaker.bake({
                    resourceRoot,
                    registryPath,
                    slotId,
                    textureIndex,
                    width,
                    height,
                    rawRgba: rawBytes,
                    exportName,
                    saveFile: bakerSaveFile,
                    deleteFile: bakerDeleteFile
                });
            } catch (error) {
                inPlaceBakeSkipped = `Active stream YTD bake failed after resource asset creation: ${error?.message || error}`;
            }
        } else {
            inPlaceBakeSkipped = capability.message || 'In-place hosted bake is unavailable on this server.';
        }

        if (cleanupKey) cleanupExportUpload(cleanupKey);
        exportResult(playerSource, {
            ok: true,
            message: `Created pack '${resourcePack.packName}.zip' (${Math.round((resourcePack.zipBytes || 0) / 1024)} KB). Download it via clothbake_get or the /out endpoint, extract into resources/, add 'ensure ${resourcePack.packName}', then restart. ${inPlaceBake ? 'Also baked into the active stream YTD.' : ''}${exportModeNote}`,
            restartRequired: true,
            resourcePack,
            inPlaceBake,
            inPlaceBakeSkipped,
            sidecarPath: sidecarDir
        });

        // A successful export spends one design use (unlimited grants and
        // open-design servers are unaffected), then announces itself so other
        // resources can react (wardrobe wiring, logging, economy hooks).
        try {
            fivemBridge().ConsumeDesign(playerSource, slotId);
        } catch { /* grants unavailable; export already succeeded */ }
        try {
            emit('cr-clothes:designExported', {
                player: playerSource,
                slotId,
                textureIndex,
                packName: resourcePack.packName || null,
                mode: resourcePack.mode || 'addon'
            });
        } catch { /* event bus unavailable */ }

        // Phase B: fire-and-forget bot upload of the assembled pack zip.
        // resourcePack.zipPath is produced by the v2 pack exporter; older
        // results without it simply skip the upload. Never blocks the reply.
        let packZip = resourcePack && resourcePack.zipPath;

        // Webhook delivery links straight to this file over the server's own
        // HTTP endpoint, which has no auth -- so rename it to carry an
        // unguessable id first. The URL becomes the credential, and both
        // delivery paths below then reference the same renamed file.
        if (packZip && webhookDelivery.enabled()) {
            try {
                const renamed = path.join(
                    path.dirname(packZip),
                    webhookDelivery.deliveryName(resourcePack.packName || exportName, '.zip')
                );
                fs.renameSync(packZip, renamed);
                packZip = renamed;
                if (resourcePack) resourcePack.zipPath = renamed;
            } catch (error) {
                console.warn(`[cr-clothes] could not apply capability name: ${error?.message || error}`);
            }
        }

        if (packZip && (botUploader.enabled() || webhookDelivery.enabled())) {
            // Fire-and-forget: build the card preview, then upload the pack.
            // Preferred preview is a 3D render of the garment's real mesh
            // wearing the design (the preview OBJ ships with the resource);
            // fallback is the flat design texture. Neither may block or fail
            // the export -- the pack is already built and downloadable.
            (async () => {
                let previewPath = null;
                try {
                    const registrySlot = loadRegistry().slots.find(item => item && item.id === slotId) || {};
                    const preview = findPreviewObj(registrySlot);
                    let png;
                    if (preview) {
                        const render = await PreviewRender.renderPreview({
                            objPath: preview.objPath,
                            textureRgba: rawBytes,
                            texWidth: width,
                            texHeight: height,
                            size: 1024,
                            // Mid-slate ground: cards render on Discord's own
                            // background, which may be light or dark; a transparent
                            // PNG can hide a white or black garment entirely.
                            background: [72, 78, 92],
                            // Manifest-driven: raw-UV previews (v7) need none;
                            // proven against in-game truth 2026-08-15.
                            uvTransform: preview.uvTransform
                        });
                        png = PngEncoder.encodePng(render.rgba, render.width, render.height, { maxDimension: 512 });
                    } else {
                        png = PngEncoder.encodePng(rawBytes, width, height, { maxDimension: 512 });
                    }
                    previewPath = path.join(path.dirname(packZip), `${path.basename(packZip, '.zip')}_preview.png`);
                    fs.writeFileSync(previewPath, png);
                } catch (error) {
                    console.warn(`[cr-clothes] preview render skipped: ${error?.message || error}`);
                    previewPath = null;
                }

                // Both paths may be on at once; neither blocks the export and
                // a failure in one must not prevent the other.
                if (botUploader.enabled()) {
                    await botUploader.uploadPack({
                        zipPath: packZip,
                        name: exportName,
                        mode: String(resourcePack.mode || 'replace'),
                        previewPath,
                        meta: { slotId, textureIndex, uploadId, packName: resourcePack.packName || null }
                    }).catch(error => {
                        console.warn(`[cr-clothes] bot upload failed: ${error?.message || error}`);
                    });
                }

                if (webhookDelivery.enabled()) {
                    await webhookDelivery.deliver({
                        zipPath: packZip,
                        name: exportName,
                        mode: String(resourcePack.mode || 'replace'),
                        packName: resourcePack.packName || null,
                        slotId,
                        previewPath
                    }).catch(error => {
                        console.warn(`[cr-clothes] webhook delivery failed: ${error?.message || error}`);
                    });
                }
            })().catch(error => {
                console.warn(`[cr-clothes] delivery failed: ${error?.message || error}`);
            });
        }
    } catch (error) {
        if (cleanupKey) cleanupExportUpload(cleanupKey);
        exportResult(playerSource, {
            ok: false,
            message: error?.message || 'Export failed.',
            detail: error?.stack || String(error)
        });
    }
}

onNet('cr-clothes:exportFinish', request => {
    const playerSource = global.source;
    if (!hasBuilderAccess(playerSource)) {
        exportResult(playerSource, { ok: false, message: 'Export permission denied.' });
        return;
    }

    const uploadId = String(request?.uploadId || '').slice(0, 80);
    const key = playerUploadKey(playerSource, uploadId);
    const upload = exportUploads.get(key);
    if (!upload) {
        exportResult(playerSource, { ok: false, message: 'Export upload was not found.' });
        return;
    }

    bakeExportUpload(playerSource, uploadId, upload, key);
});

onNet('cr-clothes:exportPayload', request => {
    const playerSource = global.source;
    if (!hasBuilderAccess(playerSource)) {
        exportResult(playerSource, { ok: false, message: 'Export permission denied.' });
        return;
    }

    try {
        const uploadId = String(request?.uploadId || '').slice(0, 80);
        const totalChunks = Math.floor(Number(request?.totalChunks) || 0);
        if (!uploadId || !Number.isFinite(totalChunks) || totalChunks < 1 || totalChunks > 1000) {
            throw new Error('Invalid latent export payload.');
        }

        validateUploadMeta(request?.meta || {});
        const chunks = normalizeChunkArray(request?.chunks, totalChunks);
        const received = chunks.filter(chunk => !!chunk).length;
        bakeExportUpload(playerSource, uploadId, {
            startedAt: Date.now(),
            totalChunks,
            chunks,
            received,
            meta: request?.meta || {}
        });
    } catch (error) {
        exportResult(playerSource, {
            ok: false,
            message: error?.message || 'Invalid latent export payload.',
            detail: error?.stack || String(error)
        });
    }
});

// One line at startup instead of one per subsystem. `set clothdesigner_debug
// true` in server.cfg brings the per-subsystem detail back.
setTimeout(() => {
    try {
        const debug = GetConvar('clothdesigner_debug', 'false') === 'true';
        refreshBakerCapability(debug);
        const slots = loadRegistry().slots;
        const exportable = slots.filter(slot => String(slot?.assetMode || '').toLowerCase() === 'generated').length;
        let status = {};
        try { status = fivemBridge().GetStatus() || {}; } catch { /* grants not loaded */ }
        const delivery = [webhookDelivery.enabled() ? 'Discord webhook' : null, botUploader.enabled() ? 'bot' : null]
            .filter(Boolean).join(' + ') || 'download only (clothbake_get)';
        const rights = status.openDesign ? 'open to everyone' : `grants (${status.storage || 'memory'})`;
        const outputDir = require(path.join(resourceRoot, 'builder', 'output-dir.js')).resolveOutputDir(resourceRoot);
        const version = GetResourceMetadata(resourceName, 'version', 0) || '?';
        console.log(`[cr-clothes] v${version} ready | garments: ${slots.length} (${exportable} exportable) | delivery: ${delivery} | design rights: ${rights} | framework: ${status.framework || 'standalone'} | packs: ${outputDir}`);

        // Only speak up beyond that when something needs the owner's attention.
        if (!slots.length) {
            console.log(`[cr-clothes] no garments yet: drop clothing packs into ${path.join(resourceRoot, 'garments')} and run crclothes_prepare.`);
        }
        const { publicUrl } = webhookDelivery.settings();
        if (webhookDelivery.enabled() && !publicUrl) {
            console.warn('[cr-clothes] clothdesigner_webhook_url is set but clothdesigner_public_url is not, so download links cannot be built.');
        } else if (webhookDelivery.enabled() && /127[.]0[.]0[.]1|localhost/i.test(publicUrl)) {
            console.warn('[cr-clothes] clothdesigner_public_url points at this machine, so download links only work on the server itself. Use the address players connect to.');
        }
    } catch (error) {
        console.warn(`[cr-clothes] startup check failed: ${error?.message || error}`);
    }
}, 1500);
