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
read the pack's textures from this folder. They are only ever read, never
changed.

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
into `cr-clothes-prepared.zip` instead. Run `clothbake_get` for the download
link, extract the zip over the `cr-clothes` folder, then restart.

## Three things to know

**The pack must still be running.** Preparing makes a garment *designable*; the
game still loads the model from the pack itself, so keep `ensure <that pack>`
in your `server.cfg`.

**Packs with a `.ymt` export as new items; packs without one export as a
replacement.** A full clothing pack ships a `<collection>.ymt`, and designs made
on its garments export as a new addon item. A single item split out of a larger
pack usually has no `.ymt`; designs on it export as a pack that replaces that
garment's texture instead. `crclothes_prepare` tells you which applies.

**Names are guessed.** A garment is labelled from its collection and drawable
id. Rename it in `generated/registry.json` — `displayName` is what players see.

## Only use clothing you have the right to use

Clothing you made, commissioned, or bought with the right to modify it. This
project ships no game assets and takes no position on what you add here.
