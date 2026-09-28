const MONITOR_ALARM = 'fc27-market-monitor';
const WATCH_KEY = 'fc27PriceRangeWatchesV1';
const STATUS_KEY = 'fc27PriceRangeStatusV1';
const SNAPSHOT_KEY = 'fc27MarketSnapshotsV1';
const CHECK_PERIOD_MINUTES = 1;
const SNAPSHOT_PERIOD_MS = 15 * 60 * 1000;
const MAX_SNAPSHOTS_PER_CARD = 672;
let currentCheck = null;

const nowIso = () => new Date().toISOString();
const formatCoins = (value) => Number(value).toLocaleString('en-US');

function toMarketUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^(\/27\/player\/\d+\/[^/]+)(?:\/market)?\/?$/);
    return match ? `${url.origin}${match[1]}/market` : '';
  } catch (_) { return ''; }
}

async function migrateWatches() {
  const stored = await chrome.storage.local.get([WATCH_KEY, STATUS_KEY]);
  const watches = stored[WATCH_KEY] || {};
  const statuses = stored[STATUS_KEY] || {};
  const migrated = {};
  const migratedStatuses = { ...statuses };
  let changed = false;
  for (const [oldKey, original] of Object.entries(watches)) {
    if (oldKey === '67329765' && !original.url) { delete migratedStatuses[oldKey]; changed = true; continue; }
    const watch = { ...original };
    if (!watch.basePlayerEaId && oldKey === '67329765') watch.basePlayerEaId = '220901';
    const watchId = watch.pageId ? `futbin:${watch.pageId}` : (watch.watchId || oldKey);
    const url = toMarketUrl(watch.url);
    watch.watchId = watchId;
    if (url) watch.url = url;
    if (!watch.priceRule) watch.priceRule = { min: null, max: null };
    migrated[watchId] = watch;
    if (watchId !== oldKey) {
      if (statuses[oldKey] && !migratedStatuses[watchId]) migratedStatuses[watchId] = statuses[oldKey];
      delete migratedStatuses[oldKey];
    }
    if (watchId !== oldKey || watch.url !== original.url || !original.priceRule || watch.basePlayerEaId !== original.basePlayerEaId) changed = true;
  }
  if (changed) await chrome.storage.local.set({ [WATCH_KEY]: migrated, [STATUS_KEY]: migratedStatuses });
  return migrated;
}

async function ensureMonitor() {
  const watches = await migrateWatches();
  const tabs = await chrome.tabs.query({ url: 'https://www.futbin.com/27/player/*' });
  for (const watch of Object.values(watches)) {
    const marketUrl = toMarketUrl(watch.url);
    if (!marketUrl) continue;
    const existing = tabs.find((tab) => toMarketUrl(tab.url) === marketUrl);
    if (existing?.id && existing.url !== marketUrl) {
      await chrome.tabs.update(existing.id, { url: marketUrl, pinned: true });
    }
  }
  await chrome.alarms.clear('fc27-price-range-monitor');
  const alarm = await chrome.alarms.get(MONITOR_ALARM);
  if (!alarm || alarm.periodInMinutes !== CHECK_PERIOD_MINUTES) {
    await chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
  }
}

async function reloadTabAndWait(tabId, timeoutMs = 25000) {
  await new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('监控页面加载超时')); }, timeoutMs);
    const listener = (changedId, info) => {
      if (changedId !== tabId || info.status !== 'complete') return;
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    try { await chrome.tabs.reload(tabId, { bypassCache: true }); }
    catch (error) { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); reject(error); }
  });
}

async function readPageWhenReady(tabId, attempts = 15) {
  let lastError;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['sales-parser.js', 'content.js'] });
  } catch (error) {
    lastError = new Error(`无法注入最新版 Market 探针：${error.message || String(error)}`);
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'FC27_READ_FUTBIN_MARKET_V3' });
      if (response?.ok && response.item?.priceRange && response.item?.market?.lowestPrice) return response;
      lastError = new Error(response?.error || 'FUTBIN 市场页尚未显示完整 PC 报价');
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError || new Error('无法读取 FUTBIN 市场页');
}

async function setWatchStatus(watchId, patch) {
  const stored = await chrome.storage.local.get(STATUS_KEY);
  const statuses = stored[STATUS_KEY] || {};
  statuses[watchId] = { ...(statuses[watchId] || {}), ...patch, updatedAt: nowIso() };
  await chrome.storage.local.set({ [STATUS_KEY]: statuses });
}

