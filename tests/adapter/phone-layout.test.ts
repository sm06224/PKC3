/** @vitest-environment happy-dom */
/**
 * スマホ用画面を画面へ写す(#632 段①)。実体は
 * `src/adapter/ui/render/phone-layout.ts` / `src/styles/app.css` の末尾。
 *
 * 🔴 守る主張:
 * 1. 幅の数字は **TS 1 か所**。CSS には 1 文字も無い(2 か所に割れると別の幅で切り替わる)
 * 2. 出ていない面は **`visibility: hidden` + `inert`**(`display: none` にしない)
 * 3. スマホでは**列の畳みを画面へ写さない**(#609 の行き止まりを作らない)
 * 4. 版面が入れ替わったら**写し直す**(畳んだまま窓を狭めた回だけ一覧が消える、を作らない)
 * 5. 情報ページは**開いたノートでだけ**出る / 帯からは必ず戻れる
 * 6. 編集中に本文ページから出ようとしたら**理由を言う**(無言の dead click にしない)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { appPhone } from '../../src/adapter/ui/render/phone-layout';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { PHONE_MAX_HEIGHT_PX, PHONE_MAX_PX, PHONE_MIN_PX } from '../../src/features/phone-layout';
import { ENTRY_MENU_ACTIONS, NOTE_TOOL_ACTIONS } from '../../src/features/entry-actions';
import { blocksFor, decl, mediaBlock, stripComments, withoutMedia } from '../helpers/css-blocks';

/** 幅の見張りの替え玉。⚠ `matches` を手で動かして `change` を撃つ。 */
class FakeMedia {
  matches: boolean;
  private readonly fns: (() => void)[] = [];
  constructor(matches: boolean) {
    this.matches = matches;
  }
  addEventListener(_t: 'change', fn: () => void): void {
    this.fns.push(fn);
  }
  removeEventListener(_t: 'change', fn: () => void): void {
    const i = this.fns.indexOf(fn);
    if (i >= 0) this.fns.splice(i, 1);
  }
  set(v: boolean): void {
    this.matches = v;
    for (const fn of [...this.fns]) fn();
  }
}

const META = (lid: string, title: string, archetype = 'text') =>
  ({
    lid,
    title,
    archetype,
    created_at: null,
    updated_at: null,
    entry_order: 1,
    status: null,
    date: null,
    archived: 0,
  }) as never;

function setup(phone: boolean) {
  document.body.textContent = '';
  localStorage.clear();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  buildShell(root);
  const said: string[] = [];
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [META('n1', '買い物'), META('n2', '日記')],
    relations: [],
  });
  bindActions(root, d, { showStatus: (t) => said.push(t) });
  const media = new FakeMedia(phone);
  /**
   * 🔴 **見張りは 2 本あるので、問い合わせごとに別の替え玉を返す**(#632 段③)。
   *
   * ⚠ 1 本しか返さないと、**スマホ幅にした瞬間に「対応外」も真**になる ──
   *   360〜720px は**対応している幅**なので、それは製品と逆である。
   * 🔑 `narrow` の既定は `false`(= 対応している幅)── 対応外を測る test だけが
   *   `s.narrow.set(true)` で狭める。
   */
  const narrow = new FakeMedia(false);
  const mm = (q: string): FakeMedia =>
    q.includes(`${PHONE_MIN_PX - 1}px`) ? narrow : media;
  appPhone.install(root, mm, () => applyPaneVisibility(root, appPanes.getHidden()));
  const push = (): void => {
    const st = d.getState();
    appPhone.render({
      selectedLid: st.selectedLid,
      viewMode: st.viewMode,
      editing: st.phase === 'editing',
      title: st.selectedLid === null ? '' : (st.entryMetas.get(st.selectedLid)?.title ?? ''),
    });
  };
  d.onState(push);
  push();
  const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
  return {
    root,
    d,
    said,
    media,
    narrow,
    shell,
    page: () => shell.getAttribute('data-pkc-page'),
    layout: () => shell.getAttribute('data-pkc-layout'),
    bar: () => root.querySelector<HTMLElement>('[data-pkc-region="phone-bar"]')!,
    field: (name: string) => root.querySelector<HTMLElement>(`[data-pkc-field="${name}"]`)!,
    menu: () => root.querySelector('[data-pkc-region="context-menu"]'),
    open: (lid: string) => {
      d.dispatch({ type: 'SELECT_ENTRY', lid });
      d.dispatch({ type: 'BODY_LOADED', lid, body: '本文' });
    },
    /**
     * 一覧の行と**同じ押し口**(`select-entry` + `data-pkc-entry`)。
     * ⚠ renderer はこの台に居ないので手で置く ── 綴りは `binder.ts` の受け手が
     *   読む 2 つと同じにする(違えば押しても何も起きず、test が空振りする)。
     */
    row: (lid: string) => {
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'select-entry');
      b.setAttribute('data-pkc-entry', lid);
      root.append(b);
      return b;
    },
  };
}

/** ⚠ 共有の 1 個を PC の版面へ戻す ── 残すと別の file の test が phone のまま走る。 */
afterEach(() => {
  const off = document.createElement('div');
  appPhone.install(off, () => new FakeMedia(false));
});

describe('版面の切り替え(属性)', () => {
  it('🔴 PC の幅では印を 1 つも書かない(既定の画面は 1 バイトも変わらない)', () => {
    const s = setup(false);
    expect(s.layout()).toBeNull();
    expect(s.page()).toBeNull();
    expect(s.bar().hidden, 'PC で帯が出ている').toBe(true);
  });

  it('🔴 スマホの幅では layout=phone / page=list(何も選んでいない)', () => {
    const s = setup(true);
    expect(s.layout()).toBe('phone');
    expect(s.page()).toBe('list');
    expect(s.bar().hidden, '一覧に帯を出している(押す先が無い)').toBe(true);
  });

  it('🔴 行を開くと本文ページへ進む ── 進む側の配線は 0 行(state から導く)', () => {
    const s = setup(true);
    s.open('n1');
    expect(s.page()).toBe('note');
    expect(s.bar().hidden).toBe(false);
    expect(s.field('phone-title').textContent).toBe('買い物');
  });

  it('🔴 出ていない面は inert(隠れた面へ Tab が入らない)', () => {
    const s = setup(true);
    s.open('n1');
    const has = (region: string) =>
      s.shell.querySelector(`[data-pkc-region="${region}"]`)!.hasAttribute('inert');
    expect(has('center'), '出ている面が inert').toBe(false);
    expect(has('sidebar'), '隠れた一覧が inert でない').toBe(true);
    expect(has('inspector'), '隠れた情報が inert でない').toBe(true);
    // 対照群: PC の幅へ戻すと 3 面とも外れる
    s.media.set(false);
    expect(has('center') || has('sidebar') || has('inspector'), 'PC でも inert が残る').toBe(false);
  });

  /**
   * 🔴 **面(設定・ヘルプ・2 ペイン・集計)のページを、どの test も触っていなかった**
   *   (着地前レビュー 4)。⚠ `FACE.pane` を `'sidebar'` に変える変異は
   *   **CSS が center を出したまま center に `inert` を付ける**ので、
   *   設定の中も「× 閉じる」も押せない**完全な行き止まり**になるのに、
   *   落ちる test が 1 つも無かった。
   */
  it('🔴 面のページでは、その面が押せて「× 閉じる」で戻れる', () => {
    const s = setup(true);
    s.open('n1');
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' });
    expect(s.page()).toBe('pane');
    const inertOf = (region: string) =>
      s.shell.querySelector(`[data-pkc-region="${region}"]`)!.hasAttribute('inert');
    expect(inertOf('center'), '面を出しているのに中央が inert(何も押せない)').toBe(false);
    expect(inertOf('sidebar'), '一覧が inert でない').toBe(true);
    expect(inertOf('inspector'), '情報が inert でない').toBe(true);
    /**
     * 🔴 **戻る口が本当に効く**。⚠ 実物の「× 閉じる」は `CenterRouter` の帯が持つ
     *   (`center.ts` の `pane-bar`)ので、この台(shell だけ)には居ない ──
     *   **中央の面の中に**同じ受け手を置いて、`inert` の内側でないことごと見る。
     */
    const close = s.root.ownerDocument.createElement('button');
    close.setAttribute('data-pkc-action', 'close-pane');
    s.root.querySelector('[data-pkc-region="center"]')!.append(close);
    close.click();
    expect(s.d.getState().viewMode, '面から戻れない(行き止まり)').toBe('detail');
    expect(s.page()).toBe('note');
  });

  it('🔴 幅が戻れば印も消える(狭めたまま広げて版面が壊れない)', () => {
    const s = setup(true);
    s.open('n1');
    s.media.set(false);
    expect(s.layout()).toBeNull();
    // ⚠ ページの印も消す ── `layout` だけ見ていると片方を残す変異が生き延びる
    expect(s.page(), 'ページの印が残っている').toBeNull();
    expect(s.bar().hidden).toBe(true);
    s.media.set(true);
    expect(s.layout()).toBe('phone');
    expect(s.page()).toBe('note');
  });
});

