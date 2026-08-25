/** @vitest-environment happy-dom */
/**
 * 🔴 **雛形を `Tab` で挿す**(#196 / B-2 段②)。
 *
 * 🔴 規則そのもの(`insertSnippet` / `abbrBeforeCaret`)は
 * `tests/features/snippet-{expand,table}.test.ts` が見ている。
 * **ここが見るのは繋がり**である ── 編集に入ると雛形が集まり、`Tab` が本文と
 * state の両方を動かし、当たらない `Tab` は**素通りする**か。
 *
 * ⚠ 観測点を textarea の `value` だけにしない ── それだと「書き戻したが state に
 *   届いていない」実装が緑で通り、**保存すると雛形が消える**(書式パネルと同じ罠)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { snippetItemOf, SNIPPET_ARCHETYPE } from '../../src/features/snippet/snippet-table';
import { archetypeLabel } from '../../src/adapter/ui/render/sidebar';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { openDialog } from './dialog-helper';
import { afterEach } from 'vitest';

function meta(lid: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ⚠ 雛形は worker の `snippetScan` が返す ── ここでは同じ組み立て口で作る。 */
function scanOf(bodies: Record<string, { title: string; body: string }>) {
  const items = Object.entries(bodies)
    .map(([lid, v]) => snippetItemOf(lid, v.title, v.body))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return { items, total: items.length, truncated: false };
}

function setup(
  body: string,
  snippets: Record<string, { title: string; body: string }> = {},
  opts: { withScan?: boolean } = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, null, undefined, (b) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
  );
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  let scanCalls = 0;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => body,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    ...(opts.withScan === false
      ? {}
      : {
          snippetScan: async () => {
            scanCalls += 1;
            return scanOf(snippets);
          },
        }),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  return { root, d, q, calls: () => scanCalls };
}

/** 編集に入って textarea を返す。 */
async function edit(
  d: Dispatcher,
  q: <T extends HTMLElement>(s: string) => T | null,
): Promise<HTMLTextAreaElement> {
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  await tick();
  q('[data-pkc-action="start-edit"]')!.click();
  await tick();
  return q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
}

