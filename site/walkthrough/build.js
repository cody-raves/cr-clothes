'use strict';
// Builds the first-install walkthrough: <out>/first-install/index.html and the
// pictures next to it. Called by site/build.js.
//
// The page is template.html of this folder, with these put in:
//   - the designer's real markup and style sheet, read from cr-clothes/web/
//     at build time. The player mounts them in a shadow root (so the
//     designer's styles cannot reach the page) for the "Design in game"
//     screen, which therefore always shows the product as it is now;
//   - the words of the ten screens from steps.js, twice: as data for the
//     player and as the written list under it;
//   - the addresses and the link preview from site.config.js.
// The pictures in assets/ are copied to <out>/first-install/img/.

const path = require('node:path');
const steps = require('./steps.js');

const HERE = __dirname;
const PAGE = 'first-install';
// Name in the page's data -> file in assets/. All of them are pictures of the
// designer in use: its 3D preview, the texture of the example design, the UV
// guide it draws over that texture, and the Garment Browser's two renders.
const PICTURES = {
    preview: 'preview.png',
    texture: 'texture.png',
    uvGuide: 'uv-guide.png',
    browserMain: 'browser-main.png',
    browserThumb: 'browser-thumb.png'
};
// The designer is drawn on the stage as a picture of a 1440 x 810 game window
// (VW and VH in template.html's mountDesigner).
const DESIGNER = { width: 1440, height: 810 };