describe('情報ページ(#609 の行き止まりを作らない)', () => {
  it('🔴 情報 → ← ノート で戻れる(帯の字と行き先が一緒に変わる)', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-info').click();
    expect(s.page()).toBe('info');
    const back = s.field('phone-back');
    expect(back.textContent, '情報ページで「← 一覧」のまま').toBe('← ノート');
    expect(back.getAttribute('data-pkc-page')).toBe('note');
    expect(s.field('phone-info').hidden, 'いま居る場所へ行くボタンが出たまま').toBe(true);
    back.click();
    expect(s.page()).toBe('note');
    expect(s.field('phone-back').textContent).toBe('← 一覧');
  });

  /**
   * 🔴 **帯は面の中に置かない**(2026-09-02、実装の 1 稿目で踏んだ)。
   *
   * ⚠ 1 稿目は帯を `center` の先頭子にしていた ── スマホは 3 面を重ねて 1 枚ずつ
   *   出すので、**情報ページでは center ごと隠れ、帯も一緒に消えた**。
   *   「← ノート」が画面から無くなる = 情報ページが行き止まり(#609 と同じ型)。
   * 🔑 だから**器の位置そのものを pin する** ── 「見えているか」は happy-dom では
   *   測れない(CSS を描かない)が、**どこに居るか**なら測れる。
   */
  it('🔴 帯は shell の子である(面と一緒に隠れない)', () => {
    const s = setup(true);
    const bar = s.bar();
    expect(bar.parentElement?.getAttribute('data-pkc-region'), '帯が面の中に居る').toBe('shell');
    expect(
      bar.closest('[data-pkc-region="center"]'),
      '帯が中央の面の中に居る(情報ページで一緒に消える)',
    ).toBeNull();
    // ⚠ Tab がまず戻る口に当たる(並びの先頭)
    expect(bar.previousElementSibling, '帯が shell の先頭に居ない').toBeNull();
  });

  it('🔴 設定などの面ではページの帯を出さない(戻る口が 2 本並ばない)', () => {
    const s = setup(true);
    s.open('n1');
    expect(s.bar().hidden).toBe(false);
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' });
    expect(s.page(), '面を開いたのに本文ページのまま').toBe('pane');
    expect(s.bar().hidden, '面の「× 閉じる」と ← が並んでいる').toBe(true);
    // 対照群: 面を閉じれば帯は戻る
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    expect(s.bar().hidden).toBe(false);
  });

  it('🔴 別のノートへ移ると情報は自分で閉じる', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-info').click();
    expect(s.page()).toBe('info');
    s.open('n2');
    expect(s.page(), '前のノートの情報が出たまま').toBe('note');
    expect(s.field('phone-title').textContent).toBe('日記');
  });

  /**
   * 🔴 **← 一覧 でノートは開いたまま**(user 裁定 2026-09-02)。
   *
   * ⚠ 直す前は `DESELECT_ENTRY` を撃っていたので、**戻った瞬間に
   *   「さっきまで読んでいた物」が消えていた**。
   */
  it('🔴 ← 一覧 で一覧へ戻るが、ノートは開いたまま', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-back').click();
    expect(s.page()).toBe('list');
    expect(s.d.getState().selectedLid, '選択まで外れた').toBe('n1');
  });

  /**
   * 🔴 **一覧の上に「ノートへ →(題名)」が出る**(user 裁定 2026-09-02)。
   * ⚠ **題名まで見る** ── 字が空だと、user はどのノートへ戻るのか読めない。
   */
  it('🔴 一覧の上に「ノートへ →」が題名つきで出て、押すと本文へ戻る', () => {
    const s = setup(true);
    s.open('n1');
    const back = s.field('phone-return');
    expect(back.hidden, '本文を見ている間に出ている').toBe(true);
    s.field('phone-back').click();
    expect(back.hidden, '一覧に戻る口が無い').toBe(false);
    /**
     * 🔴 **字も pin する**(着地前レビュー 5)。⚠ 直す前は題名しか見ておらず、
     *   「ノートへ →」を空文字にしても緑だった ── 一覧の頭に**灰色の題名が
     *   1 行出るだけ**になり、押せることもどこへ行くかも読めない。
     */
    expect(back.textContent, 'どこへ行く行なのか字が無い').toContain('ノートへ');
    expect(s.field('phone-return-title').textContent).toBe('買い物');
    back.click();
    expect(s.page(), '「ノートへ →」で戻れない').toBe('note');
    expect(back.hidden, '本文に戻ったのに行が残っている').toBe(true);
  });

  /**
   * 🔴 **同じ行をもう一度押しても本文へ戻る**(user 裁定 2026-09-02 の肝)。
   *
   * ⚠ ここが設計 doc §2-6 が「一覧を出したまま選択を保つ bit」を**一度棄却した
   *   理由**である ── `SELECT_ENTRY` は同じ lid なら同じ state を返し、
   *   `dispatcher` は `changed` のときだけ listener を呼ぶので、
   *   **`render` が走らず一覧に留まる dead tap** になる。
   * 🔑 だから `selectEntryOrExplain` が**押された側で直に**畳む。
   * ⚠ **対照群を同じ it に置く**(別のノートの行)── 置かないと
   *   「別のノートなら動く(= state が動いたから)」だけを見て通してしまう。
   */
  it('🔴 一覧で「いま開いているノート」の行を押しても本文へ戻る(dead tap を作らない)', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-back').click();
    expect(s.page()).toBe('list');
    expect(s.d.getState().selectedLid).toBe('n1');
    // ⚠ 一覧の行と同じ押し口を作る(renderer は台に居ないので手で置く)
    s.row('n1').click();
    expect(s.page(), '同じ行を押しても一覧のまま = dead tap').toBe('note');
    // 対照群: 別のノートの行でも同じく本文へ出る
    s.field('phone-back').click();
    expect(s.page()).toBe('list');
    s.row('n2').click();
    expect(s.page()).toBe('note');
    expect(s.d.getState().selectedLid).toBe('n2');
  });

  /** ⚠ 起動直後(何も開いていない)の一覧には出さない ── 押す先が無い行になる。 */
  it('🔴 何も開いていない一覧には「ノートへ →」を出さない', () => {
    const s = setup(true);
    expect(s.page()).toBe('list');
    expect(s.field('phone-return').hidden).toBe(true);
  });

  /**
   * 🔴 **列のいちばん上に在る**(着地前レビュー 6)。
   *
   * ⚠ `shell.ts` は「戻る口は探す前に見える場所に在るべきで、一覧を下へ流しても
   *   隠れない」と主張しているのに、**置き場を見る検査が 1 つも無かった** ──
   *   一覧の下端へ動かしても unit は `hidden` と字しか見ず、smoke の `clickReal` は
   *   `scrollIntoViewIfNeeded` を呼ぶので緑になる。
   * 🔴 壊れる形:ノートが 50 件ある人は**戻る行が流れて見えない**(この裁定の主題
   *   そのものが消える)。
   */
  it('🔴 「ノートへ →」は左の列のいちばん上に在る(下へ流れない)', () => {
    const s = setup(true);
    const sidebar = s.shell.querySelector('[data-pkc-region="sidebar"]')!;
    expect(
      sidebar.firstElementChild?.getAttribute('data-pkc-region'),
      '戻る行が列の先頭に無い(一覧を流すと隠れる)',
    ).toBe('phone-return');
  });

  /** ⚠ PC の版面では 1px も場所を取らない。 */
  it('🔴 PC の幅では「ノートへ →」は出ない', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-back').click();
    expect(s.field('phone-return').hidden).toBe(false);
    s.media.set(false);
    expect(s.field('phone-return').hidden, 'PC の版面に残っている').toBe(true);
  });
});

