/**
 * **追記できるのはどれで、何を足すか**(P8 段⑥)。
 *
 * > user 指摘 2026-08-03「**ログの追記機構とテキストエントリの追記機構も無い**」
 *
 * 🔴 これは「無かった機能」ではなく **doc が先に嘘をついていた**箇所である ──
 * `docs/manual.md` は「**ログ** = 追記型。`## <日時>` の節を末尾に足していきます」
 * と書き、`textlog-flavor.ts` も「追記 = 末尾への節 append(P3-5 で編集 UI が実装)」
 * と書いていたが、**その UI は一度も存在しなかった**。
 *
 * 🔑 **判定を 1 か所に置く**(検証の規律「同じ判定が 2 か所に生えたら規則を寄せる」)。
 * ボタンを出すかどうか(描画側)と、何を足すか(binder 側)が別々に育つと、
 * 「ボタンは出るが何も起きない」/「押せないが機構はある」がすぐ生える。
 */
import { formatHeadingTimestamp } from './textlog-flavor';
import { archetypeLabel } from './archetype-label';

/**
 * 追記の導線を出す archetype。
 * ⚠ **意図的に 2 つだけ**。添付・フォルダは本文が「説明」であって記録の連なりでは
 * ないので、末尾に足す操作に意味が無い(足したければ普通に編集する)。
 */
export const APPENDABLE_ARCHETYPES: ReadonlySet<string> = new Set(['text', 'textlog']);

export function isAppendable(archetype: string | undefined): boolean {
  return archetype !== undefined && APPENDABLE_ARCHETYPES.has(archetype);
}

/**
 * 🔴 **本文に入れられる種類を、user の言葉で**(#668 A)──「ノートとログ」。
 *
 * ⚠ 断り文に「追記できない種類」とだけ書くと、user は**どれなら入るのか**を
 *   知りようがない(開いているのが何なのかも言っていなかった)。
 * 🔑 一覧は `APPENDABLE_ARCHETYPES` から組む ── 種類を足したら字も一緒に変わる
 *   (綴りを 2 か所に持たない。§7)。名前は `archetype-label.ts` の 1 か所から引く。
 */
export function appendableKindsLabel(): string {
  return [...APPENDABLE_ARCHETYPES].map(archetypeLabel).join('と');
}

/**
 * 何を足すか。ログは**日時の節**、ノートは**空行だけ**(見出しを勝手に足さない ──
 * ノートの構造は書く人のもの)。
 * ⚠ 秒まで入れる(PKC2 textlog-readability-hardening の教訓:高頻度の記録は
 * 分では区別できない)。
 */
export function appendHeadingFor(archetype: string, now: Date): string | null {
  return archetype === 'textlog' ? `## ${formatHeadingTimestamp(now.toISOString())}` : null;
}
