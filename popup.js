const WATCH_KEY = 'fc27PriceRangeWatchesV1';
const STATUS_KEY = 'fc27PriceRangeStatusV1';
const SNAPSHOT_KEY = 'fc27MarketSnapshotsV1';
const $ = (id) => document.getElementById(id);

function status(message, kind = '') {
  $('status').textContent = message;
  $('status').className = `status ${kind}`;
}

function toMarketUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^(\/27\/player\/\d+\/[^/]+)(?:\/market)?\/?$/);
    return match ? `${url.origin}${match[1]}/market` : '';
  } catch (_) { return ''; }
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadFile(filename, content, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(filename, fields, rows) {
  const content = '\uFEFF' + [fields.join(','), ...rows.map((row) => fields.map((field) => csvEscape(row[field])).join(','))].join('\r\n') + '\r\n';
  downloadFile(filename, content, 'text/csv;charset=utf-8');
}

const formatCoins = (value) => value == null ? '—' : Number(value).toLocaleString('en-US');
function formatRange(range) {
  return range ? `${formatCoins(range.min)}–${formatCoins(range.max)} 金币` : '尚未建立价格范围基线';
}
function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatBeijingTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date);
}

function correctedSaleTime(displayTime, soldAt, timeBasis, referenceTime) {
  return globalThis.fc27SalesParser.correctLegacySaleTime(displayTime, soldAt, timeBasis, referenceTime);
}

async function readFutbinPage(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['sales-parser.js', 'content.js'] });
  } catch (_) {
    // sendMessage below returns the actionable error when the page cannot be probed.
  }
  return chrome.tabs.sendMessage(tabId, { type: 'FC27_READ_FUTBIN_MARKET_V3' });
}

async function migrateWatches() {
  const stored = await chrome.storage.local.get([WATCH_KEY, STATUS_KEY]);
  const watches = stored[WATCH_KEY] || {};
  const statuses = stored[STATUS_KEY] || {};
  const migrated = {}, migratedStatuses = { ...statuses };
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
    if (watchId !== oldKey || watch.url !== original.url || !original.priceRule) changed = true;
  }
  if (changed) await chrome.storage.local.set({ [WATCH_KEY]: migrated, [STATUS_KEY]: migratedStatuses });
  return migrated;
}

async function openWatchTab(watch) {
  const wanted = toMarketUrl(watch.url);
  const tabs = await chrome.tabs.query({ url: 'https://www.futbin.com/27/player/*' });
  const existing = tabs.find((tab) => toMarketUrl(tab.url) === wanted && /\/market\/?$/.test(new URL(tab.url).pathname));
  if (existing?.id) return chrome.tabs.update(existing.id, { pinned: true, active: false });
  return chrome.tabs.create({ url: wanted, active: false, pinned: true });
}

async function removeWatch(watchId) {
  const stored = await chrome.storage.local.get([WATCH_KEY, STATUS_KEY, SNAPSHOT_KEY]);
  const watches = stored[WATCH_KEY] || {}, statuses = stored[STATUS_KEY] || {}, snapshots = stored[SNAPSHOT_KEY] || {};
  delete watches[watchId]; delete statuses[watchId]; delete snapshots[watchId];
  await chrome.storage.local.set({ [WATCH_KEY]: watches, [STATUS_KEY]: statuses, [SNAPSHOT_KEY]: snapshots });
}

async function saveRule(watchId, minText, maxText) {
  const min = minText.trim() ? Number(minText.replace(/,/g, '')) : null;
  const max = maxText.trim() ? Number(maxText.replace(/,/g, '')) : null;
  if (min != null && (!Number.isSafeInteger(min) || min <= 0)) throw new Error('提醒下限必须是正整数。');
  if (max != null && (!Number.isSafeInteger(max) || max <= 0)) throw new Error('提醒最高价必须是正整数。');
  if (min != null && max == null) throw new Error('设置下限时也要填写最高价。');
  if (min != null && min > max) throw new Error('提醒下限不能高于最高价。');
  const stored = await chrome.storage.local.get(WATCH_KEY);
  const watches = stored[WATCH_KEY] || {};
  if (!watches[watchId]) throw new Error('这张卡已不在监控列表中。');
  const previous = watches[watchId].priceRule || {};
  if (previous.min !== min || previous.max !== max) {
    watches[watchId].priceRule = { min, max };
    watches[watchId].priceAlertActive = false;
    watches[watchId].pendingPriceAlert = false;
  }
  await chrome.storage.local.set({ [WATCH_KEY]: watches });
}

