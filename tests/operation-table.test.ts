/**
 * 🔴 **操作の全数台帳を、崩れたら鳴るようにする**(#582 段①)。
 *
 * ## ⚠ 段①の題は「4 つの登記簿を寄せる」だったが、実測で的を外していた
 *
 * 5 つの登記簿(71 id)の**重なりは 1 件だけ**(`cycle-read-columns`)── つまり
 * **重複ではなく分割**なので、寄せても消える重複が無い(「三つの似た行 > 早すぎる helper」)。
 *
 * 🔴 **本当の穴は「操作の id 空間が 2 つある」こと**だった:
 *
 * | | 数 |
 * |---|---|
 * | `data-pkc-action` の受け手 | 183 |
 * | 登記簿の id | 71 |
 * | 両方に在る | **30** |
 * | 受け手の表の外に在る登記 | **41**(うち橋で繋がっているのは 15) |
 * | どの登記簿にも無い受け手 | **153** |
 *
 * 🔑 だから台帳の仕事は「寄せる」ではなく **2 つの空間を突き合わせて、
 * 繋がっていない分を名指しする**ことである ── R7(一貫性の検査)の足場。
 *
 * ## ⚠ 数え方を 2 度まちがえた(この test が生まれた理由)
 *
 * 1. `classify()` は **`Map`** を返すのに `kinds[id]` と書いたので、
 *    **183 件が揃って `null`** になっていた ── 数字が出ないので空振りに見えない。
 * 2. 「出口を受け手だけで探したから `toggle-sidebar` が 0 件に見える」と書きかけたが、
 *    🔴 **それも誤り**だった ── 実測すると走査を広げても **1 件も増えない**。
 *    ボタンの綴りは `toggle-pane` + `data-pkc-pane` なので、鍵の id は
 *    **どちらの走査でも当たらない**。🔑 誤読を直したのは**橋**のほうである。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { registries, summary, table } from '../scripts/operation-table.mjs';

interface Row {
  id: string;
  receiver: boolean;
  books: string[];
  label: string | null;
  arg: string | null;
  screens: string[];
  bridge: string | null;
}
interface Summary {
  total: number;
  receivers: number;
  registered: number;
  both: number;
  outsideActionsTable: { id: string; bridge: string | null }[];
  unbridged: string[];
  unregistered: number;
  scanned: number;
  sharedBooks: { id: string; books: string[] }[];
  perBook: Record<string, number>;
}
const s = (): Summary => (summary as () => Summary)();
const rows = (): Row[] => (table as () => Row[])();
const reg = (): Record<string, { id: string }[]> =>
  (registries as () => Record<string, { id: string }[]>)();

/**
 * 🔴 **押し所へ辿る道が、この走査から見えない登記**(26 件)。
 *
 * ⚠ **「押せない」ではない** ── 専用の listener で受けている物が居る。
 * 🔑 **身元で pin する**(件数ではなく)── 同じ数だけ取り違えても件数は合う。
 * 🔑 減らしたら**ここから消す**ので、直したことを忘れられない。
 */
const UNBRIDGED: readonly string[] = [
  'append-send',
  'dual-copy-to-other',
  'dual-mark',
  'dual-move-to-other',
  'dual-new-folder',
  'dual-new-note',
  'dual-other-pane',
  'dual-preview',
  'dual-rename',
  'edit-all',
  // ⚠ 2026-09-05(#215): 左の列の行の鍵 3 つ ── `runFilerKey` の `FILER_KEY_ACTION` で受ける
  'filer-rename',
  'filer-move',
  'filer-new-in-folder',
  'filer-extend-down',
  'filer-extend-up',
  'filer-open',
  'filer-parent',
  'filer-row-down',
  'filer-row-up',
  'filer-select-all',
  'filer-trash',
  'focus-search',
  'redo',
  'row-cancel',
  'row-commit',
  'toggle-focus-mode',
  'undo',
  'view-detail',
  'view-dual',
];

