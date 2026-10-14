const assert = require('node:assert/strict')
const test = require('node:test')
const {
  escapeSearchText,
  isValidTrackingNumber,
  parseBearerToken
} = require('../utils/request-security')

test('accepts a single well-formed Bearer token', () => {
  assert.equal(parseBearerToken('Bearer abc.def'), 'abc.def')
  assert.equal(parseBearerToken('bEaReR token'), 'token')
  assert.equal(parseBearerToken('Basic token'), null)
  assert.equal(parseBearerToken('Bearer token extra'), null)
  assert.equal(parseBearerToken(undefined), null)
})

test('escapes regex operators and caps search text at 100 characters', () => {
  const searchText = '[parcel].*'
  const escaped = escapeSearchText(searchText)

  assert.ok(new RegExp(escaped).test(searchText))
  assert.equal(new RegExp(escaped).test('parcel parcel'), false)
  assert.equal(escapeSearchText('a'.repeat(120)).length, 100)
})

test('accepts only bounded alphanumeric tracking numbers with hyphens', () => {
  assert.equal(isValidTrackingNumber('ZAP20261014ABC123'), true)
  assert.equal(isValidTrackingNumber('ZAP-123'), true)
  assert.equal(isValidTrackingNumber('ZAP 123'), false)
  assert.equal(isValidTrackingNumber('ZAP/123'), false)
  assert.equal(isValidTrackingNumber('A'.repeat(65)), false)
})