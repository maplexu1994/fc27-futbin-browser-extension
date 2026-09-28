const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackup, mergeBackup } = require('./monitor-backup.js');

const watchId = 'futbin:559';
const watch = {
  watchId, pageId: '559', name: 'Rodrygo', enabled: true,
  url: 'https://www.futbin.com/27/player/559/rodrygo-silva-de-goes/market',
  priceRule: { min: null, max: 21000 }, lastPrice: 21750
};
const sample = { collectedAt: '2026-09-28T08:12:00.000Z', lowestPrice: 21750 };

test('backup includes only monitor watches and history', () => {
  const backup = createBackup({ [watchId]: watch }, { [watchId]: [sample] });
  assert.deepEqual(Object.keys(backup.watches), [watchId]);
  assert.deepEqual(backup.snapshots[watchId], [sample]);
  assert.equal(JSON.stringify(backup).includes('fc27Cards'), false);
});

test('restore merges history without overwriting existing alert rules or duplicating samples', () => {
  const backup = createBackup({ [watchId]: watch }, { [watchId]: [sample] });
  const fresh = mergeBackup(backup, {}, {});
  assert.equal(fresh.watches[watchId].priceRule.max, 21000);
  assert.deepEqual(fresh.snapshots[watchId], [sample]);
  const current = { ...watch, priceRule: { min: 18000, max: 20000 } };
  const first = mergeBackup(backup, { [watchId]: current }, { [watchId]: [sample] });
  assert.deepEqual(first.watches[watchId].priceRule, current.priceRule);
  assert.equal(first.snapshots[watchId].length, 1);
  const second = mergeBackup(backup, first.watches, first.snapshots);
  assert.equal(second.snapshots[watchId].length, 1);
});

test('restore rejects another format and a mismatched Market URL', () => {
  assert.throws(() => mergeBackup({ format: 'other', version: 1, watches: {}, snapshots: {} }, {}, {}), /不是受支持/);
  const backup = createBackup({ [watchId]: watch }, { [watchId]: [] });
  backup.watches[watchId].url = 'https://www.futbin.com/27/player/123/another/market';
  assert.throws(() => mergeBackup(backup, {}, {}), /不匹配/);
});

test('restore rejects history without a matching card', () => {
  const backup = createBackup({}, {});
  backup.snapshots[watchId] = [sample];
  assert.throws(() => mergeBackup(backup, {}, {}), /没有对应/);
});
