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
const READ_WIDTH_SELECTOR = ((): string => {
  const css = readFileSync('src/styles/app.css', 'utf8');
  const hits = parseRules(css).filter(
    (r) => r.selector.startsWith('.pkc-md-rendered') && /max-width:\s*var\(--read-w\)/.test(r.body),
  );
  // ⚠ 空振り防止 ── 1 本も無いなら、この file の検査は全部無意味である
  if (hits.length !== 1) throw new Error(`本文の読み幅の規則が ${hits.length} 本(1 本のはず)`);
  return hits[0]!.selector;
})();

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
  document.body.textContent = '';
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

    // 🔴 押した行だけ跳ねない ── 生の行の器も同じ規則に当たる
    const p = [...live!.querySelectorAll('p')].find((e) => e.textContent === '生にする段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    const slot = live!.querySelector<HTMLElement>('[data-pkc-row-slot]');
    expect(slot, '行を押しても生の器が出ていない(この検査は空振り)').not.toBeNull();
    expect(
      slot!.matches(READ_WIDTH_SELECTOR),
      '押した行だけ全幅へ跳ねる(同じ紙の上で 1 行だけ生になる、が崩れている)',
    ).toBe(true);
  });

  /**
   * ⚠ **ヘルプは対象外**(設計 doc の表)── アプリの文書であって user の文書では
   * ない。ここが当たり始めたら、印を配る先を広げすぎている。
   */
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