// A shadow root keeps the designer's styles away from the page, but the style
// sheet still answers to the visitor's browser window: its media queries ask
// for the window's width and its vw and vh lengths are parts of the window.
// Left alone, the designer on the stage would be laid out differently in every
// window narrower than its widest breakpoint. So both are settled here, once,
// for the window the designer is drawn as. A media query or a window unit this
// does not know stops the build, so a new one in the product cannot bring the
// problem back unnoticed.
function settleForWindow(css, size) {
    let out = css.replace(/@media\s*\(\s*(max|min)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g, (whole, bound, px) => {
        const applies = bound === 'max' ? size.width <= Number(px) : size.width >= Number(px);
        return applies ? '@media all' : '@media not all';
    });
    out = out.replace(/(?<![\w.#-])(\d*\.?\d+)(vw|vh)\b/g, (whole, number, unit) => +(Number(number) * (unit === 'vw' ? size.width : size.height) / 100).toFixed(3) + 'px');
    const left = [
        ...(out.match(/@media[^{;]*/g) || []).map(query => query.trim()).filter(query => query !== '@media all' && query !== '@media not all'),
        ...(out.match(/(?<![\w.#-])\d*\.?\d+(?:[sld]?v(?:w|h|i|b|min|max))\b/g) || [])
    ];
    if (left.length) throw new Error('walkthrough: cr-clothes/web/style.css has something that depends on the browser window and that walkthrough/build.js cannot settle for the stage: ' + [...new Set(left)].slice(0, 5).join(', '));
    return out;
}

module.exports = function buildWalkthrough(site) {
    const { config } = site;
    const web = path.join(site.root, 'cr-clothes', 'web');
    const html = site.readText(path.join(web, 'index.html'));
    const css = site.readText(path.join(web, 'style.css'));
    let page = site.readText(path.join(HERE, 'template.html'));

    // ---- the designer, from the product
    // Greedy on purpose: the Garment Browser's preview pane is a <main> of its own
    // inside <main id="app">, so the first "</main>" is not the end of the designer.
    const main = /<main id="app"[\s\S]*<\/main>/.exec(html);
    if (!main) throw new Error('walkthrough: <main id="app"> not found in cr-clothes/web/index.html');
    const swap = (text, from, to) => {
        if (!text.includes(from)) throw new Error('walkthrough: cr-clothes/web/index.html no longer contains ' + from);
        return text.split(from).join(to);
    };
    let designerHtml = main[0];
    designerHtml = swap(designerHtml, 'class="app is-hidden" aria-hidden="true"', 'class="app" aria-hidden="false"');     // the product starts hidden and shows itself on /clothdesigner
    designerHtml = swap(designerHtml, 'src="img/logo.png"', 'src="../assets/logo.png"');
    // Inside a shadow root the document root is the host element.
    const designerCss = settleForWindow(css, DESIGNER).split(':root').join(':host');
    if (!page.includes('const VW = ' + DESIGNER.width + ', VH = ' + DESIGNER.height + ';')) throw new Error('walkthrough: template.html no longer draws the designer at ' + DESIGNER.width + ' x ' + DESIGNER.height + '; DESIGNER in walkthrough/build.js has to say the same size');

    // ---- the words of the screens: one list, used twice
    if (!Array.isArray(steps) || !steps.length) throw new Error('walkthrough: steps.js exports no steps');
    const onlyCode = text => !/<(?!\/?code>)/.test(text);
    for (const step of steps) {
        if (!/^[a-z0-9-]+$/.test(step.id || '') || typeof step.title !== 'string' || typeof step.text !== 'string') throw new Error('walkthrough: a step in steps.js needs an id, a title and a text');
        if (!onlyCode(step.text)) throw new Error('walkthrough: the text of step "' + step.id + '" may contain <code> and no other markup');
        // What a screen says besides its caption has to be what the stage really shows there.
        if (step.note !== undefined) {
            if (typeof step.note !== 'string' || !step.note || !onlyCode(step.note)) throw new Error('walkthrough: the note of step "' + step.id + '" has to be text that may contain <code> and no other markup');
            if (!page.includes(step.note)) throw new Error('walkthrough: the note of step "' + step.id + '" in steps.js is not what its screen in template.html says, word for word');
        }
        if (step.lines !== undefined) {
            if (!Array.isArray(step.lines) || !step.lines.length || step.lines.some(line => typeof line !== 'string' || /[\r\n]/.test(line))) throw new Error('walkthrough: the lines of step "' + step.id + '" have to be a list of single lines of text');
            for (const line of step.lines) {
                if (line && !page.includes('\'' + line + '\'')) throw new Error('walkthrough: step "' + step.id + '" in steps.js lists the line ' + JSON.stringify(line) + ', which its screen in template.html does not type');
            }
        }
    }
    // The player's scenes (template.html) are matched to the captions by id.
    const sceneIds = [...page.matchAll(/^ {12}id: '([a-z0-9-]+)',$/gm)].map(match => match[1]);
    const stepIds = steps.map(step => step.id);
    if (sceneIds.join(' ') !== stepIds.join(' ')) throw new Error('walkthrough: the scenes in template.html (' + sceneIds.join(', ') + ') and the steps in steps.js (' + stepIds.join(', ') + ') do not match');

    // The list is plain text: the player makes each heading a link to its screen
    // when it starts, so without the player there are no links that lead nowhere.
    // Numbered as on the stage: the first screen is the title, the steps are 1 to 9.
    const indent = ' '.repeat(16);
    const stepList = steps.map((step, index) => {
        const rows = [
            indent + '<li' + (step.lines ? ' class="step-wide"' : '') + '>',
            indent + '    <h3>' + (index ? '<span class="step-number">' + index + '</span> ' : '') + '<span class="step-name">' + site.escapeHtml(step.title) + '</span></h3>',
            indent + '    <p>' + step.text + '</p>'
        ];
        // No line break between the tags and the lines: inside <pre> it would show.
        if (step.lines) rows.push(indent + '    <pre class="step-lines" tabindex="0"><code>' + step.lines.map(site.escapeHtml).join('\n') + '</code></pre>');
        if (step.note) rows.push(indent + '    <p class="step-note">' + step.note + '</p>');
        rows.push(indent + '</li>');
        return rows.join('\n');
    }).join('\n');

    // ---- the pictures
    const data = { logo: '../assets/logo.png' };
    for (const [name, file] of Object.entries(PICTURES)) {
        site.copy(path.join(HERE, 'assets', file), PAGE + '/img/' + file);
        data[name] = 'img/' + file;
    }
    // Every picture the page's data names has to be a file this build writes.
    for (const [name, address] of Object.entries(data)) {
        const target = path.posix.normalize(PAGE + '/' + address);
        if (!site.has(target)) throw new Error('walkthrough: the page\'s data names the picture ' + address + ' (' + name + '), but the build writes no ' + target);
    }

    // ---- put together
    const values = {
        PAGE_URL: config.siteUrl + PAGE + '/',
        REPO_URL: config.repoUrl,
        ADMIN_GUIDE_URL: config.adminGuideUrl
    };
    // These two are HTML and go in last; the others are text.
    const blocks = {
        SOCIAL_TAGS: site.socialTags(values.PAGE_URL),
        STEP_LIST: stepList
    };
    page = page.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => {
        if (name in blocks) return whole;
        if (!(name in values)) throw new Error('walkthrough: template.html asks for {{' + name + '}}, which the build does not know');
        return site.escapeHtml(values[name]);
    });
    for (const [name, block] of Object.entries(blocks)) {
        if (page.split('{{' + name + '}}').length !== 2) throw new Error('walkthrough: template.html has to have {{' + name + '}} exactly once');
        page = page.replace('{{' + name + '}}', () => block);
    }

    data.steps = steps.map(step => {
        const entry = { id: step.id, title: step.title, text: step.text };
        if (step.lines) entry.lines = step.lines;
        if (step.note) entry.note = step.note;
        return entry;
    });
    data.designerHtml = designerHtml;
    data.designerCss = designerCss;
    // The data sits in a script block: no "<" may be left in it as it is
    // ("</script>" would end the block, "<!--" would change how it is read).
    // (The two line separators JSON allows inside a string are written as escapes as well.)
    const json = JSON.stringify(data).replace(/</g, '\\u003c')
        .split(String.fromCharCode(0x2028)).join('\\u2028')
        .split(String.fromCharCode(0x2029)).join('\\u2029');
    if (!page.includes('/*__DATA__*/{}')) throw new Error('walkthrough: template.html has no place for the data');
    page = page.replace('/*__DATA__*/{}', () => json);

    site.write(PAGE + '/index.html', page);
};
