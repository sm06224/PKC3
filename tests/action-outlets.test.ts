/**
 * 🔴 **操作 → 出口の対応表を、崩さないように留める**(#582 の研究 R1 / R7)。
 *
 * ## なぜ要るか
 *
 * PKC3 には受け手が **196 種**(2026-09-05 実測。起票時は 181)あるのに、
 * 「**この操作は画面のどこから押せるか**」を
 * 答える物が **1 つも無かった**。⚠ だから届いていない操作が静かに溜まる ──
 * #500 で「右ペインが唯一の入口」の 6 種が**畳むと画面ごと消える**ことが分かった。
 *
 * 🔑 表を出すのは `scripts/action-outlets.mjs`。ここは**その表が崩れたら鳴る**側である。
 *
 * ## ⚠ 数え方を 2 度まちがえている(2026-08-29。**両方この test が生まれた理由**)
 *
 * 1. **表の外まで走っていた** ── `ACTIONS` の**末尾まで**走査したので、別の表の
 *    `format-bold` / `open-settings` など **19 種**まで拾い、**204 種**と出した
 *    (真は当時 **183**。⚠ この 2 つは 2026-08-29 の数であって、いまの数ではない)。
 *    ⚠ 名前が**それらしい**ので気づけない ── 気づけたのは
 *    「一意 197 / 総数 204」という**内部の食い違い**を数えたからである。
 * 2. 🔴 **同じ綴りが表の中と外の両方に在る**(`insert-snippet` / `insert-entry-link`)。
 *    ⚠ だから「先頭から探して最初に当たった本文」を読むと、**呼び側によって違う本文**を掴む
 *    ── 生成した一覧と検査した一覧が **1 件だけ**食い違った。
 * 🔑 だから本文を切るのは `handlers()` **1 か所**にした(§7)。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { codeOnlyForScan, handlers, receivers, report } from '../scripts/action-outlets.mjs';

interface Row { action: string; screens: string[]; key: boolean }
interface Report { receivers: number; withScreen: number; unresolved: string[]; rows: Row[] }
const r = (): Report => (report as () => Report)();
const bodies = (): Map<string, string> => (handlers as () => Map<string, string>)();
const names = (): string[] => (receivers as () => string[])();

/** 対象(選んだノート / 押した行)を読むか。⚠ 判定は 1 か所に書く。 */
const OBJECT = /selectedLid|data-pkc-entry|data-pkc-lid|multiSelected/;

/**
 * 🔴 **`ACTIONS` の**外**にしか無い綴り**。⚠ これが受け手に混ざったら、
 * 走査が表の終端を越えている(1 の再発)。
 */
const OUTSIDE_ONLY: readonly string[] = ['format-bold', 'open-settings', 'toggle-sidebar'];

/**
 * 🔴 **出口を静的に追えないもの**(変数で `data-pkc-action` を配る経路)。
 *
 * ⚠ **等値で pin する** ── 件数だけだと、同じ数だけ入れ替わっても気づけない。
 * 🔑 増えたら「**また静的に追えない出口を足した**」という合図
 * (減ったら、直したぶんをこの表から消すこと ── 消さないと落ちる = 忘れられない)。
 */
/**
 * ⚠ **2026-08-29 に 2 件減らした** ── `calendar-nav` / `calendar-today` は
 *   #292 段⑤ で中央のカレンダーを外したときの**取り残し**で、`src` 全体に
 *   焼く所が **0 件**、しかも `schedule-nav` / `schedule-today` と本体が同じだった。
 * 🔑 `repo-hygiene` は**逆向き(焼いたのに受け手が無い)しか見ない**ので鳴らなかった
 *   ── この表が、その向きの計器である。
 */
const UNRESOLVED: readonly string[] = [
  'choose-office-pack',
  'dual-back',
  'dual-bookmark',
  'dual-forward',
  'install-office-pack',
  'move-order-down',
  'move-order-up',
  'remove-office-pack',
  'reset-office-profile',
  'set-app-group',
  'set-app-icon',
  'toggle-todo',
  'view-big',
];

/**
 * 🔴 **「対象があるときだけ意味があるのに、出口が 1 か所しか無い」操作**。
 *
 * ⚠ その面を畳む・狭くすると **画面から消える**。#500 で 6 種にだけ 2 本目の道を作ったが、
 *   全体では **30 種**在る ── 置き場の規則が無いまま足し算で埋めてきた実体である。
 * 🔑 **#582(操作体系の再設計)の結論が出るまで、ここを増やさない。**
 *   ⚠ 増えたらこの test が落ちる = 「体系の外でまた 1 つ足した」と分かる。
 */
