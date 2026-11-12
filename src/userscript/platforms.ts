import type { PlatformId, RedemptionOutcome } from '../shared/types.ts';

export interface PlatformSubmissionResult {
  outcome: RedemptionOutcome;
  message: string;
}

export interface PlatformAdapter {
  id: PlatformId;
  displayName: string;
  walletUrl: string;
  isWalletPage(url: string, doc: Document): boolean;
  detectChallengeOrAuthBlock(doc: Document): string | null;
  findInputAndSubmit(doc: Document): {
    input: HTMLInputElement | null;
    submit: HTMLElement | null;
  };
  classifyFeedback(doc: Document): PlatformSubmissionResult;
}

interface PlatformAdapterConfig {
  id: PlatformId;
  displayName: string;
  walletUrl: string;
  walletPathPattern: RegExp;
  inputSelectors: string[];
  submitSelectors: string[];
  submitTestIdHint: string;
  feedbackSelectors: string[];
}

export function setNativeInputValue(
  input: HTMLInputElement,
  value: string,
): void {
  const proto = Object.getPrototypeOf(input) as HTMLInputElement | null;
  const descriptor =
    Object.getOwnPropertyDescriptor(input, 'value') ??
    (proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined);
  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function detectCommonChallenge(doc: Document): string | null {
  const challengeSelectors = [
    '#px-captcha',
    '[id*="px-captcha"]',
    '.cf-turnstile',
    '[data-testid="challenge-container"]',
    '[data-testid="login-modal"]',
  ];
  for (const sel of challengeSelectors) {
    const el = doc.querySelector(sel);
    if (el) {
      return '偵測到網站安全驗證或登入要求，已暫停佇列，請手動完成驗證後繼續';
    }
  }
  const bodyText = doc.body?.textContent ?? '';
  if (
    /Press\s*&\s*Hold|confirm you are a human|請證明您是人類|請先登入|驗證您是人類/i.test(
      bodyText,
    )
  ) {
    return '偵測到網站安全驗證或登入要求，已暫停佇列，請手動完成驗證後繼續';
  }
  return null;
}

function classifyFeedbackText(text: string): PlatformSubmissionResult {
  const normalized = text.trim();
  if (
    /已經領取|已領取|已套用過|已存在|already\s*(claimed|applied|redeemed|added)|已被領取/i.test(
      normalized,
    )
  ) {
    return {
      outcome: 'already_claimed',
      message: normalized || '已領取過此優惠碼',
    };
  }
  if (
    /成功|已存入|已新增|已套用|已歸戶|added|claimed|applied\s+successfully|promo\s+applied/i.test(
      normalized,
    ) &&
    !/無法|失敗|無效|過期/.test(normalized)
  ) {
    return {
      outcome: 'claimed',
      message: normalized || '成功領取優惠碼',
    };
  }
  return {
    outcome: 'invalid_or_expired',
    message: normalized || '此優惠碼無效、已過期或不符合資格',
  };
}

const APP_DEEPLINK_PATTERN =
  /^(?:foodpanda|ubereats|uber):\/\/|(?:onelink\.me|app\.adjust\.com|branch\.io|apps\.apple\.com|itunes\.apple\.com)/i;

let antiHijackInstalled = false;

export function isAppDeepLink(url: string): boolean {
  return APP_DEEPLINK_PATTERN.test(url.trim());
}

export function installAntiAppHijack(doc: Document): void {
  // Remove iOS Smart App Banner meta tags & app-open banners
  const banners = doc.querySelectorAll(
    'meta[name="apple-itunes-app"], [data-testid*="app-banner"], [class*="smart-banner"], [id*="branch-banner"]',
  );
  for (const el of banners) {
    el.remove();
  }

  // Neutralize deep-link anchors on the page
  const anchors = doc.querySelectorAll<HTMLElement>('a[href]');
  for (const a of anchors) {
    const href = a.getAttribute('href') ?? '';
    if (isAppDeepLink(href)) {
      a.setAttribute('data-blocked-deeplink', href);
      a.removeAttribute('href');
    }
  }

  if (antiHijackInstalled) return;
  antiHijackInstalled = true;

  doc.addEventListener('click', (ev: Event) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    let curr: HTMLElement | null = target;
    while (curr) {
      const href =
        curr.getAttribute?.('href') ??
        curr.getAttribute?.('data-blocked-deeplink') ??
        '';
      if (href && isAppDeepLink(href)) {
        ev.preventDefault();
        return;
      }
      curr = curr.parentElement;
    }
  });
}

export function navigateWithoutAppSwitch(
  targetUrl: string,
  doc: Document,
  fallbackNavigate: (url: string) => void,
): void {
  try {
    const parsed = new URL(
      targetUrl,
      typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'https://www.foodpanda.com.tw/',
    );
    const relativePath = `${parsed.pathname}${parsed.search}${parsed.hash}`;

    // 1. If an in-page SPA link to this pathname exists, click it so router navigates without iOS Universal Link
    const inPageLink = doc.querySelector<HTMLElement>(
      `a[href="${parsed.pathname}"]`,
    );
    if (inPageLink) {
      inPageLink.click();
      return;
    }

    // 2. If History API is available on the same origin in a real browser, trigger SPA popstate first
    if (
      typeof window !== 'undefined' &&
      window.location &&
      window.location.origin === parsed.origin &&
      typeof (window as unknown as { history?: History }).history?.pushState ===
        'function'
    ) {
      const hist = (window as unknown as { history: History }).history;
      hist.pushState({}, '', relativePath);
      window.dispatchEvent(new Event('popstate', { bubbles: true }));
    }
  } catch {
    // Fallback to standard navigation
  }

  fallbackNavigate(targetUrl);
}

