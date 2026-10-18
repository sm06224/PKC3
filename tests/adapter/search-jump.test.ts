/** @vitest-environment happy-dom */
/**
 * 🔴 **「探す」から本文の当たった所へ送って塗る**(#1102 段①)── DOM 側。
 *
 * ## user から見た物語
 *
 * 「探す」で行を押す → ノートが開く → **本文の中の当たった語が塗られ、その位置へ送られる**。
 * 右上に「1/4 件 ‹ ›」が出て、‹ › で前後へ。畳んだ章の中なら、開いてから送る。
 * ノートを変える / 編集を始める / × を押すと、塗りも帯も消える。
 *
 * ## 守るもの
 *
 * ① 当たりを**本文の text node から**数える(操作のために差し込んだ字は数えない / 大小は区別しない)
 * ② 塗りは Custom Highlight(本文の DOM を 1 バイトも変えない)── 全部 + いまの 1 つ
 * ③ 帯の字は「n/m 件」/ 当たりが無いときはその事実を言う(数字の 0 で黙らない)
 * ④ 送りは端で回り、**世代が変わったときだけ**送る(描き直しのたびに跳ねない)
 * ⑤ 畳んだ章の中なら開いてから送る
 * ⑥ 🔴 **対照群: Custom Highlight を持たない環境**では塗らず、**送りと帯だけ**効く(無言で終わらない)
 * ⑦ ノートを変える / 編集に入る / 控えを消す → 塗りも帯も消える
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import {
  HIT_CURRENT_HIGHLIGHT,
  HIT_HIGHLIGHT,
  HIT_RANGE_MAX,
  collectHitRanges,
  paintHitRanges,
  searchJumpLabel,
} from '../../src/adapter/ui/render/search-jump';
import { toggleHeadingFold } from '../../src/adapter/ui/render/heading-fold';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 当たりは 4 つ(本文 3 + 見出し 1。大小違いも数える)。 */
const BODY = [
  '# 会議の手引き',
  '',
  '来週の会議は 10 時から。',
  '',
  'ふつうの段落です。',
  '',
  '## 議事',
  '',
  '前回の会議と、MEETING の会議 を見直す。',
].join('\n');

class FakeHighlight {
  readonly ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    // ⚠ 本物の Highlight も、引数に大量の Range を展開されると(スタックの上限で)RangeError になりうる ── それを模す
    if (ranges.length > SPREAD_LIMIT) throw new RangeError('Maximum call stack size exceeded');
    this.ranges = ranges;
  }
  add(range: Range): this {
    this.ranges.push(range);
    return this;
  }
}
const SPREAD_LIMIT = 10000;
let registry: Map<string, FakeHighlight>;
let scrolled: Element[];

function installHighlightApi(): void {
  registry = new Map();
  vi.stubGlobal('CSS', { highlights: registry });
  vi.stubGlobal('Highlight', FakeHighlight);
}

function base(body = BODY): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a'), meta('b')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  return reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
}

async function open(body = BODY) {
  const root = document.createElement('div');
  document.body.append(root);
  const detail = new DetailRenderer(buildShell(root).detail);
  const s0 = base(body);
  detail.render(s0);
  await settle();
  return { root, detail, s0 };
}

const apply = async (
  detail: DetailRenderer,
  s: AppState,
  action: Parameters<typeof reduce>[1],
): Promise<AppState> => {
  const next = reduce(s, action).state;
  detail.render(next);
  await settle();
  return next;
};

const bar = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-pkc-field="search-jump"]')!;
const count = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-pkc-field="search-jump-count"]')!.textContent;

