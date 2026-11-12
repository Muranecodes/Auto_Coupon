import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { FakeShadowRoot, installFakeDom } from './helpers/fake-dom.ts';
import { mountAutoCoupon } from '../src/userscript/app.ts';
import {
  recordNetworkFeedbackText,
  uberEatsAdapter,
} from '../src/userscript/platforms.ts';
import {
  clearRedemptionRecords,
  deleteRedemptionRecord,
  loadRedemptionRecords,
  loadSpeedMode,
  saveRedemptionRecord,
  saveSpeedMode,
} from '../src/userscript/storage.ts';

describe('Seam 1: Userscript Mounted Controller on foodpanda wallet page', () => {
  beforeEach(() => {
    installFakeDom('https://www.foodpanda.com.tw/vouchers');
  });

  it('mounts Shadow DOM Bottom Sheet on foodpanda wallet page, runs a Redemption Run via simulated DOM events, records outcomes, skips recorded coupons unless Force Retry is enabled, and pauses on anti-bot challenge', async () => {
    document.body.innerHTML = `
      <main id="foodpanda-vouchers-page">
        <input data-testid="voucher-input" placeholder="輸入優惠碼" value="" />
        <button data-testid="voucher-apply-btn" type="button">套用</button>
        <div data-testid="voucher-feedback"></div>
      </main>
    `;

    const inputEl = document.querySelector<HTMLInputElement>(
      '[data-testid="voucher-input"]',
    )!;
    const applyBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="voucher-apply-btn"]',
    )!;
    const feedbackEl = document.querySelector<HTMLElement>(
      '[data-testid="voucher-feedback"]',
    )!;

    const submittedCodes: string[] = [];
    let lastInputEventValue = '';
    inputEl.addEventListener('input', () => {
      lastInputEventValue = inputEl.value;
    });

    applyBtn.addEventListener('click', () => {
      const code = lastInputEventValue.trim();
      submittedCodes.push(code);
      if (code === '天天省天天爽') {
        feedbackEl.textContent = '成功新增優惠券！已存入您的優惠券匣';
      } else if (code === 'PANDA100') {
        feedbackEl.textContent = '您已經領取過此優惠券';
      } else if (code === 'EXPIRED99') {
        feedbackEl.textContent = '此優惠碼無效或已過期';
      }
    });

    const controller = mountAutoCoupon({
      url: 'https://www.foodpanda.com.tw/vouchers',
      delayMs: () => 5,
      autoSyncFeed: false,
    });

    const host = document.querySelector('#auto-coupon-root');
    assert.ok(host, 'Expected #auto-coupon-root host element');
    const shadow = host.shadowRoot!;
    assert.ok(shadow, 'Expected open shadowRoot on host');

    // Expand Bottom Sheet by clicking floating pill
    const pill = shadow.querySelector<HTMLButtonElement>(
      '[data-role="floating-pill"]',
    )!;
    assert.ok(pill, 'Expected floating pill button');
    pill.click();

    const sheet = shadow.querySelector<HTMLElement>(
      '[data-role="bottom-sheet"]',
    )!;
    assert.equal(sheet.getAttribute('data-open'), 'true');

    // Queue three Wallet Coupons and start Redemption Run
    controller.setQueue(['天天省天天爽', 'PANDA100', 'EXPIRED99']);
    const startBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="start-run-btn"]',
    )!;
    startBtn.click();

    await controller.waitForIdle();

    assert.deepEqual(submittedCodes, ['天天省天天爽', 'PANDA100', 'EXPIRED99']);

    const summaryText =
      shadow.querySelector('[data-role="run-summary"]')?.textContent ?? '';
    assert.match(summaryText, /成功:\s*1/);
    assert.match(summaryText, /已領過:\s*1/);
    assert.match(summaryText, /無效\/過期:\s*1/);

    // Second run with same codes + 1 new code should skip the 3 recorded ones
    submittedCodes.length = 0;
    controller.setQueue(['天天省天天爽', 'PANDA100', 'EXPIRED99', 'NEWCODE88']);
    applyBtn.onclick = () => {
      if (lastInputEventValue.trim() === 'NEWCODE88') {
        feedbackEl.textContent = '成功新增優惠券！';
      }
    };
    startBtn.click();
    await controller.waitForIdle();

    assert.deepEqual(submittedCodes, ['NEWCODE88']);

    // Enabling Force Retry should re-run all queued codes
    submittedCodes.length = 0;
    const forceRetryCheckbox = shadow.querySelector<HTMLInputElement>(
      '[data-role="force-retry-checkbox"]',
    )!;
    forceRetryCheckbox.checked = true;
    forceRetryCheckbox.dispatchEvent(new Event('change', { bubbles: true }));

    controller.setQueue(['天天省天天爽', 'PANDA100']);
    startBtn.click();
    await controller.waitForIdle();

    assert.deepEqual(submittedCodes, ['天天省天天爽', 'PANDA100']);

    // Anti-bot challenge detection pauses immediately without submitting remaining codes
    submittedCodes.length = 0;
    const challengeBanner = document.createElement('div');
    challengeBanner.id = 'px-captcha';
    challengeBanner.textContent = 'Press & Hold to confirm you are a human';
    document.body.appendChild(challengeBanner);

    controller.setQueue(['CODE_A', 'CODE_B']);
    startBtn.click();
    await controller.waitForIdle();

    assert.deepEqual(submittedCodes, []);
    assert.match(
      shadow.querySelector('[data-role="run-status"]')?.textContent ?? '',
      /已暫停/,
    );

    // After user manually clears the anti-bot challenge and clicks Resume, remaining queue runs
    challengeBanner.remove();
    applyBtn.onclick = () => {
      feedbackEl.textContent = '成功新增優惠券！';
    };
    const resumeBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="resume-run-btn"]',
    )!;
    resumeBtn.click();
    await controller.waitForIdle();

    assert.deepEqual(submittedCodes, ['CODE_A', 'CODE_B']);
    assert.equal(
      shadow
        .querySelector('[data-wallet-code="CODE_A"]')
        ?.getAttribute('data-coupon-status'),
      'claimed',
    );
  });

  it('supports Uber Eats platform namespace isolation and auto-navigates from non-wallet pages to resume a queued Redemption Run', async () => {
    // 1. Pre-record a coupon on foodpanda to verify platform isolation
    installFakeDom('https://www.foodpanda.com.tw/vouchers');
    document.body.innerHTML = `
      <input data-testid="voucher-input" value="" />
      <button data-testid="voucher-apply-btn" type="button">套用</button>
      <div data-testid="voucher-feedback">成功新增優惠券！</div>
    `;
    const fpController = mountAutoCoupon({
      url: 'https://www.foodpanda.com.tw/vouchers',
      delayMs: () => 5,
      autoSyncFeed: false,
    });
    fpController.setQueue(['SHARED_PROMO']);
    document
      .querySelector('#auto-coupon-root')!
      .shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-role="start-run-btn"]',
      )!
      .click();
    await fpController.waitForIdle();

    // 2. User is now on Uber Eats homepage (non-wallet page) with the same storage
    window.location.href = 'https://www.ubereats.com/tw';
    document.body.innerHTML = `<div id="ubereats-home">Uber Eats 首頁</div>`;

    let navigatedToUrl = '';
    const ueHomeController = mountAutoCoupon({
      url: 'https://www.ubereats.com/tw',
      delayMs: () => 5,
      autoSyncFeed: false,
      navigate: (targetUrl) => {
        navigatedToUrl = targetUrl;
      },
    });

    assert.equal(ueHomeController.platform.id, 'ubereats');
    ueHomeController.setQueue(['SHARED_PROMO', 'UBER_ONLY_50']);

    const homeShadow =
      document.querySelector('#auto-coupon-root')!.shadowRoot!;
    homeShadow
      .querySelector<HTMLButtonElement>('[data-role="start-run-btn"]')!
      .click();
    await ueHomeController.waitForIdle();

    // Should have navigated to the Uber Eats offers hub (promos) URL instead of failing
    assert.equal(
      navigatedToUrl,
      'https://www.ubereats.com/tw/feeds/offershub?mod=promos&ps=1',
    );

    // 3. Simulate page load on the Uber Eats promotions wallet URL; it should auto-resume!
    window.location.href = navigatedToUrl;
    document.body.innerHTML = `
      <section data-testid="promotions-page">
        <input data-testid="promo-code-input" placeholder="輸入優惠序號" value="" />
        <button data-testid="promo-apply-button" type="button">套用</button>
        <div data-testid="promo-status-message"></div>
      </section>
    `;

    const ueInput = document.querySelector<HTMLInputElement>(
      '[data-testid="promo-code-input"]',
    )!;
    const ueApply = document.querySelector<HTMLButtonElement>(
      '[data-testid="promo-apply-button"]',
    )!;
    const ueStatus = document.querySelector<HTMLElement>(
      '[data-testid="promo-status-message"]',
    )!;

    const ueSubmitted: string[] = [];
    let ueCurrentInput = '';
    ueInput.addEventListener('input', () => {
      ueCurrentInput = ueInput.value;
    });
    ueApply.addEventListener('click', () => {
      const code = ueCurrentInput.trim();
      ueSubmitted.push(code);
      if (code === 'SHARED_PROMO') {
        ueStatus.textContent = '已成功套用優惠序號';
      } else if (code === 'UBER_ONLY_50') {
        ueStatus.textContent = '此優惠序號已領取過';
      }
    });

    const ueWalletController = mountAutoCoupon({
      url: navigatedToUrl,
      delayMs: () => 5,
      autoSyncFeed: false,
    });
    await ueWalletController.waitForIdle();

    // SHARED_PROMO was only recorded on foodpanda, so both codes must run on Uber Eats!
    assert.deepEqual(ueSubmitted, ['SHARED_PROMO', 'UBER_ONLY_50']);

    const ueShadow =
      document.querySelector('#auto-coupon-root')!.shadowRoot!;
    const ueSummary =
      ueShadow.querySelector('[data-role="run-summary"]')?.textContent ?? '';
    assert.match(ueSummary, /成功:\s*1/);
    assert.match(ueSummary, /已領過:\s*1/);
  });

  it('syncs remote Coupon Feed, filters expired coupons, separates Wallet Coupons from Checkout Coupons with one-tap copy, and parses freeform Chinese/alphanumeric text into interactive Candidate Chips', async () => {
    const { clipboardWrites } = installFakeDom(
      'https://www.foodpanda.com.tw/vouchers',
    );
    document.body.innerHTML = `
      <main id="foodpanda-vouchers-page">
        <input data-testid="voucher-input" value="" />
        <button data-testid="voucher-apply-btn" type="button">套用</button>
        <div data-testid="voucher-feedback">成功新增優惠券！</div>
      </main>
    `;

    const inputEl = document.querySelector<HTMLInputElement>(
      '[data-testid="voucher-input"]',
    )!;
    const applyBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="voucher-apply-btn"]',
    )!;

    const submittedCodes: string[] = [];
    let currentInputVal = '';
    inputEl.addEventListener('input', () => {
      currentInputVal = inputEl.value;
    });
    applyBtn.addEventListener('click', () => {
      submittedCodes.push(currentInputVal.trim());
    });

    const mockFeed = {
      updatedAt: '2026-11-12T00:00:00Z',
      coupons: [
        {
          code: '十一月熊貓',
          platform: 'foodpanda',
          title: '全平台滿 $299 折 $50',
          category: 'wallet',
          expiresAt: '2099-12-31',
          updatedAt: '2026-11-12T00:00:00Z',
        },
        {
          code: 'EXPIRED_OLD',
          platform: 'foodpanda',
          title: '已過期優惠券',
          category: 'wallet',
          expiresAt: '2020-01-01',
          updatedAt: '2026-11-12T00:00:00Z',
        },
        {
          code: 'CTBC2026',
          platform: 'foodpanda',
          title: '中國信託信用卡結帳滿 $300 折 $60',
          category: 'checkout_only',
          expiresAt: '2099-12-31',
          updatedAt: '2026-11-12T00:00:00Z',
        },
        {
          code: 'UBER_FEED_CODE',
          platform: 'ubereats',
          title: 'Uber Eats 專屬券',
          category: 'wallet',
          expiresAt: '2099-12-31',
          updatedAt: '2026-11-12T00:00:00Z',
        },
      ],
    };

    const controller = mountAutoCoupon({
      url: 'https://www.foodpanda.com.tw/vouchers',
      delayMs: () => 5,
      autoSyncFeed: true,
      fetchFeed: async () => mockFeed,
    });

    await controller.waitForIdle();

    const shadow = document.querySelector('#auto-coupon-root')!.shadowRoot!;

    // Only 1 active, non-expired foodpanda Wallet Coupon ('十一月熊貓') should count toward the badge
    const badge = shadow.querySelector('[data-role="pill-badge"]')!;
    assert.equal(badge.textContent, '1');

    // Checkout Coupon ('CTBC2026') is rendered in the checkout-only copy section and supports one-tap copy
    const checkoutList = shadow.querySelector(
      '[data-role="checkout-coupon-list"]',
    )!;
    assert.ok(checkoutList, 'Expected checkout-coupon-list section');
    assert.match(checkoutList.textContent, /CTBC2026/);

    const copyBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-copy-code="CTBC2026"]',
    )!;
    assert.ok(copyBtn, 'Expected one-tap copy button for CTBC2026');
    copyBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(clipboardWrites, ['CTBC2026']);
    assert.match(copyBtn.textContent, /已複製/);

    // Paste freeform promotional text with Chinese & alphanumeric codes + noise
    const freeformInput = shadow.querySelector<HTMLInputElement>(
      '[data-role="freeform-input"]',
    )!;
    const parseBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="parse-text-btn"]',
    )!;

    freeformInput.value = `
      🔥 本週熊貓隱藏優惠整理！滿499折100超划算：
      1. 生鮮雜貨輸入【天天省天天爽】享85折優惠
      2. 美食外送優惠碼：PANDA888 滿$299折$50
      3. 下午茶輸入「週三買熊貓」免外送費
    `;
    freeformInput.dispatchEvent(new Event('input', { bubbles: true }));
    parseBtn.click();

    const chipElements = shadow.querySelectorAll('[data-role="candidate-chip"]');
    const chipCodes = chipElements.map((el) => el.getAttribute('data-code'));
    assert.deepEqual(chipCodes, ['天天省天天爽', 'PANDA888', '週三買熊貓']);

    // Deselect 'PANDA888' chip before starting Redemption Run
    const panda888Chip = shadow.querySelector<HTMLElement>(
      '[data-code="PANDA888"]',
    )!;
    panda888Chip.click();
    assert.equal(panda888Chip.getAttribute('data-selected'), 'false');

    // Start Redemption Run: should run synced Wallet Coupon ('十一月熊貓') + selected Candidate Chips ('天天省天天爽', '週三買熊貓'), excluding 'PANDA888', 'CTBC2026', and 'EXPIRED_OLD'
    const startBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="start-run-btn"]',
    )!;
    startBtn.click();
    await controller.waitForIdle();

    assert.deepEqual(submittedCodes, ['十一月熊貓', '天天省天天爽', '週三買熊貓']);
  });

  it('ignores dormant #px-captcha and script text on foodpanda, and auto-clicks Uber Eats 新增優惠序號 button to reveal the promo input modal', async () => {
    // 1. foodpanda page with dormant empty #px-captcha and <script> containing 請先登入
    installFakeDom('https://www.foodpanda.com.tw/vouchers');
    document.body.innerHTML = `
      <script>window.__I18N__ = {"login": "請先登入", "human": "請證明您是人類"};</script>
      <div id="px-captcha" style="display: none;"></div>
      <div data-testid="voucher-box">
        <label>輸入優惠碼</label>
        <input type="text" value="" />
        <button type="button">套用</button>
      </div>
      <div role="alert">成功新增優惠券！</div>
    `;

    const fpSubmitted: string[] = [];
    const fpInput = document.querySelector<HTMLInputElement>('input')!;
    const fpBtn = document.querySelector<HTMLButtonElement>('button')!;
    fpBtn.addEventListener('click', () => {
      fpSubmitted.push(fpInput.value.trim());
    });

    const fpController = mountAutoCoupon({
      url: 'https://www.foodpanda.com.tw/vouchers',
      delayMs: () => 5,
      autoSyncFeed: false,
    });
    fpController.setQueue(['週二星享日']);
    document
      .querySelector('#auto-coupon-root')!
      .shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-role="start-run-btn"]',
      )!
      .click();
    await fpController.waitForIdle();

    assert.deepEqual(fpSubmitted, ['週二星享日']);

    // 2. Uber Eats page where input only mounts after clicking "新增優惠序號" button
    installFakeDom('https://www.ubereats.com/tw');
    document.body.innerHTML = `
      <div id="ue-account-panel">
        <button id="open-promo-modal-btn" type="button">新增優惠序號</button>
      </div>
    `;

    const ueSubmitted: string[] = [];
    document
      .querySelector('#open-promo-modal-btn')!
      .addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = `
          <input type="text" value="" />
          <button id="ue-modal-submit" type="button">套用</button>
          <div role="alert">已成功套用優惠序號</div>
        `;
        document.body.appendChild(dialog);
        const modalInput = dialog.querySelector<HTMLInputElement>('input')!;
        const modalSubmit =
          dialog.querySelector<HTMLButtonElement>('#ue-modal-submit')!;
        modalSubmit.addEventListener('click', () => {
          ueSubmitted.push(modalInput.value.trim());
        });
      });

    const ueController = mountAutoCoupon({
      url: 'https://www.ubereats.com/tw',
      delayMs: () => 5,
      autoSyncFeed: false,
    });
    ueController.setQueue(['581享受']);
    document
      .querySelector('#auto-coupon-root')!
      .shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-role="start-run-btn"]',
      )!
      .click();
    await ueController.waitForIdle();

    assert.deepEqual(ueSubmitted, ['581享受']);
  });

  it('redeems on Uber Eats when promo input is inside a deeply nested BaseWeb modal below a header search input and submit button is 6 levels up', async () => {
    installFakeDom('https://www.ubereats.com/tw');
    document.body.innerHTML = `
      <header>
        <input id="header-search" type="text" placeholder="搜尋 Uber Eats" value="" />
      </header>
      <div data-baseweb="modal">
        <div class="l1">
          <div class="l2">
            <h3>優惠序號</h3>
            <div class="l3">
              <div class="l4">
                <div class="l5">
                  <div class="l6">
                    <input id="deep-promo-input" type="text" value="" />
                  </div>
                </div>
              </div>
            </div>
            <button id="deep-close-btn" type="button" aria-label="關閉">✕</button>
            <button id="deep-add-btn" type="button" disabled>新增</button>
          </div>
        </div>
        <div id="deep-toast" role="alert"></div>
      </div>
    `;

    const deepInput = document.querySelector<HTMLInputElement>('#deep-promo-input')!;
    const deepAddBtn = document.querySelector<HTMLButtonElement>('#deep-add-btn')!;
    const deepToast = document.querySelector<HTMLElement>('#deep-toast')!;
    const submitted: string[] = [];

    deepInput.addEventListener('input', () => {
      if (deepInput.value.trim().length > 0) {
        deepAddBtn.removeAttribute('disabled');
      }
    });
    deepAddBtn.addEventListener('click', () => {
      submitted.push(deepInput.value.trim());
      deepToast.textContent = '已成功套用優惠序號';
    });

    const controller = mountAutoCoupon({
      url: 'https://www.ubereats.com/tw',
      delayMs: () => 5,
      autoSyncFeed: false,
    });
    controller.setQueue(['會員雙享']);

    document
      .querySelector('#auto-coupon-root')!
      .shadowRoot!.querySelector<HTMLButtonElement>('[data-role="start-run-btn"]')!
      .click();
    await controller.waitForIdle();

    assert.deepEqual(submitted, ['會員雙享']);
    const headerSearch = document.querySelector<HTMLInputElement>('#header-search')!;
    assert.equal(headerSearch.value, '');
  });

  it('redeems a valid foodpanda coupon when React controlled input uses _valueTracker and /vouchers page body has 已過期 tab and voucher cards', async () => {
    installFakeDom('https://www.foodpanda.com.tw/vouchers');
    document.body.innerHTML = `
      <main id="foodpanda-vouchers-page">
        <nav class="voucher-tabs">
          <button type="button">可使用 (1)</button>
          <button type="button">已使用 / 已過期</button>
        </nav>
        <section class="voucher-box">
          <input data-testid="voucher-input" placeholder="輸入優惠碼" value="" />
          <button data-testid="voucher-apply-btn" type="button" disabled="true">套用</button>
        </section>
        <section data-testid="voucher-list">
          <article class="voucher-card">現有優惠券：滿 $200 折 $30（不適用於指定店家，過期無效）</article>
        </section>
      </main>
    `;

    const inputEl = document.querySelector<HTMLInputElement>(
      '[data-testid="voucher-input"]',
    )!;
    const applyBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="voucher-apply-btn"]',
    )!;
    const voucherList = document.querySelector<HTMLElement>(
      '[data-testid="voucher-list"]',
    )!;

    let domValue = '';
    let trackerValue = '';
    let reactStateCode = '';
    Object.defineProperty(Object.getPrototypeOf(inputEl), 'value', {
      configurable: true,
      get() {
        return domValue;
      },
      set(v: string) {
        domValue = String(v ?? '');
      },
    });
    Object.defineProperty(inputEl, 'value', {
      configurable: true,
      get() {
        return domValue;
      },
      set(v: string) {
        domValue = String(v ?? '');
        trackerValue = domValue;
      },
    });
    (
      inputEl as unknown as {
        _valueTracker: { getValue(): string; setValue(v: string): void };
      }
    )._valueTracker = {
      getValue() {
        return trackerValue;
      },
      setValue(v: string) {
        trackerValue = String(v ?? '');
      },
    };

    inputEl.addEventListener('input', () => {
      if (trackerValue !== domValue) {
        trackerValue = domValue;
        reactStateCode = domValue;
        applyBtn.disabled = reactStateCode.trim().length === 0;
        if (!applyBtn.disabled) {
          applyBtn.removeAttribute('disabled');
        }
      }
    });

    applyBtn.addEventListener('click', () => {
      if (applyBtn.disabled) return;
      const submitted = reactStateCode.trim();
      if (submitted === '天天省天天爽') {
        setTimeout(() => {
          const newCard = document.createElement('article');
          newCard.setAttribute('class', 'voucher-card');
          newCard.innerHTML =
            '<svg class="fp-icon"><path d="M0 0"></path></svg><span>天天省天天爽 — 美食外送滿額折扣優惠（不適用於部分指定餐廳，逾期過期無效）</span>';
          voucherList.appendChild(newCard);
        }, 30);
      } else if (submitted === '週二星享日') {
        // Simulate 200 OK JSON API response whose voucher terms contain "不適用於" and "過期無效"
        recordNetworkFeedbackText(
          JSON.stringify({
            status_code: 200,
            data: {
              id: 'v-999',
              code: '週二星享日',
              title: '週二星巴克滿額現折 $70',
              description: '本優惠券不適用於特定門市，逾期過期無效',
              status: 'ACTIVE',
            },
          }),
          200,
        );
      }
    });

    // Seed v1 storage with a false-negative invalid_or_expired record from v1.0.0
    localStorage.setItem(
      'auto_coupon:v1:records:foodpanda',
      JSON.stringify({
        天天省天天爽: {
          code: '天天省天天爽',
          platform: 'foodpanda',
          outcome: 'invalid_or_expired',
          message: '此優惠碼無效、已過期或不符合資格',
          attemptedAt: '2026-11-12T00:00:00.000Z',
        },
      }),
    );

    const controller = mountAutoCoupon({
      url: 'https://www.foodpanda.com.tw/vouchers',
      delayMs: () => 10,
      autoSyncFeed: false,
    });

    controller.setQueue(['天天省天天爽', '週二星享日']);
    const shadow = document.querySelector('#auto-coupon-root')!.shadowRoot!;
    shadow
      .querySelector<HTMLButtonElement>('[data-role="start-run-btn"]')!
      .click();
    await controller.waitForIdle();

    const statusAttr1 = shadow
      .querySelector('[data-wallet-code="天天省天天爽"]')
      ?.getAttribute('data-coupon-status');
    const statusAttr2 = shadow
      .querySelector('[data-wallet-code="週二星享日"]')
      ?.getAttribute('data-coupon-status');
    assert.equal(statusAttr1, 'claimed');
    assert.equal(statusAttr2, 'claimed');
  });

  it('mounts and preserves the floating pill on Uber Eats under frozen XHR prototype, Trusted Types CSP, React hydration body wipe, and header search input', async () => {
    const env = installFakeDom('https://www.ubereats.com/tw');
    env.document.body.innerHTML = `
      <header>
        <input id="ue-header-search" type="text" role="combobox" placeholder="搜尋 Uber Eats" value="" />
      </header>
    `;

    // 1. Freeze XMLHttpRequest.prototype and block ShadowRoot.prototype.innerHTML (Trusted Types CSP)
    const FrozenXHR = function () {};
    FrozenXHR.prototype = Object.freeze({
      open() {},
      send() {},
    });
    Object.defineProperty(env.window, 'XMLHttpRequest', {
      value: FrozenXHR,
      writable: false,
      configurable: true,
    });
    Object.defineProperty(FakeShadowRoot.prototype, 'innerHTML', {
      set() {
        throw new TypeError(
          "Failed to set the 'innerHTML' property on 'ShadowRoot': This document requires 'TrustedHTML' assignment.",
        );
      },
      configurable: true,
    });

    try {
      const controller = mountAutoCoupon({
        url: 'https://www.ubereats.com/tw',
        autoSyncFeed: false,
      });

      const pillBefore = env.document
        .querySelector('#auto-coupon-root')
        ?.shadowRoot?.querySelector('[data-role="floating-pill"]');
      assert.ok(pillBefore, 'Floating pill should mount under Trusted Types CSP and frozen XHR');

      // 2. Header search input ("搜尋 Uber Eats") must not cause Uber Eats homepage to be detected as wallet page
      assert.equal(
        controller.platform.isWalletPage('https://www.ubereats.com/tw', env.document),
        false,
      );

      // 3. Simulate Uber Eats React/Fusion SSR hydration wiping document.body children
      env.document.body.innerHTML = '<div id="root"><main>Uber Eats Hydrated</main></div>';
      await new Promise((resolve) => setTimeout(resolve, 120));

      const pillAfter = env.document
        .querySelector('#auto-coupon-root')
        ?.shadowRoot?.querySelector('[data-role="floating-pill"]');
      assert.ok(
        pillAfter,
        'Floating pill should automatically re-attach after Uber Eats hydration replaces body children',
      );
    } finally {
      delete (FakeShadowRoot.prototype as unknown as { innerHTML?: unknown }).innerHTML;
    }
  });

  it('applies top-layer stacking context styles to #auto-coupon-root, defends against cross-origin iframes, and styles pill for Uber Eats', async () => {
    const env = installFakeDom('https://www.ubereats.com/tw');
    env.document.body.innerHTML = `
      <div id="app-root">
        <!-- Uber Eats overlays and fixed elements with z-indexes -->
        <div style="position: fixed; z-index: 200; width: 100%; height: 100%;">Overlay</div>
        <iframe></iframe>
      </div>
    `;

    // Simulate cross-origin iframe throwing SecurityError on contentDocument access
    const frame = env.document.querySelector<HTMLElement>('iframe')!;
    Object.defineProperty(frame, 'contentDocument', {
      get() {
        throw new Error('SecurityError: Blocked a frame with origin from accessing a cross-origin frame.');
      },
      configurable: true,
    });

    const controller = mountAutoCoupon({
      url: 'https://www.ubereats.com/tw',
      autoSyncFeed: false,
    });

    const host = env.document.querySelector<HTMLElement>('#auto-coupon-root');
    assert.ok(host, 'Expected #auto-coupon-root host to be mounted');

    // Verify host has Light DOM styles with clean static layout (no transform containing-block traps)
    const hostStyle = host.getAttribute('style') ?? host.style.cssText ?? '';
    assert.ok(hostStyle.includes('position: static'), 'Host must have position: static to avoid containing block trap');

    // Verify floating pill inside shadow root
    const pill = host.shadowRoot?.querySelector<HTMLButtonElement>('[data-role="floating-pill"]');
    assert.ok(pill, 'Expected floating pill inside shadowRoot');

    // Verify Uber Eats brand styling
    assert.ok(
      pill.style.background?.includes('#06C167') || pill.style.background?.includes('rgb(6, 193, 103)'),
      'Pill should have Uber Eats green brand color on Uber Eats',
    );

    // Verify safe handling of cross-origin iframe in findInputAndSubmit
    const { input, submit } = controller.platform.findInputAndSubmit(env.document);
    assert.equal(input, null);
    assert.equal(submit, null);
  });

  it('supports 3-tab navigation, renders history records with expandable accordion diagnostics, allows single reset and clear-all with confirm prompt', async () => {
    clearRedemptionRecords('foodpanda');
    saveRedemptionRecord(
      'foodpanda',
      'COUPON_CLAIMED',
      'claimed',
      '成功領取優惠券',
    );
    saveRedemptionRecord(
      'foodpanda',
      'COUPON_ALREADY',
      'already_claimed',
      '此優惠碼已存在於優惠券匣',
    );
    saveRedemptionRecord(
      'foodpanda',
      'COUPON_INVALID',
      'invalid_or_expired',
      '優惠碼無效或已過期',
    );

    const controller = mountAutoCoupon({
      url: 'https://www.foodpanda.com.tw/vouchers',
      autoSyncFeed: false,
    });

    const host = document.querySelector('#auto-coupon-root');
    assert.ok(host, 'Expected #auto-coupon-root');
    const shadow = host.shadowRoot!;

    // Open sheet
    const pill = shadow.querySelector<HTMLButtonElement>(
      '[data-role="floating-pill"]',
    )!;
    pill.click();

    // Verify Tab buttons exist
    const tabQueueBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="tab-queue"]',
    );
    const tabHistoryBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="tab-history"]',
    );
    const tabCheckoutBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="tab-checkout"]',
    );
    assert.ok(tabQueueBtn, 'Queue tab button should exist');
    assert.ok(tabHistoryBtn, 'History tab button should exist');
    assert.ok(tabCheckoutBtn, 'Checkout tab button should exist');

    // Default active tab is queue
    assert.equal(tabQueueBtn.getAttribute('data-active'), 'true');
    assert.equal(tabHistoryBtn.getAttribute('data-active'), 'false');

    const historyBadge = shadow.querySelector<HTMLElement>(
      '[data-role="history-badge"]',
    );
    assert.ok(historyBadge, 'History badge should exist');
    assert.equal(historyBadge.textContent, '3');

    // Switch to history tab
    tabHistoryBtn.click();
    assert.equal(tabHistoryBtn.getAttribute('data-active'), 'true');
    assert.equal(tabQueueBtn.getAttribute('data-active'), 'false');

    const historyPanel = shadow.querySelector<HTMLElement>(
      '[data-panel="history"]',
    );
    assert.ok(historyPanel, 'History panel should exist');
    assert.equal(historyPanel.getAttribute('data-active'), 'true');

    // Verify 3 accordion items rendered
    const historyItems = shadow.querySelectorAll<HTMLElement>(
      '[data-role="history-item"]',
    );
    assert.equal(historyItems.length, 3);

    // Test expanding accordion card for invalid coupon
    const invalidCard = Array.from(historyItems).find(
      (el) => el.getAttribute('data-code') === 'COUPON_INVALID',
    );
    assert.ok(invalidCard, 'Invalid coupon card should be present');
    assert.equal(invalidCard.getAttribute('data-expanded'), 'false');

    const toggle = invalidCard.querySelector<HTMLElement>(
      '[data-role="accordion-toggle"]',
    )!;
    toggle.click();
    assert.equal(invalidCard.getAttribute('data-expanded'), 'true');

    const body = invalidCard.querySelector<HTMLElement>(
      '[data-role="accordion-body"]',
    )!;
    assert.ok(
      body.textContent?.includes('優惠碼無效或已過期'),
      'Accordion body should display error message',
    );

    // Test filter chips
    const claimedFilter = shadow.querySelector<HTMLButtonElement>(
      '[data-role="history-filter-claimed"]',
    )!;
    claimedFilter.click();
    let currentCards = shadow.querySelectorAll<HTMLElement>(
      '[data-role="history-item"]',
    );
    assert.equal(currentCards.length, 1);
    assert.equal(currentCards[0]?.getAttribute('data-code'), 'COUPON_CLAIMED');

    // Reset filter to all
    const allFilter = shadow.querySelector<HTMLButtonElement>(
      '[data-role="history-filter-all"]',
    )!;
    allFilter.click();
    currentCards = shadow.querySelectorAll<HTMLElement>(
      '[data-role="history-item"]',
    );
    assert.equal(currentCards.length, 3);

    // Test single item reset
    const resetBtn = invalidCard.querySelector<HTMLButtonElement>(
      '[data-action="reset-history-code"][data-code="COUPON_INVALID"]',
    )!;
    resetBtn.click();

    // Verify storage record deleted
    const recordsAfterReset = loadRedemptionRecords('foodpanda');
    assert.equal(recordsAfterReset['COUPON_INVALID'], undefined);
    assert.equal(historyBadge.textContent, '2');

    // Test clear all with confirm dialog
    let confirmCalled = false;
    const testConfirm = (msg: string) => {
      confirmCalled = true;
      assert.ok(msg.includes('清空此平台的所有歷史領取紀錄'));
      return true;
    };
    (window as unknown as { confirm: (msg: string) => boolean }).confirm = testConfirm;
    (globalThis as unknown as { confirm: (msg: string) => boolean }).confirm = testConfirm;

    const clearBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="clear-history-btn"]',
    )!;
    clearBtn.click();
    assert.ok(confirmCalled, 'window.confirm should have been prompted');

    const recordsAfterClear = loadRedemptionRecords('foodpanda');
    assert.deepEqual(recordsAfterClear, {});
    assert.equal(historyBadge.textContent, '0');

    // Verify empty notice rendered
    const listEl = shadow.querySelector<HTMLElement>(
      '[data-role="history-coupon-list"]',
    )!;
    assert.ok(
      listEl.textContent?.includes('尚無符合條件的領取紀錄'),
      'Should display empty notice when history is cleared',
    );

    // Switch to checkout tab
    tabCheckoutBtn.click();
    assert.equal(tabCheckoutBtn.getAttribute('data-active'), 'true');
    const checkoutPanel = shadow.querySelector<HTMLElement>(
      '[data-panel="checkout"]',
    )!;
    assert.equal(checkoutPanel.getAttribute('data-active'), 'true');
  });

  it('detects Uber Eats TooManyRequests rate limits via network status 429 and DOM text, pauses the run without poisoning history, and offers cooldown countdown and speed selection', async () => {
    installFakeDom('https://www.ubereats.com/tw/feeds/offershub?mod=promos&ps=1');
    clearRedemptionRecords('ubereats');

    // 1. Verify default speed mode
    assert.equal(loadSpeedMode('ubereats'), 'safe');
    assert.equal(loadSpeedMode('foodpanda'), 'standard');

    // 2. Setup Uber Eats promotions DOM
    document.body.innerHTML = `
      <section data-testid="promotions-page">
        <input data-testid="promo-code-input" placeholder="輸入優惠序號" value="" />
        <button data-testid="promo-apply-button" type="button">套用</button>
        <div data-testid="promo-status-message"></div>
      </section>
    `;

    const promoInput = document.querySelector<HTMLInputElement>(
      '[data-testid="promo-code-input"]',
    )!;
    const promoApply = document.querySelector<HTMLButtonElement>(
      '[data-testid="promo-apply-button"]',
    )!;
    const promoStatus = document.querySelector<HTMLElement>(
      '[data-testid="promo-status-message"]',
    )!;

    const submittedCodes: string[] = [];
    let currentInputVal = '';
    promoInput.addEventListener('input', () => {
      currentInputVal = promoInput.value;
    });

    let mockRateLimitActive = true;
    promoApply.addEventListener('click', () => {
      const code = currentInputVal.trim();
      submittedCodes.push(code);
      if (code === 'UBER_VALID_1') {
        promoStatus.textContent = '已成功套用優惠序號';
      } else if (code === 'UBER_TOO_FAST') {
        if (mockRateLimitActive) {
          // Simulate Uber Eats 429 rate limit payload
          recordNetworkFeedbackText(
            JSON.stringify({ error: 'TooManyRequests', status_code: 429 }),
            429,
          );
          promoStatus.textContent = 'TooManyRequests';
        } else {
          promoStatus.textContent = '已成功套用優惠序號';
        }
      } else if (code === 'UBER_PENDING_3') {
        promoStatus.textContent = '已成功套用優惠序號';
      }
    });

    const controller = mountAutoCoupon({
      url: 'https://www.ubereats.com/tw/feeds/offershub?mod=promos&ps=1',
      delayMs: () => 5,
      autoSyncFeed: false,
    });
    controller.setQueue(['UBER_VALID_1', 'UBER_TOO_FAST', 'UBER_PENDING_3']);

    const shadow = document.querySelector('#auto-coupon-root')!.shadowRoot!;

    // Verify speed mode dropdown in Shadow DOM
    const speedSelect = shadow.querySelector<HTMLSelectElement>(
      '[data-role="speed-mode-select"]',
    )!;
    assert.ok(speedSelect, 'Speed mode select must be present in queue panel');
    assert.equal(speedSelect.value, 'safe');

    // Test changing speed mode
    speedSelect.value = 'standard';
    speedSelect.dispatchEvent(new Event('change'));
    assert.equal(loadSpeedMode('ubereats'), 'standard');

    // Restore to safe
    speedSelect.value = 'safe';
    speedSelect.dispatchEvent(new Event('change'));
    assert.equal(loadSpeedMode('ubereats'), 'safe');

    // Click start run
    const startBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="start-run-btn"]',
    )!;
    startBtn.click();
    await controller.waitForIdle();

    // Verify only the first code was submitted before rate limit halted the run
    assert.deepEqual(submittedCodes, ['UBER_VALID_1', 'UBER_TOO_FAST']);

    // Check storage records: UBER_VALID_1 recorded, but UBER_TOO_FAST must NOT be recorded as invalid!
    const records = loadRedemptionRecords('ubereats');
    assert.ok(records['UBER_VALID_1']);
    assert.equal(records['UBER_VALID_1']!.outcome, 'claimed');
    assert.equal(
      records['UBER_TOO_FAST'],
      undefined,
      'Rate-limited coupon must not be recorded in storage as invalid_or_expired',
    );

    // Summary counters: invalid_or_expired must be 0
    const summaryText =
      shadow.querySelector('[data-role="run-summary"]')?.textContent ?? '';
    assert.match(summaryText, /成功:\s*1/);
    assert.match(summaryText, /無效\/過期:\s*0/);

    // Status message should indicate rate limit pause and cooldown countdown
    const statusText =
      shadow.querySelector('[data-role="run-status"]')?.textContent ?? '';
    assert.ok(
      statusText.includes('TooManyRequests') && statusText.includes('建議冷卻'),
      `Status indicator should display rate limit warning. Got: ${statusText}`,
    );

    // Check wallet list: UBER_TOO_FAST and UBER_PENDING_3 should remain pending
    const remainingRow = shadow.querySelector(
      '[data-wallet-code="UBER_TOO_FAST"]',
    );
    assert.equal(remainingRow?.getAttribute('data-coupon-status'), 'pending');

    // Now simulate user waiting / clicking resume after cooldown
    mockRateLimitActive = false;
    const resumeBtn = shadow.querySelector<HTMLButtonElement>(
      '[data-role="resume-run-btn"]',
    )!;
    resumeBtn.click();
    await controller.waitForIdle();

    // All 3 codes must have been submitted successfully now
    assert.deepEqual(submittedCodes, [
      'UBER_VALID_1',
      'UBER_TOO_FAST',
      'UBER_TOO_FAST',
      'UBER_PENDING_3',
    ]);

    const finalRecords = loadRedemptionRecords('ubereats');
    assert.equal(finalRecords['UBER_VALID_1']?.outcome, 'claimed');
    assert.equal(finalRecords['UBER_TOO_FAST']?.outcome, 'claimed');
    assert.equal(finalRecords['UBER_PENDING_3']?.outcome, 'claimed');
  });

  it('cleanses historic false-negative invalid_or_expired records caused by TooManyRequests on load', () => {
    installFakeDom('https://www.ubereats.com/tw/feeds/offershub?mod=promos&ps=1');
    clearRedemptionRecords('ubereats');

    saveRedemptionRecord('ubereats', 'REAL_CLAIMED', 'claimed', '成功領取');
    saveRedemptionRecord(
      'ubereats',
      'POISONED_CODE_1',
      'invalid_or_expired',
      'TooManyRequests',
    );
    saveRedemptionRecord(
      'ubereats',
      'POISONED_CODE_2',
      'invalid_or_expired',
      '嘗試次數過多，請稍後再試 (HTTP 429)',
    );
    saveRedemptionRecord(
      'ubereats',
      'LEGIT_EXPIRED',
      'invalid_or_expired',
      '此優惠券已失效或已兌換完畢',
    );

    const loaded = loadRedemptionRecords('ubereats');
    assert.equal(loaded['REAL_CLAIMED']?.outcome, 'claimed');
    assert.equal(loaded['LEGIT_EXPIRED']?.outcome, 'invalid_or_expired');
    assert.equal(
      loaded['POISONED_CODE_1'],
      undefined,
      'POISONED_CODE_1 should have been cleansed on load',
    );
    assert.equal(
      loaded['POISONED_CODE_2'],
      undefined,
      'POISONED_CODE_2 should have been cleansed on load',
    );
  });
});

