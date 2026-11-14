import type {
  CouponEntry,
  RedemptionOutcome,
  RedemptionRecord,
} from '../shared/types.ts';
import {
  DEFAULT_FEED_URL,
  fetchCouponFeed,
  partitionPlatformCoupons,
} from './feed.ts';
import {
  detectPlatform,
  installAntiAppHijack,
  installInputFocusTracker,
  installNetworkFeedbackSniffer,
  navigateWithoutAppSwitch,
  setNativeInputValue,
  triggerSubmitOrEnter,
  type PlatformAdapter,
} from './platforms.ts';
import {
  clearRedemptionRecords,
  consumePendingRunState,
  dedupeCouponCodes,
  deleteRedemptionRecord,
  loadRedemptionRecords,
  loadSpeedMode,
  savePendingRunState,
  saveRedemptionRecord,
  saveSpeedMode,
  type SpeedMode,
} from './storage.ts';

export interface MountAutoCouponOptions {
  url?: string;
  delayMs?: () => number;
  autoSyncFeed?: boolean;
  feedUrl?: string;
  fetchFeed?: (url: string) => Promise<unknown>;
  navigate?: (url: string) => void;
}

export interface AutoCouponController {
  platform: PlatformAdapter;
  setQueue(codes: string[]): void;
  getQueue(): string[];
  syncFeed(): Promise<void>;
  waitForIdle(): Promise<void>;
}

export function getSpeedDelayFn(speedMode: SpeedMode): () => number {
  if (speedMode === 'safe') {
    return () => 3000 + Math.floor(Math.random() * 3000);
  }
  return () => 2000 + Math.floor(Math.random() * 1500);
}

const DEFAULT_DELAY_FN = () => 2000 + Math.floor(Math.random() * 1500);

function applyHostStyles(el: HTMLElement): void {
  try {
    el.style.cssText =
      'position: static !important;' +
      'display: block !important;' +
      'margin: 0 !important;' +
      'padding: 0 !important;' +
      'border: none !important;' +
      'background: transparent !important;';
  } catch {
    // Ignore in non-browser env
  }
}

const SHADOW_STYLES = `
  :host {
    all: initial;
    display: block;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
  }
  .ac-pill {
    position: fixed;
    right: 16px;
    bottom: calc(90px + env(safe-area-inset-bottom, 0px));
    z-index: 2147483647;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 14px;
    border-radius: 999px;
    border: 2px solid rgba(255, 255, 255, 0.95);
    background: linear-gradient(135deg, #f472b6 0%, #ec4899 50%, #c084fc 100%);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    box-shadow: 0 6px 24px rgba(236, 72, 153, 0.4);
    cursor: pointer;
    white-space: nowrap;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .ac-pill:hover {
    transform: scale(1.02);
    box-shadow: 0 8px 26px rgba(236, 72, 153, 0.48);
  }
  .ac-pill-badge {
    background: #fff;
    color: #db2777;
    border-radius: 999px;
    padding: 2px 7px;
    font-size: 12px;
    font-weight: 800;
    display: inline-block;
  }
  .ac-pill-close-icon {
    display: none;
    font-size: 18px;
    font-weight: 800;
    line-height: 1;
  }
  @keyframes ac-sheet-pop {
    from {
      opacity: 0;
      transform: scale(0.94);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  .ac-sheet {
    position: fixed;
    z-index: 2147483647;
    background: #ffffff;
    color: #1f2937;
    box-shadow: 0 10px 32px rgba(219, 39, 119, 0.16), 0 2px 10px rgba(0, 0, 0, 0.08);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: opacity 0.18s ease;
    box-sizing: border-box;
    border: 1px solid rgba(244, 114, 182, 0.3);
  }
  .ac-sheet[data-open="true"] {
    animation: ac-sheet-pop 0.16s ease-out;
  }
  /* Desktop: sheet grows out of floating pill position; pill becomes circular ✕ collapse button */
  @media (min-width: 641px) {
    .ac-pill[data-open="true"] {
      width: 44px;
      height: 44px;
      padding: 0;
      gap: 0;
    }
    .ac-pill[data-open="true"] .ac-pill-label,
    .ac-pill[data-open="true"] .ac-pill-badge {
      display: none;
    }
    .ac-pill[data-open="true"] .ac-pill-close-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .ac-sheet {
      right: 16px;
      bottom: calc(146px + env(safe-area-inset-bottom, 0px));
      top: auto;
      width: 360px;
      max-width: calc(100vw - 16px);
      max-height: min(62vh, calc(100vh - 166px));
      border-radius: 16px;
      padding: 12px 14px;
      transform-origin: bottom right;
    }
    .ac-sheet .ac-header {
      cursor: grab;
      touch-action: none;
      -webkit-user-select: none;
      user-select: none;
    }
    .ac-sheet .ac-header:active {
      cursor: grabbing;
    }
    .ac-sheet .ac-close-btn {
      display: none;
    }
  }
  /* Mobile: fixed-height bottom sheet; pill hides while open and header keeps close button */
  @media (max-width: 640px) {
    .ac-pill[data-open="true"] {
      display: none;
    }
    .ac-sheet {
      left: 0;
      right: 0;
      bottom: 0;
      height: 45vh;
      max-height: 50vh;
      border-radius: 18px 18px 0 0;
      padding: 12px 14px calc(16px + env(safe-area-inset-bottom, 0px));
    }
    .ac-sheet .ac-close-btn {
      display: inline-flex;
    }
  }
  .ac-sheet[data-open="false"] {
    display: none;
  }
  .ac-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    flex-shrink: 0;
  }
  .ac-notice {
    font-size: 11px;
    color: #9d174d;
    background: #fdf2f8;
    border: 1px solid #fbcfe8;
    border-radius: 8px;
    padding: 6px 8px;
    margin-bottom: 8px;
    line-height: 1.4;
    flex-shrink: 0;
  }
  .ac-title {
    font-size: 14px;
    font-weight: 800;
    color: #be185d;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ac-tab-bar {
    display: flex;
    gap: 4px;
    padding: 3px;
    background: #fdf2f8;
    border-radius: 999px;
    margin-bottom: 8px;
    border: 1px solid #fce7f3;
    flex-shrink: 0;
  }
  .ac-tab-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 5px 8px;
    border-radius: 999px;
    border: none;
    background: transparent;
    color: #9d174d;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .ac-tab-btn[data-active="true"] {
    background: #ffffff;
    color: #db2777;
    font-weight: 800;
    box-shadow: 0 2px 6px rgba(219, 39, 119, 0.15);
  }
  .ac-tab-badge {
    background: #fce7f3;
    color: #db2777;
    border-radius: 999px;
    padding: 1px 5px;
    font-size: 10px;
    font-weight: 700;
  }
  .ac-tab-btn[data-active="true"] .ac-tab-badge {
    background: #fdf2f8;
    color: #be185d;
  }
  .ac-tab-panel {
    display: none;
  }
  .ac-tab-panel[data-active="true"] {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .ac-btn {
    padding: 6px 12px;
    border-radius: 999px;
    border: none;
    background: linear-gradient(135deg, #ec4899 0%, #c084fc 100%);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
  }
  .ac-btn:active {
    transform: scale(0.97);
  }
  .ac-btn-secondary {
    background: #fdf2f8;
    color: #be185d;
    border: 1px solid #fbcfe8;
  }
  .ac-btn-danger {
    background: #fee2e2;
    color: #b91c1c;
    border: 1px solid #fecaca;
  }
  .ac-btn-sm {
    padding: 3px 8px;
    font-size: 11px;
    border-radius: 8px;
  }
  .ac-action-row {
    display: flex;
    align-items: stretch;
    gap: 8px;
    margin: 2px 0 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid #fce7f3;
    flex-shrink: 0;
  }
  .ac-btn-cta {
    flex: 1;
    min-height: 38px;
    padding: 8px 12px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 800;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    cursor: pointer;
    transition: transform 0.1s ease, box-shadow 0.15s ease, opacity 0.15s ease;
  }
  .ac-btn-cta:active {
    transform: translateY(1px) scale(0.98);
  }
  .ac-btn-cta-primary {
    border: none;
    background: linear-gradient(135deg, #ec4899 0%, #db2777 100%);
    color: #ffffff;
    box-shadow: 0 4px 12px rgba(219, 39, 119, 0.28);
  }
  .ac-btn-cta-secondary {
    background: #ffffff;
    color: #be185d;
    border: 1.5px solid #f472b6;
    box-shadow: 0 2px 6px rgba(219, 39, 119, 0.12);
  }
  .ac-btn-cta-secondary[data-paused="false"] {
    opacity: 0.58;
    box-shadow: none;
  }
  .ac-btn-cta-secondary[data-paused="true"] {
    opacity: 1;
    background: #fdf2f8;
    box-shadow: 0 4px 12px rgba(219, 39, 119, 0.22);
  }
  .ac-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .ac-section {
    margin-top: 4px;
    padding-top: 6px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .ac-select {
    padding: 3px 6px;
    border-radius: 6px;
    border: 1px solid #fbcfe8;
    background: #fff;
    font-size: 11px;
    color: #1f2937;
    outline: none;
    cursor: pointer;
  }
  .ac-select:focus {
    border-color: #ec4899;
  }
  .ac-scroll-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin-top: 4px;
    padding-right: 2px;
  }
  .ac-scroll-list::-webkit-scrollbar {
    width: 4px;
  }
  .ac-scroll-list::-webkit-scrollbar-thumb {
    background: #fbcfe8;
    border-radius: 4px;
  }
  .ac-badge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
  }
  .ac-badge-claimed {
    background: #dcfce7;
    color: #15803d;
  }
  .ac-badge-already_claimed {
    background: #f3e8ff;
    color: #7e22ce;
  }
  .ac-badge-invalid_or_expired {
    background: #fdf2f8;
    color: #9d174d;
  }
  .ac-badge-pending {
    background: #f3f4f6;
    color: #6b7280;
  }
  .ac-badge-submitting {
    background: #fef3c7;
    color: #b45309;
  }
  .ac-history-filter-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    margin-bottom: 6px;
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .ac-filter-chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .ac-filter-chip {
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid #fbcfe8;
    background: #fff;
    color: #9d174d;
    font-size: 11px;
    cursor: pointer;
  }
  .ac-filter-chip[data-active="true"] {
    background: #ec4899;
    color: #fff;
    border-color: #ec4899;
    font-weight: 700;
  }
  .ac-accordion-card {
    background: #fff;
    border: 1px solid #fce7f3;
    border-radius: 10px;
    margin-bottom: 5px;
    overflow: hidden;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .ac-accordion-card:hover {
    border-color: #f472b6;
  }
  .ac-accordion-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    cursor: pointer;
    gap: 6px;
    user-select: none;
    background: #fff;
  }
  .ac-accordion-header-left {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 700;
    color: #1f2937;
  }
  .ac-accordion-header-right {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: #9ca3af;
  }
  .ac-accordion-body {
    padding: 6px 8px;
    background: #fdf2f8;
    border-top: 1px dashed #fbcfe8;
    font-size: 11px;
    color: #4b5563;
    display: none;
  }
  .ac-accordion-card[data-expanded="true"] .ac-accordion-body {
    display: block;
  }
  .ac-accordion-card[data-expanded="true"] .ac-chevron {
    transform: rotate(180deg);
  }
  .ac-chevron {
    transition: transform 0.2s ease;
    display: inline-block;
    font-size: 8px;
    color: #be185d;
  }
  .ac-accordion-actions {
    margin-top: 6px;
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
`;

