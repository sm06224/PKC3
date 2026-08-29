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
 * しかも気づく手掛かりは追記欄の横の「元に戻す」だけで、本文を見ている人は見ていない。
 * 🔴 二度押しして**二重に足す**恐れがある。
 *
 * 🔑 #514(目次から飛ぶ前に覆っている畳みを開く)の**追記版**である。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyHeadingFold, isHeadingFolded } from '../../src/adapter/ui/render/heading-fold';
import { listAppendTargets } from '../../src/features/markdown/append-target';

const BODY = ['## 決定事項', '', 'いままでの中身', '', '## つぎの章', '', 'べつの中身', ''].join(
  '\n',
);

function rig() {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  /**
   * ⚠ **印は製品と同じ関数から引く**(`listAppendTargets`)── 見出しの `id` は
   * `makeSlugCounter` で作られ、入り先の印と**同じ綴り**である
   * (`append-target.ts` の `AppendTarget` に明記)。手で書くと、綴りの作り方が
   * 変わった日に**この test だけ**が古い印を持つ。
   */
  const slugs = listAppendTargets(BODY).map((t) => t.slug);
  expect(slugs.length, '見出しの印が引けていない(前提が崩れている)').toBe(2);
  host.innerHTML =
    `<h2 data-pkc-source-line="0" id="${slugs[0]}">決定事項</h2>` +
    '<p data-pkc-source-line="2" id="p-a">いままでの中身</p>' +
    `<h2 data-pkc-source-line="4" id="${slugs[1]}">つぎの章</h2>` +
    '<p data-pkc-source-line="6" id="p-b">べつの中身</p>';
  root.append(host);

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
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BODY });
  // 🔑 畳みの押し口と span を実物と同じ形で当てる
  applyHeadingFold(host);
  return {
    root,
    host,
    d,
    sel,
    input,
    slugs,
    head: (i: number) => host.querySelector(`#${slugs[i]}`)!,
    fold: (i: number): void => {
      host.querySelector<HTMLElement>(`#${slugs[i]} [data-pkc-field="heading-fold"]`)!.click();
    },
    append: (text: string, slug: string): void => {
      input.value = text;
      sel.value = slug;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    },
  };
}

describe('畳んだ章への追記(#596 B)', () => {
  it('🔴 入り先の章が畳んでいたら、追記の前に開く', () => {
    const r = rig();
    r.fold(0);
    expect(isHeadingFolded(r.head(0)), '畳めていない(前提が崩れている)').toBe(true);
    expect((r.host.querySelector('#p-a') as HTMLElement).hidden, '中身が隠れていない').toBe(true);

    r.append('A 案で決定', r.slugs[0]!);

    expect(isHeadingFolded(r.head(0)), '追記したのに章が畳んだまま').toBe(false);
    expect(
      (r.host.querySelector('#p-a') as HTMLElement).hidden,
      '追記したのに中身が隠れたまま',
    ).toBe(false);
  });

  it('🔴 「末尾」に追記したときは、**いちばん後ろの章**が開く', () => {
    const r = rig();
    r.fold(1);
    expect(isHeadingFolded(r.head(1)), '畳めていない(前提が崩れている)').toBe(true);
    r.append('末尾へ', '');
    expect(isHeadingFolded(r.head(1)), '末尾へ追記したのに最後の章が畳んだまま').toBe(false);
  });

  it('🔴 **対照群** ── 入り先でない章は畳んだまま(何でも開く作りではない)', () => {
    const r = rig();
    r.fold(0);
    r.fold(1);
    r.append('A 案で決定', r.slugs[0]!);
    expect(isHeadingFolded(r.head(0)), '入り先が開いていない').toBe(false);
    expect(isHeadingFolded(r.head(1)), '関係のない章まで開いた').toBe(true);
  });

  it('⚠ 追記しなければ、畳みは動かない', () => {
    const r = rig();
    r.fold(0);
    expect(isHeadingFolded(r.head(0))).toBe(true);
    // ⚠ 押していないので何も起きない
    expect(isHeadingFolded(r.head(0)), '押していないのに開いた').toBe(true);
  });
});
