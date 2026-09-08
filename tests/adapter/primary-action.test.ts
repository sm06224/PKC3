/** @vitest-environment happy-dom */
/**
 * 🔴 **その面の「主の操作」は 1 つだけ**(#722 P2-10。user 裁定 2026-09-06 = 案 A)。
 *
 * ## なぜ要るか
 *
 * cowork 実測 2026-09-05:「1440px の 1 画面に押せるボタンが **50 個**、うち
 * **23 個が完全に同じ見た目**。濃い地を持つのは『いま選んでいるタブ』の 1 個だけ」──
 * **どれを押せば話が進むのかが画面から読めない**、が実害だった。
 *
 * ## 守る主張
 *
 * 1. 🔴 **左の列(一覧)の主は「+ ノート」1 つ**
 * 2. 🔴 **読む面の主は「編集」1 つ** ── 編集に入ったら**「保存」へ移る**
 *    (⚠ 増えるのではなく**移る** ── 2 つになった瞬間に段が消える)
 * 3. 🔴 **同じ `commit-edit` でも、追記欄の側には印を付けない**
 *    (中央と追記欄の 2 か所に出る ── 両方濃くすると「1 面 1 つ」が崩れる)
 * 4. ⚠ **印を付ける口は 1 つだけ**(`icons.ts` の `markPrimary`)── 属性を直に
 *    書かれると、上の全数検査が数え落とす
 *
 * ⚠ **空振り防止**:同じ面に**普通のボタンが何個も在る**ことを見る ── 1 個しか
 *   出ていない面で「主は 1 つ」は自明に成り立つ。
 * ⚠ 見え方そのもの(地と字が反転しているか)は CSS なので**実ブラウザにしか無い**
 *   ── `tests/smoke/primary-action.smoke.spec.ts` が見る。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { appKeymap } from '../../src/adapter/ui/render/keymap';
import { applyShortcutHints } from '../../src/adapter/ui/render/shortcut-hint';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

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
  document.body.textContent = '';
});

/**
 * 面を組んで、状態を送れる口を返す。
 * ⚠ **左の列も本物で組む**(`BrowseRouter`)── 「+ ノート」の印は phase で
 *   付け外しするので、組まないと**その配線を 1 度も通らない**(CLAUDE.md §2)。
 */
