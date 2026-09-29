const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('./market-trend.js');

const at = (minute) => `2026-09-29T10:${String(minute).padStart(2, '0')}:00.000Z`;
const snapshot = (minute, lowestPrice, visiblePrices) => ({ collectedAt: at(minute), lowestPrice, visiblePrices });
const market = (minute, lowestPrice, prices) => ({ checkedAt: at(minute), lowestPrice, prices });

test('higher floor and disappearance below the fixed old floor suggest an upward move', () => {
  const result = compare(market(20, 67000, [67000, 67000, 67000, 68000, 68000]), [
    snapshot(1, 66000, [66000, 67000, 67000, 68000, 68000])
  ]);
  assert.equal(result.minutes, 19);
  assert.deepEqual(result.lowestPrice, [66000, 67000]);
  assert.deepEqual(result.lowListings, [1, 0]);
  assert.equal(result.signal, '偏涨迹象（待确认）');
});

test('lower floor and more quotes under the fixed old floor suggest downward pressure', () => {
  const result = compare(market(20, 98000, [98000, 99000, 100000, 101000]), [
    snapshot(1, 100000, [100000, 100000, 102000])
  ]);
  assert.deepEqual(result.lowListings, [2, 3]);
  assert.equal(result.signal, '偏跌迹象（待确认）');
});

test('stable floor with fewer low quotes after a falling segment suggests an early stop', () => {
  const result = compare(market(32, 100000, [100000]), [
    snapshot(1, 101000, [101000]),
    snapshot(16, 100000, [100000, 100000, 100000])
  ]);
  assert.deepEqual(result.lowListings, [3, 1]);
  assert.equal(result.previousKind, 'down');
  assert.equal(result.signal, '初步止跌（待确认）');
});

test('two consecutive upward segments strengthen the signal without claiming certainty', () => {
  const result = compare(market(32, 67000, [67000, 68000]), [
    snapshot(1, 65000, [65000, 66000]),
    snapshot(16, 66000, [66000, 67000])
  ]);
  assert.equal(result.previousKind, 'up');
  assert.equal(result.signal, '偏涨（连续两段，仍需观察）');
});

test('missing quote details or old samples do not create a directional prediction', () => {
  const missingPrices = compare(market(20, 67000, [67000]), [
    { collectedAt: at(1), lowestPrice: 66000 }
  ]);
  assert.equal(missingPrices.signal, '方向待确认');
  assert.equal(missingPrices.lowListings, null);
  assert.equal(compare(market(50, 67000, [67000]), [snapshot(1, 66000, [66000])]), null);
});
