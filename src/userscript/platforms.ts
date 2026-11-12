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
  tryOpenPromoModal(doc: Document): boolean;
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
  modalTriggerPattern: RegExp;
}

let lastUserFocusedInput: HTMLInputElement | null = null;
let focusTrackerInstalled = false;

export function installInputFocusTracker(doc: Document): void {
  if (focusTrackerInstalled) return;
  focusTrackerInstalled = true;

  const recordTarget = (ev: Event) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA'
    ) {
      lastUserFocusedInput = target as HTMLInputElement;
    }
  };

  doc.addEventListener('focusin', recordTarget);
  doc.addEventListener('click', recordTarget);
}

export function setNativeInputValue(
  input: HTMLInputElement,
  value: string,
): void {
  try {
    if (typeof input.focus === 'function') {
      input.focus();
    }
  } catch {
    // Ignore focus errors
  }

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

export function triggerSubmitOrEnter(
  input: HTMLInputElement,
  submit: HTMLElement | null,
): void {
  if (submit) {
    submit.click();
    return;
  }

  // Fallback: dispatch Enter key events and submit parent form if present
  input.dispatchEvent(new Event('keydown', { bubbles: true }));
  input.dispatchEvent(new Event('keypress', { bubbles: true }));
  input.dispatchEvent(new Event('keyup', { bubbles: true }));

  let curr: HTMLElement | null = input.parentElement;
  while (curr) {
    if (curr.tagName === 'FORM') {
      const formEl = curr as unknown as {
        requestSubmit?: () => void;
        submit?: () => void;
      };
      if (typeof formEl.requestSubmit === 'function') {
        formEl.requestSubmit();
      } else if (typeof formEl.submit === 'function') {
        formEl.submit();
      } else {
        curr.dispatchEvent(new Event('submit', { bubbles: true }));
      }
      return;
    }
    curr = curr.parentElement;
  }
}

function isElementDisplayed(el: HTMLElement): boolean {
  const styleAttr = el.getAttribute?.('style') ?? '';
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(styleAttr)) {
    return false;
  }
  if (el.getAttribute?.('aria-hidden') === 'true') {
    return false;
  }
  if (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { getComputedStyle?: typeof getComputedStyle })
      .getComputedStyle === 'function'
  ) {
    try {
      const computed = window.getComputedStyle(el);
      if (
        computed.display === 'none' ||
        computed.visibility === 'hidden' ||
        computed.opacity === '0'
      ) {
        return false;
      }
    } catch {
      // Ignore in test DOM
    }
  }
  if (typeof el.getBoundingClientRect === 'function') {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return false;
      }
    } catch {
      // Ignore in test DOM
    }
  }
  return true;
}

function isElementVisiblyActive(el: HTMLElement): boolean {
  if (!isElementDisplayed(el)) return false;
  return Boolean(
    (el.textContent && el.textContent.trim().length > 0) ||
      el.querySelector?.('iframe'),
  );
}

