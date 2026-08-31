/** @vitest-environment happy-dom */
/**
 * P6f: 「書き出す」と「削除」を**隣に並べた**ことで生まれた縁を pin する。
 *
 * 🔴 変異試験で 3 件が**誰にも守られていなかった**(review M-1〜M-3)。
 * どれも「書き出したつもりでファイルが落ちていない」に直結する。
 */
import { describe, expect, it, vi } from 'vitest';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import {
  exportArchive,
  exportEntry,
  exportEntryDocx,
  exportEntryPptx,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import { answerDialog } from './dialog-helper';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import {
  renderMarkdown,
  type RenderMarkdownOptions,
} from '../../src/features/markdown/markdown-render';

function source(over: Partial<ArchiveSource> = {}): ArchiveSource {
  return {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => [
      {
        lid: 'n1',
        title: 'ノート',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
    ],
    listBodies: async () => ({ rows: [{ lid: 'n1', body: 'x' }], done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
    ...over,
  };
}

function deps(
  src: ArchiveSource,
  settle: () => Promise<void> = async () => {},
): ExportDeps & { files: string[] } {
  const files: string[] = [];
  return {
    source: src,
    download: (name) => files.push(name),
    report: () => {},
    settle,
    // ⚠ 既定は「焼けない」── 図を見る test は自分で差し替える
    // ⚠ ベクタは使わない腕(ラスタ経路を通す)
    renderFigureVector: async () => null,
    renderFigure: async () => null,
    now: () => new Date('2026-08-02T00:00:00Z'),
    files,
  };
}

const fakeDispatcher = (phase: string) => {
  const dispatched: Array<{ type: string; error?: string }> = [];
  return {
    dispatched,
    dispatcher: {
      getState: () => ({ phase }),
      dispatch: (a: { type: string; error?: string }) => dispatched.push(a),
    } as unknown as Dispatcher,
  };
};

describe('1 ノート書出し — 断るなら読む前に断る', () => {
  it('🔴 編集中は store を**1 度も読まずに**断る', async () => {
    // ガードが読みの後ろにあると「30MB 読んでから編集中ですと言う」になり、
    // さらに読みの途中で編集が確定すると body と鎖の基準 tip が別時刻になる
    const getBody = vi.fn(async () => 'x');
    const listBodies = vi.fn(async () => ({ rows: [], done: true }));
    const { dispatcher, dispatched } = fakeDispatcher('editing');
    const d = deps(source({ getBody, listBodies }));

    expect(await exportEntry(dispatcher, d, 'n1', 'archive')).toBeNull();
    expect(getBody).not.toHaveBeenCalled();
    expect(listBodies).not.toHaveBeenCalled();
    expect(d.files).toHaveLength(0);
    expect(dispatched[0]).toMatchObject({ type: 'OP_FAILED' });
  });

  it('ready なら読んで書き出す', async () => {
    const { dispatcher } = fakeDispatcher('ready');
    const d = deps(source());
    expect(await exportEntry(dispatcher, d, 'n1', 'archive')).toBe(1);
    expect(d.files[0]).toMatch(/\.pkc3\.zip$/);
  });
});

describe('削除と書出しの排他', () => {
  /** binder だけを立てて、削除 action の振る舞いを見る。 */
  function setup(services: BinderServices) {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-entry="n1">' +
      '<button data-pkc-action="delete-entry">削除</button>' +
      '<button data-pkc-action="export-entry">書き出す</button>' +
      '</div>';
    document.body.append(root);
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'n1',
          title: 'ノート',
          archetype: 'text',
          createdAt: null,
          updatedAt: null,
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        },
      ],
      relations: [],
    });
    const events: string[] = [];
    d.onEvent(() => {});
    const orig = d.dispatch.bind(d);
    d.dispatch = (a: Parameters<typeof orig>[0]) => {
      events.push(a.type);
      return orig(a);
    };
    bindActions(root, d, services);
    return { root, d, events };
  }

  it('🔴 書出しの実行中は削除を断る(走査の途中で対象が消えない)', () => {
    // 「書き出す」を押した直後に「削除」を押せると、走査中に entry が消えて
    // 書出しが失敗する ── user は書き出したつもりでファイルが 1 個も無い
    vi.stubGlobal('confirm', () => true);
    const { root, events } = setup({ busy: () => true });
    root.querySelector<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    expect(events).toContain('OP_FAILED');
    expect(events).not.toContain('DELETE_ENTRY');
    vi.unstubAllGlobals();
  });

  /**
   * ⚠ **確認はアプリ自身のダイアログ**(#299 段②)── `confirm` を差し替えても
   *   呼ばれない。押す口はページの中に在る。
   */
  it('実行中でなければ削除できる', async () => {
    const { root, events } = setup({ busy: () => false });
    root.querySelector<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    await answerDialog('ok');
    expect(events).toContain('DELETE_ENTRY');
  });
});

