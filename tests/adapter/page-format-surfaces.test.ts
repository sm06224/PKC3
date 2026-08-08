/** @vitest-environment happy-dom */
/**
 * 🔴 **読み幅が効く面を、面ごとに pin する**(2026-08-08。紙面フォーマット段 1)。
 *
 * > CLAUDE.md「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する ──
 * > 『この値を読む場所』を grep で数え上げ、**数えた数だけ test を持つ**」
 *
 * 読み幅は 1 本の CSS 規則で効くが、**当たるかどうかは器が印を持つか**で決まる。
 * 器は 6 か所ある(アプリ 4 + 書き出し 2)── 印を 1 か所落とすと、その面だけ
 * 全幅に伸びる。⚠ 実際 2026-08-08 の直前まで**編集の 2 面には掛かっておらず**、
 * 同じ文書が「読む面 42rem / 書いている間は全幅」という非対称だった。
 *
 * 🔑 検査は**規則の字面を写さない** ── `app.css` から**実物の選択子を抜いて**、
 * 各面の**本物の renderer が作った DOM** に当てる(`matches`)。写すと、
 * 「test の中の selector だけが正しい」状態を作ってしまう。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { HelpRenderer } from '../../src/adapter/ui/render/help';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import { parseRules } from '../../build/body-css';

/** `max-width: var(--read-w)` を持つ**本文の**規則の選択子(app.css の実物)。 */
const READ_WIDTH_RULES = ((): { block: string; row: string } => {
  const css = readFileSync('src/styles/app.css', 'utf8');
  const hits = parseRules(css).filter(
    (r) => r.selector.startsWith('.pkc-md-rendered') && /max-width:\s*var\(--read-w\)/.test(r.body),
  );
  /**
   * ⚠ 空振り防止 ── 1 本も無いなら、この file の検査は全部無意味である。
   * いまは **2 本**:① 本文ブロックの allow-list ② ライブエディタで生になった行
   * (印が付いたときだけ掛かる。2026-08-08 に ① から切り出した ── 一緒にすると
   *  表・コードを押した編集欄まで散文の幅へ縮む)。ここが見たいのは ①。
   */
  if (hits.length !== 2) throw new Error(`本文の読み幅の規則が ${hits.length} 本(2 本のはず)`);
  const block = hits.find((r) => r.selector.includes(':is('));
  const row = hits.find((r) => r.selector.includes('data-pkc-row-slot'));
  if (block === undefined) throw new Error('本文ブロックの allow-list が見つからない');
  if (row === undefined) throw new Error('生の行の読み幅の規則が見つからない');
  return { block: block.selector, row: row.selector };
})();

/** 本文ブロック(散文)の読み幅の選択子。 */
const READ_WIDTH_SELECTOR = READ_WIDTH_RULES.block;
/** 生になった行(印が付いたときだけ掛かる)の選択子。 */
const ROW_WIDTH_SELECTOR = READ_WIDTH_RULES.row;

/**
 * 🔴 **app.css の実物を注入する**(2026-08-08)。`row-swap.ts` は
 * `getComputedStyle(el).maxWidth` で「置き換える塊に上限が在ったか」を見るので、
 * **CSS が無いと全部『上限なし』**になり、生の行の検査が丸ごと空振りする。
 * ⚠ `--read-w` の定義も要る ── 未定義の `var()` は宣言ごと無効になる。
 */
function installReadWidthCss(): void {
  const style = document.createElement('style');
  style.textContent =
    `:root{--read-w:42rem}` +
    `${READ_WIDTH_SELECTOR}{max-width:var(--read-w)}` +
    `${ROW_WIDTH_SELECTOR}{max-width:var(--read-w)}`;
  document.head.append(style);
}

/**
 * 注記を落とす。⚠ **「在る」ことを主張する検査**でだけ使う ── 注釈が検査を
 * 満たすと、実装を消しても緑になる(`docs-parity` の `codeOnly` と同じ理由)。
 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
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
    ...over,
  };
}

function state(body: string, over: Partial<EntryMeta> = {}): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', over)],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  return s;
}

const editing = (body: string): AppState => reduce(state(body), { type: 'START_EDIT' }).state;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const setLive = (on: boolean): void => {
  history.replaceState(null, '', on ? '/?pkc-flag=editor.live' : '/');
};

/** その面に出た段落が、読み幅の規則に**実際に当たる**か。 */
function capped(root: HTMLElement, text: string): boolean {
  const p = [...root.querySelectorAll('p')].find((e) => e.textContent === text);
  if (!p) throw new Error(`段落が出ていない(この検査は空振り): ${text}`);
  return p.matches(READ_WIDTH_SELECTOR);
}

