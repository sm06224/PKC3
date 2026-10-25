/** @vitest-environment node */
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
import { createCancelToken, type CancelToken } from '../../src/features/job-cancel';
import type { JobControl } from '../../src/adapter/ui/actions/job-control';
import { CORRUPT_REFUSAL } from '../../src/features/storage/db-corruption';
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
    renderIcon: async () => null,
    // ⚠ この file は SQL の埋め込みを通らない(`sql-embed-export.test.ts` が見る)
    askSql: async () => {
      throw new Error('この test では引かない');
    },
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

/** つながり・履歴を 1 行も返さない読み口(必須の口を満たすだけ。中身を見る test は別に作る)。 */
const emptyPage = async () => ({
  rows: [],
  lastRowid: 0,
  skipped: 0,
  empty: 0,
  maxRowid: 0,
  done: true,
});
const noExtraPicks = { pickRelations: emptyPage, pickRevisions: emptyPage };
/** つながり・履歴の表が読めない DB(索引の外でも読めない壊れ方)を模す。 */
const failingPage = async (): Promise<never> => {
  throw new Error('database disk image is malformed');
};
const brokenExtraPicks = { pickRelations: failingPage, pickRevisions: failingPage };

describe('末尾の使い分け(#1017 段④b)', () => {
  it('🔴 コレクション全体は既定で .pkc3-full.zip', async () => {
    const { deps, downloaded } = baseDeps();
    const n = await exportArchive(readyDispatcher(), deps, 'archive');
    expect(n).toBe(1);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.name.endsWith('.pkc3-full.zip'), downloaded[0]!.name).toBe(true);
  });

  it('🔴 1 ノートの書き出しは .pkc3-notes.zip(exportEntry)', async () => {
    const { deps, downloaded } = baseDeps();
    const d = readyDispatcher();
    await exportEntry(d, deps, 'a', 'archive');
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.name.endsWith('.pkc3-notes.zip'), downloaded[0]!.name).toBe(true);
  });

  it('🔴 フォルダの書き出しも .pkc3-notes.zip(exportFolder)', async () => {
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
      rescue: { pick: fakeRescuePick(), ...brokenExtraPicks },
    });
    const n = await exportArchive(readyDispatcher(), deps, 'archive');
    expect(n, '倒れた結果の件数を返していない').toBe(1);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.name.endsWith('.pkc3-part.zip'), downloaded[0]!.name).toBe(true);
    // 🔑 §5 の検算:読めなかったときは、通知に「入っていません」が出る
    const notified = notices.join('\n');
    expect(notified, 'つながり・履歴が読めなかったことを言っていない').toContain(
      'その分は入っていません',
    );
  });

  /**
   * 🔴 **拾えたつながり・履歴は zip に入れ、画面の字も「入れました」と言う**(#1087)。
   * ⚠ 偽の「入っていません」を残さない ── 件数は入れた物の数と一致する。
   */
  it('🔴 つながり・履歴を拾えたら zip に入り、字は件数で言う(「入っていません」と言わない)', async () => {
    const page = <T,>(rows: T[]) => async () => ({
      rows,
      lastRowid: 1,
      skipped: 0,
      empty: 0,
      maxRowid: 1,
      done: true,
    });
    const { deps, downloaded, notices } = baseDeps({
      source: fakeSource({ fail: 'database disk image is malformed' }),
      rescue: {
        pick: fakeRescuePick(),
        pickRelations: page([
          { rowid: 1, cid: 'c1', id: 'rel1', fromLid: 'r1', toLid: 'r1', kind: 'semantic' },
          // 一覧に無いノートへのつながりは入れない(作り直しと同じ扱い)
          { rowid: 2, cid: 'c1', id: 'rel2', fromLid: 'r1', toLid: 'ghost', kind: 'semantic' },
        ]),
        pickRevisions: page([
          {
            rowid: 1,
            cid: 'c1',
            entryLid: 'r1',
            revOrder: 1,
            createdAt: null,
            title: '旧題',
            archetype: 'text',
            kind: 'full',
            snapshot: '旧本文',
            contentHash: null,
          },
        ]),
      },
    });
    await exportArchive(readyDispatcher(), deps, 'archive');
    const notified = notices.join('\n');
    expect(notified).toContain('つながり 1 件・履歴 1 版を入れました');
    expect(notified, '入れたのに「入っていません」と言っている').not.toContain(
      'つながりと履歴は入っていません',
    );
    expect(downloaded[0]!.name.endsWith('.pkc3-part.zip')).toBe(true);
  });

  it('🔴 Markdown も同じ理由で .pkc3-part.zip へ倒れる', async () => {
    const { deps, downloaded, notices } = baseDeps({
      source: fakeSource({ fail: 'sqlite result code 11' }),
      rescue: { pick: fakeRescuePick(), ...brokenExtraPicks },
    });
    await exportArchive(readyDispatcher(), deps, 'markdown');
    expect(downloaded[0]!.name.endsWith('.pkc3-part.zip')).toBe(true);
    expect(notices.join('\n')).toContain('その分は入っていません');
  });

  it('⚠ corrupt でない失敗は倒れない(大きすぎる、を壊れていると偽らない)', async () => {
    const { deps } = baseDeps({
      source: fakeSource({ fail: 'RangeError: Invalid array buffer length' }),
      rescue: { pick: fakeRescuePick(), ...noExtraPicks },
    });
    const d = readyDispatcher();
    const n = await exportArchive(d, deps, 'archive');
    expect(n, '倒れずに失敗として返すべき').toBeNull();
    expect(d.getState().error, '失敗が画面に出ていない').toContain('書き出しに失敗しました');
  });

  it('🔴 拾い出しも 1 件も拾えなかったら、「ノートが 1 件もありません」ではなく壊れの案内を出す(#1087)', async () => {
    const emptyPick = async () => ({
      rows: [],
      lastRowid: 1,
      skipped: 3,
      empty: 20,
      maxRowid: 1,
      done: true,
    });
    const { deps, downloaded } = baseDeps({
      source: fakeSource({ fail: 'database disk image is malformed' }),
      rescue: { pick: emptyPick, ...noExtraPicks },
    });
    const d = readyDispatcher();
    const n = await exportArchive(d, deps, 'archive');
    expect(n).toBeNull();
    expect(downloaded, '空の zip を落とした').toHaveLength(0);
    const err = d.getState().error ?? '';
    expect(err, '壊れの案内を出していない').toContain(CORRUPT_REFUSAL);
    expect(err, '壊れた保存領域の人に「ノートが無い」と言っている').not.toContain('1 件もありません');
  });

  it('⚠ rescue が渡っていなければ倒れない(deps.rescue 省略時)', async () => {
    const { deps } = baseDeps({ source: fakeSource({ fail: 'database disk image is malformed' }) });
    const d = readyDispatcher();
    const n = await exportArchive(d, deps, 'archive');
    expect(n).toBeNull();
    expect(d.getState().error).toContain('書き出しに失敗しました');
  });

  it('🔴 1 ノート・フォルダの書き出しは、corrupt でも倒れない(archiveScope が notes)', async () => {
    // ⚠ exportEntry / exportFolder は絞り込みの読み(singleEntrySource / folderSource)
    //   自体が同じ理由で落ちるので、拾い出しの対象にしない(ExportDeps.rescue の docstring)。
    const pick = vi.fn(fakeRescuePick());
    const { deps } = baseDeps({
      source: fakeSource({ fail: 'database disk image is malformed' }),
      rescue: { pick, ...noExtraPicks },
    });
    const d = readyDispatcher();
    const n = await exportEntry(d, deps, 'a', 'archive');
    expect(n, 'notes scope では倒れずに失敗するべき').toBeNull();
    // 🔑 拾い出しの口が 1 度も呼ばれていないこと(倒れる経路にすら入っていない)
    expect(pick, '1 ノートの書き出しなのに拾い出しへ切り替わった').not.toHaveBeenCalled();
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
      rescue: { pick, ...noExtraPicks },
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
      rescue: { pick: fakeRescuePick(), ...noExtraPicks },
    });
    await exportArchive(readyDispatcher(), deps, 'archive');
    expect(lastRescueWritten(), '拾い出しへ倒れた回を記録していない').not.toBeNull();
  });

  it('⚠ 1 ノート・フォルダの書き出しは記録しない(「捨てる」の代わりにならない)', async () => {
    expect(lastRescueWritten()).toBeNull();
    const { deps } = baseDeps();
    const d = readyDispatcher();
    await exportEntry(d, deps, 'a', 'archive');
    expect(lastRescueWritten(), '1 ノートの書き出しなのに「捨てる」の門を開けてしまう').toBeNull();
  });

  it('⚠ 失敗した回(倒れもしない失敗)は記録しない', async () => {
    expect(lastRescueWritten()).toBeNull();
    const { deps } = baseDeps({ source: fakeSource({ fail: 'RangeError: boom' }) });
    await exportArchive(readyDispatcher(), deps, 'archive');
    expect(lastRescueWritten(), '失敗したのに済んだ顔をしている').toBeNull();
  });
});