describe('書き出す対象の解決', () => {
  it('🔴 行から closest で引く(削除と**同じ規則**)', () => {
    // 片方だけ selectedLid 固定だと、filer / sidebar の行に並べた瞬間に
    // 「A を書き出して B を削除する」が成立する
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-entry="other"><button data-pkc-action="export-entry">書き出す</button></div>';
    document.body.append(root);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const asked: string[] = [];
    bindActions(root, d, { exportEntry: (lid) => asked.push(lid) });
    root.querySelector<HTMLElement>('[data-pkc-action="export-entry"]')!.click();
    // selectedLid は null のまま ── closest を見ていなければ 1 件も来ない
    expect(asked).toEqual(['other']);
  });

  /**
   * 🔴 **Word も同じ規則で引く**(#187 段①)。⚠ 隣に並ぶボタンなので、片方だけ
   * `selectedLid` 固定にすると「**A を Word にして B を消す**」が成立する。
   * ⚠ この test を足したのは、変異試験で「いつも選択中のノートにする」が
   * **smoke では生き延びた**からである(情報ペインでは行と選択が必ず一致するので
   * 差が出ない ── 差が出る入力をここで作る)。
   */
  it('🔴 Word の書き出しも行から closest で引く', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-entry="other"><button data-pkc-action="export-entry-docx">Word</button></div>';
    document.body.append(root);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const asked: string[] = [];
    bindActions(root, d, { exportEntryDocx: (lid) => asked.push(lid) });
    root.querySelector<HTMLElement>('[data-pkc-action="export-entry-docx"]')!.click();
    expect(asked).toEqual(['other']);
  });

  /** 🔴 **PowerPoint も同じ規則で引く**(#187 段⑤)── 隣に並ぶ 4 つ目のボタンである。 */
  it('🔴 PowerPoint の書き出しも行から closest で引く', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-entry="other"><button data-pkc-action="export-entry-pptx">PowerPoint</button></div>';
    document.body.append(root);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const asked: string[] = [];
    bindActions(root, d, { exportEntryPptx: (lid) => asked.push(lid) });
    root.querySelector<HTMLElement>('[data-pkc-action="export-entry-pptx"]')!.click();
    expect(asked).toEqual(['other']);
  });
});

/**
 * P8 段㉑: 🔴 **本文を書き換える入口を、まとめて止める**。
 *
 * 🔴 直す前この判定は `delete-entry` **1 か所だけ**にあった。書出しは本文を
 * 4MB ずつページングして(`await` を跨ぐ)、そのあとで履歴の鎖を引くので、
 * バッチの隙間に保存が割り込むと **本文は旧版・鎖の頭は新 tip 基準**という
 * 噛み合わないアーカイブができる。取り込み直すと「履歴が噛み合いません」だけが
 * 出て、そのノートの履歴が丸ごと落ちる(title / status は検査が無いので黙って旧値)。
 * 「削除は止めるのに保存は止めない」= 同じ危険に入口ごとに別の答えを出していた。
 *
 * ⚠ 観測点は**入口ごと**。1 つでも素通しなら、そこから壊れる。
 */
describe('書出し中に本文を書き換えられない', () => {
  /** 本文を書き換える入口を**全部**並べた root を作る。 */
  function setupAll(busy: boolean) {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-pkc-entry="n1">' +
      '<button data-pkc-action="start-edit">編集</button>' +
      '<button data-pkc-action="commit-edit">保存</button>' +
      '<button data-pkc-action="append-entry">追記</button>' +
      '<button data-pkc-action="toggle-todo">済</button>' +
      '<button data-pkc-action="delete-entry">削除</button>' +
      '<button data-pkc-action="restore-trash" data-pkc-rev-id="r1" data-pkc-trash-lid="n1">復元</button>' +
      '<button data-pkc-action="purge-trash">空にする</button>' +
      '</div>';
    document.body.append(root);
    const d = new Dispatcher();
    const events: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = (a: Parameters<typeof orig>[0]) => {
      events.push(a.type);
      return orig(a);
    };
    bindActions(root, d, { busy: () => busy });
    return { root, events };
  }

  const ENTRIES = [
    'start-edit',
    'commit-edit',
    'append-entry',
    'toggle-todo',
    'delete-entry',
    'restore-trash',
    'purge-trash',
  ];

  it.each(ENTRIES)('🔴 書出しの実行中は「%s」を可視に断る', (action) => {
    vi.stubGlobal('confirm', () => true);
    const { root, events } = setupAll(true);
    root.querySelector<HTMLElement>(`[data-pkc-action="${action}"]`)!.click();
    expect(events, `${action} が無言で素通りしている`).toContain('OP_FAILED');
    vi.unstubAllGlobals();
  });

  /**
   * ⚠ **空振り防止** ── 常時 OP_FAILED を出す実装でも上は通る。
   * 実行中でなければ**同じ押し方で通る**ことを見る。
   */
  it('⚠ 実行中でなければ、同じ入口が通る', () => {
    vi.stubGlobal('confirm', () => true);
    const { root, events } = setupAll(false);
    root.querySelector<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    expect(events, '実行中でないのに断っている').not.toContain('OP_FAILED');
    expect(events).toContain('START_EDIT');
    vi.unstubAllGlobals();
  });
});

