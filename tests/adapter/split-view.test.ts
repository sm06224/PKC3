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

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function boot(): { root: HTMLElement; d: Dispatcher; center: CenterRouter; said: string[] } {
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

  it('🔴 外す口が在る(置けるなら外せる)', async () => {
    const { root, d } = boot();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    const off = root.querySelector('[data-pkc-action="unsplit-entry"]');
    expect(off).not.toBeNull();
    expect(off!.getAttribute('data-pkc-lid')).toBe('b');
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
 * 🔑 器の `getBoundingClientRect` だけを差して、**畳みが実際に起きる幅**を作る。
 */
describe('枠を畳んだ理由を帯に出す(#606)', () => {
  it('🔴 幅が足りなくて枠を減らしたら、その理由が帯に出る', async () => {
    const { d, root, said } = boot();
    const row = root.querySelector<HTMLElement>('[data-pkc-region="split-row"]');
    expect(row, '器が無い(台の前提が崩れている)').not.toBeNull();
    /**
     * ⚠ **数字は実測で書く**(2 巡目レビュー R-6)。1 稿目は「1 枠 448px」と
     *   書いていたが、それは**標準の文字(13px)のとき**の値である ──
     *   happy-dom の既定 `font-size` は **16px** なので、実際に使われるのは
     *   `readColumnMinPx(16) = 551.4px`、2 枠の閾値は **1118.8px**。
     *   ⚠ 結論(狭いと 1 枠)は合っていたが、**書いた数字は使われていなかった**。
     * 🔑 だから**境目のすぐ下**を使う ── 適当に小さい値だと、
     *   「採寸が死んでいても畳む」形と区別できない(R-5)。
     */
    row!.getBoundingClientRect = () => ({ width: 1100, height: 300 }) as DOMRect;

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
    const row = root.querySelector<HTMLElement>('[data-pkc-region="split-row"]');
    /**
     * 🔑 **境目のすぐ上**(1118.8px)を使う(2 巡目レビュー R-5)。
     * ⚠ 1 稿目は 2000px で、**採寸が完全に死んでいても緑**だった
     *   (`measure` が `null` → `fitCount` が「測れないなら減らさない」→ 黙る)。
     *   実測: `measure` を常に `null` にする変異が、この対照群**だけ**では SURVIVED。
     * 🔑 境目のすぐ上下に置くと、①採寸が読まれていること
     *   ②境目が文字の大きさに載っていること(R-4)を**同時に**見られる。
     */
    row!.getBoundingClientRect = () => ({ width: 1200, height: 300 }) as DOMRect;

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
    const row = root.querySelector<HTMLElement>('[data-pkc-region="split-row"]');
    row!.getBoundingClientRect = () => ({ width, height: 300 }) as DOMRect;
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
    const row = root.querySelector<HTMLElement>('[data-pkc-region="split-row"]');
    let w = 1100;
    row!.getBoundingClientRect = () => ({ width: w, height: 300 }) as DOMRect;
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    expect(said, '畳んだ側が言っていない(台の空振り)').toHaveLength(1);

    w = 1200; // 広げて戻す
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
    const row = root.querySelector<HTMLElement>('[data-pkc-region="split-row"]');
    row!.getBoundingClientRect = () => ({ width, height: 300 }) as DOMRect;
    row!.style.fontSize = fontSize;
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await settle();
    // 主の枠 + 留めた枠 の合計(主は `data-pkc-split-main`)
    return root.querySelectorAll('[data-pkc-split-lid]').length + 1;
  }
});
