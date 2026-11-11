import type { CandidateChip } from '../shared/types.ts';

const NOISE_TOKEN_REGEX =
  /^(?:\d+|[$＄]\d+|NT\$?\d+|滿\d+.*|折\d+.*|\d+(?:\.\d+)?折|免運|免外送費|外送|優惠碼|優惠券|折扣碼|優惠序號|輸入|代碼|使用|領取|點我|立即|限時|最高|享\d+.*)$/i;

function isValidCandidateToken(raw: string): boolean {
  const token = raw.trim();
  if (token.length < 2 || token.length > 20) return false;
  if (NOISE_TOKEN_REGEX.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  if (/^(https?|www|foodpanda|ubereats)$/i.test(token)) return false;
  return /^[A-Za-z0-9\u4e00-\u9fff_-]+$/.test(token);
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

  // Scan line by line in source order for explicit bracketed or keyword-prefixed codes
  const explicitPattern =
    /【([^】\n]{2,20})】|「([^」\n]{2,20})」|『([^』\n]{2,20})』|(?:優惠碼|優惠序號|折扣碼|代碼|code)\s*[:：為是]?\s*([A-Za-z0-9\u4e00-\u9fff_-]{2,20})|輸入\s*([A-Za-z0-9_-]{3,20})/gi;

  let match: RegExpExecArray | null;
  while ((match = explicitPattern.exec(text)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    pushCandidate(token);
  }

  // Fallback: if no explicit delimiters matched, treat input as a whitespace/comma/newline separated list of codes
  if (results.length === 0) {
    const rawTokens = text.split(/[\r\n,，、;；\s]+/);
    for (const tok of rawTokens) {
      pushCandidate(tok);
    }
  }

  return results;
}