/**
 * 🔴 **保存の直後に押しても、保存した本文が出る**(2026-08-17 に実測で判明)。
 *
 * 書込は effect 層の **1 本の chain に直列化**されるが、書き出しの読みは
 * **その外**に居る ── `getBody` は並んでいる書込を**追い越す**。
 * 実測(`vite preview` + 実ブラウザ、保存して 90ms 後に Word を押す):
 * **11/12 が保存前の本文**を書き出した(800ms 待つ対照群は 0/12)。
 * worker への命令の順番は `upsertEntry`(改名)→ **`getBody`(書き出し)** →
 * `upsertEntry`(本文)で、改名の書込が 67ms かかる間に読みが割り込んでいた。
 *
 * ⚠ **入口ごとに見る**(CLAUDE.md §7)── 3 つの出口はそれぞれ別の場所で読むので、
 * 代表 1 つの test は他の 2 つを 1 度も通らない。
 * ⚠ 観測点は「`settle()` を呼んだか」ではなく **落ちてきた file の中身**にする ──
 * 呼んだだけで読みの**前**でなければ意味が無い。
 */
describe('書き出しは、飛んでいる書込が着地してから読む', () => {
  const OLD = '古い本文';
  const NEW = '保存した本文';

  /** `settle()` が解けるまで**古い本文**を返す store(= 書込が飛んでいる状態)。 */
  function lagging(): { src: ArchiveSource; settle: () => Promise<void> } {
    let landed = false;
    const body = (): string => (landed ? NEW : OLD);
    return {
      settle: async () => {
        landed = true;
      },
      src: source({
        getBody: async () => body(),
        listBodies: async () => ({ rows: [{ lid: 'n1', body: body() }], done: true }),
      }),
    };
  }

  /** 落ちてきた file を捕まえる deps。 */
  function catching(src: ArchiveSource, settle: () => Promise<void>) {
    const got: Blob[] = [];
    return {
      got,
      d: {
        ...deps(src, settle),
        download: (_name: string, blob: Blob) => got.push(blob),
        renderBody: async (text: string) => `<p>${text}</p>`,
      } as unknown as ExportDeps & { files: string[] },
    };
  }

  it('🔴 Word(#187)── 保存前の本文を書き出さない', async () => {
    const { src, settle } = lagging();
    const { d, got } = catching(src, settle);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    expect(await got[0]!.text(), '保存前の本文が入っている').toContain(NEW);
  });

  it('🔴 1 ノートのアーカイブ(P6f)── 保存前の本文を書き出さない', async () => {
    const { src, settle } = lagging();
    const { d, got } = catching(src, settle);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntry(dispatcher, d, 'n1', 'archive')).toBe(1);
    expect(await got[0]!.text(), '保存前の本文が入っている').toContain(NEW);
  });

  it('🔴 まとめての書き出し(P6d)── 保存前の本文を書き出さない', async () => {
    const { src, settle } = lagging();
    const { d, got } = catching(src, settle);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportArchive(dispatcher, d, 'archive')).toBe(1);
    expect(await got[0]!.text(), '保存前の本文が入っている').toContain(NEW);
  });

  /**
   * ⚠ **空振り防止** ── 上の 3 件は「`settle()` が本文を新しくする」という
   * 仕掛けに乗っている。待たなければ**本当に古い本文が出る**ことを 1 度見ておく
   * (見ないと、fake が常に新しい本文を返していても緑になる)。
   */
  it('⚠ 待たなければ古い本文が出る(仕掛けが効いていることの確認)', async () => {
    const { src, settle } = lagging();
    const { d, got } = catching(src, settle);
    const { dispatcher } = fakeDispatcher('ready');
    await exportEntryDocx(dispatcher, { ...d, settle: async () => {} }, 'n1');
    expect(await got[0]!.text()).toContain(OLD);
  });
});

/**
 * 🔴 **Word に画像を入れる**(#187 段②)の adapter 側。
 *
 * ⚠ 組み立ての規則(EMU / 縦横比 / rels)は `tests/features/docx-export.test.ts` が
 * 見る。ここが見るのは **adapter にしか無い所** ── 添付の bytes を解いて
 * `word/media/*` として zip に足し、解けなかったものを**理由つきで残す**こと。
 * ⚠ この経路は smoke でも通らない(smoke のノートに添付が無い)。
 */
