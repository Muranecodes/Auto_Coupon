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

const CHECKOUT_ONLY_REGEX =
  /信用卡|刷卡|簽帳卡|金融卡|銀行|中國信託|中信|國泰世華|國泰|玉山|台新|富邦|永豐|聯邦|星展|滙豐|匯豐|兆豐|第一銀行|華南|合作金庫|彰銀|LINE\s*Pay\s*卡|CUBE\s*卡|結帳限定|結帳輸入|限定結帳/i;

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
        mergedByKey.set(key, { ...item });
      }
    }
  }

  for (const source of sources) {
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
    return a.code.localeCompare(b.code, 'zh-Hant');
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
