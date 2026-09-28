const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('./sales-parser.js');

test('takes the lowest sale from only the visible Latest Sales text', () => {
  const visiblePcSales = [
    'Sep 28, 8:52 AM 23.5K',
    'Sep 28, 8:49 AM 23.5K',
    'Sep 28, 8:47 AM 23.5K',
    'Sep 28, 8:43 AM 23.75K',
    'Sep 28, 8:12 AM 21.5K'
  ].join(' ');
  const sales = parser.parseLatestSalesText(visiblePcSales);
  assert.equal(sales.length, 5);
  const result = parser.lowestVisibleSale(sales, [], new Date('2026-09-28T17:00:00Z'));
  assert.equal(result.lowestPrice, 21500);
  assert.equal(result.displayTime, 'Sep 28, 8:12 AM');
  assert.equal(result.sampleCount, 5);
  assert.equal(result.soldAt, '2026-09-28T07:12:00.000Z');
  assert.equal(result.timeBasis, 'uk-wall');
  assert.equal(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(result.soldAt)), '15:12');
});

test('UK summer and winter page times convert with the correct offset', () => {
  assert.equal(parser.parseUkPageTime('Sep 28, 8:52 AM', new Date('2026-09-28T08:52:00Z')), '2026-09-28T07:52:00.000Z');
  assert.equal(parser.parseUkPageTime('Jan 28, 8:52 AM', new Date('2026-01-28T08:52:00Z')), '2026-01-28T08:52:00.000Z');
  assert.equal(parser.parseUkPageTime('Dec 31, 11:30 PM', new Date('2027-01-01T00:00:00Z')), '2026-12-31T23:30:00.000Z');
  assert.equal(parser.parseUkPageTime('Oct 25, 1:30 AM', new Date('2026-10-25T02:00:00Z')), null);
});

test('prefers an absolute sale timestamp for Beijing conversion', () => {
  const sales = parser.parseLatestSalesText('Sep 28, 8:52 AM 23.5K Sep 28, 8:49 AM 22K');
  const result = parser.lowestVisibleSale(sales, [null, '2026-09-28T08:49:00Z']);
  assert.equal(result.lowestPrice, 22000);
  assert.equal(result.soldAt, '2026-09-28T08:49:00.000Z');
  assert.equal(result.timeBasis, 'absolute');
  assert.equal(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(result.soldAt)), '16:49');
});

test('rejects timezone-free timestamps as absolute times', () => {
  assert.equal(parser.parseAbsoluteTimestamp('2026-09-28 08:49:00'), null);
  assert.equal(parser.parseSalePrice('23.75K'), 23750);
  assert.equal(parser.parseSalePrice('1.25M'), 1250000);
});

test('corrects a previously stored browser-local sale using its collection time', () => {
  const corrected = parser.correctLegacySaleTime('Sep 28, 8:12 AM', '2026-09-28T00:12:00.000Z',
    'browser-local', '2026-09-28T08:30:00.000Z');
  assert.deepEqual(corrected, { soldAt: '2026-09-28T07:12:00.000Z', timeBasis: 'uk-wall' });
});
