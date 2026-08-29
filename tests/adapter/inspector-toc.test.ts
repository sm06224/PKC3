/** @vitest-environment happy-dom */
/**
 * 🔴 **見出しから自動で作る目次**(#493)。
 *
 * > user 報告 2026-08-27:「**自動で見出しから生成された TOC が PKC2 にはあるけど、
 * > PKC3 にはない**」
 *
 * ## ⚠ 「無い」ではなく「手で書かないと出ない」だった
 *
 * 材料は全部在った ── `extractHeadingsFromMarkdown` も、h1〜h3 への id 刻みも。
 * ⚠ しかも `markdown-render.ts` の id を刻む節には「**right-pane の目次が
 * 飛べるように**」と書いてあり、**受け手だけが未実装**だった。
 *
 * ## 🔑 置き場は「好み」ではなく PKC2 の実装が答えを持っていた
 *
 * PKC2 は meta ペイン(= 右の列)に置き、**見出しが 0 件なら丸ごと出さない**
 * (`renderer.ts:9056` / `docs/development/table-of-contents-right-pane.md`)。
 * user が既に知っている絵に揃える。
 *
 * ## 🔴 守る主張
 *
 * 1. 見出しが在れば**その順・その深さ**で並ぶ
 * 2. 🔴 **0 件なら行ごと畳む**(`<dt>` も一緒に ── 見出しだけ残さない)
 * 3. 🔴 押すと**本文のその見出し**へ飛ぶ(別の面の同じ id へ飛ばない)
 * 4. 🔴 飛び先が無い回は**理由を出す**(無言の dead click を作らない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { extractHeadingsFromMarkdown } from '../../src/features/markdown/markdown-toc';

function meta(lid: string): EntryMeta {
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
  };
}

const BODY = ['# 第 1 章', '本文', '## 節 A', 'あ', '### 細目', 'い', '# 第 2 章', 'う'].join('\n');

beforeEach(() => {
  document.body.textContent = '';
});

function setup(body: string | null) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => inspector.render(s));
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  if (body !== null) d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  return { root, d };
}

/**
 * 🔴 **押した後は 1 tick 待つ**(#517)。
 *
 * ⚠ `toc-jump` は **async** になった(本文が描けるのを待ってから探すため)ので、
 *   同期の `it` から `click()` しただけでは**まだ何も起きていない** ──
 *   assert は走るが実装がそこへ到達しておらず、**押しても飛ばない実装でも緑**になる
 *   (CLAUDE.md §1「async にした瞬間、それを呼ぶ同期の test は全部空振りになる」)。
 * 🔑 だから `click()` の後は必ずここを通す。
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const links = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-pkc-action="toc-jump"]'),
];
const tocRow = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="inspector-toc"]')!;

describe('目次(#493)', () => {
  it('🔴 見出しがその順・その深さで並ぶ', () => {
    const { root } = setup(BODY);
    expect(
      links(root).map((b) => b.textContent),
      '目次が出ていない',
    ).toEqual(['第 1 章', '節 A', '細目', '第 2 章']);
    expect(
      links(root).map((b) => b.parentElement?.getAttribute('data-pkc-toc-level')),
      '深さが出ていない(字下げできない)',
    ).toEqual(['1', '2', '3', '1']);
  });

  /**
   * 🔑 **印は本文の id と同じ綴りでなければ飛べない。**
   * ⚠ ここで綴りを書き写すと、実装が変わっても test が気づかない ──
   *   **features の 1 か所**から採って突き合わせる。
   */
  it('🔴 押す先の印が、本文に刻まれる id と同じ綴り', () => {
    const { root } = setup(BODY);
    expect(links(root).map((b) => b.getAttribute('data-pkc-toc-slug'))).toEqual(
      extractHeadingsFromMarkdown(BODY).map((h) => h.slug),
    );
  });

  it('🔴 見出しが無いノートでは行ごと畳む(見出しだけ残さない)', () => {
    const { root } = setup('本文だけ\n');
    const dd = tocRow(root);
    expect(dd.hidden, '見出しが無いのに目次の行が出ている').toBe(true);
    expect(
      (dd.previousElementSibling as HTMLElement).hidden,
      '値だけ畳んで「目次」の見出しが残っている',
    ).toBe(true);
  });

  it('本文が読めていないときも出さない', () => {
    const { root } = setup(null);
    expect(tocRow(root).hidden).toBe(true);
  });

  /** ⚠ 直したら戻ること(状態が残らない)── 見出しを足せば出る。 */
  it('🔴 見出しを足せばその場で出る', () => {
    const { root, d } = setup('本文だけ\n');
    expect(tocRow(root).hidden).toBe(true);
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '# 章\n本文\n' });
    expect(tocRow(root).hidden, '足したのに出ない').toBe(false);
    expect(links(root).map((b) => b.textContent)).toEqual(['章']);
  });
});

