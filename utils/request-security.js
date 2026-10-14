function parseBearerToken(authorization) {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : null
}

function escapeSearchText(value) {
  return String(value).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isValidTrackingNumber(value) {
  return /^[A-Za-z0-9-]{1,64}$/.test(value)
}

module.exports = { escapeSearchText, isValidTrackingNumber, parseBearerToken }