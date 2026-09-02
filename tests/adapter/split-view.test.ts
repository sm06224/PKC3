/** @vitest-environment happy-dom */
/**
 * 🔴 **読む面を横に並べる**(#505 段②)── 画面に何が出るか。
 *
 * ⚠ ここで**いちばん大事な 1 件**は「留めた枠に `detail-*` が生えないこと」である。
 * 生えると、本文を押したときの受け手(`binder.ts` の
 * `closest('[data-pkc-field="detail-body"]')` が 4 か所)が**留めた枠の押しを
 * 主の枠の押しとして扱う** ── 留めた枠の行番号で**選んでいるノートを書き換える**、
 * という「押した物と効く先が食い違う」事故になる。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { setFoldNotify } from '../../src/adapter/ui/render/fold-notify';
import { SPLIT_PINNED_MAX } from '../../src/features/split-frames';
import { bindActions } from '../../src/adapter/ui/actions/binder';

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function boot(
  /** ⚠ 既定は 2 件。⚠ 「横に出せる数(3)を超えた」を見る test は増やして呼ぶ。 */
  extra: readonly string[] = [],
): { root: HTMLElement; d: Dispatcher; center: CenterRouter; said: string[] } {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-region', 'detail');
  document.body.append(root);
  const said: string[] = [];
  /**
   * 🔴 **製品と同じ口を使う**(#606。2026-08-30)。
   * ⚠ 直す前はここで `CenterRouter` の 6 番目の引数に自前の口を渡していた ──
   *   ところが **`main.ts` は渡していなかった**ので、この test は緑のまま
   *   **製品では 1 度も帯が出ていなかった**(CLAUDE.md §7
   *   「両端が相手を模した stub と話していると、綴りの食い違いが両方緑のまま通る」)。
   * 🔑 口を 1 つに寄せたので、**台が偽装できなくなった** ── ここで配るのは
   *   `main.ts:873` が配るのと**同じ口**である。
   */
  setFoldNotify((t) => said.push(t));
  const center = new CenterRouter(root, undefined, null, undefined, undefined);
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      { lid: 'a', title: '資料 A', archetype: 'text' },
      { lid: 'b', title: '資料 B', archetype: 'text' },
      ...extra.map((lid) => ({ lid, title: `資料 ${lid}`, archetype: 'text' })),
    ] as never,
    relations: [],
  });
  d.onState((s) => center.render(s));
  return { root, d, center, said };
}

/** その面に在る `data-pkc-field` の値を全部。 */
function fieldsIn(el: Element): string[] {
  return [...el.querySelectorAll('[data-pkc-field]')].map(
    (n) => n.getAttribute('data-pkc-field') ?? '',
  );
}

/**
 * 🔴 **スタックの帯**(#633 段①。user 裁定 2026-09-02 ②④)。
 *
 * ⚠ ここが守るのは **#584 の片道が閉じたこと**である ── 直す前は「× 降ろす」が
 *   **枠の中にしか無かった**ので、幅で枠が畳まれると**降ろす口が画面から消えて**いた。
 *   🔴 しかも PR #649 で並びが憶えられるようになったので、開き直しても
 *   **毎回同じ行き止まりから始まる**状態だった。
 */
