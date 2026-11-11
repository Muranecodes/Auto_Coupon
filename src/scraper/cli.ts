import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CouponFeed, PlatformId } from '../shared/types.ts';
import { buildCouponFeed, type ScraperSourceInput } from './pipeline.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../..');
const feedFilePath = resolve(rootDir, 'data/coupons.json');

interface ConfiguredSource {
  platform: PlatformId;
  url: string;
}

export const DEFAULT_SCRAPER_SOURCES: ConfiguredSource[] = [
  {
    platform: 'foodpanda',
    url: 'https://www.foodpanda.com.tw/contents/deals',
  },
  {
    platform: 'ubereats',
    url: 'https://www.ubereats.com/tw',
  },
];

async function fetchHtmlSource(
  source: ConfiguredSource,
): Promise<ScraperSourceInput | null> {
  try {
    const res = await fetch(source.url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return {
      platform: source.platform,
      url: source.url,
      html,
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let existingFeed: CouponFeed | null = null;
  if (existsSync(feedFilePath)) {
    try {
      existingFeed = JSON.parse(
        readFileSync(feedFilePath, 'utf8'),
      ) as CouponFeed;
    } catch {
      existingFeed = null;
    }
  }

  const fetchedSources: ScraperSourceInput[] = [];
  for (const src of DEFAULT_SCRAPER_SOURCES) {
    const item = await fetchHtmlSource(src);
    if (item) fetchedSources.push(item);
  }

  const nextFeed = buildCouponFeed(
    fetchedSources,
    existingFeed,
    new Date().toISOString(),
  );

  mkdirSync(dirname(feedFilePath), { recursive: true });
  writeFileSync(
    feedFilePath,
    `${JSON.stringify(nextFeed, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `Updated Coupon Feed (${nextFeed.coupons.length} active coupons) -> ${feedFilePath}`,
  );
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  await main();
}