/**
 * 🔴 **失敗したら、進行中の字(「書き出しています…」)を消す**(#1017 C5)。
 *
 * ⚠ 直す前は、失敗しても進行中の字が画面下に**残った**(エラーの行と並んで「まだ続いている」と読める)。
 * ⚠ **出す前の断り**(編集中)は進行中の字を出していないので、消す `notify('')` も撃たない。
 */
describe('exportArchive ── 失敗したら進行中の字を消す(#1017 C5)', () => {
  it('🔴 失敗した回は、進行中の字のあとに空の字(消す)が来て、完了の字は出ない', async () => {
    const { deps, notices } = baseDeps({
      source: fakeSource({ fail: 'RangeError: Invalid array buffer length' }),
    });
    const d = readyDispatcher();
    expect(await exportArchive(d, deps, 'archive'), '前提が崩れた(失敗していない)').toBeNull();
    expect(notices[0], '前提が崩れた(進行中の字が先に出ていない)').toContain('書き出しています…');
    expect(notices.at(-1), '失敗したのに進行中の字が残る').toBe('');
    expect(notices.some((n) => n.startsWith('書き出しました')), '失敗なのに完了と言った').toBe(false);
  });

  it('対照群:成功した回は、最後が完了の字で、消す字は撃たない', async () => {
    const { deps, notices } = baseDeps();
    expect(await exportArchive(readyDispatcher(), deps, 'archive')).not.toBeNull();
    expect(notices.at(-1)).toContain('書き出しました');
    expect(notices, '成功なのに消す字を撃った').not.toContain('');
  });

  it('🔴 出す前の断り(編集中)は、消す字も撃たない(別の知らせを巻き込まない)', async () => {
    const { deps, notices } = baseDeps();
    const sent: unknown[] = [];
    const editing = {
      getState: () => ({ phase: 'editing' }),
      dispatch: (a: unknown) => sent.push(a),
    } as unknown as Dispatcher;
    expect(await exportArchive(editing, deps, 'archive')).toBeNull();
    expect(sent[0], '前提が崩れた(断っていない)').toMatchObject({ type: 'OP_FAILED' });
    expect(notices, '出していない進行中の字を消す字を撃った').toEqual([]);
  });
});