describe('スタックの帯(#633 段①)', () => {
  /** 帯に出ている札の名前(押す側のボタンの字)。 */
  const cards = (root: HTMLElement): string[] =>
    [...root.querySelectorAll('[data-pkc-field="stack-card"] [data-pkc-action="pin-split"]')].map(
      (n) => n.textContent ?? '',
    );

  it('🔴 何も載せていなければ、帯は DOM に置かない(版面を食わない)', async () => {
    const { root } = boot();
    await settle();
    expect(
      root.querySelectorAll('[data-pkc-region="stack-bar"]'),
      '何も載せていないのに帯を置いている',
    ).toHaveLength(0);
  });

  it('🔴 新しく載せた物が一番上(帯の左端)に来る', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    expect(cards(root), '載せた順が逆(古い物が隣に残っている)').toEqual(['資料 B', '資料 A']);
  });

  it('🔴 札を押すと一番上へ上がる(件数は増えない)', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    // ⚠ 前提: いま一番上は「資料 B」(でなければ、押しても何も変わらず空振り)
    expect(cards(root)[0], '前提が崩れている').toBe('資料 B');
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    await settle();
    expect(cards(root), '押しても上がらない / 増えた').toEqual(['資料 A', '資料 B']);
  });

  /**
   * 🔴 **これが #584 の当の経路** ── 帯の × は、**枠が 1 つも出ていなくても**押せる。
   * ⚠ 台は `measure` が `null` を返す(happy-dom)ので枠は畳まれないが、
   *   **帯が枠と別の場所に在る**ことは見られる ── 畳まれた状態そのものは
   *   smoke(実ブラウザ)が見る。
   */
  it('🔴 帯の × は枠の外に在る(枠が畳まれても降ろせる)', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    const band = root.querySelector('[data-pkc-region="stack-bar"]');
    expect(band, '帯が無い').not.toBeNull();
    /**
     * 🔴 **帯は「枠の器」の外に在る** ── 器(`split-row`)の中に入れると、
     *   幅で枠が畳まれたときに**帯まで横へ並んで潰れる / 一緒に消える**。
     * ⚠ 変異試験 M4(`row.append(el)`)が生き延びて教えた ── 1 稿目は
     *   `split-frame` の中かどうかしか見ておらず、**器の中は素通り**だった。
     */
    expect(
      band!.closest('[data-pkc-region="split-row"]'),
      '帯が枠の器の中に在る(畳むと一緒に消える)',
    ).toBeNull();
    expect(
      band!.closest('[data-pkc-region="split-frame"]'),
      '帯が枠の中に在る(枠が消えると一緒に消える)',
    ).toBeNull();
    // 🔑 置き場は**器の直前**(= 本文の上の 1 行)
    expect(
      band!.nextElementSibling?.getAttribute('data-pkc-region'),
      '帯が本文の上に無い',
    ).toBe('split-row');
    const off = band!.querySelector('[data-pkc-action="unsplit-entry"]');
    expect(off, '帯に降ろす口が無い').not.toBeNull();
    expect(off!.closest('[data-pkc-lid]')?.getAttribute('data-pkc-lid')).toBe('b');
  });

  /**
   * 🔴 **いま横に出ている札には印が付く**(#633 段①)。
   * ⚠ 台(happy-dom)は採寸しないので**全部が出ている**扱いになる ── ここで見るのは
   *   「**印そのものが在るか**」である(出ている物と出ていない物の差は smoke が見る)。
   * ⚠ 変異試験 M5(印を付けない)が生き延びて教えた。
   */
  it('🔴 横に出ている札には印が付く', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    const card = root.querySelector('[data-pkc-field="stack-card"]');
    expect(card, '札が無い').not.toBeNull();
    expect(
      card!.hasAttribute('data-pkc-shown'),
      '出ているのに印が無い(押しても画面が変わらない札と見分けが付かない)',
    ).toBe(true);
  });

  /**
   * 🔴 **札を押したら「その札の物」が上がる**(#633 裁定④)。
   *
   * ⚠ **配線の test である** ── 帯は `split-view.ts` が描き、身元を読むのは
   *   `binder.ts` の受け手なので、**どちらの test にも書けない**(§7)。
   * ⚠ 変異試験 M7(身元を無視して `selectedLid` を載せる)が生き延びて教えた ──
   *   直す前の受け手は**いつでも `selectedLid`** だったので、札の名前と
   *   起きることが食い違う(別のノートが上がる)。
   */
  it('🔴 札を押すと、その札のノートが上がる(選んでいるノートではない)', async () => {
    const { root, d } = boot();
    bindActions(root, d, {});
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    await settle();
    // ⚠ 前提 ── 一番上は「資料 B」で、選んでいるのも 'b'(押す札とは別の物)
    expect(d.getState().splitLids[0], '前提が崩れている').toBe('b');
    expect(d.getState().selectedLid, '前提が崩れている').toBe('b');
    const cardA = root.querySelector<HTMLElement>(
      '[data-pkc-field="stack-card"][data-pkc-lid="a"] [data-pkc-action="pin-split"]',
    );
    expect(cardA, '「資料 A」の札が無い').not.toBeNull();
    cardA!.click();
    await settle();
    expect(
      d.getState().splitLids[0],
      '押した札ではなく、選んでいるノートが上がった',
    ).toBe('a');
  });

  it('🔴 名前は entryMetas から引く(改名に追随する)', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    expect(cards(root)).toEqual(['資料 B']);
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'b', title: '資料 B(改)' });
    await settle();
    expect(cards(root), '帯が古い名前のまま').toEqual(['資料 B(改)']);
  });

  /**
   * 🔴 **「畳みました」は幅の話のときだけ言う**(#633 段①)。
   * ⚠ スタックは 20 件まで積めるが、横に出るのはもともと 3 枠まで ──
   *   総数から引くと「17 枚畳みました」と毎回言うことになる(帯に札で出ているので
   *   user は失っていない)。
   */
  it('🔴 横に出せる数を超えて載せても、「畳みました」とは言わない', async () => {
    const { d, said, root } = boot(['c', 'd', 'e']);
    for (const lid of ['a', 'b', 'c', 'd', 'e']) d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid });
    await settle();
    /**
     * ⚠ **前提を assert する**(§1)── 横に出せる数(3)を**本当に超えて**いること。
     *   超えていなければ、この test は「畳んだと言わない」を**当たり前に**通す(空振り)。
     *   ⚠ 変異試験 M6(総数で数える)が生き延びて教えた ── 1 稿目は 2 件しか載せて
     *   いなかったので、総数で数えても差が出なかった。
     */
    expect(
      root.querySelectorAll('[data-pkc-field="stack-card"]').length,
      '前提が崩れている: 横に出せる数を超えていない',
    ).toBeGreaterThan(SPLIT_PINNED_MAX);
    expect(said, '幅の話でないのに畳んだと言った').toEqual([]);
  });
});

