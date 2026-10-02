/** @vitest-environment happy-dom */
/**
 * 🔴 **表の見出しは 1 回押しで並べ替えだけ。編集は 2 回押しか ✎ から**(#1240。Gemini 裁定 A)。
 *
 * > 画面で起きていたこと: 読む画面の表で見出しの升を 1 回押すと、その列で並べ替わる(#1150)と
 * > **同時に**升が編集欄(「表のセル」)になった。並べ替えと編集の 2 つの受け手が、同じ 1 回押しを
 * > 奪い合っていた。
 *
 * 🔑 **面は本物の描画から組む**(`renderMarkdown` + `applyTableSort` ── `detail.ts` と同じ順)。
 *   手で `<th>` を書くと、描画が実際に何を焼くか(✎ を出すか / 印の綴り)を 1 度も見ない。
 * 🔑 **対照群を同じ `it` に置く** ── 本文の升は今までどおり 1 回押しで開く。
 *   見出しで開かないことだけを見ると、台が壊れて何も開かない回でも緑になる。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyTableSort } from '../../src/adapter/ui/render/table-sort';
import {
  extractMdBlockPlainText,
  stripTableChromeForCopy,
} from '../../src/adapter/ui/actions/copy-md-block';

const INPUT = '[data-pkc-field="cell-input"]';
const MD = '| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n| みかん | 1 |\n';
const CSV = '```csv\n品名,数\nりんご,3\nみかん,1\n```\n';

function metasOf(lids: readonly string[]): AppState['entryMetas'] {
  const m = new Map<string, AppState['entryMetas'] extends Map<string, infer V> ? V : never>();
  for (const [i, lid] of lids.entries()) {
    m.set(lid, {
      lid,
      title: lid,
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: i + 1,
      status: null,
      date: null,
      archived: false,
    } as never);
  }
  return m as AppState['entryMetas'];
}

function setup(body: string, interactive = true) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = '<div data-pkc-region="detail"><div data-pkc-field="detail-body"></div></div>';
  document.body.append(root);
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  host.innerHTML =
    '<div class="pkc-md-rendered">' +
    renderMarkdown(body, { sourceLineAnchors: true, interactiveCells: interactive } as never) +
    '</div>';
  // 🔑 `detail.ts` は描いた後に並べ替えを付ける ── 同じ順にする
  applyTableSort(host);
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase: 'ready',
    selectedLid: 'n1',
    entryMetas: metasOf(['n1']),
    openBody: { lid: 'n1', body, baseline: body, persisted: body, diskAhead: false },
  });
  bindActions(root, d, {});
  return { root, host, d };
}

const ths = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('th')];
const tds = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('td')];
const openInput = (host: HTMLElement): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>(INPUT);
/** 本文の 1 列目(並び順を見る)。 */
const firstCol = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('tbody tr')].map((tr) => tr.children[0]!.textContent ?? '');
const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
const dblclick = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
};