async function renderMonitor() {
  const watches = await migrateWatches();
  const stored = await chrome.storage.local.get([STATUS_KEY, SNAPSHOT_KEY]);
  const statuses = stored[STATUS_KEY] || {}, snapshots = stored[SNAPSHOT_KEY] || {};
  const entries = Object.entries(watches).filter(([, watch]) => watch.url);
  $('monitorState').textContent = `${entries.length} 张`;
  $('monitorMessage').textContent = entries.length ? '前台页面不强制刷新；后台 Market 页每分钟刷新，每 15 分钟保存样本。' : '打开任意 FUTBIN FC27 卡片后，点击“添加当前卡片”。';
  const list = $('monitorPlayers'); list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('li'); empty.className = 'empty'; empty.textContent = '尚未添加监控卡片'; list.append(empty); return;
  }
  for (const [watchId, watch] of entries) {
    const monitorStatus = statuses[watchId], market = watch.lastMarket;
    const latestSales = watch.lastLatestSales ? {
      ...watch.lastLatestSales,
      ...correctedSaleTime(watch.lastLatestSales.displayTime, watch.lastLatestSales.soldAt,
        watch.lastLatestSales.timeBasis, watch.lastLatestSales.checkedAt)
    } : null;
    const sampleCount = (snapshots[watchId] || []).length;
    const li = document.createElement('li'); li.className = 'monitor-card';
    const head = document.createElement('div'); head.className = 'monitor-card-head';
    const identity = document.createElement('span');
    const name = document.createElement('strong'); name.textContent = watch.name || `FUTBIN 卡片 ${watch.pageId}`;
    const meta = document.createElement('small'); meta.textContent = `${watch.overall || '?'} · ${watch.version || '版本未知'} · FUTBIN ${watch.pageId}`;
    identity.append(name, meta);
    const stateTag = document.createElement('span'); stateTag.className = `tag ${monitorStatus?.state === 'error' ? 'empty-price' : 'done'}`;
    stateTag.textContent = monitorStatus?.state === 'error' ? '需处理' : '监控中'; head.append(identity, stateTag);

    const price = document.createElement('div'); price.className = 'monitor-price';
    price.textContent = `${monitorStatus?.state === 'error' ? '上次读到的最低价' : '最低价'} ${formatCoins(market?.lowestPrice ?? watch.lastPrice)}`;
    const depth = document.createElement('div'); depth.className = 'monitor-depth';
    depth.textContent = market ? `可见 ${market.visibleCount}/5 档 · 最低价 ${market.atLowestCount} 张 · +5% 内 ${market.within5Count} 张` : '等待首次 Market 深度采样';
    const sales = document.createElement('div'); sales.className = 'monitor-sales';
    if (latestSales?.lowestPrice) {
      const beijing = formatBeijingTime(latestSales.soldAt);
      const timeText = beijing ? `北京时间 ${beijing}${latestSales.timeBasis === 'uk-wall' ? '（由英国时间换算）' : ''}` : `页面时间 ${latestSales.displayTime || '未提供'}（无法确认具体时刻）`;
      sales.textContent = `${monitorStatus?.state === 'error' ? '上次读到的 ' : ''}Latest Sales 最低成交 ${formatCoins(latestSales.lowestPrice)} · ${timeText} · 显示 ${latestSales.sampleCount} 笔`;
    } else {
      sales.textContent = 'Latest Sales：当前 PC 栏目没有可解析的销售记录';
    }
    const range = document.createElement('div'); range.className = 'monitor-range'; range.textContent = `EA 价格范围：${formatRange(watch.lastRange)}`;

    const rule = document.createElement('div'); rule.className = 'rule-row';
    const min = document.createElement('input'); min.type = 'text'; min.inputMode = 'numeric'; min.placeholder = '下限（可空）'; min.value = watch.priceRule?.min ?? '';
    const max = document.createElement('input'); max.type = 'text'; max.inputMode = 'numeric'; max.placeholder = '提醒最高价'; max.value = watch.priceRule?.max ?? '';
    const save = document.createElement('button'); save.textContent = '保存提醒';
    save.addEventListener('click', async () => {
      try { await saveRule(watchId, min.value, max.value); status(`已保存 ${watch.name} 的最低价提醒。`, 'success'); await renderMonitor(); }
      catch (error) { status(error.message || String(error), 'error'); }
    });
    rule.append(min, max, save);
    const ruleHelp = document.createElement('div'); ruleHelp.className = 'monitor-status';
    ruleHelp.textContent = '只填最高价表示“≤ 该价格”；上下限都填表示区间提醒。清空两项可关闭。';
    const checkedAt = formatTime(monitorStatus?.checkedAt || market?.checkedAt);
    const detail = document.createElement('div');
    if (monitorStatus?.state === 'error') {
      detail.className = 'monitor-error';
      detail.textContent = `读取失败：${monitorStatus.message || '未知错误'}${checkedAt ? ` · 尝试于 ${checkedAt}` : ''}${market?.checkedAt ? ` · 上次成功 ${formatTime(market.checkedAt)}` : ''}`;
    } else {
      detail.className = 'monitor-status';
      detail.textContent = `${monitorStatus?.message || '等待首次检查'}${checkedAt ? ` · 最近检查 ${checkedAt}` : ''} · 已存 ${sampleCount} 条`;
    }
    const actions = document.createElement('div'); actions.className = 'monitor-card-actions';
    const open = document.createElement('button'); open.textContent = '打开 Market';
    open.addEventListener('click', async () => { await openWatchTab(watch); status(`已打开 ${watch.name} 的 Market 监控页。`, 'success'); });
    const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '移除';
    remove.addEventListener('click', async () => { await removeWatch(watchId); await renderMonitor(); status(`已移除 ${watch.name} 的监控和历史。`, 'success'); });
    actions.append(open, remove);
    li.append(head, price, depth, sales, range, rule, ruleHelp, detail, actions); list.append(li);
  }
}

