import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    url: 'https://www.callingtaiwan.com.tw/foodpanda-coupon-code/',
  },
  {
    platform: 'ubereats',
    url: 'https://www.callingtaiwan.com.tw/ubereats%E5%84%AA%E6%83%A0-%E6%9C%80%E6%96%B0%E9%A4%90%E5%BB%B3%E5%A4%96%E9%80%81%E9%A6%96%E8%B3%BC%E5%84%AA%E6%83%A0%E5%BA%8F%E8%99%9F-%E6%8A%98%E6%89%A3%E7%A2%BC-%E6%8E%A8%E8%96%A6%E7%A2%BC/',
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
    if (!res.ok) {
      console.warn(`[scrape] Skipped ${source.url} (HTTP ${res.status})`);
      return null;
    }
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
  const args = new Set(process.argv.slice(2));
  if (args.has('--print-sources')) {
    console.log(JSON.stringify(DEFAULT_SCRAPER_SOURCES));
    return;
  }

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

  let fetchedSources: ScraperSourceInput[] = [];
  if (args.has('--sources-stdin')) {
    const rawInput = readFileSync(0, 'utf8').trim();
    if (rawInput) {
      const parsed = JSON.parse(rawInput) as ScraperSourceInput[];
      if (Array.isArray(parsed)) {
        fetchedSources = parsed;
      }
    }
  } else {
    for (const src of DEFAULT_SCRAPER_SOURCES) {
      const item = await fetchHtmlSource(src);
      if (item) fetchedSources.push(item);
    }
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