async function findMonitorTab(watch) {
  const wanted = toMarketUrl(watch.url);
  if (!wanted) return null;
  const tabs = await chrome.tabs.query({ url: 'https://www.futbin.com/27/player/*' });
  const matching = tabs.filter((tab) => {
    try { return toMarketUrl(tab.url) === wanted && /\/market\/?$/.test(new URL(tab.url).pathname); }
    catch (_) { return false; }
  });
  return matching.find((tab) => !tab.active) || matching[0] || null;
}

async function readWatch(watch, { reload = true } = {}) {
  let tab = await findMonitorTab(watch);
  if (!tab?.id) throw new Error('市场监控页未打开，请点击“打开监控页”');
  if (reload && tab.active) {
    tab = await chrome.tabs.create({ url: toMarketUrl(watch.url), active: false, pinned: true });
  } else if (reload) {
    await reloadTabAndWait(tab.id);
  }
  const response = await readPageWhenReady(tab.id);
  if (!response.item.isMarketPage) throw new Error('当前探测页不是 Market 页面');
  if (watch.basePlayerEaId && response.item.eaId !== watch.basePlayerEaId) throw new Error(`基础球员 ID 不匹配：${response.item.eaId}`);
  if (watch.pageId && response.item.pageId !== watch.pageId) throw new Error('FUTBIN 卡片页面 ID 不匹配');
  return response.item;
}

async function notifyRangeChange(watch, oldRange, nextRange) {
  await chrome.notifications.create(`fc27-range-${watch.pageId}-${Date.now()}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('monitor-icon.png'), title: `${watch.name} PC 价格范围已调整`,
    message: `${formatCoins(oldRange.min)}–${formatCoins(oldRange.max)} → ${formatCoins(nextRange.min)}–${formatCoins(nextRange.max)}`,
    contextMessage: `${watch.overall || ''} ${watch.version || ''} · FUTBIN Market`, priority: 2, requireInteraction: true
  });
}

async function notifyPriceAlert(watch, market) {
  const rule = watch.priceRule || {};
  const ruleText = rule.min != null ? `${formatCoins(rule.min)}–${formatCoins(rule.max)}` : `≤ ${formatCoins(rule.max)}`;
  await chrome.notifications.create(`fc27-price-${watch.pageId}-${Date.now()}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('monitor-icon.png'), title: `${watch.name} 已进入低价提醒区间`,
    message: `当前最低 ${formatCoins(market.lowestPrice)}（规则 ${ruleText}）；最低价 ${market.atLowestCount} 张，+5% 内 ${market.within5Count} 张`,
    contextMessage: 'FUTBIN Market 可见最低五档样本', priority: 2, requireInteraction: true
  });
}

function priceMatches(rule, price) {
  if (!rule || rule.max == null || price == null) return false;
  return price <= rule.max && (rule.min == null || price >= rule.min);
}

async function maybeRecordSnapshot(watchId, current, item, force = false) {
  const last = current.lastSnapshotAt ? new Date(current.lastSnapshotAt).getTime() : 0;
  if (!force && Date.now() - last < SNAPSHOT_PERIOD_MS) return false;
  const stored = await chrome.storage.local.get(SNAPSHOT_KEY);
  const all = stored[SNAPSHOT_KEY] || {};
  const list = Array.isArray(all[watchId]) ? all[watchId] : [];
  list.push({
    collectedAt: item.collectedAt || nowIso(), lowestPrice: item.market.lowestPrice,
    visiblePrices: item.market.prices, visibleCount: item.market.visibleCount,
    atLowestCount: item.market.atLowestCount, within5Count: item.market.within5Count,
    within5Limit: item.market.within5Limit, sourceUpdatedLabel: item.updatedLabel || '',
    latestSaleLowestPrice: item.latestSales?.lowestPrice ?? null,
    latestSaleSoldAt: item.latestSales?.soldAt || null,
    latestSaleDisplayTime: item.latestSales?.displayTime || '',
    latestSaleTimeBasis: item.latestSales?.timeBasis || '',
    latestSaleSampleCount: item.latestSales?.sampleCount ?? 0
  });
  all[watchId] = list.slice(-MAX_SNAPSHOTS_PER_CARD);
  current.lastSnapshotAt = list[list.length - 1].collectedAt;
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: all });
  return true;
}

