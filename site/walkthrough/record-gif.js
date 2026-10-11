'use strict';
// Records the first-install walkthrough as an animated GIF.
//
// An optional tool for contributors: the site build never runs it. It plays
// the built page in headless Chrome, in the page's recording view (the page
// opened with ?record=1, key H: the stage alone, 1280 x 720), captures every
// frame with its time stamp, and has ffmpeg write the GIF. Every screen is
// held exactly as long as the page holds it.
//
//   node site/build.js
//   node site/walkthrough/record-gif.js --chrome <chrome executable>
//   node site/build.js                       (again: it copies the new GIF into docs/)
//
// Needs puppeteer-core (npm install --no-save puppeteer-core), a Chrome or
// Chromium, and ffmpeg. All three are looked for before anything is recorded
// or written.
//
// Options, with the environment variable that does the same:
//   --chrome <file>     Chrome or Chromium executable            CHROME_PATH
//   --ffmpeg <file>     ffmpeg executable (default: "ffmpeg")     FFMPEG_PATH
//   --docs <folder>     the built site to record (default: <repository>/docs)
//   --out <file>        the GIF (default: site/static/first-install.gif)
//   --card <file>       the picture link previews show: the finished first
//                       screen (default: site/static/first-install-card.png;
//                       "--card none" writes none)
//   --stills <folder>   also write the finished state of each screen as a PNG
//   --frames <folder>   keep the captured frames there (default: a temporary
//                       folder that is removed afterwards). The folder has to
//                       be new, empty, or hold nothing but the frames of an
//                       earlier recording, which are replaced. Nothing else
//                       is ever removed from it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const steps = require('./steps.js');

const SITE = path.resolve(__dirname, '..');
const ROOT = path.resolve(SITE, '..');
const W = 1280, H = 720;
const MAX_HOLD = 9;             // seconds: no single frame is held longer than this (the longest screen holds for 8)
const TIME_LIMIT = 240;         // seconds: the whole walkthrough takes about 100
// What this tool writes into a frames folder, and so the only thing it may find or remove there.
const ownFrame = name => /^f\d{5}\.png$/.test(name) || name === 'frames.txt';

// Everything the recording needs is checked here. Nothing is written or removed yet.
function options(argv) {
    const known = ['chrome', 'ffmpeg', 'docs', 'out', 'card', 'stills', 'frames'];
    const given = {};
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i].replace(/^--/, '');
        if (!argv[i].startsWith('--') || !known.includes(name) || argv[i + 1] === undefined) throw new Error('unknown or incomplete option: ' + argv[i] + '\n       options: ' + known.map(option => '--' + option).join(' '));
        given[name] = argv[++i];
    }
    const chrome = given.chrome || process.env.CHROME_PATH;
    if (!chrome) throw new Error('no Chrome given: pass --chrome <chrome executable> or set CHROME_PATH');
    if (!fs.existsSync(chrome)) throw new Error('Chrome not found at ' + chrome);
    const docs = path.resolve(given.docs || path.join(ROOT, 'docs'));
    const pageFile = path.join(docs, 'first-install', 'index.html');
    if (!fs.existsSync(pageFile)) throw new Error('no built page at ' + pageFile + '\n       run "node site/build.js" first, or point --docs at a built site');
    const ffmpeg = given.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
    return {
        chrome,
        ffmpeg,
        ffmpegOld: ffmpegIsOld(ffmpeg),
        pageFile,
        out: path.resolve(given.out || path.join(SITE, 'static', 'first-install.gif')),
        card: given.card === 'none' ? null : path.resolve(given.card || path.join(SITE, 'static', 'first-install-card.png')),
        stills: given.stills ? path.resolve(given.stills) : null,
        frames: given.frames ? framesFolder(given.frames) : null
    };
}

