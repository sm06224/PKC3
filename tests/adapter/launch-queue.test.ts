/** @vitest-environment node */
/**
 * P7 段③: `launchQueue` の受け口。
 *
 * 🔴 **宣言と実体の parity をここでも縛る**。`manifest.webmanifest` が
 * `file_handlers` を宣言している以上、OS から md をダブルクリックしたときに
 * **実際に entry ができる**ところまでが実体である ── 「受け口の関数がある」
 * だけでは、そこへファイルが届いていない可能性が残る。
 *
 * ⚠ `launchQueue` は実ブラウザの install が要るので smoke では踏めない
 * (設計 doc §3)。**受け口 → 実 `importFiles` → 実 reducer** を 1 本に繋いだ
 * test で、`entryMetas` に entry が現れるところまで見る ── レビュー H1 で
 * 「配線を丸ごと切っても 918/918 green」だったのがここである。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  armLaunchQueue,
  type LaunchedItem,
  type LaunchParamsLike,
  type LaunchTarget,
} from '../../src/adapter/platform/launch-queue';
import {
  MARKDOWN_EXTENSIONS,
  isMarkdownFileName,
} from '../../src/features/import/plain-markdown';
import { OFFICE_LAUNCH_EXTS } from '../../src/features/office/office-launch';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { whenPhaseReady } from '../../src/adapter/state/wait-for-ready';
import { createAssetGate } from '../../src/adapter/ui/actions/asset-gate';
import { importFiles } from '../../src/adapter/ui/actions/import-file';
import type { ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

/** 実ブラウザの `launchQueue` を真似る(consumer を保持して後から発火できる)。 */
function fakeTarget(opts: { throwOnSetConsumer?: boolean } = {}): {
  target: LaunchTarget;
  fire(params: LaunchParamsLike): void;
  hasConsumer(): boolean;
} {
  let consumer: ((p: LaunchParamsLike) => void) | null = null;
  return {
    target: {
      launchQueue: {
        setConsumer: (c) => {
          if (opts.throwOnSetConsumer) throw new Error('setConsumer 不可');
          consumer = c;
        },
      },
    },
    fire: (params) => consumer?.(params),
    hasConsumer: () => consumer !== null,
  };
}

const handleFor = (file: File): { kind: string; getFile(): Promise<File> } => ({
  kind: 'file',
  getFile: () => Promise.resolve(file),
});

const md = (name: string, body = '# 中身\n'): File => new File([body], name, { type: '' });