describe('Word の画像(#187 段②)', () => {
  /** 1×1 の PNG(67 バイト)。 */
  const PNG = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );

  /** 添付 1 件を持つノート(本文は `<img data-pkc-asset-key>` を返す)。 */
  function setup(over: { blob?: Blob | null; size?: { w: number; h: number } | null } = {}) {
    const got: Blob[] = [];
    const src = source({
      getBody: async () => '![図](asset:ast-1)',
      getAssetBlob: async () =>
        over.blob === undefined ? new Blob([PNG], { type: 'image/png' }) : over.blob,
    });
    const d = {
      ...deps(src),
      download: (_n: string, blob: Blob) => got.push(blob),
      renderBody: async () =>
        '<p><img data-pkc-asset-key="ast-1" data-pkc-asset-name="図.png" alt="図"></p>',
    } as unknown as ExportDeps;
    // ⚠ happy-dom は `createImageBitmap` を持たない ── 実寸を返す口を立てる
    //   (`null` を渡す arm は「読めなかった」の再現)
    const size = over.size === undefined ? { w: 1200, h: 900 } : over.size;
    (globalThis as unknown as Record<string, unknown>).createImageBitmap = async () => {
      if (size === null) throw new Error('decode failed');
      return { width: size.w, height: size.h, close: () => {} };
    };
    return { d, got };
  }

  it('🔴 添付が word/media に入り、document がそれを指す', async () => {
    const { d, got } = setup();
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(text, 'zip に画像が入っていない').toContain('word/media/image1.png');
    // ⚠ VML なので `r:id`(#238 で DrawingML から移した)
    expect(text, 'document が画像を指していない').toContain('r:id="rIdM1"');
    expect(text, '本文が「写せませんでした」のまま').not.toContain('写せませんでした');
  });

  it('🔴 bytes が取れなければ、理由を残して本文を続ける(黙って消さない)', async () => {
    const { d, got } = setup({ blob: null });
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(text).not.toContain('word/media/');
    expect(text, '落ちたことがどこにも書かれていない').toContain('写せませんでした');
  });

  it('🔴 大きさが読めなければ入れない(潰れた図を出さない)', async () => {
    const { d, got } = setup({ size: null });
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(text).not.toContain('word/media/');
    expect(text).toContain('大きさを読めませんでした');
  });

  it('🔴 Word が読めない形式は入れず、形式名を出す', async () => {
    const { d, got } = setup({ blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }) });
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(text).not.toContain('word/media/');
    expect(text).toContain('image/svg+xml');
  });
});

/**
 * 🔴 **Word の図とグラフ**(#187 段②)。
 *
 * ⚠ 段① は器の中の**原文を等幅で出していた**(PKC2 の失敗の再演)。ここが見るのは
 * 「焼いた PNG が実際に zip に入り、document がそれを指すか」と、
 * **焼けなかったときに理由が残るか**である。
 */
