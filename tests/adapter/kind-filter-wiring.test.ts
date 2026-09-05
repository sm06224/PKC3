/** @vitest-environment happy-dom */
/**
 * 🔴 **種類で絞る ── 配線**(#411)。
 *
 * 純関数の規則は `tests/features/kind-filter.test.ts` が見る。ここで見るのは
 * **画面と state の間**、つまり「規則が全部の面に届いているか」である。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
import { KindBarRenderer } from '../../src/adapter/ui/render/kind-bar';
import type { BrowseMode } from '../../src/adapter/ui/render/browse-mode';

function meta(lid: string, order: number, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    ...over,
  } as EntryMeta;
}

const boot = (metas: EntryMeta[]): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;

const SET = [
  meta('a', 1, { title: 'りんご' }),
  meta('b', 2, { title: '写真', archetype: 'attachment' }),
  meta('c', 3, { title: '資料', archetype: 'folder' }),
  meta('d', 4, { title: 'りんご園', archetype: 'attachment' }),
];

describe('reducer', () => {
  it('札を押すと入り、もう一度押すと外れる', () => {
    let s = boot(SET);
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    expect([...s.kindFilter]).toEqual(['attachment']);
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    expect([...s.kindFilter]).toEqual([]);
  });

  it('解除は全部外す', () => {
    let s = boot(SET);
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'folder' }).state;
    expect(s.kindFilter.size).toBe(2);
    expect(reduce(s, { type: 'CLEAR_KIND_FILTER' }).state.kindFilter.size).toBe(0);
  });

  it('⚠ 選択は消さない(絞って消えた行を選んでいても、外せば戻る)', () => {
    let s: AppState = { ...boot(SET), selectedLid: 'a' };
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    expect(s.selectedLid).toBe('a');
  });

  it('⚠ 本文の当たりは捨てない(語は変わっていない ── 捨てると行がちらつく)', () => {
    const hits = new Set(['a']);
    let s: AppState = { ...boot(SET), searchHits: hits as ReadonlySet<string> };
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    expect(s.searchHits).toBe(hits);
  });

  /**
   * 🔴 **これが本命**(review M-2 の再演)。
   *
   * 「添付だけ」を出しているときに**ノートを作る**と、作った物は札に弾かれて
   * 一覧に出ない ── user は「効かなかった」と思って Esc を押し、
   * **新規未編集 cancel の掃除で entry ごと消える**。
   * ⚠ `filterQuery` については 2026-08 に実証済みで、そちらは既に外している。
   *   軸が 1 つ増えたので、**同じ穴が同じ形で開いた**。
   */
  it('🔴 作ると種類の絞りも外れる(作った物が一生出ない、を作らない)', () => {
    let s = boot(SET);
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    expect(s.kindFilter.size, '前提: 絞っている').toBe(1);
    s = reduce(s, { type: 'CREATE_ENTRY', archetype: 'text', lid: 'n', title: '新しい' }).state;
    expect(s.kindFilter.size, '作ったのに絞りが残っている ── 作った物が出ない').toBe(0);
  });

  /**
   * 🔴 **添付の作成だけは絞りを外さない**(#668 D)。
   *
   * 上の it の理由(作った物が絞りに弾かれて一生出ない → Esc で消える)は添付には
   * 当たらない ── 添付は開いていたノートの本文に入り(#666)、編集にも入らない。
   * ⚠ 逆に外すと「探す」の字と種類の札が、写真を 1 枚足しただけで黙って消える。
   * 🔑 上の it が**対照群**である(普通のノートでは外れる)── 判定を archetype で
   *   分けていることを、両側で見る。
   */
  it('🔴 添付を作っても「探す」の字と種類の札は残る(#668 D)', () => {
    let s: AppState = { ...boot(SET), filterQuery: 'りんご' };
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'text' }).state;
    expect(s.kindFilter.size, '前提: 絞っている').toBe(1);
    s = reduce(s, {
      type: 'CREATE_ENTRY',
      archetype: 'attachment',
      lid: 'att',
      title: '猫.png',
      body: '---\nattachment.name: 猫.png\n---\n',
      edit: false,
    }).state;
    expect(s.entryMetas.has('att'), '前提: 添付が作られていない').toBe(true);
    expect([...s.kindFilter], '添付を作ったら種類の札が消えた').toEqual(['text']);
    expect(s.filterQuery, '添付を作ったら「探す」の字が消えた').toBe('りんご');
  });
});

