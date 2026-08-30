/** @vitest-environment happy-dom */
/**
 * 🔴 **自由配置の板**(#283 P4)── 位置を当てる(place-board)/ 掴んで動かす
 * (place-drag)/ 書換の門(MOVE_PLACE)。
 *
 * ## 守る主張
 *
 * 1. `.pkc-place` の塊が **本文の記法の位置**に置かれる(x= y= w= h= z=)
 * 2. `entry=` の塊は**題名の札**になり、押すとそのノートへ飛ぶ(展開はしない)
 * 3. 🔴 掴んで離すと `MOVE_PLACE` が飛び、**開き行を捕えた** REQUEST_BODY_REWRITE になる
 *    ── 行は描画が焼いた `data-pkc-source-line`(+ frontmatter)で指す
 * 4. 🔴 編集中は声に出して断る(reducer 1 か所 ── 掴む口を足しても取りこぼさない)
 * 5. 動かしていない(slop 未満)/ 元の位置へ戻した(取りやめ)なら書かない
 * 6. 🔴 塊の `data-pkc-entry` は名前を替えて外す ── 札の中のチェックを押したとき、
 *    `toggle-task` の closest が別ノートへ書かないため(レビュー実測 2026-08-28)
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { installPlaceDrag } from '../../src/adapter/ui/render/place-drag';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  '- 牛乳',
  ':::',
  '',
  ':::format{#p2 .pkc-place entry=n2 x=460 y=40}',
  ':::',
].join('\n');

/** 描画が吐く形(place-probe で実測した属性の並び。source-line 含む)を模す。 */
const RENDERED = [
  '<div class="pkc-format-block pkc-place" id="p1" data-pkc-format-block data-pkc-h="200" data-pkc-w="320" data-pkc-x="120" data-pkc-y="40" data-pkc-source-line="0" data-pkc-source-end="3"><h3>買い出し</h3></div>',
  '<div class="pkc-format-block pkc-place" id="p2" data-pkc-format-block data-pkc-entry="n2" data-pkc-x="460" data-pkc-y="40" data-pkc-source-line="5" data-pkc-source-end="6"></div>',
].join('\n');

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('位置を当てる(applyPlaceLayout)', () => {
  function mounted() {
    const host = document.createElement('div');
    host.className = 'pkc-md-rendered';
    host.innerHTML = RENDERED;
    document.body.append(host);
    const titles = new Map([['n2', '相手のノート']]);
    const n = applyPlaceLayout(host, (l) => titles.get(l) ?? null, 0);
    return { host, n };
  }

  it('🔴 本文の記法の位置に置かれる(x= y= w= h=)', () => {
    const { host, n } = mounted();
    expect(n).toBe(2);
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    expect(p1.style.left).toBe('120px');
    expect(p1.style.top).toBe('40px');
    expect(p1.style.width).toBe('320px');
    expect(p1.style.height).toBe('200px');
    expect(host.classList.contains('pkc-board-host'), '器に板の印が無い').toBe(true);
    // いちばん下の塊(40+200)まで scroll で届く高さ
    expect(host.style.minHeight).toBe('280px');
  });

  it('🔑 開き行の行番号が焼かれる(source-line + frontmatter ぶん)', () => {
    const { host } = mounted();
    expect(
      [...host.querySelectorAll('.pkc-place')].map((el) => el.getAttribute('data-pkc-place-line')),
    ).toEqual(['0', '5']);
    // frontmatter があるノートでは、そのぶんずれる(taskLineOffset と同じ座標系)
    const host2 = document.createElement('div');
    host2.innerHTML = RENDERED;
    document.body.append(host2);
    applyPlaceLayout(host2, () => null, 3);
    expect(
      [...host2.querySelectorAll('.pkc-place')].map((el) => el.getAttribute('data-pkc-place-line')),
    ).toEqual(['3', '8']);
  });

  it('🔴 塊の data-pkc-entry は data-pkc-place-entry へ移して外す(closest の誤爆を作らない)', () => {
    const { host } = mounted();
    const p2 = host.querySelector<HTMLElement>('#p2')!;
    expect(p2.hasAttribute('data-pkc-entry'), '塊に data-pkc-entry が残っている').toBe(false);
    expect(p2.getAttribute('data-pkc-place-entry')).toBe('n2');
    // ⚠ 札の中に書いたチェックの印から closest で lid を引くと、当たるのは
    //   塊ではなく**札のボタンの外側 = 無し**であること(toggle-task は自ノートに書く)
    const inner = document.createElement('span');
    p2.prepend(inner);
    expect(inner.closest('[data-pkc-entry]')).toBeNull();
  });

  it('掴む口が 1 つずつ出る(2 回呼んでも増えない・見出しの字を汚さない・札も生き続ける)', () => {
    const { host } = mounted();
    applyPlaceLayout(host, () => '改名後', 0);
    const grips = host.querySelectorAll('[data-pkc-field="place-grip"]');
    expect(grips).toHaveLength(2);
    expect(grips[0]!.textContent, '印が字として入っている(写しが汚れる)').toBe('');
    expect(host.querySelector('h3')!.textContent).toBe('買い出し');
    // ⚠ 2 回目の呼び出し(entry は place-entry へ移設済み)でも札は描き直される
    expect(host.querySelector('#p2 [data-pkc-field="place-card"]')!.textContent).toBe('改名後');
  });

  it('🔴 entry= の塊は題名の札になり、押す先が select-entry(展開はしない)', () => {
    const { host } = mounted();
    const card = host.querySelector<HTMLButtonElement>('#p2 [data-pkc-field="place-card"]')!;
    expect(card.textContent).toBe('相手のノート');
    expect(card.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(card.getAttribute('data-pkc-entry')).toBe('n2');
  });

  it('相手が見つからないとき、いちばん多い原因(ID の貼り間違い)を先に言う', () => {
    const host = document.createElement('div');
    host.innerHTML = RENDERED;
    document.body.append(host);
    applyPlaceLayout(host, () => null, 0);
    const card = host.querySelector<HTMLButtonElement>('#p2 [data-pkc-field="place-card"]')!;
    expect(card.textContent).toBe('(見つかりません)');
    expect(card.title, '直し方(ID の形)を言っていない').toContain('entry:');
    expect(card.title).toContain('閉じ括弧');
  });

  it('板の塊が無ければ器の印も外す(戻り道)', () => {
    const { host } = mounted();
    host.innerHTML = '<p>ただの本文</p>';
    expect(applyPlaceLayout(host, () => null, 0)).toBe(0);
    expect(host.classList.contains('pkc-board-host')).toBe(false);
    expect(host.style.minHeight).toBe('');
  });

  it('読めない値(x="abc")は 0 扱い(黙って落ちない)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="pkc-format-block pkc-place" data-pkc-x="abc"></div>';
    document.body.append(host);
    applyPlaceLayout(host, () => null, 0);
    expect(host.querySelector<HTMLElement>('.pkc-place')!.style.left).toBe('0px');
  });
});

