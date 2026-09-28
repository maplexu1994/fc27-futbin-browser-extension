const CSV_FIELDS = ['card_id', 'game', 'player_id', 'name', 'version', 'source', 'source_card_id', 'market', 'price_type', 'price', 'source_time', 'collected_at', 'demo'];
const WATCH_KEY = 'fc27PriceRangeWatchesV1';
const STATUS_KEY = 'fc27PriceRangeStatusV1';
const SNAPSHOT_KEY = 'fc27MarketSnapshotsV1';
const state = { cards: [], captures: {}, urls: {} };
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

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false; else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  const headers = (rows.shift() || []).map((item) => item.trim().replace(/^\uFEFF/, ''));
  return rows.filter((values) => values.some((item) => item.trim())).map((values) => Object.fromEntries(headers.map((key, index) => [key, (values[index] || '').trim()])));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename, fields, rows) {
  const content = '\uFEFF' + [fields.join(','), ...rows.map((row) => fields.map((field) => csvEscape(row[field])).join(','))].join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function rowsForExport() {
  return Object.values(state.captures).filter((item) => item.price != null).map((item) => ({
    card_id: item.card.card_id, game: 'FC27', player_id: item.card.player_id, name: item.card.name,
    version: item.card.version, source: 'futbin', source_card_id: item.pageId, market: 'pc',
    price_type: 'reference_lowest', price: item.price, source_time: item.updatedLabel || '',
    collected_at: item.collectedAt, demo: '0'
  }));
}

async function persist() {
  await chrome.storage.local.set({ fc27Cards: state.cards, fc27Captures: state.captures, fc27FutbinUrlsV2: state.urls });
}

function renderBatch() {
  const done = state.cards.filter((card) => state.captures[card.ea_id]).length;
  $('count').textContent = state.cards.length ? `${done} / ${state.cards.length} 已采集` : '未加载批次';
  $('exportCsv').disabled = rowsForExport().length === 0;
  $('openNext').disabled = state.cards.length === 0;
  $('capture').disabled = state.cards.length === 0;
  const list = $('players'); list.replaceChildren();
  if (!state.cards.length) {
    const li = document.createElement('li'); li.className = 'empty'; li.textContent = '尚未加载批次'; list.append(li); return;
  }
  for (const card of state.cards) {
    const li = document.createElement('li');
    const label = document.createElement('span'); label.textContent = `${card.name} · ${card.version}`;
    const sub = document.createElement('small'); sub.textContent = `EA ID ${card.ea_id} · ${card.overall || '评分未填'}`; label.append(sub);
    const tag = document.createElement('span'); const captured = state.captures[card.ea_id];
    tag.className = `tag ${captured ? (captured.price == null ? 'empty-price' : 'done') : ''}`;
    tag.textContent = captured ? (captured.price == null ? '无报价' : captured.price.toLocaleString()) : '待采集';
    li.append(label, tag); list.append(li);
  }
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
  watches[watchId].priceRule = { min, max };
  watches[watchId].priceAlertActive = false;
  await chrome.storage.local.set({ [WATCH_KEY]: watches });
}

async function renderMonitor() {
  const watches = await migrateWatches();
  const stored = await chrome.storage.local.get([STATUS_KEY, SNAPSHOT_KEY]);
  const statuses = stored[STATUS_KEY] || {}, snapshots = stored[SNAPSHOT_KEY] || {};
  const entries = Object.entries(watches).filter(([, watch]) => watch.url);
  $('monitorState').textContent = `${entries.length} 张`;
  $('monitorState').className = `tag ${entries.length ? 'done' : ''}`;
  $('monitorMessage').textContent = entries.length ? 'Market 页报价和 Latest Sales 每分钟检查；每 15 分钟保存样本。' : '打开任意 FUTBIN FC27 卡片后，点击“添加当前卡片”。';
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

async function loadPersisted() {
  const stored = await chrome.storage.local.get(['fc27Cards', 'fc27Captures', 'fc27FutbinUrlsV2']);
  state.cards = stored.fc27Cards || []; state.captures = stored.fc27Captures || {}; state.urls = stored.fc27FutbinUrlsV2 || {};
  for (const key of Object.keys(state.urls)) state.urls[key] = toMarketUrl(state.urls[key]) || state.urls[key];
  renderBatch(); await renderMonitor();
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
      lastPrice: item.market?.lowestPrice ?? item.price,
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
  if (!response?.ok || failures.length) status(failures.length ? `${failures.length} 张检查失败，请查看卡片状态。` : response?.error || '检查失败。', 'error');
  else if (!results.length) status('尚未添加任何监控卡片。', 'error');
  else status(`已检查并记录 ${results.length} 张卡${alerts.length ? `，触发 ${alerts.length} 个通知` : ''}。`, 'success');
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

$('cardsFile').addEventListener('change', async (event) => {
  try {
    const file = event.target.files[0]; if (!file) return;
    const cards = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
    if (!cards.length || cards.length > 10) throw new Error('cards.csv 必须包含 1 到 10 张卡。');
    const seen = new Set();
    for (const card of cards) {
      if (card.game !== 'FC27' || !/^\d+$/.test(card.ea_id || '') || !card.card_id || !card.player_id || !card.name || !card.version) throw new Error('cards.csv 缺少必需字段或不是 FC27 球员卡。');
      if (seen.has(card.ea_id)) throw new Error(`批次中 EA ID 重复：${card.ea_id}`);
      seen.add(card.ea_id);
    }
    state.cards = cards; state.captures = {}; await persist(); renderBatch();
    status(`已加载 ${cards.length} 张卡。`, 'success');
  } catch (error) { status(error.message || String(error), 'error'); }
  event.target.value = '';
});

$('openNext').addEventListener('click', async () => {
  const card = state.cards.find((item) => !state.captures[item.ea_id]);
  if (!card) return status('本批次的卡片都已完成。', 'success');
  const knownUrl = toMarketUrl(state.urls[card.ea_id]);
  if (!knownUrl) await chrome.storage.local.set({ fc27PendingSearch: { eaId: card.ea_id, name: card.name, overall: card.overall || '' } });
  await chrome.tabs.create({ url: knownUrl || 'https://www.futbin.com/27/players', active: true });
  status(knownUrl ? `已打开 ${card.name} 的 Market 页。` : `已打开球员目录，请选择 ${card.name} 的正确版本。`);
});

$('capture').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith('https://www.futbin.com/27/player/')) throw new Error('请先打开 FUTBIN FC27 球员页。');
    const response = await readFutbinPage(tab.id);
    if (!response?.ok) throw new Error(response?.error || '无法读取当前页面。');
    const item = response.item;
    const card = state.cards.find((candidate) => candidate.ea_id === item.eaId || candidate.player_id === item.eaId);
    if (!card) throw new Error(`页面基础球员 ID ${item.eaId} 不在当前批次。`);
    if (card.overall && item.overall && card.overall !== item.overall) throw new Error(`评分不匹配：工具目录 ${card.overall}，FUTBIN ${item.overall}。`);
    state.captures[card.ea_id] = { card, ...item };
    state.urls[card.ea_id] = item.marketUrl || toMarketUrl(item.url);
    await persist(); renderBatch();
    status(item.price == null ? `已核对 ${card.name}，但当前没有有效 PC 报价。` : `已采集 ${card.name}：${formatCoins(item.price)} 金币。`, item.price == null ? '' : 'success');
  } catch (error) { status(error.message || String(error), 'error'); }
});

$('exportCsv').addEventListener('click', () => {
  const rows = rowsForExport(); downloadCsv('futbin-prices.csv', CSV_FIELDS, rows);
  status(`已导出 ${rows.length} 条报价。`, 'success');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[WATCH_KEY] || changes[STATUS_KEY] || changes[SNAPSHOT_KEY])) renderMonitor().catch(() => {});
});

loadPersisted().catch((error) => status(error.message || String(error), 'error'));