describe('編集中の戻り(無言の dead click にしない)', () => {
  it('🔴 編集中に ← / 情報 を押すと理由が出て、ページは動かない', () => {
    const s = setup(true);
    s.open('n1');
    s.d.dispatch({ type: 'START_EDIT' });
    expect(s.d.getState().phase, '台が編集に入っていない(前提が崩れた)').toBe('editing');
    s.field('phone-back').click();
    expect(s.page(), '編集中に一覧へ戻ってしまった').toBe('note');
    expect(s.d.getState().error).toContain('保存するか取り消してから');
    s.field('phone-info').click();
    expect(s.page(), '編集中に情報へ移ってしまった').toBe('note');
  });

  /** ⚠ **対照群** ── 編集を抜ければ同じボタンが効く(常に断る実装を殺す)。 */
  it('編集を抜ければ同じボタンで戻れる', () => {
    const s = setup(true);
    s.open('n1');
    s.d.dispatch({ type: 'START_EDIT' });
    s.d.dispatch({ type: 'CANCEL_EDIT' });
    s.field('phone-back').click();
    expect(s.page()).toBe('list');
  });
});

describe('⋯(本文ページから届く操作)', () => {
  it('🔴 右クリックと同じ項目 + 操作を探す が出る', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-menu').click();
    const menu = s.menu();
    expect(menu, '⋯ を押してもメニューが出ない').not.toBeNull();
    const labels = [...menu!.querySelectorAll('button')].map((b) => b.textContent);
    for (const a of ENTRY_MENU_ACTIONS.filter((a) => a.when === undefined))
      expect(labels, `右クリックの「${a.label}」が ⋯ に無い`).toContain(a.label);
    expect(labels, 'パレットへの入口が無い(左の列は見えていない)').toContain('操作を探す');
  });

  it('🔴 押した物の身元をボタンへ写す(メニューは器の外に出る)', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-menu').click();
    const b = s.menu()!.querySelector('button')!;
    expect(b.getAttribute('data-pkc-menu-lid')).toBe('n1');
  });

  it('🔴 もう一度 ⋯ を押すと閉じる(片道の操作を作らない)', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-menu').click();
    expect(s.menu()).not.toBeNull();
    s.field('phone-menu').click();
    expect(s.menu(), '2 度目の ⋯ で閉じない').toBeNull();
  });

  it('ノートを開いていなければ空の箱を出さない', () => {
    const s = setup(true);
    s.field('phone-menu').click();
    expect(s.menu()).toBeNull();
  });
});

/**
 * 🔴 **左の列の道具は、本文ページからも届く**(#632 段①、設計 doc §2-7)。
 *
 * ⚠ 4 つとも「いま開いているノート」に効くのに、押し口は**一覧の中にしか無い** ──
 *   スマホでは一覧と本文が同時に出ないので、本文を開いている間は押せず、
 *   一覧へ戻ると `selectedLid` が消えて**対象が居なくなる**(円環の dead click)。
 */
describe('⋯ と左の列の等値(次に足した人が気づく)', () => {
  /**
   * 🔴 **既知リストで pin する**(`KNOWN_DEAD` と同じ作法)。
   * ⚠ 「`selectedLid` を読む受け手」は機械的に数えられない(受け手の中を読むことに
   *   なる)ので、**顔ぶれを等値で留めて、足した人に分類させる**。
   */
  const CREATE_BAR = [
    // 「いま開いているノート」に効かない 3 つ ── ⋯ には出さない
    'create-entry',
    'toggle-create-menu',
    'open-today',
    // 「いま開いているノート」に効く 4 つ ── ⋯ に出す
    'attach-file',
    'start-audio-capture',
    'start-screen-capture',
    'start-timer',
  ];

  it('🔴 左の列の道具の顔ぶれが変わっていない(増えたらここで気づく)', () => {
    const s = setup(false);
    const acts = [...s.root.querySelectorAll('[data-pkc-region="create-bar"] [data-pkc-action]')]
      .map((e) => e.getAttribute('data-pkc-action'))
      .filter((a): a is string => a !== null);
    expect(acts, '左の列の道具が増減した ── ⋯ に出すかを決めて、この表を直す').toEqual(
      CREATE_BAR,
    );
  });

  it('🔴 ノートに効く 4 つは、全部 ⋯ から押せる', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-menu').click();
    const acts = [...s.menu()!.querySelectorAll('button')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    for (const a of NOTE_TOOL_ACTIONS)
      expect(acts, `${a.action} が ⋯ に無い(本文ページから押せない)`).toContain(a.action);
    // ⚠ 対照群: ノートに効かない 3 つは出さない(⋯ を「左の列の写し」にしない)
    for (const a of ['create-entry', 'toggle-create-menu', 'open-today'])
      expect(acts, `${a} まで ⋯ に出ている`).not.toContain(a);
  });

  /**
   * 🔴 **「在る」ではなく「押して効く」まで見る**(着地前レビュー 欠陥 1。2026-09-02)。
   *
   * ⚠ 上の test は題名に「押せる」と書きながら、**メニューに項目が在るか**しか
   *   見ていなかった ── だから `attach-file` が**押しても無反応**なまま緑だった。
   * 🔴 原因は `⋯` のメニューが **root の直下**に出ること(`context-menu.ts` が
   *   自分でそう戒めている)── 受け手が `target.closest('…shell…')` を辿ると
   *   **必ず null** になり、`?.` が例外ごと飲むので**理由も出ない**。
   * ⚠ 他の 3 つは `target` を読まないので通る ── **3 つ通ったから 4 つ通った**と
   *   読める形だった(§1「別の物に満たされる」の顔違い)。
   */
  it('🔴 ⋯ の「添付」を押すと、ファイルを選ぶ口が実際に開く', () => {
    const s = setup(true);
    s.open('n1');
    const input = s.root.querySelector<HTMLInputElement>('[data-pkc-field="attach-input"]')!;
    expect(input, '常設の hidden input が無い(台の前提が崩れた)').not.toBeNull();
    let opened = 0;
    input.addEventListener('click', () => {
      opened += 1;
    });
    // 対照群: 左の列から押すと開く(器の外から押したときだけ壊れる、を見分ける)
    s.root
      .querySelector<HTMLElement>('[data-pkc-region="create-bar"] [data-pkc-action="attach-file"]')!
      .click();
    expect(opened, '左の列からも開かない(この test は何も見ていない)').toBe(1);

    s.field('phone-menu').click();
    s.menu()!
      .querySelector<HTMLElement>('[data-pkc-action="attach-file"]')!
      .click();
    expect(opened, '⋯ から押してもファイルを選ぶ口が開かない(無言の dead click)').toBe(2);
  });

  /**
   * 🔴 **危ない物はいちばん下**(着地前レビュー 欠陥 7)。
   * ⚠ `entry-actions.ts` が「**消す物をいちばん下**に置く ── 上から順に押していく人が、
   *   勢いで `削除` に当たらないため」と明記しているのに、⋯ は道具 5 つを**後ろへ**
   *   足したので、削除が**真ん中**へ来ていた(行の丈は 26px、隙間 1px)。
   */
  it('🔴 ⋯ でも「削除」はいちばん下に在る', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-menu').click();
    const acts = [...s.menu()!.querySelectorAll('button')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(acts, '削除がメニューに無い(台の前提が崩れた)').toContain('delete-entry');
    expect(acts[acts.length - 1], '削除がいちばん下ではない').toBe('delete-entry');
    // ⚠ 空振り防止 ── 道具も操作を探すも、ちゃんと同じメニューに載っている
    expect(acts).toContain('attach-file');
    expect(acts).toContain('open-palette');
  });

  /**
   * 🔴 **毎日使うものを上へ**(user 裁定 2026-09-02)。
   *
   * ⚠ 直す前は右クリックの 11 項目(印を付ける / 複製 / 書き出す…)が先頭を占め、
   *   **添付・録音・画面録画・計測が下**だった ── スマホでこの 4 つに届く道は
   *   ⋯ **しか無い**のに、いちばん遠い所に置いていた。
   * ⚠ **並びごと等値で pin する** ── 「含まれている」だけ見ると、順番を壊す変異が
   *   生き延びる(この test の主張はまさに順番である)。
   */
  it('🔴 ⋯ の先頭は、毎日使う 4 つ(添付 / 録音 / 画面録画 / 時間を計る)', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-menu').click();
    const acts = [...s.menu()!.querySelectorAll('button')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(acts.slice(0, NOTE_TOOL_ACTIONS.length), '毎日使う道具が先頭に無い').toEqual(
      NOTE_TOOL_ACTIONS.map((a) => a.action),
    );
    /**
     * ⚠ **対照群 2 つ** ── 頭へ寄せたせいで、後ろの決まりが崩れていないこと:
     *   ① 右クリックの項目はその**次**に続く ② 危ない物といちばん下は不動。
     */
    expect(acts[NOTE_TOOL_ACTIONS.length], '右クリックの項目が続いていない').toBe(
      ENTRY_MENU_ACTIONS.filter((a) => a.when === undefined)[0]!.action,
    );
    expect(acts[acts.length - 1], '削除がいちばん下ではない').toBe('delete-entry');
    expect(acts[acts.length - 2], '操作を探す が削除の直前ではない').toBe('open-palette');
  });

  it('🔴 表と実物の綴りが合っている(受け手を新しく作っていない)', () => {
    const s = setup(false);
    for (const a of NOTE_TOOL_ACTIONS)
      expect(
        s.root.querySelector(`[data-pkc-region="create-bar"] [data-pkc-action="${a.action}"]`),
        `${a.action} が左の列に無い ── ⋯ 専用の受け手を作っている`,
      ).not.toBeNull();
  });

  /**
   * 🔴 **同じ操作の説明が 2 か所にある ── 片方だけ直る形を止める**
   * (#666 の着地前レビュー 6)。
   *
   * ⚠ 説明は**左の列のボタンの `title`**(`shell.ts`)と**`⋯` の説明欄**
   *   (`ENTRY_ACTION_HINTS`)の 2 か所にある。⚠ 後者は digest で pin されて
   *   いたが、**前者を指す検査は 1 件も無かった** ── だから #666 で「添付」の
   *   説明を直したとき、`⋯` 側だけが直り、**左の列は古い字のまま**残った。
   *
   * 🔑 **字が違うのには理由がある。1 本に寄せない**:
   *   左の列のボタンは**特定のノートを指していない**ので「**いま開いている
   *   ノート**」、`⋯` は**その行を右クリックして開いた**メニューなので
   *   「**このノート**」である。寄せるとどちらかが必ず嘘になる。
   * 🔑 だから**対で pin する** ── どちらかを直すと落ちるので、
   *   もう片方を見ずに済ませられない。
   */
  it('🔴 左の列の 4 つのボタンの説明が、⋯ の説明と対で管理されている', () => {
    const KNOWN: ReadonlyArray<readonly [string, string]> = [
      ['attach-file', 'a6636dfe'],
      ['start-audio-capture', '482a19bc'],
      ['start-screen-capture', '166e461a'],
      ['start-timer', 'ef2332cc'],
    ];
    // ⚠ 空振り防止 ── 道具が増減したまま「全部一致した」と言わない
    expect(KNOWN.length, '道具の数と表の行数が違う').toBe(NOTE_TOOL_ACTIONS.length);
    const s = setup(false);
    const digest = (h: string): string =>
      createHash('sha256').update(h).digest('hex').slice(0, 8);
    const drift: string[] = [];
    for (const [action, want] of KNOWN) {
      const b = s.root.querySelector<HTMLElement>(
        `[data-pkc-region="create-bar"] [data-pkc-action="${action}"]`,
      );
      expect(b, `左の列に ${action} が無い`).not.toBeNull();
      const title = b!.title;
      expect(title.length, `${action}: 説明が空`).toBeGreaterThan(0);
      const got = digest(title);
      if (got !== want) drift.push(`${action}: ${want} → ${got}「${title}」`);
    }
    expect(
      drift,
      '左の列の説明が変わった ── `ENTRY_ACTION_HINTS` の同じ操作も見てから、この表を直す',
    ).toEqual([]);
  });
});