/**
 * 🔴 **消したあと、次に選ばれるのは「見えているもの」**(#411 / review M-1 の再演)。
 *
 * ⚠ 2026-08 に `filterQuery` で実証済みの事故そのものである ──
 *   絞り込み**前**の並びから後継を採ると、**一覧に出ていない entry** が選ばれ、
 *   もう一度「削除」を押すと**見えていないものが消える**。
 * 🔑 軸が 1 つ増えたので、同じ穴が同じ形で開いた ── 変異試験 M9 が
 *   `SURVIVED` で教えた(この it を書くまで、この経路は**誰も通っていなかった**)。
 */
describe('消したあとの後継', () => {
  it('🔴 種類で絞っているとき、後継は**その種類の中**から選ばれる', () => {
    let s = boot(SET); // a:ノート b:添付 c:フォルダ d:添付
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    s = { ...s, selectedLid: 'b' };
    const after = reduce(s, { type: 'DELETE_ENTRY', lid: 'b' }).state;
    expect(after.selectedLid, '画面に出ていないノートが選ばれた').toBe('d');
  });

  /**
   * ⚠ **対照群**。絞っていなければ、隣(`c`)が後継になる ── これが変わって
   *   いないことを見ないと、「たまたま `d` になっただけ」と区別がつかない。
   */
  it('⚠ 絞っていなければ、後継は素直に隣', () => {
    const s = { ...boot(SET), selectedLid: 'b' };
    expect(reduce(s, { type: 'DELETE_ENTRY', lid: 'b' }).state.selectedLid).toBe('c');
  });

  it('その種類が自分しか居なければ、後継は無し(見えないものを選ばない)', () => {
    let s = boot(SET);
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'folder' }).state;
    s = { ...s, selectedLid: 'c' };
    expect(reduce(s, { type: 'DELETE_ENTRY', lid: 'c' }).state.selectedLid).toBeNull();
  });
});

