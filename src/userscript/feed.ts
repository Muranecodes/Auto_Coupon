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

export const BUILTIN_COUPON_FEED: CouponFeed = {
  updatedAt: '2026-11-12T13:50:00.000Z',
  coupons: [
    {
      code: '週二星享日',
      platform: 'foodpanda',
      title: '週二星巴克指定專區滿額現折 $70',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '天天取天天爽',
      platform: 'foodpanda',
      title: '外帶自取指定店家滿額折抵優惠（最高折 $110）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '天天省天天爽',
      platform: 'foodpanda',
      title: '美食外送指定餐廳滿額折扣優惠',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '11111111111',
      platform: 'foodpanda',
      title: 'pandapro 半年會員方案特價 $111 結帳優惠碼',
      category: 'checkout_only',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '581享受',
      platform: 'ubereats',
      title: '精選店家滿 $399 享 85 折（最高折 $70~$90）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '會員週年享',
      platform: 'ubereats',
      title: 'Uber One 會員美食外送滿 $649 現折 $100（可用 2 次）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '會員週年慶',
      platform: 'ubereats',
      title: 'Uber One 會員美食外送滿 $450 享 $0 外送費與服務費（可用 4 次）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: 'afftweats1126',
      platform: 'ubereats',
      title: 'Uber Eats 新戶首 2 單滿 $150 折 $75',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '週年慶外帶',
      platform: 'ubereats',
      title: '外帶自取單筆滿 $179 享 7 折（最高折 $60）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
  ],
};

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
    if (parsed.coupons.length > 0) {
      saveCachedFeed(parsed);
      return parsed;
    }
    if (!customFetcher) {
      return BUILTIN_COUPON_FEED;
    }
    return parsed;
  } catch {
    const cached = loadCachedFeed();
    if (cached && cached.coupons.length > 0) return cached;
    return BUILTIN_COUPON_FEED;
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
