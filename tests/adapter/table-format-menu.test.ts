/** @vitest-environment happy-dom */
/**
 * 🔴 **右クリックで表の形を変える**(#708 段②)── binder / reducer の側。
 *
 * ⚠ ここで見るのは「**押した所と、効く先が一致するか**」である ── 記法の側
 *   (どこからどこまでが表か / 何を断るか)は `tests/features/table-convert.test.ts`。
 *
 * ## 🔑 面は**本物の描画**から組む
 *
 * ⚠ 手で `<table data-pkc-source-line="…">` を書くと、**描画が実際に何を焼くか**を
 *   1 度も見ないことになる(2026-08-25 の「両端が相手を模した stub と話していた」)。
 *   だからここは `renderMarkdown` の出力をそのまま器へ入れ、**押した所から行番号が
 *   引けること**まで通しで見る。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyBodyRewrite, type BodyRewrite } from '../../src/features/markdown/body-rewrite';
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

function setup(body: string, phase: AppState['phase'] = 'ready') {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = '<div data-pkc-region="detail"><div data-pkc-field="detail-body"></div></div>';
  document.body.append(root);
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  /**
   * ⚠ **描くのは frontmatter を剥いだ本文**(`detail.ts` と同じ)── 剥がないと
   *   焼かれる行番号がずれ、`tableLineAt` の足し込みが**当たっているのか
   *   ずれているのか**が見えなくなる。
   */
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), {
    sourceLineAnchors: true,
    taskLineOffset: frontmatterLineCount(body),
    interactiveCells: true,
  } as never);
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase,
    selectedLid: 'n1',
    entryMetas: metasOf(['n1']),
    openBody: { lid: 'n1', body, baseline: body, persisted: body, diskAhead: false },
  });
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  bindActions(root, d, {});
  const rightClickAt = (sel: string): void => {
    const el = host.querySelector(sel);
    if (el === null) throw new Error(`前提が崩れている: ${sel} が描かれていない`);
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
  };
  return {
    root,
    d,
    events,
    host,
    rightClickAt,
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

const MD = '# 覚書\n\n| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n';
const CSV = '# 覚書\n\n```csv\n品名,数\nりんご,3\n```\n';

describe('右クリックで表の形を変える(#708 段②)', () => {
  it('🔴 markdown の表を右クリックすると「CSV の表にする」が出る', () => {
    const s = setup(MD);
    s.rightClickAt('table td');
    expect(s.labels()).toContain('table-to-csv:CSV の表にする');
    // ⚠ **反対側は出さない**(押しても何も起きない口を作らない)
    expect(s.labels().join(' '), '同じ形にする口まで出ている').not.toContain('table-to-markdown');
  });

  it('🔴 csv の囲みを右クリックすると「Markdown の表にする」が出る', () => {
    const s = setup(CSV);
    s.rightClickAt('.pkc-md-rendered-csv td');
    expect(s.labels()).toContain('table-to-markdown:Markdown の表にする');
    expect(s.labels().join(' '), '同じ形にする口まで出ている').not.toContain('table-to-csv');
  });

  it('⚠ 表の外(段落・見出し)では 1 つも出さない', () => {
    const s = setup(MD);
    s.rightClickAt('h1');
    expect(s.labels().join(' '), '表でない所で表の口が出た').not.toContain('table-to-');
    // 空振り防止 ── メニュー自体は出ている(見出しの物と本文の物)
    expect(s.labels().length, 'メニューが空(この検査が何も見ていない)').toBeGreaterThan(2);
  });

  /**
   * 🔴 **押した所と効く先が一致する**(#281 の再発を作らない)。
   *
   * ⚠ 行番号は**描画が焼いた値 + frontmatter の行数**である ── 足し忘れると
   *   frontmatter を持つノートでだけ**別の行を書き換える**。だから fixture に
   *   frontmatter を入れて、**生の body の行番号**が届くことを見る。
   */
  it('🔴 押した表の行番号が、生の body の座標で届く(frontmatter のぶんを足す)', () => {
    const body = `---\ntags: [x]\n---\n${MD}`;
    // 前提 ── 表は生の body の 5 行目から始まる(数え直しではなく、body を読む)
    expect(body.split('\n')[5], '前提: 表の見出しの行が 5 行目ではない').toBe('| 品名 | 数 |');
    const s = setup(body);
    s.rightClickAt('table td');
    s.press('table-to-csv');
    expect(s.events).toEqual([
      expect.objectContaining({
        type: 'REQUEST_BODY_REWRITE',
        lid: 'n1',
        rewrite: { kind: 'table-format', line: 5, to: 'csv' },
      }),
    ]);
  });

  it('🔴 押すと本当に本文が変わる(配線が繋がっている)', () => {
    const s = setup(MD);
    s.rightClickAt('table td');
    s.press('table-to-csv');
    const ev = s.events[0];
    expect(ev, '書換を頼んでいない').toBeDefined();
    // ⚠ **event を信じない** ── 実際に本文へ当てて、csv の囲みになることまで見る
    const next = applyBodyRewrite(MD, (ev as { rewrite: BodyRewrite }).rewrite);
    expect(next, '当てられなかった').not.toBeNull();
    expect(next, 'csv の囲みになっていない').toContain('```csv\n品名,数\nりんご,3\n```');
    expect(next, '見出しまで書き換えた').toContain('# 覚書');
  });

  /**
   * 🔴 **黙って断らない**(user 裁定 2026-09-04)。
   * ⚠ 断りは**画面に出る**(`state.error`)。⚠ そして**書換を頼んでいない**ことも
   *   併せて見る ── 理由だけ出して裏で書き換えていたら、いちばん悪い形である。
   */
  it('🔴 式が在る csv は断る ── 理由が画面に出て、書換は頼まない', () => {
    const s = setup('```csv\n数,単価,計\n2,100,=A2*B2\n```\n');
    s.rightClickAt('.pkc-md-rendered-csv td');
    s.press('table-to-markdown');
    expect(s.d.getState().error, '断りの理由が画面に出ていない').toContain('式');
    expect(s.events, '断ったのに書換を頼んだ').toEqual([]);
  });

  /**
   * 🔴 **編集中は理由を出して断る**(`edit-cell` / `shape-cell` と同じ作法)。
   * ⚠ 実物では本文が `textarea` に替わるので右クリックはまず来ないが、
   *   **受け手の側でも断る** ── 別の経路から来た日に、裏で本文を書き換えない。
   */
  it('🔴 編集中は理由を出して断る(裏で本文を書き換えない)', () => {
    const s = setup(MD, 'editing');
    s.rightClickAt('table td');
    s.press('table-to-csv');
    expect(s.events, '編集中に書換を頼んだ').toEqual([]);
    expect(s.d.getState().error, '断りの理由が出ていない').toContain('編集');
  });
});