/** `Tab` を撃つ。⚠ 既定が止められたか(= こちらが握ったか)を返す。 */
function tab(ta: HTMLTextAreaElement, shift = false): boolean {
  const ev = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  ta.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe('雛形を Tab で挿す(#196 / B-2)', () => {
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'split');
  });

  it('🔴 編集に入ると雛形を集める(さっき直した雛形が次の編集で効く)', async () => {
    const { d, q, calls } = setup('', { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } });
    expect(calls(), '編集に入る前から集めている').toBe(0);
    await edit(d, q);
    expect(calls()).toBe(1);
    expect(d.getState().snippetScan?.items).toHaveLength(1);
  });

  /**
   * 🔴 **「編集に入る」は 2 経路ある**(2026-08-25、実ブラウザの smoke が拾った)。
   *
   * ⚠ 1 稿目は `START_EDIT` にだけ集めを置いたので、**作成から入った編集では
   *   短縮語が 1 つも当たらなかった** ── unit は「編集」を押す経路しか通しておらず、
   *   作成の経路は**1 度も走っていなかった**(CLAUDE.md §2)。
   * 🔑 だから**両方の経路**を通す(片方だけだと、もう片方が黙って死ぬ)。
   */
  it('🔴 作って即編集の経路でも雛形を集める', async () => {
    const { d, calls } = setup('', {
      s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' },
    });
    expect(calls()).toBe(0);
    d.dispatch({
      type: 'CREATE_ENTRY',
      lid: 'new1',
      title: '新しいノート',
      archetype: 'text',
    });
    await tick();
    expect(calls(), '作成から入った編集で集めていない').toBe(1);
    expect(d.getState().snippetScan?.items).toHaveLength(1);
  });

  it('🔴 短縮語 + Tab で本文と state が**そろって**変わる', async () => {
    const { d, q } = setup('', {
      s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100-0000 千代田区' },
    });
    const ta = await edit(d, q);
    ta.value = 'addr';
    ta.setSelectionRange(4, 4);
    expect(tab(ta), 'Tab を握っていない').toBe(true);
    // ① 本文
    expect(ta.value).toBe('〒100-0000 千代田区');
    await tick();
    // ② 🔴 state ── ここが繋がっていないと**保存した瞬間に雛形が消える**
    expect(d.getState().openBody?.body).toBe('〒100-0000 千代田区');
  });

  it('🔴 印が在れば選ばれ、次の Tab で次の印へ移る', async () => {
    const { d, q } = setup('', {
      s1: { title: '挨拶', body: '---\nabbr: aisatsu\n---\n${宛名} 様\n${本文}' },
    });
    const ta = await edit(d, q);
    ta.value = 'aisatsu';
    ta.setSelectionRange(7, 7);
    tab(ta);
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('${宛名}');
    expect(tab(ta), '2 度目の Tab を握っていない').toBe(true);
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('${本文}');
  });

  /**
   * 🔴 **当たらない `Tab` は素通しする** ── 常に握ると、編集欄から `Tab` で
   * 出られなくなる(キーボードだけで使う人の動線を 1 つ殺す)。
   */
  it('🔴 当たらなければ Tab を握らない(焦点移動が生きる)', async () => {
    const { d, q } = setup('', { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } });
    const ta = await edit(d, q);
    ta.value = 'ふつうの文';
    ta.setSelectionRange(5, 5);
    expect(tab(ta)).toBe(false);
    expect(ta.value, '本文が変わっている').toBe('ふつうの文');
  });

  it('🔴 雛形を集められなくても、Tab は素通りする(静かに畳む)', async () => {
    const { d, q } = setup('', {}, { withScan: false });
    const ta = await edit(d, q);
    ta.value = 'addr';
    ta.setSelectionRange(4, 4);
    expect(tab(ta)).toBe(false);
    expect(d.getState().snippetScan, '集められないのに表を持っている').toBe(null);
  });

  it('⚠ 語の途中では展開しない(myaddr の尻に当たらない)', async () => {
    const { d, q } = setup('', { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } });
    const ta = await edit(d, q);
    ta.value = 'myaddr';
    ta.setSelectionRange(6, 6);
    expect(tab(ta)).toBe(false);
  });

  it('⚠ Shift+Tab は触らない(逆方向の焦点移動を殺さない)', async () => {
    const { d, q } = setup('', { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } });
    const ta = await edit(d, q);
    ta.value = 'addr';
    ta.setSelectionRange(4, 4);
    expect(tab(ta, true)).toBe(false);
    expect(ta.value).toBe('addr');
  });

  /**
   * 🔴 **短縮語が先、印が後**(binder の順序)。⚠ 逆だと、後ろに `${…}` が残った
   * ノートで短縮語を打った瞬間、**展開されずに遠くへ飛ぶ**。
   */
  it('🔴 後ろに印が残っていても、短縮語のほうが先に効く', async () => {
    const { d, q } = setup('', { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } });
    const ta = await edit(d, q);
    ta.value = 'addr\nあとで ${直す}';
    ta.setSelectionRange(4, 4);
    tab(ta);
    expect(ta.value).toBe('〒100\nあとで ${直す}');
  });

  /**
   * 🔴 **選んでいる字を、雛形に食わせない**(2026-08-25、変異試験 B3 が生き延びて判明)。
   *
   * ⚠ 短縮語は**選択の頭**の手前で当たるので、`collapsed` の門を外すと
   *   `hit.start` 〜 **選択の終わり**を丸ごと置き換える ── つまり
   *   **user が選んでいた字が、断りも無く消える**。
   * 🔑 対照群を同じ it に置く(選ばなければ展開する)── 置かないと
   *   「別の理由で展開しなかっただけ」を次に見抜けない。
   */
  it('🔴 字を選んでいるときは展開しない(選んだ字が消えない)', async () => {
    const { d, q } = setup('', { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } });
    const ta = await edit(d, q);
    ta.value = 'addr大事な文';
    ta.setSelectionRange(4, 8); // 「大事な文」を選んでいる
    expect(tab(ta), '選択中の Tab を握った').toBe(false);
    expect(ta.value, '選んでいた字が雛形に食われた').toBe('addr大事な文');
    // ⚠ 対照群 ── 同じ本文・同じ位置で、選ばずカーソルだけなら展開する
    ta.setSelectionRange(4, 4);
    expect(tab(ta), '対照群が展開していない(前提が崩れた)').toBe(true);
    expect(ta.value).toBe('〒100大事な文');
  });
});