describe('exportArchive ── 添付が多いときは進み具合(添付 N / M)を出す', () => {
  const PROGRESS = /^書き出しています\(添付 (\d+) \/ (\d+)\)$/;

  function sourceWithAssets(n: number): ArchiveSource {
    const metas = Array.from({ length: n }, (_, i) => ({
      key: `ast-${String(i).padStart(4, '0')}`,
      mime: 'image/png',
      size: 1,
      hash: null,
    }));
    return {
      ...fakeSource(),
      listAssetMetas: async () => metas,
      getAssetBlob: async () => new Blob(['x']),
    };
  }

  it('45 件の添付: 20 件ごとに出る / 最後の 1 件は出さない / 書き出しは成功する', async () => {
    const { deps, notices, downloaded } = baseDeps({ source: sourceWithAssets(45) });
    expect(await exportArchive(readyDispatcher(), deps)).toBe(1);
    const progress = notices.filter((m) => PROGRESS.test(m));
    // 時間の間引き(250ms)は環境で揺れるので、20 件ごとの 2 回は必ず在ることだけを見る
    expect(progress).toContain('書き出しています(添付 20 / 45)');
    expect(progress).toContain('書き出しています(添付 40 / 45)');
    expect(progress).not.toContain('書き出しています(添付 45 / 45)');
    for (const m of progress) expect(Number(PROGRESS.exec(m)![1])).toBeLessThan(45);
    // 結果の知らせが最後(進み具合で上書きされたまま残らない)
    expect(notices.at(-1)).toMatch(/^書き出しました: /);
    // 🔴 保存したファイルの名前を言う(#1643 依頼 38-4)── ダウンロード欄から探す手掛かり
    expect(downloaded[0]!.name, '前提: 名前がある').toMatch(/\.pkc3-full\.zip$/);
    expect(notices.at(-1)).toContain(`「${downloaded[0]!.name}」`);
    expect(downloaded).toHaveLength(1);
  });

  it('対照群: 添付が 3 件なら進み具合は出さない(20 件にも 250ms にも届かない小さい書き出しを騒がせない)', async () => {
    const { deps, notices } = baseDeps({ source: sourceWithAssets(3) });
    await exportArchive(readyDispatcher(), deps);
    expect(notices.filter((m) => PROGRESS.test(m))).toEqual([]);
  });
});