describe.each([
  ['markdown の表', MD],
  ['csv の表', CSV],
])('見出しの升は 1 回押しで並べ替えだけ(#1240)── %s', (_name, body) => {
  it('🔴 見出しを 1 回押す → 並び順が変わり、編集欄は出ない(対照群: 本文の升は 1 回押しで開く)', () => {
    const { host } = setup(body);
    expect(firstCol(host), '前提: 描いたままの並び').toEqual(['りんご', 'みかん']);
    const head = ths(host)[1]!;
    expect(head.getAttribute('data-pkc-action'), '前提: 見出しの升が編集の印を持っていない').toBe(
      'edit-cell',
    );
    click(head);
    expect(firstCol(host), '並べ替えが走っていない').toEqual(['みかん', 'りんご']);
    expect(openInput(host), '見出しの 1 回押しで編集欄が開いた').toBeNull();
    // ⚠ 対照群 ── 台が壊れて「何も開かない」だけでも上は緑になる
    click(tds(host)[0]!);
    expect(openInput(host), '対照群が鳴っていない ── 本文の升が 1 回押しで開かない').not.toBeNull();
    expect(openInput(host)!.getAttribute('aria-label')).toBe('表のセル');
  });

  it.each(['Enter', ' '])('🔴 見出しで %j を押す → 並べ替えだけ(編集欄は出ない)', (key) => {
    const { host } = setup(body);
    const head = ths(host)[1]!;
    head.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    expect(firstCol(host), '鍵で並べ替わっていない').toEqual(['みかん', 'りんご']);
    expect(openInput(host), '鍵で編集欄が開いた').toBeNull();
    // ⚠ 対照群 ── 本文の升は 1 回押しで開く(「見出しで開かない」が、台が何も開かないせいではない)
    click(tds(host)[0]!);
    expect(openInput(host), '対照群が鳴っていない').not.toBeNull();
  });

  it('🔴 見出しを 2 回押す → 編集欄が開く(その升の字で)', () => {
    const { host } = setup(body);
    const head = ths(host)[0]!;
    dblclick(head);
    const input = openInput(host);
    expect(input, '2 回押しで編集欄が開かない').not.toBeNull();
    expect(input!.value).toBe('品名');
    expect(head.contains(input), '開いたのが別の升').toBe(true);
  });

  it('🔴 見出しの ✎ を押す → 編集欄が開く。⚠ 並べ替えは走らない', () => {
    const { host } = setup(body);
    const head = ths(host)[1]!;
    const pencil = head.querySelector<HTMLElement>('.pkc-cell-edit-btn');
    expect(pencil, '見出しの升に ✎ が無い').not.toBeNull();
    expect(pencil!.getAttribute('data-pkc-action')).toBe('edit-header-cell');
    expect(pencil!.title).toBe('この見出しを編集する');
    click(pencil!);
    const input = openInput(host);
    expect(input, '✎ で編集欄が開かない').not.toBeNull();
    expect(input!.value, '開いたのが別の升').toBe('数');
    expect(firstCol(host), '✎ を押したのに並べ替えが走った').toEqual(['りんご', 'みかん']);
  });

  it('🔴 ✎ は見出しの升にだけ在る(本文の升には出さない)。字は持たない', () => {
    const { host } = setup(body);
    expect(host.querySelectorAll('.pkc-cell-edit-btn').length, '見出しの数と ✎ の数が違う').toBe(
      ths(host).length,
    );
    for (const td of tds(host)) expect(td.querySelector('.pkc-cell-edit-btn'), '本文の升に ✎').toBeNull();
    // 🔴 ✎ は CSS で出す ── 升の字(textContent / コピー)に混ざらない
    for (const th of ths(host)) {
      expect(th.textContent, '見出しの字に ✎ が混ざった').not.toContain('✎');
      expect(th.querySelector('.pkc-cell-edit-btn')!.textContent).toBe('');
    }
    expect(ths(host).map((t) => t.textContent)).toEqual(['品名', '数']);
  });

  it('⚠ 開いた編集欄の中の押し・鍵は、並べ替えを起こさない(空白が打てる / Enter で並ばない)', () => {
    const { host } = setup(body);
    dblclick(ths(host)[1]!);
    const input = openInput(host)!;
    expect(input, '前提: 欄が開いていない').not.toBeNull();
    const before = firstCol(host);
    click(input);
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    input.dispatchEvent(space);
    expect(space.defaultPrevented, '欄の中の空白が握られて、字が打てない').toBe(false);
    expect(firstCol(host), '欄の中の押し・鍵で並べ替わった').toEqual(before);
  });

  it('⚠ 並べ替えた後でも、2 回押しの欄は壊れない(並べ替えは本文の行だけ動かす)', () => {
    const { host } = setup(body);
    const head = ths(host)[1]!;
    click(head);
    click(head);
    dblclick(head);
    expect(openInput(host), '並べ替えの後に欄が開かない').not.toBeNull();
    // 並べ替えが欄を巻き込まない
    click(ths(host)[0]!.querySelector('.pkc-cell-edit-btn')!.parentElement!);
    expect(host.contains(openInput(host)), '欄が器から外れた').toBe(true);
  });
});