beforeEach(() => {
  document.body.textContent = '';
  scrolled = [];
  // happy-dom は scrollIntoView を持たない / 箱の寸法が 0 ── 「どの塊へ送ったか」を観測する
  (Element.prototype as unknown as { scrollIntoView: (o?: unknown) => void }).scrollIntoView =
    function (this: Element) {
      scrolled.push(this);
    };
  installHighlightApi();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collectHitRanges: 本文の text node から当たりを数える', () => {
  it('🔴 大小を区別せず、文書順に数える(見出しも本文も)', async () => {
    const { root } = await open();
    const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    const ranges = collectHitRanges(host, '会議');
    expect(ranges.map((r) => r.toString())).toEqual(['会議', '会議', '会議', '会議']);
    // 大小違い(対照群: 別の語は別の数)
    expect(collectHitRanges(host, 'meeting')).toHaveLength(1);
    expect(collectHitRanges(host, 'meeting')[0]!.toString()).toBe('MEETING');
  });

  it('🔴 操作のために差し込んだ字(ボタン)は数えない', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>会議の本文</p><button type="button">会議を折りたたむ</button>';
    document.body.append(host);
    expect(collectHitRanges(host, '会議')).toHaveLength(1);
  });

  it('除外の語は塗らない / 語が無ければ 0 件', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>会議と中止</p>';
    document.body.append(host);
    expect(collectHitRanges(host, '-中止')).toEqual([]);
    expect(collectHitRanges(host, '会議 -中止').map((r) => r.toString())).toEqual(['会議']);
  });

  it('🔴 本文の DOM は 1 バイトも変えない(Range を作るだけ)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>会議と会議</p>';
    document.body.append(host);
    const before = host.innerHTML;
    collectHitRanges(host, '会議');
    expect(host.innerHTML).toBe(before);
  });
});

describe('🔴 #1087: 整形された字と、節点をまたぐ語', () => {
  const hostOf = (md: string): HTMLElement => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(md);
    document.body.append(host);
    return host;
  };
  const hits = (md: string, q: string): string[] =>
    collectHitRanges(hostOf(md), q, 'filter').map((r) => r.toString());

  it('前提: 描画は引用符だけ整形し、記号(…・–・©・™・±)には置き換えない(依頼 254)', () => {
    const t = hostOf('don\'t "hi" Wait... a -- b (c) (tm) +-').textContent ?? '';
    for (const ch of ['’', '“'])
      expect(t, `整形後の本文に ${ch} が居る`).toContain(ch);
    for (const ch of ['…', '–', '©', '™', '±'])
      expect(t, `本文に ${ch} は出ない`).not.toContain(ch);
  });

  it.each(["don't", '"hi"', 'Wait...', 'a -- b', '(c)', '(tm)', '+-'])(
    '打った字 %s が、描かれた本文で 1 件当たる',
    (typed) => {
      const got = hits(`before ${typed} after`, typed);
      expect(got).toHaveLength(1);
      expect(got[0]!.length).toBeLessThanOrEqual(typed.length);
    },
  );

  it('対照群: 整形されない字は今までどおり 1 件 / 別の語は 0 件', () => {
    expect(hits('A&B here', 'A&B')).toHaveLength(1);
    expect(hits('a<b here', 'a<b')).toHaveLength(1);
    expect(hits('see example.com now', 'example.com')).toHaveLength(1);
    expect(hits("don't stop", 'dont')).toHaveLength(0);
  });

  it('🔴 色分けされたコードの `const foo`(節点をまたぐ)が 1 件当たる', () => {
    const host = hostOf('```js\nconst foo = 1;\n```');
    expect(host.querySelector('.pkc-tok-keyword'), '前提: 色分けの <span> が居る').not.toBeNull();
    const r = collectHitRanges(host, 'const foo', 'filter');
    expect(r.map((x) => x.toString())).toEqual(['const foo']);
    expect(r[0]!.startContainer, '始まりと終わりは別の節点').not.toBe(r[0]!.endContainer);
  });

  it('🔴 太字・リンクをまたぐ語が当たる', () => {
    expect(hits('**bo**ld word', 'bold')).toEqual(['bold']);
    expect(hits('go [lin](https://example.org/x)k now', 'link')).toEqual(['link']);
    expect(hits('a **b** c', 'a b c')).toEqual(['a b c']);
  });

  it('切れ目: 段落・改行・ボタンをまたいでは当たらない / 無関係な語は 0 件', () => {
    expect(hits('foo\n\nbar', 'foobar')).toEqual([]);
    expect(hits('foo  \nbar', 'foobar')).toEqual([]);
    const host = document.createElement('div');
    host.innerHTML = '<p>fo<button type="button">ZZ</button>o</p>';
    document.body.append(host);
    expect(collectHitRanges(host, 'foZZo')).toEqual([]);
    expect(hits('hello **world**', 'unrelated')).toEqual([]);
  });

  it('隣り合う 2 件は別々に数える', () => {
    expect(hits('**ab**ab', 'ab')).toEqual(['ab', 'ab']);
  });
});

