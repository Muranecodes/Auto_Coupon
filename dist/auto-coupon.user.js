// ==UserScript==
// @name         Auto_Coupon — 熊貓 & Uber Eats 自動領優惠券
// @namespace    https://github.com/Muranecodes/Auto_Coupon
// @version      1.3.1
// @description  在台灣 foodpanda 與 Uber Eats 網頁版自動批次歸戶優惠碼、一鍵複製結帳限定碼、智慧解析文字優惠碼（支援 iOS Safari Stay/Userscripts 與 Android/電腦 Tampermonkey）
// @author       Muranecodes
// @match        *://*.foodpanda.com.tw/*
// @match        *://foodpanda.com.tw/*
// @match        https://*.foodpanda.com.tw/*
// @match        https://foodpanda.com.tw/*
// @match        *://*.ubereats.com/*
// @match        *://ubereats.com/*
// @match        https://*.ubereats.com/*
// @match        https://ubereats.com/*
// @match        *://*.uber.com/*
// @match        *://uber.com/*
// @match        https://*.uber.com/*
// @match        https://uber.com/*
// @include      *://*.foodpanda.com.tw/*
// @include      *://foodpanda.com.tw/*
// @include      https://*.foodpanda.com.tw/*
// @include      https://foodpanda.com.tw/*
// @include      *://*.ubereats.com/*
// @include      *://ubereats.com/*
// @include      https://*.ubereats.com/*
// @include      https://ubereats.com/*
// @include      https://*ubereats.com/*
// @include      *://*.uber.com/*
// @include      *://uber.com/*
// @include      https://*.uber.com/*
// @include      https://uber.com/*
// @include      https://*uber.com/*
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
}

