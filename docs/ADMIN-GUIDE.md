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
   [cr-clothes] v1.0.0 ready | garments: 0 (0 exportable) | delivery: download only (clothbake_get) | design rights: grants (oxmysql) | framework: qb | packs: /tmp/clothdesigner
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
- **Leave the files in `garments/`.** Exports read the pack's textures from
  there. They are only read, never changed.
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
3. Add `ensure <pack folder name>` to `server.cfg`.
4. Restart the server.

The design is baked into the first texture slot of the garment unless the
player chose another slot.

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
| `clothdesigner_debug true` | Detailed startup and export logging |

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

**I need more detail.**
`set clothdesigner_debug true` in `server.cfg`, restart, and read the console.

## Known limits

- **Packs without a `.ymt` export as a replacement.** A full clothing pack
  includes its collection's `.ymt`, and designs on its garments export as a new
  addon item. A single item split out of a larger pack usually has none;
  designs on it export as a pack that replaces that garment's texture.
  `crclothes_prepare` says which applies to each garment.
- **Two designs of the same garment share a collection.** Each addon pack
  reuses the collection name of the garment it came from, so install one
  design per garment at a time.
- **One texture slot per export.** A pack carries the design in the slot the
  player picked; the garment's other slots keep their original textures.