describe('書換の門(MOVE_PLACE)', () => {
  function booted() {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', '板'), meta('n2', '相手のノート')],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
    events.length = 0;
    return { d, events };
  }

  it('🔴 開き行を捕えた REQUEST_BODY_REWRITE になる', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: 5, x: 10, y: 20 });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n1',
      rewrite: {
        kind: 'place-move',
        line: 5,
        openLine: ':::format{#p2 .pkc-place entry=n2 x=460 y=40}',
        x: 10,
        y: 20,
      },
    });
  });

  it('🔴 編集中は声に出して断る(掴む口を足しても取りこぼさない ── reducer 1 か所)', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: 0, x: 1, y: 2 });
    expect(d.getState().error ?? '', '理由が出ていない').toContain('編集を終了');
    expect(d.getState().error ?? '', '押した場所と文言が合っていない').toContain('板');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  /**
   * 🔴 **横に留めた枠の付箋も、その枠のノートへ書く**(#281 検算 2026-08-30)。
   *
   * ⚠ 直す前は `openBody` だけを見ていたので、留めた枠の付箋を動かすと
   *   ①主の枠が板でなければ**黙って no-op** ②主の枠も板なら**別のノートの
   *   同じ行を書き換えうる**、の 2 つに落ちていた。
   * 🔑 この it は**主の枠を板ではないノート**にして撃つ ── そうしないと、
   *   openBody から拾った行が偶然一致して「直った」に見えることがある。
   */
  it('🔴 横に留めた枠の付箋は、その枠のノートの行を書く(主の枠ではない)', () => {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 'ふつうのノート'), meta('n2', '板')],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'ただの本文\nもう 1 行\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: BOARD });
    events.length = 0;

    d.dispatch({ type: 'MOVE_PLACE', lid: 'n2', line: 5, x: 10, y: 20 });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '留めた枠の付箋を動かしても書換の依頼が出ない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n2',
      rewrite: { kind: 'place-move', line: 5, openLine: BOARD.split('\n')[5], x: 10, y: 20 },
    });
  });

  /**
   * 対照群 ── 🔑 **留めていない lid では書かない。** これが無いと、上の it は
   * 「lid の門を丸ごと外した」変異でも緑になる(門が生きていることを見ていない)。
   */
  it('🔴 対照群: 留めてもいない・開いてもいない lid では書かない', () => {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 'ふつうのノート'), meta('n2', '板')],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'ただの本文\nもう 1 行\n' });
    events.length = 0;
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n2', line: 5, x: 10, y: 20 });
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('🔴 開いているノートと違う lid では書かない(実在する別ノートの lid でも)', () => {
    const { d, events } = booted();
    // ⚠ metas に**実在する** n2 で撃つ ── 「meta が無いから」の門に救われない形で、
    //   「openBody と違うから」の門そのものを見る(§1「救い手が別」)
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n2', line: 0, x: 1, y: 2 });
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('板の開き行でない行 / 範囲の外の行は書かない', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: 2, x: 1, y: 2 });
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: 99, x: 1, y: 2 });
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', line: -1, x: 1, y: 2 });
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });
});

