'use strict';

// Valuation rules from Rowan's Case Clicker Pricedata Overlay and Auction Sniper.
// ChunkyCheese maintains the public pattern price list used by both.
const LIST_GID = 1167749951;
const LIST_PUB_ID = '2PACX-1vQHX9j8A3dRJrJS-J7Zs7PcIAC-5CgBydhFVOELd92PqPZY2VdJXEDtk4AIDgVl1-lnO_JcV3pBGouy';

const QUALITY_BASE = 7;
const EXT_COL = { 'Factory New': 4, 'Minimal Wear': 5, 'Field-Tested': 6, 'Well-Worn': 7, 'Battle-Scarred': 8 };

// Patterns flagged as event drops with no EV multiplier documented in the sheet.
const EVENT_EV_FALLBACK_BY_PATTERN_ID = {
  '65a652a7fdd7ea906a8f8767': 3000000, // Talon Knife | Fade '100% Fade'
  '65a652acfdd7ea906a8f8768': 800000, // Talon Knife | Fade '80% Fade'
};

function listCsvUrl() {
  return `https://docs.google.com/spreadsheets/d/e/${LIST_PUB_ID}/pub?gid=${LIST_GID}&single=true&output=csv`;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseMagnitude(str) {
  if (str == null) return null;
  str = String(str).trim();
  if (!str || str.toUpperCase() === 'N/A') return null;
  const m = str.match(/^([\-+]?[\d.,]+)\s*([kKmMbB])?$/);
  if (!m) { const n = parseFloat(str.replace(/,/g, '')); return isNaN(n) ? null : n; }
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return null;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k') n *= 1e3; else if (suf === 'm') n *= 1e6; else if (suf === 'b') n *= 1e9;
  return n;
}

function parseAdjustment(str) {
  if (str == null) return null;
  str = String(str).trim();
  if (!str || str.toUpperCase() === 'N/A') return null;
  if (str[0] === 'x' || str[0] === 'X') { const v = parseFloat(str.slice(1)); return isNaN(v) ? null : { type: 'mult', value: v }; }
  if (str[0] === '+') { const v = parseMagnitude(str.slice(1)); return v == null ? null : { type: 'add', value: v }; }
  if (str[0] === '-') { const v = parseMagnitude(str.slice(1)); return v == null ? null : { type: 'add', value: -v }; }
  const setVal = parseMagnitude(str);
  if (setVal != null) return { type: 'set', value: setVal };
  return null;
}

function applyAdjustment(base, adj) {
  if (adj.type === 'mult') return base * adj.value;
  if (adj.type === 'set') return adj.value;
  return base + adj.value; // 'add'
}

function getFloatRanks(skin) {
  return skin.floatRanks ? Object.values(skin.floatRanks) : [];
}

class PriceData {
  constructor() {
    this.listByPatternId = new Map();
    this.ready = false;
    this.loadedAt = 0;
  }

  async load() {
    if (this.ready && Date.now() - this.loadedAt < 15 * 60_000) return;
    const response = await fetch(listCsvUrl(), { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error('ChunkyCheese PriceData returned HTTP ' + response.status + '.');
    const rows = parseCSV(await response.text());
    const list = new Map(rows.slice(1).filter(row => /^[a-f0-9]{24}$/i.test(row[30] || '')).map(row => [row[30], row]));
    if (!list.size) throw Error('ChunkyCheese pattern prices were unavailable.');
    this.listByPatternId = list;
    this.loadedAt = Date.now();
    this.ready = true;
  }

  /** Dollar-denominated estimate, ported from the userscript's calcPrice(). Reference only --
   * do NOT compare this directly against a token-denominated auction bid. */
  calcDollarPrice(skin) {
    const native = (typeof skin.price === 'number' ? skin.price : skin.weaponPrice) || 0;
    if (!this.ready) return { calc: native, native, source: 'loading' };

    const ranks = getFloatRanks(skin);
    const weaponPrice = typeof skin.weaponPrice === 'number' ? skin.weaponPrice : native;
    const skinPrice = typeof skin.price === 'number' ? skin.price : weaponPrice;
    let price = skinPrice;
    let source = 'fallback-native';

    if (skin.patternId && this.listByPatternId.has(skin.patternId)) {
      const row = this.listByPatternId.get(skin.patternId);
      const skinGroupValue = String(row[3] || '').trim();
      const col = EXT_COL[skin.exterior];
      let wearPrice = col != null ? parseMagnitude(row[col]) : null;
      if (wearPrice == null) wearPrice = parseMagnitude(row[2]);
      let hasPrice = false;
      if (wearPrice != null) { price = wearPrice; hasPrice = true; }

      if (ranks[18] === 1 && ranks[19] === 1) {
        price = skinGroupValue === 'Tier' ? 5000000 : Math.max(5000000, price * 15);
      }

      const skipStForKnife08FN = skinGroupValue === 'Knife08' && skin.exterior === 'Factory New';
      if (skin.statTrak) {
        if (!skipStForKnife08FN) { const adj = parseAdjustment(row[9]); if (adj) price = applyAdjustment(price, adj); }
      } else if (skin.souvenir) {
        const adj = parseAdjustment(row[10]); if (adj) price = applyAdjustment(price, adj);
      }

      if (skin.event) {
        const ev = parseAdjustment(row[11]);
        if (ev) price = applyAdjustment(price, ev);
        else if (EVENT_EV_FALLBACK_BY_PATTERN_ID[skin.patternId] != null) price = EVENT_EV_FALLBACK_BY_PATTERN_ID[skin.patternId];
      }

      const quality = typeof skin.quality === 'number' ? skin.quality : 0;
      if (quality) {
        price = hasPrice ? price : weaponPrice;
        price = price * (quality > 0 ? Math.pow(QUALITY_BASE, quality) : 1);
      }

      if (skinPrice !== weaponPrice) price = price + (skinPrice - weaponPrice);
      source = hasPrice ? 'calculated' : 'calculated-no-wear-price';
    } else if (!skin.patternId) {
      if (ranks[6] === 1 && ranks[7] === 1) price = Math.max(5000000, price);
    }

    if (typeof skin.name === 'string' && skin.name.includes('Terminal')) { price = 25000; source = 'terminal-flat'; }
    if (typeof skin.name === 'string' && skin.name.includes("(Holo) | Katowice 2014")) {
      const kQuality = typeof skin.quality === 'number' ? skin.quality : 0;
      const qsBase = kQuality > 0 ? weaponPrice * Math.pow(QUALITY_BASE, kQuality) : skinPrice;
      price = qsBase * 3;
      source = 'katowice-3x';
    }

    // A skin can be genuinely rare -- an event drop, or holding just one end of a float extreme
    // (rank 1 for lowest OR highest, not both) -- without any of the branches above ever having
    // touched `price`. The formula (ported as-is from the sheet's own methodology) only prices
    // event/near-1-of-1 premiums through the patternId-matched branch or a full lowest+highest
    // 1/1; anything else with these signals silently falls through to the bare native price.
    // Confirmed against a real case: an event-tagged SSG 08 nicknamed "Event HF: #1" (rank 1 for
    // highest-float-in-event-skingroup) priced at its $0.05 native value while actually being bid
    // to $2M+ in the live auction house. Flag it instead of returning a confident-looking number
    // that isn't one -- valuateAuction treats this as low-confidence and won't auto-bid on it.
    const partialFloatExtreme = (ranks[6] === 1) !== (ranks[7] === 1) || (ranks[18] === 1) !== (ranks[19] === 1);
    const unpricedSpecial = source === 'fallback-native' && (!!skin.event || partialFloatExtreme);
    if (unpricedSpecial) source = 'fallback-native-unpriced-special';

    return { calc: price, native, source };
  }
}


module.exports = { PriceData };
