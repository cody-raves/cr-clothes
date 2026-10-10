// ---------------------------------------------------------------------------
// prepare-command.js -- crclothes_prepare console command
// ---------------------------------------------------------------------------
// Turns clothing the owner already has into designable garments, with real 3D
// previews read straight from the pack's own .ydd files.
//
//   1. Owner drops clothing packs into cr-clothes/garments/
//   2. Owner runs `crclothes_prepare` in the server console
//   3. Garments appear in the designer after a restart
//
// Usage:
//     crclothes_prepare            scan and prepare everything in garments/
//     crclothes_prepare dry        report what WOULD be prepared, write nothing
//
// The work itself lives in builder/prepare-runner.js (no FiveM globals, so it
// is testable offline). On a read-only hosted server the runner packs its
// output into a zip in the download directory instead of writing in place.
//
// Wrapped in an IIFE: FiveM loads every server_scripts JS file into one shared
// module scope, so top-level `const fs`/`path` would collide with the same
// names in builder/server.js.
// ---------------------------------------------------------------------------

(() => {
const path = require('node:path');

const resourceName = GetCurrentResourceName();
const resourceRoot = GetResourcePath(resourceName);
const PrepareRunner = require(path.join(resourceRoot, 'builder', 'prepare-runner.js'));

const GARMENTS_DIR = path.join(resourceRoot, 'garments');
const OUTPUT_DIR = require(path.join(resourceRoot, 'builder', 'output-dir.js')).resolveOutputDir(resourceRoot);

const TAG = '[crclothes_prepare]';
const say = message => console.log(`${TAG} ${message}`);

RegisterCommand('crclothes_prepare', (playerSource, args) => {
    if (playerSource !== 0) return;   // console only
    const dryRun = String((args && args[0]) || '').toLowerCase() === 'dry';

    let outcome;
    try {
        outcome = PrepareRunner.runPrepare({
            resourceRoot,
            garmentsDir: GARMENTS_DIR,
            outputDir: OUTPUT_DIR,
            dryRun,
            log: say
        });
    } catch (error) {
        say(`failed: ${error?.message || error}`);
        return;
    }

    if (outcome.status === 'written' || outcome.status === 'zipped') {
        // Preparing makes a garment designable; the game still loads the model
        // from a streaming resource. Say so rather than let the owner find an
        // invisible garment later.
        say('');
        say('REMINDER: the clothing pack itself must still be running (ensure <that pack>),');
        say('so the game can load the garment players are designing on.');
    }
}, true);

if (GetConvar('clothdesigner_debug', 'false') === 'true') say(`ready. Drop clothing packs in ${GARMENTS_DIR} and run crclothes_prepare.`);
})();