async function checkWatch(watchId, watch, options = {}) {
  if (!watch.enabled || !watch.url) return { status: 'not_configured' };
  try {
    const item = await readWatch(watch, options);
    const stored = await chrome.storage.local.get(WATCH_KEY);
    const watches = stored[WATCH_KEY] || {};
    const current = watches[watchId];
    if (!current) return { status: 'removed' };
    const nextRange = { min: item.priceRange.min, max: item.priceRange.max };
    const oldRange = current.lastRange;
    const rangeChanged = Boolean(oldRange && (oldRange.min !== nextRange.min || oldRange.max !== nextRange.max));
    const alertMatches = priceMatches(current.priceRule, item.market.lowestPrice);
    const shouldAlert = alertMatches && !current.priceAlertActive;
    if (rangeChanged) current.pendingRangeNotification = { from: oldRange, to: nextRange };
    if (shouldAlert) current.pendingPriceAlert = true;
    if (!alertMatches) current.pendingPriceAlert = false;
    current.priceAlertActive = alertMatches;
    current.lastRange = { ...nextRange, checkedAt: nowIso() };
    current.lastPrice = item.market.lowestPrice;
    current.lastMarket = { ...item.market, checkedAt: nowIso() };
    current.lastLatestSales = item.latestSales ? { ...item.latestSales, checkedAt: nowIso() } : null;
    current.lastUpdatedLabel = item.updatedLabel || '';
    const snapshotSaved = await maybeRecordSnapshot(watchId, current, item, options.forceSnapshot === true);
    watches[watchId] = current;
    await chrome.storage.local.set({ [WATCH_KEY]: watches });
    let rangeNotified = false;
    let priceNotified = false;
    if (current.pendingRangeNotification) {
      await notifyRangeChange(current, current.pendingRangeNotification.from, current.pendingRangeNotification.to);
      delete current.pendingRangeNotification;
      await chrome.storage.local.set({ [WATCH_KEY]: watches });
      rangeNotified = true;
    }
    if (current.pendingPriceAlert) {
      await notifyPriceAlert(current, item.market);
      current.pendingPriceAlert = false;
      await chrome.storage.local.set({ [WATCH_KEY]: watches });
      priceNotified = true;
    }
    const messages = [];
    if (rangeNotified) messages.push('价格范围已调整');
    if (priceNotified) messages.push('最低价已进入提醒区间');
    if (snapshotSaved) messages.push('已记录市场样本');
    await setWatchStatus(watchId, { state: 'ok', message: messages.join('；') || '已读取页面，最低价与价格范围未触发通知', checkedAt: nowIso() });
    return { watchId, status: rangeNotified || priceNotified ? 'changed' : 'unchanged', item, rangeChanged: rangeNotified, priceAlert: priceNotified, snapshotSaved };
  } catch (error) {
    await setWatchStatus(watchId, { state: 'error', message: error.message || String(error), checkedAt: nowIso() });
    return { watchId, status: 'error', error: error.message || String(error) };
  }
}

async function checkAll(options = {}) {
  if (currentCheck) {
    if (!options.forceSnapshot) return currentCheck;
    try { await currentCheck; } catch (_) { /* A manual sample still needs its own run. */ }
    return checkAll(options);
  }
  currentCheck = (async () => {
    const watches = await migrateWatches();
    const results = [];
    for (const [watchId, watch] of Object.entries(watches)) results.push(await checkWatch(watchId, watch, options));
    return results;
  })();
  try { return await currentCheck; } finally { currentCheck = null; }
}

chrome.runtime.onInstalled.addListener(() => { ensureMonitor().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureMonitor().catch(() => {}); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === MONITOR_ALARM) checkAll().catch(() => {}); });
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const match = notificationId.match(/^fc27-(?:range|price)-(\d+)-/);
  if (!match) return;
  const watches = await migrateWatches();
  const url = Object.values(watches).find((watch) => watch.pageId === match[1])?.url;
  if (url) await chrome.tabs.create({ url, active: true });
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'FC27_CHECK_RANGES_NOW') {
    checkAll({ reload: message.reload !== false, forceSnapshot: message.forceSnapshot === true }).then((results) => sendResponse({ ok: true, results })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === 'FC27_TEST_RANGE_NOTIFICATION') {
    chrome.notifications.create(`fc27-range-test-${Date.now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('monitor-icon.png'), title: 'FC27 市场监控测试', message: 'Windows 桌面通知工作正常。', priority: 2 })
      .then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});

ensureMonitor().catch(() => {});
