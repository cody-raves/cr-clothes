# cr-clothes Discord bot (optional)

Optional delivery bot for cr-clothes. FiveM servers running cr-clothes bake clothing packs
and POST them here over HTTP; the bot posts each pack as a card (embed +
attachment or download link) into the Discord channel that guild paired via
`/setup`. One bot instance, hosted by you, serves many guilds. The bot never
touches the game servers and holds no credentials for them — install
stays a manual download by the guild admin.

## Requirements

- Node.js 18+ (uses only `node:` builtins plus `discord.js` v14)
- A Discord application/bot (only for live mode — see dry-run below)

## Operator setup

1. **Install dependencies**

   ```
   npm install
   ```

2. **Create the Discord application** (skip for dry-run testing)

   - Go to https://discord.com/developers/applications → *New Application*.
   - **Bot** tab → *Reset Token* → copy the bot token. No privileged intents
     are needed (the bot only uses the Guilds intent).
   - Note the **Application ID** on *General Information* — this is the
     client ID.

3. **Configure `.env`**

   ```
   copy .env.example .env
   ```

   Fill in at minimum:

   | Key | Value |
   |---|---|
   | `DISCORD_TOKEN` | bot token (leave empty for dry-run) |
   | `DISCORD_CLIENT_ID` | application ID |
   | `PORT` | HTTP port (default 8085) |
   | `PUBLIC_URL` | public base URL game servers reach this box at |
   | `DATA_DIR` | storage dir (default `./data`) |
   | `MAX_UPLOAD_MB` | upload cap after base64 decode (default 30) |
   | `ATTACH_LIMIT_MB` | attach vs. link threshold (default 7.5) |

4. **Register the slash commands** (once, and again whenever they change)

   ```
   npm run register
   ```

5. **Invite the bot** to a guild with both scopes and message permissions:

   ```
   https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=52224
   ```

   `52224` = View Channel + Send Messages + Embed Links + Attach Files.

6. **Run**

   ```
   npm start
   ```

   The startup banner states the mode (LIVE or DRY-RUN).

### Dry-run mode (no Discord token)

If `DISCORD_TOKEN` is empty or unset, the bot never contacts Discord. The
HTTP API, storage, auth, and routing all behave identically; "posting a card"
instead writes the exact would-be Discord payload (embed JSON + attachment
info) to `data/outbox/<timestamp>-<id>.json` and logs a one-line summary.
Use the CLI to create pairings for testing:

```
npm run cli -- issue-token --guild 123456789012345678 --channel 234567890123456789 --name "Test Guild"
npm run cli -- list
npm run cli -- revoke --token cd_live_<32hex>
```

Tokens are stored **hashed** (sha256); the plaintext is printed once at issue
time and cannot be recovered — rotate instead.

Note: the running bot loads `servers.json` at startup, so a token issued or
revoked via the CLI while the bot is running takes effect only after a bot
restart. Live-mode `/setup` and `/revoke` don't have this limitation — they
mutate the in-process store directly.

## Pairing a Discord server (what its admins do)

1. Invite the bot (link above), then run **`/setup`** in the channel where
   pack cards should appear. Requires the *Manage Server* permission.
2. The bot replies **ephemerally** (only the admin sees it) with a one-time
   token `cd_live_...` and these two lines to put in the FiveM `server.cfg`:

   ```
   set clothdesigner_bot_url "https://<your-bot-host>"
   set clothdesigner_bot_token "cd_live_..."
   ```

   Restart the game server after editing. The token is a server-side convar —
   never replicated, never printed.
3. Every finished pack now appears as a card in the chosen channel. Small
   packs (≤ `ATTACH_LIMIT_MB`) are attached directly; larger ones get a
   download link. The card includes install instructions (extract into
   `resources/`, add an `ensure` line, restart).
4. **`/status`** shows the paired channel, pairing date, and upload count
   (never the token). Re-running **`/setup`** issues a new token and revokes
   the old one (rotation for leaked tokens). **`/revoke`** disables uploads
   without a replacement.

## HTTP API contract (game-server side)

### `POST /api/v1/upload`

- Header: `Authorization: Bearer cd_live_<32 lowercase hex>`
- Body (JSON):

  ```json
  {
    "name": "Design name",             // 1-100 chars, required
    "mode": "replace",                 // e.g. "replace" | "addon", 1-40 chars, required
    "fileName": "pack.zip",            // [A-Za-z0-9_.-]{1,80}, required
    "fileB64": "<base64 of the zip>",  // required; decoded size <= MAX_UPLOAD_MB
    "meta": { "server": "My RP City" } // optional; meta.server shows on the card
  }
  ```

- Responses:
  - `200` `{"ok":true,"id":"<16 hex>","delivered":"attach"|"link"|"outbox"}`
  - `400` bad/missing field (`bad_name`, `bad_mode`, `bad_fileName`,
    `bad_fileB64`, `bad_meta`, `invalid_json`)
  - `401` unknown or revoked token
  - `413` body or decoded file too large
  - `429` rate limited (max **10 uploads per 10 minutes per token**)
  - `502` stored OK but Discord delivery failed

### `GET /files/<id>/<fileName>`

Serves a stored pack as a download (`Content-Disposition: attachment`).
Used by the card's download link for oversized packs. 404 for anything else.

### `GET /healthz`

`{"ok":true,"mode":"live"|"dry-run","guilds":<active pairing count>}`

## Data layout

```
data/
  servers.json   pairings, keyed by sha256(token) — plaintext never stored
  uploads.json   last 200 upload records
  files/<id>/<fileName>   stored packs
  outbox/        dry-run card payloads
```

`data/`, `.env`, and `node_modules/` are gitignored.