function mount(metas: EntryMeta[] = [meta('n1', 'あ')]): { root: HTMLElement; d: Dispatcher } {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  const box = new AppendBoxRenderer(regions.append);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => {
    detail.render(s);
    box.render(s);
    browse.render(s, 'list');
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  if (metas.length > 0) {
    d.dispatch({ type: 'SELECT_ENTRY', lid: metas[0]!.lid });
    d.dispatch({ type: 'BODY_LOADED', lid: metas[0]!.lid, body: '本文\n' });
  }
  return { root, d };
}

/**
 * その面の主の操作の action(`[hidden]` / `[inert]` の下は除く)。
 * ⚠ **`display: none` と画面外は見られない** ── happy-dom に版面が無いので、
 *   そこは smoke の担当である。⚠ `[inert]` を足したのは着地前レビューの指摘
 *   (スマホ版は `display:none` ではなく `visibility` + `inert` で切り替える)。
 */
function primariesIn(root: HTMLElement, region: string): string[] {
  const host = root.querySelector(`[data-pkc-region="${region}"]`);
  if (host === null) throw new Error(`前提が崩れている: 面 ${region} が無い`);
  return [...host.querySelectorAll<HTMLButtonElement>('button[data-pkc-primary]')]
    .filter((b) => b.closest('[hidden],[inert]') === null)
    .map((b) => b.getAttribute('data-pkc-action') ?? '');
}

/** その面に見えている普通のボタンの数(空振り防止に使う)。 */
function plainCount(root: HTMLElement, region: string): number {
  const host = root.querySelector(`[data-pkc-region="${region}"]`);
  if (host === null) throw new Error(`前提が崩れている: 面 ${region} が無い`);
  return [...host.querySelectorAll<HTMLButtonElement>('button:not([data-pkc-primary])')].filter(
    (b) => b.closest('[hidden],[inert]') === null,
  ).length;
}

describe('主の操作は面ごとに 1 つ(#722 P2-10)', () => {
  it('🔴 一覧の主は「+ ノート」1 つだけ', () => {
    const { root } = mount();
    // ⚠ 空振り防止 ── 同じ列に普通のボタンが何個も在ってこそ「1 つ」が意味を持つ
    expect(plainCount(root, 'sidebar'), '左の列にボタンが少なすぎる(何も判定していない)').toBeGreaterThan(3);
    expect(primariesIn(root, 'sidebar')).toEqual(['create-entry']);
  });

  it('🔴 読む面の主は「編集」1 つだけ', () => {
    const { root } = mount();
    expect(plainCount(root, 'detail'), '読む面にボタンが少なすぎる(何も判定していない)').toBeGreaterThan(2);
    expect(primariesIn(root, 'detail')).toEqual(['start-edit']);
  });

  it('🔴 編集に入ると、主は「保存」へ**移る**(増えない)', () => {
    const { root, d } = mount();
    d.dispatch({ type: 'START_EDIT' });
    // 前提:編集の帯が出ている(出ていなければ以下は空振り)
    expect(
      root.querySelector('[data-pkc-region="detail"] button[data-pkc-action="commit-edit"]'),
      '前提が崩れている: 編集の帯が出ていない',
    ).not.toBeNull();
    expect(primariesIn(root, 'detail')).toEqual(['commit-edit']);
  });

  it('🔴 追記欄の「保存」には印を付けない(同じ action でも 2 つ濃くしない)', () => {
    const { root, d } = mount();
    d.dispatch({ type: 'START_EDIT' });
    // 前提:追記欄が編集中の出口を出している(#716 の約束)
    expect(
      root.querySelector<HTMLElement>('[data-pkc-field="append-lock"]')!.hidden,
      '前提が崩れている: 追記欄が編集中の帯を出していない',
    ).toBe(false);
    expect(primariesIn(root, 'append')).toEqual([]);
    // ⚠ 対照群 ── 追記欄にも `commit-edit` は在る(在るのに印だけ無い、を見る)
    expect(
      root.querySelector('[data-pkc-region="append"] button[data-pkc-action="commit-edit"]'),
      '前提が崩れている: 追記欄に保存が無い',
    ).not.toBeNull();
  });

  /**
   * 🔴 **編集中は「+ ノート」を濃くしない**(着地前レビュー・動線 1、2026-09-06)。
   *
   * ⚠ `CREATE_ENTRY` は `phase !== 'ready'` を**黙って捨てる**(`app-state.ts`)ので、
   *   編集中の「+ ノート」は**押しても 1 ドットも動かない**。そこを画面でいちばん
   *   濃くすると、「濃い = 次に押す物」と教えた直後に嘘をつく。
   * ⚠ **押した結果は変えていない** ── 黙って捨てる穴は別に起票した。
   */
  it('🔴 編集中は、左の列の「+ ノート」が濃くなくなる', () => {
    const { root, d } = mount();
    // 前提:読んでいるときは濃い(そうでなければ以下は自明)
    expect(primariesIn(root, 'sidebar'), '前提が崩れている: 読んでいるとき濃くない').toEqual([
      'create-entry',
    ]);
    d.dispatch({ type: 'START_EDIT' });
    expect(primariesIn(root, 'sidebar'), '編集中も「+ ノート」が濃い(押しても何も起きないのに)').toEqual(
      [],
    );
    // ⚠ 戻ること ── 片道の変化を作らない
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(primariesIn(root, 'sidebar'), '編集を終えても濃さが戻らない').toEqual(['create-entry']);
  });

  it('🔴 画面ぜんぶで、主の操作は 2 つを超えない(左の列 + 中央)', () => {
    const { root, d } = mount();
    const count = (): number => root.querySelectorAll('button[data-pkc-primary]').length;
    expect(count(), '読んでいるとき、主が多すぎる').toBe(2);
    d.dispatch({ type: 'START_EDIT' });
    // 編集中は中央の「保存」だけ(左の「+ ノート」は押せないので濃さを外す)
    expect(count(), '編集中、主が多すぎる').toBe(1);
  });

  /**
   * 🔴 **1 件も無い一覧でも、主は 1 つだけ**(着地前レビュー・実装 4)。
   * ⚠ `empty-start.ts` に **2 つ目の `create-entry`**(「+ ノートを作る」)が在る ──
   *   そこにも印を付けると**左の列に濃い物が 2 つ**並ぶ。付けない側に決めたので、
   *   決めたことをここで留める(留めないと、次に読む人が「改善」として入れる)。
   */
  it('🔴 1 件も無い一覧でも、主は「+ ノート」1 つだけ', () => {
    const { root } = mount([]);
    // 前提:空の案内が出ている(出ていなければ何も判定していない)
    // ⚠ **`[data-pkc-archetype]` で探さない** ── 帯の「+ ノート」も同じ属性を持つので、
    //    空の案内が 1 度も出なくても前提が通ってしまう(1 稿目でそう外した)
    expect(
      root.querySelector('[data-pkc-region="sidebar"] [data-pkc-field="empty-start-create"]'),
      '前提が崩れている: 空の一覧の「+ ノートを作る」が出ていない',
    ).not.toBeNull();
    expect(primariesIn(root, 'sidebar')).toEqual(['create-entry']);
  });

  it('🔴 印を付ける口は markPrimary だけ(属性を直に書かない)', () => {
    const bad: string[] = [];
    for (const file of walk('src')) {
      if (file.endsWith(join('ui', 'render', 'icons.ts'))) continue;
      const text = readFileSync(file, 'utf-8');
      // ⚠ コメントの中の言及は拾わない ── 実行する行だけを見る
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (code.includes('data-pkc-primary')) bad.push(file);
    }
    expect(bad, '印を直に書いている file がある(全数検査が数え落とす)').toEqual([]);
    // ⚠ 空振り防止 ── icons.ts の側には在ること
    expect(
      readFileSync('src/adapter/ui/render/icons.ts', 'utf-8'),
      '印の定義が icons.ts から消えた',
    ).toContain('data-pkc-primary');
  });
});
/**
 * 🔴 **編集中の「+ ノート」は、押せない見た目になり、理由を言う**(#761)。
 *
 * ## 直す前に起きていたこと
 *
 * `CREATE_ENTRY` は `phase !== 'ready'` を **`events: []` で黙って捨てる**。
 * だから編集中の「+ ノート」は **1 ドットも動かず、断り文も出なかった** ──
 * `Ctrl+N` も同じボタンを押しに行くので、鍵も**完全に無音**だった。
 *
 * ## 🔑 観測点を 3 つに分けた(1 つでは足りない)
 *
 * | 見るもの | 落ちないと何を見逃すか |
 * |---|---|
 * | `disabled` | 見た目で押せないと分からない(#715 の規律の外に落ちる) |
 * | 説明(`title`)の中の理由 | hover と「操作を名前で探す」に理由が届かない |
 * | **鍵で撃ったときの 1 行** | 🔴 **鍵は見た目を持たない** ── ここだけが無音のまま残る |
 *
 * ⚠ **「ノートが増えない」だけを見ても意味が無い** ── 直す前も増えなかった
 *   (issue #761 がそう書いている)。**理由の側**が、この検査の本体である。
 *
 * ## ⚠ ここが見ているのは「鍵がボタンまで届いたとき」だけである
 *
 * 実ブラウザで測って分かったこと(2026-09-08):**本文を打っている最中の
 * `Ctrl+N` は、もっと手前の門で止まる** ── 文字を打つ欄に焦点があるときは
 * 全域の鍵を通さない(`typing` の判定)。⚠ そこは「打っている途中に別のノートへ
 * 飛ばない」ための**意図的な門**で、#761 が直す所ではない(マニュアルにも
 * 前からそう書いてある)。
 * 🔑 だから下の検査は `runGlobalCommand` を**直に**呼ぶ ── 鍵の配線そのものは
 *   `tests/smoke/primary-action.smoke.spec.ts` が、焦点を欄の外へ出してから見る。
 */
describe('編集中の「+ ノート」は理由を言う(#761)', () => {
  /** 左の列の「+ ノート」。⚠ 無ければ前提が崩れている。 */
  function createBtn(root: HTMLElement): HTMLButtonElement {
    const b = root.querySelector<HTMLButtonElement>('[data-pkc-field="create-run"]');
    if (b === null) throw new Error('前提が崩れている: 「+ ノート」が無い');
    return b;
  }

  it('🔴 読んでいる間は押せる(空振り防止の対照群)', () => {
    const { root, d } = mount();
    const b = createBtn(root);
    expect(b.disabled, '読んでいるのに押せない').toBe(false);
    expect(b.getAttribute('data-pkc-blocked'), '押せるのに理由が付いている').toBeNull();
    expect(b.title, '押せるのに説明へ理由が混ざっている').not.toContain('編集中');
    // 🔑 **実際に増える**ことまで見る ── 増えないなら、下の「増えない」は自明になる
    const before = d.getState().entryMetas.size;
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n9', title: '新規' });
    expect(d.getState().entryMetas.size, '押せる状態なのに増えない(台が壊れている)').toBe(
      before + 1,
    );
  });

  it('🔴 編集中は押せない見た目になり、説明に理由が入る', () => {
    const { root, d } = mount();
    d.dispatch({ type: 'START_EDIT' });
    const b = createBtn(root);
    expect(b.disabled, '編集中なのに押せる見た目のまま').toBe(true);
    const why = b.getAttribute('data-pkc-blocked');
    expect(why, '押せないのに理由を持っていない').not.toBeNull();
    expect(why, '理由が編集中の話になっていない').toContain('編集中');
    // ⚠ 出口も言う ── 「使えません」だけだと、user はどこを押せばよいか分からない
    expect(why, '出口(保存 / キャンセル)を言っていない').toContain('保存');
    expect(b.title, '説明に理由が出ていない(hover と「操作を探す」が読む所)').toContain(why!);
  });

  /**
   * 🔴 **割当を変えても理由が消えない**(#761)。
   *
   * ⚠ 説明は `applyShortcutHints` が**割当の変更のたびに組み直す** ── 理由を
   *   知らないまま土台だけ書き戻すと、`Ctrl+N` を割り当て直した瞬間に
   *   **理由だけが静かに消える**(画面は「押せない」のに、なぜかは読めない)。
   * 🔑 だから理由はボタンの属性に置き、組み立ての 1 本が毎回読む。
   */
  it('🔴 説明を組み直しても、理由は残る', () => {
    const { root, d } = mount();
    d.dispatch({ type: 'START_EDIT' });
    const b = createBtn(root);
    const why = b.getAttribute('data-pkc-blocked');
    expect(why, '前提が崩れている: 理由が付いていない').not.toBeNull();
    // ⚠ 空振り防止 ── 組み直しが 1 件も当たっていないなら、この検査は何も見ていない
    expect(applyShortcutHints(root), '説明を 1 つも組み直していない').toBeGreaterThan(0);
    expect(b.title, '組み直したら理由が消えた').toContain(why!);
  });

  it('🔴 編集中に鍵で撃つと、ノートは増えず、画面に理由が 1 行出る', () => {
    const { root, d } = mount();
    d.dispatch({ type: 'START_EDIT' });
    const before = d.getState().entryMetas.size;
    const said: string[] = [];
    let prevented = 0;
    const ran = runGlobalCommand(
      'create-entry',
      root,
      d,
      appKeymap,
      () => {
        prevented += 1;
      },
      (t) => said.push(t),
    );
    expect(ran, '鍵の受け手が拾っていない').toBe(true);
    expect(prevented, 'ブラウザの既定を止めていない').toBe(1);
    expect(d.getState().entryMetas.size, '編集中なのにノートが増えた').toBe(before);
    // 🔴 **ここが本体** ── 直す前はここが 0 行だった
    expect(said, '鍵で撃ったのに理由が 1 行も出ない').toHaveLength(1);
    expect(said[0], '出た字が理由になっていない').toContain('編集中');
  });

  it('⚠ 理由を持たない押せないボタンは、今までどおり黙っている(nav-back)', () => {
    /**
     * 🔑 **対照群**(#761 の実装が「一律に何か言う」形になっていないこと)。
     * ⚠ 履歴が無いときの `Alt+←` まで喋ると、連打で字が出続ける ──
     *   `nav-back` は `disabled` だが**理由を持たない**ので黙るのが正しい。
     */
    const { root, d } = mount();
    const back = root.querySelector<HTMLButtonElement>('button[data-pkc-action="nav-back"]');
    expect(back, '前提が崩れている: 戻るボタンが無い').not.toBeNull();
    expect(back!.disabled, '前提が崩れている: 履歴が無いのに押せる').toBe(true);
    expect(back!.getAttribute('data-pkc-blocked'), '理由を持ってしまっている').toBeNull();
    const said: string[] = [];
    runGlobalCommand('nav-back', root, d, appKeymap, () => {}, (t) => said.push(t));
    expect(said, '理由を持たないのに喋った').toEqual([]);
  });
});