/**
 * 🔴 **書き出しを途中でやめる**(台帳 #1852 束 F2 / 依頼 253)。
 * 観測点は「ダウンロードが始まったか」「失敗の欄(OP_FAILED)に出していないか」「読めた分だけのバックアップへ倒れていないか」「出口で印を返したか」。
 */
describe('exportArchive ── 途中でやめる(依頼 253)', () => {
  function jobWith() {
    const tokens: CancelToken[] = [];
    const finished: CancelToken[] = [];
    const job: JobControl = {
      start: () => {
        const t = createCancelToken();
        tokens.push(t);
        return t;
      },
      finish: (t) => void finished.push(t),
      cancelCurrent: () => false,
    };
    return { job, tokens, finished };
  }
  /** 添付 n 件。`onGet` は添付を 1 件読むたびに呼ぶ(やめる印を立てる場所)。 */
  function sourceWithAssets(n: number, onGet: (i: number) => void = () => undefined): ArchiveSource {
    const metas = Array.from({ length: n }, (_, i) => ({ key: `ast-${i}`, mime: 'image/png', size: 1, hash: null }));
    let i = 0;
    return {
      ...fakeSource(),
      listAssetMetas: async () => metas,
      getAssetBlob: async () => {
        onGet(i++);
        return new Blob(['x']);
      },
    };
  }

  it('🔴 添付を読んでいる途中でやめると、ダウンロードを始めず、失敗にも読めた分だけのバックアップにもしない', async () => {
    const j = jobWith();
    let reads = 0;
    const d = readyDispatcher();
    const { deps, downloaded, notices } = baseDeps({
      job: j.job,
      source: sourceWithAssets(5, (i) => {
        reads++;
        if (i === 1) j.tokens[0]!.cancel(); // 2 件目を読んだところで「やめる」
      }),
      // 倒れ先(読めた分だけのバックアップ)が使われたら見える
      rescue: { pick: fakeRescuePick(), ...noExtraPicks },
    });
    expect(await exportArchive(d, deps)).toBeNull();
    expect(reads, '区切りで止まらず最後まで読んだ').toBe(2);
    expect(downloaded, 'やめたのにダウンロードが始まった').toEqual([]);
    expect(d.getState().error, 'やめたのを失敗の欄に出した').toBeNull();
    expect(notices.at(-1)).toBe('書き出しをやめました(ファイルは作っていません)');
    expect(notices.some((m) => m.includes('読めた分')), 'やめたのを保存領域の問題と読んで倒れた').toBe(false);
    expect(j.finished, '出口で印を返していない').toEqual([j.tokens[0]]);
  });

  it('対照群: 印を立てなければ最後まで書き出す', async () => {
    const j = jobWith();
    let reads = 0;
    const { deps, downloaded, notices } = baseDeps({ job: j.job, source: sourceWithAssets(5, () => void reads++) });
    expect(await exportArchive(readyDispatcher(), deps)).toBe(1);
    expect(reads).toBe(5);
    expect(downloaded).toHaveLength(1);
    expect(notices.at(-1)).toMatch(/^書き出しました: /);
    expect(j.finished).toEqual([j.tokens[0]]);
  });

  it('🔴 組み終えた後(最後の添付を読み終えた直後)にやめても、ダウンロードは始めない', async () => {
    const j = jobWith();
    const { deps, downloaded, notices } = baseDeps({
      job: j.job,
      source: sourceWithAssets(2, (i) => {
        if (i === 1) j.tokens[0]!.cancel(); // 最後の 1 件を読んだところ(次の読みは無い)
      }),
    });
    expect(await exportArchive(readyDispatcher(), deps)).toBeNull();
    expect(downloaded).toEqual([]);
    expect(notices.at(-1)).toBe('書き出しをやめました(ファイルは作っていません)');
  });

  it('失敗した回も出口で印を返す(finally)', async () => {
    const j = jobWith();
    const { deps } = baseDeps({ job: j.job, source: fakeSource({ fail: 'boom' }) });
    expect(await exportArchive(readyDispatcher(), deps)).toBeNull();
    expect(j.finished).toEqual([j.tokens[0]]);
  });

  it('job が無い配線は従来どおり(印を作らない)', async () => {
    const { deps, downloaded } = baseDeps({ source: sourceWithAssets(2) });
    expect(deps.job).toBeUndefined();
    expect(await exportArchive(readyDispatcher(), deps)).toBe(1);
    expect(downloaded).toHaveLength(1);
  });
});
