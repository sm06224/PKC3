/** @vitest-environment happy-dom */
/**
 * 🔴 **畳んだ章に追記したら、足した字が見える**(#596 B)。
 *
 * ## user の物語
 *
 * 20 章のノートの見出しを全部畳んで、目次のように読んでいる(畳みのいちばん自然な
 * 使い方)。「決定事項」を追記の入り先にして「A 案で決定」と打ち、「追記」を押す。
 * ⚠ 直す前は **本文に何も現れなかった** ── 描き直しのたびに `applyHeadingFold` が
 * 入った塊を `hidden` にするので、user から見ると**書いたものが消える**。
 * 🔴 二度押しして**二重に足す**恐れがある。
 *
 * ## 🔴 台は**実物の描画**から組む(着地前レビュー 🔴3③)
 *
 * ⚠ 1 稿目は `innerHTML` を手で書き、印(slug)を `listAppendTargets` から取っていた ──
 * つまり**実装と同じ綴りの別の写し**で、実装が間違える形では台も同じように間違える。
 * 🔑 ここは `renderMarkdown` を通す ── 刻印(`data-pkc-source-line` / `-end`)も
 * 見出しの `id` も**実物が焼いたもの**になる。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyHeadingFold, isHeadingFolded } from '../../src/adapter/ui/render/heading-fold';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { listAppendTargets } from '../../src/features/markdown/append-target';

/**
 * 🔴 **入れ子の章を持つ**(着地前レビュー 🔴2)── 入り先の節の末尾は、
 * その節の**中の深い見出し**の span の内側に落ちる。外側だけ開いても隠れたままになる。
 */
const BODY = [
  '## 決定事項',
  '',
  'いままでの中身',
  '',
  '### 補足',
  '',
  'こまかい話',
  '',
  '## つぎの章',
  '',
  'べつの中身',
  '',
].join('\n');

function rig(body = BODY, minTargets = 2) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  // 🔑 実物と同じ描画(刻印つき)
  host.innerHTML = renderMarkdown(body, { sourceLineAnchors: true });
  root.append(host);

  const slugs = listAppendTargets(body).map((t) => t.slug);
  expect(slugs.length, '入り先が引けていない(台の前提が崩れている)').toBeGreaterThanOrEqual(
    minTargets,
  );
  const sel = document.createElement('select');
  sel.setAttribute('data-pkc-field', 'append-target');
  for (const value of ['', ...slugs]) {
    const opt = document.createElement('option');
    opt.value = value;
    sel.append(opt);
  }
  root.append(sel);
  const input = document.createElement('textarea');
  input.setAttribute('data-pkc-field', 'append-input');
  root.append(input);
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', 'append-entry');
  root.append(btn);
  document.body.append(root);

  const d = new Dispatcher();
  bindActions(root, d, { showStatus: () => {} });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      {
        lid: 'n1',
        title: '章の在るノート',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      } as never,
    ],
    relations: [],
  });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  applyHeadingFold(host);
  const heads = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('h1,h2,h3')];
  return {
    root,
    host,
    d,
    sel,
    slugs,
    heads,
    /** 器の直下の塊(畳みの計算と同じ数え方)。 */
    blocks: (): HTMLElement[] => [...host.children] as HTMLElement[],
    foldAll: (): void => {
      for (const h of heads()) {
        const b = h.querySelector<HTMLElement>('[data-pkc-field="heading-fold"]');
        if (b !== null && !isHeadingFolded(h)) b.click();
      }
    },
    fold: (i: number): void => {
      heads()[i]!.querySelector<HTMLElement>('[data-pkc-field="heading-fold"]')!.click();
    },
    append: (text: string, slug: string): void => {
      root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value = text;
      sel.value = slug;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    /** ⚠ **入る所が見えるか** ── 入り先の節の**最後の塊**が hidden でないこと。 */
    lastBlockOfSectionHidden: (headingIdx: number): boolean => {
      const bs = [...host.children] as HTMLElement[];
      const start = bs.indexOf(heads()[headingIdx]!);
      let end = bs.length;
      const lv = Number(heads()[headingIdx]!.tagName.slice(1));
      for (let i = start + 1; i < bs.length; i += 1) {
        const m = /^H([1-6])$/.exec(bs[i]!.tagName);
        if (m !== null && Number(m[1]) <= lv) {
          end = i;
          break;
        }
      }
      return Boolean(bs[end - 1]!.hidden);
    },
  };
}