/**
 * 🔴 **押した結果が見える所を開く**(#583 のスマホ版。設計 doc §2-15)。
 *
 * ⚠ スマホでは一覧が DOM から消えず `visibility` で隠れるだけなので、
 *   `focus-search` の `querySelector` は**隠れた欄を見つけてしまう** ──
 *   焦点は入らず、鍵は食われ、画面は 1 ドットも動かない(#583 で直した
 *   当の症状が、面を重ねた瞬間に戻る)。
 */
describe('探す・絞る・目次(隠れた面へ送らない)', () => {
  /**
   * 🔴 **PC は 1 バイトも触らない**(着地前レビュー 3)。
   *
   * ⚠ `phoneShowList` の `isPhone()` の早期 return を外しても、既存の test は
   *   1 つも落ちなかった ── `focus-search` は `isPhone()` のときしか呼ばず、
   *   `filter-by-tag` を **PC で編集中に**押す test が 1 件も無かったためである。
   * 🔴 壊れる形:PC で編集中に情報ペインのタグ札を押すと、**列は両方見えているのに**
   *   絞り込みが効かず「保存するか取り消してから、**一覧で探してください**」という
   *   スマホ用の字が出る(いまは絞り込める)。
   */
  it('🔴 PC では編集中でもタグ札で絞れる(スマホの断りを持ち込まない)', () => {
    const s = setup(false);
    s.open('n1');
    s.d.dispatch({ type: 'START_EDIT' });
    expect(s.d.getState().phase, '台が編集に入っていない(前提が崩れた)').toBe('editing');
    const chip = s.root.ownerDocument.createElement('button');
    chip.setAttribute('data-pkc-action', 'filter-by-tag');
    chip.setAttribute('data-pkc-tag', '買い物');
    s.root.append(chip);
    chip.click();
    expect(s.d.getState().filterQuery, 'PC なのに絞り込まれていない').toBe('買い物');
    expect(s.d.getState().error ?? '', 'PC にスマホ用の断りが出ている').not.toContain(
      '一覧で探してください',
    );
  });

  it('🔴 探す鍵を押すと一覧ページへ移り、欄に焦点が入る', () => {
    const s = setup(true);
    s.open('n1');
    expect(s.page()).toBe('note');
    s.root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(s.page(), '本文ページのまま(隠れた欄に焦点を入れている)').toBe('list');
    expect(
      s.root.ownerDocument.activeElement?.getAttribute('data-pkc-field'),
      '探す欄に焦点が入っていない',
    ).toBe('entry-filter');
  });

  /**
   * 🔴 **集中モードの鍵も、スマホでは断る**(#632 段④。実測で見つけた)。
   *
   * ⚠ 段① は `toggle-pane`(`Alt+[` / `Alt+]`)にだけ門を置き、**対称の反対側**である
   *   この鍵(`Mod+Alt+\`)を取りこぼしていた。
   * 🔴 実測(375×667):`pkc3.panes` が `null` → **`'sidebar inspector'`** に変わるのに、
   *   画面は 1px も動かず状態の行も**空のまま**だった ── **見えない状態変化が保存される**
   *   ので、PC の幅へ戻したときに**身に覚えのない畳み**が残る。
   * 🔑 だから見るのは 2 つ:**理由が出ること**と、🔴 **保存値が動かないこと**。
   *   ⚠ 後者を書かないと、「断り文を出してから畳む」実装が素通りする。
   */
  it('🔴 集中モードの鍵はスマホで断り、畳みの保存値も動かさない', () => {
    const s = setup(true);
    s.open('n1');
    const before = appPanes.getHidden().join(' ');
    s.root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '\\',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(s.d.getState().error ?? '', 'スマホで集中モードを黙って受けている').toContain(
      '列は畳めません',
    );
    expect(
      appPanes.getHidden().join(' '),
      '断ったのに保存値が動いた(PC へ戻すと身に覚えのない畳みが残る)',
    ).toBe(before);
  });

  /**
   * ⚠ **対照群** ── PC の幅では今までどおり両側を畳む。
   * ⚠ 置かないと「いつでも断る」実装が上を素通りする(集中モードごと殺す変異)。
   */
  it('PC の幅では集中モードが効く(両側を畳む)', () => {
    const s = setup(false);
    s.open('n1');
    appPanes.setHidden([]);
    s.root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '\\',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(appPanes.getHidden().slice().sort().join(' '), 'PC で集中モードが効かない').toBe(
      'inspector sidebar',
    );
    expect(s.d.getState().error ?? '', 'PC にスマホ用の断りが出ている').not.toContain(
      '列は畳めません',
    );
  });

  /** ⚠ **対照群** ── PC の幅では今までどおり(ページを移さない)。 */
  it('PC の幅では一覧を閉じない(ページという概念が無い)', () => {
    const s = setup(false);
    s.open('n1');
    s.root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(s.d.getState().selectedLid, 'PC なのに選択を外した').toBe('n1');
    // ⚠ **鍵が届いたことまで見る** ── 届いていなければ「移さなかった」は空振りである
    expect(
      s.root.ownerDocument.activeElement?.getAttribute('data-pkc-field'),
      '鍵が 1 度も届いていない(この対照群は何も見ていない)',
    ).toBe('entry-filter');
  });

  /**
   * 🔴 **面(設定・ヘルプ・2 ペイン・集計)を開いている間も、一覧まで出す**
   *   (着地前レビュー 3。⚠ 変異試験 N5 が SURVIVED で「直したのに test が無い」と教えた)。
   *
   * ⚠ 直す前は `DESELECT_ENTRY` だけ撃っていた ── 面が開いたままだと
   *   `phonePageOf` は `pane` を返し続けるので**一覧は画面に出ない**。
   *   結果は「**選択だけ黙って消えて、焦点も入らない**」で、
   *   #583 で直した無言の dead key が**選択の消失つきで**戻る形だった。
   */
  it('🔴 設定を開いたまま探す鍵を押しても、一覧ページまで出る', () => {
    const s = setup(true);
    s.open('n1');
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' });
    expect(s.page(), '台が面を開けていない(前提が崩れた)').toBe('pane');
    s.root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(s.page(), '面が開いたままなので一覧が画面に出ていない').toBe('list');
    expect(s.d.getState().viewMode, '面を閉じていない').toBe('detail');
    expect(
      s.root.ownerDocument.activeElement?.getAttribute('data-pkc-field'),
      '探す欄に焦点が入っていない(隠れた欄へ入れている)',
    ).toBe('entry-filter');
  });

  it('🔴 編集中は理由を出して断る(黙って何も起きない、にしない)', () => {
    const s = setup(true);
    s.open('n1');
    s.d.dispatch({ type: 'START_EDIT' });
    s.root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(s.d.getState().error).toContain('保存するか取り消してから');
    expect(s.page(), '編集中に一覧へ飛んだ').toBe('note');
  });

  /**
   * 🔴 **断ったなら、絞り込みも起こさない**(着地前レビュー 欠陥 6)。
   * ⚠ 直す前は `SET_ENTRY_FILTER` を**先に**撃ってから断っていた ── PC では
   *   左の列ですぐ見えるので食い違わないが、スマホは一覧が画面に無いので
   *   **「できません」と言われたのに、後で見ると絞られている**。
   */
  it('🔴 編集中にタグ札を押したら、絞り込みも起きない', () => {
    const s = setup(true);
    s.open('n1');
    s.d.dispatch({ type: 'START_EDIT' });
    const badge = s.root.ownerDocument.createElement('button');
    badge.setAttribute('data-pkc-action', 'filter-by-tag');
    badge.setAttribute('data-pkc-tag', '買い物');
    s.root.querySelector('[data-pkc-region="detail"]')!.append(badge);
    badge.click();
    expect(s.d.getState().error, '断っていない').toContain('保存するか取り消してから');
    expect(s.d.getState().filterQuery, '断ったのに絞り込みは起きている').toBe('');
  });

  it('🔴 本文のタグ札を押すと、絞った一覧が出る', () => {
    const s = setup(true);
    s.open('n1');
    const badge = s.root.ownerDocument.createElement('button');
    badge.setAttribute('data-pkc-action', 'filter-by-tag');
    badge.setAttribute('data-pkc-tag', '買い物');
    s.root.querySelector('[data-pkc-region="detail"]')!.append(badge);
    badge.click();
    expect(s.d.getState().filterQuery, '絞れていない').toBe('買い物');
    expect(s.page(), '絞ったのに一覧が見えない(無言の dead click)').toBe('list');
  });

  it('🔴 情報ページの目次を押すと、本文ページへ戻る', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-info').click();
    expect(s.page()).toBe('info');
    const link = s.root.ownerDocument.createElement('button');
    link.setAttribute('data-pkc-action', 'toc-jump');
    link.setAttribute('data-pkc-toc-slug', 'midashi');
    s.root.querySelector('[data-pkc-region="inspector"]')!.append(link);
    link.click();
    expect(s.page(), '送ったのに情報ページのまま(飛び先が見えない)').toBe('note');
  });
});

