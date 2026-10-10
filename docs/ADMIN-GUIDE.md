# cr-clothes admin guide

Everything a server owner needs: install, add clothing, decide who may design,
get the finished packs, and (only if you want to) sell design rights on your
own store.

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [1. Install](#1-install)
- [2. Choose how packs reach you](#2-choose-how-packs-reach-you)
- [3. Add your clothing](#3-add-your-clothing)
- [4. Decide who may design](#4-decide-who-may-design)
- [5. Selling design rights (optional)](#5-selling-design-rights-optional)
- [What players do](#what-players-do)
- [Installing a finished pack](#installing-a-finished-pack)
- [Command reference](#command-reference)
- [Settings reference](#settings-reference)
- [Hosted servers](#hosted-servers)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

---

## How it works

Everything happens on your own server.

1. A player opens the designer in game and paints on a garment's real UV map,
   watching the result on a live 3D preview.
2. They press **Export clothing pack**. Your server bakes the design into the
   garment's texture and builds an installable clothing resource.
3. The pack is saved on your server and a download link is posted to your
   Discord.
4. You install the pack like any other clothing resource.

No website, no outside bake service, no account, no store in the middle.

## Requirements

- A FiveM server on a recent artifact (the resource uses the Node 22 runtime).
- The Cfx.re "Stream Custom Clothing" entitlement on your server key, as
  with any clothing pack.
- Clothing you have the right to use and modify. **cr-clothes ships with no
  garments** — you add your own.
- Optional: a Discord channel webhook, for delivery.
- Optional: `oxmysql`, to keep design rights in your database. Without it they
  are kept in FiveM's built-in key-value store.

Works with Qbox, qb-core, ESX, or no framework at all.

---

## 1. Install

1. Copy the `cr-clothes` folder into your server's `resources/` folder.
2. Add to `server.cfg`:

   ```cfg
   ensure cr-clothes
   add_ace group.admin command.clothbuilder allow
   add_ace group.admin crclothes.admin allow
   ```

3. Start the server. You should see one line:

   ```
   [cr-clothes] v1.1.0 ready | garments: 0 (0 exportable) | delivery: download only (clothbake_get) | design rights: grants (oxmysql) | framework: qb | packs: /tmp/clothdesigner
   ```

   That line is the whole health check: how many garments are installed, how
   packs are delivered, how design rights are stored, which framework was
   detected, and where packs are written.

The two `add_ace` lines give your admins the designer without needing a grant
(`command.clothbuilder`) and the grant commands in game (`crclothes.admin`).

## 2. Choose how packs reach you

| Option | You run | You get |
|---|---|---|
| **Download only** | nothing | `clothbake_get` in the console prints the links |
| **Discord webhook** (recommended) | nothing | A message in your channel with the 3D preview and a download link |
| **Discord bot** | the bot in `clothdesigner-bot/` | Cards with buttons and file hosting on the bot's machine |

### Discord webhook

1. In Discord: channel settings → Integrations → Webhooks → New Webhook → copy
   the URL.
2. Add to `server.cfg`:

   ```cfg
   set clothdesigner_webhook_url "https://discord.com/api/webhooks/..."
   set clothdesigner_public_url  "http://YOUR.SERVER.IP:PORT"
   ```

   `clothdesigner_public_url` is the address **players connect to** — your
   public IP and game port. FiveM serves web requests on the game port, so no
   extra port needs opening. Do not use `127.0.0.1`: the link would only work
   on the server itself.

3. Restart, then test from the server console:

   ```
   clothwebhook_test
   ```

   A test message should arrive. Open its link from a device that is not on
   your network (a phone on mobile data) to confirm the address is reachable.

The pack never leaves your server. Discord only receives a link back to it.
Each link contains a random id, and with a webhook configured the folder
listing is switched off, so a pack can only be downloaded by someone who has
its link.

### Discord bot

See [`clothdesigner-bot/README.md`](../clothdesigner-bot/README.md). The bot is
optional and can run alongside the webhook.

## 3. Add your clothing

Put clothing packs you own into `cr-clothes/garments/` and run, in the server
console:

```
crclothes_prepare
```

Drop in the whole unzipped pack. Both common layouts are understood, and files
that are not clothing are ignored. Run `crclothes_prepare dry` first to see
what would be registered without changing anything.

For each garment this registers it in the catalogue and reads its 3D mesh out
of the pack's own `.ydd`, which becomes the live preview and the UV guide in
the designer. No other tools are needed.

Then load the result:

```
refresh
restart cr-clothes
```

Three things to know:

- **Keep the pack running.** Preparing makes a garment designable; the game
  still loads the model from the pack itself. Keep `ensure <that pack>` in
  `server.cfg`.
- **Leave the files in `garments/`.** Exports read the pack's model and
  textures from there. They are only read, never changed.
- **Names are guessed** from the collection and drawable number. Rename them
  in `generated/registry.json` — `displayName` is what players see.

Full details, including the two folder layouts:
[`cr-clothes/garments/README.md`](../cr-clothes/garments/README.md).

## 4. Decide who may design

Set in `cr-clothes/config.lua`:

```lua
Config.OpenDesign = false
```

| Value | Who can export a design |
|---|---|
| `true` | Everyone. A free creative tool for the whole server. |
| `false` (default) | Admins, plus anyone holding a *design right* |

Design rights are given to a player, a job or a gang:

```
crclothes_grant 12 * 1                 one design for the player with server id 12
crclothes_grant license:abc123 * 5     five designs for that player, online or not
crclothes_grant job:police * -1        the police job, unlimited
crclothes_grant gang:ballas * -1       a gang, unlimited
crclothes_revoke job:police            take it back
crclothes_grants                       list every right
```

A right is used up each time its holder exports a design; `-1` never runs out.
The second argument limits a right to one garment (use a garment's id from
`generated/registry.json`) or `*` for any.

`Config.DesignRequiresBoss = true` limits job and gang rights to bosses and
leaders, so a police chief can design department uniforms but a cadet cannot.

## 5. Selling design rights (optional)

cr-clothes has no store and takes no cut. If you want to charge for designs,
you sell them on **your own** store, at your price, and keep all of it. If you
do not want to sell anything, skip this section — nothing depends on it.

Any store that can run a console command on your server after a purchase
works. For Tebex, add this to a package's commands:

```
crclothes_grant {id} * 1
```

and this to its refund or chargeback commands:

```
crclothes_revoke {id}
```

Step-by-step, including bundles, subscriptions and testing a purchase:
[`cr-clothes/TEBEX.md`](../cr-clothes/TEBEX.md).

Other resources can grant rights too — an in-game shop, a reward, an item:

```lua
exports['cr-clothes']:GrantDesign('player:license:abc123', '*', 1, 'my-shop')
exports['cr-clothes']:RevokeDesign('player:license:abc123')
exports['cr-clothes']:CanDesign(source, '*')
exports['cr-clothes']:GetGrants(source)

AddEventHandler('cr-clothes:designExported', function(data)
    -- data.player, data.slotId, data.packName, data.mode
    -- data.collection: the new item's collection name (nil for a replacement pack)
end)
```

---

## What players do

1. `/clothdesigner` opens the garment browser.
2. Pick a gender and category, then double-click a garment.
3. Design: fill colour, text, freehand drawing, images from approved sites.
   The 3D preview updates as they work.
4. **View on my character** hides the designer to look at the design on their
   own character. ESC or BACKSPACE returns to it. Only they see this.
5. **Export clothing pack** bakes it and delivers it to you.

The chat command is `Config.Command` in `config.lua`.

## Installing a finished pack

1. Download the zip from the link and unzip it.
2. Put the pack folder into `resources/`.
3. Add `ensure <pack folder name>` to `server.cfg`, below your other clothing
   packs. A pack that starts before them can shift the item numbers some
   outfit scripts have saved.
4. Restart the server.

**New in 1.1.0 and not yet tested in the game.** The packs described here
have only been checked offline; none has been loaded in the game yet. Try one
exported pack on a test server before you install packs on a live one. If the
new item does not show up, see [Troubleshooting](#troubleshooting).

Each pack adds one new clothing item in a collection of its own. The message
the player sees in game after exporting names it, for example
`mp_f_cd_3f9a1c0b7e2d`. So do the Discord message of the webhook and the
`pack-manifest.json` inside the pack. The pack is built so that the new item
sits beside the garment it was designed on and beside other designs, and
nothing is replaced. It makes no difference whether the original pack came
with a `.ymt`: the exported pack brings its own.

The pack carries the garment's model and the design as its one texture. The
design replaces the whole texture; nothing of the original shows through. In
a default pack it makes no difference which texture slot the player picked in
the designer. With `clothdesigner_export_textures all` the design takes the
place of the picked slot.

Two things to know:

- Each installed pack that adds a new item uses one clothing collection slot,
  and a server only has a few. Read [Known limits](#known-limits) before
  installing many.
- A design on a prop (hat, glasses, earpiece, watch, bracelet) is the
  exception: it exports as a pack that replaces the texture of the existing
  prop. The message in game says so, and the webhook's Discord message
  carries the same note. See `clothdesigner_prop_addon` in the settings
  reference.

---

## Command reference

Server console unless noted.

| Command | What it does |
|---|---|
| `/clothdesigner` (chat) | Opens the designer |
| `crclothes_prepare [dry]` | Registers the clothing in `garments/` |
| `crclothes_grant <who> [garment] [uses]` | Gives a design right |
| `crclothes_revoke <who> [garment]` | Removes one |
| `crclothes_grants [who]` | Lists rights |
| `clothwebhook_test` | Posts a test message to your webhook |
| `clothbake_get` | Prints download links for the packs on the server |

The three `crclothes_grant…` commands also work in game for anyone with the
`crclothes.admin` ACE.

## Settings reference

`server.cfg`:

| Setting | Purpose |
|---|---|
| `clothdesigner_webhook_url` | Discord webhook that receives pack links |
| `clothdesigner_public_url` | Address players connect to; used to build links |
| `clothdesigner_bot_url`, `clothdesigner_bot_token` | Optional Discord bot |
| `clothdesigner_export_textures all` | Packs carry every texture of the garment, with the design in the slot the player picked. Default: the design only |
| `clothdesigner_prop_addon true` | Designs on props export as new items, like clothing. Default: they export as a replacement of the prop's texture. Not yet tested in game |
| `clothdesigner_ymt_layout ragelib` | If a new item does not show up in game with the default, set this, export the design again and install the new pack. It writes the pack's `.ymt` (the file that describes the item to the game) in the arrangement used by the two packs this project has seen load in game. The default arrangement has not been loaded in the game yet |
| `clothdesigner_export_mode replace` | Every design exports as a replacement of the original garment's texture instead of a new item. A replacement pack is not a collection and uses no collection slot; it needs the same entitlement |
| `clothdesigner_debug true` | Detailed startup and export logging |

The four export settings are read at every export, so a `set` typed in the
server console applies to the next one. Any other value means the default.

`config.lua`:

| Setting | Purpose |
|---|---|
| `Config.Command` | Chat command that opens the designer |
| `Config.OpenDesign` | `true` lets everyone design |
| `Config.DesignRequiresBoss` | Job and gang rights apply to bosses only |
| `Config.AllowedImageHosts` | Sites players may load image layers from |
| `Config.MaxTextLength` | Longest text layer |

---

## Hosted servers

Game-server hosts usually make the resource folder read-only to the running
server. cr-clothes is built for that:

- Baked packs are written to `/tmp/clothdesigner`, not into the resource.
  That is a temporary folder: expect it to be emptied when the server
  restarts, and download packs before you restart.
- `crclothes_prepare` cannot write into the resource either. It puts everything
  into one zip instead and tells you so. Run `clothbake_get` for the link,
  unzip it, and upload its `generated` folder into `cr-clothes/` with your
  host's file manager. Then `refresh` and `restart cr-clothes`.

On your own machine or a VPS, `crclothes_prepare` writes straight into the
resource and nothing needs re-uploading. Packs go to `/tmp/clothdesigner` on
Linux and to `cr-clothes/output/` on Windows; the startup line shows which.
The Windows folder is not cleaned up automatically, so delete old packs when
you no longer need them.

## Troubleshooting

**The designer says no garments are installed.**
You have not added clothing yet. See [Add your clothing](#3-add-your-clothing).
If you ran `crclothes_prepare`, did you `refresh` and restart afterwards?

**The Discord link will not open.**
Check that it starts with your server's public address. If it starts with
`127.0.0.1`, fix `clothdesigner_public_url` and restart. If the address is
right, the server may have restarted since the export (hosted servers lose
packs on restart).

**A garment shows in the designer but not on the character.**
The clothing pack it came from is not running. Add `ensure <that pack>`.

**Export says the player is not allowed.**
`Config.OpenDesign` is `false` and they have no design right. Grant one, or
check `crclothes_grants`.

**A garment has no 3D preview.**
Its `.ydd` could not be read. `crclothes_prepare` prints the reason next to
that garment. It can still be designed on with the flat preview.

**`crclothes_prepare` says assets were not recognised.**
The files do not follow the clothing naming convention
(`<collection>^<part>_<number>_u.ydd`). They are probably not ped clothing.

**A new item from an exported pack does not show up in game.**
Check that the pack's `ensure` line is in `server.cfg`, that the server was
restarted, and that you joined after the restart. Check that your other
clothing packs work: a pack needs the clothing entitlement on the server key.
If all of that holds, `set clothdesigner_ymt_layout ragelib`, export the
design again and install the new pack. New-item packs are new in 1.1.0 and
have not been tested in the game yet.

**I need more detail.**
`set clothdesigner_debug true` in `server.cfg`, restart, and read the console.

## Known limits

- **New-item packs are not yet tested in the game.** Since 1.1.0 every design
  on clothing exports as a pack of a new kind, with a `.ymt` that cr-clothes
  writes itself. These packs have been checked offline only. Test one before
  relying on them.
- **Each installed pack uses one clothing collection slot.** Every pack that
  adds a new item is a clothing collection of its own, and the player model
  has room for only a small number of them: roughly 3 to 8 per gender
  depending on the game build, shared with every other clothing pack on the
  server. Going over the limit crashes that gender's player model for
  everyone. Install a few designs per gender, not dozens, and count your other
  clothing packs too. A pack that replaces a texture (a prop, or any design
  with `clothdesigner_export_mode replace`) is not a collection and uses no
  slot. On FiveM for GTA V Enhanced a FiveM maintainer has said that no slots
  are free at all: new items do not load there, replacements do. A way to
  merge several designs into one collection is planned.
- **Props export as a replacement.** A design on a hat, glasses, an earpiece,
  a watch or a bracelet exports as a pack that replaces the texture of the
  existing prop. The message in game and the webhook's Discord message say
  so. `crclothes_prepare` notes it next to each prop.
  `set clothdesigner_prop_addon true` makes props export as new items like
  clothing; that has not been tested in game yet.
- **A garment the new-item form cannot describe exports as a replacement.**
  This applies to a texture whose name ends in a race suffix the game's own
  files do not use. The pack then replaces that garment's texture, and the
  message says why.
- **One texture per pack.** A pack carries the design; the garment's original
  textures stay in the original pack. `set clothdesigner_export_textures all`
  ships every texture of the garment instead, with the design in the slot the
  player picked.
- **A new item is described by the garment's file names only.** Whatever else
  the original pack's `.ymt` said about that garment (heel height, hair
  fitting, sounds) is not carried over, and alternate meshes and cloth physics
  files are not copied.