describe('目次を押すと本文へ飛ぶ(#493)', () => {
  /** 本文の面に、描かれた見出しを置く(実物と同じ id の刻み方)。 */
  function plantBody(root: HTMLElement, slugs: string[]): HTMLElement[] {
    const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    const made: HTMLElement[] = [];
    for (const s of slugs) {
      const h = document.createElement('h1');
      h.id = s;
      h.scrollIntoView = vi.fn();
      detail.append(h);
      made.push(h);
    }
    return made;
  }

  it('🔴 本文のその見出しへ飛ぶ', async () => {
    const { root } = setup(BODY);
    const slugs = extractHeadingsFromMarkdown(BODY).map((h) => h.slug);
    const planted = plantBody(root, slugs);
    links(root)[2]!.click();
    await settle();
    expect(planted[2]!.scrollIntoView, '押した見出しへ飛んでいない').toHaveBeenCalled();
    expect(planted[0]!.scrollIntoView, '別の見出しへ飛んだ').not.toHaveBeenCalled();
  });

  /**
   * 🔴 **別の面の同じ id へ飛ばない**(#493)。
   *
   * ⚠ マニュアルもヘルプも**同じ `makeSlugCounter`** で id を刻むので、
   *   `getElementById` で引くと**本文ではないほう**に当たりうる。
   *   2026-08-08 に「id の重複 0 件」という守れない条件を書いて踏んだ場所である。
   */
  it('🔴 同じ id が別の面にも在るとき、本文のほうへ飛ぶ', async () => {
    const { root } = setup(BODY);
    const slug = extractHeadingsFromMarkdown(BODY)[0]!.slug;
    // ⚠ **本文より先に**別の面へ置く(`getElementById` は先頭を返す)
    const other = document.createElement('h1');
    other.id = slug;
    other.scrollIntoView = vi.fn();
    root.querySelector('[data-pkc-region="inspector"]')!.prepend(other);
    const planted = plantBody(root, [slug]);
    links(root)[0]!.click();
    await settle();
    expect(planted[0]!.scrollIntoView, '本文へ飛んでいない').toHaveBeenCalled();
    expect(other.scrollIntoView, '別の面の同じ id へ飛んだ').not.toHaveBeenCalled();
  });

  /**
   * 🔴 **飛び先が無い回は理由を出す**(1 面の編集中は本文が描かれていない)。
   * ⚠ 黙ると「押しても何も起きない」になる(#300 の型)。
   */
  it('🔴 本文が描かれていなければ理由を出す(無言にしない)', async () => {
    const { root, d } = setup(BODY);
    links(root)[0]!.click();
    await settle();
    // ⚠ 編集していないのに「編集中は…」と出さない(レビュー指摘 ── 文言は phase で分ける)
    expect(d.getState().error ?? '', '押しても何も起きない').toContain('まだ出ていません');
    expect(d.getState().error ?? '', '編集していないのに編集の断り文が出た').not.toContain(
      '編集中',
    );
  });

  it('🔴 編集中は「編集中だから」と言う(1 面の編集では本文が描かれていない)', async () => {
    const { root, d } = setup(BODY);
    d.dispatch({ type: 'START_EDIT' });
    links(root)[0]!.click();
    await settle();
    expect(d.getState().error ?? '', '押しても何も起きない').toContain('編集中');
  });

  /**
   * 🔴 **畳んだ章の中の見出しへは、開いてから飛ぶ**(#514)。
   *
   * ⚠ 直す前は hit が**見つかる**(querySelectorAll は hidden も拾う)のに
   *   display:none の要素への `scrollIntoView` が no-op ── 断りの分岐にも
   *   入らず、**無言の dead click** だった。
   */
  it('🔴 畳んだ章の中の見出しへは、開いてから飛ぶ(#514)', async () => {
    const { root } = setup(BODY);
    const slugs = extractHeadingsFromMarkdown(BODY).map((h) => h.slug);
    const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    // 実物の畳みと同じ形を作る: h1 が data-pkc-folded、配下の塊が hidden
    const chapter = document.createElement('h1');
    chapter.id = slugs[0]!;
    chapter.setAttribute('data-pkc-folded', '');
    chapter.scrollIntoView = vi.fn();
    const para = document.createElement('p');
    para.hidden = true;
    const section = document.createElement('h2');
    section.id = slugs[1]!;
    section.hidden = true;
    section.scrollIntoView = vi.fn();
    detail.append(chapter, para, section);

    links(root)[1]!.click();
    await settle();

    expect(section.hidden, '開いていない(hidden のままでは飛べない)').toBe(false);
    expect(section.scrollIntoView, '飛んでいない').toHaveBeenCalled();
    expect(
      chapter.hasAttribute('data-pkc-folded'),
      '畳みの印が残っている(次の描画でまた隠れる)',
    ).toBe(false);
  });

  /**
   * 🔴 **本文以外の面を開いたままなら、本文の面へ戻ってから飛ぶ**(#514)。
   *
   * ⚠ 面は hidden で常駐する(center.ts)ので hit は見つかるが、
   *   隠れた面の中では `scrollIntoView` が no-op ── 無言の dead click だった。
   */
  it('🔴 本文以外の面を開いたままなら、本文の面へ戻ってから飛ぶ(#514)', async () => {
    const { root, d } = setup(BODY);
    const slugs = extractHeadingsFromMarkdown(BODY).map((h) => h.slug);
    const planted = plantBody(root, slugs);
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' });

    links(root)[0]!.click();
    await settle();

    expect(d.getState().viewMode, '本文の面へ戻っていない').toBe('detail');
    expect(planted[0]!.scrollIntoView, '飛んでいない').toHaveBeenCalled();
  });

  /**
   * 🔴 **本文の面に居るときは、面の切替を撃たない**(レビュー指摘)。
   * `SET_VIEW_MODE` は履歴・ゴミ箱の panel を畳む副作用を持つ ──
   * 無条件に撃つと**目次を押しただけで履歴の一覧が閉じる**。
   */
  it('🔴 本文の面で押したときは面の切替を撃たない(履歴の一覧が閉じない)', async () => {
    const { root, d } = setup(BODY);
    const slugs = extractHeadingsFromMarkdown(BODY).map((h) => h.slug);
    const planted = plantBody(root, slugs);
    // ⚠ SHOW_HISTORY は一覧の**要求**しか出さない(effect 層が引く)── ここは
    //   effect を繋がない台なので、届いた形(REVISION_LIST_LOADED)を直接入れる
    d.dispatch({ type: 'REVISION_LIST_LOADED', lid: 'n1', items: [] });
    expect(d.getState().revisionPanel, '前提が崩れている(履歴が開いていない)').not.toBeNull();

    links(root)[0]!.click();
    await settle();

    expect(planted[0]!.scrollIntoView, '飛んでいない').toHaveBeenCalled();
    expect(d.getState().revisionPanel, '目次を押しただけで履歴が閉じた').not.toBeNull();
  });

  /**
   * 🔴 **囲み(`:::`)の中の見出しでも、外の畳みを開いて飛ぶ**(レビュー指摘)。
   * ⚠ 畳みを管理する器は **`detail-body`**(#598)── `hit.parentElement`(囲みの section)を
   *   渡すと外の畳みに届かず、#514 の無言がそのまま残る。
   */
  it('🔴 囲みの中の見出しでも、外の畳みを開いて飛ぶ', async () => {
    const { root } = setup(BODY);
    const slugs = extractHeadingsFromMarkdown(BODY).map((h) => h.slug);
    const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    // 実物と同じ器(detail-body-host)の中に、畳んだ章と、囲みに包まれた節を置く
    const host = document.createElement('div');
    // 🔴 **実物と同じ綴り**(#598)── 骨組みは `-host` を付けるが、markdown を
    //    描いた瞬間に `detail-body` へ**上書きされる**。台が `-host` のままだと、
    //    実装が本文の面で器を外していても**緑になる**(実際に外していた)。
    host.setAttribute('data-pkc-field', 'detail-body');
    // ⚠ この台は「本文が描き終わっている」形なので、**描けた印も付ける**(#517)──
    //    付けないと `waitPainted` が期限まで待ち、この test が別の理由で落ちる
    host.setAttribute('data-pkc-painted', 'n1');
    const chapter = document.createElement('h1');
    chapter.id = slugs[0]!;
    chapter.setAttribute('data-pkc-folded', '');
    chapter.scrollIntoView = vi.fn();
    const wrap = document.createElement('section');
    wrap.hidden = true; // 章の畳みが囲みごと隠している形
    const section = document.createElement('h2');
    section.id = slugs[1]!;
    section.scrollIntoView = vi.fn();
    wrap.append(section);
    host.append(chapter, wrap);
    detail.append(host);

    links(root)[1]!.click();
    await settle();

    expect(wrap.hidden, '囲みが開いていない(外の畳みに届いていない)').toBe(false);
    expect(section.scrollIntoView, '飛んでいない').toHaveBeenCalled();
    expect(chapter.hasAttribute('data-pkc-folded'), '畳みの印が残っている').toBe(false);
  });
});

