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
import { requestCellMove, takeCellMove } from '../../src/adapter/ui/render/cell-input';

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
  /**
   * 🔑 **留めた枠(スタック)として描く**(#505)── 器に `data-pkc-split-lid` が
   *   焼かれる。⚠ 中身は**別のノートの本文**なので、`openBody`(主の枠)の
   *   行番号で読んではいけない(着地前レビュー・実装 R1)。
   */
  splitLid: string | null = null,
) {
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
  const drawn = renderMarkdown(bodyBelowFrontmatter(body), {
    sourceLineAnchors: true,
    taskLineOffset: frontmatterLineCount(body),
    interactiveCells: true,
  } as never);
  host.innerHTML =
    splitLid === null ? drawn : `<div data-pkc-split-lid="${splitLid}">${drawn}</div>`;
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
  bindActions(root, d, services);
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

/**
 * 「▾」を押して小窓が組み上がるまで待つ。
 * 🔴 **開けたら必ず閉じる**(`closePick`)── `app-dialog` は**重なったときだけ列に
 *   並べる**ので、開きっぱなしにすると**次の `pick` が 1 マイクロタスクでは開かない**。
 *   ⚠ 実際に踏んだ:1 つの `it` で 2 回開いたら 2 回目が 0 行に見え、
 *   さらに**次の `it` まで巻き添え**にした(検査が製品ではなく台のせいで落ちる)。
 */
async function openPick(host: HTMLElement): Promise<HTMLElement[]> {
  const menu = host.querySelector<HTMLElement>('[data-pkc-copy-menu]');
  if (menu === null) throw new Error('前提が崩れている: ▾ が描かれていない');
  menu.click();
  await Promise.resolve();
  return [...document.querySelectorAll<HTMLElement>('[data-pkc-field="pick-copy-format"]')];
}

/** いま開いている小窓の題名。⚠ 題名は**中身と一致**していなければならない(動線 D5)。 */
function pickTitle(): string {
  return document.querySelector('[data-pkc-field="dialog-title"]')?.textContent ?? '';
}

async function closePick(): Promise<void> {
  document.querySelector<HTMLElement>('[data-pkc-field="dialog-cancel"]')?.click();
  await Promise.resolve();
}
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
   * 🔴 **留めた枠の ▾ から、主の枠のノートを書き換えない**
   * (着地前レビュー・実装 R1、2026-09-06。**実ブラウザで再現された**)。
   *
   * ⚠ `convert()` は `tableLineAt` も `tableAt` も **`openBody`(主の枠)の本文**で
   *   読むので、**留めた枠**(別のノート)の表で押すと、押した物ではなく
   *   **主の枠のノート**が csv に化けた。画面では留めた枠が変わらないので、
   *   user は自分の操作を疑わない ── 押した物と壊れた物が別、の型である。
   * ⚠ 同じ handler の 10 行下(`noteTitle`)は `lidOfNode` を通していた ──
   *   **隣に足した口だけがその 1 本を外れていた**(#281 で 1 度直した罠の 3 度目)。
   * 🔑 いまは「押した所の持ち主 ≠ 開いている本文」なら**行を出さない**。
   *
   * ⚠ **対照群を同じ it に置く** ── 留めた枠で 5 行なのは「▾ がそもそも
   *   出ていない」でも成り立つので、**同じ表を主の枠で描いた台**で 6 行出ることを見る。
   */
  it('🔴 留めた枠の ▾ には「本文を書き換える」行を出さない(主の枠を書き換えない)', async () => {
    // ── 対照群 ── 主の枠なら 6 行目が出る
    const main = setup(MD);
    expect(
      (await openPick(main.host)).length,
      '対照群が鳴っていない ── 主の枠でも書き換える行が出ていない',
    ).toBe(6);
    expect(pickTitle(), '書き換える行が在るのに題名が名乗っていない').toBe(
      'この表をコピー / 書き換える',
    );
    await closePick();

    // ── 本題 ── 留めた枠(別ノート)では出さない
    const split = setup(MD, 'ready', {}, 'n2');
    expect((await openPick(split.host)).length, '留めた枠の ▾ に、主の枠を書き換える行が出た').toBe(
      5,
    );
    expect(
      document.querySelectorAll('[data-pkc-field="pick-copy-format-sep"]').length,
      '書き換える行が無いのに区切りだけ出た',
    ).toBe(0);
    /**
     * 🔴 **題名は、在る物だけを名乗る**(着地前レビュー・動線 D5)。
     * ⚠ 行が無いのに「書き換える」と名乗ると、user は「壊れている」か
     *   「自分の押し方が悪い」と読む(約束だけが残る)。
     */
    expect(pickTitle(), '書き換える行が無いのに題名が約束している').toBe('この表をコピー');
    await closePick();
  });

  /**
   * 🔴 **区切りは「書き換える行の上」に在る**(着地前レビュー・実装 R4)。
   *
   * ⚠ 直す前の検査は区切りを `toHaveCount(1)` でしか見ていなかったので、
   *   **線を一番下へ動かす変異が生き延びた** ── そうなると書き換える行が
   *   コピーの 5 つと**地続き**になり、**この裁定が防ごうとした当のもの**
   *   (コピーのつもりで本文が変わる)が戻る。
   * 🔑 だから**位置**で見る ── 線より下に在る行は 1 つだけである。
   */
  it('🔴 区切りより下に在るのは、書き換える 1 行だけ', async () => {
    const s = setup(MD);
    expect((await openPick(s.host)).length, '前提が崩れている: 小窓が開いていない').toBe(6);
    const sep = document.querySelector('[data-pkc-field="pick-copy-format-sep"]');
    expect(sep, '前提が崩れている: 区切りが出ていない').not.toBeNull();
    const below = [...(sep!.parentElement?.children ?? [])]
      .slice([...(sep!.parentElement?.children ?? [])].indexOf(sep!) + 1)
      .filter((e) => e.getAttribute('data-pkc-field') === 'pick-copy-format');
    expect(below.length, '区切りより下が 1 行になっていない').toBe(1);
    expect(below[0]?.textContent, '区切りより下がコピーの行になっている').toContain('書き換える');
    await closePick();
  });

  /**
   * 🔴 **忙しい間に止めるのは「書く 1 行」だけで、コピーは止めない**
   * (#708 裁定②の着地前レビュー・動線 D3、2026-09-06)。
   *
   * ⚠ 1 稿目は `copy-md-block` を **action の名前**で `BODY_WRITE_ACTIONS` に載せた。
   *   ところがその名前は表だけの受け手ではなく、**コードの囲み・mermaid / chart /
   *   html / svg の ⧉** も同じ名前で受ける ── つまり**コピーが 1 つ残らず止まる**。
   *   ⚠ そのうえ `busy` は書き出し / 取込だけでなく**添付の取り込み**でも真になるので、
   *   写真を 1 枚入れた直後にコードをコピーすると「書き出し / 取込が実行中です」と出た
   *   (押した所と理由が食い違う)。
   * 🔑 いまは門を `applyTableFormat`(**書く瞬間**)へ移してある。
   *
   * ⚠ **対照群を同じ it に置く**(CLAUDE.md §1)── 台が `busy` を渡せていないだけで
   *   「止まらなかった」と読めてしまう。だから**止まるはずの物**(`edit-cell`)が
   *   同じ台で本当に止まることを先に見る。
   */
  it('🔴 忙しい間でも、コードの囲みの ⧉ は断られない(止まるのは書く操作だけ)', () => {
    const body = '# 覚書\n\n```js\nconst a = 1;\n```\n\n| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n';

    /**
     * ── 対照群 ── 止まるはずの物は、この台で本当に止まる。
     * ⚠ **台を分ける**(同じ台で続けて押さない)── 断りは `state.error` に残るので、
     *   1 つの台で 2 つ押すと「消し忘れた前の断り」と「新しい断り」が**同じ字**になり、
     *   区別できない(消す口を足すより、台を 2 つ作るほうが読める)。
     */
    const ctrl = setup(body, 'ready', { busy: () => true });
    const cell = ctrl.host.querySelector<HTMLElement>('[data-pkc-action="edit-cell"]');
    expect(cell, '前提が崩れている: 升に押し所が焼かれていない').not.toBeNull();
    cell!.click();
    expect(ctrl.d.getState().error, '対照群が鳴っていない ── 台が busy を渡せていない').toContain(
      '書き出し / 取込が実行中です',
    );

    // ── 本題 ── コピーは読むだけなので止めない
    const s = setup(body, 'ready', { busy: () => true });
    const copy = s.host.querySelector<HTMLElement>('[data-pkc-copy-kind="code"]');
    expect(copy, '前提が崩れている: コードの囲みに ⧉ が無い').not.toBeNull();
    copy!.click();
    expect(s.d.getState().error, '忙しいだけでコピーまで断られた').toBeNull();
  });

  /**
   * 🔴 **止めるほうは、その操作の言葉で断る**(同 D3)。
   *
   * ⚠ 名前の門の字は「書き出し / 取込が実行中です」だが、`busy` は**添付の取り込み**
   *   でも真になるので、**書き出しも取込もしていない user** がその字を読むことがある。
   * 🔑 書く瞬間の門は、**何ができないか**を言う。
   * ⚠ **対照群**(忙しくない同じ台)を同じ it に置く ── 置かないと「別の理由で
   *   書換が来なかった」と区別できない。
   */
  it('🔴 忙しい間に表の形を変えようとすると、その操作の言葉で断る(裏で書き換えない)', () => {
    const busy = setup(MD, 'ready', { busy: () => true });
    busy.rightClickAt('table td');
    busy.press('table-to-csv');
    expect(busy.events, '忙しいのに書換を頼んだ').toEqual([]);
    expect(busy.d.getState().error, '断りの理由が出ていない').toBe(
      '取り込みが終わってから、表の形を変えてください',
    );

    // ── 対照群 ── 忙しくなければ同じ手順で書換が届く
    const free = setup(MD, 'ready', { busy: () => false });
    free.rightClickAt('table td');
    free.press('table-to-csv');
    expect(free.events, '忙しくないのに書換が来ない ── 台が壊れている').toHaveLength(1);
    expect(free.d.getState().error, '忙しくないのに断られた').toBeNull();
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
    /**
     * 🔴 **できるようになったことを言う**(#708 段④ で字を直した)。
     * ⚠ それまでは「升を押して打てます」と言っていたが、段④ で**markdown の表の升も
     *   押せる**ようになったので、その字は**両方で真 = 何も伝えていない**。
     *   いま形で変わるのは**行・列の ＋ ×** と**式**である。
     */
    expect(note, '形で何が変わるかを言っていない').toContain('行と列');
    expect(note, '式のことを言っていない').toContain('式');
    /**
     * 🔴 **帰り道は「▾」で言う**(着地前レビュー・動線 D1、2026-09-06)。
     * ⚠ ここは 2026-09-05 まで「右クリック」を pin していた ── ところが
     *   **指で触る端末に右クリックは無い**ので、この裁定(#708 裁定②)で
     *   入口を足した当の user に、**その端末に無い操作**で戻れと言っていた。
     * ⚠ だから**「右クリック」が戻っていないことも見る** ── 字を書き戻す変異が
     *   「▾ を含む」だけの検査では生き延びる(両方書けば通ってしまう)。
     */
    expect(note, '帰り道を言っていない').toContain('▾');
    expect(note, '指の端末に無い操作で戻れと言っている').not.toContain('右クリック');
    // 🔴 **往復で落ちる物も同じ 1 行で言う**(同 D6)── 「戻せます」だけは嘘に近い
    expect(note, '桁揃えが戻らないことを言っていない').toContain('桁揃え');

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

/**
 * 🔴 **表の升の中のリンクは、リンクとして働く**(#708 段④、着地前レビュー・動線 ③)。
 *
 * ⚠ 升そのものが `edit-cell` の印を持つので、升の中の `<a>` を押すと
 *   **`closest` が升まで登って、リンクではなく入力欄が開く**。
 *   実害:表にリンクを並べるのは markdown の表のいちばん普通の使い方なのに、
 *   **そこだけリンクが死ぬ**(しかも開かない理由はどこにも出ない)。
 */
describe('表の升の中のリンク(#708 段④)', () => {
  const LINKED = '| 参考 | [公式](https://example.com) |\n|---|---|\n| 次 | ふつうの字 |\n';

  it('🔴 升の中のリンクを押しても、入力欄が開かない', () => {
    setup(LINKED, 'ready');
    const link = document.querySelector<HTMLElement>('[data-pkc-field="detail-body"] a[href]');
    expect(link, '前提: 升の中にリンクが描かれていない').not.toBeNull();
    link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(
      document.querySelector('[data-pkc-field="cell-input"]'),
      'リンクを押したら升の入力欄が開いた',
    ).toBeNull();
  });

  it('⚠ 対照群 ── リンクでない升を押せば、いままでどおり欄が開く', () => {
    setup(LINKED, 'ready');
    const cells = [
      ...document.querySelectorAll<HTMLElement>('[data-pkc-action="edit-cell"]'),
    ];
    const plain = cells.find((c) => c.querySelector('a[href]') === null);
    expect(plain, '前提: リンクの無い升が無い').toBeDefined();
    plain!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(
      document.querySelector('[data-pkc-field="cell-input"]'),
      'ふつうの升で欄が開かない',
    ).not.toBeNull();
  });
});

/**
 * 🔴 **`Tab` / `Enter` で、確定して隣の升へ移る**(#750 I1。user 裁定 2026-09-06)。
 *
 * ⚠ ここは**受け口**を見る(押した鍵が、確定と行き先の予約になっているか)。
 *   隣の選び方は `cell-input.test.ts`、打った字が本文へ入るところまでは
 *   実ブラウザの smoke が見る。
 */
describe('表の升で Tab / Enter を押す(#750 I1)', () => {
  /** 升の押し所(描画が焼いた順)。 */
  const cells = (host: HTMLElement): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>('[data-pkc-action="edit-cell"]'),
  ];
  const openInput = (host: HTMLElement): HTMLInputElement | null =>
    host.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]');

  /** 升を開いて、打ちかけの字を入れ、鍵を押す。 */
  function press(
    host: HTMLElement,
    nth: number,
    value: string | null,
    key: string,
    shift = false,
  ): void {
    cells(host)[nth]!.click();
    const input = openInput(host);
    if (input === null) throw new Error('前提が崩れている: 欄が開いていない');
    if (value !== null) input.value = value;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }),
    );
  }

  it('🔴 字を変えて Tab を押すと、確定して「右の升」を予約する', () => {
    requestCellMove(null);
    const s = setup(MD);
    press(s.host, 2, 'みかん', 'Tab'); // 2 = 「りんご」(見出しの 2 つの次)
    // ① 確定した(本文の書換を頼んでいる)
    expect(s.events, '確定していない(Tab で字が捨てられている)').toHaveLength(1);
    // ② 行き先を預けた ── 実際に開くのは `detail.ts` が塊を差し替えた後
    expect(takeCellMove(), '右の升を預けていない').toEqual({ line: '4', col: '1' });
  });

  it('🔴 Enter は「同じ列の下」を予約する(右ではない)', () => {
    requestCellMove(null);
    const s = setup(MD);
    press(s.host, 0, 'しなもの', 'Enter'); // 0 = 見出しの「品名」
    expect(s.events, '確定していない').toHaveLength(1);
    expect(takeCellMove(), '下の升を預けていない').toEqual({ line: '4', col: '0' });
  });

  it('🔴 Shift+Tab は「左の升」(片道の操作を作らない)', () => {
    requestCellMove(null);
    const s = setup(MD);
    press(s.host, 3, '5', 'Tab', true); // 3 = 「3」
    expect(takeCellMove(), '左の升を預けていない').toEqual({ line: '4', col: '0' });
  });

  it('🔴 字が変わっていない回は、書き戻しを待たずにその場で隣を開く', () => {
    /**
     * ⚠ 変わっていなければ `SET_CSV_CELL` は撃たれない = **描き直しが来ない**ので、
     *   予約だけして待つと**押したのに何も起きない**(次の無関係な描き直しまで)。
     */
    requestCellMove(null);
    const s = setup(MD);
    press(s.host, 2, null, 'Tab'); // 字はそのまま
    expect(s.events, '変えていないのに書換を頼んだ').toEqual([]);
    expect(takeCellMove(), '待つ必要が無いのに予約した').toBeNull();
    // 🔑 その場で隣が開いている
    expect(openInput(s.host)?.value, '隣の升の欄が開いていない').toBe('3');
  });

  it('🔴 自分で別の升を押したら、預けた行き先は捨てる', () => {
    /**
     * ⚠ 予約を残すと、**後から届いた書き戻し**で「押していない升」が開く ──
     *   user は自分が押した升に打っているつもりなので、**打った字が別の升へ入る**。
     * 🔑 だから**升を開いた時点**で捨てる(取り消しはその 1 か所だけ)。
     * ⚠ 変異試験 M5 が SURVIVED で教えた ── 予約を捨てる行を消しても、
     *   これを足すまでどの検査も鳴らなかった。
     */
    requestCellMove(null);
    const s = setup(MD);
    press(s.host, 2, 'みかん', 'Tab'); // ここで (4,1) を預ける
    cells(s.host)[0]!.click(); // user が自分で別の升を押す
    expect(takeCellMove(), '別の升を押したのに、前の行き先が残っている').toBeNull();
  });

  it('🔴 行き先が無ければ、いままでどおり閉じる(動かない欄を残さない)', () => {
    requestCellMove(null);
    const s = setup(MD);
    press(s.host, 3, 'みかん', 'Tab'); // 3 = 最後の升
    expect(s.events, '確定していない').toHaveLength(1);
    expect(takeCellMove(), '行き先が無いのに預けた').toBeNull();
    expect(openInput(s.host), '行き先が無いのに欄が残っている').toBeNull();
  });

});
