(() => {
  const MIN_INTERVAL_MS = 14 * 60 * 1000;
  const MAX_INTERVAL_MS = 30 * 60 * 1000;

  function validPrice(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function visiblePrices(sample) {
    const prices = sample?.visiblePrices || sample?.prices;
    return Array.isArray(prices) && prices.length > 0 && prices.length <= 5 && prices.every(validPrice)
      ? prices : null;
  }

  function findEarlier(samples, time) {
    return samples
      .filter((item) => {
        const sampledAt = Date.parse(item?.collectedAt || '');
        return Number.isFinite(sampledAt) && time - sampledAt >= MIN_INTERVAL_MS && time - sampledAt <= MAX_INTERVAL_MS;
      })
      .sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt))[0] || null;
  }

  function segment(before, after) {
    if (!validPrice(before?.lowestPrice) || !validPrice(after?.lowestPrice)) return null;
    const ceiling = before.lowestPrice;
    const previousPrices = visiblePrices(before);
    const currentPrices = visiblePrices(after);
    const lowListings = previousPrices && currentPrices
      ? [previousPrices.filter((value) => value <= ceiling).length,
        currentPrices.filter((value) => value <= ceiling).length]
      : null;
    let kind = 'unclear';
    if (lowListings) {
      if (after.lowestPrice > ceiling && lowListings[0] > 0 && lowListings[1] === 0) kind = 'up';
      else if (after.lowestPrice < ceiling && lowListings[1] > lowListings[0]) kind = 'down';
      else if (after.lowestPrice === ceiling && lowListings[1] < lowListings[0]) kind = 'easing';
      else if (after.lowestPrice === ceiling && lowListings[1] > lowListings[0]) kind = 'pressure';
    }
    return { kind, ceiling, lowListings };
  }

  function compare(market, snapshots) {
    const currentTime = Date.parse(market?.checkedAt || '');
    if (!Number.isFinite(currentTime) || !Array.isArray(snapshots)) return null;
    const earlier = findEarlier(snapshots, currentTime);
    if (!earlier) return null;
    const current = segment(earlier, market);
    if (!current) return null;
    const previous = findEarlier(snapshots, Date.parse(earlier.collectedAt));
    const previousKind = previous ? segment(previous, earlier)?.kind : null;
    let signal = '方向待确认';
    if (current.kind === 'up') signal = previousKind === 'up' ? '偏涨（连续两段，仍需观察）' : '偏涨迹象（待确认）';
    else if (current.kind === 'down') signal = previousKind === 'down' ? '偏跌（连续两段，仍需观察）' : '偏跌迹象（待确认）';
    else if (current.kind === 'easing') signal = previousKind === 'down' || previousKind === 'pressure'
      ? '初步止跌（待确认）' : '低价挂单减少，方向待确认';
    else if (current.kind === 'pressure') signal = '低价挂单增加，偏跌风险';
    return {
      minutes: Math.round((currentTime - Date.parse(earlier.collectedAt)) / 60000),
      lowestPrice: [earlier.lowestPrice, market.lowestPrice],
      ceiling: current.ceiling,
      lowListings: current.lowListings,
      kind: current.kind,
      signal,
      previousKind
    };
  }

  const api = { compare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.fc27MarketTrend = api;
})();
