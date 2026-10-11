'use strict';
// The ten screens of the first-install walkthrough, in words.
//
// This is the ONE place the captions are written. The build (build.js in this
// folder) puts them into the page twice: as data for the player, which shows
// them on the stage, and as the list under the player, which is the
// walkthrough for a reader without scripts, a screen reader or a search engine.
//
//   id     names the screen. The player's scenes in template.html carry the same
//          ids in the same order; the build stops if they do not match.
//   title  plain text
//   text   HTML: plain text and <code> only. Title and text are the caption
//          the stage shows.
//
// A screen can say more than its caption. The stage draws that itself; these
// two fields give the same words to the list under the player and to the text
// a small stage gets repeated beneath it, so that a reader who cannot make out
// the stage misses nothing. They have to be the screen's own words: the build
// stops if one of them is not in template.html, letter for letter.
//
//   lines  the lines the screen types out for the reader to copy (plain text;
//          an empty string is an empty line)
//   note   the note the screen shows besides its caption (HTML, <code> only)
//
// The first screen is the title and has no number; the stage numbers the nine
// steps after it 1 to 9, and so does the list.
//
// "Install the pack" (in its note) and "Wear it" (in its text) say that
// new-item packs are new in 1.1.0 and not yet tested in the game. Keep that
// statement in both for as long as it is true.
module.exports = [
    {
        id: 'title',
        title: 'First install',
        text: 'From download to installing your first exported design.',
        note: 'You need a recent FiveM server artifact, a clothing pack you own, and the Cfx.re “Stream Custom Clothing” entitlement on your server key.'
    },
    {
        id: 'download',
        title: 'Download',
        text: 'On the GitHub page press <code>Code</code>, then <code>Download ZIP</code>. Unzip it.'
    },
    {
        id: 'drop-it-in',
        title: 'Drop it in',
        text: 'Copy the <code>cr-clothes</code> folder into your server’s <code>resources</code> folder. That one folder is the whole install.',
        note: 'Only <code>cr-clothes</code> goes on the server. The bot is optional and the docs are for you.'
    },
    {
        id: 'server-cfg',
        title: 'Add these lines to server.cfg',
        text: 'The webhook is where finished packs are announced. The public address is the one players connect to.',
        lines: [
            'ensure cr-clothes',
            'add_ace group.admin command.clothbuilder allow',
            'add_ace group.admin crclothes.admin allow',
            '',
            'set clothdesigner_webhook_url "https://discord.com/api/webhooks/..."',
            'set clothdesigner_public_url  "http://YOUR.SERVER.IP:PORT"'
        ]
    },
    {
        id: 'start',
        title: 'Start the server',
        text: 'One line tells you it is running. Then run <code>clothwebhook_test</code> in the console and open the link it posts in Discord.'
    },
    {
        id: 'add-clothing',
        title: 'Add your clothing',
        text: 'Copy a clothing pack you own into <code>cr-clothes/garments</code> and run <code>crclothes_prepare</code>, then <code>refresh</code> and <code>restart cr-clothes</code>. The pack itself stays installed with its own <code>ensure</code> line.',
        note: 'Hosted server? <code>crclothes_prepare</code> makes a zip instead. <code>clothbake_get</code> prints its link; upload its <code>generated</code> folder into <code>cr-clothes</code>.'
    },
    {
        id: 'design',
        title: 'Design in game',
        text: 'Type <code>/clothdesigner</code>, double-click your garment and design on it. The 3D preview updates as you work. Then press <code>Export clothing pack</code>.'
    },
    {
        id: 'discord',
        title: 'The link lands in your Discord',
        text: 'A message with the 3D preview and a download link back to your own server. The pack itself never leaves it. Download it before you restart.'
    },
    {
        id: 'install-pack',
        title: 'Install the pack',
        text: 'Unzip it and put the pack folder into <code>resources</code>. Add its <code>ensure</code> line below your other clothing packs, restart the server, and join again.',
        note: 'New-item packs are new in 1.1.0 and not yet tested in the game: try one on a test server first. Each installed pack uses one of a few clothing collection slots, so install a few designs, not dozens.'
    },
    {
        id: 'wear-it',
        title: 'Wear it',
        text: 'The pack is built to add your design as a new clothing item. New in 1.1.0 and not yet tested in the game: try one on a test server first.'
    }
];
