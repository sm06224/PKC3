/** @vitest-environment happy-dom */
/**
 * 🔴 **落とした `.vcf` / `.md` は、取り込むボタンで選んだときと同じ結果になる**(#535 ①)。
 *
 * ## 直す前は「別のことが起きて」いた
 *
 * スマホから出した `contacts.vcf` はダウンロードフォルダに在り、user は
 * **窓へドラッグして落とす**(いちばん自然な手)。ところが `routeFiles` は
 * 「画像でなければ添付」に倒していたので、**連絡先は 1 件も増えず、
 * `contacts.vcf` という添付が 1 つ増えて**いた。
 * 🔑 「取り込めなかった」ではなく「**別のことが起きた**」ので、
 * user は自分が何を間違えたのか分からない ── そして片づける物が 1 つ残る。
 *
 * ⚠ **添付したい人の道は残っている**(「添付」ボタンから選べば添付になる)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';

/** file を持つ drop event を作る(happy-dom に `DragEvent` の実体は無い)。 */
function dropEvent(files: File[]): Event & { defaultPrevented: boolean } {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types: ['Files'],
      dropEffect: 'none',
      files: { length: files.length, item: (i: number) => files[i] ?? null },
      items: [],
    },
  });
  return e as Event & { defaultPrevented: boolean };
}

const file = (name: string, type = ''): File => new File(['x'], name, { type });

function setup(over: Partial<BinderServices> = {}, phase: 'ready' | 'editing' = 'ready') {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>' +
    '<div data-pkc-region="entry-list"><input data-pkc-field="find" /></div>';
  document.body.append(root);
  const calls = { attach: [] as File[][], imported: [] as File[][] };
  const services: BinderServices = {
    attachFiles: (files) => calls.attach.push(files),
    importFiles: (files) => calls.imported.push(files),
    ...over,
  };
  const dispatcher = new Dispatcher();
  /**
   * ⚠ **起動まで進める**(`new Dispatcher()` は `initializing`)── 取込は
   *   `phase === 'ready'` でしか受けないので、ここを飛ばすと**全部が添付に落ちて**
   *   「取込へ倒す」を見たつもりの test が**何も見ない**(2026-08-29 に実際に踏んだ)。
   */
  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      {
        lid: 'n1',
        title: 'メモ',
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
  if (phase === 'editing') {
    // ⚠ **実物の経路で編集へ入れる**(state を手で捏ねない)
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'メモ\n' });
    dispatcher.dispatch({ type: 'START_EDIT' });
  }
  bindActions(root, dispatcher, services);
  return {
    root,
    dispatcher,
    calls,
    outside: root.querySelector('input')!,
    ta: root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!,
  };
}

describe('落とした file の行き先(#535 ①)', () => {
  it('🔴 `.vcf` を落とすと、添付ではなく**取り込む**', () => {
    const { outside, calls } = setup();
    outside.dispatchEvent(dropEvent([file('contacts.vcf', 'text/vcard')]));
    expect(calls.imported, '取込へ行っていない').toHaveLength(1);
    expect(calls.imported[0]?.[0]?.name).toBe('contacts.vcf');
    // 🔑 **対照群** ── 添付には行っていない(直す前はこちらだけが動いていた)
    expect(calls.attach, 'まだ添付へ回している').toHaveLength(0);
  });

  it('🔴 `.md` も同じ(取込の振り分けが受ける 2 種は揃える)', () => {
    const { outside, calls } = setup();
    outside.dispatchEvent(dropEvent([file('note.md', 'text/markdown')]));
    expect(calls.imported).toHaveLength(1);
    expect(calls.attach).toHaveLength(0);
  });

  it('🔴 それ以外は、これまでどおり**添付**(挙動を広げすぎない)', () => {
    const { outside, calls } = setup();
    outside.dispatchEvent(dropEvent([file('scan.pdf', 'application/pdf')]));
    expect(calls.attach, '添付へ行っていない').toHaveLength(1);
    expect(calls.imported, '関係ない file を取込へ回している').toHaveLength(0);
  });

  it('🔴 混ざっていたら添付のまま ── ⚠ 倒すと「落としただけで断り文」になる', () => {
    // `importFiles` は種類の違う file を**断る**ので、ここで倒すと
    // user は落としただけで「分けて取り込んでください」を読まされる
    const { outside, calls } = setup();
    outside.dispatchEvent(dropEvent([file('contacts.vcf'), file('photo.png', 'image/png')]));
    expect(calls.attach, '混在なのに取込へ回した').toHaveLength(1);
    expect(calls.imported).toHaveLength(0);
  });

  it('⚠ 受け手がいなければ、これまでどおり添付へ落ちる(黙って消さない)', () => {
    const { outside, calls } = setup({ importFiles: undefined });
    outside.dispatchEvent(dropEvent([file('contacts.vcf')]));
    expect(calls.attach, '受け手が無いときに何も起きていない').toHaveLength(1);
  });

  it('🔴 編集中は倒さない ── これまでどおり**添付**(動線を奪わない)', () => {
    /**
     * 🔴 **着地前に自分の diff を読み直して見つけた回帰**(2026-08-29)。
     * ⚠ 取込は `phase !== 'ready'` を**断る**ので、編集中に倒すと
     *   「編集を終了してから取り込んでください」を読まされる ──
     *   **これまでは添付できていた**ので、動線を 1 つ奪うことになる。
     */
    const { outside, calls, dispatcher } = setup({}, 'editing');
    expect(dispatcher.getState().phase, '前提: 編集に入っていない').toBe('editing');

    outside.dispatchEvent(dropEvent([file('contacts.vcf')]));
    expect(calls.attach, '編集中なのに添付へ落ちていない').toHaveLength(1);
    expect(calls.imported, '編集中に取込へ倒した(断り文になる)').toHaveLength(0);
  });

  it('🔴 本文の欄へ落としても取り込む(面で結果を変えない)', () => {
    // ⚠ 画像は本文へ差し込まれるが、`.vcf` は**どこへ落としても取込**である
    //    ── 落とす場所で結果が変わると、user は「どこへ落とすか」を覚える羽目になる
    const { ta, calls } = setup();
    ta.dispatchEvent(dropEvent([file('contacts.vcf')]));
    expect(calls.imported).toHaveLength(1);
    expect(calls.attach).toHaveLength(0);
  });
});
