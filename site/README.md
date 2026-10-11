# site/

The source of the project site. GitHub Pages serves the repository's `docs/`
folder at <https://cody-raves.github.io/cr-clothes/>, and this folder is what
`docs/` is built from.

## Rebuild

```
node site/build.js
```

Node is all it needs. `node site/build.js --out <folder>` builds somewhere
else, for a preview. The same sources always give the same files.

## What is generated

Everything in `docs/` except what is kept by hand at its top level: the
Markdown files (`docs/ADMIN-GUIDE.md`) and a `CNAME` file, if the site ever
gets a domain of its own. The build puts the whole site together first. Only
when that worked does it empty the rest of the folder, subfolders included,
and write it again; a build that fails leaves `docs/` as it was. So never edit
the generated files and never keep anything of your own in a subfolder of
`docs/`: change the source here and rebuild.

| Output | Source |
|---|---|
| `docs/index.html` | `build.js` (for now a page that passes visitors on to the walkthrough) |
| `docs/first-install/` | `walkthrough/` |
| `docs/assets/` | `static/`, copied as it is, and the logo from `cr-clothes/web/img/` |
| `docs/.nojekyll` | `build.js` |

`site.config.js` holds the addresses every page uses and the link preview
(title, text and picture) that both pages carry. `static/favicon.png` is the
logo on a dark tile: the logo itself is white on nothing and would vanish on a
light tab strip.

## The walkthrough

- `walkthrough/template.html` is the page: its styles, the ten screens and
  the player.
- `walkthrough/steps.js` holds the words of the ten screens: the caption of
  each and, where a screen says more than its caption, the lines it types and
  its note. The player and the written list under it are both made from this
  one file. The first screen is the title; the nine steps after it are
  numbered 1 to 9, on the stage and in the list.
- The "Design in game" screen shows the real designer. Its markup and style
  sheet are read from `cr-clothes/web/` at build time, so the screen follows
  the product. The style sheet's media queries and window units are settled
  for the size the designer is drawn at, so the screen looks the same in every
  browser window; the build stops at one it does not know.
- The pictures in `walkthrough/assets/` are pictures of the designer in use.

Addresses:

- `#step-1` to `#step-10` open a screen, paused. The numbers are the ones on
  the dots under the stage: `#step-1` is the title screen, `#step-4` the
  screen of step 3.
- `?autoplay=0` keeps the page from playing by itself.
- `?embed=1` shows the stage and its buttons only, for an `<iframe>`. The
  player fits itself into the frame: the buttons in a row at the bottom and
  the stage as large as the height above them allows. In a frame shaped 16:9
  the stage is a little narrower than the frame; make the frame about 40
  pixels taller than that (50 where it is used by touch) and the stage fills
  its width. Where the row has no room for the ten dots they are left out. It
  does not play by itself unless the address also says `&autoplay=1`.
- `?record=1` switches on the recording view and its keys (below).

## Recording the GIF

`static/first-install.gif` (the picture at the top of the repository's README)
and `static/first-install-card.png` (the picture link previews show) are
recorded from the built page:

```
node site/build.js
node site/walkthrough/record-gif.js --chrome <path to Chrome>
node site/build.js
```

The recorder is optional and the build never runs it. It needs
[puppeteer-core](https://www.npmjs.com/package/puppeteer-core)
(`npm install --no-save puppeteer-core`; do not commit `node_modules`), a
Chrome or Chromium, and ffmpeg (`--ffmpeg <path>` if it is not on the `PATH`).
It looks for all three before it records or writes anything. It was written
for ffmpeg 5.1 or newer; with an older one it uses that version's name for the
same option, which has not been tried. `--stills <folder>` also writes the
finished state of each screen, and `--frames <folder>` keeps the captured
frames: that folder has to be new, empty, or hold only the frames of an
earlier recording. The options are listed at the top of the script.

Two keys exist for recording. They work only when the page was opened with
`?record=1`, so a letter typed on the published page never does anything:

- **H** switches the recording view on and off: the stage alone, filling the
  window, with no buttons and no pointer. **Esc** leaves it as well.
- **R** plays from the first screen.

To record by hand instead, open the page with `?autoplay=0&record=1`, press
H, make the window full screen, start a screen recorder and press R.
