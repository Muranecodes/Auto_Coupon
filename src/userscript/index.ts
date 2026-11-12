import { mountAutoCoupon } from './app.ts';

function bootAutoCoupon(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const start = (): void => {
    try {
      mountAutoCoupon();
    } catch (err) {
      console.error('[AutoCoupon] Failed to mount:', err);
    }
  };

  // Immediate start
  start();

  // Listen for DOMContentLoaded if page is still loading
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  // Backup timers for SPA / React hydration (Uber Eats & foodpanda)
  setTimeout(start, 500);
  setTimeout(start, 1500);
}

bootAutoCoupon();


