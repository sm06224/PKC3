/** @vitest-environment happy-dom */
/**
 * 一覧の並び順(#183 / 台帳 #180 A-3)。
 *
 * 🔴 守る主張:
 * 1. 既定は **手で並べ替えた順**(`entry_order`)── 手動の導線を置き換えない
 * 2. 更新順は**新しい順**、題名・種類は昇順
 * 3. **同点は lid で割る**(割らないと行が実行のたびに入れ替わって見える)
 * 4. 選んだら**画面の並びが実際に変わる**(state だけ動いても意味が無い)
 * 5. 並べ替えても**選択は消えない**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  sortOrder,
  isEntrySort,
  DEFAULT_ENTRY_SORT,
  NATURAL_DESC,
  ENTRY_SORTS,
} from '../../src/features/filter/entry-sort';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
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
    ...over,
  };
}

const metasOf = (list: EntryMeta[]) => {
  const m = new Map(list.map((x) => [x.lid, x]));
  return (lid: string) => m.get(lid);
};

describe('並び順の規則', () => {
  it('既定は手動の順(渡された order をそのまま)', () => {
    expect(DEFAULT_ENTRY_SORT).toBe('manual');
    const list = [meta('c'), meta('a'), meta('b')];
    expect(sortOrder(['c', 'a', 'b'], metasOf(list), 'manual', NATURAL_DESC['manual'])).toEqual(['c', 'a', 'b']);
  });

  it('元の配列を壊さない(state の参照は指紋でもある)', () => {
    const order = ['b', 'a'];
    sortOrder(order, metasOf([meta('a'), meta('b')]), 'title', false);
    expect(order, '呼び側の配列がその場で書き換わった').toEqual(['b', 'a']);
  });

  it('題名順は昇順', () => {
    const list = [meta('x', { title: 'んご' }), meta('y', { title: 'あい' })];
    expect(sortOrder(['x', 'y'], metasOf(list), 'title', NATURAL_DESC['title'])).toEqual(['y', 'x']);
  });

  it('🔴 更新順は**新しい順**(古い順にしない)', () => {
    const list = [
      meta('old', { updatedAt: '2026-01-01T00:00:00Z' }),
      meta('new', { updatedAt: '2026-08-15T00:00:00Z' }),
    ];
    expect(sortOrder(['old', 'new'], metasOf(list), 'updated', NATURAL_DESC['updated'])).toEqual(['new', 'old']);
  });

  it('種類順は archetype の昇順', () => {
    const list = [meta('t', { archetype: 'todo' }), meta('a', { archetype: 'attachment' })];
    expect(sortOrder(['t', 'a'], metasOf(list), 'archetype', NATURAL_DESC['archetype'])).toEqual(['a', 't']);
  });

  it('🔴 同点は lid で割る(並びが実行ごとに変わらない)', () => {
    const list = [meta('b', { title: '同じ' }), meta('a', { title: '同じ' })];
    const once = sortOrder(['b', 'a'], metasOf(list), 'title', NATURAL_DESC['title']);
    const twice = sortOrder(['a', 'b'], metasOf(list), 'title', NATURAL_DESC['title']);
    expect(once).toEqual(['a', 'b']);
    expect(twice, '入力の順で結果が変わる = 不安定').toEqual(once);
  });

  it('未知の lid は落とさず末尾へ(黙って消えるほうが害が大きい)', () => {
    const list = [meta('a', { title: 'あ' })];
    expect(sortOrder(['ghost', 'a'], metasOf(list), 'title', NATURAL_DESC['title'])).toEqual(['a', 'ghost']);
  });

  it('isEntrySort は登録した並びだけを通す', () => {
    // ⚠ **一覧から引く**(数を直書きすると、足した日にこの test だけ古くなる)
    expect(ENTRY_SORTS.every(isEntrySort)).toBe(true);
    expect(isEntrySort('relevance')).toBe(false);
  });

  /**
   * 🔴 **向きは外から決まる**(2026-08-19、2 ペインの列見出し)。
   *
   * ⚠ 直す前は `sortOrder` の中に `const desc = sort === 'updated'` と**埋まって**
   *   いたので、user が反転できなかった ── 列見出しを押しても向きが変わらない。
   * ⚠ ここは**同じ入力で向きだけを変えて**見る(片方向しか回さないと、
   *   `desc` を無視する実装が素通りする ── CLAUDE.md §2)。
   */
  it('🔴 同じ並びでも、向きを渡すと結果が反転する', () => {
    const list = [meta('x', { title: 'んご' }), meta('y', { title: 'あい' })];
    expect(sortOrder(['x', 'y'], metasOf(list), 'title', false)).toEqual(['y', 'x']);
    expect(sortOrder(['x', 'y'], metasOf(list), 'title', true), 'desc が効いていない').toEqual([
      'x',
      'y',
    ]);
  });

  /**
   * 🔴 **自然な向きは並びごとに違う** ── 更新と大きさは「多い側から」、
   * 名前と種類は「頭から」。⚠ 全部同じにすると、更新を選んだ瞬間に
   * **いちばん古いノート**が上に来る(直す前の挙動を保つ)。
   */
  it('🔴 自然な向き: 更新と大きさは降順、名前と種類は昇順', () => {
    expect(NATURAL_DESC.updated).toBe(true);
    expect(NATURAL_DESC.size).toBe(true);
    expect(NATURAL_DESC.title).toBe(false);
    expect(NATURAL_DESC.archetype).toBe(false);
    expect(NATURAL_DESC.manual).toBe(false);
  });

  /**
   * 🔴 **大きさ順は「数」で比べる**(2026-08-19)。
   * ⚠ 文字として比べると `9 > 100` になる ── 桁が混ざった瞬間に嘘の並びになり、
   *   しかも**小さい容れ物では気づけない**(1 桁しか無ければ正しく見える)。
   */
  it('🔴 大きさ順は数として比べる(文字の辞書順にしない)', () => {
    const list = [
      meta('small', { bodyChars: 9 }),
      meta('big', { bodyChars: 100 }),
      meta('mid', { bodyChars: 50 }),
    ];
    expect(sortOrder(['small', 'big', 'mid'], metasOf(list), 'size', true)).toEqual([
      'big',
      'mid',
      'small',
    ]);
    expect(sortOrder(['small', 'big', 'mid'], metasOf(list), 'size', false)).toEqual([
      'small',
      'mid',
      'big',
    ]);
  });

  /**
   * ⚠ **未計算(`null`)と空(`0`)を潰さない** ── どちらもいちばん小さい側だが、
   *   `null` は「まだ数えていない」ので `0` より更に下に置く(埋まったら動く)。
   */
  it('未計算の大きさは、いちばん小さい扱い(落とさない)', () => {
    const list = [meta('unknown', { bodyChars: null }), meta('empty', { bodyChars: 0 })];
    expect(sortOrder(['unknown', 'empty'], metasOf(list), 'size', false)).toEqual([
      'unknown',
      'empty',
    ]);
  });
});

