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
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { HelpRenderer, MANUAL_TEXT, versionText } from '../../src/adapter/ui/render/help';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import {
  VIEW_MODES,
  initialState,
  isAsidePane,
  isViewMode,
  type AppState,
  type ViewMode,
} from '../../src/adapter/state/app-state';
import { APP_VERSION } from '../../src/runtime/release-meta';
import {
  NOTICES,
  NOTICE_ITEMS_MAX,
  NOTICE_ITEM_CHARS_MAX,
  NOTICE_ITEM_CHARS_MIN,
  NOTICE_KEEP_MAX,
  NOTICE_SEEN_MAX,
  NOTICE_SHOW_MAX,
  noticeDate,
} from '../../src/features/notice/notice-log';

let region: HTMLElement;
beforeEach(() => {
  document.body.textContent = '';
  region = document.createElement('div');
  document.body.append(region);
});

/**
 * 手で進められる時計(⚠ 実時間を待つ test は書けない)。
 *
 * 🔴 **1 つだけ置く**(着地前レビュー 2 巡目・[軽] 7)── 2 稿目が
 *   `clear: () => { jobs.length = 0 }` という**本物より甘い**写しを作りかけた。
 *   ⚠ handle を無視すると「**別の予約を消す**」変異を原理的に殺せない
 *   (CLAUDE.md §3「stub は本物の意味論を真似る」)。
 */
function fakeTimers() {
  const jobs: { fn: () => void; h: number }[] = [];
  let next = 1;
  return {
    port: {
      set: (fn: () => void) => {
        const h = next++;
        jobs.push({ fn, h });
        return h;
      },
      clear: (h: unknown) => {
        const i = jobs.findIndex((j) => j.h === h);
        if (i >= 0) jobs.splice(i, 1);
      },
    },
    /** 予約が何件待っているか(⚠ 「予約した」を数える対照群に使う)。 */
    pending: () => jobs.length,
    fire: () => {
      const all = jobs.splice(0, jobs.length);
      for (const j of all) j.fn();
    },
  };
}

