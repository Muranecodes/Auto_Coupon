import { mountAutoCoupon } from './app.ts';

function bootAutoCoupon(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // Never execute inside subframes or iframes (e.g. tracking, payment, map iframes on Uber Eats)
  try {
    if (window.top && window.top !== window) return;
  } catch {
    // Cross-origin iframe throws error accessing window.top
    return;
  }

  const start = (): void => {
    try {
      mountAutoCoupon();
    } catch (err) {
      console.error('[AutoCoupon] Failed to mount:', err);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    // Backup timer in case DOMContentLoaded fired before Stay attached listener
    setTimeout(() => {
      if (!document.querySelector('#auto-coupon-root')) {
        start();
      }
    }, 500);
  } else {
    start();
  }
}

bootAutoCoupon();