function mount(): { root: HTMLElement; detail: DetailRenderer } {
  const root = document.createElement('div');
  document.body.append(root);
  const lender: AssetLender = {
    lend: async () => ({ url: 'blob:x', dispose: () => {} }),
    getBlob: async () => null,
  };
  const detail = new DetailRenderer(buildShell(root).detail, lender, new MarkdownClient());
  return { root, detail };
}

beforeEach(() => {
  document.head.textContent = '';
  document.body.textContent = '';
  installReadWidthCss();
  setLive(false);
});

describe('読み幅が効く面(アプリ 4 面)', () => {
  it('① 読む面(detail)', async () => {
    const { root, detail } = mount();
    detail.render(state('本文の段落。'));
    await settle();
    expect(capped(root, '本文の段落。'), '読む面に読み幅が掛かっていない').toBe(true);
  });

  it('② 添付の説明(本文とは別に描く経路)', async () => {
    const { root, detail } = mount();
    // ⚠ `serializeFrontmatter` は末尾に改行を付けない ── 直に繋ぐと frontmatter が
    //    閉じず、説明ではなく**本文として**描かれる(この検査が空振りになる)
    const body =
      attachmentBody({ name: 'p.png', mime: 'image/png', size: 3, assetKey: 'ast-1' }) +
      '\n\n添付の説明。\n';
    detail.render(state(body, { archetype: 'attachment' }));
    await settle();
    expect(capped(root, '添付の説明。'), '添付の説明だけ全幅に伸びる').toBe(true);
  });

  it('③ 編集の分割プレビュー', async () => {
    const { root, detail } = mount();
    detail.render(editing('書いている段落。'));
    await settle();
    const preview = root.querySelector<HTMLElement>('[data-pkc-region="editor-preview"]');
    expect(preview, '分割プレビューが出ていない(この検査は空振り)').not.toBeNull();
    expect(capped(preview!, '書いている段落。'), 'プレビューだけ全幅に伸びる').toBe(true);
  });

  it('④ ライブエディタ ── 描画済みの行も、生になった行も同じ幅', async () => {
    setLive(true);
    const { root, detail } = mount();
    detail.render(editing('生にする段落。'));
    await settle();
    const live = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]');
    expect(live, 'ライブエディタが出ていない(この検査は空振り)').not.toBeNull();
    expect(capped(live!, '生にする段落。'), 'ライブエディタだけ全幅に伸びる').toBe(true);

    // 🔴 押した行だけ跳ねない ── 段落を押した器には**散文の印**が付く
    const p = [...live!.querySelectorAll('p')].find((e) => e.textContent === '生にする段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    const slot = live!.querySelector<HTMLElement>('[data-pkc-row-slot]');
    expect(slot, '行を押しても生の器が出ていない(この検査は空振り)').not.toBeNull();
    expect(
      slot!.matches(ROW_WIDTH_SELECTOR),
      '押した行だけ全幅へ跳ねる(同じ紙の上で 1 行だけ生になる、が崩れている)',
    ).toBe(true);
  });

  /**
   * 🔴 **表・コードを押したときは縮まない**(2026-08-08 のレビューで直した穴)。
   *
   * スロットは押した塊を丸ごと置き換えるので、一律に散文の幅へ入れると
   * **表の編集欄が縮んで原文が折り返す**(実測 1600px: 表 1036px → 編集欄 672px、
   * 106 字の行が 2 行に)。判定は `getComputedStyle(el).maxWidth` = **CSS の
   * allow-list の結果**を読むので、ここでは app.css の実物を注入して確かめる。
   * ⚠ 注入を忘れると散文まで「上限なし」になり、**この検査は空振りする** ──
   *   だから段落側(上の ④)と表側(ここ)を**対で**持つ。
   */
  it('🔴 表の行を押しても、生の器は散文の幅へ縮まない', async () => {
    setLive(true);
    const { root, detail } = mount();
    detail.render(editing('| あ | い |\n|---|---|\n| 1 | 2 |\n'));
    await settle();
    const live = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]');
    const table = live!.querySelector('table');
    expect(table, '表が描かれていない(この検査は空振り)').not.toBeNull();
    // ⚠ 空振り防止 ── 表が本当に allow-list の外に居ること
    expect(
      getComputedStyle(table!).maxWidth,
      '表に読み幅が掛かっている(allow-list が壊れている)',
    ).toBe('');

    table!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    const slot = live!.querySelector<HTMLElement>('[data-pkc-row-slot]');
    expect(slot, '表を押しても生の器が出ていない(この検査は空振り)').not.toBeNull();
    expect(
      slot!.matches(ROW_WIDTH_SELECTOR),
      '表の編集欄が散文の幅へ縮む(原文が折り返す)',
    ).toBe(false);
  });

  /**
   * ⚠ **ヘルプは対象外**(設計 doc の表)── アプリの文書であって user の文書では
   * ない。ここが当たり始めたら、印を配る先を広げすぎている。
   */
  /**
   * ✗ **アプリの案内は紙面に連動しない**(2026-08-08 のレビュー)。
   *
   * 「何も選んでいないときの案内」は**アプリの文言**であって user の文書ではない
   * ので、「フル HD = 上限なし」を選んだ user にも短い文が画面幅いっぱいへ
   * 伸びるべきではない(規則の注記が「1000px 伸びると読みにくい」と言っている
   * 当のもの)。⚠ 変異試験で **SURVIVED した** ── `42rem` を `var(--read-w)` へ
   * 戻す変異が全 test 緑で通ったので、名指しで pin する。
   */
  it('✗ 何も選んでいないときの案内は、紙面フォーマットに連動しない', () => {
    const css = readFileSync('src/styles/app.css', 'utf8');
    const rules = parseRules(css).filter((r) =>
      r.selector.includes("[data-pkc-field='detail-empty']"),
    );
    expect(rules.length, '案内の規則が見つからない(この検査は空振り)').toBe(1);
    expect(
      rules[0]!.body,
      '案内が紙面に連動している(フル HD で画面幅いっぱいに伸びる)',
    ).not.toMatch(/var\(--read-w\)/);
    expect(rules[0]!.body, '案内に上限が無い(1000px 伸びて読みにくい)').toMatch(
      /max-width:\s*[0-9]/,
    );
  });

  it('✗ ヘルプのマニュアル面には掛からない', () => {
    const region = document.createElement('div');
    document.body.append(region);
    new HelpRenderer(region).render();
    const host = region.querySelector<HTMLElement>('.pkc-md-rendered');
    expect(host, 'マニュアル面が出ていない(この検査は空振り)').not.toBeNull();
    expect(host!.hasAttribute('data-pkc-prose'), 'ヘルプに散文の印が付いている').toBe(false);
  });
});