$('browsePlayers').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'https://www.futbin.com/27/players', active: true });
  status('已打开球员目录。选择对应卡片后可从详情页直接添加，扩展会切换到 Market 页。');
});

$('bindMonitor').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith('https://www.futbin.com/27/player/')) throw new Error('请先打开任意 FUTBIN FC27 球员详情页或 Market 页。');
    const response = await readFutbinPage(tab.id);
    if (!response?.ok) throw new Error(response?.error || '无法读取当前 FUTBIN 页面。');
    const item = response.item;
    if (!item.priceRange) throw new Error(`已找到 PC 价格框，但无法解析价格范围。${item.rangeDebug ? ` 附近页面文字：${item.rangeDebug}` : ''}`);
    const watches = await migrateWatches();
    const watchId = `futbin:${item.pageId}`, existing = watches[watchId];
    const name = item.productName || `FUTBIN 卡片 ${item.pageId}`;
    watches[watchId] = {
      ...(existing || {}), watchId, basePlayerEaId: item.eaId, name, version: item.cardType || 'Unknown',
      overall: item.overall || '', enabled: true, url: item.marketUrl || toMarketUrl(item.url), pageId: item.pageId,
      priceRule: existing?.priceRule || { min: null, max: null },
      lastRange: existing?.lastRange || { ...item.priceRange, checkedAt: new Date().toISOString() },
      lastPrice: item.market?.lowestPrice ?? existing?.lastPrice ?? null,
      lastMarket: item.market?.lowestPrice ? { ...item.market, checkedAt: new Date().toISOString() } : existing?.lastMarket,
      lastLatestSales: item.isMarketPage ? (item.latestSales ? { ...item.latestSales, checkedAt: new Date().toISOString() } : null) : existing?.lastLatestSales
    };
    await chrome.storage.local.set({ [WATCH_KEY]: watches });
    await chrome.tabs.update(tab.id, { url: watches[watchId].url, pinned: true });
    await renderMonitor();
    status(`${existing ? '已更新' : '已添加'} ${name}；监控页已切换到 Market。`, 'success');
  } catch (error) { status(error.message || String(error), 'error'); }
});

$('openMonitors').addEventListener('click', async () => {
  const watches = Object.values(await migrateWatches()).filter((watch) => watch.url);
  if (!watches.length) return status('尚未添加任何监控卡片。', 'error');
  for (const watch of watches) await openWatchTab(watch);
  status(`已在后台打开并置顶 ${watches.length} 个 Market 监控页。`, 'success');
});

$('checkMonitor').addEventListener('click', async () => {
  status('正在刷新全部 Market 页并记录当前样本…');
  const response = await chrome.runtime.sendMessage({ type: 'FC27_CHECK_RANGES_NOW', reload: true, forceSnapshot: true });
  await renderMonitor();
  const results = response?.results || [], failures = results.filter((result) => result.status === 'error');
  const alerts = results.filter((result) => result.rangeChanged || result.priceAlert);
  const saved = results.filter((result) => result.snapshotSaved).length;
  if (!response?.ok || failures.length) status(failures.length ? `${failures.length} 张检查失败，请查看卡片状态。` : response?.error || '检查失败。', 'error');
  else if (!results.length) status('尚未添加任何监控卡片。', 'error');
  else status(`已检查 ${results.length} 张卡，记录 ${saved} 条样本${alerts.length ? `，触发 ${alerts.length} 个通知` : ''}。`, 'success');
});

