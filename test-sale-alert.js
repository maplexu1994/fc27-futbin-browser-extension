const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Latest Sales alert fires on entry and rearms after the price recovers', async () => {
  const watchId = 'futbin:559';
  const watch = {
    watchId, pageId: '559', name: 'Rodrygo', enabled: true,
    url: 'https://www.futbin.com/27/player/559/rodrygo/market',
    priceRule: { min: null, max: null }, belowLatestSaleAlertEnabled: true
  };
  const data = {
    fc27PriceRangeWatchesV1: { [watchId]: watch },
    fc27PriceRangeStatusV1: {},
    fc27MarketSnapshotsV1: {}
  };
  const notifications = [];
  let onMessage;
  const chrome = {
    storage: { local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((key) => [key, data[key]]));
      },
      async set(values) { Object.assign(data, values); }
    } },
    tabs: { async query() { return []; } },
    alarms: {
      async clear() {}, async get() { return { periodInMinutes: 1 }; },
      onAlarm: { addListener() {} }
    },
    runtime: {
      getURL(path) { return path; },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener(listener) { onMessage = listener; } }
    },
    notifications: {
      async create(id, options) { notifications.push({ id, options }); },
      onClicked: { addListener() {} }
    }
  };
  const code = fs.readFileSync(require.resolve('./background.js'), 'utf8');
  const context = vm.createContext({ chrome, URL, Date, setTimeout, clearTimeout, console });
  vm.runInContext(`${code}\nglobalThis.testApi = {
    checkWatch,
    setItem(item) { readWatch = async () => item; },
    setReader(reader) { readWatch = reader; }
  };`, context);
  const check = async (price, salePrice) => {
    context.testApi.setItem({
      priceRange: { min: 600, max: 110000 },
      market: { lowestPrice: price, visibleCount: 1, atLowestCount: 1, within5Count: 1, prices: [price] },
      latestSales: salePrice == null ? null : { lowestPrice: salePrice, sampleCount: 1 }
    });
    return context.testApi.checkWatch(watchId, data.fc27PriceRangeWatchesV1[watchId]);
  };

  assert.equal((await check(20000, 21000)).belowLatestSaleAlert, true);
  assert.match(notifications[0].options.message, /20,000.*21,000/);
  assert.deepEqual(
    [data.fc27PriceRangeWatchesV1[watchId].lastBelowLatestSaleNotification.lowestPrice,
      data.fc27PriceRangeWatchesV1[watchId].lastBelowLatestSaleNotification.latestSaleLowestPrice],
    [20000, 21000]
  );
  assert.equal((await check(19500, 21000)).belowLatestSaleAlert, false);
  assert.equal((await check(19500, null)).belowLatestSaleAlert, false);
  assert.equal((await check(19500, 21000)).belowLatestSaleAlert, false);
  assert.equal((await check(21000, 21000)).belowLatestSaleAlert, false);
  assert.equal((await check(20500, 21000)).belowLatestSaleAlert, true);
  assert.equal(notifications.length, 2);

  data.fc27PriceRangeWatchesV1[watchId].belowLatestSaleAlertEnabled = false;
  assert.equal((await check(20000, 21000)).belowLatestSaleAlert, false);
  assert.equal(notifications.length, 2);

  data.fc27PriceRangeWatchesV1[watchId].belowLatestSaleAlertEnabled = true;
  data.fc27PriceRangeWatchesV1[watchId].belowLatestSaleAlertActive = true;
  delete data.fc27PriceRangeWatchesV1[watchId].lastBelowLatestSaleNotification;
  assert.equal((await check(370000, 372000)).belowLatestSaleAlert, true,
    'an old active state without a confirmed send should get one catch-up alert');
  assert.equal((await check(370000, 372000)).belowLatestSaleAlert, false);
  assert.equal(notifications.length, 3);

  const otherId = 'futbin:999';
  data.fc27PriceRangeWatchesV1[otherId] = {
    ...watch, watchId: otherId, pageId: '999',
    url: 'https://www.futbin.com/27/player/999/other/market'
  };
  const reads = [];
  context.testApi.setReader(async (selected) => {
    reads.push(selected.pageId);
    return {
      priceRange: { min: 600, max: 110000 },
      market: { lowestPrice: 370000, visibleCount: 1, atLowestCount: 1, within5Count: 1, prices: [370000] },
      latestSales: { lowestPrice: 372000, sampleCount: 1 }
    };
  });
  const response = await new Promise((resolve) => {
    assert.equal(onMessage({ type: 'FC27_CHECK_WATCH_NOW', watchId }, null, resolve), true);
  });
  assert.equal(response.result.watchId, watchId);
  assert.deepEqual(reads, ['559'], 'immediate check should not wait for other monitored cards');
});