describe('畳んだ列をスマホでは写さない(#609)', () => {
  it('🔴 列の畳みは写さない / 追記欄の畳みは写す', () => {
    const s = setup(true);
    appPanes.setHidden(['sidebar', 'inspector', 'append']);
    applyPaneVisibility(s.root, appPanes.getHidden());
    expect(s.shell.getAttribute('data-pkc-hidden-panes')).toBe('append');
  });

  /**
   * 🔴 **押しても何も起きない、を残さない**(着地前レビュー 欠陥 3)。
   *
   * ⚠ 直す前、スマホで `Alt+[` やパレットの「左のペインを畳む / 戻す」を押すと
   *   **画面は 1px も動かず、理由も出ず、保存値だけ黙って動いて**いた ──
   *   PC へ戻したときに畳まれている、という**見えない状態変化**まで付いていた。
   * 🔑 断って、保存値も動かさない(次に広げたとき驚かない)。
   * ⚠ 追記欄(`append`)は**スマホでも効く**ので、そちらは断らない。
   */
  it('🔴 スマホで列を畳む鍵を押すと、理由が出て保存値も動かない', () => {
    const s = setup(true);
    appPanes.setHidden([]);
    s.root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '[',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(s.d.getState().error, '押しても理由が出ない(無言の dead click)').toContain(
      'スマホの画面では',
    );
    expect(appPanes.getHidden(), '見えないのに保存値が動いた').toEqual([]);
  });

  it('🔴 追記欄の畳みはスマホでも効く(まとめて断っていない)', () => {
    const s = setup(true);
    appPanes.setHidden([]);
    s.root
      .querySelector<HTMLElement>('[data-pkc-action="toggle-pane"][data-pkc-pane="append"]')!
      .click();
    expect(appPanes.getHidden(), '追記欄まで断っている').toEqual(['append']);
    expect(s.shell.getAttribute('data-pkc-hidden-panes')).toBe('append');
  });

  it('対照群: PC の幅では 3 つとも写す', () => {
    const s = setup(false);
    appPanes.setHidden(['sidebar', 'inspector', 'append']);
    applyPaneVisibility(s.root, appPanes.getHidden());
    const v = s.shell.getAttribute('data-pkc-hidden-panes')!.split(' ').sort();
    expect(v).toEqual(['append', 'inspector', 'sidebar']);
  });

  /**
   * 🔴 **写す関数の入力が変わったら写し直す**。⚠ これが無いと、PC で一覧を畳んだまま
   * 窓を狭めた回だけ `data-pkc-hidden-panes~='sidebar'` が残り、重ねた一覧が
   * `display: none` のままになる(一覧ページが真っ白 = #609 の行き止まり)。
   */
  it('🔴 畳んだまま窓を狭めると、写し直して一覧が戻る', () => {
    const s = setup(false);
    appPanes.setHidden(['sidebar']);
    applyPaneVisibility(s.root, appPanes.getHidden());
    expect(s.shell.getAttribute('data-pkc-hidden-panes')).toBe('sidebar');
    s.media.set(true);
    expect(s.shell.getAttribute('data-pkc-hidden-panes'), '狭めても畳みが残っている').toBeNull();
    // 🔑 保存は消していない ── 広げれば戻る
    expect(appPanes.getHidden()).toEqual(['sidebar']);
    s.media.set(false);
    expect(s.shell.getAttribute('data-pkc-hidden-panes')).toBe('sidebar');
  });
});

/**
 * 🔴 **対応外の幅(360px 未満)を、変わったときだけ知らせる**(#632 段③、user 裁定 ⑥)。
 *
 * ⚠ ここが持つのは**知らせる仕組み**(`onTooNarrow`)だけである ── 何を出すか /
 *   どう消すかは **#671 の裁定 2・3** で user が決め直し、
 *   `src/adapter/ui/render/too-narrow.ts` へ移った(test は
 *   `tests/adapter/too-narrow.test.ts`)。
 *
 * ⚠ **ここでしか測れないのが「変わったときだけ」である** ── 帯は 1 行しか
 *   持たないので、同じ字を 2 回書いても実ブラウザからは**同じ画面に見える**。
 */