$('exportHistory').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get([WATCH_KEY, SNAPSHOT_KEY]);
  const watches = stored[WATCH_KEY] || {}, snapshots = stored[SNAPSHOT_KEY] || {};
  const fields = ['watch_id', 'name', 'version', 'futbin_page_id', 'collected_at', 'lowest_price', 'visible_prices', 'visible_count', 'at_lowest_count', 'within_5_percent_count', 'within_5_percent_limit', 'latest_sale_lowest_price', 'latest_sale_sold_at', 'latest_sale_beijing_time', 'latest_sale_page_time', 'latest_sale_time_basis', 'latest_sale_sample_count', 'source_updated_label'];
  const rows = [];
  for (const [watchId, list] of Object.entries(snapshots)) {
    const watch = watches[watchId] || {};
    for (const item of list) {
      const corrected = correctedSaleTime(item.latestSaleDisplayTime, item.latestSaleSoldAt,
        item.latestSaleTimeBasis, item.collectedAt);
      rows.push({ watch_id: watchId, name: watch.name || '', version: watch.version || '', futbin_page_id: watch.pageId || '', collected_at: item.collectedAt, lowest_price: item.lowestPrice, visible_prices: (item.visiblePrices || []).join('|'), visible_count: item.visibleCount, at_lowest_count: item.atLowestCount, within_5_percent_count: item.within5Count, within_5_percent_limit: item.within5Limit, latest_sale_lowest_price: item.latestSaleLowestPrice ?? '', latest_sale_sold_at: corrected.soldAt || '', latest_sale_beijing_time: formatBeijingTime(corrected.soldAt), latest_sale_page_time: item.latestSaleDisplayTime || '', latest_sale_time_basis: corrected.timeBasis || '', latest_sale_sample_count: item.latestSaleSampleCount ?? '', source_updated_label: item.sourceUpdatedLabel || '' });
    }
  }
  if (!rows.length) return status('还没有市场记录；先点击“立即检查并记录”。', 'error');
  downloadCsv('futbin-market-history.csv', fields, rows);
  status(`已导出 ${rows.length} 条市场记录。`, 'success');
});

$('testNotification').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'FC27_TEST_RANGE_NOTIFICATION' });
  status(response?.ok ? '测试通知已发送。' : response?.error || '无法发送测试通知。', response?.ok ? 'success' : 'error');
});

$('exportBackup').addEventListener('click', async () => {
  try {
    const watches = await migrateWatches();
    const stored = await chrome.storage.local.get(SNAPSHOT_KEY);
    const backup = globalThis.fc27MonitorBackup.createBackup(watches, stored[SNAPSHOT_KEY] || {});
    downloadFile(`fc27-market-monitor-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(backup, null, 2), 'application/json;charset=utf-8');
    status(`已备份 ${Object.keys(backup.watches).length} 张监控卡片及市场历史。`, 'success');
  } catch (error) { status(error.message || String(error), 'error'); }
});

$('importBackup').addEventListener('click', () => {
  $('backupFile').click();
});

$('backupFile').addEventListener('change', async (event) => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) throw new Error('备份文件超过 25 MB，无法导入。');
    const backup = JSON.parse(await file.text());
    const watches = await migrateWatches();
    const stored = await chrome.storage.local.get(SNAPSHOT_KEY);
    const result = globalThis.fc27MonitorBackup.mergeBackup(backup, watches, stored[SNAPSHOT_KEY] || {});
    await chrome.storage.local.set({ [WATCH_KEY]: result.watches, [SNAPSHOT_KEY]: result.snapshots });
    await renderMonitor();
    status(`已恢复 ${result.imported} 张卡片和 ${result.historyCount} 条备份记录；现有监控规则优先。请点击“打开全部 Market 页”。`, 'success');
  } catch (error) { status(error.message || String(error), 'error'); }
  event.target.value = '';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[WATCH_KEY] || changes[STATUS_KEY] || changes[SNAPSHOT_KEY])) renderMonitor().catch(() => {});
});

renderMonitor().catch((error) => status(error.message || String(error), 'error'));