describe('既定は 1 枠 ── 何も留めなければ画面は変わらない', () => {
  /**
   * 🔴 **見るのは「器が在るか」ではなく「送りの持ち主が誰か」**である。
   *
   * ⚠ 1 稿目は `split-row` が 0 件であることを見ていたが、実装は**器を最初から
   * 作る**形に変わった(主の renderer が器を握るので後から差し替えられない)。
   * 🔑 器が在ること自体は害ではない ── 害になるのは
   * **`DetailRenderer` の送りの持ち主(`scroller`)が外の器から移ってしまう**ことで、
   * それは `closest('[data-pkc-region="split-frame"]')` が当たるかで決まる。
   * だから**そこを見る**。
   */
  it('🔴 印が付かず、送りの持ち主も今までどおり(外の器)', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    await settle();
    expect(root.querySelector('[data-pkc-view-pane="detail"]')?.hasAttribute('data-pkc-split')).toBe(
      false,
    );
    const body = root.querySelector('[data-pkc-field="detail-body"]');
    // ⚠ 前提: 主の枠は描けている(空振りで通っていない)
    expect(body).not.toBeNull();
    expect(root.querySelector('[data-pkc-field="detail-title"]')?.textContent).toBe('資料 A');
    // 🔑 `scroller` が掴むのはこれ ── 当たらない = 外の器のまま
    expect(body!.closest('[data-pkc-region="split-frame"]')).toBeNull();
  });

  it('🔴 留めると、主の枠も自分で送るようになる(枠ごとに送る)', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    const body = root.querySelector('[data-pkc-field="detail-body"]')!;
    expect(body.closest('[data-pkc-region="split-frame"]')).not.toBeNull();
    expect(root.querySelector('[data-pkc-view-pane="detail"]')?.getAttribute('data-pkc-split')).toBe(
      'on',
    );
  });
});