describe('見出しの編集の入口(#1240)── 周りの動線', () => {
  it('🔴 書き出し・印刷の面(押せる面でない)には ✎ を焼かない', () => {
    const { host } = setup(MD, false);
    expect(host.querySelectorAll('.pkc-cell-edit-btn').length, '押せない面に ✎').toBe(0);
    expect(host.querySelectorAll('[data-pkc-action="edit-header-cell"]').length).toBe(0);
  });

  it('🔴 隣の升へ戻る鍵(Shift+Enter)で見出しの升へ入れる(プログラムから開く道)', () => {
    const { host } = setup(MD);
    click(tds(host)[0]!); // 本文の 1 行目 1 列目
    const input = openInput(host)!;
    expect(input, '前提: 本文の升が開かない').not.toBeNull();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
    );
    const now = openInput(host);
    expect(now, '見出しの升へ戻れない(click() で開こうとしている)').not.toBeNull();
    expect(ths(host)[0]!.contains(now), '開いたのが見出しの升ではない').toBe(true);
    expect(now!.value).toBe('品名');
  });

  it('🔴 2 回押しは語を選ぶので、選択が残っていても開く(✎ も同じ)', () => {
    const select = (el: Element): void => {
      const range = document.createRange();
      range.selectNodeContents(el.firstChild ?? el);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      expect(sel.isCollapsed, '前提: 字が選ばれていない').toBe(false);
    };
    const a = setup(MD);
    select(ths(a.host)[0]!);
    dblclick(ths(a.host)[0]!);
    expect(openInput(a.host), '字を選んだままの 2 回押しで開かない').not.toBeNull();
    const b = setup(MD);
    select(ths(b.host)[0]!);
    click(ths(b.host)[0]!.querySelector('.pkc-cell-edit-btn')!);
    expect(openInput(b.host), '字を選んだままの ✎ で開かない').not.toBeNull();
    // ⚠ 対照群 ── 本文の升を 1 回押すだけなら、選択中は開かない(ドラッグの終わりで字を消さない)
    const c = setup(MD);
    select(tds(c.host)[0]!);
    click(tds(c.host)[0]!);
    expect(openInput(c.host), '対照群が鳴っていない ── 選択中の 1 回押しで開いた').toBeNull();
  });

  it('⚠ 升の中のリンクは 2 回押しでも、リンクとして働く(欄を開かない)', () => {
    const { host } = setup('| [公式](https://example.com) | 数 |\n|---|---|\n| a | 1 |\n');
    const link = ths(host)[0]!.querySelector('a[href]')!;
    expect(link, '前提: 見出しにリンクが描かれていない').not.toBeNull();
    dblclick(link);
    expect(openInput(host), '見出しのリンクの 2 回押しで欄が開いた').toBeNull();
    // ⚠ 対照群 ── リンクでない所の 2 回押しなら開く
    dblclick(ths(host)[1]!);
    expect(openInput(host), '対照群が鳴っていない').not.toBeNull();
  });

  it('⚠ 表のコピーに ✎ は混ざらない(押せない小さなボタンを貼らない)', () => {
    const { host } = setup(MD);
    const table = host.querySelector<HTMLElement>('table')!;
    expect(extractMdBlockPlainText(table), '見出しの字に ✎ が混ざった').toBe(
      '品名\t数\nりんご\t3\nみかん\t1',
    );
    // ⚠ 貼る HTML 側 ── 操作子(ボタン)は落ちる
    expect(
      stripTableChromeForCopy(table).querySelector('.pkc-cell-edit-btn'),
      '貼る表に ✎ のボタンが残った',
    ).toBeNull();
  });
});