const OBJECT_LONE: readonly string[] = [
  'add-relation',
  'add-tag',
  'append-entry',
  'bulk-tag-add',
  'clear-entry-date',
  'cycle-read-columns',
  'deliver-to-extension',
  'dual-bookmark-open',
  'dual-bookmark-remove',
  'dual-crumb',
  // ⚠ `dual-row` は 2026-09-04(#687 D-1)に長押し(`long-press.ts`)が 2 つ目の出口になったので外した
  'edit-cell',
  'enter-folder',
  'insert-entry-link',
  'launch-asset',
  'launch-asset-extension',
  'launch-asset-raw',
  'move-entry',
  'navigate-entry-ref',
  'open-alarm',
  /**
   * 🔴 **スマホ用画面の 2 つは「1 か所しかない」が設計である**(#632 段①)。
   *
   * ⚠ 出口はどちらも**本文ページの帯**(`shell.ts` の `phone-bar`)1 か所しか無い ──
   *   スマホでは一覧も情報も見えていないので、**そこ以外に置ける場所が無い**。
   * 🔑 増やす向きの話ではないので、#582 の「増やさない」pin とは意味が違う ──
   *   ここに載っているのは「対象が要るのに 1 か所」という**計器の分類**であって、
   *   不具合ではない。⚠ 逆に 2 か所目ができたら、それは
   *   「同じ操作に 2 通りの経路」を作った合図なので、ここで気づく。
   */
  'phone-menu',
  'phone-page',
  /**
   * 🟢 **`pin-split` は 2026-09-02 に 2 本目の道ができた**(#633 段①)──
   *   本文の上の**スタックの帯**の札から押せる(= 一番上へ上げる)。
   */
  'rename-attachment',
  'retry-persist',
  'set-entry-date',
  'shape-cell',
  /**
   * 🔴 **スタックの「保存…」は帯にしか無い**(#633 段③)── 帯は載せているときだけ出る
   *   本文の上の 1 行で、保存の対象(いまの並び)もそこにしか見えない。⚠ 鍵の口は
   *   置いていない(載せる / 開く / 全部降ろす の 3 手は #633 段②)。増やすなら
   *   `KEY_COMMANDS` へ ── 増えた日にここが落ちて気づく。
   */
  'stack-save',
  'storage-profile',
  'toggle-app-tile',
  'unschedule-task',
  /**
   * ⚠ **この計器は「出口の数」を file で数える**(`scripts/action-outlets.mjs` の
   *   `where = 相対 path`)。`unsplit-entry` は 2026-09-02 に
   *   **本文の上のスタックの帯**にも口ができたが、⚠ 帯も枠も同じ
   *   `split-view.ts` なので、**この表からは 1 か所のまま**に見える。
   *
   * 🟢 **user から見た片道は #633 段①で閉じている** ── 直す前は「× 降ろす」が
   *   **枠の中にしか無かった**ので、幅で枠が畳まれると**降ろす口が画面から消えて**
   *   いた(#584)。帯の札の × は**枠が 1 つも出ていなくても**押せる。
   * 🔑 だから行は残す(計器の定義に嘘をつかない)が、**残っている理由は
   *   「まだ片道だから」ではない** ── 次に読む人がそう読まないように書いておく。
   */
  'unsplit-entry',
  'untag-entry',
];

describe('操作 → 出口の対応表(#582)', () => {
  it('⚠ 空振り防止 ── 受け手の表を、表の中だけ読めている', () => {
    const got = names();
    expect(got.length, '受け手を 1 つも読めていない').toBeGreaterThan(100);
    for (const outside of OUTSIDE_ONLY) {
      expect(got, `表の外の ${outside} まで拾っている(終端を切れていない)`).not.toContain(outside);
    }
    expect(new Set(got).size, '受け手の名前が重複している(終端の切り方が壊れた)').toBe(got.length);
    // 🔑 本文も同じ数だけ切れている(片方だけ壊れるのを防ぐ)
    expect(bodies().size, '本文の切り出しが受け手と揃っていない').toBe(got.length);
  });

  /**
   * 🔴 **コメントは出口ではない**(2026-09-05、#738)。
   *
   * ⚠ 直す前は原文をそのまま読んでいたので、**docstring に
   *   `data-pkc-action` の綴りを書いただけで、その file が出口として数えられた** ──
   *   #735 の直しで「csv の升にはこの印が付く」と**説明を書いた**瞬間に、下の
   *   「出口が 1 か所」の一覧が動いて赤くなった(**説明が台帳を動かした**)。
   * 🔑 見るのは 2 つ:①落とす規則が docstring を空にすること
   *   ②**実物で**、説明しか書いていない file が出口に数えられていないこと。
   * ⚠ ②が本体である ── ①だけだと「規則は在るが呼ばれていない」を見逃す。
   */
  it('🔴 コメントに書いた印を、出口として数えない (#738)', () => {
    // ① 規則そのもの(docstring の 3 つの書き出しを全部空にする)
    expect(
      codeOnlyForScan(['/**', ' * data-pkc-action="x"', ' */', '// data-pkc-action="y"'].join('\n')).trim(),
      'docstring を落とせていない',
    ).toBe('');
    // ⚠ 実行する字は残す(落としすぎると本物の出口が消える)
    expect(codeOnlyForScan('el.setAttribute("data-pkc-action", "z");')).toContain('data-pkc-action');
    /**
     * ② 実物 ── `copy-md-block.ts` は**自分の名前の説明**を docstring に持つが、
     *    そこから出口を作ってはいない(押す口を作るのは `markdown-render.ts` 側)。
     */
    const where = r().rows.find((x) => x.action === 'copy-md-block')?.screens ?? [];
    // 空振り防止 ── 出口が 1 つも読めていないなら、下は何も見ていない
    expect(where.length, 'copy-md-block の出口が 1 つも読めていない').toBeGreaterThan(0);
    expect(
      where,
      'コメントしか無い file を出口に数えている(説明を書くと台帳が動く)',
    ).not.toContain('adapter/ui/actions/copy-md-block.ts');
  });

  it('🔴 静的に追えない出口の顔ぶれが変わっていない', () => {
    expect([...r().unresolved].sort()).toEqual([...UNRESOLVED].sort());
  });

  it('🔴 「対象が要るのに出口が 1 か所」の顔ぶれが変わっていない(#582 が決まるまで増やさない)', () => {
    const h = bodies();
    const got = r()
      .rows.filter((x) => x.screens.length === 1 && OBJECT.test(h.get(x.action) ?? ''))
      .map((x) => x.action)
      .sort();
    expect(got).toEqual([...OBJECT_LONE].sort());
  });

  it('⚠ ほとんどの操作には画面の出口が在る(空振り防止の下限)', () => {
    const x = r();
    expect(x.withScreen / x.receivers, '画面の出口が見つかる割合が落ちすぎ').toBeGreaterThan(0.8);
  });
});
