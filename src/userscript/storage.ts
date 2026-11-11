import type {
  CouponFeed,
  PendingRedemptionState,
  PlatformId,
  RedemptionOutcome,
  RedemptionRecord,
} from '../shared/types.ts';

declare const GM_getValue:
  | ((key: string, defaultValue?: string) => string | undefined)
  | undefined;
declare const GM_setValue: ((key: string, value: string) => void) | undefined;

const STORAGE_PREFIX = 'auto_coupon:v1:';

function readRaw(key: string): string | null {
  const fullKey = `${STORAGE_PREFIX}${key}`;
  try {
    if (typeof GM_getValue === 'function') {
      const val = GM_getValue(fullKey, '');
      if (val) return val;
    }
  } catch {
    // Fallback to localStorage
  }
  try {
    return localStorage.getItem(fullKey);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  const fullKey = `${STORAGE_PREFIX}${key}`;
  try {
    if (typeof GM_setValue === 'function') {
      GM_setValue(fullKey, value ?? '');
    }
  } catch {
    // Fallback to localStorage
  }
  try {
    if (value === null) {
      localStorage.removeItem(fullKey);
    } else {
      localStorage.setItem(fullKey, value);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function normalizeCouponCode(code: string): string {
  return code.trim();
}

export function dedupeCouponCodes(codes: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const norm = normalizeCouponCode(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    unique.push(norm);
  }
  return unique;
}

export function loadRedemptionRecords(
  platform: PlatformId,
): Record<string, RedemptionRecord> {
  const raw = readRaw(`records:${platform}`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, RedemptionRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRedemptionRecord(
  platform: PlatformId,
  code: string,
  outcome: RedemptionOutcome,
  message?: string,
): RedemptionRecord {
  const normalized = normalizeCouponCode(code);
  const records = loadRedemptionRecords(platform);
  const record: RedemptionRecord = {
    code: normalized,
    platform,
    outcome,
    message,
    attemptedAt: new Date().toISOString(),
  };
  records[normalized] = record;
  writeRaw(`records:${platform}`, JSON.stringify(records));
  return record;
}

export function savePendingRunState(
  state: PendingRedemptionState | null,
): void {
  writeRaw('pending_run', state ? JSON.stringify(state) : null);
}

export function consumePendingRunState(
  platform: PlatformId,
): PendingRedemptionState | null {
  const raw = readRaw('pending_run');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingRedemptionState;
    if (parsed && parsed.platform === platform && Array.isArray(parsed.codes)) {
      writeRaw('pending_run', null);
      return parsed;
    }
  } catch {
    writeRaw('pending_run', null);
  }
  return null;
}

export function loadCachedFeed(): CouponFeed | null {
  const raw = readRaw('cached_feed');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CouponFeed;
  } catch {
    return null;
  }
}

export function saveCachedFeed(feed: CouponFeed): void {
  writeRaw('cached_feed', JSON.stringify(feed));
}