const RATE_LIMITED_SANITY_REGEX =
  /(?:TooManyRequests|too_many_requests|嘗試次數過多|請稍後再試|太過頻繁|系統忙碌|操作過快|頻率過高|rate\s*limit(?:ed)?|429)/i;function loadSpeedMode(platform            )            {
  const raw = readRaw(`speed_mode:${platform}`);
  if (raw === 'safe' || raw === 'standard') {
    return raw;
  }
  return platform === 'ubereats' ? 'safe' : 'standard';
}function saveSpeedMode(platform            , mode           )       {
  writeRaw(`speed_mode:${platform}`, mode);
}function loadRedemptionRecords(
  platform            ,
)                                   {
  const v2Raw = readRaw(`records:v2:${platform}`);
  if (v2Raw) {
    try {
      const parsed = JSON.parse(v2Raw)                                    ;
      if (!parsed || typeof parsed !== 'object') return {};
      let cleaned = false;
      const sanitized                                   = {};
      for (const [k, rec] of Object.entries(parsed)) {
        if (!rec) continue;
        const msg = rec.message ?? '';
        if (
          rec.outcome === 'invalid_or_expired' &&
          RATE_LIMITED_SANITY_REGEX.test(msg)
        ) {
          cleaned = true;
          continue;
        }
        sanitized[k] = rec;
      }
      if (cleaned) {
        writeRaw(`records:v2:${platform}`, JSON.stringify(sanitized));
      }
      return sanitized;
    } catch {
      return {};
    }
  }

  // Migrate v1 records while dropping false-negative invalid_or_expired entries from v1.0.0
  const v1Raw = readRaw(`records:${platform}`);
  if (!v1Raw) return {};
  try {
    const parsed = JSON.parse(v1Raw)                                    ;
    if (!parsed || typeof parsed !== 'object') return {};
    const migrated                                   = {};
    for (const [k, rec] of Object.entries(parsed)) {
      if (rec && rec.outcome !== 'invalid_or_expired') {
        migrated[k] = rec;
      }
    }
    writeRaw(`records:v2:${platform}`, JSON.stringify(migrated));
    return migrated;
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
  writeRaw(`records:v2:${platform}`, JSON.stringify(records));
  return record;
}function deleteRedemptionRecord(
  platform            ,
  code        ,
)       {
  const normalized = normalizeCouponCode(code);
  const records = loadRedemptionRecords(platform);
  if (records[normalized]) {
    delete records[normalized];
    writeRaw(`records:v2:${platform}`, JSON.stringify(records));
  }
}function clearRedemptionRecords(platform            )       {
  writeRaw(`records:v2:${platform}`, JSON.stringify({}));
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
  'https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/data/coupons.json';
const BUILTIN_COUPON_FEED             = {
  updatedAt: '2026-11-12T13:50:00.000Z',
  coupons: [
    {
      code: '週二星享日',
      platform: 'foodpanda',
      title: '週二星巴克指定專區滿額現折 $70',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '天天取天天爽',
      platform: 'foodpanda',
      title: '外帶自取指定店家滿額折抵優惠（最高折 $110）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '天天省天天爽',
      platform: 'foodpanda',
      title: '美食外送指定餐廳滿額折扣優惠',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '11111111111',
      platform: 'foodpanda',
      title: 'pandapro 半年會員方案特價 $111 結帳優惠碼',
      category: 'checkout_only',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '581享受',
      platform: 'ubereats',
      title: '精選店家滿 $399 享 85 折（最高折 $70~$90）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '會員週年享',
      platform: 'ubereats',
      title: 'Uber One 會員美食外送滿 $649 現折 $100（可用 2 次）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '會員週年慶',
      platform: 'ubereats',
      title: 'Uber One 會員美食外送滿 $450 享 $0 外送費與服務費（可用 4 次）',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: 'afftweats1126',
      platform: 'ubereats',
      title: 'Uber Eats 新戶首 2 單滿 $150 折 $75',
      category: 'wallet',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
    {
      code: '週年慶外帶',
      platform: 'ubereats',
      title: '外帶自取單筆滿 $179 享 7 折（需綁定信用卡，最高折 $60）',
      category: 'checkout_only',
      expiresAt: null,
      updatedAt: '2026-11-12T13:50:00.000Z',
    },
  ],
};
async function fetchCouponFeed(
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
    if (parsed.coupons.length > 0) {
      saveCachedFeed(parsed);
      return parsed;
    }
    if (!customFetcher) {
      return BUILTIN_COUPON_FEED;
    }
    return parsed;
  } catch {
    const cached = loadCachedFeed();
    if (cached && cached.coupons.length > 0) return cached;
    return BUILTIN_COUPON_FEED;
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
}
function isCouponExpired(
  expiresAt                           ,
  todayIsoDate        ,
)          {
  if (!expiresAt) return false;
  const datePart = expiresAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return false;
  return datePart < todayIsoDate;
}
function partitionPlatformCoupons(
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
  /^(?:\d+|[$＄]\d+|NT\$?\d+|滿\d+.*|折\d+.*|\d+(?:\.\d+)?折|免運|免外送費|外送|優惠|優惠碼|優惠券|折扣碼|優惠序號|輸入|代碼|使用|領取|點我|立即|限時|最高|享\d+.*)$/i;

const PROSE_SUBSTRING_REGEX =
  /您|你的|您的|所在|區域|路段|地址|系統|首頁|點擊|選擇|步驟|說明|注意事項/;
const COUPON_CONTEXT_HINT_REGEX =
  /優惠碼|優惠序號|折扣碼|代碼|輸入|code|【|「|『/i;

function escapeRegExp(str        )         {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidCandidateToken(raw        )          {
  const token = raw.trim();
  if (token.length < 2 || token.length > 20) return false;
  if (NOISE_TOKEN_REGEX.test(token)) return false;
  if (PROSE_SUBSTRING_REGEX.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  if (/^(https?|www|foodpanda|ubereats)$/i.test(token)) return false;
  return /^[A-Za-z0-9\u4e00-\u9fff_-]+$/.test(token);
}
function hasCouponHint(text        )          {
  return COUPON_CONTEXT_HINT_REGEX.test(text);
}
function stripCouponCodeFromTitle(
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
}
function extractCandidateChips(text        )                  {
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
      /【([^】\n]{2,20})】|「([^」\n]{2,20})」|『([^』\n]{2,20})』|(?:優惠碼|優惠序號|折扣碼|代碼|code)\s*[:：]\s*([A-Za-z0-9\u4e00-\u9fff_-]{2,15})(?=\s|$|[，,。！!（(）)])|輸入\s*[:：]?\s*([A-Za-z0-9_-]{3,20})(?=\s|$|[，,。！!（(）)])/gi;

    let matchedExplicitInLine = false;
    let match                        ;
    while ((match = explicitPattern.exec(line)) !== null) {
      const token = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
      if (token) {
        matchedExplicitInLine = true;
        pushCandidate(token);
      }
    }

    if (!matchedExplicitInLine && !/[。！!？?（）():：]/.test(line)) {
      const rawTokens = line.split(/[,，、;；\s]+/);
      for (const tok of rawTokens) {
        pushCandidate(tok);
      }
    }
  }

  return results;
}

// --- src/userscript/platforms.ts ---
let lastUserFocusedInput                          = null;
let focusTrackerInstalled = false;
function installInputFocusTracker(doc          )       {
  if (focusTrackerInstalled) return;
  focusTrackerInstalled = true;

  const recordTarget = (ev       ) => {
    const target = ev.target                      ;
    if (!target) return;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA'
    ) {
      lastUserFocusedInput = target                    ;
    }
  };

  try {
    doc.addEventListener('focusin', recordTarget);
    doc.addEventListener('click', recordTarget);
  } catch {
    // Ignore listener attachment errors
  }
}
function setNativeInputValue(
  input                  ,
  value        ,
)       {
  try {
    if (typeof input.focus === 'function') {
      input.focus();
    }
  } catch {
    // Ignore focus errors
  }

  const previousValue = input.value;
  const proto = Object.getPrototypeOf(input)                           ;
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
    input                
                                                         
     
  )._valueTracker;
  if (tracker && typeof tracker.setValue === 'function') {
    tracker.setValue(previousValue === value ? '' : previousValue);
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function triggerSubmitOrEnter(
  input                  ,
  submit                    ,
)       {
  if (submit) {
    const btn = submit                     ;
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

  let curr                     = input.parentElement;
  while (curr) {
    if (curr.tagName === 'FORM') {
      const formEl = curr                
                                   
                            
       ;
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

function isElementDisplayed(el             )          {
  const styleAttr = el.getAttribute?.('style') ?? '';
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(styleAttr)) {
    return false;
  }
  if (el.getAttribute?.('aria-hidden') === 'true') {
    return false;
  }
  if (
    typeof window !== 'undefined' &&
    typeof (window                                                             )
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

function isElementVisiblyActive(el             )          {
  if (!isElementDisplayed(el)) return false;
  return Boolean(
    (el.textContent && el.textContent.trim().length > 0) ||
      el.querySelector?.('iframe'),
  );
}

function detectCommonChallenge(doc          )                {
  try {
    const challengeSelectors = [
      '#px-captcha',
      '[id*="px-captcha"]',
      '.cf-turnstile',
      '[data-testid="challenge-container"]',
    ];
    for (const sel of challengeSelectors) {
      const el = doc.querySelector             (sel);
      if (el && isElementVisiblyActive(el)) {
        return '偵測到網站安全驗證（CAPTCHA），已暫停佇列，請手動完成驗證後點擊「繼續執行」';
      }
    }

    const pageTitle = (doc                                 ).title ?? '';
    if (
      /Access to this page has been denied|Just a moment|Attention Required/i.test(
        pageTitle,
      )
    ) {
      return '偵測到網站安全驗證頁面，已暫停佇列，請手動完成驗證後點擊「繼續執行」';
    }
  } catch {
    // Ignore DOM access errors
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
const RATE_LIMITED_REGEX =
  /(?:TooManyRequests|too_many_requests|嘗試次數過多|請稍後再試|太過頻繁|系統忙碌|操作過快|頻率過高|rate\s*limit(?:ed)?|429)/i;

function classifyFeedbackText(text        )                           {
  const normalized = text.trim();
  if (RATE_LIMITED_REGEX.test(normalized)) {
    return {
      outcome: 'rate_limited',
      message: normalized || '頻率過高（TooManyRequests），請稍後再試',
    };
  }
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
function isAppDeepLink(url        )          {
  return APP_DEEPLINK_PATTERN.test(url.trim());
}
function installAntiAppHijack(doc          )       {
  try {
    const banners = doc.querySelectorAll(
      'meta[name="apple-itunes-app"], [data-testid*="app-banner"], [class*="smart-banner"], [id*="branch-banner"]',
    );
    for (const el of banners) {
      el.remove();
    }

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
  } catch {
    // Ignore early DOM errors
  }
}
function navigateWithoutAppSwitch(
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

    const inPageLink = doc.querySelector             (
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

                                      
                   
                  
 

let lastInterceptedResponse                                    = null;
const snifferInstalledTargets = new WeakSet        ();
function recordNetworkFeedbackText(
  bodyText        ,
  status         ,
)       {
  if (bodyText && bodyText.trim()) {
    lastInterceptedResponse = {
      bodyText: bodyText.trim(),
      status,
    };
  }
}
function consumeNetworkFeedbackText()                {
  const val = lastInterceptedResponse?.bodyText ?? null;
  lastInterceptedResponse = null;
  return val;
}
function hasPendingNetworkFeedback()          {
  return lastInterceptedResponse !== null;
}

function consumeNetworkFeedbackEntry()                                    {
  const val = lastInterceptedResponse;
  lastInterceptedResponse = null;
  return val;
}

function extractJsonStringField(obj                         )         {
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
    const nested = extractJsonStringField(obj.error                           );
    if (nested) return nested;
  }
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const first = obj.errors[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object') {
      const nested = extractJsonStringField(first                           );
      if (nested) return nested;
    }
  }
  if (obj.data && typeof obj.data === 'object') {
    const nested = extractJsonStringField(obj.data                           );
    if (nested) return nested;
  }
  return '';
}

function classifyNetworkFeedback(
  entry                            ,
)                           {
  const raw = entry.bodyText.trim();
  if (entry.status === 429 || RATE_LIMITED_REGEX.test(raw)) {
    try {
      const parsed = JSON.parse(raw)           ;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const extracted = extractJsonStringField(
          parsed                           ,
        );
        return {
          outcome: 'rate_limited',
          message: extracted || raw || '頻率過高（TooManyRequests），請稍後再試',
        };
      }
    } catch {
      // ignore parse error
    }
    return {
      outcome: 'rate_limited',
      message: raw || '頻率過高（TooManyRequests），請稍後再試',
    };
  }

  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)           ;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed                           ;
        const statusCode =
          typeof obj.status_code === 'number'
            ? obj.status_code
            : typeof obj.statusCode === 'number'
              ? obj.statusCode
              : entry.status;
        const extractedMsg = extractJsonStringField(obj);

        if (
          statusCode === 429 ||
          RATE_LIMITED_REGEX.test(extractedMsg) ||
          RATE_LIMITED_REGEX.test(raw)
        ) {
          return {
            outcome: 'rate_limited',
            message:
              extractedMsg || raw || '頻率過高（TooManyRequests），請稍後再試',
          };
        }

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

function hookWindowNetworkApis(targetWin         )       {
  if (!targetWin || typeof targetWin !== 'object') return;
  try {
    if (snifferInstalledTargets.has(targetWin)) return;
    snifferInstalledTargets.add(targetWin);
  } catch {
    return;
  }

  const win = targetWin     
                         
                                           
   ;

  try {
    if (typeof win.fetch === 'function') {
      const origFetch = win.fetch.bind(targetWin);
      win.fetch = async (...args                          ) => {
        const res = await origFetch(...args);
        try {
          const reqUrl =
            typeof args[0] === 'string'
              ? args[0]
              : (args[0]                    )?.url ?? '';
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
  } catch {
    // Ignore read-only or non-configurable fetch
  }

  try {
    if (
      typeof win.XMLHttpRequest === 'function' &&
      win.XMLHttpRequest.prototype
    ) {
      const xhrProto = win.XMLHttpRequest.prototype                      
                                     
       ;
      if (!xhrProto.__autoCouponHooked) {
        try {
          xhrProto.__autoCouponHooked = true;
        } catch {
          // Ignore frozen prototype flag assignment
        }
        const origOpen = xhrProto.open;
        const origSend = xhrProto.send;
        xhrProto.open = function (
                                                      
          method        ,
          url              ,
          ...rest           
        ) {
          try {
            this.__acUrl = String(url ?? '');
          } catch {
            // Ignore non-extensible XHR instance
          }
          return (origOpen                             ).apply(this, [
            method,
            url,
            ...rest,
          ]);
        };
        xhrProto.send = function (
                                                      
          body                                           ,
        ) {
          try {
            if (
              typeof this.addEventListener === 'function' &&
              /voucher|promo|coupon|redeem/i.test(this.__acUrl ?? '')
            ) {
              this.addEventListener('load', () => {
                try {
                  if (
                    typeof this.responseText === 'string' &&
                    this.responseText
                  ) {
                    recordNetworkFeedbackText(this.responseText, this.status);
                  }
                } catch {
                  // Ignore responseText read errors
                }
              });
            }
          } catch {
            // Ignore listener errors
          }
          return origSend.call(this, body);
        };
      }
    }
  } catch {
    // Ignore frozen or read-only XMLHttpRequest.prototype
  }
}
function installNetworkFeedbackSniffer()       {
  try {
    if (typeof window !== 'undefined') {
      hookWindowNetworkApis(window);
    }
  } catch {
    // Ignore window hook errors
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
  'search',
  'tel',
  'url',
]);

const PROMO_INPUT_POSITIVE_HINT =
  /優惠|序號|折扣|代碼|禮券|promo|voucher|coupon|code/i;

const EXCLUDED_INPUT_HINT =
  /search|address|location|email|phone|password|搜尋|輸入地址|外送地址|電話|信箱|密碼/i;

function isCandidatePromoInput(inp                  )          {
  if (!isElementDisplayed(inp)) return false;
  const type = (inp.type || inp.getAttribute('type') || 'text').toLowerCase();
  if (EXCLUDED_INPUT_TYPES.has(type)) return false;
  const role = (inp.getAttribute('role') ?? '').toLowerCase();
  const meta = [
    inp.getAttribute('name') ?? '',
    inp.getAttribute('id') ?? '',
    inp.placeholder || inp.getAttribute('placeholder') || '',
    inp.getAttribute('aria-label') ?? '',
    inp.getAttribute('data-testid') ?? '',
  ].join(' ');
  if (PROMO_INPUT_POSITIVE_HINT.test(meta)) return true;
  if (role === 'combobox' || role === 'searchbox') return false;
  if (EXCLUDED_INPUT_HINT.test(meta)) return false;
  return true;
}

function collectSameOriginDocuments(rootDoc          )             {
  const docs             = [rootDoc];
  try {
    const iframes = rootDoc.querySelectorAll             ('iframe');
    for (const frame of iframes) {
      try {
        const childDoc = (
          frame                                                    
        ).contentDocument;
        if (childDoc && childDoc.body) docs.push(childDoc);
      } catch {
        // Ignore cross-origin iframe
      }
    }
  } catch {
    // Ignore frame query errors
  }
  return docs;
}

function findInputByLabelOrFallback(doc          )                          {
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
  const labels = doc.querySelectorAll             ('label');
  for (const label of labels) {
    const text = label.textContent ?? '';
    if (/優惠|序號|折扣|代碼|禮券|Promo|Voucher|Code/i.test(text)) {
      const forId = label.getAttribute('for');
      if (forId) {
        const byId = doc.querySelector                  (`#${forId}`);
        if (byId && isCandidatePromoInput(byId)) return byId;
      }
      const nested = label.querySelector                  ('input');
      if (nested && isCandidatePromoInput(nested)) return nested;
      const parentInput =
        label.parentElement?.querySelector                  ('input');
      if (parentInput && isCandidatePromoInput(parentInput)) return parentInput;
    }
  }

  // 2. Check inside any open dialog / modal / bottom sheet (in reverse order so bottom-most portal modal wins!)
  const dialogs = doc.querySelectorAll             (
    '[role="dialog"], [aria-modal="true"], [data-baseweb*="modal"], [data-baseweb*="drawer"], dialog, form',
  );
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const dlg = dialogs[i] ;
    const inputs = dlg.querySelectorAll                  ('input');
    for (let j = inputs.length - 1; j >= 0; j--) {
      const inp = inputs[j] ;
      if (isCandidatePromoInput(inp)) return inp;
    }
  }

  // 3. Check inputs whose surrounding container text mentions promo/voucher keywords
  const allInputs = doc.querySelectorAll                  ('input');
  for (let i = allInputs.length - 1; i >= 0; i--) {
    const inp = allInputs[i] ;
    if (!isCandidatePromoInput(inp)) continue;
    let anc                     = inp.parentElement;
    for (let d = 0; d < 4 && anc; d++) {
      if (/優惠|序號|折扣|代碼|禮券|Promo|Voucher|Code/i.test(anc.textContent ?? '')) {
        return inp;
      }
      anc = anc.parentElement;
    }
  }

  // 4. Final fallback: return the last visible candidate input on the page (modals render at end of body)
  for (let i = allInputs.length - 1; i >= 0; i--) {
    const inp = allInputs[i] ;
    if (isCandidatePromoInput(inp)) return inp;
  }

  return null;
}

const CLOSE_CANCEL_BUTTON_REGEX =
  /^(?:關閉|取消|返回|略過|下次再說|Close|Cancel|Back|Dismiss|×|✕|✖)$/i;

function findSubmitNearInput(
  doc          ,
  input                         ,
  config                       ,
)                     {
  const buttonKeywordRegex =
    /^(?:套用|儲存|新增|兌換|領取|確認|確定|送出|提交|使用|完成|Apply|Add|Save|Submit|Redeem)$/i;
  const looseKeywordRegex =
    /套用|儲存|新增|兌換|領取|確認|確定|送出|提交|使用優惠|Apply|Add|Save|Submit|Redeem/i;

  // 1. Walk up to 10 ancestor levels from input (covers deeply nested BaseWeb / Bento UI modals)
  if (input) {
    let container                     = input.parentElement;
    for (let depth = 0; depth < 10 && container; depth++) {
      const nearbyButtons = container.querySelectorAll             (
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
    let modalAnc                     = input.parentElement;
    for (let depth = 0; depth < 6 && modalAnc; depth++) {
      const buttons = modalAnc.querySelectorAll             (
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
        return candidates[candidates.length - 1] ;
      }
      modalAnc = modalAnc.parentElement;
    }
  }

  // 2. Search across configured submit selectors on the document
  for (const sel of config.submitSelectors) {
    const buttons = doc.querySelectorAll             (sel);
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i] ;
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

function isInsideAutoCouponHost(el             )          {
  let curr                     = el;
  while (curr) {
    if (curr.id === 'auto-coupon-root') return true;
    curr = curr.parentElement;
  }
  return false;
}

function countWalletVoucherCards(doc          )         {
  const cards = doc.querySelectorAll             (VOUCHER_CARD_SELECTOR);
  let count = 0;
  for (const card of cards) {
    if (!isInsideAutoCouponHost(card) && isElementDisplayed(card)) {
      count += 1;
    }
  }
  return count;
}

function collectFeedbackSelectorTexts(
  doc          ,
  selectors          ,
)           {
  const texts           = [];
  for (const sel of selectors) {
    const els = doc.querySelectorAll             (sel);
    for (const el of els) {
      if (isInsideAutoCouponHost(el) || !isElementDisplayed(el)) continue;
      const t = (el.textContent ?? '').trim();
      if (t) texts.push(t);
    }
  }
  return texts;
}

function isCodeInWalletDom(
  doc          ,
  code        ,
  feedbackSelectors          ,
)          {
  const normalizedCode = code.trim();
  if (!normalizedCode) return false;

  const feedbackElements = new Set             ();
  for (const sel of feedbackSelectors) {
    for (const el of doc.querySelectorAll             (sel)) {
      feedbackElements.add(el);
    }
  }

  const allElements = doc.body ? doc.body.querySelectorAll             ('*') : [];
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

function createPlatformAdapter(config                       )                  {
  return {
    id: config.id,
    displayName: config.displayName,
    walletUrl: config.walletUrl,
    fullPageNavigation: config.fullPageNavigation ?? false,

    isWalletPage(url        , doc          )          {
      if (config.walletPathPattern.test(url)) return true;
      const { input } = this.findInputAndSubmit(doc);
      return Boolean(input);
    },

    detectChallengeOrAuthBlock(doc          )                {
      return detectCommonChallenge(doc);
    },

    findInputAndSubmit(rootDoc          ) {
      for (const doc of collectSameOriginDocuments(rootDoc)) {
        try {
          let input                          = null;
          for (const sel of config.inputSelectors) {
            const matches = doc.querySelectorAll                  (sel);
            for (let i = matches.length - 1; i >= 0; i--) {
              const candidate = matches[i] ;
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
        } catch {
          // Ignore cross-origin or frame query errors
        }
      }

      return { input: null, submit: null };
    },

    tryOpenPromoModal(rootDoc          )          {
      for (const doc of collectSameOriginDocuments(rootDoc)) {
        try {
          const candidates = doc.querySelectorAll             (
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
        } catch {
          // Ignore frame query errors
        }
      }
      return false;
    },

    captureSubmissionSnapshot(doc          , code        )                     {
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

    hasSubmissionUpdate(doc          , snapshot                    )          {
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
      doc          ,
      snapshot                     ,
    )                           {
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
          currentFeedbackTexts[currentFeedbackTexts.length - 1] ,
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
        ? doc.body.querySelectorAll             ('*')
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
const foodpandaAdapter                  = createPlatformAdapter({
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
const uberEatsAdapter                  = createPlatformAdapter({
  id: 'ubereats',
  displayName: 'Uber Eats 優食',
  // Offers hub (reached via the top-left menu > 優惠; the homepage 優惠 is a different page).
  walletUrl: 'https://www.ubereats.com/tw/feeds/offershub?mod=promos&ps=1',
  fullPageNavigation: true,
  walletPathPattern: /\/feeds\/offershub\b/i,
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
function detectPlatform(url        )                  {
  if (/ubereats\.com/i.test(url) || /uber\.com/i.test(url)) {
    return uberEatsAdapter;
  }
  return foodpandaAdapter;
}

// --- src/userscript/app.ts ---
function getSpeedDelayFn(speedMode           )               {
  if (speedMode === 'safe') {
    return () => 3000 + Math.floor(Math.random() * 3000);
  }
  return () => 2000 + Math.floor(Math.random() * 1500);
}

const DEFAULT_DELAY_FN = () => 2000 + Math.floor(Math.random() * 1500);

function applyHostStyles(el             )       {
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
    gap: 6px;
    padding: 8px 14px;
    border-radius: 999px;
    border: 2px solid rgba(255, 255, 255, 0.95);
    background: linear-gradient(135deg, #f472b6 0%, #ec4899 50%, #c084fc 100%);
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    box-shadow: 0 4px 16px rgba(236, 72, 153, 0.35);
    cursor: pointer;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .ac-pill:hover {
    transform: scale(1.02);
    box-shadow: 0 6px 20px rgba(236, 72, 153, 0.45);
  }
  .ac-pill-badge {
    background: #fff;
    color: #db2777;
    border-radius: 999px;
    padding: 2px 7px;
    font-size: 11px;
    font-weight: 800;
  }
  .ac-sheet {
    position: fixed;
    z-index: 2147483647;
    background: #ffffff;
    color: #1f2937;
    box-shadow: 0 10px 32px rgba(219, 39, 119, 0.16), 0 2px 10px rgba(0, 0, 0, 0.08);
    overflow-y: auto;
    transition: transform 0.22s ease, opacity 0.22s ease;
    box-sizing: border-box;
    border: 1px solid rgba(244, 114, 182, 0.3);
  }
  /* Desktop compact floating card (under 50vh, width 360px) */
  @media (min-width: 641px) {
    .ac-sheet {
      right: 20px;
      bottom: 80px;
      width: 360px;
      max-width: calc(100vw - 40px);
      max-height: 52vh;
      border-radius: 16px;
      padding: 12px 14px;
    }
  }
  /* Mobile compact bottom sheet (capped under 50vh) */
  @media (max-width: 640px) {
    .ac-sheet {
      left: 0;
      right: 0;
      bottom: 0;
      max-height: 50vh;
      border-radius: 18px 18px 0 0;
      padding: 12px 14px calc(16px + env(safe-area-inset-bottom, 0px));
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
    display: block;
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
    transition: opacity 0.15s ease, transform 0.1s ease;
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
  .ac-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .ac-section {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #fce7f3;
    font-size: 12px;
  }
  .ac-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 6px 0;
  }
  .ac-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 999px;
    background: #fce7f3;
    color: #9d174d;
    font-size: 12px;
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
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid #fbcfe8;
    background: #fff;
    font-size: 12px;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.15s ease;
  }
  .ac-input:focus {
    border-color: #ec4899;
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
    max-height: 160px;
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

function clearChildren(el             )       {
  while (el.children && el.children.length > 0) {
    el.children[0] .remove();
  }
  el.textContent = '';
}

function createEl                  (
  doc          ,
  tag   ,
  attrs                         ,
  text         ,
)              {
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
}function mountAutoCoupon(
  options                         = {},
)                       {
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

  const getLiveUrl = ()         =>
    options.url ??
    (typeof window !== 'undefined' && window.location
      ? window.location.href
      : 'https://www.foodpanda.com.tw/');
  const currentUrl = getLiveUrl();
  const platform = detectPlatform(currentUrl);
  let currentSpeedMode            = loadSpeedMode(platform.id);
  const getEffectiveDelayFn = ()                 => {
    if (options.delayMs) return options.delayMs;
    return getSpeedDelayFn(currentSpeedMode);
  };
  const delayFn = () => getEffectiveDelayFn()();
  const feedUrl = options.feedUrl ?? DEFAULT_FEED_URL;
  const navigateFn =
    options.navigate ??
    ((targetUrl        ) => {
      if (typeof window !== 'undefined' && window.location) {
        window.location.href = targetUrl;
      }
    });

  const existingHost = document.querySelector('#auto-coupon-root')   
                      
                                 
                                              
        
          ;
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

  const host = document.createElement('div')                   
                             
                                          
   ;
  host.id = 'auto-coupon-root';
  applyHostStyles(host);

  const ensureHostMounted = ()       => {
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

  let mutationObserver                                = null;
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
  (keepAliveTimer                                     )?.unref?.();

  let rateLimitCooldownTimer                                        = null;

  function clearRateLimitCooldown()       {
    if (rateLimitCooldownTimer !== null) {
      clearInterval(rateLimitCooldownTimer);
      rateLimitCooldownTimer = null;
    }
  }

  host.__acCleanup = () => {
    clearInterval(keepAliveTimer);
    mutationObserver?.disconnect();
    clearRateLimitCooldown();
  };

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

  // Build Shadow DOM without innerHTML so strict Trusted Types CSP (e.g. on Uber Eats) never blocks mounting
  const styleEl = createEl(document, 'style', undefined, SHADOW_STYLES);
  shadow.appendChild(styleEl);

  const pillBtn = createEl(document, 'button', {
    type: 'button',
    class: 'ac-pill',
    'data-role': 'floating-pill',
  })                     ;
  pillBtn.appendChild(createEl(document, 'span', undefined, '🎟️ 自動領券'));
  const pillBadge = createEl(
    document,
    'span',
    { class: 'ac-pill-badge', 'data-role': 'pill-badge' },
    '0',
  );
  pillBtn.appendChild(pillBadge);
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

  pillBtn.style.cssText =
    'position: fixed !important;' +
    'right: 16px !important;' +
    'bottom: calc(90px + env(safe-area-inset-bottom, 0px)) !important;' +
    'z-index: 2147483647 !important;' +
    'display: inline-flex !important;' +
    'align-items: center !important;' +
    'gap: 6px !important;' +
    'padding: 10px 14px !important;' +
    'border-radius: 999px !important;' +
    'border: 2px solid rgba(255, 255, 255, 0.95) !important;' +
    `background: ${pillBg} !important;` +
    'color: #ffffff !important;' +
    'font-size: 14px !important;' +
    'font-weight: 700 !important;' +
    `box-shadow: 0 6px 24px ${shadowColor} !important;` +
    'cursor: pointer !important;' +
    'touch-action: none !important;' +
    '-webkit-user-select: none !important;' +
    'user-select: none !important;' +
    '-webkit-tap-highlight-color: transparent !important;';

  pillBadge.style.cssText =
    'background: #ffffff !important;' +
    `color: ${badgeColor} !important;` +
    'border-radius: 999px !important;' +
    'padding: 2px 7px !important;' +
    'font-size: 12px !important;' +
    'font-weight: 800 !important;' +
    'display: inline-block !important;';

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
  )                     ;
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

  let activeTab                                   = 'queue';
  let historyFilter                            = 'all';
  const expandedHistoryCodes = new Set        ();

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
    '📋 待領佇列',
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
  )                     ;
  statusRow.appendChild(statusEl);
  statusRow.appendChild(syncFeedBtn);
  tabQueuePanel.appendChild(statusRow);

  const feedUrlRow = createEl(document, 'div', { class: 'ac-row' });
  const feedUrlInput = createEl(document, 'input', {
    type: 'text',
    class: 'ac-input',
    'data-role': 'feed-url-input',
    value: feedUrl,
    placeholder: '遠端 Coupon Feed JSON URL',
  })                    ;
  feedUrlRow.appendChild(feedUrlInput);
  tabQueuePanel.appendChild(feedUrlRow);

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
  })                    ;
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
  })                     ;
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
    currentSpeedMode = speedSelect.value             ;
    saveSpeedMode(platform.id, currentSpeedMode);
  });

  speedControlWrapper.appendChild(speedLabel);
  speedControlWrapper.appendChild(speedSelect);
  forceRetryRow.appendChild(speedControlWrapper);
  tabQueuePanel.appendChild(forceRetryRow);

  const actionRow = createEl(document, 'div', { class: 'ac-row' });
  const startRunBtn = createEl(
    document,
    'button',
    { type: 'button', class: 'ac-btn', 'data-role': 'start-run-btn' },
    '開始批次歸戶',
  )                     ;
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
  )                     ;
  actionRow.appendChild(startRunBtn);
  actionRow.appendChild(resumeRunBtn);
  tabQueuePanel.appendChild(actionRow);

  const walletSection = createEl(document, 'div', { class: 'ac-section' });
  walletSection.appendChild(
    createEl(document, 'div', undefined, '歸戶型優惠碼佇列（Wallet Coupons）：'),
  );
  const walletListEl = createEl(document, 'div', {
    class: 'ac-scroll-list',
    'data-role': 'wallet-coupon-list',
  });
  walletSection.appendChild(walletListEl);
  tabQueuePanel.appendChild(walletSection);

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
  })                    ;
  const parseTextBtn = createEl(
    document,
    'button',
    {
      type: 'button',
      class: 'ac-btn ac-btn-secondary',
      'data-role': 'parse-text-btn',
    },
    '解析優惠碼',
  )                     ;
  parserRow.appendChild(freeformInput);
  parserRow.appendChild(parseTextBtn);
  parserSection.appendChild(parserRow);
  const candidateChipListEl = createEl(document, 'div', {
    class: 'ac-chip-list',
    'data-role': 'candidate-chip-list',
  });
  parserSection.appendChild(candidateChipListEl);
  tabQueuePanel.appendChild(parserSection);

  // History Panel Setup
  const historyFilterBar = createEl(document, 'div', {
    class: 'ac-history-filter-bar',
  });
  const filterChipsContainer = createEl(document, 'div', {
    class: 'ac-filter-chips',
  });

  const filterOptions                                                           = [
    { key: 'all', label: '全部' },
    { key: 'claimed', label: '🌸 成功' },
    { key: 'already_claimed', label: '✨ 已領過' },
    { key: 'invalid_or_expired', label: '💭 無效' },
  ];
  const historyFilterChips                = [];
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
  )                     ;
  clearHistoryBtn.addEventListener('click', () => {
    const confirmFn =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm
        : typeof (globalThis                                          ).confirm ===
            'function'
          ? (globalThis                                         ).confirm
          : null;
    const ok = confirmFn
      ? confirmFn('確定要清空此平台的所有歷史領取紀錄嗎？')
      : true;
    if (ok) {
      clearRedemptionRecords(platform.id);
      liveStatusByCode.clear();
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
      '結帳/信用卡限定碼（點擊一鍵複製）：',
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

  function switchTab(tab                                  )       {
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
  }

  tabQueueBtn.addEventListener('click', () => switchTab('queue'));
  tabHistoryBtn.addEventListener('click', () => switchTab('history'));
  tabCheckoutBtn.addEventListener('click', () => switchTab('checkout'));

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
    clearChildren(walletListEl);
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

  function renderHistory()       {
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
        liveStatusByCode.delete(rec.code);
        renderState();
      });
      actionsRow.appendChild(resetBtn);

      body.appendChild(actionsRow);
      card.appendChild(body);

      historyListEl.appendChild(card);
    }
  }

  function renderCandidateChips()       {
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

  function renderCheckoutCoupons()       {
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
    renderHistory();
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

  function startRateLimitCooldown(initialMsg        )       {
    clearRateLimitCooldown();
    let remainingSeconds = 600;
    const formatTimer = (secs        ) => {
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
    (rateLimitCooldownTimer                                     )?.unref?.();
  }

  async function executeRedemptionRun(
    codesToRun          ,
    isResuming = false,
  )                {
    clearRateLimitCooldown();
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
      if (platform.fullPageNavigation) {
        navigateFn(platform.walletUrl);
      } else {
        navigateWithoutAppSwitch(platform.walletUrl, document, navigateFn);
      }
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
        if (result.outcome === 'rate_limited') {
          liveStatusByCode.set(code, 'pending');
          pausedRemainingCodes = filteredCodes.slice(i);
          startRateLimitCooldown(result.message);
          return;
        }
        liveStatusByCode.set(code, result.outcome);
        summaryCounts[result.outcome] += 1;
        saveRedemptionRecord(platform.id, code, result.outcome, result.message);
        renderState();
      } catch {
        const fallbackResult = platform.classifyFeedback(document);
        if (fallbackResult.outcome === 'rate_limited') {
          liveStatusByCode.set(code, 'pending');
          pausedRemainingCodes = filteredCodes.slice(i);
          startRateLimitCooldown(fallbackResult.message);
          return;
        }
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

  const controller                       = {
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

  host.__acController = controller;
  return controller;
}

// --- src/userscript/index.ts ---
function bootAutoCoupon()       {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const start = ()       => {
    try {
      mountAutoCoupon();
    } catch (err) {
      console.error('[AutoCoupon] Failed to mount:', err);
    }
  };

  // 1. Immediate start attempt
  start();

  // 2. DOMContentLoaded event
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  // 3. window load event
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('load', start, { once: true });
  }

  // 4. Repeated periodic check for SPA hydration (every 300ms for first 3 seconds)
  let count = 0;
  const timer = setInterval(() => {
    count++;
    start();
    if (count >= 10) {
      clearInterval(timer);
    }
  }, 300);
  (timer                                     )?.unref?.();
}

bootAutoCoupon();
})();
