/** @vitest-environment happy-dom */
/**
 * attachment view(P4a)の表示と **lend/dispose 規律**(生成物のライフサイクル
 * 終端での即破棄 ── user 指示 2026-07-27)の pin。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 1,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(bodies: Record<string, string>, lender: AssetLender) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, lender);
  d.onState((s) => detail.render(s));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a1'), meta('a2', { archetype: 'text' })],
    relations: [],
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { d, q };
}

describe('attachment view (P4a)', () => {
  const imgBody = attachmentBody({
    name: 'p.png',
    mime: 'image/png',
    size: 3,
    assetKey: 'ast-1',
  });

  it('image preview: lend した URL が img に付き、選択遷移で必ず dispose される', async () => {
    let disposed = 0;
    const lender: AssetLender = {
      lend: async () => ({ url: 'blob:fake-1', dispose: () => disposed++ }),
      getBlob: async () => null,
    };
    const { d, q } = setup({ a1: imgBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);

    const img = q<HTMLImageElement>('[data-pkc-field="attachment-media"]');
    expect(img?.getAttribute('src')).toBe('blob:fake-1');
    // メタ表示 + ダウンロード導線
    expect(q('[data-pkc-field="attachment-info"]')?.textContent).toContain('p.png');
    expect(
      q('[data-pkc-action="download-asset"]')?.getAttribute('data-pkc-asset-key'),
    ).toBe('ast-1');
    expect(disposed).toBe(0); // 表示中は生きている

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a2' });
    await tick(20);
    expect(disposed).toBe(1); // 表示の寿命の終わりで即 dispose
  });

  /**
   * P8 段⑰: 🔴 **同じノートを開いたままの再描画で借り直さない**(レビュー H-4)。
   *
   * 🔴 直す前の実測: 添付を選んだまま履歴の開閉を 3 往復すると
   * **lend 7 回 / dispose 0 回**、画面の `<img>` は 1 枚。骨組みを使い回す
   * ようになった段⑪ 以降、`fresh` でない再描画では `disposeLends()` が走らず、
   * `textContent=''` で `<img>` だけ消えて貸出が積み上がっていた。
   * ⚠ 既存 test は「**選択遷移で** dispose」しか見ておらず、同一 lid の
   * 再描画を 1 件も見ていなかった。
   */
  it('🔴 同じノートのまま何度描き直しても、生きている貸出は 1 本だけ', async () => {
    let lent = 0;
    let disposed = 0;
    const lender: AssetLender = {
      lend: async () => {
        lent += 1;
        return { url: `blob:n${lent}`, dispose: () => disposed++ };
      },
      getBlob: async () => null,
    };
    const { d, q } = setup({ a1: imgBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);

    // 履歴の開閉 = 同じノートのまま再描画(骨組みは作り直されない)
    for (let i = 0; i < 3; i++) {
      d.dispatch({ type: 'SHOW_HISTORY' });
      await tick(20);
      d.dispatch({ type: 'HIDE_HISTORY' });
      await tick(20);
    }
    expect(q('[data-pkc-field="attachment-media"]'), '画像が消えた').not.toBeNull();
    // 🔴 生きている貸出は**常に 1 本**(= 借りた数 - 返した数)
    expect(lent - disposed, `貸出が積み上がっている(lend ${lent} / dispose ${disposed})`).toBe(1);

    // 選択を移したら最後の 1 本も返る
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a2' });
    await tick(20);
    expect(lent - disposed).toBe(0);
  });

  it('text preview は blob.text() を切り出して表示(URL を借りない)', async () => {
    const lender: AssetLender = {
      lend: async () => {
        throw new Error('text preview must not lend a URL');
      },
      getBlob: async () => new Blob(['こんにちは asset'], { type: 'text/plain' }),
    };
    const body = attachmentBody({
      name: 'a.txt',
      mime: 'text/plain',
      size: 10,
      assetKey: 'ast-t',
    });
    const { d, q } = setup({ a1: body }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(q('[data-pkc-field="attachment-text"]')?.textContent).toContain(
      'こんにちは asset',
    );
  });

  it('asset 不在は missing 表示(黙って空にしない)', async () => {
    const lender: AssetLender = {
      lend: async () => null,
      getBlob: async () => null,
    };
    const { d, q } = setup({ a1: imgBody }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(q('[data-pkc-asset-missing]')).not.toBeNull();
  });

  it('stale hydrate: 解決前に選択が移ったら結果を捨てて即 dispose(URL leak 0)', async () => {
    let disposed = 0;
    let release: (v: { url: string; dispose: () => void } | null) => void = () => {};
    const lender: AssetLender = {
      lend: () =>
        new Promise((r) => {
          release = r;
        }),
      getBlob: async () => null,
    };
    const { d, q } = setup({ a1: imgBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a2' }); // 解決前に離脱
    await tick();
    release({ url: 'blob:late', dispose: () => disposed++ }); // 遅延解決
    await tick();
    expect(disposed).toBe(1); // 借りた瞬間に返す
    expect(q('[data-pkc-field="attachment-media"]')).toBeNull(); // stale DOM 注入なし
  });
});

/**
 * P8 段⑬ review L-3: 🔴 **添付の説明にも図が書ける**。
 *
 * 本文(`renderView`)は `hydrateMermaid` を呼んでいたが、添付の説明だけ
 * 呼んでいなかった ── 同じ markdown なのに、置き場所で描けたり描けなかったりする。
 * 器(`data-pkc-mermaid-src`)は出るので**空の枠が残る**だけで、例外も出ない。
 *
 * ⚠ 観測点は「図が描けたか」ではなく「**面倒を見始めたか**」── 実際の焼き上げは
 * mermaid の読み込みが要る(`tests/adapter/mermaid-hydrate.test.ts` と同じ判断)。
 */
describe('添付の説明に書いた図(P8 段⑬)', () => {
  it('🔴 本文と同じように図の面倒を見る', async () => {
    const observed: Element[] = [];
    class FakeIO {
      constructor(_cb: unknown) {
        void _cb;
      }
      observe(el: Element): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    try {
      // 説明は frontmatter の**後ろ**に書く markdown(本文と同じ書き方)
      const body =
        attachmentBody({ name: 'p.png', mime: 'image/png', size: 3, assetKey: 'ast-1' }) +
        'この図の通り。\n\n```mermaid\ngraph TD\n  A-->B\n```\n';
      const lender: AssetLender = {
        lend: async () => ({ url: 'blob:fake-1', dispose: () => {} }),
        getBlob: async () => null,
      };
      const { d, q } = setup({ a1: body, a2: '# text' }, lender);
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
      await tick(20);

      const host = q('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
      expect(host, '添付の説明に図の器が出ていない').not.toBeNull();
      expect(observed, '器は出たのに、誰も焼きに来ない(空の枠が残る)').toContain(host);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * 🔴 **添付の説明にも文書 globals が届く**(#106 / Issue #103 の残面)。
 * `data-pkc-doc-align` を消費する面は 5 つ(読む面 / プレビュー / ライブ /
 * 添付の説明 / 書き出し)だが、**添付の説明だけ誰も見ていなかった** ──
 * 書き出し(pkc3-html.ts)は同じ entry に attrs を焼くので、渡し忘れは
 * 「配った HTML でだけ |> が反対に寄る」という面間の食い違いになる。
 */
describe('添付の説明の文書 globals(#106)', () => {
  const noLender: AssetLender = {
    lend: async () => null,
    getBlob: async () => null,
  };

  it('🔴 宣言した寄せ・書字方向が説明の器に付く(|> の反転が成立する前提)', async () => {
    const body = [
      '---',
      'attachment.name: p.png',
      'attachment.mime: image/png',
      'attachment.size: 3',
      'attachment.asset_key: ast-1',
      'align: right',
      'direction: rtl',
      '---',
      '',
      '|> 説明の行',
      '',
    ].join('\n');
    const { d, q } = setup({ a1: body, a2: '# text' }, noLender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);

    const desc = q('[data-pkc-field="detail-body"]');
    expect(desc, '説明の器が出ていない(この検査が空振りしている)').not.toBeNull();
    expect(desc!.getAttribute('data-pkc-doc-align'), '宣言した寄せが届いていない').toBe('right');
    expect(desc!.getAttribute('dir'), '書字方向が届いていない').toBe('rtl');
    // 入れ替え規則は `.pkc-md-rendered[data-pkc-doc-align=…] [data-pkc-align=opposite]`
    // ── class と属性が揃って初めて当たる(live-editor.test.ts の同型の観点)
    expect(
      desc!.classList.contains('pkc-md-rendered'),
      '説明の器が markdown の CSS の外に居る(属性だけ届いても寄らない)',
    ).toBe(true);
    // 空振り防止 ── この面で記法の次元がゼロなら、上の属性 pin は何も守らない
    expect(
      desc!.querySelector('[data-pkc-align="opposite"]'),
      '説明の |> が opposite を出していない',
    ).not.toBeNull();
  });

  it('宣言が無ければ属性も無い(付けっぱなしにしない)', async () => {
    const body =
      attachmentBody({ name: 'p.png', mime: 'image/png', size: 3, assetKey: 'ast-1' }) +
      '\n\n説明の行\n';
    const { d, q } = setup({ a1: body, a2: '# text' }, noLender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    const desc = q('[data-pkc-field="detail-body"]')!;
    expect(desc.hasAttribute('data-pkc-doc-align')).toBe(false);
    expect(desc.hasAttribute('dir')).toBe(false);
  });
});

/**
 * 🔴 **詳細画面から起動できる**(P10、user 指示 2026-08-05
 * 「HTML アセットの詳細画面から起動できない」)。
 *
 * 直す前は添付の詳細に起動の導線が**1 つも無かった**(ダウンロード / 参照をコピー /
 * アプリとして登録 だけ)。`text/html` は preview も出ないので、
 * **詳細から中身に触る方法が無かった**。
 */
describe('添付の詳細から起動する(P10)', () => {
  const noLender: AssetLender = {
    lend: async () => null,
    getBlob: async () => null,
  };
  const htmlBody = attachmentBody({
    name: '見積.html',
    mime: 'text/html',
    size: 120,
    assetKey: 'ast-html',
  });
  const pdfBody = attachmentBody({
    name: '見積.pdf',
    mime: 'application/pdf',
    size: 120,
    assetKey: 'ast-pdf',
  });

  it('🔴 HTML の添付には「起動」と「素のまま起動」が出る', async () => {
    const { d, q } = setup({ a1: htmlBody, a2: '# text' }, noLender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    const run = q('[data-pkc-action="launch-asset"]');
    const raw = q('[data-pkc-action="launch-asset-raw"]');
    expect(run, '「起動」が無い').not.toBeNull();
    expect(raw, '「素のまま起動」が無い').not.toBeNull();
    // ⚠ 文言だけでなく**何が起きるか**が読めること(素のままは危険側なので)
    expect(run!.getAttribute('title')).toContain('囲いの中');
    expect(raw!.getAttribute('title')).toContain('PKC3 の中身にも手が届きます');
    // 図案が入っている(押せる物だと分かる)
    expect(run!.querySelector('[data-pkc-icon] svg path')).not.toBeNull();
  });

  it('🔴 HTML でない添付には出さない', async () => {
    const { d, q } = setup({ a1: pdfBody, a2: '# text' }, noLender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(q('[data-pkc-action="launch-asset"]'), 'PDF に「起動」が出ている').toBeNull();
    expect(q('[data-pkc-action="launch-asset-raw"]')).toBeNull();
  });
});

/**
 * 🔴 **PDF の見え方**(2026-08-15、user 報告「PDF ビューアが動作しない /
 * 窓内と別窓の両方を PKC2 を真似して実装してください」)。
 *
 * ⚠ **この経路には test が 1 件も無かった** ── repo 全体で `<object>` を
 * assert する test は 0 件で、だから「302 × 152 の切手大で描かれている」ことが
 * 誰にも鳴らなかった(CLAUDE.md §2「経路が一度も通っていない」)。
 * ⚠ **寸法そのものは happy-dom では測れない**(版面が無い)ので、
 * ここでは**要素と属性**を pin し、実寸は smoke が見る。
 */
describe('PDF の添付(窓内 + 別窓)', () => {
  const pdfBody = attachmentBody({
    name: '見積.pdf',
    mime: 'application/pdf',
    size: 605,
    assetKey: 'ast-pdf',
  });
  const lender: AssetLender = {
    lend: async () => ({ url: 'blob:fake-pdf', dispose: () => undefined }),
    getBlob: async () => null,
  };

  it('🔴 object[type=application/pdf] が blob URL 付きで入る', async () => {
    const { d, q } = setup({ a1: pdfBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    const obj = q<HTMLObjectElement>('[data-pkc-field="attachment-media"]');
    expect(obj, 'preview が出ていない').not.toBeNull();
    expect(obj!.tagName.toLowerCase(), 'object で出していない').toBe('object');
    expect(obj!.getAttribute('type')).toBe('application/pdf');
    expect(obj!.getAttribute('data')).toBe('blob:fake-pdf');
    // 🔑 CSS が PDF だけを狙えるようにする印(共用の規則では 300×150 に落ちる)
    expect(obj!.getAttribute('data-pkc-preview'), 'PDF の印が無い').toBe('pdf');
    // 出せないブラウザに空白を残さない(断り文を中に置く)
    expect(obj!.textContent, '出せないときの断りが無い').toContain('ダウンロード');
    // ⚠ 「画面に出せません」の断りは**出さない**(出せているので)
    expect(q('p[data-pkc-field="attachment-no-preview"]')).toBeNull();
  });

  it('🔴 PDF にも「別の窓で見る」が出て、種類を運ぶ', async () => {
    const { d, q } = setup({ a1: pdfBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    const view = q('[data-pkc-action="view-asset"]');
    expect(view, 'PDF に「別の窓で見る」が無い').not.toBeNull();
    expect(view!.getAttribute('data-pkc-asset-key')).toBe('ast-pdf');
    expect(view!.getAttribute('data-pkc-asset-mime')).toBe('application/pdf');
    expect(view!.getAttribute('data-pkc-asset-name')).toBe('見積.pdf');
    // ⚠ 何が起きるかが読めること(画像と PDF で言い方を分ける)
    expect(view!.getAttribute('title')).toContain('PDF');
  });

  it('別窓に出せない種類には「別の窓で見る」を出さない(押せない導線を置かない)', async () => {
    const zipBody = attachmentBody({
      name: 'a.zip',
      mime: 'application/zip',
      size: 10,
      assetKey: 'ast-zip',
    });
    const { d, q } = setup({ a1: zipBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(q('[data-pkc-action="view-asset"]'), 'zip に別窓の導線が出ている').toBeNull();
  });
});

/**
 * 🔴 **出せない種類は「出せない」と言う**(2026-08-06。user 報告 minor
 * 「preview を持たない添付は何も出ない」)。
 *
 * 直す前は器が**空のまま**残り、題名と操作だけが並んだ ── 中身が空なのか
 * 出せないのかが区別できず、「壊れている」と読まれる形だった。
 */
describe('preview を持たない添付', () => {
  const lender: AssetLender = {
    lend: async () => ({ url: 'blob:x', dispose: () => {} }),
    getBlob: async () => new Blob(['x']),
  };
  const zipBody = attachmentBody({
    name: '一式.zip',
    mime: 'application/zip',
    size: 999,
    assetKey: 'ast-zip',
  });
  /**
   * ⚠ **`text/html` はここへ来ない** ── `text/` は文字の preview を持つので
   * `<pre>` が出る。案内が出るのは「起動できるのに画面には出せない」形、
   * つまり `application/xhtml+xml`(と mime 未設定)である。
   */
  const htmlBody = attachmentBody({
    name: '道具.xhtml',
    mime: 'application/xhtml+xml',
    size: 120,
    assetKey: 'ast-html2',
  });
  const imgBody = attachmentBody({
    name: 'p.png',
    mime: 'image/png',
    size: 3,
    assetKey: 'ast-img2',
  });

  it('🔴 案内が出る(黙って空にしない)', async () => {
    const { d, q } = setup({ a1: zipBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    const note = q('[data-pkc-field="attachment-no-preview"]');
    expect(note, '出せない種類で何も出ていない').not.toBeNull();
    // ⚠ 次にどうすればよいかが書いてある(「出せません」だけで終わらせない)
    expect(note!.textContent).toContain('ダウンロード');
  });

  it('HTML は起動があるので、そちらを案内する(同じ文で済ませない)', async () => {
    const { d, q } = setup({ a1: htmlBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(q('[data-pkc-field="attachment-no-preview"]')!.textContent).toContain('起動');
  });

  it('出せる種類には案内を出さない(邪魔をしない)', async () => {
    const { d, q } = setup({ a1: imgBody, a2: '# text' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(q('[data-pkc-field="attachment-media"]'), '画像が出ていない').not.toBeNull();
    expect(q('[data-pkc-field="attachment-no-preview"]'), '出せているのに案内が出た').toBeNull();
  });
});