/**
 * 🔴 **左の列の欄から始めた塗りは、打った字を丸ごと 1 句で塗る**(#1087)。
 * ⚠ 欄は打った字を 1 句として引く(`planPlain`)。「探す」と同じ割り方で塗ると、`-1` / `-メモ` は除外の語と読まれて
 *   0 件、`"a b"` は引用符を剥がして外す ── 一覧には当たっているのに「一致しませんでした」と出ていた。
 */
describe('🔴 欄から始めた塗りは、字を丸ごと 1 句として数える', () => {
  const host = (html: string): HTMLElement => {
    const h = document.createElement('div');
    h.innerHTML = html;
    document.body.append(h);
    return h;
  };

  it.each([
    ['-1', '<p>残り -1 と -1 です</p>', 2],
    ['-メモ', '<p>-メモ を書いた</p>', 1],
    ['"a b"', '<p>x "a b" y</p>', 1],
  ])('欄の語 %s は、そのままの字で数える', (q, html, n) => {
    expect(collectHitRanges(host(html), q, 'filter')).toHaveLength(n);
  });

  it('🔴 対照群: 「探す」から来た塗りは、今までどおり除外・引用符を解く(割り方を変えていない)', () => {
    expect(collectHitRanges(host('<p>残り -1 です</p>'), '-1', 'find'), '除外の語を塗った').toEqual([]);
    // 引用符は解かれる(塗るのは `a b` だけ)/ 欄の起点は引用符ごと塗る
    expect(collectHitRanges(host('<p>x "a b" y</p>'), '"a b"', 'find').map((r) => r.toString())).toEqual(['a b']);
    expect(collectHitRanges(host('<p>x "a b" y</p>'), '"a b"', 'filter').map((r) => r.toString())).toEqual(['"a b"']);
    expect(collectHitRanges(host('<p>会議と中止</p>'), '会議 -中止')).toHaveLength(1); // 起点を省くと「探す」
  });

  it('🔴 画面で: 欄の `-メモ` で開いた本文に当たりが数えられ、「一致しませんでした」を出さない', async () => {
    const { root, detail, s0 } = await open('# 題\n\n-メモ を残す。\n');
    // ⚠ 欄が空だと欄の起点の塗りは孤児として消える ── 欄に語が入っている台にする
    const typed = await apply(detail, s0, { type: 'SET_ENTRY_FILTER', query: '-メモ' });
    const s = await apply(detail, typed, { type: 'SEARCH_JUMP_START', lid: 'a', query: '-メモ', origin: 'filter' });
    expect(s.searchJump?.origin, '台の前提: 欄からの起点になっていない').toBe('filter');
    expect(count(root)).toBe('1/1 件');
    expect(registry.get(HIT_HIGHLIGHT)?.ranges.map((r) => r.toString())).toEqual(['-メモ']);
  });

  it('🔴 画面で・対照群: 同じ語でも「探す」の起点なら除外と読み、当たりは 0 件と言う', async () => {
    const { root, detail, s0 } = await open('# 題\n\n-メモ を残す。\n');
    await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '-メモ' });
    expect(count(root)).toContain('一致しませんでした');
  });
});

describe('🔴 当たりが多すぎても壊れない(#1087)', () => {
  it('集める当たりは HIT_RANGE_MAX で打ち切る', () => {
    const host = document.createElement('div');
    host.textContent = 'a'.repeat(HIT_RANGE_MAX + 100);
    document.body.append(host);
    const ranges = collectHitRanges(host, 'a');
    expect(ranges, '打ち切らずに全部集めた').toHaveLength(HIT_RANGE_MAX);
    expect(HIT_RANGE_MAX).toBe(50000);
  });

  it('対照群: 上限より少なければ全部集める', () => {
    const host = document.createElement('div');
    host.textContent = 'a'.repeat(30);
    document.body.append(host);
    expect(collectHitRanges(host, 'a')).toHaveLength(30);
  });

  it('🔴 塗るとき Range を引数に展開しない(多いと RangeError)── 全部が塗りに入る', () => {
    // 台の前提: 展開する書き方は、この台の Highlight で実際に落ちる
    expect(() => new (globalThis as { Highlight: new (...r: Range[]) => unknown }).Highlight(
      ...(Array.from({ length: SPREAD_LIMIT + 1 }, () => document.createRange()) as Range[]),
    )).toThrow(RangeError);
    const many = Array.from({ length: SPREAD_LIMIT + 5 }, () => document.createRange());
    expect(paintHitRanges(many, 0)).toBe(true);
    expect(registry.get(HIT_HIGHLIGHT)!.ranges).toHaveLength(SPREAD_LIMIT + 5);
    expect(registry.get(HIT_CURRENT_HIGHLIGHT)!.ranges).toHaveLength(1);
  });
});