describe('対応外の幅(変わったときだけ伝える)', () => {
  /**
   * 🔴 **同じ値を続けて伝えない**(user 裁定 ⑥「1 度だけ」)。
   * ⚠ 着地前の動線レビューで「広げても消えない」を直したので、
   *   いま配るのは**知らせ**ではなく**状態**である ── だから見るのは
   *   「増えないこと」ではなく「**変わったときだけ配ること**」になった。
   */
  it('🔴 狭いまま何度知らせが来ても、伝えるのは 1 度だけ', () => {
    const s = setup(true);
    const said: boolean[] = [];
    appPhone.onTooNarrow((n) => said.push(n));
    expect(said, '対応している幅なのに配った(帯の別の知らせを消す)').toEqual([]);

    s.narrow.set(true);
    expect(said, '対応外になったのに配らない').toEqual([true]);

    // 🔴 狭いままの `change` は何度来ても増えない(帯が知らせで埋まらない)
    s.narrow.set(true);
    s.narrow.set(true);
    expect(said, '狭いままなのに配り直している').toEqual([true]);
  });

  /**
   * 🔴 **広げたら「もう狭くない」と伝える**(着地前の動線レビュー)。
   * ⚠ 伝えないと、対応している幅で「対応していません」と書いたままになる
   *   ── 状態の行は 1 行しか無いので、本当に読ませたい文を押し出す。
   */
  it('🔴 広げたら、広くなったことを伝える', () => {
    const s = setup(true);
    const said: boolean[] = [];
    appPhone.onTooNarrow((n) => said.push(n));
    s.narrow.set(true);
    s.narrow.set(false);
    expect(said, '広げても何も伝えない(字が残る)').toEqual([true, false]);
    // 🔑 もう一度狭めれば、また伝える(消したのに二度と出ない、を作らない)
    s.narrow.set(true);
    expect(said, '一度消したら二度と出ない').toEqual([true, false, true]);
  });

  /**
   * 🔴 **いちばん普通の場合** ── 起動した時点でもう狭い。
   * ⚠ 帯の口(`showStatus`)は `main.ts` のずっと後で組まれるので、
   *   `install` の時点では誰も聞いていない ── **購読した瞬間に鳴らす**必要がある。
   *   これが無いと、**細い端末では 1 度も出ない**(いちばん要る場面で黙る)。
   */
  it('🔴 起動した時点でもう狭ければ、口を繋いだ瞬間に言う', () => {
    const s = setup(true);
    s.narrow.set(true); // ⚠ まだ誰も聞いていない
    const said: boolean[] = [];
    appPhone.onTooNarrow((n) => said.push(n));
    expect(said, '起動時から狭い端末で 1 度も言わない').toEqual([true]);
  });

  /** ⚠ 対照群 ── 対応している幅では**繋いでも鳴らない**(常に言う実装を通さない)。 */
  it('🔴 360px 以上では言わない', () => {
    setup(true);
    const said: boolean[] = [];
    appPhone.onTooNarrow((n) => said.push(n));
    expect(said, '対応している幅で言っている').toEqual([]);
  });

  it('🔴 口を外したら、そのあと狭めても言わない', () => {
    const s = setup(true);
    const said: boolean[] = [];
    const off = appPhone.onTooNarrow((n) => said.push(n));
    off();
    s.narrow.set(true);
    expect(said, '外した口へまだ流している').toEqual([]);
  });

  /**
   * 🔴 **境目は `PHONE_MIN_PX` 未満**(`- 1` を落とすと 360px ちょうどが対応外になる)。
   * ⚠ 数字ではなく**問い合わせた字**で見る ── 替え玉の `matches` を手で動かす台では、
   *   実装がどの幅を聞いたかは**この記録にしか出ない**。
   */
  it('🔴 見張りは 2 本で、対応外は 360px 未満を聞いている', () => {
    const asked: string[] = [];
    const off = document.createElement('div');
    off.setAttribute('data-pkc-slot', 'root');
    document.body.append(off);
    buildShell(off);
    appPhone.install(off, (q) => {
      asked.push(q);
      return new FakeMedia(false);
    });
    /**
     * 🔴 1 本目は **幅か高さ**(#663)── `,` は media query の OR。
     * ⚠ 高さの項を落とす変異はここで落ちる(横向きのスマホが 2 列版面へ戻る)。
     */
    expect(asked, '見張りの本数が違う').toEqual([
      `(max-width: ${PHONE_MAX_PX}px), (max-height: ${PHONE_MAX_HEIGHT_PX}px)`,
      `(max-width: ${PHONE_MIN_PX - 1}px)`,
    ]);
    // ⚠ 空振り防止 ── 2 本が**別の幅**を聞いている(同じ字なら片方は無意味である)
    expect(asked[0], '2 本が同じ幅を聞いている').not.toBe(asked[1]);
  });
});

/**
 * 🔴 **横に倒したスマホ(高さ 480px 以下)もスマホ用画面にする**(#663)。
 *
 * ⚠ 替え玉の台なので「幅 844 / 高さ 390」を直接は測れない ── 測れるのは
 *   **高さの問い合わせが真になったとき、版面の属性が付くか**である
 *   (実ブラウザの寸法は `tests/smoke/phone.smoke.spec.ts` の 844×390 の腕)。
 * 🔑 替え玉は**問い合わせの字を読んで**答える ── 高さの項が query に無ければ
 *   `false` を返すので、項を落とす変異はここでも落ちる(上の等値 pin と 2 重)。
 */
describe('高さでも切る(#663)', () => {
  function install(answer: (q: string) => boolean) {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    appPhone.install(root, (q) => new FakeMedia(answer(q)));
    appPhone.render({ selectedLid: null, viewMode: 'detail', editing: false, title: '' });
    return root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
  }

  it('🔴 高さ 480px 以下の問い合わせだけが真でも、スマホ用画面になる', () => {
    const shell = install((q) => q.includes(`(max-height: ${PHONE_MAX_HEIGHT_PX}px)`));
    expect(shell.getAttribute('data-pkc-layout'), '横向きのスマホが 2 列版面のまま').toBe('phone');
  });

  it('⚠ 対照群: 幅も高さも足りている(1280×720)ならスマホ用画面にならない', () => {
    // 1280×720 = 幅 720 超・高さ 480 超なので、どの問い合わせも偽
    const shell = install(() => false);
    expect(shell.getAttribute('data-pkc-layout'), '広い窓なのにスマホ用画面').not.toBe('phone');
  });

  it('⚠ 対照群: 別の高さ(720px)を聞く替え玉では真にならない(項の字が違えば効かない)', () => {
    // ⚠ 実装が `(max-height: 720px)` などへ書き換わったら、上の等値 pin と共にここも落ちる
    const shell = install((q) => q.includes('(max-height: 720px)'));
    expect(shell.getAttribute('data-pkc-layout'), '聞いていない高さで切り替わった').not.toBe('phone');
  });
});