describe('畳んだ章への追記(#596 B)', () => {
  it('🔴 台の前提 ── 入れ子の章になっている', () => {
    const r = rig();
    expect(
      r.heads().map((h) => h.tagName),
      '入れ子になっていない(この台では #596 B の本命が見えない)',
    ).toEqual(['H2', 'H3', 'H2']);
  });

  it('🔴 全部畳んだ状態で追記すると、**入る所まで開く**(内側の畳みも)', () => {
    const r = rig();
    r.foldAll();
    expect(r.lastBlockOfSectionHidden(0), '畳めていない(台の前提が崩れている)').toBe(true);

    r.append('A 案で決定', r.slugs[0]!);

    expect(
      r.lastBlockOfSectionHidden(0),
      '追記したのに、入る所が畳みの中に隠れたまま(内側の畳みが開いていない)',
    ).toBe(false);
  });

  it('🔴 「末尾」に追記したときも、入る所まで開く', () => {
    const r = rig();
    r.foldAll();
    r.append('末尾へ', '');
    expect(
      r.lastBlockOfSectionHidden(2),
      '末尾へ追記したのに、いちばん後ろの章が畳んだまま',
    ).toBe(false);
  });

  it('🔴 **対照群** ── 入り先でない章は畳んだまま(何でも開く作りではない)', () => {
    const r = rig();
    r.foldAll();
    r.append('A 案で決定', r.slugs[0]!);
    expect(r.lastBlockOfSectionHidden(2), '関係のない章まで開いた').toBe(true);
  });

  /**
   * 🔴 **開いている章へ追記しても畳まない**(着地前レビュー 🔴3 の MUT-B)。
   * ⚠ 1 稿目の台にはこれが無く、`isHeadingFolded` の条件を外す変異が生き延びた ──
   * 実害は「開いている章に追記すると、その章が畳まれて足した字が消える」で、
   * **直したかった症状を逆向きに作る**。
   */
  it('🔴 開いている章に追記しても、畳まれない', () => {
    const r = rig();
    expect(r.lastBlockOfSectionHidden(0), '押す前から畳まれている').toBe(false);
    r.append('A 案で決定', r.slugs[0]!);
    expect(r.lastBlockOfSectionHidden(0), '開いていた章を畳んでしまった').toBe(false);
  });

  /**
   * 🔴 **印の綴りに頼っていない**(着地前レビュー 🔴1)。
   * ⚠ 入り先の印は**原文の行**から、描画側の `id` は**前処理を通った token** から作られる
   *   ── 同じ `makeSlugCounter` を使っていても**読む文字列が違う**。
   * 実測:setext の `決定事項` の下に `## 決定事項` が在ると、入り先の印は `決定事項` なのに
   *   描画側の `id` は `決定事項-1` になる ── 印で引くと**別の章が開く**。
   */
  it('🔴 印と描画の id がずれる本文でも、正しい章が開く', () => {
    const body = ['決定事項', '========', '', 'h1 の中身', '', '## 決定事項', '', 'h2 の中身', ''].join(
      '\n',
    );
    const r = rig(body, 1);
    // 台の前提 ── 綴りが実際にずれている
    const ids = r.heads().map((h) => h.getAttribute('id'));
    expect(ids, '綴りがずれていない(この台では 🔴1 が見えない)').toEqual([
      '決定事項',
      '決定事項-1',
    ]);
    expect(r.slugs, '入り先は ATX の 1 件だけのはず').toEqual(['決定事項']);

    r.foldAll();
    r.append('ここへ', r.slugs[0]!);
    // 🔑 開くべきは **h2 の章**(入り先)── h1 のほうではない
    expect(r.lastBlockOfSectionHidden(1), '入り先(h2)の章が開いていない').toBe(false);
  });

  /**
   * 🔴 **frontmatter があるとき、行がずれる**(変異 Q6 が生き延びて分かった)。
   * ⚠ 入り先の一覧は**原文**の行で数えるが、描く面は **frontmatter を剥がした側**を見ている。
   *   ずらさないと、器の中で 1 つ手前の塊を掴む。
   */
  it('🔴 frontmatter がある本文でも、正しい章が開く', () => {
    const body = [
      '---',
      'tags: [会議]',
      '---',
      '',
      '## 決定事項',
      '',
      'いままでの中身',
      '',
      '## つぎの章',
      '',
      'べつの中身',
      '',
    ].join('\n');
    const r = rig(body);
    r.foldAll();
    r.append('A 案で決定', r.slugs[0]!);
    expect(r.lastBlockOfSectionHidden(0), '入り先の章が開いていない(行がずれている)').toBe(false);
    expect(r.lastBlockOfSectionHidden(1), '関係のない章まで開いた').toBe(true);
  });
});
