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
    /**
     * ⚠ **2 件持たせる** ── 「メニューを出したまま別のノートへ移る」を作るには
     *   移り先が台帳に無いと `SELECT_ENTRY` が通らない(台が崩れる)。
     */
    entryMetas: metasOf(['n1', 'n2']),
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

  /**
   * 🔴 **門は 2 つ在るので、2 つ目だけが鳴る場面を作る**(変異試験 S-4 が SURVIVED
   *   で教えた。CLAUDE.md §1「門を N 個置いたら N 通り作る」)。
   *
   * ⚠ 上の検査は binder 側の門(押す前に断る)しか通らないので、reducer 側の
   *   `phase !== 'ready'` を落としても緑のままだった。
   * 🔑 だから **reducer へ直に頼む** ── 別の経路から `SET_TABLE_FORMAT` が来た日に、
   *   裏で本文を書き換えないことを見る。
   */
  it('🔴 編集中は、頼まれても reducer が受けない(門の 2 段目)', () => {
    const s = setup(MD, 'editing');
    s.d.dispatch({ type: 'SET_TABLE_FORMAT', lid: 'n1', line: 2, to: 'csv' } as never);
    expect(s.events, '編集中なのに reducer が書換を頼んだ').toEqual([]);
    // 対照群 ── ready なら同じ頼みが通る(前提が崩れていないこと)
    const ok = setup(MD, 'ready');
    ok.d.dispatch({ type: 'SET_TABLE_FORMAT', lid: 'n1', line: 2, to: 'csv' } as never);
    expect(ok.events.length, 'ready でも受けていない(前提が崩れている)').toBeGreaterThan(0);
  });

  /**
   * 🔴 **押した後、何が起きたかを字で言う**(着地前レビュー・動線 ①)。
   *
   * ⚠ 直す前は**完全に無言**だった ── 本文が丸ごと書き換わるのに、画面に出る変化は
   *   「表の幅が変わる」だけで、user には**壊れたように見える**。
   * 🔑 言うのは**できるようになったこと**と**帰り道**の 2 つ ── 帰り道を知っているのが
   *   実装した本人だけ、という形にしない(#300 の実害と同じ型)。
   * ⚠ 対照群を同じ it に置く ── 別の書換(タグ)では出ないこと(= この分岐が効いている
   *   のであって、何にでも出る字ではない)。
   */
  it('🔴 表の形を変えた ack で、何ができるようになったかと戻し方が出る', () => {
    const s = setup(MD, 'ready');
    const csv = applyBodyRewrite(MD, { kind: 'table-format', line: 2, to: 'csv' } as BodyRewrite)!;
    expect(csv, '前提: 書き換わっていない').not.toBe(MD);
    const ack = (body: string, rewrite: BodyRewrite): void =>
      s.d.dispatch({
        type: 'BODY_REWRITTEN',
        lid: 'n1',
        body,
        rewrite,
        status: null,
        date: null,
        archived: false,
      } as never);
    ack(csv, { kind: 'table-format', line: 2, to: 'csv' } as BodyRewrite);
    const note = s.d.getState().notice ?? '';
    expect(note, '何が起きたか出ていない').toContain('CSV の表');
    expect(note, 'できるようになったことを言っていない').toContain('押すと');
    expect(note, '帰り道を言っていない').toContain('右クリック');

    // 対照群 ── 別の書換では、この字は出ない(何にでも出る字ではない)
    const s2 = setup(MD, 'ready');
    s2.d.dispatch({
      type: 'BODY_REWRITTEN',
      lid: 'n1',
      body: MD,
      rewrite: { kind: 'tag', add: ['x'], remove: [] } as never,
      status: null,
      date: null,
      archived: false,
    } as never);
    expect(s2.d.getState().notice ?? '', 'タグの書換でも表の字が出た').not.toContain('CSV の表');
  });

  /**
   * 🔴 **メニューを出したまま別のノートを選んだら、書き換えない**(変異試験 S-2 が
   *   SURVIVED で教えた)。
   *
   * ⚠ 行番号は**メニューを出したノートの座標**なので、そのまま通すと
   *   **別のノートのその行**が書き換わる(#281 の再発形)。
   * 🔑 `refuseStaleMenu` がその門で、押した所の身元と**いまの選択**を突き合わせる。
   */
  it('🔴 メニューを出したまま別のノートを選んだら、断って書き換えない', () => {
    const s = setup(MD, 'ready');
    s.rightClickAt('table td');
    /**
     * ⚠ 門が見ているのは `selectedLid` ではなく **`openBody.lid`** である
     *   (`menuStillFits`)── だから台も**開いている本文を差し替える**。
     *   選択だけ動かす形では、この門は 1 度も通らない。
     */
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' } as never);
    s.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: MD } as never);
    expect(s.d.getState().openBody?.lid, '前提: 開いている本文が替わっていない').toBe('n2');
    s.events.length = 0;
    s.press('table-to-csv');
    expect(s.events, '別のノートの本文を書き換えようとした').toEqual([]);
    expect(s.d.getState().notice, '断りの理由が出ていない').toContain('別のノート');
  });
});
