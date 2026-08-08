/** @vitest-environment happy-dom */
/**
 * 🔴 **ヘルプの面**(P11 段④。user 指示 2026-08-07)。
 *
 * > 「**お知らせ掲載内容は過去のお知らせとして、最大 10 件を…ヘルプ画面から
 * > 参照できるようにしてください / ヘルプ画面にはマニュアル導線も含めてください**」
 *
 * ## この test が守るもの
 *
 * - 版・お知らせ・マニュアルの **3 つが出る**(1 つ欠けても落ちる)
 * - 🔴 **マニュアルに文書内アンカーが無い** ── 面は `hidden` で同一 document に
 *   常駐するので、`#slug` は**先に作られた本文面の見出し**に当たる
 * - 🔴 **器を捨てない**(この repo が 4 度踏んだ罠)
 * - 🔴 **面の表が 2 つある**(`app-state.ts` の `ASIDE_PANES` と `center.ts` の
 *   `ASIDE`)── 片方だけに足すと「押しても本文が出る」。両方を**振る舞いで**突合する
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { HelpRenderer, MANUAL_TEXT, versionText } from '../../src/adapter/ui/render/help';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import {
  initialState,
  isAsidePane,
  type AppState,
  type ViewMode,
} from '../../src/adapter/state/app-state';
import { APP_VERSION } from '../../src/runtime/release-meta';
import { NOTICES, NOTICE_SHOW_MAX } from '../../src/features/notice/notice-log';

let region: HTMLElement;
beforeEach(() => {
  document.body.textContent = '';
  region = document.createElement('div');
  document.body.append(region);
});

describe('ヘルプの面', () => {
  it('題名と、版・お知らせ・マニュアルの 3 つが出る', () => {
    new HelpRenderer(region).render();
    expect(region.querySelector('[data-pkc-field="pane-title"]')?.textContent).toBe('ヘルプ');
    expect(
      region.querySelector('[data-pkc-field="help-version"]')?.textContent,
      '版が出ていない(不具合報告に要る)',
    ).toContain(APP_VERSION);
    expect(region.querySelector('[data-pkc-region="help-notices"]'), 'お知らせが無い').not.toBeNull();
    expect(region.querySelector('[data-pkc-region="help-manual"]'), 'マニュアルが無い').not.toBeNull();
  });

  /**
   * ⚠ 版の種別は**文字で出す**(設定は hover の `title` にしか入れておらず、
   * タッチ端末・キーボードだけの user には届かなかった)。
   */
  it('⚠ product 以外の版は、開発版だと文字で分かる', () => {
    // BUILD_KIND は build 時に焼かれる ── test では組み立て規則そのものを見る
    expect(versionText()).toContain(APP_VERSION);
    expect(versionText().startsWith('pkc3 v'), '版の組み立てが変わった').toBe(true);
  });

  it('🔴 お知らせが新しい順に、上限まで出る', () => {
    new HelpRenderer(region).render();
    const ids = [...region.querySelectorAll('[data-pkc-help-notice]')].map(
      (e) => e.getAttribute('data-pkc-help-notice') ?? '',
    );
    expect(ids.length, 'お知らせが 1 件も出ていない(fixture の空振り)').toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(NOTICE_SHOW_MAX);
    expect([...ids].sort().reverse(), '新しい順に並んでいない').toEqual(ids);
    // 日付は id から引く(field を二重に持たない)
    const first = region.querySelector('[data-pkc-field="notice-title"]')?.textContent ?? '';
    expect(first, '日付が出ていない').toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  /**
   * ⚠ **取込の注意**(`notices.ts`)と名前がかぶらないこと。同じ document に
   * 両方が居るので、かぶると片方を数える検査がもう片方を拾う。
   */
  it('⚠ 取込の注意と属性名がかぶらない', () => {
    new HelpRenderer(region).render();
    expect(region.querySelector('[data-pkc-notice]'), '取込の注意と同じ名前を使っている').toBeNull();
  });

  it('マニュアルを焼き込んでいる(外へ見に行かない)', () => {
    expect(MANUAL_TEXT.length, 'マニュアルが空').toBeGreaterThan(1000);
    expect(MANUAL_TEXT, 'マニュアル本体ではない').toContain('## 4. 画面のならび');
  });

  /**
   * 🔴 **文書内アンカーを持たせない。**
   *
   * 面は `hidden` で同一 document に常駐する ── 本文の見出しは `id=<slug>` を
   * 焼くので、マニュアルの `#slug` は**先に作られた本文面の見出し**に当たる。
   * ⚠ `:::toc` も同じ理由で書けない(生成されるのは文書内リンクである)。
   */
  it('🔴 マニュアルに文書内アンカーが 1 件も無い', () => {
    const anchors = [...MANUAL_TEXT.matchAll(/\]\(#[^)]*\)/g)].map((m) => m[0]);
    expect(anchors, `文書内アンカーが在る: ${anchors.join(' ')}`).toEqual([]);
    /**
     * ⚠ **書いてあるのと使っているのは別**。マニュアルは §3 で `:::toc` という
     * 記法を**説明している**(バッククォートの中)── それは描かれない。
     * 落としたいのは**行頭の `:::toc`**(実際に目次が生成される形)である。
     */
    const tocLines = MANUAL_TEXT.split('\n').filter((l) => /^:::toc\b/.test(l));
    expect(tocLines, ':::toc は文書内リンクを作る').toEqual([]);
  });

  /**
   * 🔴 **器を捨てない**(情報ペイン / ファイラ / 本文の面で 3 度、
   * 2026-08-07 に踏んだ)。押される寸前のボタンが別 node になると binder が捨てる。
   */
  it('🔴 描き直しても器が同じ node のまま', () => {
    const r = new HelpRenderer(region);
    r.render();
    const before = region.querySelector('[data-pkc-region="help-manual"]');
    r.render();
    expect(region.querySelector('[data-pkc-region="help-manual"]'), '器を作り直した').toBe(before);
  });

  /** ⚠ ワーカーが無いときは**素の原文**を出す ── 白紙にしない。 */
  it('⚠ markdown の口が無くても白紙にしない', () => {
    new HelpRenderer(region).render();
    const host = region.querySelector('[data-pkc-region="help-manual"]')!;
    expect(host.textContent, '白紙になっている').toContain('画面のならび');
  });

  it('markdown の口が在れば、それで描く', async () => {
    const seen: string[] = [];
    new HelpRenderer(region, {
      render: async (t) => {
        seen.push(t);
        return '<p data-probe="1">描いた</p>';
      },
    }).render();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[0], 'マニュアル全文を渡していない').toBe(MANUAL_TEXT);
    expect(region.querySelector('[data-probe="1"]'), '描いた結果が入っていない').not.toBeNull();
  });

  /** ⚠ 口が壊れていても白紙にしない(素の原文へ落ちる)。 */
  it('⚠ markdown の口が投げても白紙にしない', async () => {
    new HelpRenderer(region, {
      render: () => Promise.reject(new Error('worker died')),
    }).render();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const host = region.querySelector('[data-pkc-region="help-manual"]')!;
    expect(host.textContent, '白紙になっている').toContain('画面のならび');
  });
});

/**
 * 🔴 **お知らせの登記表の決まり**(書式は `.claude/skills/notice-writing/SKILL.md`)。
 * ⚠ 散文の規律にしない ── PKC2 は 1 entry 22 項目・1 項目 200 字超の壁を作った。
 */
describe('お知らせの登記表', () => {
  it('🔴 記法を書いていない(素のテキストとして出る)', () => {
    for (const n of NOTICES) {
      for (const line of n.items) {
        expect(line, `記法が書かれている: ${line}`).not.toMatch(/\*\*|`|\]\(/);
      }
    }
  });

  it('🔴 id が `YYYY-MM-DD-slug` で、重複しない', () => {
    const ids = NOTICES.map((n) => n.id);
    for (const id of ids) expect(id, `id の形が違う: ${id}`).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/);
    expect(new Set(ids).size, 'id が重複している').toBe(ids.length);
  });
});

/**
 * 🔴 **面の表が 2 つある。**
 *
 * `app-state.ts` の `ASIDE_PANES`(「一覧を押したら中央をノートへ戻すか」)と
 * `center.ts` の `ASIDE`(「中央に自分の器を持つか」)── 片方だけに足すと、
 * その面は**開いても本文が出る**(押しても何も起きないように見える)。
 * ⚠ ここは**振る舞いで**突合する(定数を export して見比べない ── export した
 * 定数を見るだけの test は、`toPane` が別の判定を持っていても通る)。
 */
const ALL_VIEWS = [
  'detail',
  'calendar',
  'kanban',
  'filer',
  'launcher',
  'settings',
  'flags',
  'help',
] as const satisfies readonly ViewMode[];

/**
 * ⚠ **型で全数を守る。** ここに足し忘れた ViewMode が在ると `never` に
 * 代入できず `npm run typecheck` が落ちる ── 表の取りこぼしを人手に頼らない。
 */
const _exhaustive: Exclude<ViewMode, (typeof ALL_VIEWS)[number]> extends never ? true : never = true;
void _exhaustive;

/** ⚠ **本物の初期 state を使う**(手組みの偽物は、足りない field を静かに隠す)。 */
function stateWith(viewMode: ViewMode): AppState {
  return { ...initialState, viewMode };
}

describe('🔴 中央の面の表が 2 つある(食い違いを落とす)', () => {
  it.each(ALL_VIEWS)('%s: 自分の器を持つ面と、ノートへ落ちる面が一致する', (view) => {
    const host = document.createElement('div');
    document.body.append(host);
    const router = new CenterRouter(host);
    router.render(stateWith(view));
    const shown = [...host.querySelectorAll('[data-pkc-view-pane]')].filter(
      (e) => !(e as HTMLElement).hidden,
    );
    expect(shown, '見えている面が 1 つではない').toHaveLength(1);
    const name = shown[0]?.getAttribute('data-pkc-view-pane');
    if (isAsidePane(view)) {
      // 🔑 ノートを映さない面は、**自分の器**が出ていなければならない
      expect(name, `${view} は自分の器を持っていない(center.ts の表に足し忘れ)`).toBe(view);
    } else {
      /**
       * 🔑 **逆向きも見る。** かんばん / カレンダーは自分の器、探し方
       * (`filer` / `launcher`)は**本文へ落ちる**(探し方は左の列が持つ)。
       * ⚠ ここを書かないと、`app-state.ts` の表にだけ足した面が素通りする。
       */
      const expected = view === 'kanban' || view === 'calendar' ? view : 'detail';
      expect(name, `${view} の落ち先が違う(app-state.ts の表に足し忘れ)`).toBe(expected);
    }
  });
});