describe('留めると横に並ぶ', () => {
  it('🔴 枠が出て、その中に留めたノートの題名と本文が出る', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'b', body: '# B の本文\n' });
    await settle();
    const frame = root.querySelector('[data-pkc-split-lid="b"]');
    expect(frame).not.toBeNull();
    expect(frame!.querySelector('[data-pkc-field="split-title"]')?.textContent).toBe('資料 B');
    expect(frame!.textContent).toContain('B の本文');
  });

  it('🔴 留めた枠に `detail-*` は 1 つも生えない(押した物と効く先を食い違わせない)', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'b', body: '# B\n' });
    await settle();
    const frame = root.querySelector('[data-pkc-split-lid="b"]')!;
    // ⚠ 前提: この枠に field が 1 つ以上在る(空の枠を「無い」と読まない)
    expect(fieldsIn(frame).length).toBeGreaterThan(0);
    expect(fieldsIn(frame).filter((f) => f.startsWith('detail-'))).toEqual([]);
    // 🔑 主の枠のほうは今までどおり `detail-*` である
    const main = root.querySelector('[data-pkc-split-main]')!;
    expect(fieldsIn(main)).toContain('detail-body');
  });

  it('🔴 留めた枠には帯(編集など)を出さない ── 直るのは主の枠のほうだから', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'b', body: '# B\n' });
    await settle();
    const frame = root.querySelector('[data-pkc-split-lid="b"]')!;
    expect(frame.querySelector('[data-pkc-action="start-edit"]')).toBeNull();
    // ⚠ 前提: 主の枠には在る(「そもそも帯が無い」で通っていない)
    const main = root.querySelector('[data-pkc-split-main]')!;
    expect(main.querySelector('[data-pkc-action="start-edit"]')).not.toBeNull();
  });

  /**
   * 🔴 **降ろす口は 2 つある**(#633 段①)── 枠の帯と、本文の上のスタックの帯。
   *
   * ⚠ 直す前は**枠の中の 1 か所だけ**だったので、幅で枠が畳まれると
   *   **降ろす口が画面から消えて**いた(#584 の片道)。
   * 🔑 どちらの口も、身元は**近い先祖の `data-pkc-lid`** が持つ(受け手は 1 つ)。
   */
  it('🔴 降ろす口が在る(置けるなら外せる)', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    const offs = [...root.querySelectorAll('[data-pkc-action="unsplit-entry"]')];
    expect(offs.length, '降ろす口が無い').toBeGreaterThan(0);
    for (const off of offs)
      expect(
        off.closest('[data-pkc-lid]')?.getAttribute('data-pkc-lid'),
        '降ろす口が身元を持っていない(押しても何が降りるか決まらない)',
      ).toBe('b');
    // 🔑 **枠の外(帯)にも 1 つ在る** ── 幅で枠が畳まれても降ろせる(#584)
    const inBand = root.querySelectorAll(
      '[data-pkc-region="stack-bar"] [data-pkc-action="unsplit-entry"]',
    );
    expect(inBand.length, '帯に降ろす口が無い(畳まれたら降ろせない)').toBe(1);
  });

  it('🔴 外すと枠ごと消え、器も畳まれる', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    expect(root.querySelectorAll('[data-pkc-split-lid]')).toHaveLength(1);
    d.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    expect(root.querySelectorAll('[data-pkc-split-lid]')).toHaveLength(0);
    // 🔑 印が外れる = CSS も送りの持ち主も**今までどおり**へ戻る
    expect(root.querySelector('[data-pkc-view-pane="detail"]')?.hasAttribute('data-pkc-split')).toBe(
      false,
    );
    // 🔑 畳んだ後も主の枠は生きている(器の出し入れで壊していない)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    await settle();
    expect(root.querySelector('[data-pkc-field="detail-title"]')?.textContent).toBe('資料 A');
  });
});

describe('🔴 留めても、いま読んでいる位置が飛ばない(変異試験 M5 が空いていた)', () => {
  /**
   * ⚠ `DetailRenderer` は骨組みを組み直したあと `scroller.scrollTop` を戻す。
   * その `scroller` は「**いちばん近い枠、無ければ外の器**」で決まる ──
   * 🔴 **枠を見る側を落とすと、留めた枠の初回描画が外の器を 0 へ戻す** =
   * user から見れば「横に留めたら、読んでいた場所が先頭へ飛んだ」。
   * ⚠ これは DOM の形(親が居るか)を見る test では死なない ── **位置そのもの**を見る。
   */
  it('留めた枠を出しても、外の器の送りは動かない', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    await settle();
    root.scrollTop = 300;
    // ⚠ 前提: 送れたこと(0 のままなら空振り)
    expect(root.scrollTop).toBe(300);
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'b', body: '# B\n' });
    await settle();
    expect(root.scrollTop, '留めたら読んでいた場所が飛んだ').toBe(300);
  });
});

describe('🔴 一覧を押しても、留めた枠は動かない', () => {
  it('主の枠だけ入れ替わる', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'b', body: '# B\n' });
    await settle();
    const main = root.querySelector('[data-pkc-split-main]')!;
    expect(main.querySelector('[data-pkc-field="detail-title"]')?.textContent).toBe('資料 A');
    // 別のノートを開く
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: '# B\n' });
    await settle();
    expect(main.querySelector('[data-pkc-field="detail-title"]')?.textContent).toBe('資料 B');
    // 🔑 留めた枠は「資料 B」のまま(消えていない・入れ替わっていない)
    const frame = root.querySelector('[data-pkc-split-lid="b"]');
    expect(frame).not.toBeNull();
    expect(frame!.querySelector('[data-pkc-field="split-title"]')?.textContent).toBe('資料 B');
  });
});

