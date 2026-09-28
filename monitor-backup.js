(() => {
  const FORMAT = 'fc27-futbin-market-monitor';
  const MAX_SNAPSHOTS_PER_CARD = 672;

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeWatch(key, value) {
    if (!object(value)) throw new Error(`监控卡片 ${key} 的数据无效。`);
    const pageId = String(value.pageId || '');
    if (!/^\d+$/.test(pageId) || key !== `futbin:${pageId}`) throw new Error(`监控卡片 ${key} 的 ID 无效。`);
    let url;
    try { url = new URL(value.url); } catch (_) { throw new Error(`监控卡片 ${key} 的 Market 链接无效。`); }
    const match = url.pathname.match(/^\/27\/player\/(\d+)\/[^/]+\/market\/?$/);
    if (url.protocol !== 'https:' || url.hostname !== 'www.futbin.com' || !match || match[1] !== pageId) {
      throw new Error(`监控卡片 ${key} 的 Market 链接与卡片 ID 不匹配。`);
    }
    return { ...value, watchId: key, pageId, url: `${url.origin}${url.pathname.replace(/\/$/, '')}` };
  }

  function validateSnapshots(key, list) {
    if (!Array.isArray(list)) throw new Error(`监控卡片 ${key} 的历史记录无效。`);
    for (const item of list) {
      if (!object(item) || typeof item.collectedAt !== 'string' || !Number.isFinite(Date.parse(item.collectedAt))) {
        throw new Error(`监控卡片 ${key} 存在无效的历史记录时间。`);
      }
    }
    return list;
  }

  function createBackup(watches, snapshots) {
    const normalized = {};
    for (const [key, watch] of Object.entries(watches || {})) normalized[key] = normalizeWatch(key, watch);
    const history = {};
    for (const [key, list] of Object.entries(snapshots || {})) {
      if (!normalized[key]) continue;
      history[key] = validateSnapshots(key, list).slice(-MAX_SNAPSHOTS_PER_CARD);
    }
    return { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), watches: normalized, snapshots: history };
  }

  function mergeBackup(backup, currentWatches, currentSnapshots) {
    if (!object(backup) || backup.format !== FORMAT || backup.version !== 1 || !object(backup.watches) || !object(backup.snapshots)) {
      throw new Error('文件不是受支持的 FC27 市场监控备份。');
    }
    const watches = { ...(currentWatches || {}) };
    const snapshots = { ...(currentSnapshots || {}) };
    let imported = 0;
    let historyCount = 0;
    for (const [key, value] of Object.entries(backup.watches)) {
      const incoming = normalizeWatch(key, value);
      watches[key] = watches[key] || incoming;
      imported++;
    }
    for (const [key, list] of Object.entries(backup.snapshots)) {
      if (!Object.hasOwn(backup.watches, key)) throw new Error(`历史记录 ${key} 没有对应的监控卡片。`);
      const incoming = validateSnapshots(key, list);
      const existing = validateSnapshots(key, snapshots[key] || []);
      const unique = new Map([...existing, ...incoming].map((item) => [JSON.stringify(item), item]));
      snapshots[key] = [...unique.values()]
        .sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt))
        .slice(-MAX_SNAPSHOTS_PER_CARD);
      historyCount += incoming.length;
    }
    return { watches, snapshots, imported, historyCount };
  }

  const api = { createBackup, mergeBackup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.fc27MonitorBackup = api;
})();
