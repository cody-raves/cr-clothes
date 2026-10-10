# Selling design rights on your own store (optional)

cr-clothes has no store, no marketplace and no cut. **You do not need Tebex, or
any store, to use it.** This page is for owners who *want* to charge players
for designing clothing: you sell it on your own store, at your own price, and
all of the money goes to you.

It needs no API keys, tokens or account linking — only a console command your
store runs after a purchase.

---

## How it works

A store such as Tebex can run a **console command on your game server** when
someone buys a package. cr-clothes has a command made for that:

```
crclothes_grant <who> <what> <how many>
```

A purchase grants a *design right*. The buyer opens the designer, makes their
garment and exports it, and the right is used up. That is the whole loop.

---

## Setup with Tebex

### 1. Create the package

For example **"Custom Clothing Design — $10"**.

### 2. Add the command

In the package's **Commands** section, add a command to run when the purchase
completes:

```
crclothes_grant {id} * 1
```

| Part | Meaning |
|---|---|
| `{id}` | the buyer — Tebex fills this in |
| `*` | any garment in your catalogue, or one garment's id to restrict it |
| `1` | one design; `-1` for unlimited |

Let the command run even when the buyer is offline. The right is stored
against their account and is waiting when they next join.

### 3. Keep `Config.OpenDesign` off

In `config.lua`:

```lua
Config.OpenDesign = false   -- players need a design right to export
```

With `true`, everyone can design for free and there is nothing to sell.

### 4. Test it before you sell it

Use Tebex's manual payment feature to create a test purchase for your own
account, then look at your server console. You should see:

```
[cr-clothes:grants] granted player:steam:1100001xxxxxxxx -> * (uses now 1)
```

Then run `crclothes_grants` and confirm the right is listed, join the server
and check that you can export a design.

**What `{id}` contains depends on how the buyer logged in to your store** — a
Steam id or a Cfx.re account id. cr-clothes accepts both, and also license and
Discord identifiers, and matches the right against every identifier the player
joins with. If your test purchase is granted to an identifier your players do
not have in game (for example a Steam id on a server that does not require
Steam), the right will never be matched: change the store's login method, or
use a variable that matches your server's identifiers.

---

## More examples

A bundle of five designs:

```
crclothes_grant {id} * 5
```

Unlimited designs (a "designer pass"):

```
crclothes_grant {id} * -1
```

The right to design one specific garment only (ids are in
`generated/registry.json`):

```
crclothes_grant {id} female:mp_f_freemode_01_mp_f_mypack:jbib:004 1
```

Refunds and chargebacks — add to the package's refund/chargeback commands:

```
crclothes_revoke {id}
```

---

## Any other store, or none

Nothing here is specific to Tebex. Anything that can run a server console
command, or call an export, can grant a right:

```lua
exports['cr-clothes']:GrantDesign('player:license:abc123', '*', 1, 'my-shop')
exports['cr-clothes']:RevokeDesign('player:license:abc123')
local grants = exports['cr-clothes']:GetGrants(source)
local allowed = exports['cr-clothes']:CanDesign(source, '*')
```

So design rights can equally come from an in-game shop that takes in-game
money, a quest reward, an inventory item, or a staff member typing a command.

React to designs being made (log them, add them to a job wardrobe):

```lua
AddEventHandler('cr-clothes:designExported', function(data)
    -- data.player, data.slotId, data.packName, data.mode
end)
```

---

## Admin commands

Server console, or in game with the `crclothes.admin` ACE:

```
crclothes_grant <who> [garment] [uses]   give a design right
crclothes_revoke <who> [garment]         take it away
crclothes_grants [who]                   list current rights
```

`<who>` is a player identifier (`license:abc…`, `steam:110…`, `fivem:123…`), an
online player's server id (`3`), or a group: `job:police`, `gang:ballas`.

```cfg
add_ace group.admin crclothes.admin allow
```

---

## Jobs and gangs

Let the police department design its own uniforms:

```
crclothes_grant job:police * -1
```

Let a gang design crew clothing:

```
crclothes_grant gang:ballas * -1
```

`Config.DesignRequiresBoss = true` limits job and gang rights to bosses and
leaders. Job and gang detection supports Qbox, qb-core and ESX (see
`bridge/framework.lua`).

---

## Storage

Design rights are stored in your database (`oxmysql`) when it is available,
otherwise in FiveM's key-value store. Nothing is written into the resource
folder, so this works on hosted servers too.
