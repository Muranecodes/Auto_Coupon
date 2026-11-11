export type PlatformId = 'foodpanda' | 'ubereats';

export type CouponCategory = 'wallet' | 'checkout_only';

export type RedemptionOutcome =
  | 'claimed'
  | 'already_claimed'
  | 'invalid_or_expired';

export interface CouponEntry {
  code: string;
  platform: PlatformId;
  title: string;
  description?: string;
  category: CouponCategory;
  expiresAt: string | null; // YYYY-MM-DD or null
  sourceUrl?: string;
  updatedAt: string;
}

export interface CouponFeed {
  updatedAt: string;
  coupons: CouponEntry[];
}

export interface RedemptionRecord {
  code: string;
  platform: PlatformId;
  outcome: RedemptionOutcome;
  message?: string;
  attemptedAt: string;
}

export interface CandidateChip {
  code: string;
  selected: boolean;
}

export interface PendingRedemptionState {
  platform: PlatformId;
  codes: string[];
  forceRetry: boolean;
  createdAt: string;
}
