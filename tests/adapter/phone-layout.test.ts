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
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { appPhone } from '../../src/adapter/ui/render/phone-layout';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { PHONE_MAX_PX, PHONE_MIN_PX } from '../../src/features/phone-layout';
import { ENTRY_MENU_ACTIONS, NOTE_TOOL_ACTIONS } from '../../src/features/entry-actions';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

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
  appPhone.install(root, () => media, () => applyPaneVisibility(root, appPanes.getHidden()));
  const push = (): void => {
    const st = d.getState();
    appPhone.render({
      selectedLid: st.selectedLid,
      viewMode: st.viewMode,
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

  it('🔴 幅が戻れば印も消える(狭めたまま広げて版面が壊れない)', () => {
    const s = setup(true);
    s.open('n1');
    s.media.set(false);
    expect(s.layout()).toBeNull();
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

  it('🔴 ← 一覧 で選択が外れ、一覧ページへ戻る', () => {
    const s = setup(true);
    s.open('n1');
    s.field('phone-back').click();
    expect(s.d.getState().selectedLid).toBeNull();
    expect(s.page()).toBe('list');
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

  it('🔴 表と実物の綴りが合っている(受け手を新しく作っていない)', () => {
    const s = setup(false);
    for (const a of NOTE_TOOL_ACTIONS)
      expect(
        s.root.querySelector(`[data-pkc-region="create-bar"] [data-pkc-action="${a.action}"]`),
        `${a.action} が左の列に無い ── ⋯ 専用の受け手を作っている`,
      ).not.toBeNull();
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

describe('CSS(構文で読む)', () => {
  const css = (): string => readFileSync('src/styles/app.css', 'utf-8');
  /** ⚠ **注釈を剥いでから見る** ── 自分の解説文が検査を満たす / 落とす(§1 に 5 回の記録)。 */
  const bare = (): string => stripComments(css());
  const PHONE = "[data-pkc-region='shell'][data-pkc-layout='phone']";

  it('🔴 幅の数字は CSS に 1 つも無い(TS と CSS が別の幅で切り替わる、を作らない)', () => {
    const text = bare();
    expect(text, `CSS に ${PHONE_MAX_PX}px が在る`).not.toContain(`${PHONE_MAX_PX}px`);
    expect(text, `CSS に ${PHONE_MIN_PX - 1}px が在る`).not.toContain(`${PHONE_MIN_PX - 1}px`);
    // ⚠ 空振り防止 ── 幅で切る `@media` そのものは残っている(1100 / 900)
    expect(text, '幅の @media が 1 つも無い(この検査は何も見ていない)').toContain(
      '@media (max-width: 1100px)',
    );
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

  it('🔴 スマホのまま印刷しても本文が紙に出る(A5 は 720 を切る)', () => {
    const printBlock = bare().slice(bare().indexOf('@media print'));
    expect(printBlock, '印刷で中央の visibility を戻していない').toContain(
      `${PHONE} [data-pkc-region='center']`,
    );
    expect(printBlock).toContain('visibility: visible');
  });
});