describe('Word の図(#187 段②)', () => {
  const PNG = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );

  /**
   * 図を 1 つ持つノート。
   * @param drawn 焼けた絵(`null` = 焼けなかった)。⚠ **画素は CSS px の 2 倍**に
   *   してある ── 画素をそのまま使う実装だと図が 2 倍の大きさで出る
   */
  function setup(drawn: { cssWidth: number } | null = { cssWidth: 360 }) {
    const got: Blob[] = [];
    const asked: string[] = [];
    const d = {
      ...deps(source({ getBody: async () => '```mermaid\ngraph TD; A-->B\n```' })),
      download: (_n: string, blob: Blob) => got.push(blob),
      renderBody: async () =>
        '<div class="pkc-mermaid-placeholder" data-pkc-mermaid-src="graph TD; A--&gt;B">' +
        '<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre></div>',
      renderFigure: async (kind: string, src: string) => {
        asked.push(`${kind}:${src}`);
        return drawn === null
          ? null
          : { blob: new Blob([PNG], { type: 'image/png' }), cssWidth: drawn.cssWidth };
      },
    } as unknown as ExportDeps;
    (globalThis as unknown as Record<string, unknown>).createImageBitmap = async () => ({
      width: 720,
      height: 480,
      close: () => {},
    });
    return { d, got, asked };
  }

  it('🔴 焼いた図が zip に入り、document がそれを指す(原文を等幅で出さない)', async () => {
    const { d, got, asked } = setup();
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(asked, '図の原文が産出器へ渡っていない').toEqual(['mermaid:graph TD; A-->B']);
    expect(text, '図が zip に入っていない').toContain('word/media/figure1.png');
    // ⚠ VML なので `r:id`(DrawingML の `r:embed` ではない ── #238)
    expect(text, 'document が図を指していない').toContain('r:id="rIdM1"');
    // 🔴 **原文が等幅で出ていない**(PKC2 の失敗の顔)
    expect(text, '図の原文が本文に出ている').not.toContain('graph TD');
    expect(text).not.toContain('描けませんでした');
  });

  it('🔴 大きさは CSS px で入る(焼いた画素をそのまま使うと 2 倍になる)', async () => {
    const { d, got } = setup({ cssWidth: 360 });
    const { dispatcher } = fakeDispatcher('ready');
    await exportEntryDocx(dispatcher, d, 'n1');
    const text = await got[0]!.text();
    // 360 CSS px = 3,429,000 EMU = 270.0pt / 高さは絵の比(720:480)で 240px = 180.0pt
    expect(text, '幅が CSS px でない').toContain('width:270.0pt');
    expect(text, '高さが絵の比で出ていない').toContain('height:180.0pt');
  });

  /**
   * 🔴 **図はベクタ(EMF)で入る**(#238。user 指示 2026-08-17
   * 「フローチャートのようないじれそうなものは emf とか wmf にして欲しい」)。
   *
   * ⚠ ここが無いと、`renderFigureVector` の配線を落としても**ラスタで出るだけ**で
   * 全部緑になる ── user から見ると「拡大すると粗い図」に静かに戻る。
   */
  const VECTOR_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" id="v">' +
    '<style>#v rect{fill:#f5f6f8;stroke:#cdd2d9;}</style>' +
    '<rect x="10" y="10" width="100" height="40"/></svg>';

  it('🔴 図はベクタ(.emf)で zip に入り、document がそれを指す', async () => {
    const { d, got, asked } = setup();
    (d as unknown as { renderFigureVector: (k: string, s: string) => Promise<string | null> }).renderFigureVector =
      async () => VECTOR_SVG;
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(text, 'ベクタで入っていない').toContain('word/media/figure1.emf');
    expect(text, 'ラスタに落ちている').not.toContain('word/media/figure1.png');
    expect(text, 'document が図を指していない').toContain('r:id="rIdM1"');
    // ⚠ **ラスタの産出器は呼ばれない**(2 度描かない)
    expect(asked, 'ベクタが在るのにラスタも焼いている').toEqual([]);
    // 大きさは viewBox から(120x60 px = 90.0 x 45.0 pt)
    expect(text).toContain('width:90.0pt');
  });

  it('🔴 ベクタに起こせない図は**ラスタへ落とす**(図が消えない)', async () => {
    const { d, got, asked } = setup();
    (d as unknown as { renderFigureVector: () => Promise<string | null> }).renderFigureVector = async () =>
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'; // 図形 0 件 → 投げる
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(text, 'ラスタへ落ちていない').toContain('word/media/figure1.png');
    expect(asked, 'ラスタの産出器が呼ばれていない').toHaveLength(1);
    expect(text).not.toContain('描けませんでした');
  });

  it('🔴 焼けなければ、その場に理由が残る(黙って消えない)', async () => {
    const { d, got } = setup(null);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(text).not.toContain('word/media/');
    expect(text).toContain('描けませんでした');
    // ⚠ それでも原文は出さない(出すなら「図の原文」として意図して出す)
    expect(text).not.toContain('graph TD');
  });
});

/**
 * 🔴 **詳細ペインと同じ材料で描く**(#187 段③)。
 *
 * ⚠ 直す前の Word は `render(body)` **だけ**で呼んでいたので:
 * ① **frontmatter が本文として出る**(`---` が水平線、`key: value` が見出しに)
 * ② `{{vars.x}}` が**生のまま**出る ③ `heading-number: true` の番号が付かない
 * ── 閲覧用 HTML が 2026-08-06(user 報告 2-7)で直した**同じ穴**が残っていた。
 *
 * 🔑 だから `renderBody` は**本物のレンダラ**を通す。fake で「渡した opts」を
 * 見るだけだと、opts の**中身が間違っていても**緑になる。
 */
describe('Word は詳細ペインと同じ材料で描く(#187 段③)', () => {
  const BODY =
    '---\nheading-number: true\nvars:\n  who: 世界\n---\n\n# 見出し\n\nこんにちは {{vars.who}}。\n\n+++\n\n次の頁\n';

  async function exportOf(body: string): Promise<string> {
    const got: Blob[] = [];
    const d = {
      ...deps(source({ getBody: async () => body })),
      download: (_n: string, blob: Blob) => got.push(blob),
      // ⚠ **本物**を通す(アプリはワーカー越しに同じ関数を呼ぶ)
      renderBody: async (text: string, opts?: RenderMarkdownOptions) => renderMarkdown(text, opts),
    } as unknown as ExportDeps;
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    return got[0]!.text();
  }

  it('🔴 frontmatter は本文に出ない', async () => {
    const text = await exportOf(BODY);
    expect(text, 'frontmatter の key が本文に出ている').not.toContain('heading-number');
    expect(text, '本文が入っていない').toContain('こんにちは');
  });

  it('🔴 {{vars}} が値に置き換わる(生のまま配らない)', async () => {
    const text = await exportOf(BODY);
    expect(text).toContain('世界');
    expect(text, 'vars が生のまま出ている').not.toContain('{{vars.who}}');
  });

  it('🔴 見出し番号が付く(画面と同じ見え方)', async () => {
    expect(await exportOf(BODY)).toContain('1. 見出し');
  });

  it('🔴 改頁(+++)が改頁として入る(水平線に化けない)', async () => {
    expect(await exportOf(BODY)).toContain('<w:br w:type="page"/>');
  });

  /**
   * ⚠ **紙面は「渡している」ところまで見る** ── 組み立て側(`buildDocx`)の test は
   * 通っていても、**書き出しが渡さなければ**画面 A3 横 / Word A4 縦になる
   * (変異試験 P11 が実際に生き延びた)。
   */
  it('🔴 画面の紙面設定が Word へ渡っている', async () => {
    const got: Blob[] = [];
    const d = {
      ...deps(source({ getBody: async () => '本文' })),
      download: (_n: string, blob: Blob) => got.push(blob),
      renderBody: async (text: string) => `<p>${text}</p>`,
      pageFormat: 'a3-landscape',
    } as unknown as ExportDeps;
    const { dispatcher } = fakeDispatcher('ready');
    await exportEntryDocx(dispatcher, d, 'n1');
    expect(await got[0]!.text(), '紙面が渡っていない(A4 縦のまま)').toContain(
      '<w:pgSz w:w="23811" w:h="16838" w:orient="landscape"/>',
    );
  });
});