let lastInterceptedResponseText: string | null = null;
let snifferInstalled = false;

export function recordNetworkFeedbackText(bodyText: string): void {
  if (bodyText && bodyText.trim()) {
    lastInterceptedResponseText = bodyText.trim();
  }
}

export function consumeNetworkFeedbackText(): string | null {
  const val = lastInterceptedResponseText;
  lastInterceptedResponseText = null;
  return val;
}

export function installNetworkFeedbackSniffer(): void {
  if (snifferInstalled || typeof window === 'undefined') return;
  snifferInstalled = true;
  const win = window as unknown as {
    fetch?: typeof fetch;
  };
  if (typeof win.fetch === 'function') {
    const origFetch = win.fetch.bind(window);
    win.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await origFetch(...args);
      try {
        const reqUrl =
          typeof args[0] === 'string'
            ? args[0]
            : (args[0] as { url?: string })?.url ?? '';
        if (/voucher|promo|coupon/i.test(reqUrl) && typeof res.clone === 'function') {
          const text = await res.clone().text();
          recordNetworkFeedbackText(text);
        }
      } catch {
        // Ignore clone/read errors
      }
      return res;
    };
  }
}

function createPlatformAdapter(config: PlatformAdapterConfig): PlatformAdapter {
  return {
    id: config.id,
    displayName: config.displayName,
    walletUrl: config.walletUrl,

    isWalletPage(url: string, doc: Document): boolean {
      if (config.walletPathPattern.test(url)) return true;
      const { input, submit } = this.findInputAndSubmit(doc);
      return Boolean(input && submit);
    },

    detectChallengeOrAuthBlock(doc: Document): string | null {
      return detectCommonChallenge(doc);
    },

    findInputAndSubmit(doc: Document) {
      let input: HTMLInputElement | null = null;
      for (const sel of config.inputSelectors) {
        const found = doc.querySelector<HTMLInputElement>(sel);
        if (found) {
          input = found;
          break;
        }
      }

      let submit: HTMLElement | null = null;
      for (const sel of config.submitSelectors) {
        const buttons = doc.querySelectorAll<HTMLElement>(sel);
        for (const btn of buttons) {
          if (
            btn.getAttribute('data-testid')?.includes(config.submitTestIdHint) ||
            /套用|儲存|新增|兌換|領取|Apply|Add/i.test(btn.textContent ?? '')
          ) {
            submit = btn;
            break;
          }
        }
        if (submit) break;
      }

      return { input, submit };
    },

    classifyFeedback(doc: Document): PlatformSubmissionResult {
      const networkText = consumeNetworkFeedbackText();
      if (networkText) {
        return classifyFeedbackText(networkText);
      }
      for (const sel of config.feedbackSelectors) {
        const el = doc.querySelector(sel);
        if (el && el.textContent?.trim()) {
          return classifyFeedbackText(el.textContent);
        }
      }
      return classifyFeedbackText(doc.body?.textContent ?? '');
    },
  };
}

export const foodpandaAdapter: PlatformAdapter = createPlatformAdapter({
  id: 'foodpanda',
  displayName: 'foodpanda 熊貓外送',
  walletUrl: 'https://www.foodpanda.com.tw/vouchers',
  walletPathPattern: /\/vouchers\b/i,
  inputSelectors: [
    'input[data-testid="voucher-input"]',
    'input[data-testid*="voucher"]',
    'input[name="voucherCode"]',
    'input[placeholder*="優惠碼"]',
    'input[placeholder*="優惠券"]',
    'input[placeholder*="Voucher"]',
  ],
  submitSelectors: [
    'button[data-testid="voucher-apply-btn"]',
    'button[data-testid*="voucher-apply"]',
    'button[data-testid*="add-voucher"]',
    'button[type="submit"]',
    'button',
  ],
  submitTestIdHint: 'voucher',
  feedbackSelectors: [
    '[data-testid="voucher-feedback"]',
    '[data-testid*="voucher-error"]',
    '[data-testid*="voucher-success"]',
    '[role="alert"]',
    '.voucher-feedback',
    '.notification-toast',
  ],
});

export const uberEatsAdapter: PlatformAdapter = createPlatformAdapter({
  id: 'ubereats',
  displayName: 'Uber Eats 優食',
  walletUrl: 'https://www.ubereats.com/tw/promotions',
  walletPathPattern: /\/(promotions|wallet)\b/i,
  inputSelectors: [
    'input[data-testid="promo-code-input"]',
    'input[data-testid*="promo"]',
    'input[name="promoCode"]',
    'input[placeholder*="優惠序號"]',
    'input[placeholder*="優惠碼"]',
    'input[placeholder*="Promo"]',
  ],
  submitSelectors: [
    'button[data-testid="promo-apply-button"]',
    'button[data-testid*="promo-apply"]',
    'button[type="submit"]',
    'button',
  ],
  submitTestIdHint: 'promo',
  feedbackSelectors: [
    '[data-testid="promo-status-message"]',
    '[data-testid*="promo-error"]',
    '[data-testid*="promo-success"]',
    '[role="alert"]',
    '.promo-feedback',
  ],
});

export function detectPlatform(url: string): PlatformAdapter {
  if (/ubereats\.com/i.test(url)) {
    return uberEatsAdapter;
  }
  return foodpandaAdapter;
}