describe('ヘルプの面', () => {
  it('題名と、版・お知らせ・マニュアルの 3 つが出る', () => {
    new HelpRenderer(region).render();
    expect(region.querySelector('[data-pkc-field="pane-title"]')?.textContent).toBe('ヘルプ');
    expect(
      region.querySelector('[data-pkc-field="help-version"]')?.textContent,
      '版が出ていない(不具合報告に要る)',
    ).toContain(APP_VERSION);
    /**
     * 🔴 **面が種別の刻印を落としていない**(2026-08-08、レビュー指摘)。
     * ⚠ `versionText` 単体の test は在ったが、**面が `versionText('product')` を
     *   呼ぶ変異は生き延びた** ── `'pkc3 v3.0.0'` は「版番号を含む」も
     *   `/^pkc3 v\d/` も満たすので、unit も smoke も緑のまま
     *   **全ビルドから開発版の刻印が消える**。関数を試すだけでは面を守らない。
     * ⚠ vitest は `BUILD_KIND === 'dev'`(`release-meta.ts`)。
     */
    expect(
      region.querySelector('[data-pkc-field="help-version"]')?.textContent,
      '面が種別の刻印を落としている(versionText を固定引数で呼んでいる)',
    ).toContain('(開発版)');
    expect(region.querySelector('[data-pkc-region="help-notices"]'), 'お知らせが無い').not.toBeNull();
    expect(region.querySelector('[data-pkc-region="help-manual"]'), 'マニュアルが無い').not.toBeNull();
  });

  /**
   * ⚠ 版の種別は**文字で出す**(設定は hover の `title` にしか入れておらず、
   * タッチ端末・キーボードだけの user には届かなかった)。
   */
  /**
   * ⚠ **種別を引数で試す**(2026-08-08、変異試験の指摘)。`BUILD_KIND` は build 時に
   * 焼き込まれるので、既定引数のままでは**分岐を 1 つも動かせず**、刻印を落とす
   * 変異が誰にも殺されなかった。
   */
  it('🔴 版に種別の刻印が出る(product だけ無印)', () => {
    expect(versionText('product'), 'product に余計な刻印が付いた').toBe(`pkc3 v${APP_VERSION}`);
    expect(versionText('stage'), '検証版の刻印が無い').toContain('(検証版)');
    expect(versionText('dev'), '開発版の刻印が無い').toContain('(開発版)');
  });

  it('🔴 お知らせが新しい順に、上限まで出る', () => {
    new HelpRenderer(region).render();
    const ids = [...region.querySelectorAll('[data-pkc-help-notice]')].map(
      (e) => e.getAttribute('data-pkc-help-notice') ?? '',
    );
    expect(ids.length, 'お知らせが 1 件も出ていない(fixture の空振り)').toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(NOTICE_SHOW_MAX);
    /**
     * 🔴 **「新しい順」は日付の順である**(2026-08-29 の動線レビュー 欠陥 5)。
     *
     * ⚠ 直す前は `[...ids].sort().reverse()` = **id 全体の綴り順**を要求していたので、
     *   実装が「同じ日は**英語スラッグの綴り順**」で並ぶことを**この test が pin していた** ──
     *   その結果、いちばん実害の大きい知らせが **7 番目**へ回り、user は
     *   「次へ」を 6 回押さないと読めなかった(実測)。
     * 🔑 見るのは 2 つ:①**日付が新しい順**であること
     *   ②**同じ日は登記表に書いた順**であること(登記表は先頭に足す規約)。
     */
    const dates = ids.map(noticeDate);
    expect([...dates].sort().reverse(), '日付が新しい順に並んでいない').toEqual(dates);
    const order = new Map(NOTICES.map((n, i) => [n.id, i]));
    const ranks = ids.map((id) => order.get(id) ?? -1);
    expect(ranks, '登記表に無いお知らせが出ている(空振り)').not.toContain(-1);
    expect([...ranks].sort((a, b) => a - b), '同じ日が登記表の順で出ていない').toEqual(ranks);
    // 日付は id から引く(field を二重に持たない)
    const first = region.querySelector('[data-pkc-field="notice-title"]')?.textContent ?? '';
    expect(first, '日付が出ていない').toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  /**
   * 🔴 **切るのは `recentNotices` だけ**(P11 の決まり)。
   * ⚠ 1 巡目は登記表が **1 件**だったので、上限も並びも「測っていない次元」だった
   *   ── 丸ごと出す変異が素通りした(変異試験で判明)。登記表を注入して試す。
   */
  it('🔴 登記表が上限より多くても、出るのは上限まで(新しい順)', () => {
    const many = Array.from({ length: NOTICE_SHOW_MAX + 4 }, (_, i) => ({
      id: `2026-02-${String(i + 1).padStart(2, '0')}-x`,
      title: `t${i}`,
      items: ['本文'],
    }));
    expect(many.length, 'fixture が上限を超えていない(空振り)').toBeGreaterThan(NOTICE_SHOW_MAX);
    new HelpRenderer(region, null, many).render();
    const ids = [...region.querySelectorAll('[data-pkc-help-notice]')].map(
      (e) => e.getAttribute('data-pkc-help-notice') ?? '',
    );
    expect(ids, '上限まで切っていない').toHaveLength(NOTICE_SHOW_MAX);
    expect(ids[0], '新しい順になっていない').toBe(`2026-02-${NOTICE_SHOW_MAX + 4}-x`);
  });

  /**
   * 🔴 **素のテキストで出す**(ヘルプ側。帯とは**別の描画経路**である)。
   * ⚠ CLAUDE.md「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」──
   *   帯だけ見ていたので、ヘルプ側を `innerHTML` にする変異が素通りした。
   */
  it('🔴 お知らせが素のテキストで出る(HTML として描かない)', () => {
    new HelpRenderer(region, null, [
      { id: '2026-08-08-x', title: 't', items: ['<b>太字</b>と <img src="x"> を書いた'] },
    ]).render();
    const li = region.querySelector('[data-pkc-help-notice] li')!;
    expect(li.children.length, 'HTML として描いている').toBe(0);
    expect(li.textContent, '原文が消えている').toContain('<b>太字</b>');
  });

  /**
   * 🔴 **マニュアルの箱を出る道が、ヘルプの中に在る**(#645。user 要望 2026-08-31
   * 「**ヘルプの中からマニュアルをアプリとして出してください**」)。
   *
   * ⚠ **箱の直上**に置く ── 下に置くと、60vh の箱をスクロールし切らないと
   *   見つからない(= 「在るのに届かない」を作り直すことになる)。
   */
  it('🔴 「マニュアルを別のウィンドウで開く」がマニュアルの箱の直上に在る', () => {
    new HelpRenderer(region).render();
    const btn = region.querySelector('[data-pkc-action="open-manual-window"]');
    expect(btn, 'ヘルプの中に、窓を開く口が無い').not.toBeNull();
    expect(btn!.textContent).toBe('マニュアルを別のウィンドウで開く');
    /**
     * ⚠ **並び順まで見る** ── 「在る」だけだと、箱の下に落ちても緑になる。
     * `compareDocumentPosition` で「ボタンが箱より前」を直に見る。
     */
    const box = region.querySelector('[data-pkc-region="help-manual"]')!;
    const before = btn!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(before, 'マニュアルの箱より後ろに置かれている').toBeTruthy();
  });

  /**
   * 🔴 **押した所を受けるのは binder 1 か所**(#645)── ここで直に listener を
   * 張ると、出す判定(help.ts)と押されたときの口(binder)が別々になる。
   */
  it('🔴 窓を開く口は data-pkc-action で出す(自前の listener を張らない)', () => {
    const src = readFileSync('src/adapter/ui/render/help.ts', 'utf-8');
    expect(src).toContain("'open-manual-window'");
    // ⚠ この file が window を開いてはいけない(adapter/platform の仕事である)
    expect(src, 'ヘルプの面が窓を開いている').not.toContain('window.open');
  });

  /**
   * ⚠ 見出しが無いと、版の行とお知らせが地続きに見える。
   * 🔴 **並びは「マニュアル → ショートカット → お知らせ」**(#719。user 裁定
   *   2026-09-06 = 案 A)── cowork 実測で「使い方を知りたい」で開いた人が最初に
   *   読むのが**リリースノート 11 件**だった(本文 106,339 字 / 5455px)。
   * ⚠ **等値で pin する** ── 「3 つ在る」だけだと、並びが戻っても落ちない。
   */
  it('🔴 見出しは「マニュアル → ショートカットキー → これまでのお知らせ」の順に出る', () => {
    new HelpRenderer(region).render();
    const heads = [...region.querySelectorAll('h3')].map((e) => e.textContent);
    expect(heads, '見出しの並びが違う').toEqual(['マニュアル', 'ショートカットキー', 'これまでのお知らせ']);
    /**
     * 🔑 **版は先頭のほうに在る**(下へ沈めない ── #719 の裁定)。
     * ⚠ **1 つだけ**であることも見る ── 「上にも出す」形にすると同じ値が 2 経路に
     *   なり、片方だけ直して食い違う(CLAUDE.md §7 / この面の元からの戒め)。
     */
    const vers = region.querySelectorAll('[data-pkc-field="help-version"]');
    expect(vers.length, '版が 2 か所に出ている(または消えた)').toBe(1);
    const order = [...region.querySelectorAll('[data-pkc-field="help-version"], h3')].map((e) =>
      e.getAttribute('data-pkc-field') ?? e.textContent,
    );
    expect(order.slice(0, 2), '版がマニュアルの見出しの直後に無い').toEqual([
      'マニュアル',
      'help-version',
    ]);
  });

  /**
   * 🔴 **面の並びを丸ごと等値で pin する**(着地前レビュー・実装 ⚠-4)。
   *
   * ⚠ 上の `h3` の並びだけでは足りない ── 変異試験で **3 件**が生き延びた:
   *   ①版をマニュアルの見出しの**上**へ戻す ②目次を別窓ボタンの**前**へ戻す
   *   ③探す欄を目次の**後ろ**へ回す。⚠ どれも h3 は 3 つのまま動かないので、
   *   「マニュアル → ショートカット → お知らせ」の pin は**1 つも鳴らない**。
   * 🔑 だから**器の直下の子を全部、順番どおりに**留める ── #719 の裁定は
   *   「何が在るか」ではなく「**開いた 1 画面に何がこの順で出るか**」だった。
   * ⚠ 名前は `data-pkc-region` → `data-pkc-field` → `タグ:字` の順に採る。
   * 🔴 **`settings-note` だけは字も留める**(着地前レビュー 2 巡目・[中] 2)──
   *   器の直下に 2 つ在り(目次の断りと、キーの断り)、名前しか見ないと
   *   ①**その 2 つを入れ替える** ②**字を空にする** が両方通る。
   *   ⚠ ②は 1 巡目の**動線 3**(「読み上げには名前が届き、目で見ている人には
   *   届かない」= 版の下に枠だけの箱)が丸ごと戻る形である。
   */
  it('🔴 ヘルプの面は、器の直下がこの順に並ぶ', () => {
    new HelpRenderer(region).render();
    const body = region.querySelector('[data-pkc-region="help-body"]');
    expect(body, '前提が崩れている: ヘルプの器が無い').not.toBeNull();
    const labels = [...body!.children].map((e) => {
      const field = e.getAttribute('data-pkc-field');
      // ⚠ 断りは**字そのものが仕事**なので、頭を留める(上の 2 つを落とす)
      if (field === 'settings-note') return `settings-note:${(e.textContent ?? '').slice(0, 6)}`;
      return (
        e.getAttribute('data-pkc-region') ?? field ?? `${e.tagName}:${e.textContent ?? ''}`
      );
    });
    expect(labels, 'ヘルプの面の並びが変わった(#719 の裁定と食い違う)').toEqual([
      'H3:マニュアル',
      'help-version',
      'help-manual-open',
      'help-find-bar',
      'settings-note:目次 ── ',
      'help-toc',
      'help-manual',
      'H3:ショートカットキー',
      'settings-note:Ctrl は',
      'help-keymap',
      'H3:これまでのお知らせ',
      'help-notices',
    ]);
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
 * 🔴 **しばらく開かなければ、マニュアルの中身を手放す**(#531 H3、2026-08-28)。
 *
 * ## 実測(2026-08-28)が設計を決めた
 *
 * | | 節点 |
 * |---|---|
 * | ヘルプを開く前 | 310 |
 * | 開いた後 | 6,884 |
 * | 閉じた後(直す前) | **6,884 のまま** |
 * | マニュアルの器だけ空に | 499(**6,385 節点・92.8% が返る**) |
 *
 * ⚠ しかし**入れ直しは 279 / 245 / 243 / 244 ms** 掛かる ── だから
 *   「**閉じたら捨てる**」にはしない(開き直すたびにその時間を払う)。
 *   user 指示 2026-08-03 は「メモリを食うのも、もっさりも嫌」で、**両方向**に効く。
 * 🔑 計算のワーカーと同じ「**しばらく使われなければ手放す**」形にした。
 *
 * ⚠ **器は捨てない** ── 捨てると押される寸前のボタンが消える(2026-08-07 に
 *   3 度踏んだ)。手放すのは**マニュアルの中身だけ**である。
 */
describe('ヘルプのマニュアルを、しばらく開かなければ手放す(#531 H3)', () => {
  let region: HTMLElement;
  beforeEach(() => {
    document.body.textContent = '';
    region = document.createElement('div');
    document.body.append(region);
  });

  const drawn = (): string => region.querySelector('[data-pkc-region="help-manual"]')!.innerHTML;

  it('🔴 閉じて時間が経つと中身を手放し、開き直すと戻る', async () => {
    const t = fakeTimers();
    let renders = 0;
    const r = new HelpRenderer(
      region,
      {
        render: async () => {
          renders += 1;
          return '<p data-probe="manual">マニュアル本文</p>';
        },
      },
      undefined,
      undefined,
      t.port,
      1000,
    );
    r.render('c1');
    await Promise.resolve();
    await Promise.resolve();
    expect(drawn(), '前提: マニュアルが描かれていない').toContain('data-probe="manual"');
    const host = region.querySelector('[data-pkc-region="help-manual"]');

    // ① 閉じただけでは**まだ捨てない**(入れ直しは 243〜279ms 掛かる)
    r.onHidden();
    expect(drawn(), '閉じた瞬間に捨てている(開き直すたびに待たされる)').toContain(
      'data-probe="manual"',
    );
    expect(t.pending(), '手放す予約をしていない').toBe(1);

    // ② しばらく開かないと手放す
    t.fire();
    expect(drawn(), '時間が経っても手放していない').not.toContain('data-probe="manual"');
    expect(
      region.querySelector('[data-pkc-region="help-manual"]'),
      '🔴 器ごと捨てた(押される寸前のボタンが消える)',
    ).toBe(host);

    // ③ 開き直すと戻る(⚠ 空のまま出ると「壊れた」に見える)
    r.render('c1');
    await Promise.resolve();
    await Promise.resolve();
    expect(drawn(), '開き直しても戻らない').toContain('data-probe="manual"');
    expect(renders, '描き直した回数が合わない').toBe(2);
  });

  it('🔴 すぐ開き直したら、描き直さない(待たされない)', async () => {
    const t = fakeTimers();
    let renders = 0;
    const r = new HelpRenderer(
      region,
      {
        render: async () => {
          renders += 1;
          return '<p data-probe="manual">マニュアル本文</p>';
        },
      },
      undefined,
      undefined,
      t.port,
      1000,
    );
    r.render('c1');
    await Promise.resolve();
    await Promise.resolve();
    r.onHidden();
    r.render('c1'); // すぐ戻ってきた
    // 🔴 **予約が取り消されていること** ── 残っていると、読んでいる最中に消える
    expect(t.pending(), '予約が残っている(読んでいる最中に中身が消える)').toBe(0);
    t.fire(); // 満期が来ても、もう誰も居ない
    expect(drawn(), 'すぐ戻ったのに手放した').toContain('data-probe="manual"');
    expect(renders, '同じ中身をもう一度描いた(待たせている)').toBe(1);
  });

  it('⚠ 一度も描いていなければ、予約もしない', () => {
    const t = fakeTimers();
    const r = new HelpRenderer(region, null, undefined, undefined, t.port, 1000);
    r.onHidden();
    expect(t.pending(), '描いてもいないのに予約した').toBe(0);
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

  /**
   * 🔴 **宣言した上限を、実際に読む。**
   *
   * ⚠ PKC2 は `date` field を宣言して**一度も読まなかった** ── この登記表で
   * 同じことをやりかけた。上限を定数で持っただけでは、**誰も止めない**。
   * だから定数を**この test が読む**(`.claude/skills/notice-writing/` の表と同じ値)。
   */
  it('🔴 項目数・字数が上限の中に収まっている', () => {
    for (const n of NOTICES) {
      expect(n.items.length, `${n.id}: 項目が多い`).toBeLessThanOrEqual(NOTICE_ITEMS_MAX);
      expect(n.items.length, `${n.id}: 項目が 0 件`).toBeGreaterThan(0);
      expect(n.title.length, `${n.id}: 題名が空`).toBeGreaterThan(0);
      for (const line of n.items) {
        expect(line.length, `${n.id}: 長すぎる項目「${line}」`).toBeLessThanOrEqual(
          NOTICE_ITEM_CHARS_MAX,
        );
        // ⚠ 下限も置く ── 空の行が user の画面に出るのを止める
        expect(line.length, `${n.id}: 短すぎる項目「${line}」`).toBeGreaterThanOrEqual(
          NOTICE_ITEM_CHARS_MIN,
        );
      }
    }
  });

  /**
   * ⚠ **掲示した約束は取り消せない**(PKC2 は掲示済みの挙動が後の既定変更を縛った)。
   * 「これから〜します」ではなく「〜できるようになりました」だけを書く。
   *
   * 🔴 **`予定です` を単独で弾かない**(2026-08-27、#280 で踏んだ)。
   * ⚠ PKC3 では **「予定」は機能の名前**である ── 「行に書いた予定です」は
   *   未来の約束ではなく**いま在るものの説明**なのに、弾かれていた。
   * 🔑 だから**動詞に続く形だけ**を見る(`する予定` / `〜される予定`)──
   *   ⚠ 名詞の「予定」まで弾くと、この製品では**正しい文が書けなくなる**
   *   (そして書き手は文を歪めるか、検査を丸ごと緩めるかを選ばされる)。
   */
  it('⚠ これからの約束を書いていない', () => {
    for (const n of NOTICES) {
      for (const line of n.items) {
        expect(line, `未来の約束が書かれている: ${line}`).not.toMatch(
          /([うくすつぬふむゆる]予定|していきます|対応します|近日)/,
        );
      }
    }
  });

  /**
   * ⚠ 登記表に残す件数の上限(読まれない物を配り続けない)。
   * ⚠ **自己言及にしない**(2026-08-08、変異試験の指摘)── 定数で fixture を作って
   *   同じ定数で assert していたので、`20 → 200` にする変異が素通りした。
   *   **宣言そのもの**を pin する(`.claude/skills/notice-writing/` の表と同じ値)。
   */
  it('⚠ 登記表が上限を超えておらず、上限の宣言も動いていない', () => {
    expect(NOTICES.length).toBeLessThanOrEqual(NOTICE_KEEP_MAX);
    expect(NOTICE_SHOW_MAX, '表示上限が変わった').toBe(10);
    expect(NOTICE_KEEP_MAX, '保持上限が変わった').toBe(10);
    /**
     * 🔴 **「表示の 2 倍」から「表示と同じ」へ変えた**(2026-08-29、#596 E)。
     * ⚠ 2 倍だった理由は「**原本は残す**」だったが、その役目は `CHANGELOG.md` が
     *   担っている ── 11 件目より後ろは**原本でもなく画面にも出ない重り**だった。
     * 🔑 揃えたので不変条件が 1 つ増える:**登記表 = 画面に出るもの**。
     */
    expect(NOTICE_KEEP_MAX, '登記表 = 画面に出るもの、が崩れた').toBe(NOTICE_SHOW_MAX);
    /**
     * 🔴 **既読の席は、表示件数より必ず多い**(2026-08-29 の着地前レビュー A)。
     * ⚠ 元は登記表の上限を既読にも使い回しており、20 → 10 に下げた瞬間に
     *   **読んだお知らせが毎起動よみがえる**ところだった(実際に再現した)。
     * ⚠ 等値ではなく**不等式**で pin する ── 「同じ数にしてはいけない」が主張である。
     * 🔑 押し出されないことそのものは `tests/adapter/notice-store.test.ts` が見る
     *   ── ここが見ているのは**宣言**であって、挙動ではない。
     */
    expect(
      NOTICE_SEEN_MAX,
      '既読の席が表示件数以下 ── 落ちた id が生きている id を押し出す',
    ).toBeGreaterThan(NOTICE_SHOW_MAX);
    /**
     * ⚠ **上限側にも門を置く**(2 巡目レビュー)── 席は localStorage に積む数なので、
     *   増やす方向には**鳴る計器が 1 つも無かった**(`* 50` にする変異が SURVIVED)。
     * 🔑 CLAUDE.md「tripwire は上限だけでなく下限も置く」の**裏返し**である。
     */
    expect(
      NOTICE_SEEN_MAX,
      '既読の席が増えすぎ ── localStorage に読まれない id を積み続ける',
    ).toBeLessThanOrEqual(NOTICE_SHOW_MAX * 4);
    expect(NOTICE_ITEMS_MAX, '項目数の上限が変わった').toBe(6);
    expect(NOTICE_ITEM_CHARS_MAX, '字数の上限が変わった').toBe(120);
    expect(NOTICE_ITEM_CHARS_MIN, '字数の下限が変わった').toBe(4);
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
  // ⚠ `calendar` / `kanban` は #292 段⑤ で中央の面ではなくなった(左の列のタブへ)
  'query',
  // ⚠ 予定表(#673 段②、user 裁定 2026-09-04)── 左の列の「予定」と同じ描画器を中央にも
  'schedule',
  // ⚠ 連絡先(#278 段③)── 予定表と同じ形
  'contacts',
  // ⚠ 探す面(#680)── ノートを映す面(行を押すと小窓)。左に同じ面は無い
  'search',
  'dual',
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

/**
 * 🔴 **畳んだ面が戻ってきていない**(#241 段⑥-b)。
 *
 * `'filer'` / `'launcher'` は P8 段⑤ で「探し方」を左の列へ移して以降、
 * **どこからも開かれない**まま `toPane` が本文へ落としていた死に値である。
 * ⚠ **同じ綴りが別の名前空間に生きている**(左の列のタブ `BrowseMode` と、
 *   鍵の文脈 `KeyContext`)ので、grep で消すと生きているほうを壊す ──
 *   ここは**中央の面としてだけ**受け付けないことを見る。
 */
describe('畳んだ中央の面(#241 段⑥-b)', () => {
  it('🔴 filer / launcher は中央の面として受け付けない', () => {
    expect(isViewMode('detail'), '空振り(生きている面まで弾いている)').toBe(true);
    for (const gone of ['filer', 'launcher']) {
      expect(isViewMode(gone), `畳んだはずの ${gone} が中央の面に戻っている`).toBe(false);
    }
  });

  it('表と型が 1 本(足したら両方に効く)', () => {
    // ⚠ `VIEW_MODES` は値の側、`ALL_VIEWS` は型の全数 ── 一致していること
    expect([...VIEW_MODES].sort()).toEqual([...ALL_VIEWS].sort());
  });

  /**
   * 🔴 **知らない値を state へ入れない**(変異試験 B3 が生き延びて判明)。
   * ⚠ 描く側は必ず実在の値を書くので、この枝は**製品でも test でも 1 度も
   *   通っていなかった** ── 「上流 1 行だけが守っていて、その 1 行を誰も
   *   試していない」形である(CLAUDE.md §2)。
   * 🔑 畳んだ面の名前を持つボタンが将来まぎれ込んでも、ここで止まる。
   */
  it('🔴 知らない data-pkc-view を押しても、面は動かない', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const before = d.getState().viewMode;

    const press = (view: string): void => {
      const btn = document.createElement('button');
      btn.setAttribute('data-pkc-action', 'set-view');
      btn.setAttribute('data-pkc-view', view);
      root.append(btn);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    };
    // ⚠ 空振り防止: **生きている面**は本当に開く(門が全部を止めていない)
    press('help');
    expect(d.getState().viewMode, '生きている面まで弾いている(空振り)').toBe('help');
    d.dispatch({ type: 'SET_VIEW_MODE', mode: before });

    for (const gone of ['filer', 'launcher', 'なにか']) {
      press(gone);
      expect(d.getState().viewMode, `知らない値「${gone}」が state に入った`).toBe(before);
    }
  });
});

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
      /**
       * ⚠ **中身まで見る**(2026-08-08、変異試験の指摘)── 見えているかだけ見て
       * いたので、render の分岐を消して**空の器**を出す変異が素通りした。
       */
      expect(
        shown[0]!.querySelector('[data-pkc-field="pane-title"]'),
        `${view} は器だけで中身が描かれていない`,
      ).not.toBeNull();
    } else {
      /**
       * 🔑 **逆向きも見る。** 集計と予定表(#673 段②)は自分の器、探し方
       * (`filer` / `launcher`)は**本文へ落ちる**(探し方は左の列が持つ)。
       * ⚠ ここを書かないと、`app-state.ts` の表にだけ足した面が素通りする。
       * ⚠ `center.ts` の `NOTE_PANES` と**同じ一覧を手で書く** ── 突合が目的なので
       *   向こうから import しない(食い違えばここで落ちる)。
       */
      const expected =
        view === 'query' || view === 'schedule' || view === 'contacts' || view === 'search'
          ? view
          : 'detail';
      expect(name, `${view} の落ち先が違う(app-state.ts の表に足し忘れ)`).toBe(expected);
    }
  });

  /**
   * 🔴 **ヘルプは共有の markdown の口で描く**(面ごとに worker を立てない)。
   * ⚠ 渡し忘れると素の原文表示に落ちるだけで**画面は成立して見える**ので、
   *   1 巡目は誰も見ていなかった(変異試験で判明)。常駐メモリの規律でもある。
   */
  it('🔴 ヘルプが、アプリ共有の markdown の口を使う', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const seen: string[] = [];
    const port = {
      render: (t: string) => {
        seen.push(t);
        return Promise.resolve('<p data-probe="1"></p>');
      },
    };
    const router = new CenterRouter(host, undefined, null, port as never);
    router.render(stateWith('help'));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen, 'ヘルプが共有の口を使っていない(面ごとに worker を立てる形)').toHaveLength(1);
    expect(host.querySelector('[data-probe="1"]'), '描いた結果が入っていない').not.toBeNull();
  });
});

/**
 * 🔴 **マニュアルの中を探す欄**(#636。user 指示 2026-08-31
 * 「**ヘルプにマニュアルの中を探すを置いて**」)。
 *
 * ⚠ 置き場を間違えると**静かに壊れる**ので、そこを重点的に留める:
 * ① 器の**中**に置くと `drawManual` の `innerHTML = …` で欄ごと消える
 * ② `built` ガードの**外**に置くと、`render()` が毎回走るので**打った字が消える**
 * ③ 本文を `hidden` で畳むと、その字が**ブラウザの Ctrl+F から見えなくなる**
 */
describe('マニュアルの中を探す(#636)', () => {
  let region: HTMLElement;
  beforeEach(() => {
    document.body.textContent = '';
    region = document.createElement('div');
    document.body.append(region);
  });

  const box = (): HTMLInputElement =>
    region.querySelector<HTMLInputElement>('[data-pkc-field="help-find"]')!;
  const countText = (): string =>
    region.querySelector('[data-pkc-field="help-find-count"]')?.textContent ?? '';
  const rows = (): HTMLElement[] => [
    ...region.querySelectorAll<HTMLElement>('[data-pkc-region="help-find-hits"] button'),
  ];
  const type = (s: string): void => {
    box().value = s;
    box().dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('🔴 欄が出て、打つと当たった節が並ぶ', () => {
    new HelpRenderer(region).render();
    expect(box(), '探す欄が無い').not.toBeNull();
    type('ルビ');
    expect(rows().length, '当たった節が 1 つも出ない').toBeGreaterThan(0);
    expect(countText(), '件数を出していない').toMatch(/か所/);
  });

  it('🔴 見つからないときは、次の一手を書く(「0 件」で終わらせない)', () => {
    new HelpRenderer(region).render();
    type('そんな語はどこにもありません');
    expect(rows().length).toBe(0);
    expect(countText(), '理由も次の一手も出ていない').toContain('別の言い方');
  });

  /** 🔴 ①器の中に置いていないか ── マニュアルを描き直しても欄が残る。 */
  it('🔴 マニュアルを描き直しても、欄と打った字が残る', async () => {
    const r = new HelpRenderer(region, {
      render: async () => '<h1>あ</h1><h2>い</h2>',
    });
    r.render();
    const before = box();
    type('ルビ');
    await Promise.resolve();
    await Promise.resolve();
    expect(box(), '描き直しで欄が作り直された(binder が押す寸前のボタンを捨てる)').toBe(before);
    expect(box().value, '打った字が消えた').toBe('ルビ');
  });

  /** 🔴 ②`built` ガードの外に置いていないか ── `render()` は開いている間毎回走る。 */
  it('🔴 面を描き直しても、打った字が消えない', () => {
    const r = new HelpRenderer(region);
    r.render();
    type('予定');
    const hits = rows().length;
    r.render();
    r.render();
    expect(box().value, 'render のたびに欄が組み直されている').toBe('予定');
    expect(rows().length, '結果まで消えている').toBe(hits);
  });

  it('⚠ Esc で打った字を消す(結果も消える)', () => {
    new HelpRenderer(region).render();
    type('予定');
    expect(rows().length).toBeGreaterThan(0);
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(box().value).toBe('');
    expect(rows().length, '結果が残っている').toBe(0);
    expect(countText(), '件数が残っている').toBe('');
  });

  /**
   * 🔴 ③**本文を畳まない**(user 指示②と衝突する)。
   * ⚠ 打つ前と打った後で、器の中の**字が 1 文字も減らない**ことを見る。
   */
  it('🔴 打っても、マニュアル本体は 1 文字も隠さない', () => {
    new HelpRenderer(region).render();
    const host = region.querySelector('[data-pkc-region="help-manual"]')!;
    const before = host.textContent ?? '';
    expect(before.length, '台の空振り(本文が空)').toBeGreaterThan(1000);
    type('ルビ');
    expect(host.textContent, 'マニュアル本体を畳んでいる ── ブラウザの検索から消える').toBe(
      before,
    );
    expect(
      host.querySelectorAll('[hidden]').length,
      '本文の一部を hidden にしている',
    ).toBe(0);
  });

  /** 🔴 押した行から、その節の見出しへ送る(飛び先は源文の通し番号)。 */
  it('🔴 行を押すと、その節の見出しへ送る', async () => {
    // ⚠ **実物の描画を通す** ── 見出しの数が源文と揃っていないと、
    //    「番号で飛ぶ」という主張そのものを見られない(3 本の作り物では空振り)
    const r = new HelpRenderer(region, { render: async (t) => renderMarkdown(t) });
    r.render();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const host = region.querySelector('[data-pkc-region="help-manual"]')!;
    const heads = [...host.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
    // ⚠ 空振り防止 ── 実物が描けていること(作り物 3 本では主張が立たない)
    expect(heads.length, 'マニュアルが描けていない(台の空振り)').toBeGreaterThan(50);
    const seen: HTMLElement[] = [];
    for (const h of heads)
      h.scrollIntoView = function (this: HTMLElement): void {
        seen.push(this);
      };
    type('ルビ');
    const row = rows()[0];
    expect(row, '押す行が無い').not.toBeUndefined();
    row!.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(seen.length, 'どの見出しへも送っていない(dead click)').toBeGreaterThan(0);
  });

  /**
   * 🔴 **描けなかったときも dead click にしない**(#636。着地前に自分で踏んだ)。
   *
   * ⚠ ワーカーが無い / 描画に失敗したときは `drawManual` が**素の原文**を出すので、
   *   `h1〜h6` が **0 本**になる ── 番号で飛ぶ実装をそのまま通すと、
   *   **並んだ行が全部 dead click** になり、理由も出ない。
   * 🔑 そのときは**行の比**で送る(正確ではないが、押した手応えは返る)。
   */
  it('🔴 マニュアルが素の原文で出ていても、押せば送る', async () => {
    // ⚠ markdown の口を渡さない = 素の原文の経路
    new HelpRenderer(region).render();
    const host = region.querySelector<HTMLElement>('[data-pkc-region="help-manual"]')!;
    expect(
      host.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      '台の前提が崩れている(素の原文なら見出しは 0 本)',
    ).toBe(0);
    // happy-dom は版面を組まないので、送り先を持てるように寸法を差す
    Object.defineProperty(host, 'scrollHeight', { value: 10_000, configurable: true });
    host.scrollTop = 0;
    type('ルビ');
    const row = rows()[0];
    expect(row, '押す行が無い').not.toBeUndefined();
    row!.click();
    // ⚠ 送るのは `manualReady` を待ってから ── 同期に見ると必ず 0 になる
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(host.scrollTop, '押しても 1px も動かない(dead click)').toBeGreaterThan(0);
  });

  /**
   * ⚠ **見出しを増やしていない**(`h3` の並びは別の test が等値 pin している)。
   * 🔑 ここは「増やしていない」を**この節の側からも**見る ── 増やした人が
   *   2 か所で気づける。
   */
  it('⚠ 探す欄のために見出しを増やしていない', () => {
    new HelpRenderer(region).render();
    expect([...region.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'マニュアル',
      'ショートカットキー',
      'これまでのお知らせ',
    ]);
  });
});

/**
 * 🔴 **面の中の目次**(#719。user 裁定 2026-09-06 = 案 A)。
 *
 * cowork 実測 2026-09-05:「本文 **106,339 字 / `scrollHeight` 5455px**、
 * **面の中のリンク 0 件**」── 10 万字を目次なしで探す形だった。
 *
 * ⚠ **飛び先が在る見出しだけ並べる**(無言の dead click を作らない)── 描画器が
 *   `id` を焼くのは h1〜h3 だけなので、h4 以下は行にしない。
 */
describe('ヘルプの面の目次(#719)', () => {
  it('🔴 目次の行が出て、押すとその見出しへ飛ぶ', async () => {
    const r = new HelpRenderer(region, { render: async (t) => renderMarkdown(t) });
    r.render();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const host = region.querySelector<HTMLElement>('[data-pkc-region="help-manual"]')!;
    // ⚠ 空振り防止 ── 実物が描けていること
    expect(
      host.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      'マニュアルが描けていない(台の空振り)',
    ).toBeGreaterThan(50);

    const rows = [...region.querySelectorAll<HTMLElement>('[data-pkc-field="help-toc-row"]')];
    expect(rows.length, '目次の行が 1 つも出ていない').toBeGreaterThan(10);

    /**
     * 🔴 **行の数 = `id` を持つ見出しの数**(等値)。
     * ⚠ 「1 つ以上」だと、**先頭 1 件だけ出す**実装でも緑になる。
     */
    const withId = [...host.querySelectorAll('h1[id], h2[id], h3[id]')];
    expect(rows.length, '目次の行と、飛び先のある見出しの数が合わない').toBe(withId.length);
    // ⚠ 対照群 ── `id` の無い見出しは行にしない(押しても飛べないので)
    expect(
      host.querySelectorAll('h4[id], h5[id], h6[id]').length,
      '前提が崩れている: h4 以下に id が焼かれている(目次の切り方を見直す)',
    ).toBe(0);

    // 押すと、その見出しへ飛ぶ
    const seen: HTMLElement[] = [];
    for (const h of withId)
      (h as HTMLElement).scrollIntoView = function (this: HTMLElement): void {
        seen.push(this);
      };
    rows[3]!.click();
    // ⚠ **押した後に待つ**(着地前レビュー・動線 2 の直しで、押した所は
    //    `manualReady` を待ってから飛ぶようになった ── 待たないと空振りになる)
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(seen, '押しても飛んでいない').toHaveLength(1);
    expect(seen[0], '押した行と違う見出しへ飛んだ').toBe(withId[3]);

    /**
     * 🔴 **行の字と段を、見出しと 1 本ずつ突き合わせる**(着地前レビュー・実装 ⚠-5)。
     * ⚠ 数だけ合わせていたので、変異試験で **3 件**が生き延びた:
     *   ①行の字を空にする ②`data-pkc-level` を落とす ③段をいつも `'1'` にする。
     *   ⚠ ①は「85 個の空のボタン」、②③は「85 行が平らな 1 枚の壁」になる
     *   (どちらも CSS の段付けが当たる先を失う)が、**数は 85 のままである**。
     */
    expect(
      rows.map((r) => r.textContent),
      '目次の字が、見出しの字と違う',
    ).toEqual(withId.map((h) => h.textContent));
    expect(
      rows.map((r) => r.getAttribute('data-pkc-level')),
      '目次の段が、見出しの段と違う(段付けの当たる先が消える)',
    ).toEqual(withId.map((h) => h.tagName.slice(1)));
    // ⚠ 空振り防止 ── 段が 1 種類しか出ていないなら、上の等値は何も見ていない
    expect(
      new Set(rows.map((r) => r.getAttribute('data-pkc-level'))).size,
      '前提が崩れている: 見出しの段が 1 種類しか無い(段付けを判定できない)',
    ).toBeGreaterThan(1);

    /**
     * 🔴 **数字で始まる見出しでも飛ぶ**(着地前レビュー ⚠-7 / 2 巡目)。
     *
     * ⚠ マニュアルの見出しは **85 本のうち 30 本**が `1-はじめる` のように数字で
     *   始まる。⚠ 1 稿目の実装は `` `#${CSS.escape(id)}` `` で選択子を組んでおり、
     *   **happy-dom は escape 済みの選択子を解決しない**ので、この 35% は
     *   **unit から 1 度も通せなかった**(守れるのは smoke 1 本だけ ── §2)。
     * 🔑 2 巡目で実装を**列挙 + id の突き合わせ**へ変えた(選択子を組まない)ので、
     *   ここで通せるようになった ── 壊れうる状態そのものが消えている(§7)。
     * ⚠ 上の `rows[3]` は**英字始まり**なので、そこだけでは通らない穴である。
     */
    const digits = withId.filter((h) => /^[0-9]/.test(h.id));
    expect(
      digits.length,
      '前提が崩れている: 数字で始まる見出しが 1 つも無い(この段は何も見ていない)',
    ).toBeGreaterThan(10);
    // ⚠ **いちばん後ろ**を採る ── 先頭は「上から 2 番目の見出し」で、
    //    前置きが縮んだ日に別の理由で落ちる(着地前レビュー 2 巡目・[軽] 6)
    const last = digits[digits.length - 1]!;
    const digitAt = withId.indexOf(last);
    seen.length = 0;
    rows[digitAt]!.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(seen, '数字で始まる見出しへ飛べていない(選択子を組み直した?)').toHaveLength(1);
    expect(seen[0], '数字で始まる行から別の見出しへ飛んだ').toBe(last);
  });

  /**
   * 🔴 **入れ直しても目次は同じ本数**(着地前レビュー・実装 ⚠-6)。
   *
   * ⚠ 5 分使わないと `dropManual()` が**本文だけ**捨てる(目次の行は残る)。
   *   開き直すと `drawManual` → `syncToc` が走るので、⚠ **前の 85 行を消さないと
   *   170 行に増える**(同じ見出しが 2 度並び、後半は押しても飛べない)。
   * ⚠ 既存の test は「1 度描いた直後」しか見ていないので、この経路を
   *   **1 度も通っていなかった**(`nav.textContent = ''` を消す変異が生き延びた)。
   */
  it('🔴 手放して開き直しても、目次は同じ本数のまま', async () => {
    // ⚠ **同じ時計を使う**(自前の甘い写しを作らない ── 上の docstring)
    const t = fakeTimers();
    const r = new HelpRenderer(
      region,
      { render: async (x) => renderMarkdown(x) },
      undefined,
      undefined,
      t.port,
      1000,
    );
    r.render('c1');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const count = (): number =>
      region.querySelectorAll('[data-pkc-field="help-toc-row"]').length;
    const first = count();
    expect(first, '目次が出ていない(空振り)').toBeGreaterThan(10);

    // 閉じて、しばらく開かないと本文だけ手放す
    r.onHidden();
    expect(t.pending(), '手放す予約をしていない(前提が崩れている)').toBe(1);
    t.fire();
    expect(
      region.querySelector('[data-pkc-region="help-manual"]')!.querySelectorAll('h2').length,
      '前提が崩れている: 本文を手放していない',
    ).toBe(0);

    /**
     * 🔴 **開き直した直後に押しても飛ぶ**(着地前レビュー 2 巡目・[重大] 1)。
     *
     * ⚠ 1 巡目の**動線 2** で `await this.manualReady` を足したのに、
     *   **その 1 行を守る検査が 1 つも無かった** ── 既存の目次 test は
     *   描き終えてから押すので、`.then` を外しても同じ結果になる(§2「通っていない」)。
     * 🔑 だから**描き終わる前に押す** ── 手放した直後の 250ms が、当の場面である。
     *   ⚠ ここで tick を回してから押すと、既存の test と同じで何も見ていない。
     */
    const jumped: HTMLElement[] = [];
    const orig = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement): void {
      jumped.push(this);
    };
    try {
      // 開き直す ── 目次は組み直されるが、**増えない**
      r.render('c1');
      // ⚠ 前提:この瞬間、本文はまだ空である(空でなければ、押しても当たり前に飛ぶ)
      expect(
        region.querySelector('[data-pkc-region="help-manual"]')!.querySelectorAll('h2').length,
        '前提が崩れている: 押す前にもう描き終わっている(待ちを判定できない)',
      ).toBe(0);
      region.querySelectorAll<HTMLElement>('[data-pkc-field="help-toc-row"]')[3]!.click();
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(count(), '開き直したら目次が増えた(同じ見出しが 2 度並ぶ)').toBe(first);
      expect(
        jumped,
        '開き直した直後に押したら、どこへも飛ばなかった(無言の dead click)',
      ).toHaveLength(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = orig;
    }
  });

  /**
   * 🔴 **これまでのお知らせは題名だけ並ぶ**(#719 案 A)。
   * ⚠ 直す前は 11 件の中身が全部開いたまま**面の先頭**に居た。
   */
  it('🔴 お知らせは畳まれて出て、押すと中身が開く', () => {
    new HelpRenderer(region).render();
    const items = [...region.querySelectorAll<HTMLDetailsElement>('[data-pkc-help-notice]')];
    expect(items.length, 'お知らせが 1 件も出ていない(空振り)').toBeGreaterThan(0);
    for (const it of items) {
      expect(it.tagName, 'お知らせが畳める形になっていない').toBe('DETAILS');
      expect(it.open, '最初から開いている(題名だけ並べる裁定に反する)').toBe(false);
      expect(
        it.querySelector('[data-pkc-field="notice-title"]')?.tagName,
        '題名が summary になっていない(押しても開かない)',
      ).toBe('SUMMARY');
      // ⚠ 中身は**在る**(畳んだのであって、落としたのではない)
      expect(it.querySelectorAll('li').length, 'お知らせの中身が落ちている').toBeGreaterThan(0);
    }
  });
  /**
   * 🔴 **押しても外側は動かさない**(着地前レビュー・動線 4、実測)。
   * ⚠ `scrollIntoView` は**スクロールできる祖先を全部**動かすので、外側まで動くと
   *   **目次が画面の外へ出る**(実測: 押す前 0 / 押した後 494)。
   */
  it('🔴 目次を押しても、外側の器はスクロールしない', async () => {
    const outer = document.createElement('div');
    outer.setAttribute('data-pkc-region', 'detail');
    document.body.append(outer);
    const host = document.createElement('div');
    outer.append(host);
    const r = new HelpRenderer(host, { render: async (t) => renderMarkdown(t) });
    r.render();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const rows = [...host.querySelectorAll<HTMLElement>('[data-pkc-field="help-toc-row"]')];
    expect(rows.length, '目次の行が出ていない(空振り)').toBeGreaterThan(3);
    // 台: `scrollIntoView` が外側を動かす実物のふるまいを真似る
    for (const h of host.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]'))
      h.scrollIntoView = function (this: HTMLElement): void {
        outer.scrollTop = 494;
      };
    outer.scrollTop = 0;
    rows[3]!.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(outer.scrollTop, '外側まで動いた(目次が画面の外へ出る)').toBe(0);
  });
});
