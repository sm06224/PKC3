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
 * 🔴 **同じ容れ物のノートを指す形は 2 つある**(#379)。
 *
 * | 形 | いつ本文に入るか |
 * |---|---|
 * | `entry:<lid>` | ふつうに書いたとき / 貼り付けが降ろしたとき |
 * | **`pkc://<この容れ物>/entry/<lid>`** | 手で書いたとき / 🔑 **書き出して取り込み直したとき**(別の容れ物のものが「自分あて」に変わる) |
 *
 * 描画側(`markdown-render.ts:711-737`)は 2 つ目を**明示的に 1 つ目と同じ扱い**に
 * している(押せば飛ぶ)。⚠ こちらが 1 つ目しか見ないと、
 * **「リンクは効くのに参照元から消える」**という、移行のたびに静かに減る穴になる。
 */

/**
 * lid に使える文字。⚠ `entry-ref.ts` / `permalink.ts` の `TOKEN_RE`
 * (`[A-Za-z0-9_-]+`)と**同じ** ── ずらすと、あちらが解けるリンクを
 * こちらが拾えなくなる。
 */
const LID_CHARS = 'A-Za-z0-9_\\-';

/** `entry:` の後ろの lid を、**次の文字が lid の文字でない**ところまで取る。 */
const LINK_RE = new RegExp(`entry:([${LID_CHARS}]+)`, 'g');

/**
 * ⚠ **cid は正規表現に埋める**ので、lid の文字だけで組まれていることを確かめる
 * (`permalink.ts` の `TOKEN_RE` が保証しているが、**保証を当てにして書かない**
 * ── 別経路で入った cid が記号を含むと、正規表現ごと壊れる)。
 */
const TOKEN_ONLY = new RegExp(`^[${LID_CHARS}]+$`);

/**
 * 本文が指しているノートの lid(重複を畳み、**出てきた順**)。
 *
 * ⚠ `#fragment` は落とす ── 章へのリンクでも、繋がっている先はノートである。
 * ⚠ 自分自身は**落とさない**(判断は呼び側 ── 図は落とすが、数えたい向きもある)。
 *
 * @param cid いまの容れ物の id。渡すと `pkc://<cid>/entry/<lid>` も拾う。
 *   ⚠ 渡さなければ `entry:` だけ ── **他の容れ物あては拾わない**
 *   (あちらはこの容れ物に居ないので、辺を引く相手が居ない)。
 */
export function bodyLinkTargets(body: string, cid?: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (lid: string): void => {
    if (seen.has(lid)) return;
    seen.add(lid);
    out.push(lid);
  };
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(body); m !== null; m = LINK_RE.exec(body)) take(m[1]!);
  if (cid !== undefined && cid !== null && TOKEN_ONLY.test(cid)) {
    const portable = new RegExp(`pkc://${cid}/entry/([${LID_CHARS}]+)`, 'g');
    for (let m = portable.exec(body); m !== null; m = portable.exec(body)) take(m[1]!);
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
export function bodyLinksTo(body: string, lid: string, cid?: string | null): boolean {
  return bodyLinkTargets(body, cid).includes(lid);
}

/**
 * 本文の中で `lid` を指しうる**字面**(SQL の LIKE で粗く削るのに使う)。
 *
 * ⚠ **これは合否ではない。** LIKE は過剰に当たるので、当たった候補を
 * `bodyLinksTo` に通して初めて答えが決まる(§7「判定を 1 か所へ寄せる」)。
 * 🔑 ここに形を足したら **`bodyLinkTargets` にも足す** ── 片方だけだと、
 * 候補にすら挙がらないか(取りこぼし)、挙がっても弾かれるか(無駄)になる。
 */
export function bodyLinkNeedles(lid: string, cid?: string | null): string[] {
  const out = [`entry:${lid}`];
  if (cid !== undefined && cid !== null && TOKEN_ONLY.test(cid)) {
    out.push(`pkc://${cid}/entry/${lid}`);
  }
  return out;
}
