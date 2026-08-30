/** @vitest-environment happy-dom */
/**
 * 🔴 **操作が「対象の隣」に無かった 2 件**(#401)。
 *
 * ⚠ どちらも「機能が無い」ではなく「**導線が無い**」形だった ──
 *   URL タイルは**表示も起動もできた**のに作れず、改名は**機構が在る**のに
 *   添付の画面から撃てなかった。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';

beforeEach(() => {
  document.body.textContent = '';
});

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const region = document.createElement('div');
  root.append(region);
  const r = new LauncherRenderer(region);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: [] });
  r.render(d.getState());
  sent.length = 0;
  const q = <T extends HTMLElement>(f: string): T =>
    region.querySelector<T>(`[data-pkc-field="${f}"]`)!;
  return { root, region, d, sent, r, q };
}

describe('① よく開くサイトをアプリ一覧に足す (#401)', () => {
  it('🔴 押す口が画面に在る(直す前は 1 つも無かった)', () => {
    const { q } = setup();
    expect(q('launcher-add-url'), 'アドレスの欄が無い').toBeTruthy();
    expect(q('launcher-add-name'), '名前の欄が無い').toBeTruthy();
    // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
    expect(q('launcher-add-go').title).toContain('別のウィンドウで開きます');
  });

  /**
   * 🔴 **打ちかけのアドレスが消えない。**
   * ⚠ `render` は一覧を毎回捨てて組み直すので、足す欄をそこに置くと
   *   **タイルの読み直しが走った瞬間に打ちかけが消える**。
   * 🔑 この test が、器を分けた理由そのものである。
   */
  it('🔴 タイルを読み直しても、打ちかけのアドレスが消えない', () => {
    const { d, r, q } = setup();
    q<HTMLInputElement>('launcher-add-url').value = 'https://例';
    d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: [] });
    r.render(d.getState());
    expect(q<HTMLInputElement>('launcher-add-url').value, '打ちかけが消えた').toBe('https://例');
  });

  /** ⚠ 押して無反応にしない ── 断るときは理由を言う(両方の断り方を見る)。 */
  it('🔴 空でも、開けない形でも、理由を出す', () => {
    const { d, sent, q } = setup();
    const press = (): Dispatchable | undefined => {
      sent.length = 0;
      q('launcher-add-go').click();
      return sent.find((a) => a.type === 'OP_FAILED');
    };
    expect(press(), '空で押しても黙っている').toBeDefined();
    q<HTMLInputElement>('launcher-add-url').value = 'javascript:alert(1)';
    const bad = press();
    expect(bad, '開けない形でも黙っている').toBeDefined();
    expect(JSON.stringify(bad)).toContain('http');
    // ⚠ 対照群 ── どちらの断りでも entry は作られていない
    expect(sent.some((a) => a.type === 'CREATE_ENTRY'), '断ったのに作っている').toBe(false);
    void d;
  });

  /**
   * 🔴 **archetype は `attachment` でなければならない。**
   * ⚠ 一覧の材料を集める `attachmentEntries` がその型で絞っているので、
   *   別の型で作ると**永久に一覧へ出ない**(押せたのに何も起きない、に見える)。
   */
  it('🔴 1 回の作成で、一覧に出る形のノートができる', () => {
    const { sent, q } = setup();
    q<HTMLInputElement>('launcher-add-name').value = '地図';
    q<HTMLInputElement>('launcher-add-url').value = 'https://example.com/map';
    q('launcher-add-go').click();
    const created = sent.find((a) => a.type === 'CREATE_ENTRY');
    expect(created, '作られていない').toBeDefined();
    expect(created).toMatchObject({ title: '地図', archetype: 'attachment', edit: false });
    expect(
      (created as { body?: string }).body,
      'タイルの材料(launcher_url)が本文に入っていない',
    ).toContain('attachment.launcher_url: https://example.com/map');
    // 🔑 足したものが**その場で**出る ── 読み直さないと「押しても何も起きない」
    expect(
      sent.some((a) => a.type === 'REFRESH_LAUNCHER_TILES'),
      '一覧を読み直していない',
    ).toBe(true);
    // ⚠ 欄は空に戻る(次の 1 件をすぐ足せる)
    expect(q<HTMLInputElement>('launcher-add-url').value).toBe('');
  });

  /** ⚠ 名前を省いたら、アドレスをそのまま名前にする(無題のタイルを作らない)。 */
  it('名前を省くとアドレスが名前になる', () => {
    const { sent, q } = setup();
    q<HTMLInputElement>('launcher-add-url').value = 'https://example.com/';
    q('launcher-add-go').click();
    expect(sent.find((a) => a.type === 'CREATE_ENTRY')).toMatchObject({
      title: 'https://example.com/',
    });
  });

  /** ⚠ 空状態の文言が**もう 1 本の道**を言う(行き止まりにしない)。 */
  it('アプリが 0 件のときの案内に、この道が書いてある', () => {
    const { region } = setup();
    const empty = region.querySelector('[data-pkc-field="launcher-empty"]');
    expect(empty?.textContent ?? '').toContain('アドレス');
  });
});

describe('② 添付の名前を、その添付の画面から変える (#401)', () => {
  it('🔴 改名は既存の 1 つの action を撃つ(新しい規則を作らない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const sent: Dispatchable[] = [];
    const raw = d.dispatch.bind(d);
    d.dispatch = ((a: Dispatchable) => {
      sent.push(a);
      return raw(a);
    }) as typeof d.dispatch;
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'a1',
          title: 'IMG_4821.png',
          archetype: 'attachment',
          createdAt: null,
          updatedAt: null,
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          bodyChars: 0,
        },
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    const input = document.createElement('input');
    input.setAttribute('data-pkc-action', 'rename-attachment');
    input.setAttribute('data-pkc-field', 'attachment-rename');
    input.value = '打ち合わせの写真';
    root.append(input);
    sent.length = 0;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent.find((a) => a.type === 'RENAME_ENTRY_TITLE')).toMatchObject({
      lid: 'a1',
      title: '打ち合わせの写真',
    });

    /**
     * ⚠ 空にはしない(無題の添付を作らない)── **いまの題名へ戻し、撃たない**。
     * ⚠ 戻る先は「最初の題名」ではなく **いま state が持っている題名**である
     *   (上で改名済みなので `打ち合わせの写真`)── ここを「最初の字」と書いて
     *   1 度落とした。**実装ではなく期待の側が間違っていた**。
     */
    sent.length = 0;
    input.value = '   ';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent.some((a) => a.type === 'RENAME_ENTRY_TITLE'), '空で撃っている').toBe(false);
    expect(input.value, 'いまの題名へ戻っていない').toBe('打ち合わせの写真');
    expect(d.getState().entryMetas.get('a1')?.title, '空で題名が消えている').toBe(
      '打ち合わせの写真',
    );
    void initialState;
    void reduce;
  });
});
