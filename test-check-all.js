const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('a forced manual check runs after an in-flight scheduled check', async () => {
  let reads = 0;
  let blockNextRead = false;
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const chrome = {
    storage: { local: {
      async get() {
        reads++;
        if (blockNextRead) { blockNextRead = false; await gate; }
        return { fc27PriceRangeWatchesV1: {}, fc27PriceRangeStatusV1: {} };
      },
      async set() {}
    } },
    tabs: { async query() { return []; } },
    alarms: {
      async clear() {}, async get() { return { periodInMinutes: 1 }; }, async create() {},
      onAlarm: { addListener() {} }
    },
    runtime: {
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    notifications: { onClicked: { addListener() {} } }
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout, Date });
  vm.runInContext(fs.readFileSync(require.resolve('./background.js'), 'utf8'), context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const before = reads;
  blockNextRead = true;
  const scheduled = vm.runInContext('checkAll()', context);
  const manual = vm.runInContext('checkAll({ forceSnapshot: true })', context);
  releaseRead();
  await Promise.all([scheduled, manual]);
  assert.equal(reads - before, 2);
});
