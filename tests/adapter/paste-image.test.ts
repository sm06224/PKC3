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
import { attachFiles, type AttachDeps } from '../../src/adapter/ui/actions/attach';

/**
 * clipboard を持つ paste event を作る(happy-dom に `ClipboardEvent` の実体は無い)。
 *
 * ⚠ **`getData` を持たせる**(2026-08-18、#251)── 本物の `DataTransfer` は必ず
 * 持っている。初版は `items` しか持たせておらず、文字の貼付を見る側(#251)を
 * 足した瞬間に `getData is not a function` で落ちた ── **stub が本物より貧しいと、
 * 実装が正しくても落ちる**(CLAUDE.md §3「stub は本物の意味論を真似る」の逆向き)。
 */
function pasteEvent(
  items: { kind: string; type: string; file?: File | null }[],
  data: Readonly<Record<string, string>> = {},
): Event & { defaultPrevented: boolean } {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: {
      items: items.map((it) => ({ kind: it.kind, type: it.type, getAsFile: () => it.file ?? null })),
      getData: (type: string) => data[type] ?? '',
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
  const calls = {
    paste: [] as (readonly File[])[],
    attach: [] as File[][],
    /** ⚠ **事情も採る**(#666)── 行き先は `attachFiles` の側が言うので、
     *   ここで見るのは「**事情がちゃんと渡っているか**」である。 */
    why: [] as (string | undefined)[],
  };
  const services: BinderServices = {
    attachFiles: (files, why) => {
      calls.attach.push(files);
      calls.why.push(why);
    },
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

  it('🔴 画像**でない file** を貼っても何もしない(既定を止めない)', () => {
    // ⚠ 1 巡目の「画像が無ければ何もしない」は `kind: 'string'` を渡していたので、
    //   `filesOf` が先に捨てて**画像の filter が 1 度も評価されなかった**(空振り)。
    //   ここは **file なのに画像でない**ものを渡す ── filter の側を通す。
    // 🔑 貼付と drop は**わざと非対称**である: 落とした file は添付にするが、
    //   貼付は画像だけ受ける(文字と file が同居する貼付で、文字を落とさないため)。
    const { ta, calls } = setup();
    const pdf = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    const e = pasteEvent([{ kind: 'file', type: 'application/pdf', file: pdf }]);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '画像でないのに既定を止めている').toBe(false);
    expect(calls.paste).toHaveLength(0);
    expect(calls.attach, '貼付で添付を作っている(drop との非対称が崩れた)').toHaveLength(0);
  });

  it('🔴 MIME が空でも、**拡張子が画像なら**本文へ入る', () => {
    // ⚠ OS によっては file に MIME が付かない ── `f.type` を直に見ると
    //   「画像でない」に落ちて、編集中は `attachFiles` が断る = **何も起きない**
    const { ta, calls } = setup();
    const bare = new File([new Uint8Array([1])], 'shot.PNG', { type: '' });
    ta.dispatchEvent(pasteEvent([{ kind: 'file', type: '', file: bare }]));
    expect(calls.paste[0], '拡張子から画像と読めていない').toHaveLength(1);
  });

  it('🔴 待っている間に**別のノートの編集**へ移ったら、そこへは差さない', async () => {
    const { ta, dispatcher, calls } = setup();
    dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    dispatcher.dispatch({ type: 'CREATE_ENTRY', lid: 'e1', archetype: 'text', title: 'a' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '' });
    dispatcher.dispatch({ type: 'START_EDIT' });
    ta.dispatchEvent(pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]));
    // ⚠ 取り消して**別のノート**を開き直す(欄は在るが、中身は別物)
    dispatcher.dispatch({ type: 'CANCEL_EDIT' });
    dispatcher.dispatch({ type: 'CREATE_ENTRY', lid: 'e2', archetype: 'text', title: 'b' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'e2', body: '' });
    dispatcher.dispatch({ type: 'START_EDIT' });
    await vi.waitFor(() => expect(dispatcher.getState().error).toBeTruthy());
    expect(ta.value, '別のノートの編集へ差し込んだ').toBe('');
    expect(calls.attach, '編集中なのに添付へ回した').toHaveLength(0);
  });

  it('🔑 クリップボードの画像を**全部**拾う(PKC2 は先頭 1 枚だけだった)', async () => {
    const { ta, calls } = setup();
    // ⚠ **本文の途中に caret を置く** ── 末尾だと、差し込みが caret を進めなくても
    //   「`.value` の代入が caret を末尾へ飛ばす」に救われて**順序が保たれてしまう**
    //   (この形にする前は、caret を進めない変異が生き延びた)
    ta.value = 'まえうしろ';
    ta.selectionStart = 3;
    ta.selectionEnd = 3;
    const e = pasteEvent([
      { kind: 'file', type: 'image/png', file: png('a.png') },
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/webp', file: png('b.webp') },
    ]);
    ta.dispatchEvent(e);
    await vi.waitFor(() => expect(ta.value).toContain('asset:k2'));
    expect(calls.paste[0], '2 枚目を落としている').toHaveLength(2);
    // 🔴 **2 枚が続けて、caret の位置に入る**
    // ⚠ caret を進めないと 2 枚目が**末尾**(「うしろ」の後ろ)へ飛ぶ
    expect(ta.value.replace(/\n/g, ' / '), '2 枚目が離れた所に入った').toMatch(
      /^まえう!\[ず\]\(asset:k1\) \/ !\[ず\]\(asset:k2\) \/ しろ$/,
    );
  });

  it('🔴 差し込みは **state にも届く**(画面だけ変わって保存されない、を作らない)', async () => {
    // ⚠ 2 列の保存は `COMMIT_EDIT` が **state の openBody** を書く ── 差し込みが
    //   `input` を撃たないと、**欄には見えているのに保存された本文には無い**。
    //   ⚠ happy-dom は `execCommand` を持たないので、unit が通るのは fallback の側
    //   である ── そこが本物と同じ意味論でないと、この穴が test から見えない。
    const { root, dispatcher } = setup();
    const host = root.querySelector('[data-pkc-region="detail"]')!;
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    host.append(ta);
    dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    dispatcher.dispatch({ type: 'CREATE_ENTRY', lid: 'e1', archetype: 'text', title: 'n' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '' });
    dispatcher.dispatch({ type: 'START_EDIT' });

    ta.dispatchEvent(pasteEvent([{ kind: 'file', type: 'image/png', file: png() }]));
    await vi.waitFor(() => expect(ta.value).toContain('asset:k1'));
    expect(
      dispatcher.getState().openBody?.body ?? '',
      'state に届いていない(保存すると参照が消える)',
    ).toContain('asset:k1');
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
    /**
     * 🔑 **起きたことを言う**(黙って回すと「貼ったのに出ない」に見える)。
     *
     * 🔴 **言い方は `OP_FAILED` ではなく `why`**(#666 の着地前レビュー 1)。
     * ⚠ ここで `OP_FAILED` を撃っても **user は一度も読めない** ──
     *   `attachFiles` は非同期なので、この行が出た**あと**に `CREATE_ENTRY` が走り、
     *   その reducer が **`error: null`** を書いて消す(`capture.ts` の同じ注記が
     *   既に戒めていた)。⚠ だから `error` を見る検査は**成り立たない条件**である。
     * 🔑 いまは取込の知らせと**同じ 1 行**に出る ── ここでは
     *   「事情が渡ったこと」だけを見て、1 行に出ることは
     *   `attach-intake.test.ts` の ⑩(本物の `attachFiles`)が pin する。
     */
    expect(calls.why[0], '事情を渡していない(user は理由を読めない)').toBe(
      '編集欄が閉じたため、打っていた所へは差せませんでした。',
    );
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

/**
 * 🔴 **fake ではなく本物の `attachFiles` を通す**(2026-08-18、着地前レビュー)。
 *
 * ⚠ 上の test 群の `attachFiles` は「呼ばれたか」しか見ない fake で、**本物より
 * 寛容**である ── 本物は `phase !== 'ready'` を**その場では取り込まない**(`attach.ts`)。
 * そのせいで「編集中に画像以外を落としたら添付になる」という**成り立たない主張**を
 * マニュアルに書いていた(CLAUDE.md §3「stub は本物の意味論を真似る」)。
 *
 * ⚠ 2026-09-04(#668 B)で本物の側が「断る」から「**預かる**」へ変わった ── この it も
 *   それに合わせて書き換えた。守る物は同じ 2 つ:①編集中に bytes を置かない
 *   ②黙らない(直す前は断りの字、いまは預かった旨)。⚠ 全量の unit を回して初めて
 *   落ちた(B のとき触った test の一覧に、この file が無かった)。
 */
describe('本物の添付を通したときの預かり(#250 → #668 B)', () => {
  it('🔴 編集中に画像以外を落とすと、**預かって何も置かれない**(断らない)', async () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>';
    document.body.append(root);
    const stored: string[] = [];
    const deps: AttachDeps = {
      gate: (run) => run(), // #724 ⑤: 単体では門を模さない(そのまま走らせる)
      putBlob: async (key) => void stored.push(key),
      putMeta: async () => {},
      listMetas: async () => [],
    };
    const dispatcher = new Dispatcher();
    bindActions(root, dispatcher, {
      // 🔑 **本物**を通す(fake は「呼ばれたか」しか見ず、本物より寛容だった)
      attachFiles: (files) => void attachFiles(dispatcher, deps, files),
      pasteImages: async () => [],
    });
    dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    dispatcher.dispatch({ type: 'CREATE_ENTRY', lid: 'e1', archetype: 'text', title: 'n' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '' });
    dispatcher.dispatch({ type: 'START_EDIT' });

    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    const pdf = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    ta.dispatchEvent(dragEvent('drop', [pdf]));
    await vi.waitFor(() =>
      expect(dispatcher.getState().notice, '預かった旨が出ていない').toContain('「a.pdf」を預かりました'),
    );
    // ⚠ 断っていない(直す前は「編集を終了してから添付してください」だった)
    expect(dispatcher.getState().error, '断っている(直す前の症状)').toBeNull();
    // ⚠ **1 拍待ってから見る** ── 預からずにその場で走らせる変異は、知らせを出した**後**に
    //    非同期で bytes を書く(hash → put の順)。待たないと空のまま通る(変異試験 W1 が教えた)
    await new Promise((r) => setTimeout(r, 30));
    // 🔑 **bytes も置かれていない**(預かっている間に書いていたら、参照の無い残骸になる)
    expect(stored, '預かっているのに bytes を書いた').toEqual([]);
    // ⚠ その場で走らせると、`CREATE_ENTRY` が黙殺されるか、途中で落ちて**エラーの行**が出る
    expect(dispatcher.getState().error, '預かるはずの回にエラーが出た').toBeNull();
    expect(dispatcher.getState().entryMetas.size, '預かるはずの回に添付が作られた').toBe(1);
    expect(dispatcher.getState().phase, '編集が壊れた').toBe('editing');
  });
});