/**
 * 🔴 **描き直しの途中でも、1 回の押しで届く**(#517)。
 *
 * ⚠ 本文の描画は worker の promise 越しなので、面を戻した直後は見出しが DOM に
 *   無い ── 直す前はそこで「もう一度押してください」と断っていた
 *   (**同じ押しを 2 回させる動線**)。
 * 🔑 待つのは `data-pkc-painted` が今の lid になること。
 */
describe('描き直しを待ってから飛ぶ(#517)', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function withHost(root: HTMLElement, slug: string, painted: string | null) {
    const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    const host = document.createElement('div');
    // 🔴 **実物と同じ綴り**(#598)── 骨組みは `-host` を付けるが、markdown を
    //    描いた瞬間に `detail-body` へ**上書きされる**。台が `-host` のままだと、
    //    実装が本文の面で器を外していても**緑になる**(実際に外していた)。
    host.setAttribute('data-pkc-field', 'detail-body');
    if (painted !== null) host.setAttribute('data-pkc-painted', painted);
    const h = document.createElement('h1');
    h.id = slug;
    h.scrollIntoView = vi.fn();
    host.append(h);
    detail.append(host);
    return { host, h };
  }

  it('🔴 印がまだ来ていなければ待ち、来た瞬間に 1 回の押しで飛ぶ', async () => {
    const { root } = setup(BODY);
    const slug = extractHeadingsFromMarkdown(BODY)[0]!.slug;
    const { host, h } = withHost(root, slug, null); // 描き直しの最中
    root.querySelectorAll<HTMLElement>('[data-pkc-action="toc-jump"]')[0]!.click();
    await settle();
    expect(h.scrollIntoView, '描けていないのに飛んだ').not.toHaveBeenCalled();
    // 本文が描き終わった
    host.setAttribute('data-pkc-painted', 'n1');
    await settle();
    expect(h.scrollIntoView, '描けたのに飛ばない(2 回押させている)').toHaveBeenCalled();
  });

  it('⚠ 対照群 ── 既に描けているときは待たない(よくある道を遅くしない)', async () => {
    const { root } = setup(BODY);
    const slug = extractHeadingsFromMarkdown(BODY)[0]!.slug;
    const { h } = withHost(root, slug, 'n1');
    root.querySelectorAll<HTMLElement>('[data-pkc-action="toc-jump"]')[0]!.click();
    await settle();
    expect(h.scrollIntoView, '描けているのに待った').toHaveBeenCalled();
  });

  it('🔴 印が来ないままでも、期限で断り文が出る(永久に待たない)', async () => {
    vi.useFakeTimers();
    try {
      const { root, d } = setup(BODY);
      const slug = extractHeadingsFromMarkdown(BODY)[0]!.slug;
      withHost(root, slug, null);
      // ⚠ **見出しは消しておく** ── 期限切れの後に「見つからない」へ落ちることを見る
      root.querySelector(`#${CSS.escape(slug)}`)!.remove();
      root.querySelectorAll<HTMLElement>('[data-pkc-action="toc-jump"]')[0]!.click();
      await vi.advanceTimersByTimeAsync(1000);
      expect(d.getState().error ?? '', '期限で断らず、黙って止まった').toContain(
        'まだ出ていません',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