/**
 * 🔴 **`:::if{format=docx}` が生きる**(#187 段⑤)。
 *
 * ⚠ この記法は**受理はするが永久に不可視**だった ── 描画が `'html'` 固定で、
 * `format=docx` の塊は**必ず空**になっていた(`markdown-render.ts` の
 * `processIfBlocks(text, lineMap, 'html')`)。Word の出口ができたので、
 * 落ちていた動線が戻る(user 不可侵指示「記法を減らすことは動線を減らすこと」)。
 */
describe('書き出す形式で本文を出し分ける(#187 段⑤)', () => {
  const BODY =
    ':::if{format=docx}\nWord にだけ出る文\n:::\n\n:::if{format=html}\n画面にだけ出る文\n:::\n\nいつも出る文\n';

  it('🔴 Word には docx の塊が入り、html の塊は入らない', async () => {
    const got: Blob[] = [];
    const d = {
      ...deps(source({ getBody: async () => BODY })),
      download: (_n: string, blob: Blob) => got.push(blob),
      renderBody: async (text: string, opts?: RenderMarkdownOptions) => renderMarkdown(text, opts),
    } as unknown as ExportDeps;
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.text();
    expect(text, 'docx 向けの本文が出ていない').toContain('Word にだけ出る文');
    expect(text, '画面向けの本文まで出ている').not.toContain('画面にだけ出る文');
    expect(text, '共通の本文が落ちている').toContain('いつも出る文');
  });

  it('⚠ 画面(既定)は今までどおり html 向け(既定を動かしていない)', () => {
    const html = renderMarkdown(BODY);
    expect(html).toContain('画面にだけ出る文');
    expect(html).not.toContain('Word にだけ出る文');
  });
});

/**
 * 🔴 **PowerPoint の出口**(#187 段⑤)。
 *
 * ⚠ ここが見るのは「純関数が正しいか」ではない(それは `pptx-export.test.ts`)──
 * **押した先が本当に PowerPoint の file を落とすか**である。
 * 🔑 Word と**同じ道**を通す作りにしたので、道が切れていれば
 *   「PowerPoint だけ画像が入らない」という形で出る。
 */