function detectCommonChallenge(doc: Document): string | null {
  const challengeSelectors = [
    '#px-captcha',
    '[id*="px-captcha"]',
    '.cf-turnstile',
    '[data-testid="challenge-container"]',
  ];
  for (const sel of challengeSelectors) {
    const el = doc.querySelector<HTMLElement>(sel);
    if (el && isElementVisiblyActive(el)) {
      return '偵測到網站安全驗證（CAPTCHA），已暫停佇列，請手動完成驗證後點擊「繼續執行」';
    }
  }

  const pageTitle = (doc as unknown as { title?: string }).title ?? '';
  if (
    /Access to this page has been denied|Just a moment|Attention Required/i.test(
      pageTitle,
    )
  ) {
    return '偵測到網站安全驗證頁面，已暫停佇列，請手動完成驗證後點擊「繼續執行」';
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
    !/無法|失敗|無效|過期|錯誤|不適用/.test(normalized)
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
  const banners = doc.querySelectorAll(
    'meta[name="apple-itunes-app"], [data-testid*="app-banner"], [class*="smart-banner"], [id*="branch-banner"]',
  );
  for (const el of banners) {
    el.remove();
  }

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

    const inPageLink = doc.querySelector<HTMLElement>(
      `a[href="${parsed.pathname}"]`,
    );
    if (inPageLink) {
      inPageLink.click();
      return;
    }

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
        if (
          /voucher|promo|coupon/i.test(reqUrl) &&
          typeof res.clone === 'function'
        ) {
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

const EXCLUDED_INPUT_TYPES = new Set([
  'hidden',
  'checkbox',
  'radio',
  'password',
  'email',
  'file',
  'submit',
  'button',
  'image',
  'range',
  'date',
  'number',
]);

const EXCLUDED_INPUT_HINT =
  /address|location|email|phone|password|搜尋餐廳|搜尋商店|輸入地址|外送地址|電話|信箱|密碼/i;

function isCandidatePromoInput(inp: HTMLInputElement): boolean {
  if (!isElementDisplayed(inp)) return false;
  const type = (inp.type || inp.getAttribute('type') || 'text').toLowerCase();
  if (EXCLUDED_INPUT_TYPES.has(type)) return false;
  const meta = [
    inp.getAttribute('name') ?? '',
    inp.getAttribute('id') ?? '',
    inp.placeholder || inp.getAttribute('placeholder') || '',
    inp.getAttribute('aria-label') ?? '',
    inp.getAttribute('data-testid') ?? '',
  ].join(' ');
  if (EXCLUDED_INPUT_HINT.test(meta)) return false;
  return true;
}

function collectSameOriginDocuments(rootDoc: Document): Document[] {
  const docs: Document[] = [rootDoc];
  const iframes = rootDoc.querySelectorAll<HTMLElement>('iframe');
  for (const frame of iframes) {
    try {
      const childDoc = (
        frame as unknown as { contentDocument?: Document | null }
      ).contentDocument;
      if (childDoc) docs.push(childDoc);
    } catch {
      // Ignore cross-origin iframe
    }
  }
  return docs;
}

function findInputByLabelOrFallback(doc: Document): HTMLInputElement | null {
  // 0. If the user recently clicked/focused a valid input on the page, trust it immediately!
  if (
    lastUserFocusedInput &&
    isCandidatePromoInput(lastUserFocusedInput) &&
    doc.body?.querySelectorAll('input').includes(lastUserFocusedInput)
  ) {
    return lastUserFocusedInput;
  }

  // 1. Check <label> elements mentioning voucher/promo keywords
  const labels = doc.querySelectorAll<HTMLElement>('label');
  for (const label of labels) {
    const text = label.textContent ?? '';
    if (/優惠|序號|折扣|代碼|禮券|Promo|Voucher|Code/i.test(text)) {
      const forId = label.getAttribute('for');
      if (forId) {
        const byId = doc.querySelector<HTMLInputElement>(`#${forId}`);
        if (byId && isCandidatePromoInput(byId)) return byId;
      }
      const nested = label.querySelector<HTMLInputElement>('input');
      if (nested && isCandidatePromoInput(nested)) return nested;
      const parentInput =
        label.parentElement?.querySelector<HTMLInputElement>('input');
      if (parentInput && isCandidatePromoInput(parentInput)) return parentInput;
    }
  }

  // 2. Check inside any open dialog / modal / bottom sheet (in reverse order so bottom-most portal modal wins!)
  const dialogs = doc.querySelectorAll<HTMLElement>(
    '[role="dialog"], [aria-modal="true"], [data-baseweb*="modal"], [data-baseweb*="drawer"], dialog, form',
  );
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const dlg = dialogs[i]!;
    const inputs = dlg.querySelectorAll<HTMLInputElement>('input');
    for (let j = inputs.length - 1; j >= 0; j--) {
      const inp = inputs[j]!;
      if (isCandidatePromoInput(inp)) return inp;
    }
  }

  // 3. Check inputs whose surrounding container text mentions promo/voucher keywords
  const allInputs = doc.querySelectorAll<HTMLInputElement>('input');
  for (let i = allInputs.length - 1; i >= 0; i--) {
    const inp = allInputs[i]!;
    if (!isCandidatePromoInput(inp)) continue;
    let anc: HTMLElement | null = inp.parentElement;
    for (let d = 0; d < 4 && anc; d++) {
      if (/優惠|序號|折扣|代碼|禮券|Promo|Voucher|Code/i.test(anc.textContent ?? '')) {
        return inp;
      }
      anc = anc.parentElement;
    }
  }

  // 4. Final fallback: return the last visible candidate input on the page (modals render at end of body)
  for (let i = allInputs.length - 1; i >= 0; i--) {
    const inp = allInputs[i]!;
    if (isCandidatePromoInput(inp)) return inp;
  }

  return null;
}

const CLOSE_CANCEL_BUTTON_REGEX =
  /^(?:關閉|取消|返回|略過|下次再說|Close|Cancel|Back|Dismiss|×|✕|✖)$/i;

function findSubmitNearInput(
  doc: Document,
  input: HTMLInputElement | null,
  config: PlatformAdapterConfig,
): HTMLElement | null {
  const buttonKeywordRegex =
    /^(?:套用|儲存|新增|兌換|領取|確認|確定|送出|提交|使用|完成|Apply|Add|Save|Submit|Redeem)$/i;
  const looseKeywordRegex =
    /套用|儲存|新增|兌換|領取|確認|確定|送出|提交|使用優惠|Apply|Add|Save|Submit|Redeem/i;

  // 1. Walk up to 10 ancestor levels from input (covers deeply nested BaseWeb / Bento UI modals)
  if (input) {
    let container: HTMLElement | null = input.parentElement;
    for (let depth = 0; depth < 10 && container; depth++) {
      const nearbyButtons = container.querySelectorAll<HTMLElement>(
        'button, [role="button"], input[type="submit"]',
      );
      for (const btn of nearbyButtons) {
        if (!isElementDisplayed(btn)) continue;
        const text = (btn.textContent ?? '').trim();
        const testId = btn.getAttribute('data-testid') ?? '';
        if (
          testId.includes(config.submitTestIdHint) ||
          buttonKeywordRegex.test(text) ||
          looseKeywordRegex.test(text) ||
          btn.getAttribute('type') === 'submit'
        ) {
          return btn;
        }
      }
      container = container.parentElement;
    }

    // 1b. If inside a compact form/modal container, pick any non-close/cancel button near the input
    let modalAnc: HTMLElement | null = input.parentElement;
    for (let depth = 0; depth < 6 && modalAnc; depth++) {
      const buttons = modalAnc.querySelectorAll<HTMLElement>(
        'button, [role="button"], input[type="submit"]',
      );
      const candidates = buttons.filter((btn) => {
        if (!isElementDisplayed(btn)) return false;
        const text = (btn.textContent ?? '').trim();
        const ariaLabel = (btn.getAttribute('aria-label') ?? '').trim();
        if (
          CLOSE_CANCEL_BUTTON_REGEX.test(text) ||
          CLOSE_CANCEL_BUTTON_REGEX.test(ariaLabel)
        ) {
          return false;
        }
        return true;
      });
      if (candidates.length > 0) {
        return candidates[candidates.length - 1]!;
      }
      modalAnc = modalAnc.parentElement;
    }
  }

  // 2. Search across configured submit selectors on the document
  for (const sel of config.submitSelectors) {
    const buttons = doc.querySelectorAll<HTMLElement>(sel);
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i]!;
      if (!isElementDisplayed(btn)) continue;
      const text = (btn.textContent ?? '').trim();
      const testId = btn.getAttribute('data-testid') ?? '';
      if (
        testId.includes(config.submitTestIdHint) ||
        buttonKeywordRegex.test(text) ||
        looseKeywordRegex.test(text)
      ) {
        return btn;
      }
    }
  }

  return null;
}