describe('操作の全数台帳(#582 段①)', () => {
  it('数が動いたら鳴る', () => {
    const x = s();
    expect({
      total: x.total,
      receivers: x.receivers,
      registered: x.registered,
      both: x.both,
      outsideActionsTable: x.outsideActionsTable.length,
      unregistered: x.unregistered,
    }).toEqual({
      // ⚠ 2026-08-31: `open-manual-window`(#645)で 1 増えた
      // ⚠ 2026-09-02: `phone-page` / `phone-menu`(#632 段①)で 2 増えた
      // ⚠ 2026-09-04: 小窓・板・章コピー・図の一覧・断り書きの設定など(#690 #677 #676 #528 #687 #278)で 8 増えた(229 → 237。別 worktree の合算 ── #724 ③で実測に合わせた)
      // ⚠ 2026-09-05: 塊の移動の「元に戻す」`undo-move`(#684 段①)で受け手が 1 増えた
      // ⚠ 2026-09-05(#215): 行の右クリックからの整理 3 つ(`rename-entry-begin` / `move-to-folder` /
      //    `create-in-folder`)── 受け手 +3、`ENTRY_MENU_ACTIONS` にも載るので registered / both も +3
      // ⚠ 2026-09-05(#215): 鍵 `filer-rename` / `filer-move` / `filer-new-in-folder` で登記 +3
      //    (受け手の表の外 ── `runFilerKey` が `FILER_KEY_ACTION` で受ける)
      total: 244,
      receivers: 200,
      registered: 78,
      both: 34,
      outsideActionsTable: 44,
      unregistered: 166,
    });
  });

  /**
   * 🔴 **登記簿は「分割」である** ── 同じ id が 2 冊に載るのは、意図して
   *   **同じ操作を 2 つの面から出している**ときだけ。
   * ⚠ 2026-09-04: `open-note-window` が 2 件目になった(#685、user 裁定)──
   *   行の右クリックと**本文の右クリック**の両方から出す。
   */
  it('🔴 登記簿をまたぐ id は、名指しの 2 件だけ', () => {
    expect(s().sharedBooks).toEqual([
      { id: 'cycle-read-columns', books: ['key', 'body'] },
      // ⚠ 2026-09-04(#690 I5): 鍵(Alt+Shift+W)と「操作を探す」から届くように
      //    `KEY_COMMANDS` にも登記した ── 受け手は情報ペインのボタン 1 つ(橋は `SHORTCUT_BUTTON`)
      { id: 'open-note-window', books: ['key', 'entry', 'body'] },
    ]);
  });

  it('登記簿の内訳が動いたら鳴る', () => {
    // ⚠ 2026-09-04: 本文のメニューが 2 → 3(`open-note-window`)
    // ⚠ 2026-09-04(#690 I5): 鍵が 52 → 53(`open-note-window` を「操作を探す」に出すため)
    // ⚠ 2026-09-05(#215): 行の右クリックが 12 → 15(名前を変える / 移す… / この中に新しいノートを作る)
    // ⚠ 2026-09-05(#215): 鍵が 53 → 56(左の列の行の F2 / F6 / Shift+F4)
    expect(s().perBook).toEqual({ key: 56, entry: 15, body: 3, collection: 2, settings: 5 });
  });

  it('🔴 押し所へ辿れない登記を、身元で pin する', () => {
    expect([...s().unbridged].sort()).toEqual([...UNBRIDGED].sort());
  });

  it('橋で繋がっている登記は、選択子か記法として辿れる', () => {
    const outside = s().outsideActionsTable.filter((r) => r.bridge !== null);
    expect(outside.length).toBe(15);
    // ⚠ **中身まで見る** ── `bridge` が空文字でも「繋がっている」に数えないため
    for (const r of outside) {
      expect(r.bridge === 'format' || (r.bridge ?? '').startsWith('button:[')).toBe(true);
    }
  });

  it('🔴 空振り防止: 受け手は全員 種別を持ち、登記は全員 字を持つ', () => {
    const all = rows();
    // ⚠ `classify()` が `Map` であることを踏んだ所 ── 全件 null なら 183 件落ちる
    expect(all.filter((r) => r.receiver && r.arg === null)).toEqual([]);
    expect(all.filter((r) => r.books.length > 0 && r.label === null)).toEqual([]);
    // ⚠ 登記簿が空になったら「未登記が増えた」ではなく**ここ**が落ちる
    for (const [name, list] of Object.entries(reg())) {
      expect(list.length, `${name} が空`).toBeGreaterThan(0);
    }
  });

  it('🔴 id 空間が混ざり始めたら鳴る(いまは 0 件)', () => {
    /**
     * ⚠ 走査を「全 id」へ広げたとき、**1 件も増えなかった**(実測 2026-08-30)。
     *   `toggle-sidebar` のボタンの綴りは `toggle-pane` + `data-pkc-pane` なので、
     *   鍵の id は**どちらの走査でも当たらない** ── 2 つの id 空間は
     *   **橋(`SHORTCUT_BUTTON`)でしか繋がっていない**。
     * 🔑 だからここは 0 件を pin する:**増えたら**、鍵の id が
     *   `data-pkc-action` として直接使われ始めた合図である(混ざると、
     *   同じ操作が 2 つの名前を持ち、台帳が二重に数える)。
     */
    expect(rows().filter((r) => !r.receiver && r.screens.length > 0)).toEqual([]);
    // ⚠ 対照群 ── 受け手の側では出口が実際に見つかっている(走査そのものは生きている)
    expect(rows().filter((r) => r.receiver && r.screens.length > 0).length).toBeGreaterThan(100);
    /**
     * 🔴 **走査の範囲そのものを見る**(変異試験 M3 が SURVIVED で教えた)。
     * ⚠ 上の 2 行だけだと、走査を受け手だけに戻したとき
     *   `!receiver && screens>0` が**空虚に真**になり、**検査ごと消える**。
     */
    expect(s().scanned).toBe(s().total);
  });
});