// Asks ffmpeg for its version: that it is there has to be known before the
// two minutes of recording, not after. Before 5.1 the option that keeps each
// frame's own duration had another name.
function ffmpegIsOld(ffmpeg) {
    let banner;
    try { banner = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (error) {
        if (error.code === 'ENOENT') throw new Error('ffmpeg not found (' + ffmpeg + '): pass --ffmpeg <ffmpeg executable> or set FFMPEG_PATH');
        throw new Error('ffmpeg could not be run (' + ffmpeg + '): ' + String(error.message).split('\n')[0]);
    }
    const version = /^ffmpeg version n?(\d+)\.(\d+)/.exec(banner);          // development builds carry no number: they are new
    return Boolean(version) && (Number(version[1]) < 5 || (Number(version[1]) === 5 && Number(version[2]) < 1));
}

// --frames names a folder of the caller's. It is accepted only if this tool
// can use it without removing anything that is not its own.
function framesFolder(given) {
    const dir = path.resolve(given);
    if (!fs.existsSync(dir)) return dir;
    if (!fs.statSync(dir).isDirectory()) throw new Error('--frames ' + dir + ' is a file');
    const others = fs.readdirSync(dir).filter(name => !ownFrame(name));
    if (others.length) throw new Error('--frames ' + dir + ' holds other things than the frames of an earlier recording (' + others.slice(0, 3).join(', ') + (others.length > 3 ? ', ...' : '') + ').\n       Give a new or empty folder: nothing in this one was touched.');
    return dir;
}

function loadPuppeteer() {
    try { return require('puppeteer-core'); } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        throw new Error('puppeteer-core is not installed where Node looks for it.\n       Install it with "npm install --no-save puppeteer-core" (in the repository or a folder above it; do not commit node_modules).');
    }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function capture(puppeteer, opts, framesDir) {
    const browser = await puppeteer.launch({
        executablePath: opts.chrome,
        headless: true,
        args: ['--window-size=' + W + ',' + H, '--hide-scrollbars', '--force-device-scale-factor=1'],
        defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }
    });
    try {
        const page = await browser.newPage();
        const scenes = [];           // { index, t }: every time the page shows a screen
        let finished = null;
        await page.exposeFunction('__sceneChanged', (index, t) => { scenes.push({ index, t }); });
        await page.exposeFunction('__finished', t => { finished = t; });

        // The page as it is published, but waiting (?autoplay=0) and with the
        // recording view and its keys switched on (?record=1).
        await page.goto(pathToFileURL(opts.pageFile).href + '?autoplay=0&record=1', { waitUntil: 'load' });
        await page.waitForSelector('html[data-player="ready"]', { timeout: 15000 });
        await page.evaluate(() => document.fonts.ready);
        const fonts = await page.evaluate(() => document.fonts.check('800 14px Inter') && document.fonts.check('500 14px "JetBrains Mono"'));
        if (!fonts) console.warn('warning: the web fonts did not load (offline?). The GIF will show the fallback fonts.');

        // H: the recording view. The stage has to fill the window exactly.
        await page.keyboard.press('h');
        await pause(300);
        const box = await page.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); });
        if (box.join() !== [0, 0, W, H].join()) throw new Error('the recording view is ' + box.join(' ') + ' in the window, expected 0 0 ' + W + ' ' + H);

        // Once through every screen in its finished state and back to the first,
        // so each picture and font the screens need is loaded before the
        // recording starts.
        for (let step = 1; step < steps.length; step++) { await page.keyboard.press('ArrowRight'); await pause(250); }
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 });
        for (let step = 1; step < steps.length; step++) { await page.keyboard.press('ArrowLeft'); await pause(60); }
        await pause(400);

        await page.evaluate(() => {
            const counter = document.querySelector('#rail span');
            const play = document.querySelector('#btnPlay');
            let started = false;
            new MutationObserver(() => window.__sceneChanged(parseInt(counter.textContent, 10) - 1, Date.now() / 1000)).observe(counter, { childList: true, characterData: true, subtree: true });
            new MutationObserver(() => {
                if (play.textContent === 'Pause') started = true;
                else if (started && play.textContent === 'Play') window.__finished(Date.now() / 1000);
            }).observe(play, { childList: true, characterData: true, subtree: true });
        });

        const client = await page.createCDPSession();
        const screencast = { format: 'png', everyNthFrame: 1 };
        const frames = [];           // { file, t }
        let count = 0;
        let lastHash = null;
        let recording = true;
        // Chrome skips frames while earlier ones are still unanswered and does
        // not send a skipped frame later. At the end of a movement the last
        // frame received can therefore be a hair short of where the movement
        // ends. So whenever nothing has arrived for a moment the screencast is
        // started again, which makes Chrome send the screen as it is; that
        // frame is kept if it differs from the last one.
        let quiet = null;
        let asked = false;           // the next frame is the answer to such a restart
        const late = { checks: 0, recovered: 0 };
        const askAgain = async () => {
            if (!recording) return;
            asked = true;
            try { await client.send('Page.stopScreencast'); await client.send('Page.startScreencast', screencast); } catch (error) { asked = false; }
        };
        client.on('Page.screencastFrame', event => {
            client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
            const answer = asked;
            asked = false;
            clearTimeout(quiet);
            const data = Buffer.from(event.data, 'base64');
            const hash = crypto.createHash('sha1').update(data).digest('hex');
            if (answer) { late.checks++; if (hash !== lastHash) late.recovered++; }
            if (!(answer && hash === lastHash)) {
                const file = 'f' + String(++count).padStart(5, '0') + '.png';
                fs.writeFileSync(path.join(framesDir, file), data);
                // A frame that had to be asked for was on the screen right after the one before it.
                const last = frames[frames.length - 1];
                frames.push({ file, t: answer && last ? last.t + 1 / 60 : event.metadata.timestamp });
                lastHash = hash;
            }
            if (!answer && recording) quiet = setTimeout(askAgain, 150);
        });
        await client.send('Page.startScreencast', screencast);
        await pause(500);
        await page.keyboard.press('r');          // R: play from the first screen

        const startedAt = Date.now();
        while (finished === null && Date.now() - startedAt < TIME_LIMIT * 1000) await pause(250);
        await pause(400);
        recording = false;
        clearTimeout(quiet);
        await client.send('Page.stopScreencast').catch(() => {});
        if (finished === null) throw new Error('the walkthrough did not reach its end within ' + TIME_LIMIT + ' seconds');
        return { frames, scenes, endT: finished, late };
    } finally {
        await browser.close();
    }
}