describe('🔴 知らないノートの枠は出さない(変異試験 M12 が空いていた)', () => {
  /**
   * ⚠ 「消したら消える」は **reducer 側**(`removeEntryFromState`)が守っている ──
   * だから描画側の絞り(`knownSplitLids`)を外しても、その test では死なない。
   * 🔑 描画側が守っているのは**別の場面**である:憶えていた並びを起動時に戻したが、
   * そのノートが**もう居ない**とき。effect が本文 `null` を受けて外すまでの間、
   * ここが止めていないと **開けない lid を指す空の枠**が出る。
   */
  it('起動で戻した並びに居ないノートが混ざっていても、枠は出ない', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SPLIT_RESTORED', lids: ['b', 'gone'] });
    await settle();
    // ⚠ 前提: 片方は在るので、枠は 1 つ出る(「そもそも出ない」で通っていない)
    expect(root.querySelectorAll('[data-pkc-split-lid]')).toHaveLength(1);
    expect(root.querySelector('[data-pkc-split-lid="gone"]')).toBeNull();
    // 🔑 state には残っている(黙って忘れない ── 外すのは effect の仕事)
    expect(d.getState().splitLids).toEqual(['b', 'gone']);
  });
});

describe('🔴 編集に入っても、分割は解かない(user 裁定 2026-08-28)', () => {
  /**
   * ⚠ 設計の初稿は「編集に入ったら分割を解く」だった ── 理由は user の字が
   * 「**閲覧時に**分割したい」だったから。🔴 **その読みは狭かった**。
   * 段組み(段①)で同じ判断を一度し、**#543 で覆されている**:
   * 「段組のままでインライン編集がしたい」。⚠ 段② で繰り返さない。
   */
  it('編集に入っても、留めた枠は出たまま', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'b', body: '# B\n' });
    await settle();
    expect(root.querySelectorAll('[data-pkc-split-lid]')).toHaveLength(1);
    d.dispatch({ type: 'START_EDIT' });
    await settle();
    // ⚠ 前提: 本当に編集へ入ったこと(空振りで通っていない)
    expect(d.getState().phase).toBe('editing');
    expect(root.querySelectorAll('[data-pkc-split-lid]'), '編集に入ったら枠が消えた').toHaveLength(1);
    expect(
      root.querySelector('[data-pkc-split-lid] [data-pkc-field="split-body"]'),
      '編集中に留めた枠の本文が消えた',
    ).not.toBeNull();
  });
});

describe('消したノートの枠は残らない', () => {
  it('🔴 消すと枠も消える', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    expect(root.querySelectorAll('[data-pkc-split-lid]')).toHaveLength(1);
    d.dispatch({ type: 'DELETE_ENTRIES', lids: ['b'] });
    await settle();
    expect(root.querySelectorAll('[data-pkc-split-lid]')).toHaveLength(0);
  });
});

/**
 * 🔴 **枠を畳んだら、帯に理由が出る**(#606。2026-08-30)。
 *
 * ## ⚠ この文言は、いままで**誰も見ていなかった**
 *
 * 台は `said` を集めていたが、**どの test も assert していなかった**
 * (`grep said` = 定義と push だけ)。しかも `main.ts` が口を渡していなかったので、
 * **製品でも 1 度も出ていない** ── つまり「黙って消さない」という規律は
 * **文言が在るだけ**で、どこにも効いていなかった。
 *
 * ## ⚠ happy-dom は幅を持たない ── だから採寸を差す
 *
 * `measure` は `getBoundingClientRect().width` が 0 なら `null` を返し、
 * `fitCount` は「**測れないなら減らさない**」で `wanted` を返す ──
 * つまり素の happy-dom では**畳みが 1 度も起きない**(だから台が書けなかった)。
 * 🔑 **面**(`[data-pkc-view-pane="detail"]`)の `getBoundingClientRect` を差して、
 * **畳みが実際に起きる幅**を作る。
 *
 * ⚠ **差す先は器ではなく面である**(#608 で移した)── 器(`split-row`)は
 * 何も並べていない間 `display: contents` で幅 0 なので、そこを測っていたせいで
 * **押すたびに 0 枚 ⇄ 3 枚で入れ替わっていた**。
 * 🔑 差す口は `sizePane` **1 つ**にしてある(4 か所に散らすと、移した日に
 * 直し漏れた台だけが静かに空振りする)。
 */
