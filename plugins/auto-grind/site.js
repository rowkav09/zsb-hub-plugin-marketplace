'use strict';

const { MAPS, itemId, pageData, parseCatalog, skillMap, whole } = require('./planning');

const TIMEOUT = 15_000;

class SiteError extends Error {
  constructor(result) {
    super('Case Clicker is ' + (result?.kind === 'rate' ? 'limiting requests.' : 'unavailable on this account’s route.'));
    this.retryMs = Math.max(30, Math.min(900, Number(result?.retryAfter) || 0)) * 1000;
  }
}

function routedSite(ctx, id) {
  async function read(path) {
    const result = await ctx.request(id, path, { timeoutMs: TIMEOUT });
    if (result.kind !== 'ok') throw new SiteError(result);
    return result;
  }
  async function write(path, body, method = 'POST') {
    return ctx.request(id, path, { method, body, tries: 1, timeoutMs: TIMEOUT });
  }
  return {
    me: async () => (await read('/api/me')).json,
    stock: async () => {
      const stock = (await read('/api/cases')).json;
      if (!Array.isArray(stock) || stock.some(row => !itemId(row?._id) || !whole(row.amount))) {
        throw Error('Could not verify case stock.');
      }
      return stock;
    },
    async catalog() {
      const page = pageData((await read('/cases/cases')).body);
      if (page.props?.pageProps?.cases) return parseCatalog(page.props);
      if (!/^[\w-]{1,64}$/.test(page.buildId || '')) throw Error('Could not read the case catalog.');
      const data = await read('/_next/data/' + page.buildId + '/en/cases/cases.json?cases=cases');
      return parseCatalog(data.json);
    },
    map: async prefix => skillMap((await read('/skillmaps/' + encodeURIComponent(MAPS[prefix].path))).body, prefix),
    skill: skill => write('/api/skill', { mapName: skill.map, skillId: skill.id }),
    buy: plan => write('/api/cases', { id: plan.item.id, type: 'case', amount: plan.count }),
    open: (plan, inspectDrops) => write('/api/open/case', {
      id: plan.item.id, quickOpen: !inspectDrops, count: String(plan.count),
      useEventTickets: false, caseOpenMultiplier: 1, autoOpen: false,
    }),
    sell: id => write('/api/inventory', { id }, 'DELETE'),
  };
}

function cheapDropIds(drops, max) {
  if (!Array.isArray(drops) || max <= 0) return [];
  return [...new Set(drops.filter(item => itemId(item?._id) &&
    (item.rarity === 'Mil-Spec Grade' || item.rarity === 'Mil-Spec') &&
    Number.isFinite(item.price) && item.price > 0 && item.price <= max &&
    Number.isFinite(item.float) && item.float >= 0.01 && item.float <= 0.85 &&
    !item.isFavorite && !item.patternName && !item.pattern?.name &&
    !item.isStatTrak && !item.statTrak && !item.isSouvenir && !item.souvenir &&
    !item.stickers?.some(Boolean) && !item.appliedKeychain && !item.event).map(item => item._id))];
}

const refused = result => result?.kind === 'api' && [400, 403, 404, 422].includes(result.status);

module.exports = { routedSite, SiteError, cheapDropIds, refused };
