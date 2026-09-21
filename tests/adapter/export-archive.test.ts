/**
 * 🔴 **file の型は「含まれる型の積」**(#1017 段④b)。
 *
 * ここで見るのは **adapter の実行部**(`exportArchive` / `exportEntry` /
 * `exportFolder`)── どの scope でどの末尾が付くか、そして
 * **保存領域に問題があるとき、自動で `.pkc3-part.zip` へ倒れるか**。
 *
 * ⚠ writer 自体(`writeArchive` の中身)は `tests/features/pkc3-archive.test.ts` が
 * 見る。ここは「呼び出し方に応じて、正しい末尾・正しいフォールバックが選ばれるか」
 * だけを見る(層をまたいで同じことを 2 度見ない)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  exportArchive,
  exportEntry,
  exportFolder,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import {
  forgetRescueWritten,
  lastRescueWritten,
  type RescuePageLike,
} from '../../src/features/storage/rescue-archive';

/**
 * 1 件だけ持つ、素直な `ArchiveSource`。
 * ⚠ **`folder: true`** で `lid: 'box'`(archetype `folder`)も足す ──
 *   `folderSource` は archetype が `folder` の相手しか受けない(§「無い物を作りかけた」の
 *   同型を、fixture 側で踏むところだった)。
 */
function fakeSource(opts: { readonly fail?: string; readonly folder?: boolean } = {}): ArchiveSource {
  const boom = (): never => {
    throw new Error(opts.fail ?? 'boom');
  };
  return {
    cid: 'c1',
    title: 'テスト container',
    listEntryMetas: opts.fail
      ? boom
      : async () => [
          {
            lid: 'a',
            title: 'ノート A',
            archetype: 'text',
            created_at: null,
            updated_at: null,
            entry_order: 1,
            status: null,
            date: null,
            archived: 0,
          },
          ...(opts.folder
            ? [
                {
                  lid: 'box',
                  title: 'フォルダ箱',
                  archetype: 'folder',
                  created_at: null,
                  updated_at: null,
                  entry_order: 2,
                  status: null,
                  date: null,
                  archived: 0,
                },
              ]
            : []),
        ],
    listBodies: async () => ({
      rows: opts.folder
        ? [
            { lid: 'a', body: '本文' },
            { lid: 'box', body: '' },
          ]
        : [{ lid: 'a', body: '本文' }],
      done: true,
    }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

/** 最小の `ExportDeps`。呼び側が要る分だけ上書きする。 */
function baseDeps(overrides: Partial<ExportDeps> = {}): {
  deps: ExportDeps;
  downloaded: Array<{ name: string; blob: Blob }>;
  notices: string[];
} {
  const downloaded: Array<{ name: string; blob: Blob }> = [];
  const notices: string[] = [];
  const deps: ExportDeps = {
    source: fakeSource(),
    download: (name, blob) => downloaded.push({ name, blob }),
    report: () => {},
    settle: async () => {},
    renderFigure: async () => null,
    renderFigureVector: async () => null,
    notify: (m) => notices.push(m),
    now: () => new Date('2026-09-21T00:00:00.000Z'),
    ...overrides,
  };
  return { deps, downloaded, notices };
}

function readyDispatcher(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return d;
}

/** 壊れた DB を模す `rescue.pick`(#971 段③の実測と同じ形で 1 行だけ返す)。 */
function fakeRescuePick(): (after: number, chunks: number) => Promise<RescuePageLike> {
  return async () => ({
    rows: [{ rowid: 1, lid: 'r1', title: '拾えたノート', archetype: 'text', body: '拾えた本文' }],
    lastRowid: 1,
    skipped: 0,
    empty: 0,
    maxRowid: 1,
    done: true,
  });
}

describe('末尾の使い分け(#1017 段④b)', () => {
  it('🔴 コレクション全体は既定で .pkc3-full.zip', async () => {
    const { deps, downloaded } = baseDeps();
    const n = await exportArchive(readyDispatcher(), deps, 'archive');
    expect(n).toBe(1);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.name.endsWith('.pkc3-full.zip'), downloaded[0]!.name).toBe(true);
  });

  it('🔴 1 ノートの書出しは .pkc3-notes.zip(exportEntry)', async () => {
    const { deps, downloaded } = baseDeps();
    const d = readyDispatcher();
    await exportEntry(d, deps, 'a', 'archive');
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.name.endsWith('.pkc3-notes.zip'), downloaded[0]!.name).toBe(true);
  });

  it('🔴 フォルダの書出しも .pkc3-notes.zip(exportFolder)', async () => {
    const { deps, downloaded } = baseDeps({ source: fakeSource({ folder: true }) });
    const d = readyDispatcher();
    await exportFolder(d, deps, 'box');
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.name.endsWith('.pkc3-notes.zip'), downloaded[0]!.name).toBe(true);
  });

  it('⚠ Markdown / 閲覧用 HTML は形式が変わらない(拡張子まで pin)', async () => {
    const { deps: mdDeps, downloaded: mdOut } = baseDeps();
    await exportArchive(readyDispatcher(), mdDeps, 'markdown');
    expect(mdOut[0]!.name.endsWith('.md.zip')).toBe(true);

    const { deps: htmlDeps, downloaded: htmlOut } = baseDeps({ renderBody: async () => '<p>x</p>' });
    await exportArchive(readyDispatcher(), htmlDeps, 'html');
    expect(htmlOut[0]!.name.endsWith('.html')).toBe(true);
  });
});

