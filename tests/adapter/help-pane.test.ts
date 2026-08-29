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
  NOTICE_SHOW_MAX,
  noticeDate,
} from '../../src/features/notice/notice-log';

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

  /** ⚠ 見出しが無いと、版の行とお知らせが地続きに見える。 */
  it('⚠ 「これまでのお知らせ」と「マニュアル」の見出しが出る', () => {
    new HelpRenderer(region).render();
    const heads = [...region.querySelectorAll('h3')].map((e) => e.textContent);
    expect(heads, '見出しが足りない').toEqual(['これまでのお知らせ', 'ショートカットキー', 'マニュアル']);
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

  /** 手で進められる時計(⚠ 実時間を待つ test は書けない)。 */
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
       * 🔑 **逆向きも見る。** 集計は自分の器、探し方(`filer` / `launcher` /
       * `schedule`)は**本文へ落ちる**(探し方は左の列が持つ)。
       * ⚠ ここを書かないと、`app-state.ts` の表にだけ足した面が素通りする。
       */
      const expected = view === 'query' ? view : 'detail';
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