describe('PowerPoint の出口(#187 段⑤)', () => {
  const PNG = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );

  /** 押した結果落ちてきた file(名前と中身)。 */
  async function exportOf(
    body: string,
    over: Partial<ExportDeps> = {},
  ): Promise<{ name: string; text: string }> {
    const got: Array<{ name: string; blob: Blob }> = [];
    const d = {
      ...deps(source({ getBody: async () => body })),
      download: (name: string, blob: Blob) => got.push({ name, blob }),
      renderBody: async (text: string, opts?: RenderMarkdownOptions) => renderMarkdown(text, opts),
      ...over,
    } as unknown as ExportDeps;
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryPptx(dispatcher, d, 'n1'), '書き出しが失敗した').toBe(true);
    expect(got, 'file が 1 つも落ちていない').toHaveLength(1);
    return { name: got[0]!.name, text: await got[0]!.blob.text() };
  }

  it('🔴 .pptx が落ち、見出しでスライドが切れる', async () => {
    const { name, text } = await exportOf('# 章\n\n## 副題\n\n### 節\n\n本文\n');
    expect(name, '拡張子が pptx でない').toMatch(/\.pptx$/);
    expect(text, 'スライドが入っていない').toContain('ppt/slides/slide1.xml');
    // 扉(#)+ 本文(###)で 2 枚
    expect(text, '2 枚目が無い ── 見出しで切れていない').toContain('ppt/slides/slide2.xml');
    expect(text, '3 枚目まで作っている').not.toContain('ppt/slides/slide3.xml');
  });

  it('🔴 書き出したことを「枚数」で知らせる(塊の数では意味が伝わらない)', async () => {
    const said: string[] = [];
    const d = {
      ...deps(source({ getBody: async () => '# 扉\n\n### 節\n\n本文\n' })),
      download: () => {},
      notify: (m: string) => said.push(m),
      renderBody: async (text: string, opts?: RenderMarkdownOptions) => renderMarkdown(text, opts),
    } as unknown as ExportDeps;
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryPptx(dispatcher, d, 'n1')).toBe(true);
    // ⚠ 「書き出しています…」→「書き出しました」の 2 本
    expect(said.at(-1), '枚数で知らせていない').toContain('2 枚');
    expect(said.at(-1), 'PowerPoint と名乗っていない').toContain('PowerPoint');
  });

  it('🔴 編集中は断る(保存したつもりの本文が入らない形を作らない)', async () => {
    const d = deps(source({ getBody: async () => '本文' })) as unknown as ExportDeps;
    const { dispatcher, dispatched } = fakeDispatcher('editing');
    expect(await exportEntryPptx(dispatcher, d, 'n1')).toBe(false);
    expect(dispatched[0]?.error, '断り文が出ていない').toContain('編集を終了');
  });

  it('🔴 添付が ppt/media に入り、スライドがそれを指す', async () => {
    (globalThis as unknown as Record<string, unknown>).createImageBitmap = async () => ({
      width: 200,
      height: 100,
      close: () => {},
    });
    const { text } = await exportOf('![絵](asset:ast-1)', {
      source: source({
        getBody: async () => '![絵](asset:ast-1)',
        getAssetBlob: async () => new Blob([PNG], { type: 'image/png' }),
      }),
      // ⚠ 添付は `data-pkc-asset-key` で拾う(Word 側の test と同じ形)
      renderBody: async () =>
        '<p><img data-pkc-asset-key="ast-1" data-pkc-asset-name="絵.png" alt="絵"></p>',
    });
    expect(text, 'zip に画像が入っていない').toContain('ppt/media/image1.png');
    expect(text, 'スライドが画像を指していない').toContain('<a:blip r:embed=');
    // 🔴 目録に宣言が無いと PowerPoint は **file ごと拒む**
    expect(text, 'png の宣言が無い').toContain('<Default Extension="png"');
    expect(text, '本文が「写せませんでした」のまま').not.toContain('写せませんでした');
  });

  /**
   * 🔴 **図はベクタ(EMF)で入る**(#238 と同じ向き)。
   * ⚠ **`emf` の宣言が無いと PowerPoint は種類を決められない** ── 段⑤ で
   *   `MEDIA_TYPES` に足すまで `application/octet-stream` になっていた。
   */
  it('🔴 図はベクタ(.emf)で入り、目録に emf が宣言される', async () => {
    const VECTOR_SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" id="v">' +
      '<style>#v rect{fill:#f5f6f8;stroke:#cdd2d9;}</style>' +
      '<rect x="10" y="10" width="100" height="40"/></svg>';
    const { text } = await exportOf('```mermaid\ngraph TD; A-->B\n```\n', {
      renderFigureVector: async () => VECTOR_SVG,
    });
    expect(text, 'ベクタで入っていない').toContain('ppt/media/figure1.emf');
    expect(text, '目録に emf の宣言が無い').toContain(
      '<Default Extension="emf" ContentType="image/x-emf"/>',
    );
    // 🔴 **原文が等幅で出ていない**(PKC2 の失敗の顔)
    expect(text, '図の原文が本文に出ている').not.toContain('graph TD');
  });

  it('🔴 ベクタに起こせない図はラスタへ落とす(図が消えない)', async () => {
    (globalThis as unknown as Record<string, unknown>).createImageBitmap = async () => ({
      width: 720,
      height: 480,
      close: () => {},
    });
    const { text } = await exportOf('```mermaid\ngraph TD; A-->B\n```\n', {
      renderFigureVector: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
      renderFigure: async () => ({ blob: new Blob([PNG], { type: 'image/png' }), cssWidth: 360 }),
    });
    expect(text, 'ラスタへ落ちていない').toContain('ppt/media/figure1.png');
    expect(text, 'ベクタが残っている').not.toContain('ppt/media/figure1.emf');
  });

  /**
   * 🔴 **`:::if{format=pptx}` が生きる**(Word の `format=docx` と同じ向き)。
   * ⚠ 渡していなければ「受理はするが永久に不可視」に戻る。
   */
  it('🔴 PowerPoint には pptx の塊が入り、docx / html の塊は入らない', async () => {
    const { text } = await exportOf(
      ':::if{format=pptx}\nスライドにだけ出る文\n:::\n\n' +
        ':::if{format=docx}\nWord にだけ出る文\n:::\n\nいつも出る文\n',
    );
    expect(text, 'pptx 向けの本文が出ていない').toContain('スライドにだけ出る文');
    expect(text, 'Word 向けの本文まで出ている').not.toContain('Word にだけ出る文');
    expect(text, '共通の本文が落ちている').toContain('いつも出る文');
  });
});

