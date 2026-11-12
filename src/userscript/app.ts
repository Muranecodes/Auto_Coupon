import type {
  CandidateChip,
  CouponEntry,
  RedemptionOutcome,
  RedemptionRecord,
} from '../shared/types.ts';
import {
  DEFAULT_FEED_URL,
  fetchCouponFeed,
  partitionPlatformCoupons,
} from './feed.ts';
import { extractCandidateChips } from './parser.ts';
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
  consumePendingRunState,
  dedupeCouponCodes,
  loadRedemptionRecords,
  normalizeCouponCode,
  savePendingRunState,
  saveRedemptionRecord,
} from './storage.ts';

export type LiveCouponStatus =
  | 'pending'
  | 'submitting'
  | RedemptionOutcome;

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

const DEFAULT_DELAY_FN = () => 650 + Math.floor(Math.random() * 550);

const HOST_STYLE_CSS =
  'position: fixed !important;' +
  'z-index: 2147483647 !important;' +
  'top: 0 !important;' +
  'left: 0 !important;' +
  'width: 0 !important;' +
  'height: 0 !important;' +
  'overflow: visible !important;' +
  'pointer-events: none !important;' +
  'display: block !important;' +
  '-webkit-transform: translateZ(0) !important;' +
  'transform: translateZ(0) !important;';

function applyHostStyles(el: HTMLElement): void {
  try {
    el.style.cssText = HOST_STYLE_CSS;
    el.setAttribute('style', HOST_STYLE_CSS);
  } catch {
    // Ignore in non-browser env
  }
}