describe('帯の字', () => {
  it('n/m 件 / 当たりが無いときはその事実を言う', () => {
    expect(searchJumpLabel(4, 0)).toBe('1/4 件');
    expect(searchJumpLabel(4, 3)).toBe('4/4 件');
    expect(searchJumpLabel(0, 0)).toBe('本文の字には一致しませんでした(図の中は数えません)');
    // 🔴 #1206 D6: 数えない範囲まで言う(断定にしない)/ 帯に収まる長さ
    expect(searchJumpLabel(0, 0)).toContain('数えません');
    expect(searchJumpLabel(0, 0).length, '帯に収まらない長さ').toBeLessThanOrEqual(120);
    expect(searchJumpLabel(0, 0)).not.toContain('当たった所はありません');
  });
});

describe('detail: 「探す」からの塗りと帯', () => {
  it('🔴 START で、当たりを全部塗り、いまの 1 つを強く塗り、帯に「1/4 件」を出す', async () => {
    const { root, detail, s0 } = await open();
    expect(bar(root).hidden, '前提: 始める前は帯が無い').toBe(true);
    await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    expect(bar(root).hidden).toBe(false);
    expect(count(root)).toBe('1/4 件');
    expect(registry.get(HIT_HIGHLIGHT)?.ranges, '全部の当たりを塗っていない').toHaveLength(4);
    const cur = registry.get(HIT_CURRENT_HIGHLIGHT)!;
    expect(cur.ranges).toHaveLength(1);
    expect(cur.ranges[0], 'いまの 1 つは先頭').toBe(registry.get(HIT_HIGHLIGHT)!.ranges[0]);
    expect(cur.priority, 'いまの 1 つが全部の塗りに負ける').toBeGreaterThan(
      registry.get(HIT_HIGHLIGHT)!.priority,
    );
  });

  it('🔴 本文の DOM を塗りのために変えていない(`<mark>` を足していない)', async () => {
    const { root, detail, s0 } = await open();
    const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    const before = host.innerHTML;
    await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    expect(host.innerHTML).toBe(before);
  });

  it('🔴 送りは端で回り、そのたびに「いまの 1 つ」が動く(次 / 前)', async () => {
    const { root, detail, s0 } = await open();
    let s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    const seen: Array<{ label: string | null; at: number }> = [];
    for (let i = 0; i < 5; i++) {
      s = await apply(detail, s, { type: 'SEARCH_JUMP_STEP', by: 1 });
      // ⚠ 送るたびに当たりを数え直す(Range は作り直される)── その時点の並びの何番目かで見る
      const all = registry.get(HIT_HIGHLIGHT)!.ranges;
      seen.push({ label: count(root), at: all.indexOf(registry.get(HIT_CURRENT_HIGHLIGHT)!.ranges[0]!) });
    }
    // 2,3,4 → 端で 1 へ回り → 2
    expect(seen.map((x) => x.label)).toEqual(['2/4 件', '3/4 件', '4/4 件', '1/4 件', '2/4 件']);
    expect(seen.map((x) => x.at)).toEqual([1, 2, 3, 0, 1]);
    // 前へ(先頭から前は末尾へ回る)
    s = await apply(detail, s, { type: 'SEARCH_JUMP_STEP', by: -1 });
    await apply(detail, s, { type: 'SEARCH_JUMP_STEP', by: -1 });
    expect(count(root)).toBe('4/4 件');
  });

  it('🔴 送った先の塊へ送る(語のある段落)── 世代が同じなら描き直しても跳ねない', async () => {
    const { detail, s0 } = await open();
    let s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    const first = scrolled.length;
    expect(first, '始めたのに送っていない').toBeGreaterThan(0);
    expect(scrolled[scrolled.length - 1]!.textContent).toContain('会議');
    // 同じノートの本文が描き直される(別の窓の追記など)── 塗りは当て直すが、送り直さない
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: BODY + '\n\nさらに会議の話。' }).state;
    detail.render(s);
    await settle();
    expect(registry.get(HIT_HIGHLIGHT)?.ranges, '描き直した後の当たりを塗り直していない').toHaveLength(5);
    expect(scrolled.length, '描き直しのたびに跳ねている').toBe(first);
    // 送りを押せば、また送る(対照群)
    await apply(detail, s, { type: 'SEARCH_JUMP_STEP', by: 1 });
    expect(scrolled.length).toBeGreaterThan(first);
  });

  it('🔴 畳んだ章の中に当たりが在れば、章を開いてから送る', async () => {
    const { root, detail, s0 } = await open();
    const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    const heading = [...host.children].find((el) => el.tagName === 'H2')!;
    toggleHeadingFold(heading);
    const inside = [...host.children].find((el) => el.textContent?.includes('MEETING')) as HTMLElement;
    expect(inside.hidden, '前提: 章が畳まれている').toBe(true);
    // 最後の当たり(畳んだ章の中)へ送る: 4 件目 = step 3
    let s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    for (let i = 0; i < 3; i++) s = await apply(detail, s, { type: 'SEARCH_JUMP_STEP', by: 1 });
    expect(count(root)).toBe('4/4 件');
    expect(inside.hidden, '畳んだままで送っている(箱が無く、送りが空振りする)').toBe(false);
    expect(scrolled[scrolled.length - 1]).toBe(inside);
  });

  it('🔴 当たりが本文に無いとき(題名だけが当たった)は、その事実を言い、送りは押せない', async () => {
    const { root, detail, s0 } = await open();
    await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: 'ありえない語' });
    expect(bar(root).hidden).toBe(false);
    expect(count(root)).toBe('本文の字には一致しませんでした(図の中は数えません)');
    const btn = (a: string) => root.querySelector<HTMLButtonElement>(`[data-pkc-action="${a}"]`)!;
    expect(btn('search-jump-prev').disabled).toBe(true);
    expect(btn('search-jump-next').disabled).toBe(true);
    // 終わり(×)は押せる ── 帯から出られなくならない
    expect(btn('search-jump-end').disabled).toBe(false);
    expect(registry.get(HIT_HIGHLIGHT), '当たりが無いのに塗りが残っている').toBeUndefined();
  });

  it('🔴 帯の押し所は 3 つ(‹ › ×)で、字と受け手の名前が揃っている', async () => {
    const { root, detail, s0 } = await open();
    await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    const rows = [...bar(root).querySelectorAll<HTMLButtonElement>('button')].map((b) => [
      b.getAttribute('data-pkc-action'),
      b.textContent,
    ]);
    expect(rows).toEqual([
      ['search-jump-prev', '‹'],
      ['search-jump-next', '›'],
      ['search-jump-end', '×'],
    ]);
  });
});

