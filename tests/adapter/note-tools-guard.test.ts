/** @vitest-environment happy-dom */
/**
 * 🔴 **開いているノートが要る 4 つの道具は、押す前に断る**
 * (user 裁定 2026-09-02「**4 つとも先に断る**」── PC も同じ)。
 *
 * ## user の物語
 *
 * 一覧を見ている(まだ何も開いていない)→ 「録音」を押す → 5 分しゃべる →
 * 止める → 🔴 **「ノートを開いていないので本文には入れていません」** と言われる。
 * ⚠ **録ってから知らされる**ので、やり直すしかない。
 *
 * ## この test が守る主張
 *
 * ① 🔴 4 つとも**押した瞬間に**断る(理由つき)
 * ② 🔴 断ったら**何も始まらない**(録音・計測が走らない / file を選ばせない)
 * ③ 🔴 断り文に**押した物の名前**が入る(4 つが同じ字だと、どれを押して断られたのか
 *    読めない ── CLAUDE.md「文言は押した場所と対で pin する」)
 * ④ ⚠ **対照群**:ノートを開いていれば同じ押しが通る(常に断る実装を殺す)
 * ⑤ 🔴 判定は `NOTE_TOOL_ACTIONS` **1 か所**から引く(5 つ目を足した日に、
 *    書き足さなくても門が効く)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { NOTE_TOOL_ACTIONS } from '../../src/features/entry-actions';

const META = (lid: string, title: string) =>
  ({
    lid,
    title,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: 1,
    status: null,
    date: null,
    archived: 0,
  }) as never;

function bench(open: boolean) {
  document.body.textContent = '';
  localStorage.clear();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [META('n1', '買い物')], relations: [] });
  if (open) {
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
  }
  /** 🔑 **始まったか**を種類ごとに数える(「断った」だけ見ると②が空振りする)。 */
  const started: string[] = [];
  bindActions(root, d, {
    startCapture: (kind) => started.push(`capture:${kind}`),
    startTimer: () => started.push('timer'),
  });
  /**
   * ⚠ 添付だけは service を呼ばない ── 受け手は**常設の隠れた入力欄を開く**。
   *   だから観測点も**その欄が開いたか**にする(呼ばれない service を見ていると、
   *   門を外しても「呼ばれていない」ままで**空振りする**)。
   */
  const input = root.querySelector<HTMLElement>('[data-pkc-field="attach-input"]')!;
  input.click = () => started.push('attach');
  return {
    d,
    started,
    /** 実物の押し口(左の列の帯)を押す。⚠ 手で `<button>` を作らない。 */
    press: (action: string) => {
      const b = root.querySelector<HTMLElement>(`[data-pkc-action="${action}"]`);
      expect(b, `押し口が画面に無い: ${action}`).not.toBeNull();
      b!.click();
    },
    error: () => d.getState().error,
  };
}

describe('ノートが要る道具は、押す前に断る(user 裁定 2026-09-02)', () => {
  /** ⚠ **4 つを名前で数え上げる** ── 1 つだけ見ると、残り 3 つの門が死んでも緑になる。 */
  it('🔴 ① ② ③ 4 つとも、断って・何も始めず・押した物の名前を言う', () => {
    for (const { action, label } of NOTE_TOOL_ACTIONS) {
      const b = bench(false);
      b.press(action);
      expect(b.started, `${label}: 断ったのに始まっている`).toEqual([]);
      expect(b.error() ?? '', `${label}: 何も言っていない`).toContain('ノートを開いてから');
      expect(b.error() ?? '', `${label}: どれを押して断られたか読めない`).toContain(label);
    }
  });

  /**
   * ⚠ **対照群** ── ノートを開いていれば同じ押しが通る。
   * 🔑 これが無いと「いつも断る」実装が緑のまま通る(§1「強制する規則は、
   *   強制しなければ false になる場面で見る」の逆側)。
   */
  it('🔴 ④ ノートを開いていれば、同じ押しで始まる', () => {
    const b = bench(true);
    for (const { action } of NOTE_TOOL_ACTIONS) b.press(action);
    expect(b.started.sort()).toEqual(
      ['attach', 'capture:audio', 'capture:screen', 'timer'].sort(),
    );
    expect(b.error() ?? '', '開いているのに断っている').not.toContain('ノートを開いてから');
  });

  /**
   * 🔴 **⑤ 門は表から引く。** ⚠ 表に在る綴りが受け手にも在ることを見ておかないと、
   *   `NOTE_TOOL_ACTIONS` の綴りを 1 文字変えた日に**門が丸ごと空振り**する
   *   (押し口は残るので画面からは分からない ── CLAUDE.md §1)。
   */
  it('🔴 ⑤ 表の 4 つは、いま画面に押し口がある', () => {
    const b = bench(true);
    expect(NOTE_TOOL_ACTIONS.map((a) => a.action)).toEqual([
      'attach-file',
      'start-audio-capture',
      'start-screen-capture',
      'start-timer',
    ]);
    for (const { action } of NOTE_TOOL_ACTIONS) b.press(action);
  });
});
