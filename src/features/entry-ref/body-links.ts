/**
 * 🔴 **本文が張っているノート間のリンクを、1 つの文法で読む**(#186 段③ / #348)。
 *
 * ノート間のリンクは **`entry:<lid>` の 1 形式**しか無い(`markdown-render.ts` /
 * `features/link/permalink.ts`)。⚠ ところがそれを読む側は **2 方向**ある:
 *
 * | 向き | 誰が読むか |
 * |---|---|
 * | **出ていく**(この本文はどこを指すか) | つながりの図(#186) |
 * | **入ってくる**(この lid を指すのは誰か) | 参照元の一覧(#348、worker の `findBacklinks`) |
 *
 * ⚠ **同じ問いに答える口が 2 つあると、片方だけ壊しても届かない**(CLAUDE.md §7)。
 * だから**文法をここ 1 つに寄せる** ── 出ていく側も入ってくる側も、この file を通す。
 *
 * ## 🔴 境界を留める(2026-08-25 に見つけた取りこぼし)
 *
 * `findBacklinks` は `body LIKE '%entry:<lid>%'` で探していた。
 * ⚠ これは **`entry:n1` が `entry:n12` の中に当たる** ── 参照していないノートが
 * 参照元として並ぶ。⚠ 逆向きの取りこぼしではなく**過剰報告**なので、
 * 「出た物が正しいか」を誰も検算しない形で残る。
 *
 * 🔑 CLAUDE.md §1「file 名で見分けるときは、path の頭と尻を両方留める」と同じ ──
 * lid の**次の 1 文字が lid の文字でないこと**まで見る。
 * ⚠ 現行の `generateLid()`(`<epoch36>-<counter36 4 桁>`)では前置の衝突は
 * まず起きないが、**取り込んだ容れ物の lid は形が違う**(PKC2 由来)。
 * 「たぶん起きない」を検査の根拠にしない。
 */

/**
 * ⚠ **`pkc://<自分>/entry/<lid>` の形は、まだ拾っていない**(#379)。
 *
 * 描画側(`markdown-render.ts`)は**その形を `entry:` と同じ扱い**にしており
 * (押せば飛ぶ)、書き出して取り込み直すと**別の容れ物のものが自分あてになる**。
 * つまり「リンクは効くのに参照元から消える」形の穴が残っている。
 * 🔑 直す場所はここ 1 つで済む(出ていく側も入ってくる側もこの file を通る)が、
 * **cid を受け取る形**にする必要があるので #379 で別に扱う。
 */

/**
 * lid に使える文字。⚠ `entry-ref.ts` の `TOKEN_RE`(`[A-Za-z0-9_-]+`)と**同じ**
 * ── ずらすと、あちらが解けるリンクをこちらが拾えなくなる。
 */
const LID_CHARS = 'A-Za-z0-9_\\-';

/** `entry:` の後ろの lid を、**次の文字が lid の文字でない**ところまで取る。 */
const LINK_RE = new RegExp(`entry:([${LID_CHARS}]+)`, 'g');

/**
 * 本文が指しているノートの lid(重複を畳み、**出てきた順**)。
 *
 * ⚠ `#fragment` は落とす ── 章へのリンクでも、繋がっている先はノートである。
 * ⚠ 自分自身は**落とさない**(判断は呼び側 ── 図は落とすが、数えたい向きもある)。
 */
export function bodyLinkTargets(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(body); m !== null; m = LINK_RE.exec(body)) {
    const lid = m[1]!;
    if (seen.has(lid)) continue;
    seen.add(lid);
    out.push(lid);
  }
  return out;
}

/**
 * この本文は `lid` を指しているか。
 *
 * 🔑 **`bodyLinkTargets` と同じ文法で答える**(別の綴りで書き直さない ──
 * CLAUDE.md「期待値を実装と同じ文法の別の綴りで組むと、同じ盲点を共有する」の逆で、
 * ここは**実装どうし**なので、むしろ 1 つに寄せるのが正しい)。
 */
export function bodyLinksTo(body: string, lid: string): boolean {
  return bodyLinkTargets(body).includes(lid);
}
