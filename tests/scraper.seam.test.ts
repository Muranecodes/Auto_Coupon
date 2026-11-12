import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CouponFeed } from '../src/shared/types.ts';
import { buildCouponFeed } from '../src/scraper/pipeline.ts';

describe('Seam 2: Coupon Feed Scraper Pipeline (buildCouponFeed)', () => {
  it('extracts Chinese and alphanumeric coupons from Taiwan roundup HTML, classifies wallet vs checkout_only, prunes expired entries, and merges deterministically without timestamp churn', () => {
    const nowIso = '2026-11-12T08:00:00.000Z';

    const foodpandaHtmlFixture = `
      <article class="post-content">
        <h1>2026年11月 foodpanda 優惠碼懶人包</h1>
        <table>
          <tr>
            <td>美食外送滿 $299 折 $50（有效期限至 2026/11/30）</td>
            <td>優惠碼：【十一月省很大】</td>
          </tr>
          <tr>
            <td>生鮮雜貨滿 $499 享 85 折（即日起至 2026-12-15）</td>
            <td>輸入優惠碼：PANDAMART85</td>
          </tr>
          <tr>
            <td>【外送-信用卡優惠】「中信LinePay卡」：舊會員消費滿 260 元現折 20 元（至 2026/11/30）</td>
            <td>優惠碼：CTBC2026</td>
          </tr>
          <tr>
            <td>國泰世華 CUBE 卡專屬結帳輸入優惠碼：CUBE88（至 2026/12/31）</td>
            <td>結帳限定優惠</td>
          </tr>
          <tr>
            <td>【pandapro】訂閱 pandapro 月費制享一個月免費（至 2026/12/31）</td>
            <td>優惠碼：JOIN1</td>
          </tr>
          <tr>
            <td>上個月舊活動（有效期限至 2026/10/31）</td>
            <td>優惠碼：【十月舊熊貓】</td>
          </tr>
        </table>
      </article>
    `;

    const uberEatsHtmlFixture = `
      <article class="entry-content">
        <h2>Uber Eats 11月最新優惠序號彙整</h2>
        <ul>
          <li>外送點餐滿 $350 折 $70，輸入「優步十一月」（期限至 2026/11/28）</li>
          <li>優市生鮮滿 $599 折 $120，優惠序號：UEMART120（期限 11/30）</li>
          <li>優市綁定國泰世華 CUBE 信用卡消費滿 599 元現折 100 元，優惠序號：CUBEBUY（至 2026/12/31）</li>
          <li>玉山銀行結帳限定折 $50，輸入【ESUN50】（至 2026/12/31）</li>
          <li>訂閱 Uber One 年費優惠方案輸入【ONE99】（至 2026/12/31）</li>
        </ul>
      </article>
    `;

    const existingFeed: CouponFeed = {
      updatedAt: '2026-11-10T00:00:00.000Z',
      coupons: [
        {
          code: 'KEEP_ACTIVE',
          platform: 'foodpanda',
          title: '既有未過期優惠券',
          category: 'wallet',
          expiresAt: '2026-11-25',
          updatedAt: '2026-11-10T00:00:00.000Z',
        },
        {
          code: 'RECLASSIFY_BANK_WALLET',
          platform: 'ubereats',
          title: '【外送】玉山卡友輸入折扣碼抽滿額折抵優惠',
          category: 'checkout_only',
          expiresAt: '2026-11-28',
          updatedAt: '2026-11-10T00:00:00.000Z',
        },
        {
          code: 'PRUNE_ME',
          platform: 'ubereats',
          title: '既有已過期優惠券',
          category: 'wallet',
          expiresAt: '2026-11-01',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };

    const feed = buildCouponFeed(
      [
        {
          platform: 'foodpanda',
          url: 'https://example.com/foodpanda-coupons',
          html: foodpandaHtmlFixture,
        },
        {
          platform: 'ubereats',
          url: 'https://example.com/ubereats-coupons',
          html: uberEatsHtmlFixture,
        },
      ],
      existingFeed,
      nowIso,
    );

    const byKey = new Map(
      feed.coupons.map((c) => [`${c.platform}:${c.code}`, c]),
    );

    // Expired coupons from HTML ('十月舊熊貓') and existing feed ('PRUNE_ME') must be pruned
    assert.equal(byKey.has('foodpanda:十月舊熊貓'), false);
    assert.equal(byKey.has('ubereats:PRUNE_ME'), false);

    // Active existing coupon is preserved, and previously over-blocked bank coupon is reclassified to wallet
    assert.equal(byKey.get('foodpanda:KEEP_ACTIVE')?.category, 'wallet');
    assert.equal(
      byKey.get('ubereats:RECLASSIFY_BANK_WALLET')?.category,
      'wallet',
    );
    assert.equal(
      byKey.get('ubereats:RECLASSIFY_BANK_WALLET')?.updatedAt,
      nowIso,
    );

    // Extracted foodpanda wallet coupons (including credit-card promo codes bindable to wallet)
    assert.equal(byKey.get('foodpanda:十一月省很大')?.category, 'wallet');
    assert.equal(
      byKey.get('foodpanda:十一月省很大')?.expiresAt,
      '2026-11-30',
    );
    assert.equal(byKey.get('foodpanda:PANDAMART85')?.category, 'wallet');
    assert.equal(
      byKey.get('foodpanda:PANDAMART85')?.expiresAt,
      '2026-12-15',
    );
    assert.equal(byKey.get('foodpanda:CTBC2026')?.category, 'wallet');

    // Extracted foodpanda explicit checkout-only & subscription coupons
    assert.equal(byKey.get('foodpanda:CUBE88')?.category, 'checkout_only');
    assert.equal(byKey.get('foodpanda:JOIN1')?.category, 'checkout_only');

    // Extracted Uber Eats wallet & checkout_only coupons
    assert.equal(byKey.get('ubereats:優步十一月')?.category, 'wallet');
    assert.equal(byKey.get('ubereats:優步十一月')?.expiresAt, '2026-11-28');
    assert.equal(byKey.get('ubereats:UEMART120')?.category, 'wallet');
    assert.equal(byKey.get('ubereats:UEMART120')?.expiresAt, '2026-11-30');
    assert.equal(byKey.get('ubereats:CUBEBUY')?.category, 'wallet');
    assert.equal(byKey.get('ubereats:ESUN50')?.category, 'checkout_only');
    assert.equal(byKey.get('ubereats:ONE99')?.category, 'checkout_only');

    // Idempotency check: running again with no changes preserves updatedAt without churn
    const secondFeed = buildCouponFeed(
      [
        {
          platform: 'foodpanda',
          url: 'https://example.com/foodpanda-coupons',
          html: foodpandaHtmlFixture,
        },
        {
          platform: 'ubereats',
          url: 'https://example.com/ubereats-coupons',
          html: uberEatsHtmlFixture,
        },
      ],
      feed,
      '2026-11-12T20:00:00.000Z',
    );

    assert.equal(secondFeed.updatedAt, feed.updatedAt);
    assert.deepEqual(secondFeed.coupons, feed.coupons);
  });
});