/** microtask / macrotask を流す(受け口は内部で await するため)。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('受け口の基本', () => {
  it('launchQueue がある環境では consumer を張る', () => {
    const f = fakeTarget();
    expect(armLaunchQueue(f.target, () => {}).armed).toBe(true);
    expect(f.hasConsumer()).toBe(true);
  });

  it('launchQueue が無い環境でも壊れない', () => {
    expect(armLaunchQueue({}, () => {}).armed).toBe(false);
  });

  it('🔴 setConsumer が投げても boot を道連れにしない', () => {
    // ⚠ ここは `startApp` の中で呼ばれるので、投げると「起動に失敗しました」の
    // 表示にすら到達せず**白画面**になる(review L-2)
    const errors: string[] = [];
    const f = fakeTarget({ throwOnSetConsumer: true });
    let intake!: { armed: boolean };
    expect(() => {
      intake = armLaunchQueue(f.target, () => {}, (m) => void errors.push(m));
    }).not.toThrow();
    expect(intake.armed).toBe(false);
    expect(errors.join('\n')).toContain('setConsumer 不可');
  });

  it('ファイルが届いたら受け取り先へ渡す', async () => {
    const f = fakeTarget();
    const got: File[][] = [];
    armLaunchQueue(f.target, (items) => void got.push(items.map((i) => i.file)));
    f.fire({ files: [handleFor(md('a.md'))] });
    await settle();
    expect(got.flat().map((x) => x.name)).toEqual(['a.md']);
  });

  it('🔴 **handle も一緒に渡す**(捨てると元ファイルへ戻せない)', async () => {
    // 2026-08-05、user 報告「スポットの編集プレビュー導線も存在しない」。
    // 直す前はここが `getFile()` の結果だけを渡していたので、取り込んだ後に
    // 「元がどのファイルか」を誰も知らず、同じ md を開くたびにノートが増えた。
    // ⚠ 観測点は「**渡された handle が、届いた当のもの**か」── 型が通るだけでは
    //    別の handle を渡す実装でも緑になる
    const f = fakeTarget();
    const handles = [handleFor(md('a.md')), handleFor(md('b.md'))];
    const got: { file: File; handle: unknown }[] = [];
    armLaunchQueue(f.target, (items) => void got.push(...items));
    f.fire({ files: handles });
    await settle();
    expect(got.map((g) => g.file.name)).toEqual(['a.md', 'b.md']);
    expect(got.map((g) => g.handle), 'handle が届いていない / 取り違えている').toEqual(handles);
  });

  it('複数ファイルはまとめて渡す(1 件ずつ entry になるのは import 側の仕事)', async () => {
    const f = fakeTarget();
    const got: File[][] = [];
    armLaunchQueue(f.target, (items) => void got.push(items.map((i) => i.file)));
    f.fire({ files: [handleFor(md('a.md')), handleFor(md('b.markdown'))] });
    await settle();
    expect(got).toHaveLength(1);
    expect(got[0]!.map((x) => x.name)).toEqual(['a.md', 'b.markdown']);
  });

  it('2 通目の launch も届く(起動中に別の md を開く)', async () => {
    const f = fakeTarget();
    const got: File[][] = [];
    armLaunchQueue(f.target, (items) => void got.push(items.map((i) => i.file)));
    f.fire({ files: [handleFor(md('1.md'))] });
    await settle();
    f.fire({ files: [handleFor(md('2.md'))] });
    await settle();
    expect(got.map((b) => b.map((x) => x.name))).toEqual([['1.md'], ['2.md']]);
  });
});

describe('🔴 黙って落とさない', () => {
  it('ファイル無しの launch(通常起動)は何もしない ── **エラーも出さない**', async () => {
    const errors: string[] = [];
    const f = fakeTarget();
    const consume = vi.fn();
    armLaunchQueue(f.target, consume, (m) => void errors.push(m));
    f.fire({});
    f.fire({ files: [] });
    f.fire({ files: null });
    await settle();
    expect(consume).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('🔴 ファイル無し launch のあとも受け口は生きている', async () => {
    // ⚠ 「呼ばれない」「エラーが無い」だけを見ると、**投げて握り潰された**
    // 実装でも通る(合成変異が素通りした ── review M-3)。
    // **そのあと正常な launch が流れる**ことまで見て、初めて生存が言える
    const f = fakeTarget();
    const got: File[][] = [];
    armLaunchQueue(f.target, (items) => void got.push(items.map((i) => i.file)));
    f.fire({});
    await settle();
    f.fire({ files: [handleFor(md('あと.md'))] });
    await settle();
    expect(got.flat().map((x) => x.name)).toEqual(['あと.md']);
  });

  it('読めないファイルは**言う**。残りは開く', async () => {
    const errors: string[] = [];
    const f = fakeTarget();
    const got: File[][] = [];
    armLaunchQueue(
      f.target,
      (items) => void got.push(items.map((i) => i.file)),
      (m) => void errors.push(m),
    );
    f.fire({
      files: [
        { kind: 'file', getFile: () => Promise.reject(new Error('権限がありません')) },
        handleFor(md('生きてる.md')),
      ],
    });
    await settle();
    expect(errors.join('\n')).toContain('権限がありません');
    expect(got.flat().map((x) => x.name)).toEqual(['生きてる.md']);
  });

  it('🔴 フォルダはアプリの言葉で断る(開発者語の TypeError を出さない)', async () => {
    // 仕様の `files` は `FileSystemHandle[]` で **directory handle が来うる**。
    // そのまま `getFile()` を呼ぶと `h.getFile is not a function` が user に出る
    const errors: string[] = [];
    const f = fakeTarget();
    const consume = vi.fn();
    armLaunchQueue(f.target, consume, (m) => void errors.push(m));
    f.fire({ files: [{ kind: 'directory' }] });
    await settle();
    expect(errors.join('\n')).toContain('フォルダは開けません');
    expect(errors.join('\n')).not.toContain('getFile');
    expect(consume).not.toHaveBeenCalled();
  });

  it('全部読めなければ受け取り先を呼ばない(空配列を渡さない)', async () => {
    const f = fakeTarget();
    const consume = vi.fn();
    armLaunchQueue(f.target, consume, () => {});
    f.fire({ files: [{ kind: 'file', getFile: () => Promise.reject(new Error('x')) }] });
    await settle();
    expect(consume).not.toHaveBeenCalled();
  });

  it('取込側が失敗しても**言う**(unhandled rejection にしない)', async () => {
    const errors: string[] = [];
    const f = fakeTarget();
    armLaunchQueue(f.target, () => Promise.reject(new Error('書込に失敗')), (m) =>
      void errors.push(m),
    );
    f.fire({ files: [handleFor(md('a.md'))] });
    await settle();
    expect(errors.join('\n')).toContain('書込に失敗');
  });
});

// ───────────────────────────────────────────────────────────────────
// 🔴 ここから **配線を通した end-to-end**。受け口だけの unit では
// 「機能が production で死んでいても全部緑」になる(review H1 で実証)
// ───────────────────────────────────────────────────────────────────

/** main.ts と同じ形の配線(受け口 → ready 待ち → gate → 実 importFiles)。 */
function wiredApp() {
  const written: EntryUpsert[] = [];
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const gate = createAssetGate(d);
  let n = 0;

  const deps: ImportDeps = {
    existingLids: async () => new Set(d.getState().entryMetas.keys()),
    existingRelationIds: () => new Set(),
    orderBase: () => 0,
    genLid: () => `lq-${++n}`,
    genAssetKey: () => `ast-${++n}`,
    genRelationId: () => `rel-${++n}`,
    bulkUpsertEntries: async (entries) => void written.push(...entries),
    bulkUpsertRelations: async () => {},
    listStoredBlobKeys: async () => new Set(),
    importRevisionChains: async () => ({
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
    }),
    restoreRevisionChains: async () => ({
      added: 0,
      skippedNoChange: 0,
      droppedOverLimit: 0,
      skippedEntries: [],
      brokenChains: [],
    }),
    putBlob: async () => {},
    putAssetMeta: async () => {},
    reload: async () => {
      d.dispatch({
        type: 'SYS_BOOTED',
        cid: 'c1',
        metas: written.map((e) => ({
          lid: e.lid,
          title: e.title,
          archetype: e.archetype,
          entryOrder: e.entryOrder,
          status: e.status,
          date: e.date,
          archived: e.archived,
          bodyChars: null,
          createdAt: '2026-08-02T00:00:00Z',
          updatedAt: '2026-08-02T00:00:00Z',
        })),
        relations: [],
      });
    },
  };

  // ⚠ main.ts の `importLaunchFiles` と**同じ形**(断らない)
  const importLaunchFiles = async (items: LaunchedItem[]): Promise<void> => {
    await whenPhaseReady(d);
    await gate.queued(() => importFiles(d, deps, items.map((i) => i.file)).then(() => {}));
  };

  return { d, gate, written, importLaunchFiles };
}

