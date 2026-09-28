const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const salesParser = require('./sales-parser.js');

test('Market probe reads the PC Latest Sales block rather than console sales', () => {
  const body = {};
  const textNode = (value, datetime = null) => ({
    textContent: value,
    parentElement: {
      parentElement: body,
      children: [],
      closest() { return null; },
      getAttribute(name) { return name === 'datetime' ? datetime : null; },
      querySelector() { return null; }
    }
  });
  const textNodes = [
    textNode('Latest Sales'), textNode('Sep 28, 8:50 AM'), textNode('12K'),
    textNode('Full History'),
    textNode('Latest Sales'), textNode('Sep 28, 8:49 AM'), textNode('23.5K'),
    textNode('Sep 28, 8:12 AM', '2026-09-28T08:12:00Z'), textNode('21.5K'),
    textNode('Full History')
  ];
  let listener;
  const consoleBox = { getAttribute() { return '559'; } };
  const prices = [22000, 22250, 22500, 22750, 23000].map((price, index) => ({
    classList: [`lowest-price-${index + 1}`], textContent: price.toLocaleString('en-US')
  }));
  const pcBox = {
    innerText: 'Trend: 0% 22,000 22,250 22,500 Price Range: 600 - 110,000',
    getAttribute() { return '559'; },
    querySelectorAll() { return prices; },
    querySelector(selector) { return selector === '.prices-updated' ? { textContent: 'PRICE UPDATED: 1 MIN AGO' } : null; }
  };
  const document = {
    body,
    querySelectorAll(selector) {
      if (selector === 'div.price-box.platform-pc-only[data-id]') return [pcBox];
      if (selector === 'div.price-box[data-id]') return [consoleBox, pcBox];
      if (selector === 'script[type="application/ld+json"]') return [{ textContent: JSON.stringify({
        '@type': 'Product', name: 'Rodrygo Gold',
        image: 'https://example.com/content/fifa27/img/players/243812.png',
        additionalProperty: [{ name: 'Overall Rating', value: '84' }, { name: 'Card Type', value: 'Gold' }]
      }) }];
      return [];
    },
    createTreeWalker() {
      let position = -1;
      return {
        get currentNode() { return textNodes[position]; },
        set currentNode(node) { position = textNodes.indexOf(node); },
        nextNode() { position++; return textNodes[position] || null; }
      };
    }
  };
  const chrome = {
    runtime: { onMessage: { addListener(callback) { listener = callback; } } },
    storage: { local: { async get() { return {}; } } }
  };
  const location = {
    pathname: '/27/player/559/rodrygo-silva-de-goes/market',
    origin: 'https://www.futbin.com',
    href: 'https://www.futbin.com/27/player/559/rodrygo-silva-de-goes/market'
  };
  const context = { document, chrome, location, NodeFilter: { SHOW_TEXT: 4 }, fc27SalesParser: salesParser, Date, console };
  vm.runInNewContext(fs.readFileSync(require.resolve('./content.js'), 'utf8'), context);
  let response;
  listener({ type: 'FC27_READ_FUTBIN_MARKET_V3' }, null, (value) => { response = value; });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.item.market.lowestPrice, 22000);
  assert.equal(response.item.latestSales.lowestPrice, 21500);
  assert.equal(response.item.latestSales.soldAt, '2026-09-28T08:12:00.000Z');
  assert.equal(response.item.latestSales.sampleCount, 2);
});
