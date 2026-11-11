import type {
  CouponEntry,
  CouponFeed,
  PlatformId,
} from '../shared/types.ts';
import { loadCachedFeed, saveCachedFeed } from './storage.ts';

declare const GM_xmlhttpRequest:
  | ((details: {
      method: string;
      url: string;
      onload?: (res: { status: number; responseText: string }) => void;
      onerror?: (err: unknown) => void;
    }) => void)
  | undefined;

export const DEFAULT_FEED_URL =
  'https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/data/coupons.json';

export async function fetchCouponFeed(
  feedUrl = DEFAULT_FEED_URL,
  customFetcher?: (url: string) => Promise<unknown>,
): Promise<CouponFeed> {
  try {
    let rawData: unknown;
    if (customFetcher) {
      rawData = await customFetcher(feedUrl);
    } else if (typeof GM_xmlhttpRequest === 'function') {
      rawData = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest!({
          method: 'GET',
          url: feedUrl,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              try {
                resolve(JSON.parse(res.responseText));
              } catch (err) {
                reject(err);
              }
            } else {
              reject(new Error(`HTTP ${res.status}`));
            }
          },
          onerror: (err) => reject(err),
        });
      });
    } else {
      const response = await fetch(feedUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      rawData = await response.json();
    }

    const parsed = validateFeed(rawData);
    saveCachedFeed(parsed);
    return parsed;
  } catch {
    const cached = loadCachedFeed();
    if (cached) return cached;
    return { updatedAt: new Date().toISOString(), coupons: [] };
  }
}

function validateFeed(raw: unknown): CouponFeed {
  if (!raw || typeof raw !== 'object') {
    return { updatedAt: new Date().toISOString(), coupons: [] };
  }
  const obj = raw as Partial<CouponFeed>;
  const coupons = Array.isArray(obj.coupons) ? obj.coupons : [];
  return {
    updatedAt:
      typeof obj.updatedAt === 'string'
        ? obj.updatedAt
        : new Date().toISOString(),
    coupons: coupons.filter(
      (c): c is CouponEntry =>
        Boolean(c && typeof c.code === 'string' && typeof c.platform === 'string'),
    ),
  };
}

export function isCouponExpired(
  expiresAt: string | null | undefined,
  todayIsoDate: string,
): boolean {
  if (!expiresAt) return false;
  const datePart = expiresAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return false;
  return datePart < todayIsoDate;
}

export function partitionPlatformCoupons(
  feed: CouponFeed,
  platform: PlatformId,
  todayIsoDate = new Date().toISOString().slice(0, 10),
): {
  walletCoupons: CouponEntry[];
  checkoutCoupons: CouponEntry[];
} {
  const walletCoupons: CouponEntry[] = [];
  const checkoutCoupons: CouponEntry[] = [];

  for (const entry of feed.coupons) {
    if (entry.platform !== platform) continue;
    if (isCouponExpired(entry.expiresAt, todayIsoDate)) continue;
    if (entry.category === 'checkout_only') {
      checkoutCoupons.push(entry);
    } else {
      walletCoupons.push(entry);
    }
  }

  return { walletCoupons, checkoutCoupons };
}
