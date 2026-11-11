import type { CandidateChip } from '../shared/types.ts';

const NOISE_TOKEN_REGEX =
  /^(?:\d+|[$＄]\d+|NT\$?\d+|滿\d+.*|折\d+.*|\d+(?:\.\d+)?折|免運|免外送費|外送|優惠碼|優惠券|折扣碼|優惠序號|輸入|代碼|使用|領取|點我|立即|限時|最高|享\d+.*)$/i;

export const COUPON_CONTEXT_HINT_REGEX =
  /優惠碼|優惠序號|折扣碼|代碼|輸入|code|【|「|『/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidCandidateToken(raw: string): boolean {
  const token = raw.trim();
  if (token.length < 2 || token.length > 20) return false;
  if (NOISE_TOKEN_REGEX.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  if (/^(https?|www|foodpanda|ubereats)$/i.test(token)) return false;
  return /^[A-Za-z0-9\u4e00-\u9fff_-]+$/.test(token);
}

export function hasCouponHint(text: string): boolean {
  return COUPON_CONTEXT_HINT_REGEX.test(text);
}

export function stripCouponCodeFromTitle(
  blockText: string,
  code: string,
): string {
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

export function extractCandidateChips(text: string): CandidateChip[] {
  const results: CandidateChip[] = [];
  const seen = new Set<string>();

  const pushCandidate = (raw: string | undefined) => {
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
    let match: RegExpExecArray | null;
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
