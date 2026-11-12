import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { installFakeDom } from './helpers/fake-dom.ts';
import { mountAutoCoupon } from '../src/userscript/app.ts';

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

    // Should have navigated to Uber Eats promotions wallet URL instead of failing
    assert.match(navigatedToUrl, /ubereats\.com\/tw\/(promotions|wallet)/i);

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
});
