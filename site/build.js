'use strict';
// Builds the project site: the pages GitHub Pages serves from the repository's
// docs/ folder.
//
//   node site/build.js                  writes <repository>/docs
//   node site/build.js --out <folder>   writes somewhere else, for a preview
//
// Needs Node and nothing else. The whole site is put together first; only
// when that worked is the output folder emptied and written. Emptied means
// everything in it, subfolders included, except what is kept by hand at its
// top level: the Markdown files (docs/ADMIN-GUIDE.md and its like) and a
// CNAME file. Everything else in docs/ comes from here, so change the sources
// in site/ and build again.
//
// The same sources always give the same files, byte for byte.

const fs = require('node:fs');
const path = require('node:path');

const SITE = __dirname;
const ROOT = path.resolve(SITE, '..');
const RESOURCE = path.join(ROOT, 'cr-clothes');

// Each page of the site is a module that exports build(site). The second
// pass of the documentation site adds its pages here.
const PAGES = [
    './walkthrough/build.js'
];

// What the build never removes from the top level of its output folder.
const keptByHand = name => /\.md$/i.test(name) || name === 'CNAME';
// The front page says which tool made it. That is how a later build knows a
// folder as the output of an earlier one, and so as something it may empty.
const GENERATOR = 'cr-clothes site/build.js';
const generatorTag = '<meta name="generator" content="' + GENERATOR + '">';

// --- helpers --------------------------------------------------------------------

const slashes = file => file.split(path.sep).join('/');
const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function walk(root) {
    const out = [];
    (function visit(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(full);
            else out.push(slashes(path.relative(root, full)));
        }
    })(root);
    return out;
}