/**
 * 🔴 **印を配る先を数え上げる。** 面が増えたときに「印を付け忘れる」のが
 * この設計の唯一の壊れ方なので、**器を作る場所の全数**をここで pin する
 * (`.pkc-md-rendered` を名乗る器 = 本文を載せる器)。
 * ⚠ 落ちたら「印を足す」か「対象外の理由を書いてこの表を直す」かのどちらか。
 */
describe('本文の器の全数(印の付け忘れを数で止める)', () => {
  /**
   * 器を作っている file と、**その file 流の「器を作る書き方」**。
   * ⚠ 数え方を file ごとに書くのは、書き方が違うからである(TS の
   *   `className = '…'` / 書き出し側は markup 文字列 + inline script)。
   *   全部を 1 つの正規表現で数えると、CSS の選択子や注記まで拾って嘘の数になる。
   */
  const SITES: Readonly<Record<string, { host: RegExp; prose: boolean; why: string }>> = {
    'src/adapter/ui/render/detail.ts': {
      host: /className = 'pkc-md-rendered'/g,
      prose: true,
      why: '読む面 / 添付の説明 / 分割プレビュー / ライブエディタ',
    },
    'src/adapter/ui/render/help.ts': {
      host: /className = 'pkc-md-rendered'/g,
      prose: false,
      why: 'アプリの文書であって user の文書ではない(設計 doc の表)',
    },
    'src/features/export/pkc3-html.ts': {
      host: /b pkc-md-rendered/g,
      prose: true,
      why: '配る HTML の本文(#body)と「全体を印刷」の箱',
    },
  };

  /** src 配下で本文の器を名乗っている file(新しい面を勝手に増やせない)。 */
  function srcFiles(dir = 'src', out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) srcFiles(full, out);
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('本文の器を作る file が表と一致する(面が増えたら気づく)', () => {
    const found = srcFiles().filter((f) => {
      const code = stripComments(readFileSync(f, 'utf8'));
      return /'pkc-md-rendered'|b pkc-md-rendered/.test(code);
    });
    expect(found.sort(), '本文の器を作る file が増減した ── 印の要否を表に書く').toEqual(
      Object.keys(SITES).sort(),
    );
  });

  it('🔴 印を付ける file では、器の数だけ印が在る', () => {
    for (const [file, spec] of Object.entries(SITES)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const hosts = [...code.matchAll(spec.host)].length;
      const marks = [...code.matchAll(/data-pkc-prose/g)].length;
      if (!spec.prose) {
        expect(marks, `${file}: 対象外のはずが印が付いている(${spec.why})`).toBe(0);
        expect(hosts, `${file}: 器が 1 つも無い(この検査は空振り)`).toBeGreaterThan(0);
        continue;
      }
      expect(hosts, `${file}: 器が 1 つも無い(この検査は空振り)`).toBeGreaterThan(0);
      expect(marks, `${file}: 器 ${hosts} 個に対して印が ${marks} 個(付け忘れ)`).toBe(hosts);
    }
  });
});
