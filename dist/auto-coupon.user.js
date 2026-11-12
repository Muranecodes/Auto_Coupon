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

  doc.addEventListener('focusin', recordTarget);
  doc.addEventListener('click', recordTarget);
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
function triggerSubmitOrEnter(
  input                  ,
  submit                    ,
)       {
  if (submit) {
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
function isAppDeepLink(url        )          {
  return APP_DEEPLINK_PATTERN.test(url.trim());
}
function installAntiAppHijack(doc          )       {
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

let lastInterceptedResponseText                = null;
let snifferInstalled = false;
function recordNetworkFeedbackText(bodyText        )       {
  if (bodyText && bodyText.trim()) {
    lastInterceptedResponseText = bodyText.trim();
  }
}
function consumeNetworkFeedbackText()                {
  const val = lastInterceptedResponseText;
  lastInterceptedResponseText = null;
  return val;
}
function installNetworkFeedbackSniffer()       {
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

function isCandidatePromoInput(inp                  )          {
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

function collectSameOriginDocuments(rootDoc          )             {
  const docs             = [rootDoc];
  const iframes = rootDoc.querySelectorAll             ('iframe');
  for (const frame of iframes) {
    try {
      const childDoc = (
        frame                                                    
      ).contentDocument;
      if (childDoc) docs.push(childDoc);
    } catch {
      // Ignore cross-origin iframe
    }
  }
  return docs;
}

function findInputByLabelOrFallback(doc          )                          {
  // 0. If the user recently clicked/focused a valid input on the page, trust it immediately!
  if (
    lastUserFocusedInput &&
    isCandidatePromoInput(lastUserFocusedInput) &&
    doc.body?.querySelectorAll('input').includes(lastUserFocusedInput)
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

function createPlatformAdapter(config                       )                  {
  return {
    id: config.id,
    displayName: config.displayName,
    walletUrl: config.walletUrl,

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
      }

      return { input: null, submit: null };
    },

    tryOpenPromoModal(doc          )          {
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
      return false;
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
    '[role="alert"]',
    '.voucher-feedback',
    '.notification-toast',
  ],
  modalTriggerPattern:
    /^(?:新增優惠券|輸入優惠碼|新增優惠碼|使用優惠券|Add a voucher|Add voucher)$/i,
});
const uberEatsAdapter                  = createPlatformAdapter({
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
function detectPlatform(url        )                  {
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
  installInputFocusTracker(document);

  const getLiveUrl = ()         =>
    options.url ??
    (typeof window !== 'undefined' && window.location
      ? window.location.href
      : 'https://www.foodpanda.com.tw/');
  const currentUrl = getLiveUrl();
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
          '已暫停：請先用手指點一下網頁上的「優惠碼輸入框」（讓游標停在框內），再按「繼續執行」';
        renderState();
        return;
      }

      liveStatusByCode.set(code, 'submitting');
      runStatusText = `執行中 (${i + 1}/${filteredCodes.length})：${code}`;
      renderState();

      setNativeInputValue(input, code);
      if (!submit) {
        ({ submit } = platform.findInputAndSubmit(document));
      }
      triggerSubmitOrEnter(input, submit);

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