function clearChildren(el: HTMLElement): void {
  while (el.children && el.children.length > 0) {
    el.children[0]!.remove();
  }
  el.textContent = '';
}

function createEl<K extends string>(
  doc: Document,
  tag: K,
  attrs?: Record<string, string>,
  text?: string,
): HTMLElement {
  const el = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

interface RectBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const VIEWPORT_EDGE = 8;
const PILL_SHEET_GAP = 12;
const PILL_CIRCLE_SIZE = 44;
const DEFAULT_PILL_ESTIMATE = { width: 138, height: 42 };
const DEFAULT_SHEET_WIDTH = 360;
const DEFAULT_SHEET_HEIGHT = 280;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function getViewportSize(): { width: number; height: number } {
  const width =
    typeof window !== 'undefined' &&
    typeof window.innerWidth === 'number' &&
    window.innerWidth > 0
      ? window.innerWidth
      : 1280;
  const height =
    typeof window !== 'undefined' &&
    typeof window.innerHeight === 'number' &&
    window.innerHeight > 0
      ? window.innerHeight
      : 800;
  return { width, height };
}

function isDesktopViewport(): boolean {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia('(min-width: 641px)').matches;
    } catch {
      // Fallback to innerWidth check
    }
  }
  return getViewportSize().width >= 641;
}

function getElementRect(el: HTMLElement, fallback: RectBox): RectBox {
  if (typeof el.getBoundingClientRect === 'function') {
    const r = el.getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0)) {
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    }
  }
  return fallback;
}

