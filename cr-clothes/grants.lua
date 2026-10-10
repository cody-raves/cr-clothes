-- grants.lua
-- Design rights: who is allowed to design which garment.
--
-- This is the integration seam for everything that wants to sell, award, or
-- restrict clothing design: a Tebex purchase, an admin command, a gang leader
-- check, a job whitelist, an inventory item. They all funnel into one grant
-- store, so cr-clothes itself never needs to know about any of them.
--
-- TEBEX: packages can run a console command on purchase. That is the whole
-- integration -- no API keys, no webhooks. In the package's command config:
--     crclothes_grant {id} * 1
-- ({id} is the buyer's identifier; '*' = any garment; 1 = one design.)
--
-- Storage: the resource folder is read-only on hosted servers, so grants are
-- NEVER written to disk here. oxmysql is used when present (the usual case on
-- RP servers); otherwise server KVP; otherwise memory (dev/testing only).

Grants = Grants or {}

local UNLIMITED = -1
local cache = {}          -- [subject] = { [template] = { uses, grantedBy, grantedAt } }
local driver = 'memory'   -- 'oxmysql' | 'kvp' | 'memory'
local KVP_KEY = 'cr_clothes_grants'

local function log(message)
    print(('[cr-clothes:grants] %s'):format(message))
end

-- Startup detail is only printed with `set clothdesigner_debug true`; the
-- resource prints one summary line on its own (builder/server.js).
local function debugLog(message)
    if GetConvar('clothdesigner_debug', 'false') == 'true' then log(message) end
end

-- ---------------------------------------------------------------- subjects

-- Subjects are 'player:<identifier>', 'job:<name>' or 'gang:<name>'.
-- Accepts loose input: a bare identifier, an online server id, or a full
-- subject string. See TEBEX.md for what a store purchase sends.
function Grants.resolveSubject(raw)
    local text = tostring(raw or ''):gsub('^%s+', ''):gsub('%s+$', '')
    if text == '' then return nil end

    if text:match('^player:') or text:match('^job:') or text:match('^gang:') then
        return text:lower()
    end

    -- A bare number is ambiguous, and a store sends one: depending on how the
    -- buyer logged in, Tebex substitutes a Steam64 id or a Cfx.re account id.
    -- Treating every number as an online server id (as this used to) would
    -- either fail the purchase or hand it to whoever holds that server slot.
    if text:match('^%d+$') then
        -- Steam64 ids are 17 digits starting 7656; FiveM knows them as steam:<hex>.
        if #text == 17 and text:sub(1, 4) == '7656' then
            return ('player:steam:%x'):format(math.tointeger(tonumber(text)))
        end

        -- A short number that matches a connected player is a server id.
        if #text <= 5 and GetPlayerName(text) then
            for _, identifier in ipairs(GetPlayerIdentifiers(text) or {}) do
                if identifier:match('^license:') then return ('player:%s'):format(identifier:lower()) end
            end
        end

        -- Otherwise it is a Cfx.re account id, which players carry as fivem:<id>.
        return ('player:fivem:%s'):format(text)
    end

    -- Anything identifier-shaped (steam:, license:, discord:, fivem:, ip:).
    if text:match('^[%a]+:') then return ('player:%s'):format(text:lower()) end

    return ('player:%s'):format(text:lower())
end

-- Every subject string that could grant this player something.
local function subjectsForPlayer(source)
    local list = {}
    for _, identifier in ipairs(GetPlayerIdentifiers(source) or {}) do
        list[#list + 1] = ('player:%s'):format(identifier:lower())
    end

    -- Job/gang subjects resolve through the framework bridge when present, so
    -- cr-clothes stays framework-agnostic (see bridge/framework.lua).
    local ok, extra = pcall(function()
        if Bridge and Bridge.GetDesignSubjects then return Bridge.GetDesignSubjects(source) end
        return nil
    end)
    if ok and type(extra) == 'table' then
        for _, subject in ipairs(extra) do
            local resolved = Grants.resolveSubject(subject)
            if resolved then list[#list + 1] = resolved end
        end
    end

    return list
end

-- ---------------------------------------------------------------- storage

local function persistAll()
    if driver == 'kvp' then
        local ok = pcall(function()
            SetResourceKvp(KVP_KEY, json.encode(cache))
        end)
        if not ok then log('KVP write failed; grants are memory-only until restart.') end
    end
end

local function persistGrant(subject, template, entry)
    if driver == 'oxmysql' then
        exports.oxmysql:execute(
            'INSERT INTO cr_clothes_grants (subject, template, uses, granted_by) VALUES (?, ?, ?, ?) '
            .. 'ON DUPLICATE KEY UPDATE uses = VALUES(uses), granted_by = VALUES(granted_by)',
            { subject, template, entry.uses, entry.grantedBy }
        )
    else
        persistAll()
    end
end

local function deleteGrant(subject, template)
    if driver == 'oxmysql' then
        if template then
            exports.oxmysql:execute('DELETE FROM cr_clothes_grants WHERE subject = ? AND template = ?', { subject, template })
        else
            exports.oxmysql:execute('DELETE FROM cr_clothes_grants WHERE subject = ?', { subject })
        end
    else
        persistAll()
    end
end

local function loadAll()
    if driver == 'oxmysql' then
        exports.oxmysql:execute('SELECT subject, template, uses, granted_by FROM cr_clothes_grants', {}, function(rows)
            local count = 0
            for _, row in ipairs(rows or {}) do
                cache[row.subject] = cache[row.subject] or {}
                cache[row.subject][row.template] = {
                    uses = tonumber(row.uses) or 0,
                    grantedBy = row.granted_by
                }
                count = count + 1
            end
            debugLog(('loaded %d grant(s) from oxmysql.'):format(count))
        end)
    elseif driver == 'kvp' then
        local ok, stored = pcall(function() return GetResourceKvpString(KVP_KEY) end)
        if ok and stored and stored ~= '' then
            local decoded = json.decode(stored)
            if type(decoded) == 'table' then
                cache = decoded
                debugLog('loaded grants from KVP.')
            end
        end
    end
end

local function detectDriver()
    if GetResourceState('oxmysql') == 'started' then
        driver = 'oxmysql'
        exports.oxmysql:execute([[
            CREATE TABLE IF NOT EXISTS cr_clothes_grants (
                id INT AUTO_INCREMENT PRIMARY KEY,
                subject VARCHAR(128) NOT NULL,
                template VARCHAR(96) NOT NULL DEFAULT '*',
                uses INT NOT NULL DEFAULT 1,
                granted_by VARCHAR(64) DEFAULT NULL,
                granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_subject_template (subject, template)
            )
        ]], {})
        return
    end

    -- Server KVP is not on every build; probe before trusting it.
    local ok = pcall(function()
        SetResourceKvp(KVP_KEY .. '_probe', '1')
        DeleteResourceKvp(KVP_KEY .. '_probe')
    end)
    driver = ok and 'kvp' or 'memory'
end

-- ---------------------------------------------------------------- core api

-- Grant design rights. template '*' means any garment. uses -1 = unlimited.
function Grants.Grant(subject, template, uses, grantedBy)
    local resolved = Grants.resolveSubject(subject)
    if not resolved then return false, 'invalid subject' end
    template = tostring(template or '*')
    uses = tonumber(uses) or 1
    if uses == 0 then return false, 'uses must be non-zero (-1 = unlimited)' end

    cache[resolved] = cache[resolved] or {}
    local existing = cache[resolved][template]
    local entry = {
        uses = (existing and existing.uses ~= UNLIMITED and uses ~= UNLIMITED)
            and (existing.uses + uses)
            or uses,
        grantedBy = tostring(grantedBy or 'admin'),
        grantedAt = os.time()
    }
    cache[resolved][template] = entry
    persistGrant(resolved, template, entry)

    TriggerEvent('cr-clothes:grantAdded', { subject = resolved, template = template, uses = entry.uses, grantedBy = entry.grantedBy })
    return true, ('granted %s -> %s (uses now %s)'):format(resolved, template, entry.uses == UNLIMITED and 'unlimited' or entry.uses)
end

function Grants.Revoke(subject, template)
    local resolved = Grants.resolveSubject(subject)
    if not resolved then return false, 'invalid subject' end

    if template and template ~= '' then
        if cache[resolved] then cache[resolved][template] = nil end
        deleteGrant(resolved, template)
    else
        cache[resolved] = nil
        deleteGrant(resolved, nil)
    end

    TriggerEvent('cr-clothes:grantRevoked', { subject = resolved, template = template })
    return true, ('revoked %s%s'):format(resolved, template and (' -> ' .. template) or '')
end

-- What can this player design? Returns a list of {subject, template, uses}.
function Grants.GetGrants(source)
    local out = {}
    for _, subject in ipairs(subjectsForPlayer(source)) do
        for template, entry in pairs(cache[subject] or {}) do
            out[#out + 1] = { subject = subject, template = template, uses = entry.uses }
        end
    end
    return out
end

-- May this player design `template`? Admins and open-design servers always can.
function Grants.CanDesign(source, template)
    if Config.OpenDesign then return true, 'open' end
    if source == 0 then return true, 'console' end
    if IsPlayerAceAllowed(tostring(source), 'command.clothbuilder') then return true, 'ace' end

    template = tostring(template or '*')
    for _, subject in ipairs(subjectsForPlayer(source)) do
        local entries = cache[subject]
        if entries then
            local entry = entries[template] or entries['*']
            if entry and (entry.uses == UNLIMITED or entry.uses > 0) then
                return true, subject
            end
        end
    end
    return false, nil
end

-- Spend one use after a successful export. Unlimited grants are untouched.
function Grants.Consume(source, template)
    if Config.OpenDesign then return true end
    template = tostring(template or '*')
    for _, subject in ipairs(subjectsForPlayer(source)) do
        local entries = cache[subject]
        if entries then
            local key = entries[template] and template or (entries['*'] and '*' or nil)
            local entry = key and entries[key]
            if entry and entry.uses ~= UNLIMITED and entry.uses > 0 then
                entry.uses = entry.uses - 1
                if entry.uses <= 0 then
                    entries[key] = nil
                    deleteGrant(subject, key)
                else
                    persistGrant(subject, key, entry)
                end
                return true
            end
            if entry and entry.uses == UNLIMITED then return true end
        end
    end
    return false
end

-- ---------------------------------------------------------------- commands

-- crclothes_grant <subject> [template] [uses]
-- Tebex package command example:  crclothes_grant {id} * 1
RegisterCommand('crclothes_grant', function(source, args)
    if source ~= 0 and not IsPlayerAceAllowed(tostring(source), 'crclothes.admin') then return end
    local subject, template, uses = args[1], args[2] or '*', args[3] or 1
    local ok, message = Grants.Grant(subject, template, uses, source == 0 and 'console' or 'admin')
    log(message or 'grant failed')
end, true)

RegisterCommand('crclothes_revoke', function(source, args)
    if source ~= 0 and not IsPlayerAceAllowed(tostring(source), 'crclothes.admin') then return end
    local ok, message = Grants.Revoke(args[1], args[2])
    log(message or 'revoke failed')
end, true)

RegisterCommand('crclothes_grants', function(source, args)
    if source ~= 0 and not IsPlayerAceAllowed(tostring(source), 'crclothes.admin') then return end
    local filter = args[1] and Grants.resolveSubject(args[1]) or nil
    log(('storage driver: %s'):format(driver))
    local total = 0
    for subject, entries in pairs(cache) do
        if not filter or subject == filter then
            for template, entry in pairs(entries) do
                log(('  %s -> %s (uses: %s, by: %s)'):format(
                    subject, template,
                    entry.uses == UNLIMITED and 'unlimited' or entry.uses,
                    entry.grantedBy or '?'))
                total = total + 1
            end
        end
    end
    if total == 0 then log('  (no grants)') end
end, true)

-- ---------------------------------------------------------------- exports

exports('GrantDesign', function(subject, template, uses, grantedBy)
    return Grants.Grant(subject, template, uses, grantedBy or 'export')
end)
exports('RevokeDesign', function(subject, template)
    return Grants.Revoke(subject, template)
end)
exports('GetGrants', function(source) return Grants.GetGrants(source) end)
exports('CanDesign', function(source, template) return (Grants.CanDesign(source, template)) end)
exports('ConsumeDesign', function(source, template) return Grants.Consume(source, template) end)
-- Read by the startup summary.
exports('GetStatus', function()
    return {
        framework = (Bridge and Bridge.GetFramework and Bridge.GetFramework()) or 'standalone',
        storage = driver,
        openDesign = Config.OpenDesign == true
    }
end)

AddEventHandler('onResourceStart', function(resource)
    if resource ~= GetCurrentResourceName() then return end
    detectDriver()
    loadAll()
    debugLog(('ready (storage: %s, open design: %s)'):format(driver, tostring(Config.OpenDesign == true)))
end)
