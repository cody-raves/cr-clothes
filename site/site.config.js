'use strict';
// The constants every page of the site needs, in one place.
//
// GitHub Pages serves the repository's docs/ folder at siteUrl. Inside the
// pages every local link is relative, so the site also works under another
// folder or opened straight from disk; siteUrl is used only where an address
// has to be absolute (canonical links and the pictures of link previews).

const siteUrl = 'https://cody-raves.github.io/cr-clothes/';          // with the closing slash
const repoUrl = 'https://github.com/cody-raves/cr-clothes';         // without

module.exports = {
    siteName: 'cr-clothes',
    siteUrl,
    repoUrl,
    // The admin guide is a Markdown file in the repository for now; when it
    // becomes a page of the site, this is the one line to change.
    adminGuideUrl: repoUrl + '/blob/main/docs/ADMIN-GUIDE.md',
    // The link preview (Open Graph and Twitter card). There is one for the
    // whole site for now: the walkthrough's, which the front page shows as
    // well for as long as it only passes visitors on. The picture is a file in
    // site/static/ (so it ends up in docs/assets/): the finished first screen
    // of the walkthrough, written by walkthrough/record-gif.js.
    card: {
        file: 'first-install-card.png',
        title: 'cr-clothes: first-install walkthrough',
        description: 'From download to installing your first exported design, in ten screens you can play or step through at your own pace.',
        alt: 'The first screen of the walkthrough: the cr-clothes logo above the steps Download, Drop it in, server.cfg, Start, Add clothing, Design, Get the pack, Install it and Wear it.'
    }
};