/**
 * 🔴 **Word / PowerPoint も、囲みが指す添付を焼き込む**(#444 段②)。
 *
 * ⚠ ここは**画面の DOM を読んでいない** ── `export-archive.ts` は
 *   その場で**もう一度描いて**から塊に畳む。渡さないと、配った .docx にだけ
 *   「このコードブロックの中身は添付に在ります」が残る(持ち出したら中身が消える)。
 */
describe('Word の書き出しでも、囲みが指す添付が入る(#444 段②)', () => {
  const ASSET = 'ヤギ座標系の覚書';

  function withAsset(): ArchiveSource {
    return source({
      listBodies: async () => ({
        rows: [{ lid: 'n1', body: '```js asset:ast-j\n控え\n```' }],
        done: true,
      }),
      getBody: async () => '```js asset:ast-j\n控え\n```',
      listAssetMetas: async () => [
        { key: 'ast-j', mime: 'text/plain', size: ASSET.length, hash: null },
      ],
      getAssetBlob: async (key) =>
        key === 'ast-j'
          ? new Blob([new TextEncoder().encode(ASSET) as unknown as BlobPart])
          : null,
    });
  }

  /** ⚠ 描くのは**本物**(`renderMarkdown`)── stub だと配線を 1 行も検めない。 */
  function catching(src: ArchiveSource) {
    const got: Blob[] = [];
    return {
      got,
      d: {
        ...deps(src),
        download: (_name: string, blob: Blob) => got.push(blob),
        renderBody: async (text: string, opts?: RenderMarkdownOptions) =>
          renderMarkdown(text, opts),
      } as unknown as ExportDeps & { files: string[] },
    };
  }

  it('🔴 添付の字が .docx に入り、控えの字は入らない', async () => {
    const { d, got } = catching(withAsset());
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const xml = await got[0]!.text();
    expect(xml, '添付の中身が届いていない').toContain(ASSET);
    expect(xml, '控えの字を配っている(添付を読んでいない)').not.toContain('控え');
  });

  it('⚠ 添付が読めなければ、その場に理由が出る(黙って空にしない)', async () => {
    const { d, got } = catching(
      source({
        listBodies: async () => ({
          rows: [{ lid: 'n1', body: '```js asset:ast-gone\n控え\n```' }],
          done: true,
        }),
        getBody: async () => '```js asset:ast-gone\n控え\n```',
      }),
    );
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const xml = await got[0]!.text();
    // 🔑 対照群 ── 上の test の「入る」は「いつでも入る」ではない
    expect(xml).toContain('このコードブロックの中身は添付');
  });
});

/**
 * 🔴 **Word / PowerPoint も「読めなかった添付」を注意に出す**(#636)。
 *
 * ⚠ 直す前は `readFenceAssets` に `onSkip` を渡していなかったので、
 *   コードブロックが指す添付が読めなくても **注意は 0 件**だった ── それでいて
 *   マニュアルには「書き出すときに読めなかった理由が残る」と書いて出荷していた
 *   (積んでいたのは閲覧用 HTML だけ)。
 * ⚠ 本文の中には理由が出る(`renderMarkdown` が器に書く)ので、**中身を見る
 *   test では気づけない** ── 見るのは `report` に届いた行である。
 */
describe('Word / PowerPoint — 読めなかった添付の注意(#636)', () => {
  /** `report` を捕まえる腕。`blob` を渡せば「読めた」対照群になる。 */
  function setup(blob: Blob | null) {
    const notes: string[][] = [];
    const src = source({
      getBody: async () => '```csv asset:ast-miss\n控え\n```',
      getAssetBlob: async () => blob,
    });
    const d = {
      ...deps(src),
      report: (n: readonly string[]) => notes.push([...n]),
      renderBody: async (text: string, opts?: RenderMarkdownOptions) =>
        renderMarkdown(text, opts ?? {}),
    } as unknown as ExportDeps;
    return { d, notes };
  }

  it('🔴 読めなかったら、どの添付が欠けたかを report へ渡す', async () => {
    const { d, notes } = setup(null);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    expect(notes, 'report が 1 度も呼ばれていない').toHaveLength(1);
    expect(
      notes[0]!.filter((n) => n.includes('ast-miss')),
      '読めなかった添付が注意に出ていない',
    ).toEqual(['コードブロックが指している添付を焼き込めませんでした(ast-miss): その添付が見つかりません']);
  });

  /**
   * 🔴 **対照群** ── 読めた回は注意が出ない。
   * ⚠ これが無いと「常に何か言っている」実装でも上の test は通る。
   */
  it('読めた添付では、その注意は出ない', async () => {
    const { d, notes } = setup(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }));
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    expect(notes[0]!.filter((n) => n.includes('ast-miss'))).toEqual([]);
  });

  /** ⚠ PowerPoint は別の入口である ── 片方だけ配線が落ちる形を作らない。 */
  it('🔴 PowerPoint でも同じ注意が出る', async () => {
    const { d, notes } = setup(null);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryPptx(dispatcher, d, 'n1')).toBe(true);
    expect(notes[0]!.some((n) => n.includes('ast-miss'))).toBe(true);
  });
});
