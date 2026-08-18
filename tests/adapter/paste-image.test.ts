/** @vitest-environment happy-dom */
/**
 * 🔴 **スクショの貼付**(#250。user 指示 2026-08-18「PKC3 でスクショ貼付の導線が
 * ない。PKC2 と同様以上に実装してください」)。
 *
 * ⚠ ここが守るのは **3 つの分かれ道**である。どれも黙って壊れる形を持つ:
 * ① 編集中の本文へ貼った → **資産にして参照を差し込む**(ノートは作らない)
 * ② それ以外へ貼った → **添付として取り込む**
 * ③ 画像が無い → **何もしない**(⚠ `preventDefault` すると**文字の貼付が死ぬ**)
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';

/** clipboard を持つ paste event を作る(happy-dom に `ClipboardEvent` の実体は無い)。 */
function pasteEvent(
  items: { kind: string; type: string; file?: File | null }[],
): Event & { defaultPrevented: boolean } {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: {
      items: items.map((it) => ({ kind: it.kind, type: it.type, getAsFile: () => it.file ?? null })),
    },
  });
  return e as Event & { defaultPrevented: boolean };
}

/** file を持つ drop / dragover event を作る(happy-dom に `DragEvent` の実体は無い)。 */
function dragEvent(
  type: 'drop' | 'dragover',
  files: File[],
  types: string[] = ['Files'],
): Event & { defaultPrevented: boolean } {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types,
      dropEffect: 'none',
      files: { length: files.length, item: (i: number) => files[i] ?? null },
      items: [],
    },
  });
  return e as Event & { defaultPrevented: boolean };
}

const png = (name = 'x.png'): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });

/** 本文の面(detail)と、その外側の面を 1 つずつ持つ器。 */
function setup(over: Partial<BinderServices> = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>' +
    // ⚠ 継ぎ足しの欄は **detail 面の外**(`shell.ts` で兄弟)── 面で判定すると
    //    ここだけ落ちる。器もそのとおりに組む
    '<div data-pkc-region="append"><textarea data-pkc-field="append-input"></textarea></div>' +
    '<div data-pkc-region="entry-list"><input data-pkc-field="find" /></div>';
  document.body.append(root);
  const calls = { paste: [] as (readonly File[])[], attach: [] as File[][] };
  const services: BinderServices = {
    attachFiles: (files) => calls.attach.push(files),
    pasteImages: async (files) => {
      calls.paste.push(files);
      return files.map((_, i) => `![ず](asset:k${i + 1})`);
    },
    ...over,
  };
  const dispatcher = new Dispatcher();
  bindActions(root, dispatcher, services);
  const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
  const append = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!;
  const outside = root.querySelector('input')!;
  return { root, ta, append, outside, calls, dispatcher };
}