describe('サイドバーの札', () => {
  /**
   * ⚠ **札を描く renderer が変わった**(2026-08-27、#478)── 帯は左の列に在って
   *   面をまたぐので、**面の中(`SidebarRenderer`)から器の側(`KindBarRenderer`)へ
   *   移した**(移す前は一覧以外のタブで 1 度も描き直されず、押しても嘘をついた)。
   * 🔑 **見たいことは 1 つも変えていない** ── 下の assert はそのままで、
   *   **駆動する相手だけ**を差し替えている。
   * ⚠ `sidebar.render` も併せて呼ぶ ── 行(`entry-list`)は今もそちらが描くので、
   *   「札を押すと行が減る」を見る test はその両方が要る。
   */
  const mount = () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const region = root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!;
    const list = new SidebarRenderer(region);
    const bar = new KindBarRenderer(region);
    // ⚠ 既定は一覧(札が出る面)── 面ごとの出し分けは `kind-bar.test.ts` が見る
    const sidebar = {
      render: (state: AppState, mode: BrowseMode = 'list'): void => {
        list.render(state);
        bar.render(state, mode);
      },
    };
    return { root, sidebar, region };
  };
  const chips = (region: HTMLElement) =>
    [...region.querySelectorAll('[data-pkc-action="toggle-kind-filter"]')].map(
      (b) => b.textContent,
    );

  it('その場に居る種類だけが、件数つきで札になる', () => {
    const { sidebar, region } = mount();
    sidebar.render(boot(SET));
    expect(chips(region)).toEqual(['ノート 1', 'フォルダ 1', '添付 2']);
  });

  it('🔴 種類が 1 つしか無ければ帯ごと出さない(押しても変わらない札は dead click)', () => {
    const { sidebar, region } = mount();
    sidebar.render(boot([meta('a', 1), meta('b', 2)]));
    expect(region.querySelector<HTMLElement>('[data-pkc-region="kind-bar"]')!.hidden).toBe(true);
  });

  it('🔴 **札を押すと行が減る**(state だけ正しくて画面が変わらない、にしない)', () => {
    const { sidebar, region } = mount();
    let s = boot(SET);
    sidebar.render(s);
    const rows = () => region.querySelectorAll('[data-pkc-region="entry-list"] li').length;
    expect(rows()).toBe(4);
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    sidebar.render(s);
    expect(rows(), '指紋に kindFilter が入っていない ── 押しても行が減らない').toBe(2);
  });

  it('押されている札は `aria-pressed`(色だけで表さない)', () => {
    const { sidebar, region } = mount();
    let s = boot(SET);
    sidebar.render(s);
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'folder' }).state;
    sidebar.render(s);
    const on = [...region.querySelectorAll('[data-pkc-action="toggle-kind-filter"]')].filter(
      (b) => b.getAttribute('aria-pressed') === 'true',
    );
    expect(on).toHaveLength(1);
    expect(on[0]!.getAttribute('data-pkc-kind')).toBe('folder');
  });

  /**
   * 🔴 **閉じ込めない。** 札はその場に居る種類しか出さないので、絞った先で
   * 札そのものが消える場面がある ── そのとき「0 件です」とだけ出た画面になり、
   * user には**絞りが効いていることすら見えない**。
   */
  it('🔴 絞っている間は必ず「解除」が出る(戻る道を消さない)', () => {
    const { sidebar, region } = mount();
    const clear = () => region.querySelector('[data-pkc-field="kind-clear"]');
    let s = boot(SET);
    sidebar.render(s);
    expect(clear(), '絞っていないのに解除が出ている').toBeNull();
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    sidebar.render(s);
    expect(clear()).not.toBeNull();
  });

  it('🔴 選んだ種類が 1 件も居なくなっても、解除は残る', () => {
    const { sidebar, region } = mount();
    // 添付が 1 件も無い器で、添付だけに絞っている(語で絞った先で起こりうる形)
    let s = boot([meta('a', 1), meta('b', 2, { archetype: 'folder' })]);
    s = reduce(s, { type: 'TOGGLE_KIND_FILTER', archetype: 'attachment' }).state;
    sidebar.render(s);
    expect(region.querySelectorAll('[data-pkc-region="entry-list"] li')).toHaveLength(0);
    expect(
      region.querySelector('[data-pkc-field="kind-clear"]'),
      '0 件の画面から戻る道が無い(user が閉じ込められる)',
    ).not.toBeNull();
  });

  it('札の数は「語で絞った後」を数える(押すと 0 件になる札を作らない)', () => {
    const { sidebar, region } = mount();
    const s = { ...boot(SET), filterQuery: 'りんご' };
    sidebar.render(s);
    // 'りんご'(text) と 'りんご園'(attachment)── フォルダは当たらないので札に出ない
    expect(chips(region)).toEqual(['ノート 1', '添付 1']);
  });
});

/**
 * 🔴 **絞りが全部の面に届いているか**(CLAUDE.md §7)。
 *
 * ⚠ `filerRows` の `kinds` と `matchesEntry` の引数は**必須**にしてあるので、
 *   「渡し忘れ」は tsc が止める ── だがそれは「**何かを渡した**」までしか
 *   言わない。`NO_KINDS` を渡せば型は通り、**その面だけ絞りが効かない**。
 * 🔑 だから見るのは「**`state.kindFilter` を渡していること**」である。
 */
