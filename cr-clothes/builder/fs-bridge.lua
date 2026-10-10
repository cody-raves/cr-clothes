-- builder/fs-bridge.lua
-- Hosted file-write bridge.
--
-- On hosted FiveM servers the Node `fs` module is jailed: fs *reads* work but
-- fs *writes* into the resource folder fail with EACCES. FiveM's own
-- SaveResourceFile native is NOT jailed and lands files inside the resource
-- folder -- this is how other resources persist images/textures at runtime.
--
-- The Node baker keeps the heavy work (zlib, RSC7 struct patching -- Lua has no
-- zlib) and hands its finished bytes here, base64-encoded, and this shim writes
-- them with SaveResourceFile. Exposed as same-resource exports, called from
-- builder/server.js and builder/smoke-test.js via global.exports[resourceName].

local RES = GetCurrentResourceName()

-- RFC 4648 base64 decode. Lua strings hold raw bytes, so this is binary-safe.
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

-- Only allow relative paths inside the resource. No absolute paths, no traversal.
local function safeRel(rel)
  rel = tostring(rel or '')
  if rel == '' or rel:find('%.%.', 1, true) or rel:sub(1, 1) == '/' or rel:find(':', 1, true) then
    return nil
  end
  return (rel:gsub('\\', '/'))
end

-- Write base64-encoded bytes to <resource>/<rel>. The parent directory must
-- already exist (SaveResourceFile cannot create directories). Returns boolean.
exports('bakerSaveFileB64', function(rel, b64)
  local safe = safeRel(rel)
  if not safe then return false end
  local bytes = b64decode(b64)
  if not bytes then return false end
  local ok = SaveResourceFile(RES, safe, bytes, #bytes)
  return ok ~= false
end)

-- Delete <resource>/<rel>. Used to clean up write-probe markers. Returns boolean.
exports('bakerDeleteFile', function(rel)
  local safe = safeRel(rel)
  if not safe then return false end
  local rp = GetResourcePath(RES)
  if not rp then return false end
  local ok = os.remove(rp .. '/' .. safe)
  return ok and true or false
end)

if GetConvar('clothdesigner_debug', 'false') == 'true' then print('[cr-clothes] fs-bridge ready (SaveResourceFile write path for hosted servers).') end