describe('スクショの貼付(#250)', () => {
  it('🔴 編集中の本文へ貼ると、資産にして**参照が差し込まれる**', async () => {
    const { ta, calls } = setup();
    ta.value = 'まえ';
    ta.selectionStart = 3;
    ta.selectionEnd = 3;
    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '既定の貼付を止めていない').toBe(true);
    await vi.waitFor(() => expect(ta.value).toContain('asset:k1'));
    // ⚠ **添付(ノート作成)には行かない** ── 編集中は CREATE_ENTRY が黙殺される
    expect(calls.attach, '編集中に添付へ回している').toHaveLength(0);
    expect(calls.paste[0], '画像が渡っていない').toHaveLength(1);
  });

  it('🔴 本文の外へ貼ると、**添付として**取り込む', () => {
    const { outside, calls } = setup();
    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]);
    outside.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(calls.attach, '添付へ行っていない').toHaveLength(1);
    expect(calls.paste, '本文の外なのに差し込んでいる').toHaveLength(0);
  });

  it('🔴 **継ぎ足しの欄**へ貼っても差し込まれる(面の外に在る)', async () => {
    // ⚠ 1 巡目は「detail 面の中の textarea か」で判定していたので、**ここだけ
    //    添付に落ちていた**(PKC2 は欄の名前で見ていて、継ぎ足しにも貼れた)
    const { append, calls } = setup();
    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]);
    append.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(append.value).toContain('asset:k1'));
    expect(calls.attach, '継ぎ足しなのに添付へ回している').toHaveLength(0);
  });

  it('🔴 画像が無ければ**何もしない**(文字の貼付を殺さない)', () => {
    const { ta, calls } = setup();
    const e = pasteEvent([{ kind: 'string', type: 'text/plain' }]);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '文字の貼付を止めている').toBe(false);
    expect(calls.paste).toHaveLength(0);
    expect(calls.attach).toHaveLength(0);
  });

  it('🔑 クリップボードの画像を**全部**拾う(PKC2 は先頭 1 枚だけだった)', async () => {
    const { ta, calls } = setup();
    const e = pasteEvent([
      { kind: 'file', type: 'image/png', file: png('a.png') },
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/webp', file: png('b.webp') },
    ]);
    ta.dispatchEvent(e);
    await vi.waitFor(() => expect(ta.value).toContain('asset:k2'));
    expect(calls.paste[0], '2 枚目を落としている').toHaveLength(2);
  });

  it('⚠ 画像を取り出せない項目は飛ばす(null で落ちない)', () => {
    const { ta, calls } = setup();
    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: null }]);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '取り出せないのに既定を止めている').toBe(false);
    expect(calls.paste).toHaveLength(0);
  });

  it('🔴 待っている間に編集欄が作り直されても、**いま在る欄**へ差す', async () => {
    const { root, ta } = setup();
    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]);
    ta.dispatchEvent(e);
    // ⚠ live の面は行を組み直す ── 掴んだままの textarea は**外れる**
    const host = root.querySelector('[data-pkc-region="detail"]')!;
    ta.remove();
    const fresh = document.createElement('textarea');
    fresh.setAttribute('data-pkc-field', 'row-source');
    host.append(fresh);
    await vi.waitFor(() => expect(fresh.value).toContain('asset:k1'));
    expect(ta.value, '外れた欄のほうへ書いている').toBe('');
  });

  it('🔴 編集を抜けたあとに差し先が消えていたら、**添付へ回す**', async () => {
    const { root, ta, dispatcher, calls } = setup();
    dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    expect(dispatcher.getState().error, '前提: まだ何も出ていない').toBeNull();
    expect(dispatcher.getState().phase, '前提: 編集していない').toBe('ready');
    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]);
    ta.dispatchEvent(e);
    // ⚠ 編集そのものが閉じた ── 差す先がどこにも無い
    root.querySelector('[data-pkc-region="detail"]')!.remove();
    await vi.waitFor(() => expect(calls.attach, '貼った画像を捨てている').toHaveLength(1));
    // 🔑 行き先を**言う**(黙って添付にすると「貼ったのに出ない」に見える)
    expect(dispatcher.getState().error).toContain('添付にしました');
  });

  it('🔴 まだ編集中なら添付にはせず、**やり直せる形で断る**', async () => {
    // ⚠ 1 面の編集は別の欄を触った瞬間に行を閉じるが、**ノートの編集は続いている**
    //   ── そこで `CREATE_ENTRY` を撃っても reducer が黙殺する(bytes だけ残る)
    const { root, ta, dispatcher, calls } = setup();
    dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    dispatcher.dispatch({ type: 'CREATE_ENTRY', lid: 'e1', archetype: 'text', title: 'n' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '' });
    dispatcher.dispatch({ type: 'START_EDIT' });
    expect(dispatcher.getState().phase, '前提: 編集中になっていない').toBe('editing');

    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]);
    ta.dispatchEvent(e);
    root.querySelector('[data-pkc-region="detail"]')!.remove();
    await vi.waitFor(() =>
      expect(dispatcher.getState().error).toContain('もう一度貼ってください'),
    );
    expect(calls.attach, '編集中なのに添付へ回した(黙殺されて bytes だけ残る)').toHaveLength(0);
  });

  it('⚠ 受け手がどこにも無ければ**既定を止めない**(文字の貼付まで殺さない)', () => {
    const { ta } = setup({ pasteImages: undefined, attachFiles: undefined });
    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '受け手が無いのに既定を止めている').toBe(false);
  });

  it('🔴 本文へ**落とした**画像も、貼付と同じく差し込まれる(#250)', async () => {
    const { ta, calls } = setup();
    const e = dragEvent('drop', [png()]);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '既定の drop(画面ごと遷移)を止めていない').toBe(true);
    await vi.waitFor(() => expect(ta.value).toContain('asset:k1'));
    expect(calls.attach, '本文へ落としたのに添付へ回している').toHaveLength(0);
  });

  it('🔴 画像**以外**を落としたら添付へ(本文には差さない)', () => {
    const { ta, calls } = setup();
    const pdf = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    ta.dispatchEvent(dragEvent('drop', [pdf]));
    expect(calls.attach[0], '添付へ行っていない').toHaveLength(1);
    expect(calls.paste, '画像でないものを本文へ差している').toHaveLength(0);
  });

  it('🔴 混ざって落ちたら、**画像は本文へ・残りは添付へ**', async () => {
    const { ta, calls } = setup();
    const pdf = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    ta.dispatchEvent(dragEvent('drop', [png(), pdf]));
    await vi.waitFor(() => expect(ta.value).toContain('asset:k1'));
    expect(calls.paste[0], '画像が本文へ行っていない').toHaveLength(1);
    expect(calls.attach[0], '画像以外が添付へ行っていない').toHaveLength(1);
    expect(calls.attach[0]![0]!.name).toBe('a.pdf');
  });

  it('🔴 file の `dragover` は止める ── 止めないと `drop` が来ない', () => {
    const { ta } = setup();
    const over = dragEvent('dragover', [], ['Files']);
    ta.dispatchEvent(over);
    expect(over.defaultPrevented, 'file の drag を受け取る形になっていない').toBe(true);
    // ⚠ 文字の drag(選択範囲の移動)は**止めない** ── 止めると編集中の移動が死ぬ
    const text = dragEvent('dragover', [], ['text/plain']);
    ta.dispatchEvent(text);
    expect(text.defaultPrevented, '文字の drag まで止めている').toBe(false);
  });

  it('⚠ 受け手が無くても、落ちた file の**既定は止める**(画面ごと遷移させない)', () => {
    const { ta } = setup({ pasteImages: undefined, attachFiles: undefined });
    const e = dragEvent('drop', [png()]);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '止めていない ── 編集中の本文が飛ぶ').toBe(true);
  });

  it('⚠ 差し込む口が無い環境では**添付へ倒す**(貼付が無反応にならない)', () => {
    const { ta, calls } = setup({ pasteImages: undefined });
    const e = pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]);
    ta.dispatchEvent(e);
    expect(calls.attach, '無反応になっている').toHaveLength(1);
  });
});