describe('並び順の配線(選ぶ → 画面が変わる)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('🔴 選ぶと一覧の並びが実際に変わり、選択は消えない', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    d.onState((s) => sidebar.render(s));
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        meta('n1', { title: 'ん', entryOrder: 1 }),
        meta('n2', { title: 'あ', entryOrder: 2 }),
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const rows = () =>
      [...root.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]')].map((e) =>
        e.getAttribute('data-pkc-entry'),
      );
    expect(rows()).toEqual(['n1', 'n2']); // 手動の順

    const sel = root.querySelector<HTMLSelectElement>('[data-pkc-field="entry-sort"]');
    expect(sel, '並び順の選択欄が画面に無い').not.toBeNull();
    sel!.value = 'title';
    sel!.dispatchEvent(new Event('change', { bubbles: true }));

    expect(d.getState().entrySort).toBe('title');
    expect(rows(), '選んだのに画面の並びが変わらない(指紋の入れ忘れ)').toEqual(['n2', 'n1']);
    expect(d.getState().selectedLid, '並べ替えで選択が消えた').toBe('n1');
  });
});

/**
 * タグの札(#182)── 情報ペインに出て、押すと**そのタグで探す**。
 * 🔴 別建てのタグ絞り込み機構を作らず、#181 の全文検索へ乗せている
 *    (frontmatter も本文なので `tags:` ごと引ける)。
 */