describe('detail: 消える', () => {
  it('🔴 × / `Esc`(`SEARCH_JUMP_END`)で、塗りも帯も消える', async () => {
    const { root, detail, s0 } = await open();
    const s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    expect(registry.size, '前提: 塗っている').toBe(2);
    await apply(detail, s, { type: 'SEARCH_JUMP_END' });
    expect(registry.size, '塗りが表に残っている').toBe(0);
    expect(bar(root).hidden).toBe(true);
  });

  it('🔴 ノートを変えると、塗りも帯も消える(別のノートの本文に塗りが残らない)', async () => {
    const { root, detail, s0 } = await open();
    let s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    s = await apply(detail, s, { type: 'SELECT_ENTRY', lid: 'b' });
    s = await apply(detail, s, { type: 'BODY_LOADED', lid: 'b', body: '別の会議の本文' });
    expect(s.searchJump).toBeNull();
    expect(registry.size, '別のノートへ移っても塗りが残っている').toBe(0);
    expect(bar(root).hidden).toBe(true);
  });

  it('🔴 編集を始めると消える(書いている本文に塗りを乗せない)', async () => {
    const { root, detail, s0 } = await open();
    let s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    s = await apply(detail, s, { type: 'START_EDIT' });
    expect(s.phase, '前提: 編集に入っている').toBe('editing');
    expect(registry.size).toBe(0);
    expect(root.querySelector('[data-pkc-field="search-jump"]')?.hasAttribute('hidden') ?? true).toBe(true);
  });

  it('🔴 本文が届く前に始めても、届いた後で塗って送る(押した直後は本文が無い)', async () => {
    // ノートを選んだ直後 = 本文はまだ。ここで START しても state は受ける(選んでいる lid だからだ)
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail);
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a'), meta('b')],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    detail.render(s);
    s = reduce(s, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' }).state;
    detail.render(s);
    expect(registry.size, '本文が無いのに塗っている').toBe(0);
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: BODY }).state;
    detail.render(s);
    await settle();
    expect(registry.get(HIT_HIGHLIGHT)?.ranges).toHaveLength(4);
    expect(count(root)).toBe('1/4 件');
    expect(scrolled.length, '本文が届いた後で送っていない').toBeGreaterThan(0);
  });
});