describe('掴んで動かす(place-drag)', () => {
  function mounted() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const host = document.createElement('div');
    host.innerHTML = RENDERED;
    root.append(host);
    applyPlaceLayout(host, () => null, 0);
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '板')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
    events.length = 0;
    const off = installPlaceDrag(root, d);
    const grip = host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-grip"]')!;
    const block = host.querySelector<HTMLElement>('#p1')!;
    return { root, host, d, events, off, grip, block };
  }

  const opts = { bubbles: true, pointerId: 1, button: 0 };

  function down(grip: HTMLElement, x = 0, y = 0, o: Record<string, unknown> = opts): void {
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: x, clientY: y }));
  }
  function move(x: number, y: number, o: Record<string, unknown> = opts): void {
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x, clientY: y }));
  }
  function up(x: number, y: number, o: Record<string, unknown> = opts): void {
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x, clientY: y }));
  }
  function drag(grip: HTMLElement, dx: number, dy: number): void {
    down(grip);
    move(dx, dy);
    up(dx, dy);
  }

  it('🔴 掴んで離すと、動いた先の位置で MOVE_PLACE → 書換の依頼が飛ぶ(行番号つき)', () => {
    const { events, grip, block, off } = mounted();
    down(grip);
    move(30, -10);
    // 掴んでいる間は見た目だけ動く
    expect(block.style.left).toBe('150px');
    expect(block.style.top).toBe('30px');
    up(30, -10);
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({ rewrite: { kind: 'place-move', line: 0, x: 150, y: 30 } });
    // ⚠ 見た目はいったん戻る ── 書けた位置は BODY_REWRITTEN の再描画が置き直す。
    //   戻さないと、断られた drop で画面と本文が食い違ったまま残る(レビュー所見 5)
    expect(block.style.left).toBe('120px');
    expect(block.style.top).toBe('40px');
    off();
  });

  it('slop 未満(押しただけ)では動かさず、書かない', () => {
    const { events, grip, block, off } = mounted();
    drag(grip, 2, 2);
    expect(block.style.left).toBe('120px');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
    off();
  });

  it('🔑 動かして元の位置へ戻して離す(取りやめ)── 何も書かず、見た目も戻る', () => {
    const { events, grip, block, off } = mounted();
    down(grip);
    move(30, 30);
    move(0, 0);
    up(0, 0);
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
    expect(block.style.left).toBe('120px');
    off();
  });

  it('左上より外へは出さない ── 掴んでいる間の見た目も、書く座標も 0 で止まる', () => {
    const { events, grip, block, off } = mounted();
    down(grip);
    move(-500, -500);
    // ⚠ 見た目の clamp(離す前)── event だけ見ると、この行を消しても緑になる
    expect(block.style.left).toBe('0px');
    expect(block.style.top).toBe('0px');
    up(-500, -500);
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev).toMatchObject({ rewrite: { kind: 'place-move', x: 0, y: 0 } });
    off();
  });

  it('🔴 動かした後の click は 1 回だけ飲む(離した指が札の押し物に落ちない)', () => {
    const { grip, block, off } = mounted();
    drag(grip, 30, 30);
    const click1 = new MouseEvent('click', { bubbles: true, cancelable: true });
    block.dispatchEvent(click1);
    expect(click1.defaultPrevented, 'drop 直後の click が素通りしている').toBe(true);
    const click2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    block.dispatchEvent(click2);
    expect(click2.defaultPrevented, '2 回目の click まで飲んでいる').toBe(false);
    off();
  });

  it('途中で切れたら(pointercancel)見た目を戻し、その後の move は効かない', () => {
    const { events, grip, block, off } = mounted();
    down(grip);
    move(30, 30);
    expect(block.style.left).toBe('150px');
    document.dispatchEvent(new PointerEvent('pointercancel', { ...opts }));
    expect(block.style.left).toBe('120px');
    move(60, 60);
    expect(block.style.left, '掴みが生きたままになっている').toBe('120px');
    up(60, 60);
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
    off();
  });

  it('🔴 掴んでいる最中の 2 本目の指では掴み直さない(1 枚目を置き去りにしない)', () => {
    const { host, grip, block, off } = mounted();
    const grip2 = host.querySelector<HTMLElement>('#p2 [data-pkc-field="place-grip"]')!;
    const block2 = host.querySelector<HTMLElement>('#p2')!;
    down(grip);
    move(30, 30);
    const o2 = { ...opts, pointerId: 2 };
    down(grip2, 0, 0, o2);
    move(90, 90, o2);
    expect(block2.style.left, '2 本目の指が別の塊を掴んでいる').toBe('460px');
    // 1 本目の掴みは生きている
    move(50, 50);
    expect(block.style.left).toBe('170px');
    up(50, 50);
    off();
  });
});