describe('Seam 1b: Uber Eats offers hub navigation', () => {
  const OFFERS_HUB_URL =
    'https://www.ubereats.com/tw/feeds/offershub?mod=promos&ps=1';

  it('recognises only the offers hub as the Uber Eats wallet page', () => {
    const env = installFakeDom('https://www.ubereats.com/tw');
    document.body.innerHTML = '<div id="home">Uber Eats 首頁</div>';

    assert.equal(uberEatsAdapter.walletUrl, OFFERS_HUB_URL);
    assert.equal(uberEatsAdapter.isWalletPage(OFFERS_HUB_URL, env.document), true);
    assert.equal(
      uberEatsAdapter.isWalletPage(
        'https://www.ubereats.com/tw/feeds/offershub?mod=promos',
        env.document,
      ),
      true,
    );
    // The legacy guesses and the homepage must not be treated as the wallet page
    for (const url of [
      'https://www.ubereats.com/tw',
      'https://www.ubereats.com/tw/promotions',
      'https://www.ubereats.com/tw/checkout',
      'https://www.ubereats.com/tw/account/wallet',
    ]) {
      assert.equal(uberEatsAdapter.isWalletPage(url, env.document), false, url);
    }
  });

  it('does a full page load to the offers hub even when the homepage has a same-path link', async () => {
    installFakeDom('https://www.ubereats.com/tw');
    clearRedemptionRecords('ubereats');
    document.body.innerHTML = `
      <div id="ubereats-home">
        <a href="/tw/feeds/offershub">優惠</a>
      </div>
    `;
    const navigations: string[] = [];
    const controller = mountAutoCoupon({
      url: 'https://www.ubereats.com/tw',
      delayMs: () => 5,
      autoSyncFeed: false,
      navigate: (targetUrl) => {
        navigations.push(targetUrl);
      },
    });
    controller.setQueue(['UBER_ONLY_50']);
    document
      .querySelector('#auto-coupon-root')!
      .shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-role="start-run-btn"]',
      )!
      .click();
    await controller.waitForIdle();

    assert.deepEqual(navigations, [OFFERS_HUB_URL]);
  });

  it('pauses with a login hint instead of re-navigating when the offers hub has no promo input', async () => {
    installFakeDom('https://www.ubereats.com/tw');
    clearRedemptionRecords('ubereats');
    document.body.innerHTML = '<div id="home">Uber Eats 首頁</div>';
    const firstNavigations: string[] = [];
    const home = mountAutoCoupon({
      url: 'https://www.ubereats.com/tw',
      delayMs: () => 5,
      autoSyncFeed: false,
      navigate: (u) => {
        firstNavigations.push(u);
      },
    });
    home.setQueue(['UBER_ONLY_50']);
    document
      .querySelector('#auto-coupon-root')!
      .shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-role="start-run-btn"]',
      )!
      .click();
    await home.waitForIdle();
    assert.deepEqual(firstNavigations, [OFFERS_HUB_URL]);

    // Page reloaded onto the offers hub but the promo input is missing (e.g. logged out)
    window.location.href = OFFERS_HUB_URL;
    document.body.innerHTML = '<main id="offers-hub-empty">請登入</main>';
    const secondNavigations: string[] = [];
    const hub = mountAutoCoupon({
      url: OFFERS_HUB_URL,
      delayMs: () => 5,
      autoSyncFeed: false,
      navigate: (u) => {
        secondNavigations.push(u);
      },
    });
    await hub.waitForIdle();

    assert.deepEqual(secondNavigations, []);
    const status =
      document
        .querySelector('#auto-coupon-root')!
        .shadowRoot!.querySelector('[data-role="run-status"]')?.textContent ??
      '';
    assert.match(status, /已暫停/);
    assert.match(status, /登入/);
  });
});
