/**
 * 封印(user 指示 2026-08-03)。
 *
 * > 「**todo とカンバンとカレンダーは一旦封印したい** / PKC2 では使い物にならないから
 * > ほぼ使ってなかった / **form エントリと一緒、機能を煮詰める前に破綻したから**、
 * > 封印しておきたい」
 *
 * 🔴 **消すのではなく畳む**。理由は 3 つある:
 * 1. **既存データを壊さない** ── 取り込んだ container に todo の entry があっても、
 *    本文は PKC-Markdown なので**普通のノートとして読めて編集できる**
 *    (PKC3 は「全 body = PKC-Markdown、アーキタイプはフレーバー」)。
 *    抽出列(status / date / archived)も落とさない ── 落とすと再開時に戻せない。
 * 2. **戻せること** ── 描画器・抽出列・flavor をすべて残してあるので、
 *    解くのは**書き直しではなく導線の付け直し**で済む。
 *    ⚠ ただし **「配列から 1 語消すだけ」で戻るのは `todo` だけ**である
 *    (2026-08-04、引き継ぎ先の指摘で判明。初版はここに「1 語消すだけ」と
 *    書いていたが、それは 4 つのうち 1 つにしか当てはまらない):
 *    - `todo` … 配列から消すだけで戻る。`shell.ts` の `CREATE_BUTTONS` に項目が
 *      残っていて、この配列がそれを濾しているだけだから
 *    - `form` … 消しても**何も戻らない**。作成導線がそもそも無い
 *      (PKC2 の 2026-04-26 audit で撤去済みの判断を継いだ)── `CREATE_BUTTONS`
 *      への追加が要る
 *    - `kanban` … 消しても**何も戻らない**。P8 段⑤ で上の帯から面の切替を外し、
 *      `VIEW_BUTTONS` は設定 1 つになったので、濾す対象が無い ── 切替の導線を
 *      どこに置くかを決めて作り直す必要がある(カレンダーは #276 で
 *      **組み込みタイル**として作り直した ── 同じ形で戻せる)。
 *      加えて `SEALED_TEST_NOTES` の smoke を戻す
 * 3. **うっかり復活しないこと** ── 導線を消すだけだと、次に UI を触った人が
 *    善意で戻してしまう。2 つの test が機械的に見張る:
 *    - `tests/docs-parity.test.ts` … 封印中のものが**導線に出ない**こと
 *    - `tests/features/sealed.test.ts` … **戻せる形が保たれている**こと
 *      (描画器・flavor・抽出列が生きている / 解いたときに何が戻り、何が戻らないか)
 *
 * ⚠ **flag ではない**。flag は「切り替えて試すもの」で、これは「畳んで凍らせるもの」。
 * flag 枠(15)を食わせないし、URL から有効化できてもいけない。
 */

/**
 * 封印中のアーキタイプ ── **作る導線を出さない**。
 * ⚠ 既存 entry の表示・編集・書き出しは**通常どおり**(本文は Markdown なので、
 * 何も特別扱いせずに読める)。
 */
export const SEALED_ARCHETYPES: readonly string[] = ['todo', 'form'] as const;

/**
 * 封印中のビュー ── **切り替える導線を出さない**。
 * ⚠ 描画器(`kanban.ts` / `calendar.ts`)は残す。消すと、解くときに書き直しになる。
 *
 * 🔴 **カレンダーは 2026-08-19 に解いた**(#276。user 指示「かつて無くした
 * カレンダーとカンバンはここで生きてきます / 発想を変え、frontmatter での
 * カレンダー情報付与や…で復活させるのです」)。
 * 🔑 `SEAL_REASON` が求める「何をもって煮詰まったと言えるか」への答えは
 *   **todo アーキタイプに寄せるのをやめ、frontmatter の `date` を情報源にする**
 *   ことだった ── 封印中の archetype に依存していたのが破綻の形だからである。
 * ⚠ 解いた形は**導線の付け直し**であり、切替を上の帯へ戻したのではない ──
 *   組み込みタイル(`launcher/tiles.ts` の `calendarTile`)から開く(#241 の形)。
 */
export const SEALED_VIEWS: readonly string[] = ['kanban'] as const;

/**
 * なぜ封印したか(解くときに読む)。⚠ **「使われなかった」ではない** ──
 * 「**煮詰める前に作り込んで破綻した**」が理由なので、解くときは
 * 「何をもって煮詰まったと言えるか」を先に決めること。
 */
export const SEAL_REASON =
  '機能を煮詰める前に作り込んで破綻したため(user 指示 2026-08-03)。解くときは、先に「何をもって煮詰まったと言えるか」を決める。';

export function isSealedArchetype(archetype: string): boolean {
  return SEALED_ARCHETYPES.includes(archetype);
}

export function isSealedView(view: string): boolean {
  return SEALED_VIEWS.includes(view);
}

/**
 * ⚠ 封印で**畳んだ test** の記録(解くときに戻す先)。
 *
 * - `tests/smoke/kanban.smoke.spec.ts` … 削除した。かんばんの切替ボタンが画面に
 *   無いので、実クリックで駆動できない。中身の検証は
 *   `tests/adapter/kanban-calendar-view.test.ts` が dispatch 経由で続けている
 *   (描画も state も生きている、という事実をそちらが示す)。
 * - `tests/smoke/layout.smoke.spec.ts` … かんばん / カレンダーの見た目を見ていた
 *   assertion を、3 列と編集中の配置を見るものへ置き換えた。
 */
export const SEALED_TEST_NOTES = 'tests/smoke/kanban.smoke.spec.ts を削除(解くときは復活させる)';
