import type { PlatformId, RedemptionOutcome } from '../shared/types.ts';

declare const unsafeWindow: Window | undefined;

export interface PlatformSubmissionResult {
  outcome: RedemptionOutcome;
  message: string;
}

export interface SubmissionSnapshot {
  code: string;
  beforeFeedbackTexts: Set<string>;
  beforeCardCount: number;
  codeExistedBefore: boolean;
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
  captureSubmissionSnapshot?(doc: Document, code: string): SubmissionSnapshot;
  hasSubmissionUpdate?(doc: Document, snapshot: SubmissionSnapshot): boolean;
  classifyFeedback(
    doc: Document,
    snapshot?: SubmissionSnapshot,
  ): PlatformSubmissionResult;
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

  const previousValue = input.value;
  const proto = Object.getPrototypeOf(input) as HTMLInputElement | null;
  const protoDescriptor =
    (proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined) ??
    (typeof HTMLInputElement !== 'undefined' && HTMLInputElement.prototype
      ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      : undefined);
  const instanceDescriptor = Object.getOwnPropertyDescriptor(input, 'value');
  const descriptor = protoDescriptor ?? instanceDescriptor;

  if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }

  const tracker = (
    input as unknown as {
      _valueTracker?: { setValue?: (v: string) => void };
    }
  )._valueTracker;
  if (tracker && typeof tracker.setValue === 'function') {
    tracker.setValue(previousValue === value ? '' : previousValue);
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function triggerSubmitOrEnter(
  input: HTMLInputElement,
  submit: HTMLElement | null,
): void {
  if (submit) {
    const btn = submit as HTMLButtonElement;
    if (btn.disabled || submit.hasAttribute('disabled')) {
      btn.disabled = false;
      submit.removeAttribute('disabled');
    }
    if (submit.getAttribute('aria-disabled') === 'true') {
      submit.setAttribute('aria-disabled', 'false');
    }
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

const ALREADY_CLAIMED_REGEX =
  /已經領取|已領取|已套用過|已存在|已被領取|重複領取|已在您的帳戶|已在優惠券匣|already[_\s-]*(claimed|applied|redeemed|added|used|in[_\s-]*wallet|exists)|duplicate/i;

const EXPLICIT_CLAIMED_REGEX =
  /成功|已存入|已新增|已套用|已歸戶|已領取優惠|恭喜獲得|領取完成|added|claimed|applied\s+successfully|promo\s+applied|voucher\s+added|saved\s+to\s+wallet/i;

const EXPLICIT_FAILURE_NEGATION_REGEX =
  /未能成功|無法成功|未成功|無法(?:使用|套用|領取|新增|兌換)|(?:領取|套用|新增|兌換)失敗|not\s+added|not\s+applied|cannot\s+be\s+applied|failed/i;

const EXPLICIT_INVALID_ERROR_REGEX =
  /(?:此|該|輸入的)?(?:優惠碼|優惠券|序號|折扣碼|代碼)(?:無效|已過期|已失效|已兌換完畢|已達上限|不存在|輸入錯誤|不正確)|無效或已過期|無效的優惠|無法(?:使用|套用|領取|新增|兌換)|(?:領取|套用|新增|兌換)失敗|不符合(?:使用|領取)?資格|已兌換完畢|數量已達上限|invalid|expired|not\s+found|not\s+eligible|cannot\s+be\s+applied|does\s+not\s+exist/i;

function classifyFeedbackText(text: string): PlatformSubmissionResult {
  const normalized = text.trim();
  if (ALREADY_CLAIMED_REGEX.test(normalized)) {
    return {
      outcome: 'already_claimed',
      message: normalized || '已領取過此優惠碼',
    };
  }
  if (
    EXPLICIT_CLAIMED_REGEX.test(normalized) &&
    !EXPLICIT_FAILURE_NEGATION_REGEX.test(normalized) &&
    !EXPLICIT_INVALID_ERROR_REGEX.test(normalized)
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

interface InterceptedNetworkFeedback {
  bodyText: string;
  status?: number;
}

let lastInterceptedResponse: InterceptedNetworkFeedback | null = null;
const snifferInstalledTargets = new WeakSet<object>();

export function recordNetworkFeedbackText(
  bodyText: string,
  status?: number,
): void {
  if (bodyText && bodyText.trim()) {
    lastInterceptedResponse = {
      bodyText: bodyText.trim(),
      status,
    };
  }
}

export function consumeNetworkFeedbackText(): string | null {
  const val = lastInterceptedResponse?.bodyText ?? null;
  lastInterceptedResponse = null;
  return val;
}

export function hasPendingNetworkFeedback(): boolean {
  return lastInterceptedResponse !== null;
}

function consumeNetworkFeedbackEntry(): InterceptedNetworkFeedback | null {
  const val = lastInterceptedResponse;
  lastInterceptedResponse = null;
  return val;
}

function extractJsonStringField(obj: Record<string, unknown>): string {
  const candidateKeys = [
    'message',
    'error_message',
    'errorMessage',
    'detail',
    'title',
    'name',
    'error_code',
    'errorCode',
    'code',
    'status',
  ];
  for (const key of candidateKeys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  if (obj.error && typeof obj.error === 'object') {
    const nested = extractJsonStringField(obj.error as Record<string, unknown>);
    if (nested) return nested;
  }
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const first = obj.errors[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object') {
      const nested = extractJsonStringField(first as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  if (obj.data && typeof obj.data === 'object') {
    const nested = extractJsonStringField(obj.data as Record<string, unknown>);
    if (nested) return nested;
  }
  return '';
}

function classifyNetworkFeedback(
  entry: InterceptedNetworkFeedback,
): PlatformSubmissionResult {
  const raw = entry.bodyText.trim();
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const statusCode =
          typeof obj.status_code === 'number'
            ? obj.status_code
            : typeof obj.statusCode === 'number'
              ? obj.statusCode
              : entry.status;
        const hasErrorField = Boolean(
          obj.error ||
            (Array.isArray(obj.errors) && obj.errors.length > 0) ||
            obj.error_code ||
            obj.errorCode ||
            obj.error_message ||
            obj.errorMessage ||
            obj.success === false ||
            obj.ok === false ||
            (typeof statusCode === 'number' && statusCode >= 400),
        );
        const extractedMsg = extractJsonStringField(obj);

        if (hasErrorField) {
          if (
            ALREADY_CLAIMED_REGEX.test(extractedMsg) ||
            ALREADY_CLAIMED_REGEX.test(raw)
          ) {
            return {
              outcome: 'already_claimed',
              message: extractedMsg || '已領取過此優惠碼',
            };
          }
          return {
            outcome: 'invalid_or_expired',
            message: extractedMsg || '此優惠碼無效、已過期或不符合資格',
          };
        }

        const hasSuccessPayload = Boolean(
          (typeof statusCode === 'number' &&
            statusCode >= 200 &&
            statusCode < 300) ||
            obj.success === true ||
            obj.ok === true ||
            obj.data ||
            obj.voucher ||
            obj.promotion ||
            obj.id ||
            obj.code,
        );
        if (hasSuccessPayload) {
          if (ALREADY_CLAIMED_REGEX.test(extractedMsg)) {
            return {
              outcome: 'already_claimed',
              message: extractedMsg || '已領取過此優惠碼',
            };
          }
          if (
            EXPLICIT_INVALID_ERROR_REGEX.test(extractedMsg) ||
            EXPLICIT_FAILURE_NEGATION_REGEX.test(extractedMsg)
          ) {
            return {
              outcome: 'invalid_or_expired',
              message: extractedMsg || '此優惠碼無效、已過期或不符合資格',
            };
          }
          return {
            outcome: 'claimed',
            message: extractedMsg || '成功領取優惠碼',
          };
        }
      }
    } catch {
      // Fall back to plain-text classification
    }
  }
  return classifyFeedbackText(raw);
}

function hookWindowNetworkApis(targetWin: unknown): void {
  if (!targetWin || typeof targetWin !== 'object') return;
  if (snifferInstalledTargets.has(targetWin)) return;
  snifferInstalledTargets.add(targetWin);

  const win = targetWin as {
    fetch?: typeof fetch;
    XMLHttpRequest?: typeof XMLHttpRequest;
  };

  if (typeof win.fetch === 'function') {
    const origFetch = win.fetch.bind(targetWin);
    win.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await origFetch(...args);
      try {
        const reqUrl =
          typeof args[0] === 'string'
            ? args[0]
            : (args[0] as { url?: string })?.url ?? '';
        if (
          /voucher|promo|coupon|redeem/i.test(reqUrl) &&
          typeof res.clone === 'function'
        ) {
          const text = await res.clone().text();
          recordNetworkFeedbackText(text, res.status);
        }
      } catch {
        // Ignore clone/read errors
      }
      return res;
    };
  }

  if (
    typeof win.XMLHttpRequest === 'function' &&
    win.XMLHttpRequest.prototype
  ) {
    const xhrProto = win.XMLHttpRequest.prototype as XMLHttpRequest & {
      __autoCouponHooked?: boolean;
    };
    if (!xhrProto.__autoCouponHooked) {
      xhrProto.__autoCouponHooked = true;
      const origOpen = xhrProto.open;
      const origSend = xhrProto.send;
      xhrProto.open = function (
        this: XMLHttpRequest & { __acUrl?: string },
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ) {
        this.__acUrl = String(url ?? '');
        return (origOpen as (...a: unknown[]) => void).apply(this, [
          method,
          url,
          ...rest,
        ]);
      };
      xhrProto.send = function (
        this: XMLHttpRequest & { __acUrl?: string },
        body?: Document | XMLHttpRequestBodyInit | null,
      ) {
        if (
          typeof this.addEventListener === 'function' &&
          /voucher|promo|coupon|redeem/i.test(this.__acUrl ?? '')
        ) {
          this.addEventListener('load', () => {
            try {
              if (typeof this.responseText === 'string' && this.responseText) {
                recordNetworkFeedbackText(this.responseText, this.status);
              }
            } catch {
              // Ignore responseText read errors
            }
          });
        }
        return origSend.call(this, body);
      };
    }
  }
}

export function installNetworkFeedbackSniffer(): void {
  if (typeof window !== 'undefined') {
    hookWindowNetworkApis(window);
  }
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {
      hookWindowNetworkApis(unsafeWindow);
    }
  } catch {
    // Ignore unsafeWindow access errors
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
    Array.from(doc.body?.querySelectorAll('input') ?? []).includes(
      lastUserFocusedInput,
    )
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
      const candidates = Array.from(buttons).filter((btn) => {
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

const VOUCHER_CARD_SELECTOR = [
  '[data-testid*="voucher-card"]',
  '[data-testid*="voucher-item"]',
  '.voucher-card',
  '[class*="voucher-card"]',
  '[class*="voucher-item"]',
  '[data-testid="voucher-list"] > *',
].join(', ');

function isInsideAutoCouponHost(el: HTMLElement): boolean {
  let curr: HTMLElement | null = el;
  while (curr) {
    if (curr.id === 'auto-coupon-root') return true;
    curr = curr.parentElement;
  }
  return false;
}

function countWalletVoucherCards(doc: Document): number {
  const cards = doc.querySelectorAll<HTMLElement>(VOUCHER_CARD_SELECTOR);
  let count = 0;
  for (const card of cards) {
    if (!isInsideAutoCouponHost(card) && isElementDisplayed(card)) {
      count += 1;
    }
  }
  return count;
}

function collectFeedbackSelectorTexts(
  doc: Document,
  selectors: string[],
): string[] {
  const texts: string[] = [];
  for (const sel of selectors) {
    const els = doc.querySelectorAll<HTMLElement>(sel);
    for (const el of els) {
      if (isInsideAutoCouponHost(el) || !isElementDisplayed(el)) continue;
      const t = (el.textContent ?? '').trim();
      if (t) texts.push(t);
    }
  }
  return texts;
}

function isCodeInWalletDom(
  doc: Document,
  code: string,
  feedbackSelectors: string[],
): boolean {
  const normalizedCode = code.trim();
  if (!normalizedCode) return false;

  const feedbackElements = new Set<HTMLElement>();
  for (const sel of feedbackSelectors) {
    for (const el of doc.querySelectorAll<HTMLElement>(sel)) {
      feedbackElements.add(el);
    }
  }

  const allElements = doc.body ? doc.body.querySelectorAll<HTMLElement>('*') : [];
  for (const el of allElements) {
    if (isInsideAutoCouponHost(el) || !isElementDisplayed(el)) continue;
    const tag = el.tagName.toUpperCase();
    if (
      tag === 'SCRIPT' ||
      tag === 'STYLE' ||
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'NAV'
    ) {
      continue;
    }
    if (feedbackElements.has(el)) continue;
    if (el.children && el.children.length > 0) {
      const clsAttr =
        typeof el.className === 'string'
          ? el.className
          : (el.getAttribute?.('class') ?? '');
      const isCard =
        clsAttr.includes('voucher-card') ||
        Boolean(el.getAttribute?.('data-testid')?.includes('voucher-card'));
      if (!isCard) continue;
    }
    const text = (el.textContent ?? '').trim();
    if (!text || !text.includes(normalizedCode)) continue;
    if (
      EXPLICIT_INVALID_ERROR_REGEX.test(text) ||
      EXPLICIT_FAILURE_NEGATION_REGEX.test(text)
    ) {
      continue;
    }
    return true;
  }
  return false;
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

    captureSubmissionSnapshot(doc: Document, code: string): SubmissionSnapshot {
      consumeNetworkFeedbackEntry();
      return {
        code: code.trim(),
        beforeFeedbackTexts: new Set(
          collectFeedbackSelectorTexts(doc, config.feedbackSelectors),
        ),
        beforeCardCount: countWalletVoucherCards(doc),
        codeExistedBefore: isCodeInWalletDom(
          doc,
          code,
          config.feedbackSelectors,
        ),
      };
    },

    hasSubmissionUpdate(doc: Document, snapshot: SubmissionSnapshot): boolean {
      if (hasPendingNetworkFeedback()) return true;
      const currentFeedbackTexts = collectFeedbackSelectorTexts(
        doc,
        config.feedbackSelectors,
      );
      for (const t of currentFeedbackTexts) {
        if (!snapshot.beforeFeedbackTexts.has(t)) return true;
      }
      if (countWalletVoucherCards(doc) > snapshot.beforeCardCount) {
        return true;
      }
      if (
        snapshot.code &&
        !snapshot.codeExistedBefore &&
        isCodeInWalletDom(doc, snapshot.code, config.feedbackSelectors)
      ) {
        return true;
      }
      return false;
    },

    classifyFeedback(
      doc: Document,
      snapshot?: SubmissionSnapshot,
    ): PlatformSubmissionResult {
      const networkEntry = consumeNetworkFeedbackEntry();
      if (networkEntry) {
        return classifyNetworkFeedback(networkEntry);
      }

      const currentFeedbackTexts = collectFeedbackSelectorTexts(
        doc,
        config.feedbackSelectors,
      );

      // 1. Prefer newly appeared / updated feedback element text
      if (snapshot) {
        for (const text of currentFeedbackTexts) {
          if (!snapshot.beforeFeedbackTexts.has(text)) {
            return classifyFeedbackText(text);
          }
        }
      }

      // 2. Check if a new voucher card was added to the wallet list in the DOM
      if (snapshot) {
        const currentCardCount = countWalletVoucherCards(doc);
        if (currentCardCount > snapshot.beforeCardCount) {
          return {
            outcome: 'claimed',
            message: '成功新增優惠券至優惠券匣',
          };
        }
        if (
          snapshot.code &&
          !snapshot.codeExistedBefore &&
          isCodeInWalletDom(doc, snapshot.code, config.feedbackSelectors)
        ) {
          return {
            outcome: 'claimed',
            message: '成功新增優惠券至優惠券匣',
          };
        }
      }

      // 3. Check any active feedback element matching feedbackSelectors
      if (currentFeedbackTexts.length > 0) {
        return classifyFeedbackText(
          currentFeedbackTexts[currentFeedbackTexts.length - 1]!,
        );
      }

      // 4. If the coupon code was already in the wallet DOM before submission
      if (
        snapshot?.code &&
        snapshot.codeExistedBefore &&
        isCodeInWalletDom(doc, snapshot.code, config.feedbackSelectors)
      ) {
        return {
          outcome: 'already_claimed',
          message: '此優惠券已存在於您的優惠券匣',
        };
      }

      // 5. Scoped fallback scan of leaf elements (excluding navigation tabs like "已使用 / 已過期" and voucher cards)
      const allEls = doc.body
        ? doc.body.querySelectorAll<HTMLElement>('*')
        : [];
      for (const el of allEls) {
        if (isInsideAutoCouponHost(el) || !isElementDisplayed(el)) continue;
        const tag = el.tagName.toUpperCase();
        if (
          tag === 'SCRIPT' ||
          tag === 'STYLE' ||
          tag === 'NAV' ||
          tag === 'BUTTON' ||
          tag === 'INPUT' ||
          tag === 'TEXTAREA'
        ) {
          continue;
        }
        if (el.children && el.children.length > 0) continue;
        const text = (el.textContent ?? '').trim();
        if (!text) continue;
        if (ALREADY_CLAIMED_REGEX.test(text)) {
          return { outcome: 'already_claimed', message: text };
        }
        if (
          EXPLICIT_CLAIMED_REGEX.test(text) &&
          !EXPLICIT_FAILURE_NEGATION_REGEX.test(text) &&
          !EXPLICIT_INVALID_ERROR_REGEX.test(text)
        ) {
          return { outcome: 'claimed', message: text };
        }
      }

      return {
        outcome: 'invalid_or_expired',
        message: '此優惠碼無效、已過期或不符合資格',
      };
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
    '[data-testid*="voucher-message"]',
    '[data-testid*="toast"]',
    '[data-testid*="snackbar"]',
    '[data-testid*="notification"]',
    '[data-testid*="alert"]',
    '[role="alert"]',
    '[role="status"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '.voucher-feedback',
    '.notification-toast',
    '[class*="toast"]',
    '[class*="snackbar"]',
    '[class*="error-message"]',
    '[class*="helper-text"]',
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