describe('🔴 配線 ── launch から entry ができるところまで', () => {
  it('md を launch すると **entryMetas に現れる**', async () => {
    const app = wiredApp();
    const f = fakeTarget();
    armLaunchQueue(f.target, app.importLaunchFiles);
    f.fire({ files: [handleFor(md('起動時に開いた.md', '# 起動時に開いた\n'))] });
    await settle();
    expect([...app.d.getState().entryMetas.values()].map((m) => m.title)).toEqual([
      '起動時に開いた',
    ]);
  });

  it('🔴 編集中に launch しても**失われない**(ready になったら取り込む)', async () => {
    // OS の launch は一発限りで picker が出ない ── 断るとファイルは失われる
    // (review H2:「編集を終了してから取り込んでください」で消えていた)
    const app = wiredApp();
    app.d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'e1', title: '編集中' });
    expect(app.d.getState().phase).not.toBe('ready');

    const f = fakeTarget();
    armLaunchQueue(f.target, app.importLaunchFiles);
    f.fire({ files: [handleFor(md('保留.md', '# 保留\n'))] });
    await settle();
    expect(app.written).toEqual([]); // まだ書かれない

    // ⚠ **ready 以外の state 変化では流れない**こと ── 「何か変わったら解決」に
    // すると、編集中の打鍵ひとつで取込が走って draft を壊す(変異試験で生き残った)
    app.d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '打鍵しただけ' });
    await settle();
    expect(app.d.getState().phase).not.toBe('ready');
    expect(app.written).toEqual([]);

    app.d.dispatch({ type: 'CANCEL_EDIT' }); // 編集を終える
    await settle();
    expect(app.written.map((e) => e.title)).toEqual(['保留']);
  });

  it('🔴 整理の実行中に launch しても**失われない**(順番待ちする)', async () => {
    const app = wiredApp();
    let release!: () => void;
    const busy = new Promise<void>((r) => (release = r));
    void app.gate(() => busy); // 整理を走らせたまま握る

    const f = fakeTarget();
    armLaunchQueue(f.target, app.importLaunchFiles);
    f.fire({ files: [handleFor(md('待つ.md', '# 待つ\n'))] });
    await settle();
    expect(app.written).toEqual([]); // gate の中なのでまだ

    release();
    await settle();
    expect(app.written.map((e) => e.title)).toEqual(['待つ']);
    // ⚠ 「もう一度選び直してください」で終わっていない
    expect(app.d.getState().error ?? '').not.toContain('選び直して');
  });

  it('user のクリック起点の取込は今までどおり**断る**(選び直せる)', async () => {
    const app = wiredApp();
    let release!: () => void;
    void app.gate(() => new Promise<void>((r) => (release = r)));
    await app.gate(async () => {}); // 2 本目 = 断られる
    expect(app.d.getState().error).toContain('選び直して');
    release();
  });
});

