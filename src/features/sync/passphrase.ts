/**
 * 🔴 **パスフレーズの入力の検査**(#2000 段 4b-B)。純粋 ── 長さ・強さの目安・確認の入力との一致・回復キーの打ち直しの照合だけ。
 * ⚠ ここは字を**保存しない・出さない**(強さの目安の字には、入れられた字を含めない)。
 */
import { parseRecoveryKey } from './e2e-crypto';

/** パスフレーズの最小の長さ(字数)。 */
export const PASSPHRASE_MIN_LENGTH = 10;

export type PassphraseStrength = 'short' | 'weak' | 'fair' | 'strong';

/** 強さの目安(厳密な推定ではない ── 長さと字の種類だけ)。10 字未満は `short`(受け付けない)。 */
export function passphraseStrength(text: string): PassphraseStrength {
  const chars = [...text.normalize('NFC')];
  if (chars.length < PASSPHRASE_MIN_LENGTH) return 'short';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(text)).length;
  const distinct = new Set(chars).size;
  if (distinct <= 3) return 'weak';
  if (chars.length >= 16 || (chars.length >= 12 && kinds >= 3)) return 'strong';
  if (kinds >= 2 || chars.length >= 12) return 'fair';
  return 'weak';
}

export const PASSPHRASE_HINT: Readonly<Record<PassphraseStrength, string>> = {
  short: `${String(PASSPHRASE_MIN_LENGTH)} 文字以上にしてください`,
  weak: '推測されやすい形です。長くする・字の種類を増やすことをおすすめします',
  fair: '使えます。もう少し長くすると、より安全です',
  strong: '十分な長さです',
};

/** 入れた 2 つの欄を検査する(通れば `null`、通らなければ理由)。 */
export function passphraseProblem(first: string, again: string): string | null {
  if ([...first.normalize('NFC')].length < PASSPHRASE_MIN_LENGTH) return `パスフレーズは ${String(PASSPHRASE_MIN_LENGTH)} 文字以上にしてください`;
  if (first !== again) return '2 つの欄のパスフレーズが一致しません';
  return null;
}

/** 回復キーの打ち直しが合っているか(大文字小文字・ハイフン・空白は問わない)。読めなければ `false`。 */
export function sameRecoveryKey(shown: string, typed: string): boolean {
  const a = parseRecoveryKey(shown);
  const b = parseRecoveryKey(typed);
  if (a === null || b === null) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  a.fill(0);
  b.fill(0);
  return diff === 0;
}