// From time-stamped frames to a list of pictures, each with how long it is shown.
function timeline({ frames, scenes, endT }, framesDir) {
    // The walkthrough starts when the first screen is entered after R was pressed.
    const first = scenes.find(scene => scene.index === 0);
    if (!first) throw new Error('the recording never saw the first screen');
    const before = frames.filter(frame => frame.t < first.t);
    // Frames after the end only show the Play button coming back.
    const list = frames.filter(frame => frame.t >= first.t && frame.t <= endT);
    if (before.length) list.unshift({ file: before[before.length - 1].file, t: first.t });
    if (!list.length) throw new Error('no frames were captured');

    // Identical consecutive frames are one frame.
    const sha = frame => crypto.createHash('sha1').update(fs.readFileSync(path.join(framesDir, frame.file))).digest('hex');
    const unique = [];
    let lastHash = null;
    for (const frame of list) {
        const hash = sha(frame);
        if (hash === lastHash) continue;
        unique.push({ ...frame });
        lastHash = hash;
    }
    // Every frame was captured, so a change that lasts one frame (an instant
    // switch of screens) is never missed. Animations are then thinned to about
    // 25 frames a second, always keeping the frame a burst of changes settles on.
    const settled = new Set(unique.filter((frame, i) => i + 1 >= unique.length || unique[i + 1].t - frame.t > 0.1));
    let kept = null;
    const items = unique.filter(frame => {
        if (kept && !settled.has(frame) && frame.t - kept.t < 0.04) return false;
        kept = frame;
        return true;
    });
    for (let i = 0; i < items.length; i++) {
        const next = i + 1 < items.length ? items[i + 1].t : endT;
        items[i].d = Math.max(0.04, Math.min(MAX_HOLD, next - items[i].t));
        const scene = [...scenes].reverse().find(entry => entry.t >= first.t && entry.t <= items[i].t + 0.001);
        items[i].scene = scene ? scene.index : 0;
    }
    return items;
}

