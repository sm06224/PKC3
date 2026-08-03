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
 * 2. **戻せること** ── 解くのはこの file の配列から 1 語消すだけ。
 * 3. **うっかり復活しないこと** ── 導線を消すだけだと、次に UI を触った人が
 *    善意で戻してしまう。`tests/features/sealed.test.ts` が機械的に見張る。
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
 */
export const SEALED_VIEWS: readonly string[] = ['kanban', 'calendar'] as const;

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
