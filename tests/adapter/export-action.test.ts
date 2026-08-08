/** @vitest-environment happy-dom */
/**
 * P6d: 書出しの**実行部**(`exportArchive`)。
 *
 * 🔴 この file は review M1 で生まれた。`report` の配線がリファクタで落ちても
 * typecheck / lint / test のどれも鳴らず、「注意 N 件」とだけ出て**中身が消える**
 * 状態が着地していた ── 実行部に test が 1 件も無かったから。
 * writer 側(pkc3-archive / pkc3-html)ではなく、**その手前の配線**を見る。
 */
import { describe, expect, it, vi } from 'vitest';
import { exportArchive, type ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { AppPhase } from '../../src/adapter/state/app-state';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const NOW = new Date('2026-08-02T09:00:00+09:00');

function fakeDispatcher(phase: AppPhase = 'ready'): {
  dispatcher: Dispatcher;
  dispatched: Array<{ type: string; error?: string }>;
} {
  const dispatched: Array<{ type: string; error?: string }> = [];
  const dispatcher = {
    getState: () => ({ phase }),
    dispatch: (a: { type: string; error?: string }) => dispatched.push(a),
  } as unknown as Dispatcher;
  return { dispatcher, dispatched };
}

interface Fake {
  title?: string;
  entries?: Array<{ lid: string; body: string }>;
  /** meta だけあって bytes が無い添付(= 注意が出る)。 */
  missingAsset?: string;
}

function source(f: Fake = {}): ArchiveSource {
  const entries = (f.entries ?? [{ lid: 'n1', body: '本文' }]).map((e, i) => ({
    lid: e.lid,
    title: e.lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
    body: e.body,
  }));
  return {
    cid: 'c1',
    title: f.title ?? 'わたしのノート',
    listEntryMetas: async () =>
      entries.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
    listBodies: async () => ({ rows: entries.map((e) => ({ lid: e.lid, body: e.body })), done: true }),
    listRelations: async () => [],
    listAssetMetas: async () =>
      f.missingAsset
        ? [{ key: f.missingAsset, mime: 'image/png', size: 1, hash: null }]
        : [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

function deps(over: Partial<ExportDeps> = {}): ExportDeps & {
  files: Array<{ name: string; blob: Blob }>;
  notes: string[][];
  messages: string[];
} {
  const files: Array<{ name: string; blob: Blob }> = [];
  const notes: string[][] = [];
  const messages: string[] = [];
  return {
    source: source(),
    download: (name, blob) => files.push({ name, blob }),
    notify: (m) => messages.push(m),
    report: (n) => notes.push([...n]),
    now: () => NOW,
    files,
    notes,
    messages,
    ...over,
  };
}

describe('書出しの実行部 — 注意を握り潰さない', () => {
  it('🔴 注意の**中身**を report へ渡す(件数だけにしない)', async () => {
    const { dispatcher } = fakeDispatcher();
    // 本文が参照している添付の bytes が無い = 一番知りたい注意
    const d = deps({ source: { ...source({ entries: [{ lid: 'n1', body: '![](asset:ast-x)' }] }), listAssetMetas: async () => [{ key: 'ast-x', mime: 'image/png', size: 1, hash: null }], getAssetBlob: async () => null } });
    await exportArchive(dispatcher, d, 'html');
    expect(d.notes).toEqual([['添付の中身が見つかりませんでした: ast-x']]);
    // status 側にも件数は出るが、それは**中身の代わりにはならない**
    expect(d.messages.at(-1)).toContain('⚠ 注意 1 件');
  });

  it('注意が無いときも report は呼ぶ(前回の注意を消せるように)', async () => {
    const { dispatcher } = fakeDispatcher();
    const d = deps();
    await exportArchive(dispatcher, d, 'archive');
    expect(d.notes).toEqual([[]]);
  });
});

describe('書出しの実行部 — 形式ごとの出口', () => {
  it('アーカイブは `.pkc3.zip`、閲覧用は `.html`', async () => {
    const { dispatcher } = fakeDispatcher();
    const a = deps();
    await exportArchive(dispatcher, a, 'archive');
    expect(a.files[0]!.name).toBe('わたしのノート-20260802.pkc3.zip');

    const h = deps();
    await exportArchive(dispatcher, h, 'html');
    expect(h.files[0]!.name).toBe('わたしのノート-20260802.html');
  });

  /**
   * 🔴 **選んだ紙面が書き出しへ届く**(2026-08-08 のレビューで空いていた穴)。
   *
   * 上流(`main.ts` が `pageFormat:` を積む)と下流(`writePortableHtml` が焼く)は
   * どちらも pin されていたが、**中間の受け渡し 1 行**を誰も見ていなかった ──
   * `deps.pageFormat ?? DEFAULT_PAGE_FORMAT` を `DEFAULT_PAGE_FORMAT` に潰す変異が
   * unit 2509 件・smoke 99 件すべて緑で通る。
   * 実害: user が「フル HD」で書いた HTML を配ると、**配った側だけ 42rem に戻る**
   * (書いた本人は自分の画面で確認しないので気づかない)。
   * ⚠ 観測点は **`91rem`**(A3 横にしか無い値)── 既定へ潰す変異を
   *   **代替物で満たせない**(「それらしい値が在る」で通らない)。
   */
  it('🔴 選んだ紙面が書き出した HTML へ届く(既定に潰されない)', async () => {
    const { dispatcher } = fakeDispatcher();
    const d = deps({ pageFormat: 'a3-landscape' });
    await exportArchive(dispatcher, d, 'html');
    const html = await d.files[0]!.blob.text();
    expect(html, '選んだ紙面の読み幅が焼かれていない').toContain('{--read-w:91rem}');
    expect(html, '選んだ紙面の紙が焼かれていない').toContain('@page{size:A3 landscape}');
  });

  it('🔴 閲覧用は「取り込み直せない」と**その場で**言う', async () => {
    // 後から見分けられない形にしない(PKC2 は light / full を manifest にしか
    // 書いておらず、user がどちらを持っているのか分からなくなっていた)
    const { dispatcher } = fakeDispatcher();
    const d = deps();
    await exportArchive(dispatcher, d, 'html');
    expect(d.messages.at(-1)).toContain('取り込み直せません');

    const a = deps();
    await exportArchive(dispatcher, a, 'archive');
    expect(a.messages.at(-1)).not.toContain('取り込み直せません');
  });

  it('🔴 md ZIP は**何が落ちるか**を件数で言う(「片道です」だけにしない)', async () => {
    const { dispatcher } = fakeDispatcher();
    const withLoss: ArchiveSource = {
      ...source(),
      listRelations: async () => [
        { id: 'r1', from_lid: 'a', to_lid: 'b', kind: 'link', created_at: null, updated_at: null },
      ],
      listRevisionLids: async () => ['n1', 'n2'],
    };
    const d = deps({ source: withLoss });
    await exportArchive(dispatcher, d, 'markdown');
    expect(d.files[0]!.name).toBe('わたしのノート-20260802.md.zip');
    expect(d.messages.at(-1)).toContain('片道');
    expect(d.messages.at(-1)).toContain('関連 1');
    expect(d.messages.at(-1)).toContain('履歴 2 件ぶん');
  });

  it('落ちるものが無いなら「取り込み直せません」とだけ言う', async () => {
    const { dispatcher } = fakeDispatcher();
    const d = deps();
    await exportArchive(dispatcher, d, 'markdown');
    expect(d.messages.at(-1)).toContain('取り込み直せません');
    expect(d.messages.at(-1)).not.toContain('関連');
  });

  it('既定はアーカイブ(呼び出し側が省いても閲覧用にならない)', async () => {
    const { dispatcher } = fakeDispatcher();
    const d = deps();
    await exportArchive(dispatcher, d);
    expect(d.files[0]!.name).toMatch(/\.pkc3\.zip$/);
  });
});

describe('書出しの実行部 — 断るべきときに断る', () => {
  it('編集中は書き出さない(保存前の本文が入った物を作らない)', async () => {
    const { dispatcher, dispatched } = fakeDispatcher('editing');
    const d = deps();
    expect(await exportArchive(dispatcher, d)).toBeNull();
    expect(d.files).toHaveLength(0);
    expect(dispatched[0]).toMatchObject({ type: 'OP_FAILED' });
  });

  it('🔴 失敗したら**壊れたファイルを落とさない**', async () => {
    const { dispatcher, dispatched } = fakeDispatcher();
    const d = deps({ source: source({ entries: [] }) }); // entry 0 件 = writer が断る
    expect(await exportArchive(dispatcher, d, 'html')).toBeNull();
    expect(d.files).toHaveLength(0);
    expect(dispatched[0]?.error).toMatch(/書き出しに失敗しました/);
  });

  it('🔴 断るのは**読み出しの前**(捨てるためだけに store を舐めない)', async () => {
    // ⚠ 「添付を base64 にしないこと」で pin しようとしたが、参照ゼロの添付は
    // そもそも載らない(keep-set)ので**空回りする test** だった ── 実測で判明。
    // 0 件のときに実際に残るコストは本文の読み出しなので、そこを見る
    const { dispatcher } = fakeDispatcher();
    const listBodies = vi.fn(async () => ({ rows: [], done: true }));
    const empty: ArchiveSource = { ...source({ entries: [] }), listBodies };
    for (const kind of ['html', 'archive', 'markdown'] as const) {
      listBodies.mockClear();
      expect(await exportArchive(dispatcher, deps({ source: empty }), kind)).toBeNull();
      expect(listBodies).not.toHaveBeenCalled();
    }
  });
});

describe('書出しの実行部 — ファイル名', () => {
  it.each([
    ['a/b:c*d?e"f<g>h|i', 'a-b-c-d-e-f-g-h-i'],
    ['   ', 'pkc3'], // 空にすると「.pkc3.zip」だけの隠しファイルになる
    ['メモ 🎉', 'メモ-🎉'], // サロゲートペアを割らない
  ])('%j → %j', async (title, expected) => {
    const { dispatcher } = fakeDispatcher();
    const d = deps({ source: source({ title }) });
    await exportArchive(dispatcher, d);
    expect(d.files[0]!.name).toBe(`${expected}-20260802.pkc3.zip`);
  });
});