describe('CSS(構文で読む)', () => {
  const css = (): string => readFileSync('src/styles/app.css', 'utf-8');
  /** ⚠ **注釈を剥いでから見る** ── 自分の解説文が検査を満たす / 落とす(§1 に 5 回の記録)。 */
  const bare = (): string => stripComments(css());
  const PHONE = "[data-pkc-region='shell'][data-pkc-layout='phone']";

  it('🔴 幅の数字は CSS に 1 つも無い(TS と CSS が別の幅で切り替わる、を作らない)', () => {
    const text = bare();
    expect(text, `CSS に ${PHONE_MAX_PX}px が在る`).not.toContain(`${PHONE_MAX_PX}px`);
    expect(text, `CSS に ${PHONE_MIN_PX - 1}px が在る`).not.toContain(`${PHONE_MIN_PX - 1}px`);
    // #663 ── 高さの境目も同じ規律(CSS に書くと JS と別の高さで切り替わる)
    expect(text, `CSS に ${PHONE_MAX_HEIGHT_PX}px が在る`).not.toContain(`${PHONE_MAX_HEIGHT_PX}px`);
    // ⚠ 空振り防止 ── 幅で切る `@media` そのものは残っている(1100 / 900)
    expect(text, '幅の @media が 1 つも無い(この検査は何も見ていない)').toContain(
      '@media (max-width: 1100px)',
    );
  });

  /**
   * 🔴 **門を N 個置いたら、N 個目だけが鳴る場面を N 通り作る**
   * (CLAUDE.md 2026-08-24。#632 段② の着地前レビュー G)。
   *
   * ⚠ 触る端末の丈は **3 本の帯**に、折る規則は **2 つのリスト**に置いたが、
   *   実ブラウザの smoke が押しているのは **タイマーだけ**である ── 収録の帯を
   *   選択子から落としても、予定の帯を落としても**緑のまま通る**。
   *   ⚠ とくに収録の「止める」は**マイクを止める唯一の出口**なので、
   *   そこだけ 26px に戻る形を黙って通してはいけない。
   * 🔑 実ブラウザで 3 本とも走らせるのは高くつく(録音は許可が要る)ので、
   *   **選択子の集合を構文で pin する** ── 落とした瞬間にここが落ちる。
   */
  it('🔴 触る端末の丈と、折る規則が、帯 3 本 / リスト 2 つ全部に当たっている', () => {
    const touch = mediaBlock(bare(), '(hover: none) and (pointer: coarse)').body;
    const bars = ['capture-bar', 'timer-bar', 'alarm-bar'].map(
      (r) => `[data-pkc-region='${r}'] button`,
    );
    const hit = blocksFor(touch, bars[0]!);
    expect(hit, '触る端末の丈の規則が無い(この検査は何も見ていない)').not.toHaveLength(0);
    for (const sel of bars)
      expect(
        blocksFor(touch, sel),
        `${sel} に丈が当たっていない(そこだけ 26px に戻る)`,
      ).not.toHaveLength(0);
    for (const b of blocksFor(touch, bars[0]!))
      expect(b, '丈が 32px でない').toMatch(decl('min-height', '32px'));

    // ⚠ 折るのは**幅**で切る側(`@media` の外)── 2 つのリスト両方に当たっているか
    const plain = withoutMedia(bare());
    for (const f of ['timer-list', 'alarm-list']) {
      const one = blocksFor(plain, `${PHONE} [data-pkc-field='${f}'] > li`);
      expect(one, `${f} が 1 件 1 行になっていない`).not.toHaveLength(0);
      for (const b of one) expect(b, `${f} の項目が 1 行を占めていない`).toMatch(decl('flex', '1 0 100%'));
    }
  });

  it('🔴 スマホの規則は畳みの属性を読まない(判定を 2 か所に置かない)', () => {
    const rules = [...withoutMedia(bare()).matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map((m) => m[1]!.trim())
      .filter((sel) => sel.includes("data-pkc-layout='phone'"));
    expect(rules.length, 'スマホの規則が 1 本も無い(この検査は何も見ていない)').toBeGreaterThan(4);
    for (const sel of rules)
      expect(sel, `スマホの規則が畳みの属性を読んでいる: ${sel}`).not.toContain(
        'data-pkc-hidden-panes',
      );
  });

  it('🔴 3 面は同じセルに重なり、出ていない面は visibility で消す', () => {
    const body = blocksFor(withoutMedia(bare()), `${PHONE} [data-pkc-region='sidebar']`).join(' ');
    expect(body, '一覧を重ねる規則が無い').toContain('grid-area: detail');
    expect(body, 'visibility で消していない').toContain('visibility: hidden');
    expect(body, 'display:none にしている(mermaid の焼き直しと scrollTop 消失を招く)').not.toMatch(
      /(^|;)\s*display:\s*none/,
    );
  });

  it('🔴 いま出ているページの面だけが見える', () => {
    const bareCss = withoutMedia(bare());
    for (const [page, region] of [
      ['list', 'sidebar'],
      ['note', 'center'],
      ['info', 'inspector'],
    ] as const) {
      const body = blocksFor(
        bareCss,
        `${PHONE}[data-pkc-page='${page}'] [data-pkc-region='${region}']`,
      ).join(' ');
      expect(body, `${page} の面を戻す規則が無い`).toContain('visibility: visible');
    }
  });

  it('🔴 帯は面と同じマスに、自分の丈だけ重なる', () => {
    const body = blocksFor(
      withoutMedia(bare()),
      `${PHONE} [data-pkc-region='phone-bar']`,
    ).join(' ');
    expect(body, '帯を面のマスへ置く規則が無い').toContain('grid-area: detail');
    expect(body, 'マス全体を覆っている(面が押し出される)').toContain('align-self: start');
  });

  /**
   * 🔴 **重ねたぶんの場所を空ける** ── 空けないと本文の 1 行目が帯の下に潜る。
   * ⚠ 丈は 1 か所(`--pkc-phone-bar`)から読む ── 数字を 2 か所に置くと、
   *   片方だけ変えた日に静かに潜る。
   */
  it('🔴 帯が出るページでは、その面の頭を帯の丈だけ空ける', () => {
    const bareCss = withoutMedia(bare());
    for (const [page, region] of [
      ['note', 'center'],
      ['info', 'inspector'],
    ] as const) {
      const body = blocksFor(
        bareCss,
        `${PHONE}[data-pkc-page='${page}'] [data-pkc-region='${region}']`,
      ).join(' ');
      expect(body, `${page}: 帯のぶんを空けていない`).toContain(
        'padding-top: var(--pkc-phone-bar)',
      );
    }
    // ⚠ 面(設定・ヘルプ等)では空けない ── 帯が出ないので理由の無い隙間になる
    const pane = blocksFor(bareCss, `${PHONE}[data-pkc-page='pane'] [data-pkc-region='center']`);
    expect(pane.join(' '), '帯の出ないページにも隙間を空けている').not.toContain('padding-top');
    // 🔑 丈の定義は 1 か所(shell)
    const shell = blocksFor(bareCss, PHONE).join(' ');
    expect(shell, '帯の丈を shell に置いていない(面が継げない)').toContain('--pkc-phone-bar:');
  });

  /**
   * 🔴 **スマホでは 2 ペインを「1 枚ずつ」出す**(user 裁定 2026-09-04、#671)。
   *
   * ⚠ **これは 2026-09-02 に入れた「縦なら上下に積む」の撤回である。**
   *   積む案は向きで得失が反転していた(実測):
   *
   * | 窓 | 並べ方 | 1 枚の寸法 | パンくず | 見える行 |
   * |---|---|---|---|---|
   * | 375×667(縦) | 左右 | 184×571 | 🔴 **0px** | 6 / 6 |
   * | 375×667(縦) | 上下 | 375×282 | 182px | 6 / 6 |
   * | 667×375(横) | 左右 | 330×279 | 136px | 6 / 6 |
   * | 667×375(横) | 上下 | 667×136 | 474px | 🔴 **1 / 6** |
   *
   * 🔑 1 枚ずつなら**どちらの向きでも版面を丸ごと使う**ので、向きで分ける
   *   理由が消える ── だから `@media (orientation: portrait)` ごと外した。
   */
  it('🔴 スマホの 2 ペインは 1 枚だけ出す(焦点の無い側を畳む)', () => {
    const css = withoutMedia(bare());
    const body = blocksFor(css, `${PHONE} [data-pkc-region='dual-body']`).join(' ');
    expect(body, 'スマホで列を 1 本にする規則が無い').not.toBe('');
    /**
     * 🔴 **`1fr` は `1fr 1fr` にも当たる**(#632 段③ の着地前レビュー 1)──
     *   `decl` は「値の頭」しか留めないので、**末尾の `;` まで**留める。
     */
    expect(body, '列が 1 本になっていない(横並びのまま)').toMatch(
      decl('grid-template-columns', '1fr\\s*;'),
    );
    expect(body, '列が 2 本のまま(この検査は何も見ていない)').not.toMatch(
      decl('grid-template-columns', '1fr\\s+1fr'),
    );
    /**
     * 🔴 **列を 1 本にしただけでは「1 枚ずつ」にならない** ── 2 枚が縦に並ぶだけ
     *   (それが撤回した案である)。**焦点の無い側を畳む**規則まで見る。
     */
    const off = blocksFor(
      css,
      `${PHONE} [data-pkc-region='dual-pane']:not([data-pkc-focused])`,
    ).join(' ');
    expect(off, '焦点の無い側を隠す規則が無い(2 枚が縦に並ぶ)').toMatch(
      decl('visibility', 'hidden'),
    );
    /**
     * 🔴 **`display: none` で隠さない**(着地前の動線レビュー C、2026-09-04 に実測)。
     * ⚠ ペインの中の一覧(`dual-table`)は `overflow: auto` の**流れる箱**なので、
     *   `display: none` にすると `scrollTop` が 0 に丸められ、**見ていた場所が
     *   毎回いちばん上に戻る**。3 面(一覧 / 本文 / 情報)では既に避けている罠である。
     */
    expect(off, '畳んで隠している(見ていた場所が毎回いちばん上に戻る)').not.toMatch(
      decl('display', 'none'),
    );
    /**
     * ⚠ 隠すだけでは**縦に 2 枚並ぶ** ── 同じマスへ重ねる規則まで見る
     *   (`visibility: hidden` は場所を空けない)。
     */
    const stack = blocksFor(css, `${PHONE} [data-pkc-region='dual-pane']`).join(' ');
    expect(stack, '2 枚を同じマスへ重ねていない(隠した側が場所を取る)').toMatch(
      decl('grid-area', '1\\s*/\\s*1'),
    );
    // ⚠ 空振り防止 ── 素の規則は**横並びのまま**である(全部畳んだのではない)
    const wide = blocksFor(css, `[data-pkc-region='dual-body']`).join(' ');
    expect(wide, '広い窓の 2 ペインまで 1 本にしている').toMatch(
      decl('grid-template-columns', '1fr\\s+1fr'),
    );
    const wideOff = blocksFor(css, `[data-pkc-region='dual-pane']`).join(' ');
    expect(wideOff, '広い窓のペインまで畳んでいる').toMatch(decl('display', 'flex'));
  });

  /**
   * 🔴 **向きで分ける規則を残さない**(#671)。
   *
   * ⚠ 撤回したのに規則が残っていると、**縦のスマホだけ 2 枚が縦に並ぶ**
   *   (`grid-template-rows: 1fr 1fr` が生き残るため)── 上の test は
   *   `withoutMedia` で読むので、**残っていても気づかない**。
   */
  it('🔴 2 ペインを向きで分ける規則は残っていない', () => {
    const css = bare();
    const at = css.indexOf('@media (orientation: portrait)');
    expect(at, '向きで分ける @media が残っている(積む案は撤回した)').toBe(-1);
  });

  /**
   * 🔴 **行き先のボタンはスマホでだけ出す**(#671)。
   *
   * ⚠ パソコンで出すと「押しても焦点が動くだけ」の、目的の読めないボタンになる
   *   ── 2 枚とも見えているので切り替える先が無い。
   * 🔑 出し入れは **CSS 1 か所**が決める(JS は `hidden` を触らない)。
   */
  it('🔴 行き先のボタンは、パソコンでは畳み、スマホでだけ出す', () => {
    const css = withoutMedia(bare());
    const base = blocksFor(css, `[data-pkc-region='dual-switch']`).join(' ');
    expect(base, 'パソコンで畳む規則が無い').toMatch(decl('display', 'none'));
    const phone = blocksFor(css, `${PHONE} [data-pkc-region='dual-switch']`).join(' ');
    expect(phone, 'スマホで出す規則が無い').toMatch(decl('display', 'block'));
    // 🔑 指で押す所の丈は 32px に揃える(user 裁定 2026-09-04)
    expect(phone, '押し所が 32px に揃っていない').toMatch(decl('min-height', '32px'));
  });

  /**
   * 🔴 **行き先のボタンは、長いフォルダ名を末尾から省く**(#687 A-1)。
   * ⚠ 省かないと 375px で 2 行に折れ、押し所の丈が題名しだいで動く
   *   (下の表が題名 1 つでずれる)。
   */
  it('🔴 行き先のボタンは、長い名前を 1 行に収めて末尾から省く', () => {
    const css = withoutMedia(bare());
    const phone = blocksFor(css, `${PHONE} [data-pkc-region='dual-switch']`).join(' ');
    expect(phone, '末尾から省く規則が無い').toMatch(decl('text-overflow', 'ellipsis'));
    expect(phone, '折り返しを止めていない(2 行になる)').toMatch(decl('white-space', 'nowrap'));
    expect(phone, 'はみ出しを隠していない').toMatch(decl('overflow', 'hidden'));
  });

  /**
   * 🔴 **タブ帯の「左」/「右」は、パソコンでは畳み、スマホでだけ出す**(#687 B-1)。
   * ⚠ DOM には常に在る(帯を組むたびに作る)ので、出し入れは CSS 1 か所が決める。
   */
  it('🔴 タブ帯の側の印は、パソコンでは畳み、スマホでだけ出す', () => {
    const css = withoutMedia(bare());
    const base = blocksFor(css, `[data-pkc-field='dual-side-mark']`).join(' ');
    expect(base, 'パソコンで畳む規則が無い').toMatch(decl('display', 'none'));
    const phone = blocksFor(css, `${PHONE} [data-pkc-field='dual-side-mark']`).join(' ');
    expect(phone, 'スマホで出す規則が無い').toMatch(decl('display', 'inline'));
  });

  /** 🔴 **もう片方の印の知らせは、情報行と同じ見た目**(#687 C-1)── 11px / muted。 */
  it('🔴 もう片方の印の知らせは、情報行と同じ大きさと色で出る', () => {
    const css = withoutMedia(bare());
    const note = blocksFor(css, `[data-pkc-field='dual-other-marks']`).join(' ');
    expect(note, '規則が無い').toMatch(decl('font-size', '11px'));
    expect(note, '色が情報と同じでない').toMatch(decl('color', 'var\\(--muted\\)'));
  });

  /**
   * 🔴 **操作の 7 つも 32px**(user 裁定 2026-09-04、#671)。
   * ⚠ 1 枚ずつにしてペインの丈が 282px → 571px になったので、6px 増やしても
   *   表の行はほとんど減らない ── 端末の中の押し所を 1 種類に揃える。
   */
  it('🔴 スマホでは 2 ペインの操作も 32px', () => {
    const css = withoutMedia(bare());
    const phone = blocksFor(
      css,
      `${PHONE} [data-pkc-region='dual-commands'] button`,
    ).join(' ');
    expect(phone, '操作の押し所を 32px にしていない').toMatch(decl('min-height', '32px'));
    // ⚠ 空振り防止 ── パソコン側には丈を足していない(1px も変えない)
    const wide = blocksFor(css, `[data-pkc-region='dual-commands'] button`).join(' ');
    expect(wide, 'パソコンの操作にも丈を足している').not.toMatch(decl('min-height', '32px'));
  });

  /**
   * 🔴 **スマホでは操作を 2 段に折る**(着地前の動線レビュー B、2026-09-04 に実測)。
   *
   * ⚠ 1 行 7 等分のままだと、375px で**語に使える幅が 15px**(全角 1 字)しか
   *   残らない ── 実測した `scrollWidth / clientWidth`:
   *   「右へ写す」53/15、「プレビュー」66/15、「名前」26/15 で **7 つ全部**が切れる。
   * 🔴 `text-overflow: ellipsis` なので画面には「右…」と出るだけで、
   *   `textContent` を見る検査は**素通りする**(CLAUDE.md §1)── 実際に切れる幅は
   *   実ブラウザで測る(`tests/smoke/phone.smoke.spec.ts`)。ここは**規則が在ること**。
   */
  it('🔴 スマホでは 2 ペインの操作を 4 列に折る', () => {
    const css = withoutMedia(bare());
    const phone = blocksFor(css, `${PHONE} [data-pkc-region='dual-commands']`).join(' ');
    expect(phone, 'スマホで列を切る規則が無い(1 行 7 等分のまま)').toMatch(
      decl('grid-template-columns', 'repeat\\(4'),
    );
    expect(phone, '行送りにしていない(4 つ目で折り返さない)').toMatch(
      decl('grid-auto-flow', 'row'),
    );
    // ⚠ 空振り防止 ── パソコンは 1 行のまま(端が揃う形を崩さない)
    const wide = blocksFor(css, `[data-pkc-region='dual-commands']`).join(' ');
    expect(wide, 'パソコンまで折り返している').toMatch(decl('grid-auto-flow', 'column'));
    /**
     * 🔴 **4 列に折っても足りなかったので、鍵の字は出さない**(実測)。
     * ⚠ `barKey` は F キーの無い操作では**最初の割当をそのまま出す**ので、
     *   「ノート」の鍵が長く、語に残ったのは **18px**(要る 40px)だった。
     * 🔑 情報は捨てない ── 鍵は説明(`title`)に残す(`dual-filer.ts`)。
     */
    const key = blocksFor(css, `${PHONE} [data-pkc-field='cmd-key']`).join(' ');
    expect(key, 'スマホで鍵の字を畳んでいない(語が 18px まで潰れる)').toMatch(
      decl('display', 'none'),
    );
    // ⚠ 空振り防止 ── パソコンでは出したまま(近道の覚え書きを消していない)
    const wideKey = blocksFor(css, `[data-pkc-field='cmd-key']`).join(' ');
    expect(wideKey, 'パソコンの鍵まで畳んでいる').not.toMatch(decl('display', 'none'));
  });

  /**
   * ⚠ **選択子と宣言を、同じ規則の中で結びつける**(着地前レビュー 9)。
   *   直す前は `slice` した塊に対して 2 つの `toContain` を別々に当てていたので、
   *   **その規則を別の選択子へ移し、中央側を別の宣言に替える**変異が両方緑で通った。
   */
  it('🔴 スマホのまま印刷しても本文が紙に出る(A5 は 720 を切る)', () => {
    const body = blocksFor(
      mediaBlock(bare(), 'print').body,
      `${PHONE} [data-pkc-region='center']`,
    ).join(' ');
    expect(body, '印刷で中央の visibility を戻す規則が無い').not.toBe('');
    expect(body, '戻していない').toMatch(decl('visibility', 'visible'));
  });
});
