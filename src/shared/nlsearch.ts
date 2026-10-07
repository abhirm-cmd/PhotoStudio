/**
 * Natural-language search → structured filter rules.
 * "outdoor wedding photos taken with the 85mm lens" →
 *   aiTag/keyword: outdoor, keyword: wedding, focalLength between 83..87
 * Unrecognized words fall back to free-text search over filename, keywords, metadata and AI tags.
 */
import type { SmartRule } from './types';

const STOP = new Set(['show', 'me', 'all', 'my', 'the', 'a', 'an', 'of', 'with', 'taken', 'shot', 'photos', 'photo', 'pictures', 'picture', 'images', 'image', 'that', 'are', 'is', 'were', 'was', 'from', 'in', 'on', 'at', 'using', 'lens', 'by', 'and', 'find', 'please', 'which', 'have', 'has', 'shots', 'files', 'camera']);

export const SCENE_TAGS = ['people', 'person', 'face', 'portrait', 'sky', 'building', 'architecture', 'landscape', 'vehicle', 'car', 'animal', 'dog', 'cat', 'bird', 'water', 'beach', 'sea', 'vegetation', 'tree', 'forest', 'flower', 'food', 'night', 'sunset', 'golden hour', 'outdoor', 'indoor', 'snow', 'city', 'mountain', 'wedding', 'couple', 'macro', 'low light', 'bright', 'dark', 'colorful', 'monochrome'];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export interface ParsedSearch { rules: SmartRule[]; text: string; chips: string[] }