/**
 * 面の幅を固定する(happy-dom は採寸しないため)。
 *
 * @returns 後から幅を書き換える口 ── 「広げて戻す」を書くのに要る
 */
function sizePane(root: HTMLElement, width: number): (next: number) => void {
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]');
  expect(pane, '面が無い(台の前提が崩れている)').not.toBeNull();
  let w = width;
  pane!.getBoundingClientRect = () => ({ width: w, height: 300 }) as DOMRect;
  return (next: number) => {
    w = next;
  };
}

describe('枠を畳んだ理由を帯に出す(#606)', () => {
  it('🔴 幅が足りなくて枠を減らしたら、その理由が帯に出る', async () => {
    const { d, root, said } = boot();
    /**
     * ⚠ **数字は実測で書く**(2 巡目レビュー R-6)。1 稿目は「1 枠 448px」と
     *   書いていたが、それは**標準の文字(13px)のとき**の値である ──
     *   happy-dom の既定 `font-size` は **16px** なので、実際に使われるのは
     *   `readColumnMinPx(16) = 551.4px`、2 枠の閾値は **1118.8px**。
     *   ⚠ 結論(狭いと 1 枠)は合っていたが、**書いた数字は使われていなかった**。
     * 🔑 だから**境目のすぐ下**を使う ── 適当に小さい値だと、
     *   「採寸が死んでいても畳む」形と区別できない(R-5)。
     */
    sizePane(root, 1100);

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();

    // ⚠ 空振り防止 ── 畳みが起きていないなら、下の assert は自明に通る
    expect(
      root.querySelectorAll('[data-pkc-split-lid]').length,
      '枠が畳まれていない(この台では文言を見られない)',
    ).toBe(0);
    expect(said, '枠を畳んだのに理由が出ていない').toEqual([
      '幅が足りないので、横に並べる枠を 1 枚畳みました',
    ]);
  });

  /** ⚠ **対照群** ── 広ければ黙る(何にでも喋る実装を落とす)。 */
  it('⚠ 幅が足りていれば何も言わない', async () => {
    const { d, root, said } = boot();
    /**
     * 🔑 **境目のすぐ上**(1118.8px)を使う(2 巡目レビュー R-5)。
     * ⚠ 1 稿目は 2000px で、**採寸が完全に死んでいても緑**だった
     *   (`measure` が `null` → `fitCount` が「測れないなら減らさない」→ 黙る)。
     *   実測: `measure` を常に `null` にする変異が、この対照群**だけ**では SURVIVED。
     * 🔑 境目のすぐ上下に置くと、①採寸が読まれていること
     *   ②境目が文字の大きさに載っていること(R-4)を**同時に**見られる。
     */
    sizePane(root, 1200);

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();

    expect(
      root.querySelectorAll('[data-pkc-split-lid]').length,
      '枠が置かれていない(台の空振り)',
    ).toBeGreaterThan(0);
    expect(said, '畳んでいないのに喋った').toEqual([]);
  });
});

/**
 * 🔴 **帯の作法**(2026-08-30 の 2 巡目レビュー R-2 / R-3 / R-4)。
 * ⚠ 3 件とも、変異が **SURVIVED** で教えたものである ──
 *   直前の台は「畳んだら言う」しか見ておらず、**言い方**を 1 つも守っていなかった。
 */
