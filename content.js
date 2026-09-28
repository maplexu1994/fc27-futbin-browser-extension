(() => {
  if (globalThis.__fc27MarketMonitorContentV3) return;
  globalThis.__fc27MarketMonitorContentV3 = true;
  function productIdentity() {
    const found = [];
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== 'object') return;
      if (value['@type'] === 'Product') {
        const imageValue = typeof value.image === 'string' ? value.image : value.image?.['@id'] || value.image?.url || '';
        const match = imageValue.match(/\/content\/fifa27\/img\/players\/(\d+)\.png/i);
        if (match) {
          const props = Object.fromEntries((value.additionalProperty || []).filter(Boolean).map((item) => [item.name, item.value]));
          found.push({ eaId: match[1], overall: props['Overall Rating'] == null ? '' : String(props['Overall Rating']), cardType: props['Card Type'] == null ? '' : String(props['Card Type']), productName: typeof value.name === 'string' ? value.name : '' });
        }
      }
      Object.values(value).forEach(walk);
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(script.textContent)); } catch (_) { /* Ignore unrelated JSON-LD. */ }
    }
    const unique = [...new Map(found.map((item) => [JSON.stringify(item), item])).values()];
    if (unique.length !== 1) throw new Error('页面中没有唯一的 FC27 EA ID，无法安全匹配。');
    return unique[0];
  }

  function parseCoins(text) {
    const normalized = String(text || '').replace(/[\s,]/g, '');
    if (!/^\d+$/.test(normalized)) return null;
    const value = Number(normalized);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function parsePriceRange(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const match = normalized.match(/(?:Price\s*Range|价格范围)\s*[:：]?\s*([\d,]+)\s*(?:-|–|—|to|至)\s*([\d,]+)/i);
    if (!match) return null;
    const values = match.slice(1).map((value) => Number(value.replace(/,/g, '')));
    return values.every((value) => Number.isSafeInteger(value) && value > 0) ? { min: values[0], max: values[1] } : null;
  }

  function elementDistance(first, second) {
    const a = first.getBoundingClientRect();
    const b = second.getBoundingClientRect();
    if (!(a.width || a.height || b.width || b.height)) return Number.MAX_SAFE_INTEGER;
    return Math.hypot(a.left + a.width / 2 - b.left - b.width / 2, a.top + a.height / 2 - b.top - b.height / 2);
  }

  function readPriceRangeNear(box) {
    const direct = parsePriceRange(box.innerText);
    if (direct) return direct;
    const candidates = [];
    const add = (element, penalty = 0) => {
      if (!(element instanceof HTMLElement)) return;
      const range = parsePriceRange(element.innerText);
      if (range) candidates.push({ range, score: elementDistance(box, element) + penalty });
    };
    let branch = box;
    for (let depth = 0; branch && depth < 5; depth++, branch = branch.parentElement) {
      add(branch.previousElementSibling, depth * 100);
      add(branch.nextElementSibling, depth * 100);
      if (branch.parentElement) for (const sibling of branch.parentElement.children) if (sibling !== branch) add(sibling, depth * 150);
    }
    for (const label of [...document.querySelectorAll('[class*="range" i], div, span, p')].filter((element) => /Price\s*Range|价格范围/i.test(element.innerText || '') && (element.innerText || '').length < 180)) {
      add(label); add(label.parentElement, 25); add(label.parentElement?.parentElement, 75);
    }
    candidates.sort((left, right) => left.score - right.score);
    return candidates[0]?.range || null;
  }

  function visiblePcListings(box) {
    const slots = [...box.querySelectorAll('[class*="lowest-price-"]')]
      .map((element) => {
        const match = [...element.classList].join(' ').match(/lowest-price-(\d+)/);
        return { slot: match ? Number(match[1]) : 999, price: parseCoins(element.textContent) };
      })
      .filter((item) => item.price != null)
      .sort((a, b) => a.slot - b.slot);
    const bySlot = new Map();
    for (const item of slots) if (!bySlot.has(item.slot)) bySlot.set(item.slot, item.price);
    const prices = [...bySlot.values()].slice(0, 5);
    const lowestPrice = prices.length ? Math.min(...prices) : null;
    const within5Limit = lowestPrice == null ? null : Math.floor(lowestPrice * 1.05);
    return { prices, lowestPrice, visibleCount: prices.length, atLowestCount: lowestPrice == null ? 0 : prices.filter((price) => price === lowestPrice).length, within5Count: within5Limit == null ? 0 : prices.filter((price) => price <= within5Limit).length, within5Limit };
  }

  function saleTimestampNear(element) {
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      for (const name of ['datetime', 'data-timestamp', 'data-time', 'data-date', 'title']) {
        const value = current.getAttribute?.(name);
        if (globalThis.fc27SalesParser.parseAbsoluteTimestamp(value)) return value;
      }
      if (current.querySelector?.('time[datetime]')) {
        const value = current.querySelector('time[datetime]').getAttribute('datetime');
        if (globalThis.fc27SalesParser.parseAbsoluteTimestamp(value)) return value;
      }
      if (current.children.length > 4) break;
    }
    return null;
  }

  function readLatestSales(box, pageId) {
    if (!globalThis.fc27SalesParser) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const headings = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (/^(?:Latest Sales|最近销售|最新销售)$/i.test(node.textContent.trim()) &&
          !node.parentElement?.closest('script, style, template')) headings.push(node);
    }
    if (!headings.length) return null;
    const pcHeadings = headings.filter((node) => node.parentElement?.closest('.platform-pc-only, [data-platform="pc"], [data-platform="PC"]'));
    let heading = pcHeadings.length === 1 ? pcHeadings[0] : null;
    if (!heading) {
      const priceBoxes = [...document.querySelectorAll('div.price-box[data-id]')]
        .filter((element) => element.getAttribute('data-id') === pageId);
      const pcIndex = priceBoxes.indexOf(box);
      if (pcIndex >= 0 && headings.length === priceBoxes.length) heading = headings[pcIndex];
      if (!heading && headings.length === 1 &&
          priceBoxes.filter((element) => element.getClientRects?.().length).length === 1 &&
          box.getClientRects?.().length) heading = headings[0];
    }
    if (!heading) return null;

    walker.currentNode = heading;
    const fragments = [];
    const dateTimestamps = [];
    while (walker.nextNode() && fragments.length < 100) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script, style, template')) continue;
      const value = node.textContent.replace(/\s+/g, ' ').trim();
      if (!value) continue;
      const stopAt = value.search(/(?:Full History|Cheapest Sale|Latest Sales|完整历史|最低成交价|最近销售|最新销售)/i);
      if (stopAt >= 0) {
        if (stopAt > 0) fragments.push(value.slice(0, stopAt));
        break;
      }
      fragments.push(value);
      if (/^(?:[A-Z][a-z]{2}\s+\d{1,2}|\d{1,2}月\d{1,2}日)/.test(value)) {
        dateTimestamps.push(saleTimestampNear(node.parentElement));
      }
    }
    const sales = globalThis.fc27SalesParser.parseLatestSalesText(fragments.join(' '));
    return globalThis.fc27SalesParser.lowestVisibleSale(sales, dateTimestamps);
  }

  function readPage() {
    const match = location.pathname.match(/^\/27\/player\/(\d+)\/[^/]+(?:\/market)?\/?$/);
    if (!match) throw new Error('请先打开 FUTBIN FC27 球员详情页或市场页。');
    const pageId = match[1];
    const boxes = [...document.querySelectorAll('div.price-box.platform-pc-only[data-id]')].filter((element) => element.getAttribute('data-id') === pageId);
    if (boxes.length !== 1) throw new Error('找不到与当前卡片 ID 匹配的 PC 价格框，请等页面价格加载后重试。');
    const box = boxes[0];
    const market = visiblePcListings(box);
    const latestSales = /\/market\/?$/.test(location.pathname) ? readLatestSales(box, pageId) : null;
    const priceRange = readPriceRangeNear(box);
    const path = location.pathname.replace(/\/$/, '').replace(/\/market$/, '');
    return {
      ...productIdentity(), pageId, url: location.href, marketUrl: `${location.origin}${path}/market`,
      isMarketPage: /\/market\/?$/.test(location.pathname), market, latestSales, priceRange,
      rangeDebug: priceRange ? '' : [box.innerText, box.nextElementSibling?.innerText, box.parentElement?.innerText].filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 300),
      updatedLabel: (box.querySelector('.prices-updated')?.textContent || '').replace(/\s+/g, ' ').trim(), collectedAt: new Date().toISOString()
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'FC27_READ_FUTBIN_MARKET_V3') return;
    try { sendResponse({ ok: true, item: readPage() }); } catch (error) { sendResponse({ ok: false, error: error.message || String(error) }); }
    return true;
  });
})();
