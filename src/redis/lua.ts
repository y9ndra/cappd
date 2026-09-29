/**
 * Lua scripts for atomic Cappd operations in Redis.
 *
 * Each script executes atomically within Redis's single-threaded engine,
 * guaranteeing serializability and preventing race conditions.
 */

export const RESERVE_LUA = `
local budgetExists = redis.call('EXISTS', KEYS[1])
if budgetExists == 0 then
  return { 'ERR_BUDGET_NOT_FOUND' }
end

local budgetData = redis.call('HMGET', KEYS[1], 'limit', 'unit', 'committed', 'reserved')
local limit = tonumber(budgetData[1])
local unit = budgetData[2]
local committed = tonumber(budgetData[3] or '0')
local reserved = tonumber(budgetData[4] or '0')

if unit ~= ARGV[4] then
  return { 'ERR_UNIT_MISMATCH', unit, ARGV[4] }
end

local available = limit - committed - reserved
local requested = tonumber(ARGV[3])

-- Invariant check: committed + reserved + requested <= limit
if requested > available then
  return { 'ERR_BUDGET_EXCEEDED', tostring(math.max(0, available)), unit }
end

local newReserved = reserved + requested
redis.call('HSET', KEYS[1], 'reserved', tostring(newReserved))

local createdAt = tonumber(ARGV[6])
local ttlMs = tonumber(ARGV[5])
local expiresAt = createdAt + ttlMs

redis.call('HMSET', KEYS[2],
  'id', ARGV[1],
  'key', ARGV[2],
  'reservedAmount', tostring(requested),
  'unit', ARGV[4],
  'status', 'reserved',
  'createdAt', tostring(createdAt),
  'expiresAt', tostring(expiresAt)
)

-- Set reservation key TTL in seconds (with 60-second grace period for post-expiration inspection)
local ttlSeconds = math.ceil((ttlMs + 60000) / 1000)
redis.call('EXPIRE', KEYS[2], ttlSeconds)

return { 'OK', tostring(createdAt), tostring(expiresAt) }
`;

export const COMMIT_LUA = `
local resExists = redis.call('EXISTS', KEYS[1])
if resExists == 0 then
  return { 'ERR_RESERVATION_NOT_FOUND' }
end

local resData = redis.call('HMGET', KEYS[1], 'key', 'reservedAmount', 'unit', 'status', 'expiresAt', 'createdAt')
local budgetKey = resData[1]
local reservedAmount = tonumber(resData[2])
local resUnit = resData[3]
local status = resData[4]
local expiresAt = tonumber(resData[5])
local createdAt = tonumber(resData[6])

if status ~= 'reserved' then
  return { 'ERR_INVALID_STATE', status, 'commit' }
end

if resUnit ~= ARGV[2] then
  return { 'ERR_UNIT_MISMATCH', resUnit, ARGV[2] }
end

local currentTime = tonumber(ARGV[3])
if currentTime > expiresAt then
  redis.call('HSET', KEYS[1], 'status', 'expired')
  local budgetExists = redis.call('EXISTS', KEYS[2])
  if budgetExists == 1 then
    local curReserved = tonumber(redis.call('HGET', KEYS[2], 'reserved') or '0')
    local nextReserved = math.max(0, curReserved - reservedAmount)
    redis.call('HSET', KEYS[2], 'reserved', tostring(nextReserved))
  end
  return { 'ERR_INVALID_STATE', 'expired', 'commit' }
end

local actualAmount = tonumber(ARGV[1])
if actualAmount > reservedAmount then
  return { 'ERR_OVERAGE', tostring(actualAmount), tostring(reservedAmount), resUnit }
end

local budgetExists = redis.call('EXISTS', KEYS[2])
if budgetExists == 0 then
  return { 'ERR_BUDGET_NOT_FOUND' }
end

local bData = redis.call('HMGET', KEYS[2], 'reserved', 'committed')
local bReserved = tonumber(bData[1] or '0')
local bCommitted = tonumber(bData[2] or '0')

local newReserved = math.max(0, bReserved - reservedAmount)
local newCommitted = bCommitted + actualAmount

redis.call('HMSET', KEYS[2], 'reserved', tostring(newReserved), 'committed', tostring(newCommitted))
redis.call('HMSET', KEYS[1], 'status', 'committed', 'committedAmount', tostring(actualAmount))

return { 'OK', tostring(createdAt), tostring(expiresAt), tostring(reservedAmount), tostring(actualAmount), resUnit, budgetKey }
`;

export const RELEASE_LUA = `
local resExists = redis.call('EXISTS', KEYS[1])
if resExists == 0 then
  return { 'ERR_RESERVATION_NOT_FOUND' }
end

local resData = redis.call('HMGET', KEYS[1], 'key', 'reservedAmount', 'unit', 'status', 'createdAt', 'expiresAt')
local budgetKey = resData[1]
local reservedAmount = tonumber(resData[2])
local resUnit = resData[3]
local status = resData[4]
local createdAt = tonumber(resData[5])
local expiresAt = tonumber(resData[6])

if status ~= 'reserved' then
  return { 'ERR_INVALID_STATE', status, 'release' }
end

local budgetExists = redis.call('EXISTS', KEYS[2])
if budgetExists == 1 then
  local curReserved = tonumber(redis.call('HGET', KEYS[2], 'reserved') or '0')
  local nextReserved = math.max(0, curReserved - reservedAmount)
  redis.call('HSET', KEYS[2], 'reserved', tostring(nextReserved))
end

redis.call('HSET', KEYS[1], 'status', 'released')

return { 'OK', tostring(createdAt), tostring(expiresAt), tostring(reservedAmount), resUnit, budgetKey }
`;

export const SET_BUDGET_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 1 then
  redis.call('HMSET', KEYS[1], 'limit', ARGV[1], 'unit', ARGV[2])
else
  redis.call('HMSET', KEYS[1], 'limit', ARGV[1], 'unit', ARGV[2], 'committed', '0', 'reserved', '0')
end
return 'OK'
`;
