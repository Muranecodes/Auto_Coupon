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
  (timer as unknown as { unref?: () => void })?.unref?.();
}

bootAutoCoupon();



