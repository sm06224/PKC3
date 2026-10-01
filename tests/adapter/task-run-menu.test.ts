/** @vitest-environment happy-dom */
/**
 * 🔴 **右クリックでチェックリストを丸ごとそろえる**(#1173)── binder / reducer の側。
 *
 * ⚠ ここで見るのは「**押した所と、効く先が一致するか**」である ── 記法の側(どの行を
 *   動かし何を飛ばすか)は `tests/features/body-rewrite.test.ts`。
 *
 * ## 🔑 面は**本物の描画**から組む
 *
 * ⚠ 手で `<li class="pkc-task-item">` を書くと、**描画が実際に何を焼くか**を 1 度も見ない
 *   ことになる。だから `renderMarkdown`(`interactiveTasks: true`)の出力をそのまま器へ入れる。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { frontmatterLineCount, bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';

const MENU = '[data-pkc-region="context-menu"]';

function metasOf(lids: readonly string[]): AppState['entryMetas'] {
  const m = new Map<string, AppState['entryMetas'] extends Map<string, infer V> ? V : never>();
  for (const [i, lid] of lids.entries()) {
    m.set(lid, {
      lid,
      title: lid,
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: i + 1,
      status: null,
      date: null,
      archived: false,
    } as never);
  }
  return m as AppState['entryMetas'];
}

function setup(
  body: string,
  phase: AppState['phase'] = 'ready',
  services: Parameters<typeof bindActions>[2] = {},
) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = '<div data-pkc-region="detail"><div data-pkc-field="detail-body"></div></div>';
  document.body.append(root);
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), {
    sourceLineAnchors: true,
    taskLineOffset: frontmatterLineCount(body),
    interactiveTasks: true,
  } as never);
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase,
    selectedLid: 'n1',
    entryMetas: metasOf(['n1', 'n2']),
    openBody: { lid: 'n1', body, baseline: body, persisted: body, diskAhead: false },
  });
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  bindActions(root, d, services);
  const rightClickAt = (el: Element): MouseEvent => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    el.dispatchEvent(ev);
    return ev;
  };
  const itemText = (n: number): Element => {
    const li = host.querySelectorAll('li.pkc-task-item')[n];
    if (li === undefined) throw new Error(`前提が崩れている: ${n} 番目の項目が描かれていない`);
    return li;
  };
  return {
    root,
    d,
    events,
    host,
    rightClickAt,
    itemText,
    labels: (): string[] =>
      [...(root.querySelector(MENU)?.querySelectorAll('button[data-pkc-action]') ?? [])].map(
        (b) => `${b.getAttribute('data-pkc-action')}:${b.textContent}`,
      ),
    press: (action: string): void => {
      const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
      if (b === null) throw new Error(`前提が崩れている: ${action} が出ていない`);
      b.click();
    },
  };
}

// 行番号: 0 見出し / 2・3 親 / 4 子 / 5 孫 / 6 繰り返し / 8 別のリストの項目
const BODY = [
  '# 持ち物', // 0
  '', // 1
  '- [ ] 歯ブラシ', // 2
  '- [x] 充電器', // 3
  '  - [ ] ケーブル', // 4
  '    - [ ] 予備', // 5
  '- [ ] ゴミ出し @2026-09-07 毎週', // 6
  '', // 7
  '1. [ ] 別のリストの項目', // 8
].join('\n');

const TASK_RUN = (s: ReturnType<typeof setup>): string[] =>
  s.labels().filter((l) => l.startsWith('task-run-'));

describe('右クリックでチェックリストをそろえる(#1173)', () => {
  it('🔴 項目の字を右クリックすると 2 つ出る(字は画面に出る物そのまま)', () => {
    const s = setup(BODY);
    s.rightClickAt(s.itemText(0));
    expect(TASK_RUN(s)).toEqual([
      'task-run-open:このリストをすべて未完了に戻す',
      'task-run-done:このリストをすべて完了にする',
    ]);
  });

  it('🔴 箱そのものの上は、ブラウザ既定のメニューを残す(奪わない・出さない)', () => {
    const s = setup(BODY);
    const box = s.host.querySelector('.pkc-task-checkbox')!;
    const ev = s.rightClickAt(box);
    expect(ev.defaultPrevented, '箱の上の既定のメニューを奪っている').toBe(false);
    expect(TASK_RUN(s)).toEqual([]);
  });

  it('⚠ 項目でない所(見出し)では出ない ── メニュー自体は出ている(空振り防止)', () => {
    const s = setup(BODY);
    s.rightClickAt(s.host.querySelector('h1')!);
    expect(TASK_RUN(s), '項目でない所でリストの口が出た').toEqual([]);
    expect(s.labels().length, 'メニューが空(この検査が何も見ていない)').toBeGreaterThan(1);
  });

  /**
   * 🔴 **押した所のリストだけが対象**(入れ子の子も含む / 別のリストは含まない)。
   * ⚠ 行番号は**描画が焼いた値 + frontmatter の行数**。fixture に frontmatter を入れて
   *   **生の body の行番号**が届くことを見る(足し忘れると別の行を書き換える)。
   */
  it('🔴 入れ子も含む・別のリストは含まない行番号が、生の body の座標で届く', () => {
    const body = `---\ntags: [x]\n---\n${BODY}`;
    expect(body.split('\n')[5], '前提: 歯ブラシが 5 行目ではない').toBe('- [ ] 歯ブラシ');
    const s = setup(body);
    s.rightClickAt(s.itemText(0));
    s.press('task-run-done');
    expect(s.events).toEqual([
      expect.objectContaining({
        type: 'REQUEST_BODY_REWRITE',
        lid: 'n1',
        // 歯ブラシ(5)・充電器(6)・ケーブル(7)・予備(8)・繰り返し(9)。1. の別リスト(11)は入らない
        rewrite: { kind: 'task-run', lines: [5, 6, 7, 8, 9], to: 'done' },
      }),
    ]);
  });

  it('🔴 入れ子の項目の字を右クリックしたら、その子リストだけが対象(親は動かさない)', () => {
    const s = setup(BODY);
    // 項目の並び: 0 歯ブラシ / 1 充電器 / 2 ケーブル / 3 予備 / 4 ゴミ出し / 5 別のリスト
    s.rightClickAt(s.itemText(2));
    s.press('task-run-open');
    expect(s.events).toEqual([
      expect.objectContaining({ rewrite: { kind: 'task-run', lines: [4, 5], to: 'open' } }),
    ]);
  });

  it('別のリスト(番号つき)を右クリックしたら、そのリストの行だけ', () => {
    const s = setup(BODY);
    s.rightClickAt(s.itemText(5));
    s.press('task-run-done');
    expect(s.events).toEqual([
      expect.objectContaining({ rewrite: { kind: 'task-run', lines: [8], to: 'done' } }),
    ]);
  });

  it('🔴 編集中は断る ── 理由が画面に出て、書換は頼まない', () => {
    const s = setup(BODY, 'editing');
    s.rightClickAt(s.itemText(0));
    s.press('task-run-done');
    expect(s.d.getState().error, '断りの理由が画面に出ていない').toContain('編集を終了してから');
    expect(s.d.getState().error).toContain('完了にしてください');
    expect(s.events, '断ったのに書換を頼んだ').toEqual([]);
  });

  it('🔴 書き出し / 取込の最中は、名前の門が止める(`BODY_WRITE_ACTIONS`)', () => {
    const s = setup(BODY, 'ready', { busy: () => true });
    s.rightClickAt(s.itemText(0));
    s.press('task-run-open');
    expect(s.d.getState().error).toContain('実行中');
    expect(s.events).toEqual([]);
  });

  it('⚠ メニューを出した後にノートが替わったら、効かない(別のノートを書き換えない)', () => {
    const s = setup(BODY);
    s.rightClickAt(s.itemText(0));
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    s.events.length = 0;
    const b = s.root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="task-run-done"]`);
    // メニューが畳まれていれば押せない ── 残っていたら受け手が断る。どちらでも書換は頼まない
    b?.click();
    expect(s.events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toEqual([]);
  });
});