/**
 * 🔴 **位置の CSS は読む面(board-host)だけに当てる**(レビュー所見 3・6、2026-08-28)。
 *
 * `.pkc-md-rendered` 起点の規則は**編集の 2 面と書き出した閲覧用 HTML にも**当たる。
 * 位置を当てる `place-board.ts` はそこに居ないので、絶対配置をそちらへ書くと
 * **付箋が左上に積み重なった壊れた面**になる(書き出した 1 枚は配った相手に届く)。
 * ⚠ happy-dom は描画しないので、規則は**構文で**読む(`css-blocks` の作法)。
 */
describe('板の CSS ── 位置は board-host 起点だけ', () => {
  const APP = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

  it('🔴 絶対配置(+ 読み幅の上限外し)は .pkc-board-host 起点', () => {
    const pos = blocksFor(APP, '.pkc-board-host .pkc-format-block.pkc-place').join(';');
    expect(pos, '位置の規則が無い(選択子を変えたならこの test も追随する)').toContain(
      'position: absolute',
    );
    expect(pos, '板の上では読み幅の上限(--read-w)を外す ── w= を 672px で黙って切らない').toContain(
      'max-width: none',
    );
  });

  it('🔴 見た目の規則(.pkc-md-rendered 起点)に位置を混ぜない', () => {
    const look = blocksFor(APP, '.pkc-md-rendered .pkc-format-block.pkc-place').join(';');
    expect(look, '見た目の規則が無い(選択子を変えたならこの test も追随する)').toContain('border');
    expect(look, '編集面・書き出しで付箋が積み重なる(position が漏れている)').not.toContain(
      'position',
    );
  });
});
