// ==UserScript==
// @name         Auto_Coupon — 熊貓 & Uber Eats 自動領優惠券
// @namespace    https://github.com/Muranecodes/Auto_Coupon
// @version      1.0.0
// @description  在台灣 foodpanda 與 Uber Eats 網頁版自動批次歸戶優惠碼、一鍵複製結帳限定碼、智慧解析文字優惠碼（支援 iOS Safari Stay/Userscripts 與 Android/電腦 Tampermonkey）
// @author       Muranecodes
// @match        https://www.foodpanda.com.tw/*
// @match        https://foodpanda.com.tw/*
// @match        https://www.ubereats.com/*
// @match        https://ubereats.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/dist/auto-coupon.user.js
// @downloadURL  https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/dist/auto-coupon.user.js
// ==/UserScript==

(() => {
  'use strict';

// --- src/userscript/storage.ts ---
const STORAGE_PREFIX = 'auto_coupon:v1:';

function readRaw(key        )                {
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

function writeRaw(key        , value               )       {
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
}function normalizeCouponCode(code        )         {
  return code.trim();
}function dedupeCouponCodes(codes          )           {
  const unique           = [];
  const seen = new Set        ();
  for (const raw of codes) {
    const norm = normalizeCouponCode(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    unique.push(norm);
  }
  return unique;
}function loadRedemptionRecords(
  platform            ,
)                                   {
  const raw = readRaw(`records:${platform}`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw)                                    ;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}function saveRedemptionRecord(
  platform            ,
  code        ,
  outcome                   ,
  message         ,
)                   {
  const normalized = normalizeCouponCode(code);
  const records = loadRedemptionRecords(platform);
  const record                   = {
    code: normalized,
    platform,
    outcome,
    message,
    attemptedAt: new Date().toISOString(),
  };
  records[normalized] = record;
  writeRaw(`records:${platform}`, JSON.stringify(records));
  return record;
}function savePendingRunState(
  state                               ,
)       {
  writeRaw('pending_run', state ? JSON.stringify(state) : null);
}function consumePendingRunState(
  platform            ,
)                                {
  const raw = readRaw('pending_run');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw)                          ;
    if (parsed && parsed.platform === platform && Array.isArray(parsed.codes)) {
      writeRaw('pending_run', null);
      return parsed;
    }
  } catch {
    writeRaw('pending_run', null);
  }
  return null;
}function loadCachedFeed()                    {
  const raw = readRaw('cached_feed');
  if (!raw) return null;
  try {
    return JSON.parse(raw)              ;
  } catch {
    return null;
  }
}function saveCachedFeed(feed            )       {
  writeRaw('cached_feed', JSON.stringify(feed));
}

// --- src/userscript/feed.ts ---
const DEFAULT_FEED_URL =
  'https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/data/coupons.json';async function fetchCouponFeed(
  feedUrl = DEFAULT_FEED_URL,
  customFetcher                                    ,
)                      {
  try {
    let rawData         ;
    if (customFetcher) {
      rawData = await customFetcher(feedUrl);
    } else if (typeof GM_xmlhttpRequest === 'function') {
      rawData = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest ({
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
    saveCachedFeed(parsed);
    return parsed;
  } catch {
    const cached = loadCachedFeed();
    if (cached) return cached;
    return { updatedAt: new Date().toISOString(), coupons: [] };
  }
}

function validateFeed(raw         )             {
  if (!raw || typeof raw !== 'object') {
    return { updatedAt: new Date().toISOString(), coupons: [] };
  }
  const obj = raw                       ;
  const coupons = Array.isArray(obj.coupons) ? obj.coupons : [];
  return {
    updatedAt:
      typeof obj.updatedAt === 'string'
        ? obj.updatedAt
        : new Date().toISOString(),
    coupons: coupons.filter(
      (c)                   =>
        Boolean(c && typeof c.code === 'string' && typeof c.platform === 'string'),
    ),
  };
}function isCouponExpired(
  expiresAt                           ,
  todayIsoDate        ,
)          {
  if (!expiresAt) return false;
  const datePart = expiresAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return false;
  return datePart < todayIsoDate;
}function partitionPlatformCoupons(
  feed            ,
  platform            ,
  todayIsoDate = new Date().toISOString().slice(0, 10),
)   
                               
                                 
  {
  const walletCoupons                = [];
  const checkoutCoupons                = [];

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

// --- src/userscript/parser.ts ---
const NOISE_TOKEN_REGEX =
  /^(?:\d+|[$＄]\d+|NT\$?\d+|滿\d+.*|折\d+.*|\d+(?:\.\d+)?折|免運|免外送費|外送|優惠碼|優惠券|折扣碼|優惠序號|輸入|代碼|使用|領取|點我|立即|限時|最高|享\d+.*)$/i;const COUPON_CONTEXT_HINT_REGEX =
  /優惠碼|優惠序號|折扣碼|代碼|輸入|code|【|「|『/i;

function escapeRegExp(str        )         {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidCandidateToken(raw        )          {
  const token = raw.trim();
  if (token.length < 2 || token.length > 20) return false;
  if (NOISE_TOKEN_REGEX.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  if (/^(https?|www|foodpanda|ubereats)$/i.test(token)) return false;
  return /^[A-Za-z0-9\u4e00-\u9fff_-]+$/.test(token);
}function hasCouponHint(text        )          {
  return COUPON_CONTEXT_HINT_REGEX.test(text);
}function stripCouponCodeFromTitle(
  blockText        ,
  code        ,
)         {
  const escaped = escapeRegExp(code);
  const cleaned = blockText
    .replace(new RegExp(`[【「『]\\s*${escaped}\\s*[】」』]`, 'g'), '')
    .replace(
      new RegExp(
        `(?:輸入)?(?:優惠碼|優惠序號|折扣碼|代碼|code)\\s*[:：為是]?\\s*${escaped}`,
        'gi',
      ),
      '',
    )
    .replace(/\s+/g, ' ')
    .replace(/^[,，、:：\-—\s]+|[,，、:：\-—\s]+$/g, '')
    .trim();
  return cleaned || `${code} 優惠券`;
}function extractCandidateChips(text        )                  {
  const results                  = [];
  const seen = new Set        ();

  const pushCandidate = (raw                    ) => {
    if (!raw) return;
    const cleaned = raw
      .trim()
      .replace(/^[【「『"'\s:：]+|[】」』"'\s]+$/g, '');
    if (!isValidCandidateToken(cleaned)) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    results.push({ code: cleaned, selected: true });
  };

  const lines = text.split(/[\r\n]+/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const explicitPattern =
      /【([^】\n]{2,20})】|「([^」\n]{2,20})」|『([^』\n]{2,20})』|(?:優惠碼|優惠序號|折扣碼|代碼|code)\s*[:：為是]?\s*([A-Za-z0-9\u4e00-\u9fff_-]{2,20})|輸入\s*[:：]?\s*([A-Za-z0-9\u4e00-\u9fff_-]{2,12})(?=\s|$|[，,。！!）)])/gi;

    let matchedExplicitInLine = false;
    let match                        ;
    while ((match = explicitPattern.exec(line)) !== null) {
      const token = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
      if (token) {
        matchedExplicitInLine = true;
        pushCandidate(token);
      }
    }

    if (!matchedExplicitInLine && !/[。！!？?（）()]/.test(line)) {
      const rawTokens = line.split(/[,，、;；\s]+/);
      for (const tok of rawTokens) {
        pushCandidate(tok);
      }
    }
  }

  return results;
}

// --- src/userscript/platforms.ts ---
function setNativeInputValue(
  input                  ,
  value        ,
)       {
  const proto = Object.getPrototypeOf(input)                           ;
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

function detectCommonChallenge(doc          )                {
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

function classifyFeedbackText(text        )                           {
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

let antiHijackInstalled = false;function isAppDeepLink(url        )          {
  return APP_DEEPLINK_PATTERN.test(url.trim());
}function installAntiAppHijack(doc          )       {
  // Remove iOS Smart App Banner meta tags & app-open banners
  const banners = doc.querySelectorAll(
    'meta[name="apple-itunes-app"], [data-testid*="app-banner"], [class*="smart-banner"], [id*="branch-banner"]',
  );
  for (const el of banners) {
    el.remove();
  }

  // Neutralize deep-link anchors on the page
  const anchors = doc.querySelectorAll             ('a[href]');
  for (const a of anchors) {
    const href = a.getAttribute('href') ?? '';
    if (isAppDeepLink(href)) {
      a.setAttribute('data-blocked-deeplink', href);
      a.removeAttribute('href');
    }
  }

  if (antiHijackInstalled) return;
  antiHijackInstalled = true;

  doc.addEventListener('click', (ev       ) => {
    const target = ev.target                      ;
    if (!target) return;
    let curr                     = target;
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
}function navigateWithoutAppSwitch(
  targetUrl        ,
  doc          ,
  fallbackNavigate                       ,
)       {
  try {
    const parsed = new URL(
      targetUrl,
      typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'https://www.foodpanda.com.tw/',
    );
    const relativePath = `${parsed.pathname}${parsed.search}${parsed.hash}`;

    // 1. If an in-page SPA link to this pathname exists, click it so router navigates without iOS Universal Link
    const inPageLink = doc.querySelector             (
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
      typeof (window                                    ).history?.pushState ===
        'function'
    ) {
      const hist = (window                                   ).history;
      hist.pushState({}, '', relativePath);
      window.dispatchEvent(new Event('popstate', { bubbles: true }));
    }
  } catch {
    // Fallback to standard navigation
  }

  fallbackNavigate(targetUrl);
}

let lastInterceptedResponseText                = null;
let snifferInstalled = false;function recordNetworkFeedbackText(bodyText        )       {
  if (bodyText && bodyText.trim()) {
    lastInterceptedResponseText = bodyText.trim();
  }
}function consumeNetworkFeedbackText()                {
  const val = lastInterceptedResponseText;
  lastInterceptedResponseText = null;
  return val;
}function installNetworkFeedbackSniffer()       {
  if (snifferInstalled || typeof window === 'undefined') return;
  snifferInstalled = true;
  const win = window                
                         
   ;
  if (typeof win.fetch === 'function') {
    const origFetch = win.fetch.bind(window);
    win.fetch = async (...args                          ) => {
      const res = await origFetch(...args);
      try {
        const reqUrl =
          typeof args[0] === 'string'
            ? args[0]
            : (args[0]                    )?.url ?? '';
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

function createPlatformAdapter(config                       )                  {
  return {
    id: config.id,
    displayName: config.displayName,
    walletUrl: config.walletUrl,

    isWalletPage(url        , doc          )          {
      if (config.walletPathPattern.test(url)) return true;
      const { input, submit } = this.findInputAndSubmit(doc);
      return Boolean(input && submit);
    },

    detectChallengeOrAuthBlock(doc          )                {
      return detectCommonChallenge(doc);
    },

    findInputAndSubmit(doc          ) {
      let input                          = null;
      for (const sel of config.inputSelectors) {
        const found = doc.querySelector                  (sel);
        if (found) {
          input = found;
          break;
        }
      }

      let submit                     = null;
      for (const sel of config.submitSelectors) {
        const buttons = doc.querySelectorAll             (sel);
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

    classifyFeedback(doc          )                           {
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
}const foodpandaAdapter                  = createPlatformAdapter({
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
});const uberEatsAdapter                  = createPlatformAdapter({
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
});function detectPlatform(url        )                  {
  if (/ubereats\.com/i.test(url)) {
    return uberEatsAdapter;
  }
  return foodpandaAdapter;
}

// --- src/userscript/app.ts ---
const DEFAULT_DELAY_FN = () => 650 + Math.floor(Math.random() * 550);

const SHADOW_STYLES = `
  :host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
  }
  .ac-pill {
    position: fixed;
    right: 16px;
    bottom: 84px;
    z-index: 2147483646;
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
    background: #ffffff;
    color: #1f2937;
    border-radius: 20px 20px 0 0;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.22);
    max-height: 82vh;
    overflow-y: auto;
    padding: 16px 18px 24px;
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
`;function mountAutoCoupon(
  options                         = {},
)                       {
  installNetworkFeedbackSniffer();
  installAntiAppHijack(document);

  const currentUrl =
    options.url ??
    (typeof window !== 'undefined' && window.location
      ? window.location.href
      : 'https://www.foodpanda.com.tw/');
  const delayFn = options.delayMs ?? DEFAULT_DELAY_FN;
  const feedUrl = options.feedUrl ?? DEFAULT_FEED_URL;
  const navigateFn =
    options.navigate ??
    ((targetUrl        ) => {
      if (typeof window !== 'undefined' && window.location) {
        window.location.href = targetUrl;
      }
    });
  const platform = detectPlatform(currentUrl);

  const existingHost = document.querySelector('#auto-coupon-root');
  if (existingHost) {
    existingHost.remove();
  }

  const host = document.createElement('div');
  host.id = 'auto-coupon-root';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  let isOpen = false;
  let forceRetry = false;
  let manualQueueCodes           = [];
  let feedWalletCoupons                = [];
  let feedCheckoutCoupons                = [];
  let candidateChips                  = [];
  let pausedRemainingCodes           = [];
  const liveStatusByCode = new Map                          ();
  let copiedCheckoutCode                = null;
  let activeTaskPromise                       = null;
  let runStatusText = '待命';
  let summaryCounts                                    = {
    claimed: 0,
    already_claimed: 0,
    invalid_or_expired: 0,
  };

  shadow.innerHTML = `
    <style>${SHADOW_STYLES}</style>
    <button type="button" class="ac-pill" data-role="floating-pill">
      <span>🎟️ 自動領券</span>
      <span class="ac-pill-badge" data-role="pill-badge">0</span>
    </button>
    <section class="ac-sheet" data-role="bottom-sheet" data-open="false">
      <div class="ac-header">
        <div class="ac-title" data-role="platform-title">${platform.displayName} 自動領券</div>
        <button type="button" class="ac-btn ac-btn-secondary" data-role="close-sheet-btn">收合</button>
      </div>
      <div class="ac-row">
        <span data-role="run-status">狀態：待命</span>
        <button type="button" class="ac-btn ac-btn-secondary" data-role="sync-feed-btn">同步最新清單</button>
      </div>
      <div class="ac-row">
        <input type="text" class="ac-input" data-role="feed-url-input" value="${feedUrl}" placeholder="遠端 Coupon Feed JSON URL" />
      </div>
      <div class="ac-row" data-role="run-summary">成功: 0 | 已領過: 0 | 無效/過期: 0</div>
      <div class="ac-row">
        <label>
          <input type="checkbox" data-role="force-retry-checkbox" />
          強制重試已記錄的優惠碼
        </label>
      </div>
      <div class="ac-row">
        <button type="button" class="ac-btn" data-role="start-run-btn">開始批次歸戶</button>
        <button type="button" class="ac-btn ac-btn-secondary" data-role="resume-run-btn">繼續執行</button>
      </div>
      <div class="ac-section">
        <div>歸戶型優惠碼佇列（Wallet Coupons）：</div>
        <div data-role="wallet-coupon-list"></div>
      </div>
      <div class="ac-section">
        <div>智慧文字擷取（貼上 LINE / 懶人包文字）：</div>
        <div class="ac-row">
          <input type="text" class="ac-input" data-role="freeform-input" placeholder="貼上含優惠碼的整段文字..." />
          <button type="button" class="ac-btn ac-btn-secondary" data-role="parse-text-btn">解析優惠碼</button>
        </div>
        <div class="ac-chip-list" data-role="candidate-chip-list"></div>
      </div>
      <div class="ac-section">
        <div>結帳/信用卡限定碼（點擊一鍵複製）：</div>
        <div data-role="checkout-coupon-list"></div>
      </div>
    </section>
  `;

  const pillBtn = shadow.querySelector                   (
    '[data-role="floating-pill"]',
  ) ;
  const pillBadge = shadow.querySelector             (
    '[data-role="pill-badge"]',
  ) ;
  const sheetEl = shadow.querySelector             (
    '[data-role="bottom-sheet"]',
  ) ;
  const closeBtn = shadow.querySelector                   (
    '[data-role="close-sheet-btn"]',
  ) ;
  const syncFeedBtn = shadow.querySelector                   (
    '[data-role="sync-feed-btn"]',
  ) ;
  const feedUrlInput = shadow.querySelector                  (
    '[data-role="feed-url-input"]',
  ) ;
  const statusEl = shadow.querySelector             (
    '[data-role="run-status"]',
  ) ;
  const summaryEl = shadow.querySelector             (
    '[data-role="run-summary"]',
  ) ;
  const forceRetryCheckbox = shadow.querySelector                  (
    '[data-role="force-retry-checkbox"]',
  ) ;
  const startRunBtn = shadow.querySelector                   (
    '[data-role="start-run-btn"]',
  ) ;
  const resumeRunBtn = shadow.querySelector                   (
    '[data-role="resume-run-btn"]',
  ) ;
  const walletListEl = shadow.querySelector             (
    '[data-role="wallet-coupon-list"]',
  ) ;
  const freeformInput = shadow.querySelector                  (
    '[data-role="freeform-input"]',
  ) ;
  const parseTextBtn = shadow.querySelector                   (
    '[data-role="parse-text-btn"]',
  ) ;
  const candidateChipListEl = shadow.querySelector             (
    '[data-role="candidate-chip-list"]',
  ) ;
  const checkoutListEl = shadow.querySelector             (
    '[data-role="checkout-coupon-list"]',
  ) ;

  function getEffectiveWalletCodes()           {
    return dedupeCouponCodes([
      ...manualQueueCodes,
      ...feedWalletCoupons.map((c) => c.code),
      ...candidateChips.filter((c) => c.selected).map((c) => c.code),
    ]);
  }

  function computeUntriedCount()         {
    const records = loadRedemptionRecords(platform.id);
    return getEffectiveWalletCodes().filter((code) => !records[code]).length;
  }

  function renderWalletCoupons()       {
    walletListEl.innerHTML = '';
    const records = loadRedemptionRecords(platform.id);
    const titleByCode = new Map(
      feedWalletCoupons.map((c) => [normalizeCouponCode(c.code), c.title]),
    );

    for (const code of getEffectiveWalletCodes()) {
      const row = document.createElement('div');
      row.setAttribute('class', 'ac-row');
      row.setAttribute('data-wallet-code', code);

      const status                   =
        liveStatusByCode.get(code) ?? records[code]?.outcome ?? 'pending';
      row.setAttribute('data-coupon-status', status);

      const title = titleByCode.get(code);
      row.textContent = title
        ? `${code} (${title}) [${status}]`
        : `${code} [${status}]`;
      walletListEl.appendChild(row);
    }
  }

  function renderCandidateChips()       {
    candidateChipListEl.innerHTML = '';
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

  function renderCheckoutCoupons()       {
    checkoutListEl.innerHTML = '';
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
        for (const btn of checkoutListEl.querySelectorAll                   (
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

  function renderState()       {
    sheetEl.setAttribute('data-open', isOpen ? 'true' : 'false');
    statusEl.textContent = `狀態：${runStatusText}`;
    summaryEl.textContent = `成功: ${summaryCounts.claimed} | 已領過: ${summaryCounts.already_claimed} | 無效/過期: ${summaryCounts.invalid_or_expired}`;
    pillBadge.textContent = String(computeUntriedCount());
    renderWalletCoupons();
  }

  async function syncFeed()                {
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

  pillBtn.addEventListener('pointerdown', (ev       ) => {
    const pe = ev                                                     ;
    dragged = false;
    dragStartX = pe.clientX ?? 0;
    dragStartY = pe.clientY ?? 0;
  });

  pillBtn.addEventListener('pointermove', (ev       ) => {
    const pe = ev                
                       
                       
                       
     ;
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
    codesToRun          ,
    isResuming = false,
  )                {
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

    if (!platform.isWalletPage(currentUrl, document)) {
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

    const records                                   = loadRedemptionRecords(
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
      const code = filteredCodes[i] ;
      const blockMsg = platform.detectChallengeOrAuthBlock(document);
      if (blockMsg) {
        pausedRemainingCodes = filteredCodes.slice(i);
        runStatusText = `已暫停：${blockMsg}`;
        renderState();
        return;
      }

      const { input, submit } = platform.findInputAndSubmit(document);
      if (!input || !submit) {
        pausedRemainingCodes = filteredCodes.slice(i);
        runStatusText = '已暫停：找不到優惠碼輸入框或套用按鈕';
        renderState();
        return;
      }

      liveStatusByCode.set(code, 'submitting');
      runStatusText = `執行中 (${i + 1}/${filteredCodes.length})：${code}`;
      renderState();

      setNativeInputValue(input, code);
      submit.click();

      const waitTime = Math.max(0, delayFn());
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      const postBlock = platform.detectChallengeOrAuthBlock(document);
      if (postBlock) {
        liveStatusByCode.set(code, 'pending');
        pausedRemainingCodes = filteredCodes.slice(i);
        runStatusText = `已暫停：${postBlock}`;
        renderState();
        return;
      }

      const result = platform.classifyFeedback(document);
      liveStatusByCode.set(code, result.outcome);
      summaryCounts[result.outcome] += 1;
      saveRedemptionRecord(platform.id, code, result.outcome, result.message);
      renderState();
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

  const pending = platform.isWalletPage(currentUrl, document)
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
    activeTaskPromise = syncFeed();
  }

  renderState();

  return {
    platform,
    setQueue(codes          ) {
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

// --- src/userscript/index.ts ---
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountAutoCoupon();
}
})();