describe('枠を畳んだ帯の作法(#606)', () => {
  /** 器の幅を固定して、その状態で render を n 回起こす。 */
  async function pinned(width: number, renders: number): Promise<string[]> {
    const { d, root, said } = boot();
    sizePane(root, width);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    for (let i = 0; i < renders; i += 1) d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await settle();
    return said;
  }

  /**
   * 🔴 **同じことを繰り返し言わない**(R-2)。
   * ⚠ 帯は 1 行しかなく(`main.ts` の `noticeLine`)、**押した答えを上書きする** ──
   *   畳んだまま何か dispatch するたびに言うと、user がコピーして出た
   *   「コピーしました」が**次の ack で必ず消える**。
   *   🔑 段組み側は同じ事故を踏んで直してある(`read-columns.ts` の `noteFoldState`)。
   */
  it('🔴 畳んだまま何度描き直しても、理由は 1 度しか言わない', async () => {
    const said = await pinned(1100, 3);
    // ⚠ 空振り防止 ── 1 度も言っていないなら「1 度だけ」は自明に通る
    expect(said.length, '1 度も言っていない(台の空振り)').toBeGreaterThan(0);
    expect(said, '描き直すたびに言っている ── 帯が他の知らせを潰す').toHaveLength(1);
  });

  /**
   * 🔴 **「0 枚畳みました」と言わない**(R-3)。
   * ⚠ 畳んだ状態から広げて戻ると `dropped` が 0 になる ──
   *   そこで喋ると「幅が足りないので、横に並べる枠を **0 枚**畳みました」という
   *   意味の通らない帯が出る。
   */
  it('🔴 広げて戻したとき「0 枚畳みました」と言わない', async () => {
    const { d, root, said } = boot();
    const widen = sizePane(root, 1100);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    expect(said, '畳んだ側が言っていない(台の空振り)').toHaveLength(1);

    widen(1200); // 広げて戻す
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await settle();
    expect(
      root.querySelectorAll('[data-pkc-split-lid]').length,
      '広げたのに枠が戻っていない(台の空振り)',
    ).toBeGreaterThan(0);
    expect(said.filter((t) => t.includes('0 枚')), '「0 枚畳みました」と言った').toEqual([]);
  });

  /**
   * 🔴 **境目は文字の大きさに載る**(R-4 / #509)。
   * ⚠ 測った `fontPx` を捨てて標準(13px)を使う変異が **SURVIVED** だった ──
   *   特大(17px)の user は 1 枠 586px 要るのに 448px で判定され、
   *   **読めない幅まで枠が並ぶ**。
   * 🔑 器の `font-size` を変えて、**同じ幅で答えが変わる**ことを見る。
   */
  it('🔴 同じ幅でも、文字が大きければ枠が入らない', async () => {
    const wide = await framesAt(1100, '13px'); // 閾値 912 → 2 枠入る
    const big = await framesAt(1100, '17px'); // 閾値 1187.7 → 1 枠しか入らない
    expect(wide, '標準の文字で 2 枠入っていない(台の空振り)').toBe(2);
    expect(big, '特大の文字なのに標準の閾値で判定している').toBe(1);
  });

  async function framesAt(width: number, fontSize: string): Promise<number> {
    const { d, root } = boot();
    sizePane(root, width);
    // ⚠ 文字の大きさも**面**に置く(採寸と同じ元から読むため)
    root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]')!.style.fontSize = fontSize;
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    // 主の枠 + 留めた枠 の合計(主は `data-pkc-split-main`)
    return root.querySelectorAll('[data-pkc-split-lid]').length + 1;
  }
});

/**
 * 🔴 **狭い窓で枠が入れ替わり続ける / 窓を狭めても畳まない**(#608)。
 *
 * ## user から見て何が起きていたか
 *
 * ノートを 2 枚「横に留める」で並べ、900px の窓で左の一覧を押すと ──
 * **1 回目 0 枚 / 2 回目 3 枚 / 3 回目 0 枚 / 4 回目 3 枚**と交互に入れ替わり、
 * 画面には 1 文字も出なかった。そして**窓を狭めただけでは畳まなかった**
 * (1 枠の下限 448px なのに、900px の窓で **203px の枠が 3 枚**残る)。
 *
 * ## 原因は 1 つ ── **測る先が器だった**
 *
 * 何も並べていない間、器(`split-row`)は `display: contents` なので幅 **0**。
 * `measure` は 0 で `null` を返し、`fitCount` は「測れないなら減らさない」で
 * `wanted` を返す ── **畳んだ次は全部戻し、その次は全部畳む**。
 *
 * ⚠ **happy-dom では振動そのものは再現しない**(器はいつでも 0 なので、
 * 直す前は「常に全部出る」side に貼り付く)。🔑 だからここで見るのは
 * **「器ではなく面を測っていること」**であり、⚠ 振動そのものは
 * `tests/smoke/split-frames.smoke.spec.ts` が実ブラウザで見る。
 */