describe('雛形が作れる(#196 / B-2)', () => {
  it('🔴 作成の一覧に「雛形」が並ぶ(作れないと自分の雛形を持てない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const kinds = [...root.querySelectorAll('[data-pkc-archetype]')].map((e) =>
      e.getAttribute('data-pkc-archetype'),
    );
    expect(kinds).toContain(SNIPPET_ARCHETYPE);
  });

  it('種別の名前が内部語のままになっていない', () => {
    expect(archetypeLabel(SNIPPET_ARCHETYPE)).toBe('雛形');
  });
});

/**
 * 🔴 **雛形を一覧から入れる**(#196 / B-2 段②-b)。
 *
 * ⚠ 短縮語 + `Tab` は**覚えている人の近道**である ── 覚えていない人には、
 *   ここが**唯一の入口**になる。だから見るのは「開くか」ではなく
 *   **「押したものが caret の位置に入るか」**まで。
 */
describe('雛形を一覧から入れる(#196 / B-2 段②-b)', () => {
  afterEach(() => {
    resetAppDialogForTest();
  });

  /**
   * 編集に入って本文と caret を作り、「雛形」を押して一覧を開く。
   *
   * ⚠ **本文と caret は押す前に作る** ── 器はモーダルなので、開いている間に
   *   user が本文を打つことはできない。だから控えるのは**押した時点**の位置である
   *   (1 稿目は開いた後に caret を作って落ち、**test の前提のほうが間違っていた**)。
   */
  async function openMenu(
    snippets: Record<string, { title: string; body: string }> = {},
    at: { body: string; caret: number } = { body: '', caret: 0 },
  ): Promise<{
    d: Dispatcher;
    q: <T extends HTMLElement>(s: string) => T | null;
    ta: HTMLTextAreaElement;
  }> {
    const { d, q } = setup('', snippets);
    const ta = await edit(d, q);
    ta.value = at.body;
    ta.setSelectionRange(at.caret, at.caret);
    q('[data-pkc-action="insert-snippet"]')!.click();
    await tick();
    return { d, q, ta };
  }

  const rows = (): HTMLButtonElement[] => [
    ...(openDialog()?.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-snippet"]') ?? []),
  ];

  /** ⚠ 閲覧中は帯そのものが無い(押せる口を出さない = dead click を作らない)。 */
  it('閲覧中は「雛形」のボタンが出ていない', async () => {
    const { d, q } = setup('x');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    expect(q('[data-pkc-action="insert-snippet"]'), '閲覧中に押せる口が出ている').toBeNull();
  });

  it('🔴 押すと一覧が開き、自分の雛形と組み込みが並ぶ', async () => {
    await openMenu({ s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } });
    expect(openDialog(), '雛形の窓が開いていない').not.toBeNull();
    const labels = rows().map((b) => b.textContent);
    // 🔑 短縮語も一緒に出す ── ここで覚えれば、次からは `Tab` で呼べる
    expect(labels[0]).toBe('住所(addr)');
    // 🔴 組み込みが後ろに居る(自分の雛形が 0 件でも空にならない、の実体)
    expect(labels, '組み込みの雛形が並んでいない').toContain('表');
  });

  /**
   * 🔴 **caret の位置に入る**(`insert-date` が 2026-08-23 に実機で踏んだ罠)。
   * ⚠ `<dialog>` は焦点を借りて返すが、**選択位置までは返さない** ── 控えていないと
   *   本文の**先頭**に入る。
   */
  it('🔴 行を押すと caret の位置に入り、state もそろって変わる', async () => {
    const { d, ta } = await openMenu(
      { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } },
      // 「まえ\n」の直後で押す(本文の先頭ではない)
      { body: 'まえ\nうしろ', caret: 3 },
    );
    rows()[0]!.click();
    await tick();
    expect(ta.value, '本文の先頭に入っている(caret を控えていない)').toBe('まえ\n〒100うしろ');
    // 🔴 state ── 繋がっていないと**保存した瞬間に消える**
    expect(d.getState().openBody?.body).toBe('まえ\n〒100うしろ');
  });

  it('🔴 組み込みの行を押すと、その雛形が入る', async () => {
    const { ta } = await openMenu();
    const table = rows().find((b) => b.textContent === '表')!;
    table.click();
    await tick();
    expect(ta.value, '表の雛形が入っていない').toContain('|---|---|');
  });

  it('🔴 やめたら本文は 1 バイトも変わらない', async () => {
    const { ta } = await openMenu(
      { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } },
      { body: 'そのまま', caret: 4 },
    );
    openDialog()!.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
    await tick();
    expect(ta.value).toBe('そのまま');
  });

  /**
   * 🔴 **押した行の本文が入る**(1 行目のを入れない)。
   * ⚠ 雛形が 1 件しかない fixture だけだと、`items[0]` を返す実装でも緑になる
   *   (CLAUDE.md §2「fixture のゼロ件の次元は測っていない次元」の**1 件版**)。
   */
  it('🔴 2 件目を押したら 2 件目が入る', async () => {
    const { ta } = await openMenu({
      s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' },
      s2: { title: '署名', body: '---\nabbr: sig\n---\n山田太郎' },
    });
    const list = rows();
    expect(list.length, '前提が崩れている(2 件並んでいない)').toBeGreaterThan(1);
    expect(list[1]!.textContent).toBe('署名(sig)');
    list[1]!.click();
    await tick();
    expect(ta.value, '1 件目が入っている').toBe('山田太郎');
  });

  /**
   * 🔴 **受ける側のボタンを出さない** ── 押した行がそのまま答えなので、
   * 「入れる」を出すと**押しても何も起きないボタン**になる(dead click)。
   */
  it('🔴 一覧では「入れる」を出さない(押しても何も起きないボタンを作らない)', async () => {
    await openMenu();
    const ok = openDialog()!.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!;
    expect(ok.hidden, '押しても何も起きない「入れる」が出ている').toBe(true);
  });

  /**
   * 🔴 **画面から降りた欄に書き込まない**(2026-08-25、変異試験 M4 が生き延びて判明)。
   *
   * ⚠ 一覧を開いている間に編集が終わる(別のタブが閉じさせる / やめる)ことがある。
   *   最初に掴んだ欄をそのまま使うと、**画面に無い節点へ字を書き、`input` まで
   *   撃つ** ── 本文は画面に出ないのに state だけ動く、という
   *   **いちばん気づけない食い違い**になる。
   * 🔑 だから押された後に**引き直す**。無ければ何もしない。
   */
  it('🔴 編集をやめた後に押しても、画面から降りた欄に書き込まない', async () => {
    const { d, ta } = await openMenu(
      { s1: { title: '住所', body: '---\nabbr: addr\n---\n〒100' } },
      { body: 'もとのまま', caret: 5 },
    );
    d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    expect(ta.isConnected, '前提が崩れている(欄がまだ画面に在る)').toBe(false);
    rows()[0]!.click();
    await tick();
    expect(ta.value, '画面に無い欄へ書き込んでいる').toBe('もとのまま');
  });

  /** 🔴 雛形が 1 件も無い人に、**作り方**を出す(ここが唯一の入口だから)。 */
  it('🔴 雛形が無いときは、作り方を出す', async () => {
    await openMenu();
    const note = openDialog()?.querySelector('[data-pkc-field="pick-snippet-note"]')?.textContent;
    expect(note, '作り方の案内が出ていない').toContain('作成');
  });
});