describe('🔴 boot の配線そのもの ── 呼び忘れを検出する', () => {
  // ⚠ **ソース本文を読む**。ここだけは実行 test で守れない ── `bootstrap()` は
  // 実 storage(OPFS)と実 window を要求するので CI では動かせず、PWA を install
  // した実ブラウザも無い。レビュー H1 は「`launch.deliverTo(...)` を消しても
  // 918/918 green」だった ── **機能が production で死んでいても緑**である。
  // 形の検査は脆いが、**無検査よりは事故の桁を止める**(size cap と同じ位置づけ)。
  const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf-8');

  it('bootstrap が受け口を張っている', () => {
    expect(main).toContain('armLaunchQueue(');
  });

  it('🔴 受け口に **断らない版**(`importLaunchFiles`)を渡している', () => {
    // ⚠ 断る版(`services.importFiles`)を渡すと、編集中・整理中の launch で
    // ファイルが失われる ── 型は通るので tsc では捕まらない
    expect(main).toMatch(/armLaunchQueue\([^)]*importLaunchFiles/s);
  });

  it('🔴 受け口は startApp の**解決後**に張る(前に張るとブラウザのバッファを奪う)', () => {
    // 仕様: LaunchParams は consume されるまで無期限にバッファされる。
    // 早く張ると取りこぼしの責任がアプリへ移り、boot 失敗でファイルが消える
    const armAt = main.indexOf('armLaunchQueue(');
    const thenAt = main.indexOf('.then((app) =>');
    expect(thenAt).toBeGreaterThan(0);
    expect(armAt).toBeGreaterThan(thenAt);
  });
});