function createPlatformAdapter(config: PlatformAdapterConfig): PlatformAdapter {
  return {
    id: config.id,
    displayName: config.displayName,
    walletUrl: config.walletUrl,

    isWalletPage(url: string, doc: Document): boolean {
      if (config.walletPathPattern.test(url)) return true;
      const { input } = this.findInputAndSubmit(doc);
      return Boolean(input);
    },

    detectChallengeOrAuthBlock(doc: Document): string | null {
      return detectCommonChallenge(doc);
    },

    findInputAndSubmit(rootDoc: Document) {
      for (const doc of collectSameOriginDocuments(rootDoc)) {
        let input: HTMLInputElement | null = null;
        for (const sel of config.inputSelectors) {
          const matches = doc.querySelectorAll<HTMLInputElement>(sel);
          for (let i = matches.length - 1; i >= 0; i--) {
            const candidate = matches[i]!;
            if (isCandidatePromoInput(candidate)) {
              input = candidate;
              break;
            }
          }
          if (input) break;
        }
        if (!input) {
          input = findInputByLabelOrFallback(doc);
        }

        if (input) {
          const submit = findSubmitNearInput(doc, input, config);
          return { input, submit };
        }
      }

      return { input: null, submit: null };
    },

    tryOpenPromoModal(doc: Document): boolean {
      const candidates = doc.querySelectorAll<HTMLElement>(
        'button, a, [role="button"], li, div[tabindex]',
      );
      for (const el of candidates) {
        if (!isElementDisplayed(el)) continue;
        const text = (el.textContent ?? '').trim();
        if (config.modalTriggerPattern.test(text)) {
          el.click();
          return true;
        }
      }
      return false;
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
    '[data-testid*="voucher"] input',
    '[class*="voucher"] input',
    'input[name*="voucher"]',
    'input[id*="voucher"]',
    'input[name*="coupon"]',
    'input[id*="coupon"]',
    'input[placeholder*="優惠碼"]',
    'input[placeholder*="優惠券"]',
    'input[placeholder*="折扣碼"]',
    'input[placeholder*="代碼"]',
    'input[aria-label*="優惠碼"]',
    'input[aria-label*="優惠券"]',
    'input[placeholder*="Voucher"]',
  ],
  submitSelectors: [
    'button[data-testid="voucher-apply-btn"]',
    'button[data-testid*="voucher-apply"]',
    'button[data-testid*="add-voucher"]',
    'button[type="submit"]',
    'button',
    '[role="button"]',
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
  modalTriggerPattern:
    /^(?:新增優惠券|輸入優惠碼|新增優惠碼|使用優惠券|Add a voucher|Add voucher)$/i,
});

export const uberEatsAdapter: PlatformAdapter = createPlatformAdapter({
  id: 'ubereats',
  displayName: 'Uber Eats 優食',
  walletUrl: 'https://www.ubereats.com/tw/promotions',
  walletPathPattern: /\/(promotions|wallet|checkout)\b/i,
  inputSelectors: [
    'input[data-testid="promo-code-input"]',
    'input[data-testid*="promo"]',
    '[data-testid*="promo"] input',
    '[class*="promo"] input',
    '[role="dialog"] input',
    '[aria-modal="true"] input',
    '[data-baseweb*="modal"] input',
    '[data-baseweb*="drawer"] input',
    'input[name*="promo"]',
    'input[id*="promo"]',
    'input[placeholder*="優惠序號"]',
    'input[placeholder*="優惠碼"]',
    'input[placeholder*="輸入優惠"]',
    'input[placeholder*="折扣碼"]',
    'input[placeholder*="代碼"]',
    'input[placeholder*="序號"]',
    'input[aria-label*="優惠序號"]',
    'input[aria-label*="優惠碼"]',
    'input[placeholder*="Promo"]',
  ],
  submitSelectors: [
    'button[data-testid="promo-apply-button"]',
    'button[data-testid*="promo-apply"]',
    'button[type="submit"]',
    'button',
    '[role="button"]',
  ],
  submitTestIdHint: 'promo',
  feedbackSelectors: [
    '[data-testid="promo-status-message"]',
    '[data-testid*="promo-error"]',
    '[data-testid*="promo-success"]',
    '[role="alert"]',
    '.promo-feedback',
  ],
  modalTriggerPattern:
    /^(?:新增優惠序號|輸入優惠序號|新增優惠|輸入優惠碼|新增折扣碼|Add promo code|Add promo|優惠方案)$/i,
});

export function detectPlatform(url: string): PlatformAdapter {
  if (/ubereats\.com/i.test(url)) {
    return uberEatsAdapter;
  }
  return foodpandaAdapter;
}