const SHADOW_STYLES = `
  :host {
    all: initial;
    display: block !important;
    position: static !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
  }
  .ac-pill {
    position: fixed;
    right: 16px;
    bottom: calc(84px + env(safe-area-inset-bottom, 0px));
    z-index: 2147483647;
    pointer-events: auto;
    -webkit-transform: translateZ(0);
    transform: translateZ(0);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-radius: 999px;
    border: none;
    background: linear-gradient(135deg, #d70f64, #ff2b85);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    box-shadow: 0 6px 20px rgba(215, 15, 100, 0.35);
    cursor: pointer;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .ac-pill-badge {
    background: #fff;
    color: #d70f64;
    border-radius: 999px;
    padding: 2px 7px;
    font-size: 12px;
    font-weight: 800;
  }
  .ac-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2147483647;
    pointer-events: auto;
    -webkit-transform: translateZ(0);
    transform: translateZ(0);
    background: #ffffff;
    color: #1f2937;
    border-radius: 20px 20px 0 0;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.22);
    max-height: 82vh;
    overflow-y: auto;
    padding: 16px 18px calc(24px + env(safe-area-inset-bottom, 0px));
    transition: transform 0.22s ease;
  }
  .ac-sheet[data-open="false"] {
    display: none;
  }
  .ac-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .ac-title {
    font-size: 16px;
    font-weight: 800;
  }
  .ac-btn {
    padding: 8px 12px;
    border-radius: 10px;
    border: none;
    background: #d70f64;
    color: #fff;
    font-weight: 700;
    cursor: pointer;
  }
  .ac-btn-secondary {
    background: #f3f4f6;
    color: #374151;
  }
  .ac-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    flex-wrap: wrap;
  }
  .ac-section {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid #e5e7eb;
  }
  .ac-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0;
  }
  .ac-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 999px;
    background: #fce7f3;
    color: #9d174d;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #f9a8d4;
  }
  .ac-chip[data-selected="false"] {
    background: #f3f4f6;
    color: #9ca3af;
    border-color: #d1d5db;
    text-decoration: line-through;
  }
  .ac-input {
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid #d1d5db;
    font-size: 13px;
    box-sizing: border-box;
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
  const delayFn = options.delayMs ?? DEFAULT_DELAY_FN;
  const feedUrl = options.feedUrl ?? DEFAULT_FEED_URL;
  const navigateFn =
    options.navigate ??
    ((targetUrl: string) => {
      if (typeof window !== 'undefined' && window.location) {
        window.location.href = targetUrl;
      }
    });
  const platform = detectPlatform(currentUrl);

  const existingHost = document.querySelector('#auto-coupon-root') as
    | (HTMLElement & { __acCleanup?: () => void })
    | null;
  if (existingHost) {
    existingHost.__acCleanup?.();
    existingHost.remove();
  }

  const host = document.createElement('div') as HTMLElement & {
    __acCleanup?: () => void;
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

  host.__acCleanup = () => {
    clearInterval(keepAliveTimer);
    mutationObserver?.disconnect();
  };

  const shadow = host.attachShadow({ mode: 'open' });

  let isOpen = false;
  let forceRetry = false;
  let manualQueueCodes: string[] = [];
  let feedWalletCoupons: CouponEntry[] = [];
  let feedCheckoutCoupons: CouponEntry[] = [];
  let candidateChips: CandidateChip[] = [];
  let pausedRemainingCodes: string[] = [];
  const liveStatusByCode = new Map<string, LiveCouponStatus>();
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
  }) as HTMLButtonElement;
  pillBtn.appendChild(createEl(document, 'span', undefined, '🎟️ 自動領券'));
  const pillBadge = createEl(
    document,
    'span',
    { class: 'ac-pill-badge', 'data-role': 'pill-badge' },
    '0',
  );
  pillBtn.appendChild(pillBadge);
  if (platform.id === 'ubereats') {
    pillBtn.style.background = 'linear-gradient(135deg, #06C167, #10B981)';
    pillBtn.style.boxShadow = '0 6px 20px rgba(6, 193, 103, 0.4)';
    pillBadge.style.color = '#06C167';
  }
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
      class: 'ac-btn ac-btn-secondary',
      'data-role': 'close-sheet-btn',
    },
    '收合',
  ) as HTMLButtonElement;
  headerRow.appendChild(closeBtn);
  sheetEl.appendChild(headerRow);

  const statusRow = createEl(document, 'div', { class: 'ac-row' });
  const statusEl = createEl(
    document,
    'span',
    { 'data-role': 'run-status' },
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
  sheetEl.appendChild(statusRow);

  const feedUrlRow = createEl(document, 'div', { class: 'ac-row' });
  const feedUrlInput = createEl(document, 'input', {
    type: 'text',
    class: 'ac-input',
    'data-role': 'feed-url-input',
    value: feedUrl,
    placeholder: '遠端 Coupon Feed JSON URL',
  }) as HTMLInputElement;
  feedUrlRow.appendChild(feedUrlInput);
  sheetEl.appendChild(feedUrlRow);

  const summaryEl = createEl(
    document,
    'div',
    { class: 'ac-row', 'data-role': 'run-summary' },
    '成功: 0 | 已領過: 0 | 無效/過期: 0',
  );
  sheetEl.appendChild(summaryEl);

  const forceRetryRow = createEl(document, 'div', { class: 'ac-row' });
  const forceRetryLabel = createEl(document, 'label');
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
  sheetEl.appendChild(forceRetryRow);

  const actionRow = createEl(document, 'div', { class: 'ac-row' });
  const startRunBtn = createEl(
    document,
    'button',
    { type: 'button', class: 'ac-btn', 'data-role': 'start-run-btn' },
    '開始批次歸戶',
  ) as HTMLButtonElement;
  if (platform.id === 'ubereats') {
    startRunBtn.style.background = '#06C167';
  }
  const resumeRunBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-btn ac-btn-secondary',
      'data-role': 'resume-run-btn',
    },
    '繼續執行',
  ) as HTMLButtonElement;
  actionRow.appendChild(startRunBtn);
  actionRow.appendChild(resumeRunBtn);
  sheetEl.appendChild(actionRow);

  const walletSection = createEl(document, 'div', { class: 'ac-section' });
  walletSection.appendChild(
    createEl(document, 'div', undefined, '歸戶型優惠碼佇列（Wallet Coupons）：'),
  );
  const walletListEl = createEl(document, 'div', {
    'data-role': 'wallet-coupon-list',
  });
  walletSection.appendChild(walletListEl);
  sheetEl.appendChild(walletSection);

  const parserSection = createEl(document, 'div', { class: 'ac-section' });
  parserSection.appendChild(
    createEl(
      document,
      'div',
      undefined,
      '智慧文字擷取（貼上 LINE / 懶人包文字）：',
    ),
  );
  const parserRow = createEl(document, 'div', { class: 'ac-row' });
  const freeformInput = createEl(document, 'input', {
    type: 'text',
    class: 'ac-input',
    'data-role': 'freeform-input',
    placeholder: '貼上含優惠碼的整段文字...',
  }) as HTMLInputElement;
  const parseTextBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-btn ac-btn-secondary',
      'data-role': 'parse-text-btn',
    },
    '解析優惠碼',
  ) as HTMLButtonElement;
  parserRow.appendChild(freeformInput);
  parserRow.appendChild(parseTextBtn);
  parserSection.appendChild(parserRow);
  const candidateChipListEl = createEl(document, 'div', {
    class: 'ac-chip-list',
    'data-role': 'candidate-chip-list',
  });
  parserSection.appendChild(candidateChipListEl);
  sheetEl.appendChild(parserSection);

  const checkoutSection = createEl(document, 'div', { class: 'ac-section' });
  checkoutSection.appendChild(
    createEl(
      document,
      'div',
      undefined,
      '結帳/信用卡限定碼（點擊一鍵複製）：',
    ),
  );
  const checkoutListEl = createEl(document, 'div', {
    'data-role': 'checkout-coupon-list',
  });
  checkoutSection.appendChild(checkoutListEl);
  sheetEl.appendChild(checkoutSection);

  shadow.appendChild(sheetEl);

  function getEffectiveWalletCodes(): string[] {
    return dedupeCouponCodes([
      ...manualQueueCodes,
      ...feedWalletCoupons.map((c) => c.code),
      ...candidateChips.filter((c) => c.selected).map((c) => c.code),
    ]);
  }

  function computeUntriedCount(): number {
    const records = loadRedemptionRecords(platform.id);
    return getEffectiveWalletCodes().filter((code) => !records[code]).length;
  }

  function renderWalletCoupons(): void {
    clearChildren(walletListEl);
    const records = loadRedemptionRecords(platform.id);
    const titleByCode = new Map(
      feedWalletCoupons.map((c) => [normalizeCouponCode(c.code), c.title]),
    );

    for (const code of getEffectiveWalletCodes()) {
      const row = document.createElement('div');
      row.setAttribute('class', 'ac-row');
      row.setAttribute('data-wallet-code', code);

      const status: LiveCouponStatus =
        liveStatusByCode.get(code) ?? records[code]?.outcome ?? 'pending';
      row.setAttribute('data-coupon-status', status);

      const title = titleByCode.get(code);
      row.textContent = title
        ? `${code} (${title}) [${status}]`
        : `${code} [${status}]`;
      walletListEl.appendChild(row);
    }
  }

  function renderCandidateChips(): void {
    clearChildren(candidateChipListEl);
    for (const chip of candidateChips) {
      const btn = document.createElement('button');
      btn.setAttribute('type', 'button');
      btn.setAttribute('class', 'ac-chip');
      btn.setAttribute('data-role', 'candidate-chip');
      btn.setAttribute('data-code', chip.code);
      btn.setAttribute('data-selected', chip.selected ? 'true' : 'false');
      btn.textContent = chip.code;
      btn.addEventListener('click', () => {
        chip.selected = !chip.selected;
        btn.setAttribute('data-selected', chip.selected ? 'true' : 'false');
        renderWalletCoupons();
        renderState();
      });
      candidateChipListEl.appendChild(btn);
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

  function renderState(): void {
    sheetEl.setAttribute('data-open', isOpen ? 'true' : 'false');
    statusEl.textContent = `狀態：${runStatusText}`;
    summaryEl.textContent = `成功: ${summaryCounts.claimed} | 已領過: ${summaryCounts.already_claimed} | 無效/過期: ${summaryCounts.invalid_or_expired}`;
    pillBadge.textContent = String(computeUntriedCount());
    renderWalletCoupons();
  }

  async function syncFeed(): Promise<void> {
    const activeUrl = feedUrlInput.value.trim() || feedUrl;
    const feed = await fetchCouponFeed(activeUrl, options.fetchFeed);
    const { walletCoupons, checkoutCoupons } = partitionPlatformCoupons(
      feed,
      platform.id,
    );
    feedWalletCoupons = walletCoupons;
    feedCheckoutCoupons = checkoutCoupons;
    renderCheckoutCoupons();
    renderState();
  }

  let dragged = false;
  let dragStartX = 0;
  let dragStartY = 0;

  pillBtn.addEventListener('pointerdown', (ev: Event) => {
    const pe = ev as unknown as { clientX?: number; clientY?: number };
    dragged = false;
    dragStartX = pe.clientX ?? 0;
    dragStartY = pe.clientY ?? 0;
  });

  pillBtn.addEventListener('pointermove', (ev: Event) => {
    const pe = ev as unknown as {
      clientX?: number;
      clientY?: number;
      buttons?: number;
    };
    if (!pe.buttons) return;
    const dx = Math.abs((pe.clientX ?? 0) - dragStartX);
    const dy = Math.abs((pe.clientY ?? 0) - dragStartY);
    if (dx > 8 || dy > 8) {
      dragged = true;
      pillBtn.style.right = 'auto';
      pillBtn.style.bottom = 'auto';
      pillBtn.style.left = `${Math.max(8, (pe.clientX ?? 40) - 40)}px`;
      pillBtn.style.top = `${Math.max(8, (pe.clientY ?? 20) - 20)}px`;
    }
  });

  pillBtn.addEventListener('click', () => {
    if (dragged) {
      dragged = false;
      return;
    }
    isOpen = !isOpen;
    renderState();
  });

  closeBtn.addEventListener('click', () => {
    isOpen = false;
    renderState();
  });

  syncFeedBtn.addEventListener('click', () => {
    activeTaskPromise = syncFeed();
  });

  forceRetryCheckbox.addEventListener('change', () => {
    forceRetry = Boolean(forceRetryCheckbox.checked);
  });

  parseTextBtn.addEventListener('click', () => {
    candidateChips = extractCandidateChips(freeformInput.value);
    renderCandidateChips();
    renderState();
  });

  async function executeRedemptionRun(
    codesToRun: string[],
    isResuming = false,
  ): Promise<void> {
    if (!isResuming) {
      summaryCounts = {
        claimed: 0,
        already_claimed: 0,
        invalid_or_expired: 0,
      };
      liveStatusByCode.clear();
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
      navigateWithoutAppSwitch(platform.walletUrl, document, navigateFn);
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

    for (const c of filteredCodes) {
      liveStatusByCode.set(c, 'pending');
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
          '已暫停：請先用手指點一下網頁上的「優惠碼輸入框」（讓游標停在框內），再按「繼續執行」';
        renderState();
        return;
      }

      liveStatusByCode.set(code, 'submitting');
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
          liveStatusByCode.set(code, 'pending');
          pausedRemainingCodes = filteredCodes.slice(i);
          runStatusText = `已暫停：${postBlock}`;
          renderState();
          return;
        }

        const result = platform.classifyFeedback(document, snapshot);
        liveStatusByCode.set(code, result.outcome);
        summaryCounts[result.outcome] += 1;
        saveRedemptionRecord(platform.id, code, result.outcome, result.message);
        renderState();
      } catch {
        const fallbackResult = platform.classifyFeedback(document);
        liveStatusByCode.set(code, fallbackResult.outcome);
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
    activeTaskPromise = executeRedemptionRun(getEffectiveWalletCodes(), false);
  });

  resumeRunBtn.addEventListener('click', () => {
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

  return {
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
}