// Text sources are read the same way wherever the repository was checked out:
// without a byte-order mark and with LF line ends.
function readText(file) {
    if (!fs.existsSync(file)) throw new Error('missing source file: ' + slashes(path.relative(ROOT, file)));
    const text = fs.readFileSync(file, 'utf8');
    return (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}

// Width and height of a PNG, from its header.
function pngSize(file) {
    const head = fs.readFileSync(file).subarray(0, 24);
    if (head.length < 24 || head.toString('latin1', 1, 4) !== 'PNG' || head.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG file: ' + slashes(path.relative(ROOT, file)));
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

// The tags a page needs for its link preview (Open Graph and Twitter card).
// One preview for the whole site for now, kept in site.config.js.
function socialTags(config, pageUrl) {
    const card = config.card;
    let size;
    try { size = pngSize(path.join(SITE, 'static', card.file)); } catch (error) {
        throw new Error('site/static/' + card.file + ' is missing or not a PNG. It is the picture link previews show; walkthrough/record-gif.js writes it.');
    }
    const picture = config.siteUrl + 'assets/' + card.file;
    const meta = (key, name, content) => '<meta ' + key + '="' + name + '" content="' + escapeHtml(content) + '">';
    return [
        meta('property', 'og:type', 'website'),
        meta('property', 'og:site_name', config.siteName),
        meta('property', 'og:title', card.title),
        meta('property', 'og:description', card.description),
        meta('property', 'og:url', pageUrl),
        meta('property', 'og:image', picture),
        meta('property', 'og:image:type', 'image/png'),
        meta('property', 'og:image:width', String(size.width)),
        meta('property', 'og:image:height', String(size.height)),
        meta('property', 'og:image:alt', card.alt),
        meta('name', 'twitter:card', 'summary_large_image'),
        meta('name', 'twitter:title', card.title),
        meta('name', 'twitter:description', card.description),
        meta('name', 'twitter:image', picture),
        meta('name', 'twitter:image:alt', card.alt)
    ].join('\n');
}

// --- where to --------------------------------------------------------------------

function outputFolder(argv) {
    let out = path.join(ROOT, 'docs');
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out' && argv[i + 1]) out = path.resolve(argv[++i]);
        else throw new Error('usage: node site/build.js [--out <folder>]');
    }
    // The folder is emptied before it is filled, so it must not be one that holds anything else.
    if (inside(out, ROOT)) throw new Error('refusing to build into ' + out + ': that is the repository or a folder around it');
    if (inside(SITE, out)) throw new Error('refusing to build into ' + out + ': that is the site\'s own source folder');
    if (inside(RESOURCE, out)) throw new Error('refusing to build into ' + out + ': that is the cr-clothes resource');
    if (fs.existsSync(out)) {
        if (!fs.statSync(out).isDirectory()) throw new Error('refusing to build into ' + out + ': it is a file');
        // Besides what is kept by hand, the folder may only hold an earlier
        // build: one whose front page names this tool as its maker.
        const strangers = fs.readdirSync(out, { withFileTypes: true }).filter(entry => !(entry.isFile() && keptByHand(entry.name)));
        if (strangers.length && !builtEarlier(out)) {
            throw new Error('refusing to empty ' + out + ': it holds files that no site build put there (' + strangers.slice(0, 3).map(entry => entry.name).join(', ') + '). Empty it yourself or choose another folder.');
        }
    }
    return out;
}

function builtEarlier(out) {
    const mark = path.join(out, '.nojekyll'), front = path.join(out, 'index.html');
    const isFile = file => fs.existsSync(file) && fs.statSync(file).isFile();
    return isFile(mark) && isFile(front) && fs.readFileSync(front, 'utf8').includes(generatorTag);
}

// --- build -------------------------------------------------------------------------

// Puts the whole site together in memory: output path -> content. Nothing on
// disk is changed here, so a build that fails leaves the output folder as it was.
function assemble(config, pages) {
    const files = new Map();
    const add = (relative, content) => {
        if (files.has(relative)) throw new Error('two parts of the build write ' + relative);
        if (!relative.includes('/') && keptByHand(relative)) throw new Error('the build may not write ' + relative + ': at the top of the output folder that name is kept for files written by hand');
        files.set(relative, content);
    };
    // What a page module gets to work with.
    const site = {
        config,
        root: ROOT,
        dir: SITE,
        readText,
        pngSize,
        escapeHtml,
        socialTags: pageUrl => socialTags(config, pageUrl),
        write(relative, content) { add(relative, Buffer.from(content, 'utf8')); },
        copy(source, relative) {
            if (!fs.existsSync(source)) throw new Error('missing source file: ' + slashes(path.relative(ROOT, source)));
            add(relative, fs.readFileSync(source));
        },
        has: relative => files.has(relative)
    };

    // GitHub Pages would otherwise run the folder through Jekyll.
    site.write('.nojekyll', '');

    // site/static/ is copied as it is; the logo is the product's own.
    const staticDir = path.join(SITE, 'static');
    for (const relative of walk(staticDir)) site.copy(path.join(staticDir, relative), 'assets/' + relative);
    site.copy(path.join(RESOURCE, 'web', 'img', 'logo.png'), 'assets/logo.png');

    for (const page of pages) page(site);

    const front = interimIndex(config, site);
    if (!front.includes(generatorTag)) throw new Error('the front page has to carry ' + generatorTag + ': it is how the next build knows this one\'s output');
    site.write('index.html', front);
    return files;
}

// Empties the output folder of everything but what is kept by hand, then writes the site.
function replace(out, files) {
    fs.mkdirSync(out, { recursive: true });
    for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
        if (entry.isFile() && keptByHand(entry.name)) continue;
        fs.rmSync(path.join(out, entry.name), { recursive: true, force: true });
    }
    for (const [relative, content] of files) {
        const file = path.join(out, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
}

// The front page, until the site has one: it passes visitors on to the walkthrough.
// A link to the site's address shows the walkthrough's preview, since that is where it leads.
function interimIndex(config, site) {
    const to = 'first-install/';
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>' + escapeHtml(config.siteName) + '</title>',
        '<meta name="description" content="cr-clothes is a free, open-source in-game clothing designer for FiveM. The first-install walkthrough shows the whole install, one screen at a time.">',
        generatorTag,
        '<link rel="canonical" href="' + escapeHtml(config.siteUrl + to) + '">',
        '<meta http-equiv="refresh" content="0; url=' + to + '">',
        '<meta name="theme-color" content="#06080d">',
        '<link rel="icon" type="image/png" href="assets/favicon.png">',
        site.socialTags(config.siteUrl + to),
        '<script>',
        '/* Opened from a folder on disk, "' + to + '" would list the folder: name the page. */',
        'if (location.protocol === \'file:\') location.replace(\'' + to + 'index.html\');',
        '</script>',
        '<style>',
        ':root { color-scheme: dark; }',
        'html, body { height: 100%; }',
        'body { margin: 0; display: grid; place-items: center; background: #06080d; color: #f4f7ff; font: 400 16px/1.5 Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif; }',
        'main { padding: 24px; text-align: center; }',
        'img { display: block; width: 72px; height: 72px; margin: 0 auto 12px; }',
        'h1 { margin: 0 0 6px; font-size: 32px; line-height: 1.2; font-weight: 800; letter-spacing: -0.02em; }',
        'p { margin: 0; color: #b6c0d6; }',
        'a { color: #9db0ff; font-weight: 600; text-underline-offset: 3px; }',
        'a:focus-visible { outline: 2px solid #9db0ff; outline-offset: 3px; border-radius: 3px; }',
        '</style>',
        '</head>',
        '<body>',
        '<main>',
        '<img src="assets/logo.png" alt="" width="72" height="72">',
        '<h1>' + escapeHtml(config.siteName) + '</h1>',
        '<p>Continue to the <a href="' + to + '">first-install walkthrough</a>.</p>',
        '</main>',
        '</body>',
        '</html>',
        ''
    ].join('\n');
}

// --- run ---------------------------------------------------------------------------

try {
    // The sources are loaded here, not at the top, so that a missing or broken
    // one is reported like every other failure of the build.
    const config = require('./site.config.js');
    const pages = PAGES.map(file => require(file));
    const out = outputFolder(process.argv.slice(2));
    const files = assemble(config, pages);
    replace(out, files);

    const written = [...files.keys()].sort();
    const size = bytes => (bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1024 / 1024).toFixed(2) + ' MB');
    const width = Math.max(...written.map(relative => relative.length));
    console.log('site built at ' + out);
    written.forEach(relative => console.log('  ' + relative.padEnd(width) + '  ' + size(files.get(relative).length).padStart(9)));
    console.log('  ' + written.length + ' files, ' + size(written.reduce((sum, relative) => sum + files.get(relative).length, 0)));
} catch (error) {
    // A source that is missing or does not parse is thrown by Node itself:
    // its first line says which file, the rest is a stack nobody needs here.
    const message = String(error && error.message ? error.message : error).split('\n')[0];
    const where = error instanceof SyntaxError && error.stack ? ' (' + slashes(path.relative(ROOT, String(error.stack).split('\n')[0])) + ')' : '';
    console.error('SITE BUILD FAILED: ' + message + where);
    process.exit(1);
}
