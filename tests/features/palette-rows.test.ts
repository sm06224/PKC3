/**
 * 🔴 **操作を名前で探す ── 一覧を組む側**(#425 段①)。
 *
 * ⚠ ここは**純関数だけ**を見る。「いま押せるか」を実際の画面から決める配線は
 *   `tests/adapter/palette.test.ts` が見る(2 つの検査で役割を分ける)。
 */
import { describe, expect, it } from 'vitest';
import { KEY_COMMANDS, defaultBindings, findCommand } from '../../src/features/keymap';
import { NOT_READY_PREFIX, paletteRows } from '../../src/features/palette/palette-rows';

const BINDINGS = defaultBindings();
/** 全部押せる、という前提の集合。 */
const ALL = new Set(KEY_COMMANDS.map((c) => c.id));
const NONE = new Set<string>();

const idsOf = (q: string, ready = ALL): string[] =>
  paletteRows(q, BINDINGS, ready).map((r) => r.id);

describe('操作を名前で探す(一覧)', () => {
  it('🔴 語を打っていなければ、表のコマンドが全部出る(隠さない)', () => {
    const rows = paletteRows('', BINDINGS, ALL);
    // ⚠ **全数**で見る ── 「1 件以上ある」だと、絞りの式が壊れても素通りする
    expect(rows.map((r) => r.id)).toEqual(KEY_COMMANDS.map((c) => c.id));
  });

  /**
   * 🔴 **画面から消した呼び名でも、探せば当たる**(#1017 段⑤-2 / #690 I5)。
   *
   * ⚠ 「小窓」は画面の字としては**使わない語**なので消したが、user は
   *   **その言葉で憶えている**(#690 で user 自身が探した語である)。
   *   消しただけだと「**探しても出てこない**」= 動線が 1 つ減る
   *   (user 裁定 2026-08-07「記法の縮小は user の動線の縮小」と同じ向き)。
   * 🔑 だから `alias` に残す ── **描画では読まない**ので画面には出ない。
   * ⚠ この検査が無いと、次に `alias` を消した人が**何も落ちないまま**動線を消せる
   *   (実際 1 稿目は配線だけ在って検査が 1 つも無かった)。
   */
  it('🔴 画面から消した旧い呼び名(小窓)でも、探せば当たる', () => {
    const hit = idsOf('小窓');
    expect(hit, '旧い呼び名で探せない ── 画面から消した語の行き先が無い').toContain(
      'open-note-window',
    );
    // ⚠ 空振り防止 ── 全部返っているなら「当たった」は何も言わない
    expect(hit.length, '絞れていない(全部返っている)').toBeLessThan(KEY_COMMANDS.length);
  });

  it('⚠ その呼び名は**画面には出ない**(alias は描画で読まない)', () => {
    const cmd = findCommand('open-note-window');
    expect(cmd, '相手の命令が無い(空振り)').toBeDefined();
    expect(cmd?.label ?? '', '画面の字に旧い呼び名が戻っている').not.toContain('小窓');
    expect(cmd?.note ?? '', '説明に旧い呼び名が戻っている').not.toContain('小窓');
  });

  it('🔴 名前で絞れる ── 当たらないものは落ちる', () => {
    const hit = idsOf('ヘルプ');
    expect(hit, '名前で当たっていない').toContain('open-help');
    expect(hit.length, '絞れていない(全部返っている)').toBeLessThan(KEY_COMMANDS.length);
  });

  it('🔴 名前の頭で当たったものが上に来る(途中で当たる別物より先)', () => {
    /**
     * 🔴 **表の並びと逆になる組で見る**(2026-08-26。変異試験 M2 が教えた)。
     *
     * ⚠ 1 稿目は「ノート」で見ていたが、`create-entry`(頭で当たる)は
     *   `edit-entry`(途中で当たる)より**表でも前**だったので、
     *   **頭の優先を丸ごと外しても順番が変わらなかった**
     *   ── 表の並びに救われていた(CLAUDE.md §1「救い手が変わっただけ」)。
     * 🔑 「編集」なら逆になる:`commit-edit`(**編集**を確定する)は頭で当たるが
     *   **表では 34 番目**、`edit-entry`(選んでいるノートを**編集**する)は
     *   途中で当たるが**表では 2 番目**。頭の優先が効いていないと順番が入れ替わる。
     * ⚠ 順番が逆だと、絞ってすぐ Enter を押した人が**別の操作**を実行する。
     */
    const hit = idsOf('編集');
    expect(hit, '前提が崩れている(頭で当たる側が落ちている)').toContain('commit-edit');
    expect(hit, '前提が崩れている(途中で当たる側が落ちている)').toContain('edit-entry');
    expect(KEY_COMMANDS.findIndex((c) => c.id === 'commit-edit'), '前提が崩れている(表の並び)')
      .toBeGreaterThan(KEY_COMMANDS.findIndex((c) => c.id === 'edit-entry'));
    expect(hit.indexOf('commit-edit')).toBeLessThan(hit.indexOf('edit-entry'));
  });

  it('説明の中の語でも当たる(名前を思い出せないとき)', () => {
    const cmd = findCommand('insert-date')!;
    expect(cmd.note ?? '', '前提が崩れている(説明が無い)').not.toBe('');
    expect(idsOf('caret'), '説明で当たっていない').toContain('insert-date');
  });

  it('綴り(id)でも当たる ── 大文字小文字は問わない', () => {
    expect(idsOf('OPEN-HELP')).toContain('open-help');
  });

  it('当たらない語では 1 件も返らない(空を返す ── 全部返さない)', () => {
    expect(idsOf('ぬるぽ')).toEqual([]);
  });

  describe('押せるか / なぜ押せないか', () => {
    it('🔴 押せる行の説明には「いまは押せません」が付かない', () => {
      const row = paletteRows('', BINDINGS, ALL).find((r) => r.id === 'create-entry')!;
      expect(row.ready).toBe(true);
      expect(row.why.startsWith(NOT_READY_PREFIX), '押せるのに断り書きが付いている').toBe(false);
      // 🔑 説明そのものは出る(何をする操作か分かる)
      expect(row.why).toBe(findCommand('create-entry')!.note);
    });

    it('🔴 押せない行は、必ず理由が付く(黙って無反応にしない)', () => {
      const rows = paletteRows('', BINDINGS, NONE);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.ready, `${r.id} が押せることになっている`).toBe(false);
        expect(r.why.startsWith(NOT_READY_PREFIX), `${r.id} に理由が付いていない`).toBe(true);
      }
    });

    it('🔴 その面にいないものは、**どこにいれば効くか**を書く', () => {
      /**
       * ⚠ `commit-edit` は `editor` の操作 ── 全域ではない。
       *   「いまは押せません」だけだと、user は**いつなら押せるのか分からない**。
       */
      const row = paletteRows('', BINDINGS, NONE).find((r) => r.id === 'commit-edit')!;
      expect(row.why).toContain('2 ペインの編集');
      expect(row.why).toContain('にいるときだけ効きます');
    });

    it('🔴 全域の操作は、**その操作自身の説明**を理由にする(書き直さない)', () => {
      /**
       * ⚠ ここで別の字を書くと、説明と理由の**2 つの答え**ができる(§7)。
       *   `edit-entry` は「ノートを選んでいるときだけ効きます」と自分で名乗っている。
       */
      const cmd = findCommand('edit-entry')!;
      const row = paletteRows('', BINDINGS, NONE).find((r) => r.id === 'edit-entry')!;
      expect(row.why).toBe(`${NOT_READY_PREFIX}${cmd.note}`);
    });

    it('🔴 押せるものが先に並ぶ ── 絞って即 Enter が空振りしない', () => {
      const only = new Set(['edit-entry']);
      const rows = paletteRows('ノート', BINDINGS, only);
      expect(rows.length, '前提が崩れている(2 件以上当たっていない)').toBeGreaterThan(1);
      expect(rows[0]!.id, '押せない行が先頭に来ている').toBe('edit-entry');
      expect(rows.slice(1).every((r) => !r.ready)).toBe(true);
    });
  });

  describe('鍵の字', () => {
    it('割り当たっている鍵が出る(次はこれで呼べる、が伝わる)', () => {
      const row = paletteRows('', BINDINGS, ALL).find((r) => r.id === 'create-entry')!;
      expect(row.keys).toEqual(['Ctrl + N']);
    });

    it('mac では ⌘ で出る(既定のままでも綴りが違う)', () => {
      const row = paletteRows('', BINDINGS, ALL, true).find((r) => r.id === 'create-entry')!;
      expect(row.keys).toEqual(['⌘ + N']);
    });

    it('🔴 user が変えた割当で出る(既定を出し続けない)', () => {
      const row = paletteRows('', { ...BINDINGS, 'create-entry': ['Alt+9'] }, ALL).find(
        (r) => r.id === 'create-entry',
      )!;
      expect(row.keys).toEqual(['Alt + 9']);
    });
  });
});
