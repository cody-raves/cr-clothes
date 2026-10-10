// builder/prepare-runner.js
// The work behind `crclothes_prepare`: scan the drop folder, register each
// garment, read its mesh out of the .ydd and write the editor's 3D preview.
//
// Kept free of FiveM globals so the whole flow can be exercised offline; the
// console command in builder/prepare-command.js is a thin wrapper around it.
//
// Output goes to the resource folder when it is writable (a VPS or local
// server). Hosted servers mount it read-only, so there everything is packed
// into one zip in the download directory for the owner to fetch and upload.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GarmentPrepare = require('./garment-prepare.js');
const YddReader = require('./ydd-reader.js');
const PreviewExport = require('./preview-export.js');
const ZipWriter = require('./zip-writer.js');

const crypto = require('node:crypto');

// The download endpoint has no auth, so the zip gets an unguessable name like
// every other file served from it.
const preparedZipName = () => 'cr-clothes-prepared_' + crypto.randomBytes(8).toString('hex') + '.zip';

// Every file under `root`, relative to it with forward slashes.
function collectFiles(root) {
    const found = [];
    const walk = dir => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push(path.relative(root, full).split(path.sep).join('/'));
        }
    };
    walk(root);
    return found;
}

function readRegistry(registryPath) {
    try {
        return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch {
        return { version: 2, assetMode: 'empty', slots: [] };
    }
}

// runPrepare({ resourceRoot, garmentsDir, registryPath, outputDir, dryRun, log, writeFile })
// -> { status, garments, previews, added, replaced, zipPath }
//
// status: 'no-folder' | 'empty' | 'nothing' | 'dry-run' | 'written' | 'zipped' | 'failed'
function runPrepare(options) {
    const log = options.log || (() => {});
    const resourceRoot = path.resolve(options.resourceRoot);
    const garmentsDir = path.resolve(options.garmentsDir || path.join(resourceRoot, 'garments'));
    const registryPath = options.registryPath || path.join(resourceRoot, 'generated', 'registry.json');
    // Injected in tests to simulate a read-only resource tree.
    const writeFile = options.writeFile || ((filePath, data) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, data);
    });

    if (!fs.existsSync(garmentsDir)) {
        log('no garments folder yet. Create ' + garmentsDir + ' and drop your clothing packs in it.');
        return { status: 'no-folder' };
    }
    const files = collectFiles(garmentsDir).filter(file => file.toLowerCase() !== 'readme.md');
    if (!files.length) {
        log('garments/ is empty. Drop a clothing pack in it (the folder with the .ydd and .ytd files) and run this again.');
        return { status: 'empty' };
    }

    const sourceRoot = path.relative(resourceRoot, garmentsDir).split(path.sep).join('/');
    const result = GarmentPrepare.prepare({ files, sourceName: sourceRoot + '/', sourceRoot });
    const { summary } = result;
    log('scanned ' + summary.filesSeen + ' file(s): ' + summary.garmentsPrepared + ' garment(s) found, '
        + summary.garmentsSkipped + ' skipped, ' + summary.unrecognisedAssets + ' unrecognised.');

    // Read each garment's mesh and build its preview files.
    const outputs = [];          // { relative, data } -- relative to the resource root
    let previews = 0;
    for (const garment of result.garments) {
        const entry = garment.registryEntry;
        let meshNote;
        try {
            const mesh = YddReader.extractMesh(path.join(garmentsDir, garment.meshSourcePath));
            const previewName = PreviewExport.previewNameFor(entry);
            for (const file of PreviewExport.buildPreview(mesh, { label: previewName, sourceFile: entry.modelFile })) {
                outputs.push({ relative: 'generated/previews/' + previewName + '/' + file.name, data: file.data });
            }
            entry.preview = PreviewExport.previewRegistryFields(previewName);
            previews++;
            meshNote = '3D preview: ' + mesh.vertexCount + ' vertices, ' + mesh.triangleCount + ' triangles';
        } catch (error) {
            // The garment is still designable; it just previews as a flat texture.
            meshNote = 'no 3D preview (' + (error && error.message ? error.message : error) + ')';
        }
        log('  + ' + entry.gender + '/' + entry.category + ' drawable ' + entry.drawableId + ' -- '
            + entry.textureCount + ' texture slot(s) -- "' + entry.displayName + '"');
        // Clothing exports as a new item whether or not the pack has a .ymt.
        // Props are the one case an owner has to switch on, so say it here
        // rather than let the first exported hat be a surprise.
        log('      ' + meshNote + (entry.kind === 'prop' ? '; exports replace this prop\'s texture unless clothdesigner_prop_addon is true' : ''));
    }
    for (const skip of result.skipped) {
        log('  - skipped ' + skip.collection + '/' + skip.prefix + '_' + skip.drawable + ': ' + skip.problems.join('; '));
    }
    if (result.unrecognised.length) {
        log('  ? ' + result.unrecognised.length + ' asset(s) did not match the clothing naming convention, e.g. '
            + result.unrecognised.slice(0, 3).join(', '));
        log('    Expected <collection>^<prefix>_<id>_u.ydd or <collection>/<prefix>_<id>_u.ydd');
    }

    const base = { garments: result.garments.length, previews };
    if (!result.garments.length) {
        log('nothing to write.');
        return { ...base, status: 'nothing' };
    }
    if (options.dryRun) {
        log('dry run -- nothing written. Run crclothes_prepare without "dry" to apply.');
        return { ...base, status: 'dry-run' };
    }

    // The registry goes last: if anything before it fails, the old registry
    // still describes exactly the files that exist.
    const merged = GarmentPrepare.mergeIntoRegistry(readRegistry(registryPath), result.garments);
    outputs.push({
        relative: path.relative(resourceRoot, registryPath).split(path.sep).join('/'),
        data: Buffer.from(JSON.stringify(merged.registry, null, 2), 'utf8')
    });

    try {
        for (const output of outputs) writeFile(path.join(resourceRoot, output.relative), output.data);
        log('written into the resource: ' + merged.added + ' garment(s) added, ' + merged.replaced + ' refreshed, ' + previews + ' 3D preview(s).');
        log('to load them, run:  refresh   then   restart ' + path.basename(resourceRoot));
        return { ...base, status: 'written', added: merged.added, replaced: merged.replaced };
    } catch (error) {
        // Read-only resource tree (normal on hosted servers): hand the owner one
        // zip to extract over the resource folder instead.
        try {
            const outputDir = options.outputDir;
            fs.mkdirSync(outputDir, { recursive: true });
            const zipPath = path.join(outputDir, preparedZipName());
            fs.writeFileSync(zipPath, ZipWriter.createZip(outputs.map(output => ({ name: output.relative, data: output.data }))));
            log('the resource folder is read-only (' + (error.code || 'write refused') + '), which is normal on hosted servers.');
            log('everything was packed into ' + zipPath);
            log('download it (clothbake_get prints the link), extract it over the ' + path.basename(resourceRoot)
                + ' folder so its generated/ folder merges in, then restart the resource.');
            return { ...base, status: 'zipped', added: merged.added, replaced: merged.replaced, zipPath };
        } catch (fallbackError) {
            log('could not write the prepared files anywhere: ' + (fallbackError && fallbackError.message ? fallbackError.message : fallbackError));
            return { ...base, status: 'failed' };
        }
    }
}

module.exports = { runPrepare, collectFiles };
