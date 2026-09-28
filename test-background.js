const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('active tabs stay visible, background tabs refresh, and failed alerts retry', async () => {
  const watchId = 'futbin:559';
  const data = {
    fc27PriceRangeWatchesV1: {
      [watchId]: {
        watchId, pageId: '559', basePlayerEaId: '243812', name: 'Rodrygo',
        version: 'Gold', overall: '84', enabled: true,
        url: 'https://www.futbin.com/27/player/559/rodrygo-silva-de-goes/market',
        priceRule: { min: null, max: 22000 }, lastPrice: 23250,
        lastRange: { min: 600, max: 110000 }
      }
    },
    fc27PriceRangeStatusV1: {},
    fc27MarketSnapshotsV1: {}
  };
  const listeners = new Set();
  let alarmListener;
  let alarmCreates = 0;
  let reloads = 0;
  let backgroundTabsCreated = 0;
  const monitorTabs = [{ id: 9, active: true, url: data.fc27PriceRangeWatchesV1[watchId].url }];
  let notificationAttempts = 0;
  const chrome = {
    storage: { local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((key) => [key, data[key]]));
      },
      async set(patch) { Object.assign(data, patch); }
    } },
    alarms: {
      async get() { return { name: 'fc27-market-monitor', periodInMinutes: 1 }; },
      async create() { alarmCreates++; },
      async clear() { return true; },
      onAlarm: { addListener(listener) { alarmListener = listener; } }
    },
    tabs: {
      async query() { return monitorTabs; },
      async reload(id) {
        assert.equal(id, 10);
        reloads++;
        queueMicrotask(() => { for (const listener of listeners) listener(id, { status: 'complete' }); });
      },
      async create(options) {
        assert.equal(options.active, false);
        const tab = { id: 10, active: false, url: options.url };
        monitorTabs.push(tab);
        backgroundTabsCreated++;
        return tab;
      },
      async update() {},
      onUpdated: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); }
      }
    },
    scripting: { async executeScript() { return []; } },
    runtime: {
      getURL(path) { return path; },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    notifications: { async create() { if (++notificationAttempts === 1) throw new Error('notification unavailable'); }, onClicked: { addListener() {} } }
  };
  chrome.tabs.sendMessage = async () => ({ ok: true, item: {
    isMarketPage: true, pageId: '559', eaId: '243812', priceRange: { min: 600, max: 110000 },
    updatedLabel: 'PRICE UPDATED: 1 MIN AGO', collectedAt: new Date().toISOString(),
    latestSales: { lowestPrice: 20500, soldAt: '2026-09-28T08:12:00.000Z', displayTime: 'Sep 28, 8:12 AM', timeBasis: 'absolute', sampleCount: 9 },
    market: {
      prices: [21750, 22000, 22000, 22250, 22250], lowestPrice: 21750,
      visibleCount: 5, atLowestCount: 1, within5Count: 5, within5Limit: 22837
    }
  } });

  const code = fs.readFileSync(require.resolve('./background.js'), 'utf8');
  vm.runInNewContext(code, { chrome, URL, setTimeout, clearTimeout, queueMicrotask, Date, console });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(alarmCreates, 0, 'worker startup must not postpone an existing alarm');

  alarmListener({ name: 'fc27-market-monitor' });
  for (let i = 0; i < 100 && data.fc27PriceRangeStatusV1[watchId]?.state !== 'error'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(reloads, 0, 'the active monitor tab should not reload');
  assert.equal(backgroundTabsCreated, 1, 'an active tab should get a background monitor copy');
  assert.equal(data.fc27PriceRangeWatchesV1[watchId].lastPrice, 21750);
  assert.equal(data.fc27PriceRangeWatchesV1[watchId].pendingPriceAlert, true);
  assert.equal(data.fc27MarketSnapshotsV1[watchId].length, 1);
  assert.equal(data.fc27PriceRangeWatchesV1[watchId].lastLatestSales.lowestPrice, 20500);
  assert.equal(data.fc27MarketSnapshotsV1[watchId][0].latestSaleSoldAt, '2026-09-28T08:12:00.000Z');

  await new Promise((resolve) => setTimeout(resolve, 0));
  alarmListener({ name: 'fc27-market-monitor' });
  for (let i = 0; i < 100 && data.fc27PriceRangeStatusV1[watchId]?.state !== 'ok'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(reloads, 1, 'the background monitor tab should reload');
  assert.equal(notificationAttempts, 2, 'the failed alert should retry');
  assert.equal(data.fc27PriceRangeWatchesV1[watchId].pendingPriceAlert, false);
});
