-- builder/http-download.lua
-- Serves baked output files for download.
--
-- Hosted servers mount the resource tree read-only, so baked YTDs are written
-- outside it (default /tmp/clothdesigner). They still have to reach the server
-- owner, so this exposes them over the FXServer HTTP endpoint.
--
-- Division of labour: the host blocks io.popen (and Lua cannot enumerate
-- directories), but the Node runtime reads /tmp fine -- so builder/output-store.js
-- exports bakerListOutputs/bakerReadOutputB64 and this file only decodes the
-- base64 and serves the bytes. Lua strings are byte-safe, so res.send delivers
-- clean binary (same approach rs_graff uses for its PNGs).
--
--   GET /cr-clothes/out            -> list available files
--   GET /cr-clothes/out/<file>     -> download that file
--
-- Console helper:  clothbake_get          -> prints the URLs

local RES = GetCurrentResourceName()

-- RFC 4648 base64 decode (Lua strings hold raw bytes, so this is binary-safe).
local _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local _b64lookup = {}
for i = 1, #_b64chars do
  _b64lookup[_b64chars:sub(i, i)] = i - 1
end

local function b64decode(b64)
  if not b64 or b64 == '' then return nil end
  b64 = tostring(b64):gsub('%s', '')
  local out, buf, bits = {}, 0, 0
  for i = 1, #b64 do
    local c = b64:sub(i, i)
    if c == '=' then break end
    local v = _b64lookup[c]
    if v ~= nil then
      buf = (buf << 6) | v
      bits = bits + 6
      if bits >= 8 then
        bits = bits - 8
        out[#out + 1] = string.char((buf >> bits) & 0xFF)
        buf = buf & ((1 << bits) - 1)
      end
    end
  end
  return table.concat(out)
end

local function safeName(name)
  name = tostring(name or '')
  if name == '' or name:find('%.%.', 1, true) then return nil end
  if not name:match('^[A-Za-z0-9_%-%.]+$') then return nil end
  return name
end

local function listOutputs()
  local ok, jsonText = pcall(function()
    return exports[RES]:bakerListOutputs()
  end)
  if not ok or type(jsonText) ~= 'string' then return {} end
  local decoded = json.decode(jsonText)
  if type(decoded) ~= 'table' then return {} end
  local names = {}
  for _, name in ipairs(decoded) do
    local safe = safeName(name)
    if safe then names[#names + 1] = safe end
  end
  return names
end

local function readOutput(name)
  local ok, b64 = pcall(function()
    return exports[RES]:bakerReadOutputB64(name)
  end)
  if not ok or type(b64) ~= 'string' or b64 == '' then return nil end
  return b64decode(b64)
end

local function respondText(res, code, text)
  res.writeHead(code, { ['Content-Type'] = 'text/plain; charset=utf-8' })
  res.send(text or '')
end

SetHttpHandler(function(req, res)
  local raw = tostring(req.path or '')
  local qAt = raw:find('?', 1, true)
  local reqPath = qAt and raw:sub(1, qAt - 1) or raw

  if reqPath == '/out' or reqPath == '/out/' then
    -- The listing is a dev convenience only. Once webhook delivery is on, pack
    -- URLs are posted to Discord and the URL is the only credential -- so an
    -- endpoint that enumerates every file would hand out everyone's packs.
    -- Owners get links from Discord or the clothbake_get console command.
    if GetConvar('clothdesigner_webhook_url', '') ~= ''
        or GetConvar('clothdesigner_disable_listing', '') == 'true' then
      respondText(res, 404, 'not found')
      return
    end
    local names = listOutputs()
    local lines = { 'Baked output files:', '' }
    if #names == 0 then
      lines[#lines + 1] = '(none yet -- export a design in game first)'
    else
      for _, name in ipairs(names) do
        lines[#lines + 1] = ('/%s/out/%s'):format(RES, name)
      end
    end
    respondText(res, 200, table.concat(lines, '\n'))
    return
  end

  if reqPath:sub(1, 5) ~= '/out/' then return end

  local name = safeName(reqPath:sub(6))
  if not name then
    respondText(res, 400, 'bad request')
    return
  end

  local bytes = readOutput(name)
  if not bytes then
    respondText(res, 404, 'not found')
    return
  end

  -- Preview images are served as images so Discord can show them in the
  -- delivery message; packs are served as downloads.
  local isPng = name:sub(-4):lower() == '.png'
  local headers = {
    ['Content-Type'] = isPng and 'image/png' or 'application/octet-stream',
    ['Content-Length'] = tostring(#bytes)
  }
  if not isPng then
    headers['Content-Disposition'] = ('attachment; filename="%s"'):format(name)
  end
  res.writeHead(200, headers)
  res.send(bytes)
end)

RegisterCommand('clothbake_get', function(source)
  if source ~= 0 then return end
  local names = listOutputs()
  if #names == 0 then
    print('[cr-clothes] no packs yet -- export a design in game first.')
    return
  end
  local base = GetConvar('clothdesigner_public_url', ''):gsub('/+$', '')
  if base == '' then
    base = 'http://HOST:PORT'
    print('[cr-clothes] set clothdesigner_public_url to get ready-made links; until then replace HOST:PORT with your server address and game port.')
  end
  for _, name in ipairs(names) do
    print(('[cr-clothes]   %s/%s/out/%s'):format(base, RES, name))
  end
end, true)

if GetConvar('clothdesigner_debug', 'false') == 'true' then print('[cr-clothes] http-download ready (serving baked outputs at /' .. RES .. '/out).') end