describe('保存領域に問題があるとき、自動で .pkc3-part.zip へ倒れる(#1017 段④b)', () => {
  it('🔴 バックアップが corrupt の綴りで落ちたら、拾い出しへ切り替わる(対照群:立っていなければ full)', async () => {
    // 対照群 ── rescue が無くても corrupt でもなければ普通に full.zip が出る
    const control = baseDeps();
    await exportArchive(readyDispatcher(), control.deps, 'archive');
    expect(control.downloaded[0]!.name.endsWith('.pkc3-full.zip')).toBe(true);

    // 本題 ── corrupt の綴りで落ち、rescue が渡っている
    const { deps, downloaded, notices } = baseDeps({
      source: fakeSource({ fail: 'database disk image is malformed' }),
      rescue: { pick: fakeRescuePick() },
    });
    const n = await exportArchive(readyDispatcher(), deps, 'archive');
    expect(n, '倒れた結果の件数を返していない').toBe(1);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.name.endsWith('.pkc3-part.zip'), downloaded[0]!.name).toBe(true);
    // 🔑 §5 の検算:通知に「入っていません」が出る
    const notified = notices.join('\n');
    expect(notified, 'つながり・履歴が入っていないことを言っていない').toContain(
      'つながりと履歴は入っていません',
    );
  });

  it('🔴 Markdown も同じ理由で .pkc3-part.zip へ倒れる', async () => {
    const { deps, downloaded, notices } = baseDeps({
      source: fakeSource({ fail: 'sqlite result code 11' }),
      rescue: { pick: fakeRescuePick() },
    });
    await exportArchive(readyDispatcher(), deps, 'markdown');
    expect(downloaded[0]!.name.endsWith('.pkc3-part.zip')).toBe(true);
    expect(notices.join('\n')).toContain('つながりと履歴は入っていません');
  });

  it('⚠ corrupt でない失敗は倒れない(大きすぎる、を壊れていると偽らない)', async () => {
    const { deps } = baseDeps({
      source: fakeSource({ fail: 'RangeError: Invalid array buffer length' }),
      rescue: { pick: fakeRescuePick() },
    });
    const d = readyDispatcher();
    const n = await exportArchive(d, deps, 'archive');
    expect(n, '倒れずに失敗として返すべき').toBeNull();
    expect(d.getState().error, '失敗が画面に出ていない').toContain('書き出しに失敗しました');
  });

  it('⚠ rescue が渡っていなければ倒れない(deps.rescue 省略時)', async () => {
    const { deps } = baseDeps({ source: fakeSource({ fail: 'database disk image is malformed' }) });
    const d = readyDispatcher();
    const n = await exportArchive(d, deps, 'archive');
    expect(n).toBeNull();
    expect(d.getState().error).toContain('書き出しに失敗しました');
  });

  it('🔴 1 ノート・フォルダの書出しは、corrupt でも倒れない(archiveScope が notes)', async () => {
    // ⚠ exportEntry / exportFolder は絞り込みの読み(singleEntrySource / folderSource)
    //   自体が同じ理由で落ちるので、拾い出しの対象にしない(ExportDeps.rescue の docstring)。
    const pick = vi.fn(fakeRescuePick());
    const { deps } = baseDeps({
      source: fakeSource({ fail: 'database disk image is malformed' }),
      rescue: { pick },
    });
    const d = readyDispatcher();
    const n = await exportEntry(d, deps, 'a', 'archive');
    expect(n, 'notes scope では倒れずに失敗するべき').toBeNull();
    // 🔑 拾い出しの口が 1 度も呼ばれていないこと(倒れる経路にすら入っていない)
    expect(pick, '1 ノートの書出しなのに拾い出しへ切り替わった').not.toHaveBeenCalled();
  });

  /**
   * 🔴 **上と同じ主張を、`exportArchive` の門そのものに当てる**(変異試験 3 が
   * SURVIVED で教えた)。
   *
   * ⚠ 上のテストは `exportEntry` 経由なので、`singleEntrySource` の読みが
   *   **`exportArchive` の中の try/catch に入る前**に落ちる ── つまり
   *   `archiveScope === 'full'` の門を 1 度も通らずに `null` が返っていた。
   *   `archiveScope === 'full' ? … : null` を丸ごと `await fallbackToRescueArchive(...)`
   *   に置き換える変異を当てても、上のテストは**通ったまま**だった
   *   (CLAUDE.md §2「経路が一度も通っていない」)。
   * 🔑 ここでは `exportArchive` を**直接** `archiveScope: 'notes'` で呼び、
   *   `writeArchive` そのものが corrupt の綴りで落ちる形にする ── これで
   *   門は必ず評価される。
   */
  it('🔴 `exportArchive` を直接 notes scope で呼んでも、corrupt では倒れない', async () => {
    const pick = vi.fn(fakeRescuePick());
    const { deps, downloaded } = baseDeps({
      source: fakeSource({ fail: 'database disk image is malformed' }),
      rescue: { pick },
    });
    const d = readyDispatcher();
    const n = await exportArchive(d, deps, 'archive', [], 'notes');
    expect(n, 'notes scope では倒れずに失敗するべき').toBeNull();
    expect(downloaded, '倒れて .pkc3-part.zip を落としてしまった').toHaveLength(0);
    expect(pick, 'notes scope なのに拾い出しへ切り替わった').not.toHaveBeenCalled();
    expect(d.getState().error).toContain('書き出しに失敗しました');
  });
});

