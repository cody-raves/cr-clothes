# Drop your clothing here

Put clothing packs you already own into this folder, then run this in the
**server console**:

```
crclothes_prepare
```

Each garment gets registered and its 3D mesh is read straight out of the pack,
so players see the real garment in the designer and their drawing appears on it
live. No CodeWalker, no other tools.

## What to drop

The folder from any addon clothing pack — the one holding the `.ydd` and `.ytd`
files. Both common layouts work:

```
garments/
  Female Torn Jeans/
    stream/
      mp_f_freemode_01_mp_f_popcorn1^lowr_048_u.ydd          <- caret layout
      mp_f_freemode_01_mp_f_popcorn1^lowr_diff_048_a_uni.ytd
      mp_f_freemode_01_mp_f_popcorn1^lowr_diff_048_b_uni.ytd

  My Other Pack/
    stream/
      mp_m_freemode_01_mp_m_mypack.ymt
      mp_m_freemode_01_mp_m_mypack/                          <- nested layout
        jbib_000_u.ydd
        jbib_diff_000_a_uni.ytd
```

Drop the whole unzipped pack in — `fxmanifest.lua`, `.fxap` and anything else
that is not clothing is ignored. **Leave the files here afterwards:** exports
read the pack's model and textures from this folder. They are only ever read,
never changed.

## What gets read

Everything comes from the pack itself, so there is nothing to configure:

| From | Becomes |
|---|---|
| `mp_f_` / `mp_m_` in the name | male or female |
| `jbib` `lowr` `berd` `feet` … | tops, pants, masks, shoes … |
| `_048_` | drawable id |
| `_a_` `_b_` `_c_` … | how many texture slots the garment has |
| the `.ydd` | the 3D preview and the UV guide |

See what would happen without changing anything:

```
crclothes_prepare dry
```

## After it runs

On your own machine or a VPS the files are written straight into the resource:

```
refresh
restart cr-clothes
```

On a hosted server the resource folder is read-only, so everything is packed
into one zip instead, named `cr-clothes-prepared_` plus a random id. Run
`clothbake_get` for the download link, extract the zip over the `cr-clothes`
folder, then restart.

## Three things to know

**The pack must still be running.** Preparing makes a garment *designable*; the
game still loads the model from the pack itself, so keep `ensure <that pack>`
in your `server.cfg`.

**Every design exports as a new item.** A design made on one of these garments
exports as a pack that adds a new clothing item of its own, whether or not the
pack you dropped here has a `.ymt`. By default the original garment is left as
it is (a server set to `clothdesigner_export_mode replace` replaces it instead).
Props are the exception: a design on a hat, glasses, an earpiece, a watch or a
bracelet exports as a pack that replaces the prop's texture, unless
`clothdesigner_prop_addon` is set to `true`. `crclothes_prepare` says so next
to each prop. Each installed pack uses one of a small number of clothing
collection slots; see "Known limits" in the admin guide. Packs of this kind
are new in 1.1.0 and have not been tested in the game yet.

**Names are guessed.** A garment is labelled from its collection and drawable
id. Rename it in `generated/registry.json` — `displayName` is what players see.

## Only use clothing you have the right to use

Clothing you made, commissioned, or bought with the right to modify it. This
project ships no game assets and takes no position on what you add here.