export function parseSearch(input: string, known: { cameras?: string[]; lenses?: string[]; keywords?: string[]; aiTags?: string[] } = {}): ParsedSearch {
  let q = ` ${input.toLowerCase().replace(/[“”"]/g, ' ')} `;
  const rules: SmartRule[] = [];
  const chips: string[] = [];
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => { const m = q.match(re); if (m) { fn(m); q = q.replace(re, ' '); } };

  take(/\b(\d{2,3})\s?mm\b/, m => { const f = Number(m[1]); rules.push({ field: 'focalLength', op: 'between', value: f - 2, value2: f + 2 }); chips.push(`${f}mm`); });
  take(/\bf\/?\s?(\d+(?:\.\d+)?)\b/, m => { const a = Number(m[1]); rules.push({ field: 'aperture', op: 'between', value: a - 0.05, value2: a + 0.05 }); chips.push(`f/${a}`); });
  take(/\biso\s?(\d{2,6})\b/, m => { rules.push({ field: 'iso', op: 'is', value: Number(m[1]) }); chips.push(`ISO ${m[1]}`); });
  take(/\b(?:high|over|above)\s+iso\b/, () => { rules.push({ field: 'iso', op: 'gte', value: 3200 }); chips.push('High ISO'); });
  take(/\b([1-5])[\s-]?stars?\b/, m => { rules.push({ field: 'rating', op: 'gte', value: Number(m[1]) }); chips.push(`★ ${m[1]}+`); });
  take(/\b(five|four|three|two|one)[\s-]?stars?\b/, m => { const n = ['one', 'two', 'three', 'four', 'five'].indexOf(m[1]) + 1; rules.push({ field: 'rating', op: 'gte', value: n }); chips.push(`★ ${n}+`); });
  take(/\b(unrated)\b/, () => { rules.push({ field: 'rating', op: 'is', value: 0 }); chips.push('Unrated'); });
  take(/\b(picks?|picked|flagged)\b/, () => { rules.push({ field: 'flag', op: 'is', value: 'pick' }); chips.push('Picks'); });
  take(/\b(rejects?|rejected)\b/, () => { rules.push({ field: 'flag', op: 'is', value: 'reject' }); chips.push('Rejected'); });
  take(/\b(favou?rites?)\b/, () => { rules.push({ field: 'favorite', op: 'is', value: true }); chips.push('Favorites'); });
  take(/\b(unedited|not edited)\b/, () => { rules.push({ field: 'edited', op: 'is', value: false }); chips.push('Unedited'); });
  take(/\b(edited)\b/, () => { rules.push({ field: 'edited', op: 'is', value: true }); chips.push('Edited'); });
  take(/\b(ai[\s-]?enhanced)\b/, () => { rules.push({ field: 'aiEnhanced', op: 'is', value: true }); chips.push('AI enhanced'); });
  take(/\b(raws?|raw files?)\b/, () => { rules.push({ field: 'isRaw', op: 'is', value: true }); chips.push('RAW'); });
  take(/\b(jpe?gs?)\b/, () => { rules.push({ field: 'fileType', op: 'is', value: 'jpg' }); chips.push('JPEG'); });
  take(/\b(portrait|vertical) (?:orientation|format)\b/, () => { rules.push({ field: 'orientation', op: 'is', value: 'portrait' }); chips.push('Portrait orientation'); });
  take(/\b(landscape|horizontal) (?:orientation|format)\b/, () => { rules.push({ field: 'orientation', op: 'is', value: 'landscape' }); chips.push('Landscape orientation'); });
  for (const label of ['red', 'yellow', 'green', 'blue', 'purple']) take(new RegExp(`\\b${label} label(?:ed|s)?\\b`), () => { rules.push({ field: 'label', op: 'is', value: label }); chips.push(`${label} label`); });
  take(/\b(?:in|from|during)\s+(19|20)(\d{2})\b/, m => { const y = `${m[1]}${m[2]}`; rules.push({ field: 'date', op: 'between', value: `${y}-01-01`, value2: `${y}-12-31T23:59:59` }); chips.push(y); });
  take(/\b(19|20)(\d{2})\b/, m => { const y = `${m[1]}${m[2]}`; rules.push({ field: 'date', op: 'between', value: `${y}-01-01`, value2: `${y}-12-31T23:59:59` }); chips.push(y); });
  for (let i = 0; i < 12; i++) take(new RegExp(`\\b${MONTHS[i]}\\b`), () => { rules.push({ field: 'date', op: 'contains', value: `-${String(i + 1).padStart(2, '0')}-` }); chips.push(MONTHS[i][0].toUpperCase() + MONTHS[i].slice(1)); });

  for (const cam of known.cameras ?? []) {
    const c = cam.toLowerCase();
    const short = c.replace(/^(canon|nikon|sony|fujifilm|panasonic|olympus|om digital solutions|pentax|ricoh|leica)\s+/, '');
    for (const v of [c, short].filter(s => s.length >= 2)) if (q.includes(` ${v} `) || q.includes(` ${v.replace(/^eos\s+/, '')} `)) { rules.push({ field: 'camera', op: 'contains', value: short }); chips.push(cam); q = q.replace(v, ' '); break; }
  }
  for (const brand of ['canon', 'nikon', 'sony', 'fujifilm', 'fuji', 'panasonic', 'olympus', 'pentax', 'leica', 'hasselblad']) {
    take(new RegExp(`\\b${brand}\\b`), () => { rules.push({ field: 'camera', op: 'contains', value: brand === 'fuji' ? 'fuji' : brand }); chips.push(brand[0].toUpperCase() + brand.slice(1)); });
  }

  // Scene / AI tags and keywords
  const kw = new Set((known.keywords ?? []).map(k => k.toLowerCase()));
  const tags = new Set([...(known.aiTags ?? []).map(t => t.toLowerCase()), ...SCENE_TAGS]);
  const words = q.split(/[^a-z0-9-]+/).filter(Boolean);
  const textWords: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const two = i + 1 < words.length ? `${w} ${words[i + 1]}` : '';
    if (two && tags.has(two)) { rules.push({ field: 'aiTag', op: 'contains', value: two }); chips.push(two); i++; continue; }
    if (STOP.has(w)) continue;
    const singular = w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
    if (kw.has(w) || kw.has(singular)) { rules.push({ field: 'keyword', op: 'contains', value: kw.has(w) ? w : singular }); chips.push(`#${w}`); continue; }
    if (tags.has(w) || tags.has(singular)) { rules.push({ field: 'aiTag', op: 'contains', value: tags.has(w) ? w : singular }); chips.push(w); continue; }
    textWords.push(w);
  }
  return { rules, text: textWords.join(' '), chips };
}

/** True when a query looks like natural language rather than a plain text search. */
export function looksNatural(q: string) {
  return /\s/.test(q.trim()) && (/\b(show|photos?|taken|with|from|stars?|mm|iso|picks?|edited|raw)\b/i.test(q) || q.trim().split(/\s+/).length >= 3);
}