describe('🔴 宣言と実体の parity ── manifest が言う拡張子が実際に entry になる', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf-8'),
  ) as {
    launch_handler?: { client_mode?: string };
    file_handlers?: Array<{ action?: string; accept?: Record<string, string[]> }>;
  };
  const handlers = manifest.file_handlers ?? [];
  const declared = handlers.flatMap((h) => Object.values(h.accept ?? {}).flat());

  it('manifest が file_handlers を宣言している(空なら parity 検査が空振りする)', () => {
    expect(handlers.length).toBeGreaterThan(0);
    expect(declared.length).toBeGreaterThan(0);
  });

  it('`action` はアプリ自身を指す(別 URL を開くと受け口に届かない)', () => {
    for (const h of handlers) expect(h.action).toBe('./');
  });

  it('🔴 `launch_handler` は既存 window を使う(開いたファイルを 2 枚目に迷子にしない)', () => {
    /**
     * ⚠ 未宣言だと既定は `auto` = **UA 任せ**で、desktop の UA は新 window を作ることがある。
     *
     * 🔴 **理由を 2026-08-22 に書き直した(#300 段⑥)。**
     * ⚠ 直す前は「その window は `acquireWriterLease` の Web Lock を取れずに
     *   『別のタブで開いています…』のまま止まる ── ファイルはそこで死ぬ」と書いていたが、
     *   **#177 以降これは事実ではない** ── lease を取れない窓は `ProxyStoreClient` で
     *   **follower としてふつうに動く**(#300 段①③ で `noopener` の窓を実測済み)。
     * 🔑 いまの理由は**別**である:新しい窓に開くと、user が**さっきまで見ていた窓**とは
     *   別の場所へファイルが入る ── 取り込みは成功するのに「**どこへ行ったか分からない**」
     *   形になる。`focus-existing` なら**いま見ている窓**に届く。
     * ⚠ 「事実ではない理由」を残すと、次に読む人が**存在しない不具合を追う**
     *   (CLAUDE.md「実態と乖離した記述は見つけ次第その場で直す」)。
     */
    expect(manifest.launch_handler?.client_mode).toBe('focus-existing');
  });

  /**
   * 🔴 **markdown として宣言した拡張子は、受け口を通って entry になる**。
   *
   * ⚠ 2026-08-26 に **Office の関連付けを足した**(#432)ので、宣言は 2 系統に
   *   なった ── ここで見るのは **markdown の側だけ**である。Office の側は
   *   entry を作らない(**元のファイルへ書き戻す**のが正しい振る舞い)ので、
   *   同じ物差しを当てると「成り立たない条件」になる。
   */
  const mdDeclared = declared.filter((ext) => !OFFICE_LAUNCH_EXTS.includes(ext));

  it('🔴 markdown として宣言された拡張子は、受け口を通って**entry になる**', async () => {
    expect(mdDeclared.length, '空振り ── markdown の宣言が 1 つも無い').toBeGreaterThan(0);
    const app = wiredApp();
    const f = fakeTarget();
    armLaunchQueue(f.target, app.importLaunchFiles);
    f.fire({ files: mdDeclared.map((ext) => handleFor(md(`note${ext}`))) });
    await settle();
    expect(app.written.map((e) => e.title)).toEqual(mdDeclared.map(() => '中身'));
    for (const ext of mdDeclared) {
      expect(isMarkdownFileName(`note${ext}`), `${ext} が md として受けられない`).toBe(true);
    }
  });

  /**
   * 🔴 **Office として宣言した拡張子は、markdown の取り込みでノートを作らない**(#432)。
   *
   * ⚠ **この it が守っているのは `import-file.ts` の濾し**であって、
   *   `main.ts` の振り分けではない(この harness は `importLaunchFiles` を
   *   **書き写している**ので、振り分けはここを通らない)。
   *   🔑 振り分けそのものは `office-save-back.test.ts` の原文 pin が見る。
   * ⚠ それでも要る:濾しが外れると、Office の文書が**中身を読めないまま
   *   ノートになる**ので、関連付けを足したこちらが害の出口になる。
   * ⚠ 対照群は上の it(markdown は entry になる)である ── 片方だけだと
   *   「受け口が丸ごと死んでいる」と区別がつかない。
   */
  it('🔴 Office として宣言された拡張子は、markdown の取り込みで**ノートにならない**', async () => {
    expect(
      OFFICE_LAUNCH_EXTS.length,
      '空振り ── Office の宣言が 1 つも無い',
    ).toBeGreaterThan(0);
    const app = wiredApp();
    const f = fakeTarget();
    armLaunchQueue(f.target, app.importLaunchFiles);
    f.fire({ files: OFFICE_LAUNCH_EXTS.map((ext) => handleFor(md(`report${ext}`))) });
    await settle();
    expect(
      app.written,
      'Office の文書が markdown の取り込みへ落ちた(中身を読めないままノートになる)',
    ).toEqual([]);
  });

  it('受け口が扱う拡張子の集合は、受理器 2 系統と manifest の 3 者で一致する', () => {
    expect([...MARKDOWN_EXTENSIONS, ...OFFICE_LAUNCH_EXTS].sort()).toEqual(
      [...declared].sort(),
    );
  });
});