/**
 * 🔴 **専用の「拾って、戻せる形で書き出す」ボタンを退役させた後も、
 * 「入れ物を捨てる」画面の門(#986 段③)が二度と開かないままにならないか**
 * (#1017 段④b)。
 *
 * ⚠ その門は `container-reset.ts` の `resetExplainMessage` が
 * `lastRescueWritten()` を読んで開く ── 直す前は、そこへ書き込む唯一の道が
 * **退役させた専用ボタン**だった。書かなくなった状態で退役させると、
 * **健全な入れ物でも「入れ物を捨てる」画面が永久に「まだ拾い出していません」と
 * 言い続ける**(門が構造から開かなくなる ── CLAUDE.md §7「読む側と書く側で、
 * 門の段数が違う」の逆:**書く側を削って読む側だけ残した**形)。
 *
 * 🔑 ここで見るのは「代わりに何が書き込むか」だけ ──
 * `resetExplainMessage` 自体の文言は `tests/adapter/container-reset-ui.test.ts` /
 * `tests/features/container-reset.test.ts` が見る(層をまたいで 2 度見ない)。
 */
describe('普通のバックアップも、「入れ物を捨てる」画面の記録へ届く(#1017 段④b / #986 段③)', () => {
  beforeEach(() => {
    forgetRescueWritten();
  });

  it('🔴 コレクション全体のバックアップが普通に成功しても記録する', async () => {
    expect(lastRescueWritten(), '前の it の記録が残っている').toBeNull();
    const { deps } = baseDeps();
    await exportArchive(readyDispatcher(), deps, 'archive');
    const rescued = lastRescueWritten();
    expect(rescued, '普通に成功したのに記録していない ── #986 の門が開かなくなる').not.toBeNull();
    expect(rescued?.stats.entries).toBe(1);
  });

  it('🔴 保存領域に問題があって拾い出しへ倒れたときも記録する(既存の道)', async () => {
    expect(lastRescueWritten()).toBeNull();
    const { deps } = baseDeps({
      source: fakeSource({ fail: 'database disk image is malformed' }),
      rescue: { pick: fakeRescuePick() },
    });
    await exportArchive(readyDispatcher(), deps, 'archive');
    expect(lastRescueWritten(), '拾い出しへ倒れた回を記録していない').not.toBeNull();
  });

  it('⚠ 1 ノート・フォルダの書出しは記録しない(「捨てる」の代わりにならない)', async () => {
    expect(lastRescueWritten()).toBeNull();
    const { deps } = baseDeps();
    const d = readyDispatcher();
    await exportEntry(d, deps, 'a', 'archive');
    expect(lastRescueWritten(), '1 ノートの書出しなのに「捨てる」の門を開けてしまう').toBeNull();
  });

  it('⚠ 失敗した回(倒れもしない失敗)は記録しない', async () => {
    expect(lastRescueWritten()).toBeNull();
    const { deps } = baseDeps({ source: fakeSource({ fail: 'RangeError: boom' }) });
    await exportArchive(readyDispatcher(), deps, 'archive');
    expect(lastRescueWritten(), '失敗したのに済んだ顔をしている').toBeNull();
  });
});
