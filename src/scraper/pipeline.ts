import { readFileSync } from 'node:fs';
import type {
  CouponCategory,
  CouponEntry,
  CouponFeed,
  PlatformId,
} from '../shared/types.ts';
import { isCouponExpired } from '../userscript/feed.ts';
import {
  extractCandidateChips,
  hasCouponHint,
  stripCouponCodeFromTitle,
} from '../userscript/parser.ts';

export interface ScraperSourceInput {
  platform: PlatformId;
  url: string;
  html: string;
}

const categoryRules = JSON.parse(
  readFileSync(new URL('./category-rules.json', import.meta.url), 'utf8'),
) as { checkoutOnlyPatterns: string[] };

const CHECKOUT_ONLY_REGEX = new RegExp(
  categoryRules.checkoutOnlyPatterns.join('|'),
  'i',
);

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TableRowCoupon {
  code: string;
  content: string;
  expireText: string;
}

function extractCallingTaiwanTableCoupons(html: string): TableRowCoupon[] {
  const results: TableRowCoupon[] = [];
  const tbodyMatch = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch?.[1]) return results;

  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[] = [];
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(tbodyMatch[1])) !== null) {
    if (trMatch[1]) rows.push(trMatch[1]);
  }

  for (const rowHtml of rows.slice(1)) {
    const tdRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    const tds: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      tds.push(tdMatch[1] ?? '');
    }
    if (tds.length < 3) continue;

    const expireText = stripHtmlTags(tds[0]!);
    const content = stripHtmlTags(tds[1]!);
    const rawCodeCell = tds[2]!
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n');

    const codeLines = rawCodeCell
      .split(/\r?\n/)
      .map((line) => stripHtmlTags(line).split('(')[0]!.split('（')[0]!.trim())
      .filter(Boolean);

    for (const code of codeLines) {
      if (
        !content.includes('首購') &&
        !code.includes('前往訂餐') &&
        !code.includes('前往兌換')
      ) {
        results.push({ code, content, expireText });
      }
    }
  }

  return results;
}

function splitHtmlIntoBlocks(html: string): string[] {
  const blocks: string[] = [];
  const blockRegex = /<(tr|li|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) !== null) {
    const inner = match[2] ?? '';
    const text = stripHtmlTags(inner);
    if (text) blocks.push(text);
  }
  if (blocks.length === 0) {
    const fallback = stripHtmlTags(html);
    if (fallback) blocks.push(fallback);
  }
  return blocks;
}

export function parseExpirationDate(
  text: string,
  referenceYear: number,
): string | null {
  const fullDateMatch = text.match(
    /(?:至|期限|有效|截止|~|～|-|—)?\s*(20\d{2})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})\s*日?/,
  );
  if (fullDateMatch) {
    const year = fullDateMatch[1]!;
    const month = fullDateMatch[2]!.padStart(2, '0');
    const day = fullDateMatch[3]!.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const shortDateMatch = text.match(
    /(?:至|期限|有效|截止|~|～)\s*(\d{1,2})\s*[\/\-月]\s*(\d{1,2})\s*日?/,
  );
  if (shortDateMatch) {
    const month = shortDateMatch[1]!.padStart(2, '0');
    const day = shortDateMatch[2]!.padStart(2, '0');
    return `${referenceYear}-${month}-${day}`;
  }

  return null;
}

export function classifyCouponCategory(contextText: string): CouponCategory {
  if (CHECKOUT_ONLY_REGEX.test(contextText)) {
    return 'checkout_only';
  }
  return 'wallet';
}

function entriesContentEqual(a: CouponEntry, b: CouponEntry): boolean {
  return (
    a.code === b.code &&
    a.platform === b.platform &&
    a.title === b.title &&
    a.category === b.category &&
    a.expiresAt === b.expiresAt &&
    (a.sourceUrl ?? '') === (b.sourceUrl ?? '')
  );
}

export function buildCouponFeed(
  sources: ScraperSourceInput[],
  existingFeed: CouponFeed | null = null,
  nowIso = new Date().toISOString(),
): CouponFeed {
  const todayIsoDate = nowIso.slice(0, 10);
  const referenceYear = Number.parseInt(todayIsoDate.slice(0, 4), 10) || 2026;

  const existingByKey = new Map<string, CouponEntry>();
  const mergedByKey = new Map<string, CouponEntry>();

  if (existingFeed && Array.isArray(existingFeed.coupons)) {
    for (const item of existingFeed.coupons) {
      const key = `${item.platform}:${item.code}`;
      existingByKey.set(key, item);
      if (!isCouponExpired(item.expiresAt, todayIsoDate)) {
        const category = classifyCouponCategory(item.title ?? '');
        mergedByKey.set(key, {
          ...item,
          category,
          updatedAt: item.category === category ? item.updatedAt : nowIso,
        });
      }
    }
  }

  for (const source of sources) {
    const tableRows = extractCallingTaiwanTableCoupons(source.html);
    if (tableRows.length > 0) {
      for (const row of tableRows) {
        const expiresAt = parseExpirationDate(
          `至 ${row.expireText}`,
          referenceYear,
        );
        if (isCouponExpired(expiresAt, todayIsoDate)) continue;
        const category = classifyCouponCategory(row.content);
        const key = `${source.platform}:${row.code}`;
        const prev = existingByKey.get(key);
        const candidate: CouponEntry = {
          code: row.code,
          platform: source.platform,
          title: row.content,
          category,
          expiresAt,
          sourceUrl: source.url,
          updatedAt: nowIso,
        };
        if (prev && entriesContentEqual(prev, candidate)) {
          candidate.updatedAt = prev.updatedAt;
        }
        mergedByKey.set(key, candidate);
      }
      continue;
    }

    const blocks = splitHtmlIntoBlocks(source.html);
    for (const block of blocks) {
      if (!hasCouponHint(block)) continue;
      const chips = extractCandidateChips(block);
      if (chips.length === 0) continue;

      const expiresAt = parseExpirationDate(block, referenceYear);
      if (isCouponExpired(expiresAt, todayIsoDate)) continue;

      const category = classifyCouponCategory(block);

      for (const chip of chips) {
        const key = `${source.platform}:${chip.code}`;
        const prev = existingByKey.get(key);
        const candidate: CouponEntry = {
          code: chip.code,
          platform: source.platform,
          title: stripCouponCodeFromTitle(block, chip.code),
          category,
          expiresAt,
          sourceUrl: source.url,
          updatedAt: nowIso,
        };
        if (prev && entriesContentEqual(prev, candidate)) {
          candidate.updatedAt = prev.updatedAt;
        }
        mergedByKey.set(key, candidate);
      }
    }
  }

  const sortedCoupons = [...mergedByKey.values()].sort((a, b) => {
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return 0;
  });

  const prevCoupons = existingFeed?.coupons ?? [];
  const isUnchanged =
     existingFeed !== null &&
    sortedCoupons.length === prevCoupons.length &&
    sortedCoupons.every((item, idx) => {
      const prev = prevCoupons[idx];
      return Boolean(prev && entriesContentEqual(item, prev));
    });

  return {
    updatedAt: isUnchanged ? existingFeed!.updatedAt : nowIso,
    coupons: sortedCoupons,
  };
}