function encode(items, opts, framesDir) {
    const listFile = path.join(framesDir, 'frames.txt');
    const quoted = file => "file '" + path.join(framesDir, file).split(path.sep).join('/').replace(/'/g, "'\\''") + "'";
    const lines = [];
    for (const item of items) lines.push(quoted(item.file), 'duration ' + item.d.toFixed(3));
    lines.push(quoted(items[items.length - 1].file));         // the concat format needs the last picture twice
    fs.writeFileSync(listFile, lines.join('\n'));
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    // One palette for the whole film, no dithering, and only the changed rectangle per frame: flat interface colours stay flat and the file stays small.
    const filter = 'scale=' + W + ':-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle';
    // Each picture keeps the duration the list gives it.
    const ownDurations = opts.ffmpegOld ? ['-vsync', 'vfr'] : ['-fps_mode', 'vfr'];
    try {
        execFileSync(opts.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-filter_complex', filter, ...ownDurations, '-loop', '0', opts.out], { stdio: ['ignore', 'inherit', 'inherit'] });
    } catch (error) {
        throw new Error('ffmpeg failed while writing ' + opts.out);
    }
}

(async () => {
    const opts = options(process.argv.slice(2));
    const puppeteer = loadPuppeteer();
    // Only now, with everything the recording needs in place, is a folder made or touched.
    const framesDir = opts.frames || fs.mkdtempSync(path.join(os.tmpdir(), 'first-install-gif-'));
    if (opts.frames) {
        fs.mkdirSync(framesDir, { recursive: true });
        for (const name of fs.readdirSync(framesDir).filter(ownFrame)) fs.rmSync(path.join(framesDir, name));      // the frames of an earlier recording
    }
    try {
        console.log('recording ' + opts.pageFile);
        const recording = await capture(puppeteer, opts, framesDir);
        const items = timeline(recording, framesDir);

        // Every screen must be in the film.
        const last = steps.map((step, index) => items.filter(item => item.scene === index).pop());
        const missing = steps.filter((step, index) => !last[index]).map(step => step.id);
        if (missing.length) throw new Error('these screens are missing from the recording: ' + missing.join(', '));

        encode(items, opts, framesDir);
        const seconds = items.reduce((sum, item) => sum + item.d, 0);
        console.log('wrote ' + opts.out);
        console.log('  ' + items.length + ' frames, ' + seconds.toFixed(1) + ' s, ' + (fs.statSync(opts.out).size / 1024 / 1024).toFixed(2) + ' MB, ' + W + ' px wide');
        console.log('  ' + recording.late.checks + ' still moments checked, ' + recording.late.recovered + ' of them needed their last frame fetched');
        steps.forEach((step, index) => {
            const mine = items.filter(item => item.scene === index);
            console.log('  ' + String(index + 1).padStart(2) + '  ' + step.id.padEnd(14) + mine.reduce((sum, item) => sum + item.d, 0).toFixed(1).padStart(6) + ' s  ' + String(mine.length).padStart(4) + ' frames');
        });

        // The finished state of a screen is the last frame before the next screen.
        if (opts.card) {
            fs.mkdirSync(path.dirname(opts.card), { recursive: true });
            fs.copyFileSync(path.join(framesDir, last[0].file), opts.card);
            console.log('wrote ' + opts.card);
        }
        if (opts.stills) {
            fs.mkdirSync(opts.stills, { recursive: true });
            steps.forEach((step, index) => fs.copyFileSync(path.join(framesDir, last[index].file), path.join(opts.stills, String(index).padStart(2, '0') + '-' + step.id + '.png')));
            console.log('wrote ' + steps.length + ' stills to ' + opts.stills);
        }
    } finally {
        if (!opts.frames) fs.rmSync(framesDir, { recursive: true, force: true });
    }
})().catch(error => {
    console.error('RECORDING FAILED: ' + error.message);
    process.exit(1);
});