function makeRect(left: number, top: number, width: number, height: number): RectBox {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

export function mountAutoCoupon(
  options: MountAutoCouponOptions = {},
): AutoCouponController {
  try {
    installNetworkFeedbackSniffer();
  } catch {
    // Ignore sniffer error
  }
  try {
    installAntiAppHijack(document);
  } catch {
    // Ignore anti-hijack error
  }
  try {
    installInputFocusTracker(document);
  } catch {
    // Ignore focus tracker error
  }

  const getLiveUrl = (): string =>
    options.url ??
    (typeof window !== 'undefined' && window.location
      ? window.location.href
      : 'https://www.foodpanda.com.tw/');
  const currentUrl = getLiveUrl();
  const platform = detectPlatform(currentUrl);
  let currentSpeedMode: SpeedMode = loadSpeedMode(platform.id);
  const getEffectiveDelayFn = (): (() => number) => {
    if (options.delayMs) return options.delayMs;
    return getSpeedDelayFn(currentSpeedMode);
  };
  const delayFn = () => getEffectiveDelayFn()();
  const feedUrl = options.feedUrl ?? DEFAULT_FEED_URL;
  const navigateFn =
    options.navigate ??
    ((targetUrl: string) => {
      if (typeof window !== 'undefined' && window.location) {
        window.location.href = targetUrl;
      }
    });

  const existingHost = document.querySelector('#auto-coupon-root') as
    | (HTMLElement & {
        __acCleanup?: () => void;
        __acController?: AutoCouponController;
      })
    | null;
  if (existingHost) {
    if (
      existingHost.__acController &&
      existingHost.shadowRoot?.querySelector('[data-role="floating-pill"]')
    ) {
      return existingHost.__acController;
    }
    existingHost.__acCleanup?.();
    existingHost.remove();
  }

  const host = document.createElement('div') as HTMLElement & {
    __acCleanup?: () => void;
    __acController?: AutoCouponController;
  };
  host.id = 'auto-coupon-root';
  applyHostStyles(host);

  const ensureHostMounted = (): void => {
    try {
      const mountTarget = document.body ?? document.documentElement;
      if (!mountTarget) return;
      applyHostStyles(host);
      if (
        host.parentElement !== mountTarget ||
        document.querySelector('#auto-coupon-root') !== host
      ) {
        mountTarget.appendChild(host);
      }
    } catch {
      // Ignore transient hydration DOM errors
    }
  };
  ensureHostMounted();

  let mutationObserver: { disconnect(): void } | null = null;
  try {
    if (
      typeof MutationObserver === 'function' &&
      document.documentElement
    ) {
      const obs = new MutationObserver(() => {
        ensureHostMounted();
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      mutationObserver = obs;
    }
  } catch {
    // Ignore MutationObserver errors in minimal DOM environments
  }

  const keepAliveTimer = setInterval(ensureHostMounted, 50);
  (keepAliveTimer as unknown as { unref?: () => void })?.unref?.();

  let rateLimitCooldownTimer: ReturnType<typeof setInterval> | null = null;

  function clearRateLimitCooldown(): void {
    if (rateLimitCooldownTimer !== null) {
      clearInterval(rateLimitCooldownTimer);
      rateLimitCooldownTimer = null;
    }
  }

  const cleanupCallbacks: Array<() => void> = [];

  host.__acCleanup = () => {
    clearInterval(keepAliveTimer);
    mutationObserver?.disconnect();
    clearRateLimitCooldown();
    for (const cb of cleanupCallbacks) {
      try {
        cb();
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  const shadow = host.attachShadow({ mode: 'open' });

  let isOpen = false;
  let customPillPos: { left: number; top: number } | null = null;
  let forceRetry = false;
  let manualQueueCodes: string[] = [];
  let feedWalletCoupons: CouponEntry[] = [];
  let feedCheckoutCoupons: CouponEntry[] = [];
  let pausedRemainingCodes: string[] = [];
  let copiedCheckoutCode: string | null = null;
  let activeTaskPromise: Promise<void> | null = null;
  let runStatusText = '待命';
  let summaryCounts: Record<RedemptionOutcome, number> = {
    claimed: 0,
    already_claimed: 0,
    invalid_or_expired: 0,
  };

  // Build Shadow DOM without innerHTML so strict Trusted Types CSP (e.g. on Uber Eats) never blocks mounting
  const styleEl = createEl(document, 'style', undefined, SHADOW_STYLES);
  shadow.appendChild(styleEl);

  const pillBtn = createEl(document, 'button', {
    type: 'button',
    class: 'ac-pill',
    'data-role': 'floating-pill',
    'data-open': 'false',
    'aria-label': '展開自動領券選單',
  }) as HTMLButtonElement;
  pillBtn.appendChild(
    createEl(document, 'span', { class: 'ac-pill-label' }, '🎟️ 自動領券'),
  );
  const pillBadge = createEl(
    document,
    'span',
    { class: 'ac-pill-badge', 'data-role': 'pill-badge' },
    '0',
  );
  pillBtn.appendChild(pillBadge);
  pillBtn.appendChild(
    createEl(
      document,
      'span',
      { class: 'ac-pill-close-icon', 'aria-hidden': 'true' },
      '✕',
    ),
  );
  const isUber = platform.id === 'ubereats';
  const pillBg = isUber
    ? 'linear-gradient(135deg, #06C167, #10B981)'
    : 'linear-gradient(135deg, #d70f64, #ff2b85)';
  const badgeColor = isUber ? '#06C167' : '#d70f64';
  const shadowColor = isUber
    ? 'rgba(6, 193, 103, 0.45)'
    : 'rgba(215, 15, 100, 0.4)';

  pillBtn.style.background = pillBg;
  pillBtn.style.boxShadow = `0 6px 24px ${shadowColor}`;
  pillBadge.style.color = badgeColor;

  shadow.appendChild(pillBtn);

  const sheetEl = createEl(document, 'section', {
    class: 'ac-sheet',
    'data-role': 'bottom-sheet',
    'data-open': 'false',
  });

  const headerRow = createEl(document, 'div', { class: 'ac-header' });
  headerRow.appendChild(
    createEl(
      document,
      'div',
      { class: 'ac-title', 'data-role': 'platform-title' },
      `${platform.displayName} 自動領券`,
    ),
  );
  const closeBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-btn ac-btn-secondary ac-close-btn',
      'data-role': 'close-sheet-btn',
    },
    '收合',
  ) as HTMLButtonElement;
  headerRow.appendChild(closeBtn);
  sheetEl.appendChild(headerRow);

  const isIos =
    typeof navigator !== 'undefined' &&
    /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  if (isIos) {
    const noticeEl = createEl(
      document,
      'div',
      { class: 'ac-notice', 'data-role': 'ios-notice' },
      '⚠️ 提醒：iOS Safari 行動版因 WebKit 限制相容性較有限（目前優先開發電腦網頁版）。若領券遇到問題，建議改用電腦瀏覽器（Tampermonkey）操作！',
    );
    sheetEl.appendChild(noticeEl);
  }

  let activeTab: 'queue' | 'history' | 'checkout' = 'queue';
  let historyFilter: 'all' | RedemptionOutcome = 'all';
  const expandedHistoryCodes = new Set<string>();

  const tabBar = createEl(document, 'div', {
    class: 'ac-tab-bar',
    'data-role': 'tab-bar',
  });
  const tabQueueBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-tab-btn',
      'data-role': 'tab-queue',
      'data-tab': 'queue',
      'data-active': 'true',
    },
    '💰 省錢錢',
  );
  const tabHistoryBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-tab-btn',
      'data-role': 'tab-history',
      'data-tab': 'history',
      'data-active': 'false',
    },
  );
  tabHistoryBtn.appendChild(createEl(document, 'span', undefined, '🌸 歷史紀錄 '));
  const historyBadgeEl = createEl(
    document,
    'span',
    { class: 'ac-tab-badge', 'data-role': 'history-badge' },
    '0',
  );
  tabHistoryBtn.appendChild(historyBadgeEl);

  const tabCheckoutBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-tab-btn',
      'data-role': 'tab-checkout',
      'data-tab': 'checkout',
      'data-active': 'false',
    },
    '🎫 結帳限定碼',
  );

  tabBar.appendChild(tabQueueBtn);
  tabBar.appendChild(tabHistoryBtn);
  tabBar.appendChild(tabCheckoutBtn);
  sheetEl.appendChild(tabBar);

  const tabQueuePanel = createEl(document, 'div', {
    class: 'ac-tab-panel',
    'data-panel': 'queue',
    'data-active': 'true',
  });
  const tabHistoryPanel = createEl(document, 'div', {
    class: 'ac-tab-panel',
    'data-panel': 'history',
    'data-active': 'false',
  });
  const tabCheckoutPanel = createEl(document, 'div', {
    class: 'ac-tab-panel',
    'data-panel': 'checkout',
    'data-active': 'false',
  });

  const actionRow = createEl(document, 'div', {
    class: 'ac-action-row',
    'data-role': 'action-row',
  });
  const startRunBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-btn-cta ac-btn-cta-primary',
      'data-role': 'start-run-btn',
    },
    '🚀 開始批次歸戶',
  ) as HTMLButtonElement;
  if (platform.id === 'ubereats') {
    startRunBtn.style.background =
      'linear-gradient(135deg, #06C167 0%, #059669 100%)';
    startRunBtn.style.boxShadow = '0 4px 12px rgba(6, 193, 103, 0.28)';
  }
  const resumeRunBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-btn-cta ac-btn-cta-secondary',
      'data-role': 'resume-run-btn',
      'data-paused': 'false',
    },
    '▶ 繼續執行',
  ) as HTMLButtonElement;
  actionRow.appendChild(startRunBtn);
  actionRow.appendChild(resumeRunBtn);
  tabQueuePanel.appendChild(actionRow);

  const statusRow = createEl(document, 'div', {
    class: 'ac-row',
    style: 'justify-content: space-between;',
  });
  const statusEl = createEl(
    document,
    'span',
    { 'data-role': 'run-status', style: 'flex: 1; min-width: 0;' },
    '狀態：待命',
  );
  const syncFeedBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-btn ac-btn-secondary',
      'data-role': 'sync-feed-btn',
    },
    '同步最新清單',
  ) as HTMLButtonElement;
  statusRow.appendChild(statusEl);
  statusRow.appendChild(syncFeedBtn);
  tabQueuePanel.appendChild(statusRow);

  const summaryEl = createEl(
    document,
    'div',
    { class: 'ac-row', 'data-role': 'run-summary' },
    '成功: 0 | 已領過: 0 | 無效/過期: 0',
  );
  tabQueuePanel.appendChild(summaryEl);

  const forceRetryRow = createEl(document, 'div', {
    class: 'ac-row',
    style: 'justify-content: space-between;',
  });
  const forceRetryLabel = createEl(document, 'label', {
    style: 'display: inline-flex; align-items: center; gap: 4px;',
  });
  const forceRetryCheckbox = createEl(document, 'input', {
    type: 'checkbox',
    'data-role': 'force-retry-checkbox',
  }) as HTMLInputElement;
  forceRetryLabel.appendChild(forceRetryCheckbox);
  const forceRetryText = createEl(
    document,
    'span',
    undefined,
    '強制重試已記錄的優惠碼',
  );
  forceRetryLabel.appendChild(forceRetryText);
  forceRetryRow.appendChild(forceRetryLabel);

  const speedControlWrapper = createEl(document, 'div', {
    style: 'display: inline-flex; align-items: center; gap: 4px; font-size: 11px;',
  });
  const speedLabel = createEl(document, 'span', undefined, '速度：');
  const speedSelect = createEl(document, 'select', {
    class: 'ac-select',
    'data-role': 'speed-mode-select',
  }) as HTMLSelectElement;
  const optSafe = createEl(
    document,
    'option',
    { value: 'safe' },
    '安全防風控 (3~6s)',
  );
  const optStandard = createEl(
    document,
    'option',
    { value: 'standard' },
    '標準 (2~3.5s)',
  );
  speedSelect.appendChild(optSafe);
  speedSelect.appendChild(optStandard);
  speedSelect.value = currentSpeedMode;

  speedSelect.addEventListener('change', () => {
    currentSpeedMode = speedSelect.value as SpeedMode;
    saveSpeedMode(platform.id, currentSpeedMode);
  });

  speedControlWrapper.appendChild(speedLabel);
  speedControlWrapper.appendChild(speedSelect);
  forceRetryRow.appendChild(speedControlWrapper);
  tabQueuePanel.appendChild(forceRetryRow);

  // History Panel Setup
  const historyFilterBar = createEl(document, 'div', {
    class: 'ac-history-filter-bar',
  });
  const filterChipsContainer = createEl(document, 'div', {
    class: 'ac-filter-chips',
  });

  const filterOptions: Array<{ key: 'all' | RedemptionOutcome; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'claimed', label: '🌸 成功' },
    { key: 'already_claimed', label: '✨ 已領過' },
    { key: 'invalid_or_expired', label: '💭 無效' },
  ];
  const historyFilterChips: HTMLElement[] = [];
  for (const opt of filterOptions) {
    const chip = createEl(
      document,
      'button',
      {
        type: 'button',
        class: 'ac-filter-chip',
        'data-role': `history-filter-${opt.key}`,
        'data-filter': opt.key,
        'data-active': opt.key === 'all' ? 'true' : 'false',
      },
      opt.label,
    );
    chip.addEventListener('click', () => {
      historyFilter = opt.key;
      renderHistory();
    });
    historyFilterChips.push(chip);
    filterChipsContainer.appendChild(chip);
  }
  historyFilterBar.appendChild(filterChipsContainer);

  const clearHistoryBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-btn ac-btn-danger ac-btn-sm',
      'data-role': 'clear-history-btn',
    },
    '🗑️ 清空歷史',
  ) as HTMLButtonElement;
  clearHistoryBtn.addEventListener('click', () => {
    const confirmFn =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm
        : typeof (globalThis as { confirm?: (msg: string) => boolean }).confirm ===
            'function'
          ? (globalThis as { confirm: (msg: string) => boolean }).confirm
          : null;
    const ok = confirmFn
      ? confirmFn('確定要清空此平台的所有歷史領取紀錄嗎？')
      : true;
    if (ok) {
      clearRedemptionRecords(platform.id);
      expandedHistoryCodes.clear();
      renderState();
    }
  });
  historyFilterBar.appendChild(clearHistoryBtn);
  tabHistoryPanel.appendChild(historyFilterBar);

  const historyListEl = createEl(document, 'div', {
    class: 'ac-scroll-list',
    'data-role': 'history-coupon-list',
  });
  tabHistoryPanel.appendChild(historyListEl);

  // Checkout Panel Setup
  const checkoutSection = createEl(document, 'div', { class: 'ac-section' });
  checkoutSection.appendChild(
    createEl(
      document,
      'div',
      undefined,
      '結帳限定碼（點擊一鍵複製）：',
    ),
  );
  const checkoutListEl = createEl(document, 'div', {
    class: 'ac-scroll-list',
    'data-role': 'checkout-coupon-list',
  });
  checkoutSection.appendChild(checkoutListEl);
  tabCheckoutPanel.appendChild(checkoutSection);

  sheetEl.appendChild(tabQueuePanel);
  sheetEl.appendChild(tabHistoryPanel);
  sheetEl.appendChild(tabCheckoutPanel);

  shadow.appendChild(sheetEl);

  function switchTab(tab: 'queue' | 'history' | 'checkout'): void {
    activeTab = tab;
    tabQueueBtn.setAttribute('data-active', tab === 'queue' ? 'true' : 'false');
    tabHistoryBtn.setAttribute('data-active', tab === 'history' ? 'true' : 'false');
    tabCheckoutBtn.setAttribute('data-active', tab === 'checkout' ? 'true' : 'false');

    tabQueuePanel.setAttribute('data-active', tab === 'queue' ? 'true' : 'false');
    tabHistoryPanel.setAttribute('data-active', tab === 'history' ? 'true' : 'false');
    tabCheckoutPanel.setAttribute('data-active', tab === 'checkout' ? 'true' : 'false');

    if (tab === 'history') {
      renderHistory();
    }
    syncFloatingLayout();
  }

  tabQueueBtn.addEventListener('click', () => switchTab('queue'));
  tabHistoryBtn.addEventListener('click', () => switchTab('history'));
  tabCheckoutBtn.addEventListener('click', () => switchTab('checkout'));

  function getEffectiveWalletCodes(): string[] {
    return dedupeCouponCodes([
      ...manualQueueCodes,
      ...feedWalletCoupons.map((c) => c.code),
    ]);
  }

  function computeUntriedCount(): number {
    const records = loadRedemptionRecords(platform.id);
    return getEffectiveWalletCodes().filter((code) => !records[code]).length;
  }

  function renderHistory(): void {
    clearChildren(historyListEl);
    const records = loadRedemptionRecords(platform.id);
    const allRecords = Object.values(records);
    historyBadgeEl.textContent = String(allRecords.length);

    for (const chip of historyFilterChips) {
      chip.setAttribute(
        'data-active',
        chip.getAttribute('data-filter') === historyFilter ? 'true' : 'false',
      );
    }

    const filtered = allRecords.filter((rec) => {
      if (historyFilter === 'all') return true;
      return rec.outcome === historyFilter;
    });

    filtered.sort((a, b) => (b.attemptedAt || '').localeCompare(a.attemptedAt || ''));

    if (filtered.length === 0) {
      const emptyNotice = createEl(
        document,
        'div',
        {
          style:
            'text-align: center; padding: 14px 8px; color: #9d174d; font-size: 11px;',
        },
        '🌸 尚無符合條件的領取紀錄',
      );
      historyListEl.appendChild(emptyNotice);
      return;
    }

    for (const rec of filtered) {
      const isExpanded = expandedHistoryCodes.has(rec.code);
      const card = createEl(document, 'div', {
        class: 'ac-accordion-card',
        'data-role': 'history-item',
        'data-code': rec.code,
        'data-outcome': rec.outcome,
        'data-expanded': isExpanded ? 'true' : 'false',
      });

      const header = createEl(document, 'div', {
        class: 'ac-accordion-header',
        'data-role': 'accordion-toggle',
      });

      const left = createEl(document, 'div', {
        class: 'ac-accordion-header-left',
      });
      const codeSpan = createEl(document, 'span', undefined, rec.code);
      left.appendChild(codeSpan);

      const badge = createEl(
        document,
        'span',
        { class: `ac-badge ac-badge-${rec.outcome}` },
        rec.outcome === 'claimed'
          ? '🌸 成功'
          : rec.outcome === 'already_claimed'
            ? '✨ 已領過'
            : '💭 無效',
      );
      left.appendChild(badge);
      header.appendChild(left);

      const right = createEl(document, 'div', {
        class: 'ac-accordion-header-right',
      });
      const timeStr = rec.attemptedAt
        ? rec.attemptedAt.slice(5, 16).replace('T', ' ')
        : '';
      const timeSpan = createEl(document, 'span', undefined, timeStr);
      const chevron = createEl(document, 'span', { class: 'ac-chevron' }, '▼');
      right.appendChild(timeSpan);
      right.appendChild(chevron);
      header.appendChild(right);

      header.addEventListener('click', () => {
        if (expandedHistoryCodes.has(rec.code)) {
          expandedHistoryCodes.delete(rec.code);
          card.setAttribute('data-expanded', 'false');
        } else {
          expandedHistoryCodes.add(rec.code);
          card.setAttribute('data-expanded', 'true');
        }
      });
      card.appendChild(header);

      const body = createEl(document, 'div', {
        class: 'ac-accordion-body',
        'data-role': 'accordion-body',
      });
      const msgDiv = createEl(
        document,
        'div',
        undefined,
        `訊息：${rec.message || '無詳細訊息'}`,
      );
      body.appendChild(msgDiv);

      const actionsRow = createEl(document, 'div', {
        class: 'ac-accordion-actions',
      });
      const copyBtn = createEl(
        document,
        'button',
        {
          type: 'button',
          class: 'ac-btn ac-btn-secondary ac-btn-sm',
          'data-action': 'copy-history-code',
        },
        '📋 複製',
      );
      copyBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          void navigator.clipboard.writeText(rec.code);
        }
        copyBtn.textContent = '已複製';
        setTimeout(() => {
          copyBtn.textContent = '📋 複製';
        }, 1500);
      });
      actionsRow.appendChild(copyBtn);

      const resetBtn = createEl(
        document,
        'button',
        {
          type: 'button',
          class: 'ac-btn ac-btn-secondary ac-btn-sm',
          'data-action': 'reset-history-code',
          'data-code': rec.code,
        },
        '🔄 重置此券',
      );
      resetBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        deleteRedemptionRecord(platform.id, rec.code);
        expandedHistoryCodes.delete(rec.code);
        renderState();
      });
      actionsRow.appendChild(resetBtn);

      body.appendChild(actionsRow);
      card.appendChild(body);

      historyListEl.appendChild(card);
    }
  }

  function renderCheckoutCoupons(): void {
    clearChildren(checkoutListEl);
    for (const item of feedCheckoutCoupons) {
      const row = document.createElement('div');
      row.setAttribute('class', 'ac-row');

      const label = document.createElement('span');
      label.textContent = `${item.code} — ${item.title}`;

      const copyBtn = document.createElement('button');
      copyBtn.setAttribute('type', 'button');
      copyBtn.setAttribute('class', 'ac-btn ac-btn-secondary');
      copyBtn.setAttribute('data-copy-code', item.code);
      copyBtn.textContent =
        copiedCheckoutCode === item.code ? '已複製' : '複製';
      copyBtn.addEventListener('click', () => {
        copiedCheckoutCode = item.code;
        for (const btn of checkoutListEl.querySelectorAll<HTMLButtonElement>(
          '[data-copy-code]',
        )) {
          btn.textContent =
            btn.getAttribute('data-copy-code') === item.code
              ? '已複製'
              : '複製';
        }
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          void navigator.clipboard.writeText(item.code);
        }
      });

      row.appendChild(label);
      row.appendChild(copyBtn);
      checkoutListEl.appendChild(row);
    }
  }

  let currentPlacement: 'above' | 'below' = 'above';
  let activeDragPlacement: 'above' | 'below' | null = null;

  function applyPillPosition(): void {
    if (customPillPos) {
      pillBtn.style.left = `${Math.round(customPillPos.left)}px`;
      pillBtn.style.top = `${Math.round(customPillPos.top)}px`;
      pillBtn.style.right = 'auto';
      pillBtn.style.bottom = 'auto';
    } else {
      pillBtn.style.left = '';
      pillBtn.style.top = '';
      pillBtn.style.right = '';
      pillBtn.style.bottom = '';
    }
  }

  function clearSheetInlineLayout(): void {
    sheetEl.style.left = '';
    sheetEl.style.top = '';
    sheetEl.style.right = '';
    sheetEl.style.bottom = '';
    sheetEl.style.maxHeight = '';
    sheetEl.style.transformOrigin = '';
    sheetEl.removeAttribute('data-placement');
  }

  function syncFloatingLayout(): void {
    applyPillPosition();
    const desktop = isDesktopViewport();
    if (!desktop || !isOpen) {
      clearSheetInlineLayout();
      return;
    }

    const { width: vw, height: vh } = getViewportSize();
    const fallbackPill = customPillPos
      ? makeRect(
          customPillPos.left,
          customPillPos.top,
          PILL_CIRCLE_SIZE,
          PILL_CIRCLE_SIZE,
        )
      : makeRect(
          vw - 16 - PILL_CIRCLE_SIZE,
          vh - 90 - PILL_CIRCLE_SIZE,
          PILL_CIRCLE_SIZE,
          PILL_CIRCLE_SIZE,
        );
    const pillRect = getElementRect(pillBtn, fallbackPill);
    const fallbackSheetWidth = Math.min(DEFAULT_SHEET_WIDTH, vw - VIEWPORT_EDGE * 2);
    const measuredSheet = getElementRect(
      sheetEl,
      makeRect(0, 0, fallbackSheetWidth, DEFAULT_SHEET_HEIGHT),
    );
    const sheetWidth =
      measuredSheet.width > 0 ? measuredSheet.width : fallbackSheetWidth;

    const spaceAbove = pillRect.top - VIEWPORT_EDGE - PILL_SHEET_GAP;
    const spaceBelow = vh - pillRect.bottom - VIEWPORT_EDGE - PILL_SHEET_GAP;
    const placement: 'above' | 'below' =
      activeDragPlacement ??
      (spaceAbove >= 240 || spaceAbove >= spaceBelow ? 'above' : 'below');
    currentPlacement = placement;

    const availHeight = Math.max(
      160,
      placement === 'above' ? spaceAbove : spaceBelow,
    );
    const pillCenterX = pillRect.left + pillRect.width / 2;
    const alignRight = pillCenterX >= vw / 2;
    const rawLeft = alignRight ? pillRect.right - sheetWidth : pillRect.left;
    const sheetLeft = clamp(
      rawLeft,
      VIEWPORT_EDGE,
      vw - sheetWidth - VIEWPORT_EDGE,
    );

    sheetEl.setAttribute('data-placement', placement);
    sheetEl.style.left = `${Math.round(sheetLeft)}px`;
    sheetEl.style.right = 'auto';
    sheetEl.style.maxHeight = `${Math.floor(Math.min(vh * 0.68, availHeight))}px`;

    if (placement === 'above') {
      sheetEl.style.bottom = `${Math.round(
        Math.max(VIEWPORT_EDGE, vh - pillRect.top + PILL_SHEET_GAP),
      )}px`;
      sheetEl.style.top = 'auto';
      sheetEl.style.transformOrigin = alignRight
        ? 'bottom right'
        : 'bottom left';
    } else {
      sheetEl.style.top = `${Math.round(
        Math.max(VIEWPORT_EDGE, pillRect.bottom + PILL_SHEET_GAP),
      )}px`;
      sheetEl.style.bottom = 'auto';
      sheetEl.style.transformOrigin = alignRight ? 'top right' : 'top left';
    }
  }

  function setSheetOpen(nextOpen: boolean): void {
    if (nextOpen === isOpen) {
      renderState();
      return;
    }

    if (customPillPos && isDesktopViewport()) {
      const { width: vw, height: vh } = getViewportSize();
      if (nextOpen) {
        const beforeRect = getElementRect(
          pillBtn,
          makeRect(
            customPillPos.left,
            customPillPos.top,
            DEFAULT_PILL_ESTIMATE.width,
            DEFAULT_PILL_ESTIMATE.height,
          ),
        );
        const alignRight = beforeRect.left + beforeRect.width / 2 >= vw / 2;
        const circleLeft = alignRight
          ? beforeRect.right - PILL_CIRCLE_SIZE
          : beforeRect.left;
        customPillPos = {
          left: clamp(
            circleLeft,
            VIEWPORT_EDGE,
            vw - PILL_CIRCLE_SIZE - VIEWPORT_EDGE,
          ),
          top: clamp(
            beforeRect.top,
            VIEWPORT_EDGE,
            vh - PILL_CIRCLE_SIZE - VIEWPORT_EDGE,
          ),
        };
      } else {
        const circleRect = getElementRect(
          pillBtn,
          makeRect(
            customPillPos.left,
            customPillPos.top,
            PILL_CIRCLE_SIZE,
            PILL_CIRCLE_SIZE,
          ),
        );
        isOpen = false;
        pillBtn.setAttribute('data-open', 'false');
        const afterRect = getElementRect(
          pillBtn,
          makeRect(
            circleRect.left,
            circleRect.top,
            DEFAULT_PILL_ESTIMATE.width,
            DEFAULT_PILL_ESTIMATE.height,
          ),
        );
        const alignRight = circleRect.left + circleRect.width / 2 >= vw / 2;
        const collapsedLeft = alignRight
          ? circleRect.right - afterRect.width
          : circleRect.left;
        customPillPos = {
          left: clamp(
            collapsedLeft,
            VIEWPORT_EDGE,
            vw - afterRect.width - VIEWPORT_EDGE,
          ),
          top: clamp(
            circleRect.top,
            VIEWPORT_EDGE,
            vh - afterRect.height - VIEWPORT_EDGE,
          ),
        };
      }
    }

    isOpen = nextOpen;
    renderState();
  }

  function renderState(): void {
    pillBtn.setAttribute('data-open', isOpen ? 'true' : 'false');
    pillBtn.setAttribute(
      'aria-label',
      isOpen ? '收合自動領券選單' : '展開自動領券選單',
    );
    sheetEl.setAttribute('data-open', isOpen ? 'true' : 'false');
    const totalWalletCount = getEffectiveWalletCodes().length;
    const untriedCount = computeUntriedCount();
    statusEl.textContent =
      totalWalletCount > 0
        ? `狀態：${runStatusText}（可領取 ${untriedCount} / 共 ${totalWalletCount} 筆）`
        : `狀態：${runStatusText}`;
    summaryEl.textContent = `成功: ${summaryCounts.claimed} | 已領過: ${summaryCounts.already_claimed} | 無效/過期: ${summaryCounts.invalid_or_expired}`;
    pillBadge.textContent = String(untriedCount);
    const isPaused =
      pausedRemainingCodes.length > 0 || rateLimitCooldownTimer !== null;
    resumeRunBtn.setAttribute('data-paused', isPaused ? 'true' : 'false');
    renderHistory();
    syncFloatingLayout();
  }

  async function syncFeed(): Promise<void> {
    const feed = await fetchCouponFeed(feedUrl, options.fetchFeed);
    const { walletCoupons, checkoutCoupons } = partitionPlatformCoupons(
      feed,
      platform.id,
    );
    feedWalletCoupons = walletCoupons;
    feedCheckoutCoupons = checkoutCoupons;
    renderCheckoutCoupons();
    renderState();
  }

  let suppressNextPillClick = false;
  let clearSuppressTimer: ReturnType<typeof setTimeout> | null = null;
  let activeDragCleanup: (() => void) | null = null;

  const globalEventTarget =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function'
      ? window
      : document;

  function beginDrag(
    sourceEl: HTMLElement,
    ev: Event,
    allowWhenOpenOnly = false,
  ): void {
    const pe = ev as unknown as {
      clientX?: number;
      clientY?: number;
      button?: number;
      pointerId?: number;
      target?: { closest?: (sel: string) => unknown } | null;
    };
    if (pe.button !== undefined && pe.button !== 0) return;
    if (allowWhenOpenOnly && (!isOpen || !isDesktopViewport())) return;
    if (sourceEl === headerRow && pe.target?.closest?.('button')) return;

    activeDragCleanup?.();

    const dragStartX = pe.clientX ?? 0;
    const dragStartY = pe.clientY ?? 0;
    const { width: vw, height: vh } = getViewportSize();
    const isDesktopGroupDrag = isOpen && isDesktopViewport();

    const fallbackPillStart = customPillPos
      ? makeRect(
          customPillPos.left,
          customPillPos.top,
          isDesktopGroupDrag ? PILL_CIRCLE_SIZE : DEFAULT_PILL_ESTIMATE.width,
          isDesktopGroupDrag ? PILL_CIRCLE_SIZE : DEFAULT_PILL_ESTIMATE.height,
        )
      : makeRect(
          vw - 16 - (isDesktopGroupDrag ? PILL_CIRCLE_SIZE : DEFAULT_PILL_ESTIMATE.width),
          vh - 90 - (isDesktopGroupDrag ? PILL_CIRCLE_SIZE : DEFAULT_PILL_ESTIMATE.height),
          isDesktopGroupDrag ? PILL_CIRCLE_SIZE : DEFAULT_PILL_ESTIMATE.width,
          isDesktopGroupDrag ? PILL_CIRCLE_SIZE : DEFAULT_PILL_ESTIMATE.height,
        );
    const pillStartRect = getElementRect(pillBtn, fallbackPillStart);
    const estSheetWidth = Math.min(DEFAULT_SHEET_WIDTH, vw - VIEWPORT_EDGE * 2);
    const parsedSheetLeft = Number.parseFloat(sheetEl.style.left);
    const parsedSheetTop = Number.parseFloat(sheetEl.style.top);
    const parsedSheetBottom = Number.parseFloat(sheetEl.style.bottom);
    const alignRight =
      pillStartRect.left + pillStartRect.width / 2 >= vw / 2;
    const fallbackSheetLeft = Number.isFinite(parsedSheetLeft)
      ? parsedSheetLeft
      : clamp(
          alignRight ? pillStartRect.right - estSheetWidth : pillStartRect.left,
          VIEWPORT_EDGE,
          vw - estSheetWidth - VIEWPORT_EDGE,
        );
    const fallbackSheetTop = Number.isFinite(parsedSheetTop)
      ? parsedSheetTop
      : Number.isFinite(parsedSheetBottom)
        ? vh - parsedSheetBottom - DEFAULT_SHEET_HEIGHT
        : currentPlacement === 'below'
          ? pillStartRect.bottom + PILL_SHEET_GAP
          : pillStartRect.top - PILL_SHEET_GAP - DEFAULT_SHEET_HEIGHT;
    const sheetStartRect = isDesktopGroupDrag
      ? getElementRect(
          sheetEl,
          makeRect(
            fallbackSheetLeft,
            fallbackSheetTop,
            estSheetWidth,
            DEFAULT_SHEET_HEIGHT,
          ),
        )
      : null;

    if (isDesktopGroupDrag) {
      activeDragPlacement = currentPlacement;
    }

    if (
      typeof pe.pointerId === 'number' &&
      typeof (sourceEl as unknown as { setPointerCapture?: (id: number) => void })
        .setPointerCapture === 'function'
    ) {
      try {
        (sourceEl as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture(
          pe.pointerId,
        );
      } catch {
        // Ignore capture failure on synthetic events
      }
    }

    let moved = false;

    const onPointerMove = (moveEv: Event) => {
      const mpe = moveEv as unknown as {
        clientX?: number;
        clientY?: number;
        buttons?: number;
      };
      if (mpe.buttons === 0) {
        onPointerUp();
        return;
      }
      const dx = (mpe.clientX ?? dragStartX) - dragStartX;
      const dy = (mpe.clientY ?? dragStartY) - dragStartY;
      if (!moved && Math.abs(dx) <= 6 && Math.abs(dy) <= 6) {
        return;
      }
      moved = true;
      if (sourceEl === pillBtn) {
        suppressNextPillClick = true;
      }

      const { width: curVw, height: curVh } = getViewportSize();

      if (isDesktopGroupDrag && sheetStartRect) {
        const groupLeft = Math.min(pillStartRect.left, sheetStartRect.left);
        const groupTop = Math.min(pillStartRect.top, sheetStartRect.top);
        const groupRight = Math.max(pillStartRect.right, sheetStartRect.right);
        const groupBottom = Math.max(pillStartRect.bottom, sheetStartRect.bottom);

        const clampedDx = clamp(
          dx,
          VIEWPORT_EDGE - groupLeft,
          curVw - VIEWPORT_EDGE - groupRight,
        );
        const clampedDy = clamp(
          dy,
          VIEWPORT_EDGE - groupTop,
          curVh - VIEWPORT_EDGE - groupBottom,
        );

        const newPillLeft = pillStartRect.left + clampedDx;
        const newPillTop = pillStartRect.top + clampedDy;
        const newSheetLeft = sheetStartRect.left + clampedDx;

        customPillPos = { left: newPillLeft, top: newPillTop };
        applyPillPosition();

        sheetEl.style.left = `${Math.round(newSheetLeft)}px`;
        sheetEl.style.right = 'auto';
        if (activeDragPlacement === 'below') {
          sheetEl.style.top = `${Math.round(
            newPillTop + pillStartRect.height + PILL_SHEET_GAP,
          )}px`;
          sheetEl.style.bottom = 'auto';
        } else {
          sheetEl.style.bottom = `${Math.round(
            curVh - newPillTop + PILL_SHEET_GAP,
          )}px`;
          sheetEl.style.top = 'auto';
        }
      } else {
        const newLeft = clamp(
          pillStartRect.left + dx,
          VIEWPORT_EDGE,
          curVw - pillStartRect.width - VIEWPORT_EDGE,
        );
        const newTop = clamp(
          pillStartRect.top + dy,
          VIEWPORT_EDGE,
          curVh - pillStartRect.height - VIEWPORT_EDGE,
        );
        customPillPos = { left: newLeft, top: newTop };
        applyPillPosition();
      }
    };

    const onPointerUp = () => {
      cleanupDrag();
      if (moved && sourceEl === pillBtn) {
        suppressNextPillClick = true;
        if (clearSuppressTimer !== null) {
          clearTimeout(clearSuppressTimer);
        }
        clearSuppressTimer = setTimeout(() => {
          suppressNextPillClick = false;
          clearSuppressTimer = null;
        }, 50);
        (clearSuppressTimer as unknown as { unref?: () => void })?.unref?.();
      }
    };

    const cleanupDrag = () => {
      activeDragPlacement = null;
      globalEventTarget.removeEventListener('pointermove', onPointerMove);
      globalEventTarget.removeEventListener('pointerup', onPointerUp);
      globalEventTarget.removeEventListener('pointercancel', onPointerUp);
      if (activeDragCleanup === cleanupDrag) {
        activeDragCleanup = null;
      }
    };

    activeDragCleanup = cleanupDrag;
    globalEventTarget.addEventListener('pointermove', onPointerMove);
    globalEventTarget.addEventListener('pointerup', onPointerUp);
    globalEventTarget.addEventListener('pointercancel', onPointerUp);
  }

  pillBtn.addEventListener('pointerdown', (ev: Event) => {
    beginDrag(pillBtn, ev, false);
  });

  headerRow.addEventListener('pointerdown', (ev: Event) => {
    beginDrag(headerRow, ev, true);
  });

  const onViewportResize = () => {
    if (customPillPos) {
      const { width: vw, height: vh } = getViewportSize();
      const estW =
        isOpen && isDesktopViewport()
          ? PILL_CIRCLE_SIZE
          : DEFAULT_PILL_ESTIMATE.width;
      const estH =
        isOpen && isDesktopViewport()
          ? PILL_CIRCLE_SIZE
          : DEFAULT_PILL_ESTIMATE.height;
      customPillPos = {
        left: clamp(customPillPos.left, VIEWPORT_EDGE, vw - estW - VIEWPORT_EDGE),
        top: clamp(customPillPos.top, VIEWPORT_EDGE, vh - estH - VIEWPORT_EDGE),
      };
    }
    syncFloatingLayout();
  };
  globalEventTarget.addEventListener('resize', onViewportResize);

  cleanupCallbacks.push(() => {
    activeDragCleanup?.();
    if (clearSuppressTimer !== null) {
      clearTimeout(clearSuppressTimer);
      clearSuppressTimer = null;
    }
    globalEventTarget.removeEventListener('resize', onViewportResize);
  });

  pillBtn.addEventListener('click', () => {
    if (suppressNextPillClick) {
      suppressNextPillClick = false;
      return;
    }
    setSheetOpen(!isOpen);
  });

  closeBtn.addEventListener('click', () => {
    setSheetOpen(false);
  });

  syncFeedBtn.addEventListener('click', () => {
    activeTaskPromise = syncFeed();
  });

  forceRetryCheckbox.addEventListener('change', () => {
    forceRetry = Boolean(forceRetryCheckbox.checked);
  });

  function startRateLimitCooldown(initialMsg: string): void {
    clearRateLimitCooldown();
    let remainingSeconds = 600;
    const formatTimer = (secs: number) => {
      const m = Math.floor(secs / 60)
        .toString()
        .padStart(2, '0');
      const s = (secs % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    };
    runStatusText = `🚨 風控限制中（${initialMsg}）— 建議冷卻：${formatTimer(remainingSeconds)} (可隨時點擊「繼續執行」提早嘗試)`;
    renderState();

    rateLimitCooldownTimer = setInterval(() => {
      remainingSeconds--;
      if (remainingSeconds <= 0) {
        clearRateLimitCooldown();
        runStatusText = '建議冷卻時間已結束，請點擊「繼續執行」接續嘗試';
        renderState();
      } else {
        runStatusText = `🚨 風控限制中（${initialMsg}）— 建議冷卻：${formatTimer(remainingSeconds)} (可隨時點擊「繼續執行」提早嘗試)`;
        renderState();
      }
    }, 1000);
    (rateLimitCooldownTimer as unknown as { unref?: () => void })?.unref?.();
  }

  async function executeRedemptionRun(
    codesToRun: string[],
    isResuming = false,
  ): Promise<void> {
    clearRateLimitCooldown();
    if (!isResuming) {
      summaryCounts = {
        claimed: 0,
        already_claimed: 0,
        invalid_or_expired: 0,
      };
    }

    const dedupedCodes = dedupeCouponCodes(codesToRun);

    const preBlock = platform.detectChallengeOrAuthBlock(document);
    if (preBlock) {
      pausedRemainingCodes = [...dedupedCodes];
      runStatusText = `已暫停：${preBlock}`;
      renderState();
      return;
    }

    const liveUrl = getLiveUrl();
    if (!platform.isWalletPage(liveUrl, document)) {
      if (platform.tryOpenPromoModal(document)) {
        const modalWait = Math.max(20, delayFn());
        await new Promise((resolve) => setTimeout(resolve, modalWait));
      }
    }

    if (!platform.isWalletPage(getLiveUrl(), document)) {
      savePendingRunState({
        platform: platform.id,
        codes: dedupedCodes,
        forceRetry,
        createdAt: new Date().toISOString(),
      });
      runStatusText = '正在跳轉至優惠券頁面...';
      renderState();
      if (platform.fullPageNavigation) {
        navigateFn(platform.walletUrl);
      } else {
        navigateWithoutAppSwitch(platform.walletUrl, document, navigateFn);
      }
      return;
    }

    const records: Record<string, RedemptionRecord> = loadRedemptionRecords(
      platform.id,
    );
    const filteredCodes = dedupedCodes.filter(
      (code) => isResuming || forceRetry || !records[code],
    );

    if (filteredCodes.length === 0) {
      pausedRemainingCodes = [];
      runStatusText = '已完成（無待執行的優惠碼）';
      renderState();
      return;
    }

    runStatusText = `執行中 (0/${filteredCodes.length})`;
    renderState();

    for (let i = 0; i < filteredCodes.length; i++) {
      const code = filteredCodes[i]!;
      const blockMsg = platform.detectChallengeOrAuthBlock(document);
      if (blockMsg) {
        pausedRemainingCodes = filteredCodes.slice(i);
        runStatusText = `已暫停：${blockMsg}`;
        renderState();
        return;
      }

      let { input, submit } = platform.findInputAndSubmit(document);
      if (!input) {
        if (platform.tryOpenPromoModal(document)) {
          const modalWait = Math.max(20, delayFn());
          await new Promise((resolve) => setTimeout(resolve, modalWait));
          ({ input, submit } = platform.findInputAndSubmit(document));
        }
      }
      if (!input) {
        pausedRemainingCodes = filteredCodes.slice(i);
        runStatusText =
          '已暫停：找不到優惠碼輸入框。請確認已登入並停留在優惠頁（Uber Eats：左上角選單 → 優惠），或用手指點一下「優惠碼輸入框」（讓游標停在框內），再按「繼續執行」';
        renderState();
        return;
      }

      runStatusText = `執行中 (${i + 1}/${filteredCodes.length})：${code}`;
      renderState();

      try {
        const snapshot = platform.captureSubmissionSnapshot?.(document, code);

        setNativeInputValue(input, code);
        await Promise.resolve();
        if (!submit) {
          ({ submit } = platform.findInputAndSubmit(document));
        }
        triggerSubmitOrEnter(input, submit);

        const waitTime = Math.max(0, delayFn());
        if (waitTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }

        if (snapshot && platform.hasSubmissionUpdate) {
          const pollInterval = Math.min(350, Math.max(12, waitTime));
          for (
            let attempt = 0;
            attempt < 3 && !platform.hasSubmissionUpdate(document, snapshot);
            attempt++
          ) {
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
          }
        }

        const postBlock = platform.detectChallengeOrAuthBlock(document);
        if (postBlock) {
          pausedRemainingCodes = filteredCodes.slice(i);
          runStatusText = `已暫停：${postBlock}`;
          renderState();
          return;
        }

        const result = platform.classifyFeedback(document, snapshot);
        if (result.outcome === 'rate_limited') {
          pausedRemainingCodes = filteredCodes.slice(i);
          startRateLimitCooldown(result.message);
          return;
        }
        summaryCounts[result.outcome] += 1;
        saveRedemptionRecord(platform.id, code, result.outcome, result.message);
        renderState();
      } catch {
        const fallbackResult = platform.classifyFeedback(document);
        if (fallbackResult.outcome === 'rate_limited') {
          pausedRemainingCodes = filteredCodes.slice(i);
          startRateLimitCooldown(fallbackResult.message);
          return;
        }
        summaryCounts[fallbackResult.outcome] += 1;
        saveRedemptionRecord(
          platform.id,
          code,
          fallbackResult.outcome,
          fallbackResult.message,
        );
        renderState();
      }
    }

    pausedRemainingCodes = [];
    runStatusText = '已完成';
    renderState();
  }

  startRunBtn.addEventListener('click', () => {
    clearRateLimitCooldown();
    activeTaskPromise = executeRedemptionRun(getEffectiveWalletCodes(), false);
  });

  resumeRunBtn.addEventListener('click', () => {
    clearRateLimitCooldown();
    const remaining =
      pausedRemainingCodes.length > 0
        ? [...pausedRemainingCodes]
        : getEffectiveWalletCodes();
    activeTaskPromise = executeRedemptionRun(remaining, true);
  });

  let isCurrentlyWalletPage = false;
  try {
    isCurrentlyWalletPage = platform.isWalletPage(currentUrl, document);
  } catch {
    isCurrentlyWalletPage = false;
  }
  const pending = isCurrentlyWalletPage
    ? consumePendingRunState(platform.id)
    : null;

  if (pending && pending.codes.length > 0) {
    isOpen = true;
    forceRetry = Boolean(pending.forceRetry);
    forceRetryCheckbox.checked = forceRetry;
    manualQueueCodes = [...pending.codes];
  }

  if (options.autoSyncFeed !== false && pending && pending.codes.length > 0) {
    activeTaskPromise = syncFeed().then(() =>
      executeRedemptionRun([...manualQueueCodes], false),
    );
  } else if (pending && pending.codes.length > 0) {
    activeTaskPromise = executeRedemptionRun([...manualQueueCodes], false);
  } else if (options.autoSyncFeed !== false) {
    activeTaskPromise = syncFeed().catch((err) => {
      console.warn('[AutoCoupon] Auto-sync feed error:', err);
    });
  }

  renderState();

  const controller: AutoCouponController = {
    platform,
    setQueue(codes: string[]) {
      manualQueueCodes = dedupeCouponCodes(codes);
      renderState();
    },
    getQueue() {
      return getEffectiveWalletCodes();
    },
    async syncFeed() {
      activeTaskPromise = syncFeed();
      await activeTaskPromise;
    },
    async waitForIdle() {
      while (activeTaskPromise) {
        const current = activeTaskPromise;
        await current;
        if (activeTaskPromise === current) {
          break;
        }
      }
    },
  };

  host.__acController = controller;
  return controller;
}