describe('枠の畳みは面の幅で決める(#608)', () => {
  /** 主 + 留めた枠の合計。 */
  function count(root: HTMLElement): number {
    return root.querySelectorAll('[data-pkc-split-lid]').length + 1;
  }

  async function pinTwo(d: Dispatcher): Promise<void> {
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
  }

  /**
   * 🔴 **器が 0 でも、面が測れれば畳む。**
   *
   * ⚠ 器の幅は**明示的に 0 に差す** ── happy-dom の既定に頼ると、
   *   「たまたま 0 だった」のか「`display: contents` を再現している」のかが
   *   読めない(台が何を主張しているか字で残す)。
   */
  it('🔴 器が幅 0(display: contents)でも、面の幅で畳む', async () => {
    const { d, root } = boot();
    const row = root.querySelector<HTMLElement>('[data-pkc-region="split-row"]');
    expect(row, '器が無い(台の前提が崩れている)').not.toBeNull();
    row!.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    sizePane(root, 1100); // 境目 1118.8px のすぐ下 → 1 枠しか入らない
    await pinTwo(d);
    expect(count(root), '器の 0 を読んで「減らさない」へ落ちている').toBe(1);
  });

  /**
   * 🔴 **対照群 ── 器がいくら広くても、面が狭ければ畳む。**
   *
   * ⚠ これが無いと、上の 1 件は「器を読んでいるが、たまたま 0 だから畳んだ」でも通る。
   *   🔑 器を**わざと広く**して、答えが器に載っていないことを見る。
   */
  it('🔴 器を広く差しても、面が狭ければ畳む(器は読んでいない)', async () => {
    const { d, root } = boot();
    const row = root.querySelector<HTMLElement>('[data-pkc-region="split-row"]');
    row!.getBoundingClientRect = () => ({ width: 4000, height: 300 }) as DOMRect;
    sizePane(root, 1100);
    await pinTwo(d);
    expect(count(root), '器の幅で判定している').toBe(1);
  });

  /** ⚠ 空振り防止 ── 面が広ければ 2 枠出る(この台が何も畳まないわけではない)。 */
  it('⚠ 面が広ければ 2 枠出る(台の空振り防止)', async () => {
    const { d, root } = boot();
    sizePane(root, 1200); // 境目のすぐ上
    await pinTwo(d);
    expect(count(root), '広いのに畳んでいる').toBe(2);
  });

  /**
   * 🔴 **面の `padding` は引く**(`box-sizing: border-box` なので外寸に入っている)。
   *
   * ⚠ 引かないと、面の枠飾りのぶんだけ**中身より広く**見積もる ──
   *   境目ちょうどで「入るはず」と読んで、実際には収まらない幅で並べる。
   * 🔑 境目(1118.8px)を挟んで、`padding` があるとどちら側に落ちるかで見る。
   */
  it('🔴 面の padding を引いてから判定する', async () => {
    const { d, root } = boot();
    const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]');
    // 外寸 1130 ── 素で読めば境目(1118.8)の上だが、左右 8px の余白を引くと 1114 で下
    pane!.style.paddingLeft = '8px';
    pane!.style.paddingRight = '8px';
    sizePane(root, 1130);
    await pinTwo(d);
    expect(count(root), '外寸のまま判定している(余白を引いていない)').toBe(1);
  });

  /**
   * 🔴 **窓の大きさが変わったら測り直す**(#608 のもう半分)。
   *
   * ⚠ 直す前は `SplitView.render` を呼ぶのが `center.ts` の 1 か所だけで、
   *   **`ResizeObserver` が付いていなかった** ── 段組み側
   *   (`installColumnFit`)には付いているのに、**片方だけ見ていなかった**。
   * ⚠ happy-dom は `ResizeObserver` を持たないので、**偽物を差して**
   *   「鳴らしたら測り直す」ところまでを見る。
   */
  it('🔴 面の幅が変わったら、鳴らされた時点で畳み直す', async () => {
    const fired: (() => void)[] = [];
    const g = globalThis as { ResizeObserver?: unknown };
    const had = 'ResizeObserver' in g;
    const prev = g.ResizeObserver;
    g.ResizeObserver = class {
      constructor(cb: () => void) {
        fired.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    try {
      const { d, root } = boot();
      const widen = sizePane(root, 1200);
      await pinTwo(d);
      expect(count(root), '広いうちは 2 枠(台の空振り)').toBe(2);
      // ⚠ **前提**: 見張りが 1 つ以上付いている(0 個なら以下は自明に通る)
      expect(fired.length, '見張りが 1 つも付いていない').toBeGreaterThan(0);

      widen(1100); // 狭める ── ⚠ dispatch は 1 度も起こさない
      for (const cb of fired) cb();
      await settle();
      expect(count(root), '窓を狭めても畳まない(resize を見ていない)').toBe(1);
    } finally {
      if (had) g.ResizeObserver = prev;
      else delete g.ResizeObserver;
    }
  });

});
