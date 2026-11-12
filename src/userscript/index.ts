import { mountAutoCoupon } from './app.ts';

function bootAutoCoupon(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!document.body && !document.documentElement) {
    window.addEventListener?.('DOMContentLoaded', () => {
      mountAutoCoupon();
    });
    return;
  }
  mountAutoCoupon();
}

bootAutoCoupon();