describe('絞りが全部の面に届いている', () => {
  const FACES = [
    'src/adapter/ui/render/filer.ts',
    'src/adapter/ui/render/dual-filer.ts',
    'src/adapter/state/app-state.ts',
    'src/adapter/ui/actions/binder.ts',
  ];

  it('`filerRows` を呼ぶ面は、数えた数だけ `kindFilter` を渡している', () => {
    for (const f of FACES) {
      const src = readFileSync(f, 'utf8');
      const calls = (src.match(/filerRows\(/g) ?? []).length;
      const passed = (src.match(/kinds: (st|state)\.kindFilter,/g) ?? []).length;
      expect(calls, `${f}: 前提が崩れている(呼び出しが 1 つも無い)`).toBeGreaterThan(0);
      expect(passed, `${f}: ${calls} 回呼んでいるのに ${passed} 回しか渡していない`).toBe(
        calls,
      );
    }
  });

  /**
   * 🔴 **絞りを渡していても、指紋に入れ忘れると画面は変わらない**(#411)。
   *
   * ⚠ これは**実ブラウザの smoke が拾った** ── unit はサイドバーしか見て
   *   いなかったので、フォルダ面と 2 ペインと予定は**誰も守っていなかった**
   *   (`filer.ts` の 530 行目に「`filerRows` へ渡しているのに指紋に入れて
   *   いなかった」と、まったく同じ罠の記録が既に在る)。
   * 🔑 **`filterQuery` を指紋にしている面は、`kindFilter` も指紋にする** ──
   *   軸を足すたびに全部の面を手で数え直さないで済むよう、規則で書く。
   *
   * ⚠ **見るのは「突き合わせの行」だけ**(代入の行 `this.lastKinds = …` を
   *   数えない)。初版は `this.last` を含む行を全部拾っていたので、**比較を
   *   消しても代入が残っていれば合格**だった ── 変異試験 M12 / M13 が
   *   `SURVIVED` で教えた(CLAUDE.md §1「救い手が変わっただけ」)。
   */
  it('🔴 `filterQuery` を指紋にしている面は、`kindFilter` も指紋にしている', () => {
    const FACES = [
      'src/adapter/ui/render/sidebar.ts',
      'src/adapter/ui/render/filer.ts',
      'src/adapter/ui/render/dual-filer.ts',
      'src/adapter/ui/render/schedule.ts',
    ];
    for (const f of FACES) {
      const src = readFileSync(f, 'utf8');
      /**
       * ⚠ **指紋の行だけを見る**(file 全体で `kindFilter` を数えない)──
       *   全体で数えると、`filerRows` へ渡している行に満たされて**常に真**に
       *   なる(CLAUDE.md §1「範囲が広すぎて無関係な行に満たされる」)。
       */
      const fp = src.split('\n').filter(
        (l) =>
          // 突き合わせの行(`state.x !== this.lastX`)── **代入の行は数えない**
          (/this\.last/.test(l) && /[!=]==/.test(l)) ||
          /**
           * 指紋を object で組む面(予定)── `{ filter: …, kindFilter: … }`。
           * ⚠ 鍵を**名指しする** ── `\w+:` で拾うと、`filerRows` へ渡している
           *   `kinds: state.kindFilter,` に満たされて**常に真**になる
           *   (変異試験 M12 / M13 がそれで生き延びた)。
           */
          /^\s*(filter|hits|kindFilter):\s*state\.\w+,$/.test(l),
      );
      const marksQuery = fp.some((l) => l.includes('filterQuery'));
      expect(marksQuery, `${f}: 前提が崩れている(絞り込みを指紋にしていない)`).toBe(true);
      expect(
        fp.some((l) => l.includes('kindFilter')),
        `${f}: 語は指紋なのに種類が指紋でない ── 札を押しても描き直さない`,
      ).toBe(true);
    }
  });

  it('語だけを見る面(サイドバー / 予定)も `kindFilter` を通している', () => {
    for (const f of ['src/adapter/ui/render/sidebar.ts', 'src/adapter/ui/render/schedule.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} が種類の絞りを渡していない`).toContain('state.kindFilter');
    }
  });
});