describe('タグの札(#182)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function withInspector() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((s) => inspector.render(s));
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', { title: 'メモ' })],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    return { d, root };
  }

  it('🔴 本文のタグが札として出て、押すとそのタグで探す', () => {
    const { d, root } = withInspector();
    d.dispatch({
      type: 'BODY_LOADED',
      lid: 'n1',
      body: '---\ntags: [買い物, 家事]\n---\n本文\n',
    });
    const chips = [...root.querySelectorAll('[data-pkc-action="filter-by-tag"]')];
    expect(chips.map((c) => c.textContent), 'タグの札が出ていない').toEqual([
      '買い物',
      '家事',
    ]);
    (chips[0] as HTMLElement).click();
    expect(d.getState().filterQuery, '押しても探さない').toBe('買い物');
  });

  it('本文が読めていないときは「タグ無し」と嘘を書かない', () => {
    const { root } = withInspector();
    const box = root.querySelector('[data-pkc-field="inspector-tags"]');
    expect(box?.textContent, '本文未読なのに断定している').toBe('—');
  });

  it('タグの無い本文では「無し」と出る', () => {
    const { d, root } = withInspector();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文だけ\n' });
    const box = root.querySelector('[data-pkc-field="inspector-tags"]');
    expect(box?.textContent).toBe('無し');
  });

  /**
   * 🔴 **読めていないときに「無し」と断定しない**(#284 の残件)。
   *
   * ⚠ 直す前は、閉じの `---` を失ったノートに対してこの行が**タグ「無し」と
   *   嘘をついていた** ── `parseFrontmatter` は読めないときも「そもそも書いて
   *   いない文書」と**同じ答え**を返すからである。
   * 🔑 すぐ上の「本文未読では嘘を書かない」は守られていたのに、
   *   **対称の反対側だけ空いていた**(CLAUDE.md「片側を直したら反対側を疑う」)。
   * ⚠ **対照群を同じ節に置く** ── 正しく閉じていれば今までどおり札が出る
   *   (上の 3 件がそれ)。
   */
  it('🔴 文書の情報が読めていないときは、理由を出す(「無し」と断定しない)', () => {
    const { d, root } = withInspector();
    // 閉じの `---` を失った本文 ── user がタグを書いたのに読めていない
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '---\ntags: [買い物]\n本文\n' });
    const box = root.querySelector('[data-pkc-field="inspector-tags"]');
    expect(box?.textContent, '読めていないのに「無し」と断定している').toBe('読めていません');
    // ⚠ 理由は `title` に(行が狭いので画面には短く)
    expect(box?.getAttribute('title') ?? '', '何が起きたか読めない').toContain('閉じの ---');
    // ⚠ 空振り防止 ── 札は出ていない(出ていたら上の主張は無意味)
    expect(root.querySelectorAll('[data-pkc-action="filter-by-tag"]').length).toBe(0);
  });

  /**
   * 🔴 **理由は 1 形だけではない**(着地前レビュー M3 / M4)。
   *
   * ⚠ 1 稿目は `malformed`(閉じが無い)しか通していなかったので、
   *   **`problem !== null` を `problem !== null && tags.length === 0` に弱める変異が
   *   生き延びた** ── その変異は「**1 本目にタグが在る二重 fence**」で警告を消し、
   *   #318 が言う「いちばん安心させる形」に戻す。
   * 🔑 だから**理由の種類ごとに 1 件ずつ**通す(§7「経路ごとに pin する」の
   *   画面側の顔)。
   */
  /**
   * 🔴 **1 組目が読めるなら、実在するタグを隠さない**(2 巡目レビュー A-2)。
   *
   * ⚠ 1 稿目は「理由が在る = 読めていない」と畳んでいたので、
   *   **本文の先頭にもう 1 組らしき行が続くだけ**の健全なノートで、
   *   **実在するタグを画面から消して**いた ── #284 の嘘の裏返しを作っていた。
   * 🔑 出せるものは出し、言うべきことは `title` に添える。
   */
  it('🔴 2 組目が残っていても、読めている 1 組目のタグは出す', () => {
    const { d, root } = withInspector();
    d.dispatch({
      type: 'BODY_LOADED',
      lid: 'n1',
      body: '---\ntags: [買い物]\n---\n\n---\n\nTODO: 明日やる\n',
    });
    expect(
      [...root.querySelectorAll('[data-pkc-action="filter-by-tag"]')].map((c) => c.textContent),
      '実在するタグを隠した',
    ).toEqual(['買い物']);
    expect(
      root.querySelector('[data-pkc-field="inspector-tags"]')?.getAttribute('title') ?? '',
      '2 組目のことを何も言っていない',
    ).toContain('2 組目');
  });

  /**
   * ⚠ **ただし「無し」と言い切らない** ── 読めている 1 組目にタグが無いのは事実だが、
   *   user のタグが 2 組目へ落ちている可能性がある。`title` だけに逃がすと
   *   **乗せないと分からない**ので、行の字にも出す。
   */
  it('🔴 1 組目にタグが無く、2 組目が残っているなら「無し」と言い切らない', () => {
    const { d, root } = withInspector();
    d.dispatch({
      type: 'BODY_LOADED',
      lid: 'n1',
      body: '---\nstatus: done\n---\n---\ntags: [買い物]\n本文\n',
    });
    const box = root.querySelector('[data-pkc-field="inspector-tags"]');
    expect(box?.textContent, '「無し」と言い切っている').toContain('2 組目');
  });

  it('🔴 cap を超えた文書の情報でも「無し」と断定しない', () => {
    const { d, root } = withInspector();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: `---\nk: ${'あ'.repeat(20000)}\n---\n本文\n` });
    const box = root.querySelector('[data-pkc-field="inspector-tags"]');
    expect(box?.textContent, 'cap 超過で「無し」と断定している').toBe('読めていません');
    // ⚠ **画面へ出す字は user の言葉**(2 巡目レビュー B-5)
    expect(box?.getAttribute('title') ?? '', '内部語がそのまま出ている').not.toMatch(
      /frontmatter|bytes|parse/,
    );
    expect(box?.getAttribute('title') ?? '').toContain('大きすぎて');
  });

  /**
   * ⚠ **直したら消えること**(状態が残らない)── 閉じを書き足せば元に戻る。
   * 🔑 `title` を消し忘れると、札が出ているのに古い理由が残る。
   */
  it('🔴 閉じを書き足せば、札に戻って理由も消える', () => {
    const { d, root } = withInspector();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '---\ntags: [買い物]\n本文\n' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '---\ntags: [買い物]\n---\n本文\n' });
    const box = root.querySelector('[data-pkc-field="inspector-tags"]');
    expect(
      [...root.querySelectorAll('[data-pkc-action="filter-by-tag"]')].map((c) => c.textContent),
      '直したのに札が戻らない',
    ).toEqual(['買い物']);
    expect(box?.getAttribute('title'), '古い理由が残っている').toBeNull();
  });
});
