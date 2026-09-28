(() => {
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const ENGLISH_DATE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+(?:\d{4},?\s+)?\d{1,2}:\d{2}\s*[AP]M\b/gi;
  const CHINESE_DATE = /\d{1,2}月\d{1,2}日\s*(?:上午|下午)?\s*\d{1,2}:\d{2}\s*(?:上午|下午)?/g;
  const UK_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  function parseSalePrice(value) {
    const match = String(value || '').trim().match(/^([\d,]+(?:\.\d+)?)\s*([KM])?$/i);
    if (!match) return null;
    const multiplier = match[2]?.toUpperCase() === 'M' ? 1000000 : match[2]?.toUpperCase() === 'K' ? 1000 : 1;
    const price = Number(match[1].replace(/,/g, '')) * multiplier;
    return Number.isSafeInteger(price) && price > 0 ? price : null;
  }

  function parseLatestSalesText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const dates = [...text.matchAll(ENGLISH_DATE), ...text.matchAll(CHINESE_DATE)]
      .sort((left, right) => left.index - right.index);
    const sales = [];
    for (let index = 0; index < dates.length; index++) {
      const date = dates[index];
      const end = index + 1 < dates.length ? dates[index + 1].index : text.length;
      const afterDate = text.slice(date.index + date[0].length, end).trim();
      const priceMatch = afterDate.match(/^([\d,]+(?:\.\d+)?\s*[KM]?)(?!\w)/i);
      const price = parseSalePrice(priceMatch?.[1]);
      if (price != null) sales.push({ price, displayTime: date[0].trim(), sourceIndex: index });
    }
    return sales;
  }

  function parseAbsoluteTimestamp(value) {
    const raw = String(value || '').trim();
    if (/^\d{10,13}$/.test(raw)) {
      const milliseconds = raw.length === 10 ? Number(raw) * 1000 : Number(raw);
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(raw) || !/(?:Z|[+-]\d\d:?\d\d)$/i.test(raw)) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function ukParts(date) {
    return Object.fromEntries(UK_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]));
  }

  function parseUkPageTime(label, now = new Date()) {
    const text = String(label || '').trim();
    let month, day, hour, minute, year;
    const english = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(?:(\d{4}),?\s+)?(\d{1,2}):(\d{2})\s*([AP]M)$/i);
    const chinese = text.match(/^(\d{1,2})月(\d{1,2})日\s*(上午|下午)?\s*(\d{1,2}):(\d{2})\s*(上午|下午)?$/);
    if (english) {
      month = MONTHS[english[1].toLowerCase()]; day = Number(english[2]); year = english[3] ? Number(english[3]) : ukParts(now).year;
      hour = Number(english[4]) % 12 + (english[6].toUpperCase() === 'PM' ? 12 : 0); minute = Number(english[5]);
    } else if (chinese) {
      month = Number(chinese[1]) - 1; day = Number(chinese[2]); year = ukParts(now).year;
      const period = chinese[3] || chinese[6];
      hour = period ? Number(chinese[4]) % 12 + (period === '下午' ? 12 : 0) : Number(chinese[4]);
      minute = Number(chinese[5]);
    } else return null;
    if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const convert = (calendarYear) => {
      const wallAsUtc = Date.UTC(calendarYear, month, day, hour, minute);
      const calendar = new Date(wallAsUtc);
      if (calendar.getUTCFullYear() !== calendarYear || calendar.getUTCMonth() !== month || calendar.getUTCDate() !== day) return null;
      const matching = [wallAsUtc, wallAsUtc - 60 * 60 * 1000].filter((timestamp) => {
        const parts = ukParts(new Date(timestamp));
        return parts.year === calendarYear && parts.month === month + 1 && parts.day === day &&
          parts.hour === hour && parts.minute === minute;
      });
      return matching.length === 1 ? new Date(matching[0]).toISOString() : null;
    };
    let soldAt = convert(year);
    if (soldAt && !english?.[3] && Date.parse(soldAt) > now.getTime() + 24 * 60 * 60 * 1000) soldAt = convert(year - 1);
    return soldAt;
  }

  function lowestVisibleSale(sales, timestamps = [], now = new Date()) {
    if (!sales.length) return null;
    const firstLowest = sales.reduce((best, sale, index) => sale.price < sales[best].price ? index : best, 0);
    const sale = sales[firstLowest];
    const absolute = parseAbsoluteTimestamp(timestamps[sale.sourceIndex ?? firstLowest]);
    const soldAt = absolute || parseUkPageTime(sale.displayTime, now);
    return {
      lowestPrice: sale.price,
      soldAt,
      displayTime: sale.displayTime,
      timeBasis: absolute ? 'absolute' : soldAt ? 'uk-wall' : 'unverified',
      sampleCount: sales.length
    };
  }

  function correctLegacySaleTime(displayTime, soldAt, timeBasis, referenceTime) {
    if (timeBasis !== 'browser-local') return { soldAt, timeBasis };
    const reference = new Date(referenceTime || Date.now());
    const corrected = parseUkPageTime(displayTime, Number.isNaN(reference.getTime()) ? new Date() : reference);
    return { soldAt: corrected, timeBasis: corrected ? 'uk-wall' : 'unverified' };
  }

  const api = { parseSalePrice, parseLatestSalesText, parseAbsoluteTimestamp, parseUkPageTime, lowestVisibleSale, correctLegacySaleTime };
  globalThis.fc27SalesParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