describe('🔴 留めた枠は、主の枠の塗りに触らない', () => {
  it('留めた枠が描かれても(= 骨組みを作っても)、主の枠の塗りと帯は残り、留めた枠に帯は出ない', async () => {
    const { root, detail, s0 } = await open();
    const s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    expect(registry.get(HIT_HIGHLIGHT)?.ranges, '前提: 主の枠が塗っている').toHaveLength(4);
    // 横に留めた枠(別のノート b を出す)── 描くと骨組みを作る(`disposeLends` が走る)
    const host = document.createElement('div');
    document.body.append(host);
    const pinned = new DetailRenderer(host, null, undefined, null, undefined, undefined, undefined, 'b');
    const withSplit = { ...s, splitBodies: new Map([['b', '別の会議の本文']]) } as AppState;
    pinned.render(withSplit);
    await settle();
    expect(host.textContent, '前提: 留めた枠が描かれている').toContain('別の会議の本文');
    expect(registry.get(HIT_HIGHLIGHT)?.ranges, '留めた枠が主の枠の塗りを消した / 上書きした').toHaveLength(4);
    expect(bar(root).hidden, '主の枠の帯が消えた').toBe(false);
    expect(host.querySelector('[data-pkc-field="search-jump"]'), '留めた枠に帯が出ている').toBeNull();
  });

  it('🔴 主の枠と同じノートを留めた枠でも、塗りの表を上書きしない(同じ本文を 2 か所に出す形)', async () => {
    const { root, detail, s0 } = await open();
    const s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    const mainHighlight = registry.get(HIT_HIGHLIGHT)!;
    expect(mainHighlight.ranges, '前提: 主の枠が塗っている').toHaveLength(4);
    // 同じノート a を横にも留める ── 本文も同じなので、門が無いと留めた枠も当たりを数えて塗る
    const host = document.createElement('div');
    document.body.append(host);
    const pinned = new DetailRenderer(host, null, undefined, null, undefined, undefined, undefined, 'a');
    pinned.render({ ...s, splitBodies: new Map([['a', BODY]]) } as AppState);
    await settle();
    expect(host.textContent, '前提: 留めた枠が同じ本文を描いている').toContain('来週の会議');
    expect(
      registry.get(HIT_HIGHLIGHT),
      '留めた枠が塗りの表を上書きした(主の枠の Range が消え、画面の塗りが飛ぶ)',
    ).toBe(mainHighlight);
    expect(bar(root).hidden).toBe(false);
  });
});

describe('🔴 対照群: Custom Highlight を持たない環境', () => {
  it('塗らずに、送りと帯だけ効く(無言で終わらない)', async () => {
    // 古いブラウザ相当: `CSS.highlights` が無い
    vi.stubGlobal('CSS', {});
    const { root, detail, s0 } = await open();
    const s = await apply(detail, s0, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    expect(registry.size, '塗れない環境で塗りの表を触っている').toBe(0);
    expect(count(root), '帯が出ていない = 無言').toBe('1/4 件');
    expect(scrolled.length, '送っていない').toBeGreaterThan(0);
    // 送りも効く
    await apply(detail, s, { type: 'SEARCH_JUMP_STEP', by: 1 });
    expect(count(root)).toBe('2/4 件');
  });
});
