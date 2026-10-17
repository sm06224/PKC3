/**
 * 🔴 **拾った中身で、その場に建て直す**(#1006。user 裁定 2026-09-18)。
 *
 * ⚠ ここで守るのは「建て直せること」だけではない ── **順番**である。
 * 1 つでも入れ替えると、user のデータが静かに消える:
 *
 * | 入れ替えると | 何が起きるか |
 * |---|---|
 * | zip を落とす前に捨てる | 🔴 **保険が無いまま消える** |
 * | `fallbackReason` を見ずに書き戻す | 🔴 **メモリ上に書いて、タブを閉じた瞬間に全部消える** |
 * | 書き戻す前に他のタブへ知らせる | 🔴 他のタブが**別の器を採番**し、**復元した本体が以後見えなくなる** |
 *
 * 🔑 だから **test は「呼ばれた順番」を採る** ── 結果だけ見ても、この 3 つは見えない。
 */
import { describe, expect, it } from 'vitest';
import { readArchive, writeArchive } from '../../src/features/export/pkc3-archive';
import { readAssetSource } from '../../src/features/import/zip-reader';
import {
  collectRescued,
  collectRescuedExtras,
  rebuildContainer,
  rebuildDoneMessage,
  rebuildExplainMessage,
  rebuiltEntries,
  REBUILD_LOST,
  REBUILD_NOT_WRITER,
  type RebuildPorts,
  type RescuedRow,
} from '../../src/features/storage/container-rebuild';
import {
  RESCUE_IDLE_PAGE_LIMIT,
  type RescuedRelation,
  type RescuedRevision,
  type RescuePageLike,
} from '../../src/features/storage/rescue-archive';

const NOW = '2026-09-18T00:00:00.000Z';

/** 並び・時刻を読めなかった行(#1087)。 */
const NOSTAMP = { entryOrder: null, createdAt: null, updatedAt: null } as const;

const THREE: RescuedRow[] = [
  { lid: 'a1', title: '牛乳を買う', archetype: 'text', body: '# 牛乳を買う\n\n近所で\n', ...NOSTAMP },
  { lid: 'b2', title: '会議のメモ', archetype: 'text', body: '# 会議のメモ\n\n- 決めたこと\n', ...NOSTAMP },
  { lid: 'c3', title: '日本語の題', archetype: 'text', body: '# 日本語の題\n\nあいうえお\n', ...NOSTAMP },
];

/** 壊れた DB の代わり。⚠ 読めない区画は**例外ではなく `skipped`** で返る(本物と同じ)。 */
function fakePick(opts: {
  rows?: readonly RescuedRow[];
  skippedPerPage?: number;
  emptyPerPage?: number;
  pageSize?: number;
}): (after: number, chunks: number) => Promise<RescuePageLike> {
  const rows = opts.rows ?? THREE;
  const size = opts.pageSize ?? 2;
  return async (after: number) => {
    const from = rows.findIndex((_, i) => i + 1 > after);
    const at = from < 0 ? rows.length : from;
    const slice = rows.slice(at, at + size);
    const lastRowid = at + slice.length;
    return {
      rows: slice.map((r, i) => ({ rowid: at + i + 1, ...r })),
      lastRowid,
      skipped: opts.skippedPerPage ?? 0,
      empty: opts.emptyPerPage ?? 0,
      maxRowid: rows.length,
      done: lastRowid >= rows.length,
    };
  };
}

/**
 * 呼ばれた順番を採る台。
 *
 * ⚠ **結果ではなく順番を見る**のがこの file の要である ──
 *   「戻った」だけを見る assert は、上の表の 3 つを**どれも見ていない**。
 */
function harness(
  over: {
    rows?: readonly RescuedRow[];
    /** 🔴 開き直しが退避した理由(立っていたら書き戻してはいけない)。 */
    fallbackReason?: string;
    /** zip を落とすのが落ちる(= まだ何も消していない段で止まる)。 */
    failArchive?: string;
    /** 書き戻しが落ちる。 */
    failWrite?: string;
    /** 捨てる所そのものが落ちる。 */
    failWipe?: string;
    /** 🔴 捨てた後、開き直しが落ちる(`applySchema` の失敗など)。 */
    failReopen?: string;
    /** 🔴 このタブが保存を担当していない(既定は担当)。 */
    notWriter?: boolean;
    assets?: Map<string, Blob>;
    skippedPerPage?: number;
    /** 🔑 壊れた DB から拾えるつながり・履歴・色（#1087）。 */
    relations?: readonly RescuedRelation[];
    revisions?: readonly RescuedRevision[];
    tagColors?: Array<{ tag: string; color: string }>;
    /** つながり・履歴の拾い出しで読めない区画がある。 */
    extrasSkipped?: number;
  } = {},
): {
  ports: RebuildPorts;
  calls: string[];
  written: () => readonly { lid: string }[];
  writtenFull: () => readonly import('../../src/features/storage/container-rebuild').RebuiltEntry[];
  /** 書き戻した物（#1087）。 */
  wrote: {
    relations: RescuedRelation[];
    chains: Map<string, readonly RescuedRevision[]>;
    assetMetas: Array<{ key: string; mime: string | null; size: number | null; hash: string | null }>;
    tagColors: Array<{ tag: string; color: string }>;
  };
} {
  const wrote: {
    relations: RescuedRelation[];
    chains: Map<string, readonly RescuedRevision[]>;
    assetMetas: Array<{ key: string; mime: string | null; size: number | null; hash: string | null }>;
    tagColors: Array<{ tag: string; color: string }>;
  } = { relations: [], chains: new Map(), assetMetas: [], tagColors: [] };
  const onePage =
    <R,>(rows: readonly R[]) =>
    async (after: number) => ({
      rows: after === 0 ? rows : [],
      lastRowid: 1,
      skipped: after === 0 ? (over.extrasSkipped ?? 0) : 0,
      empty: 0,
      maxRowid: 1,
      done: true,
    });
  const calls: string[] = [];
  let written: readonly { lid: string }[] = [];
  let writtenFull: readonly import('../../src/features/storage/container-rebuild').RebuiltEntry[] = [];
  const idb = over.assets;
  const ports: RebuildPorts = {
    holdsWriterLease: () => over.notWriter !== true,
    pickRelations: onePage(over.relations ?? []),
    pickRevisions: onePage(over.revisions ?? []),
    readTagColors: async () => {
      calls.push('readTagColors');
      return over.tagColors ?? [];
    },
    writeRelations: async (_cid, relations) => {
      calls.push('writeRelations');
      wrote.relations = [...relations];
    },
    writeRevisions: async (_cid, chains) => {
      calls.push('writeRevisions');
      wrote.chains = new Map(chains);
      return { added: [...chains.values()].reduce((n, c) => n + c.length, 0), broken: 0 };
    },
    writeAssetMetas: async (_cid, metas) => {
      calls.push('writeAssetMetas');
      wrote.assetMetas = [...metas];
    },
    writeTagColors: async (_cid, colors) => {
      calls.push('writeTagColors');
      wrote.tagColors = [...colors];
    },
    pick: fakePick({
      ...(over.rows === undefined ? {} : { rows: over.rows }),
      ...(over.skippedPerPage === undefined ? {} : { skippedPerPage: over.skippedPerPage }),
    }),
    ...(idb === undefined
      ? {}
      : {
          assets: {
            listKeys: async () => [...idb.keys()],
            get: async (_cid: string, key: string) => idb.get(key) ?? null,
          },
        }),
    saveArchive: async (source) => {
      calls.push('saveArchive');
      if (over.failArchive !== undefined) throw new Error(over.failArchive);
      // ⚠ 空振り防止 ── 実際に組ませて、行が出ることまで見る
      await writeArchive(source, NOW);
    },
    wipeStorage: async () => {
      calls.push('wipeStorage');
      // 🔴 **捨てる所が落ちる**(#1006 の着地前レビュー ── 直す前はここで投げると
      //    呼び側が「何も消えていません」と嘘を言った)
      if (over.failWipe !== undefined) throw new Error(over.failWipe);
      return { wiped: true, note: null };
    },
    reopenStorage: async () => {
      calls.push('reopenStorage');
      // 🔴 **捨てた後に、開き直しが落ちる** ── いちばん危ない所
      if (over.failReopen !== undefined) throw new Error(over.failReopen);
      return over.fallbackReason === undefined
        ? { fallbackReason: undefined }
        : { fallbackReason: over.fallbackReason };
    },
    openContainer: async (cid) => {
      calls.push(`openContainer:${cid}`);
    },
    writeEntries: async (cid, entries) => {
      calls.push(`writeEntries:${cid}:${entries.length}`);
      if (over.failWrite !== undefined) throw new Error(over.failWrite);
      written = entries.map((e) => ({ lid: e.lid }));
      writtenFull = [...entries];
    },
    forgetLocal: () => {
      calls.push('forgetLocal');
    },
    /**
     * 🔑 **進み具合も同じ列に採る** ── 「いつ言ったか」は順番の話なので、
     *   別の配列に採ると**書き戻しとの前後が見えなくなる**。
     */
    onProgress: (phase) => {
      calls.push(`progress:${phase}`);
    },
    announceWiped: () => {
      calls.push('announceWiped');
    },
  };
  return { ports, calls, written: () => written, writtenFull: () => writtenFull, wrote };
}

describe('🔴 拾った中身で、その場に建て直す(#1006)', () => {
  /**
   * 🔴 #1087: 2 枚目のタブ(DB の担当でない側)で押すと、捨てる命令だけが担当のタブへ届いて
   * そちらの DB が空になり、開き直しは手を取れずメモリ上へ落ちていた。
   * 直す前(門なし)はこの test が「捨てた」で落ちる。
   */
  it('🔴 担当でないタブでは、拾うことも捨てることもせずに断る', async () => {
    const h = harness({ notWriter: true });
    await expect(rebuildContainer('c-old', 'わたしの PKC', h.ports)).rejects.toThrow(REBUILD_NOT_WRITER);
    expect(h.calls, '断ったのに何かを呼んだ').toEqual([]);
    // 対照群: 担当なら同じ台で最後まで走る
    const ok = harness();
    expect((await rebuildContainer('c-old', 'わたしの PKC', ok.ports)).outcome).toBe('rebuilt');
    expect(ok.calls).toContain('wipeStorage');
  });

  it('🟢 3 件を拾って、同じ器の id へ書き戻す', async () => {
    const h = harness();
    const r = await rebuildContainer('c-old', 'わたしの PKC', h.ports);

    expect(r.outcome).toBe('rebuilt');
    expect(r.restored, '戻した件数が合わない').toBe(3);
    expect(h.written().map((e) => e.lid)).toEqual(['a1', 'b2', 'c3']);

    /**
     * 🔑 **ここがこの機能の肝** ── 器の id を持ち越さないと、
     *   ①孤児の掃除が添付を全部「どこにも属さない」と判定し、
     *   ②壊れる前に作った栞と外部リンクが全部死ぬ。
     */
    expect(h.calls, '器の id を持ち越していない').toContain('openContainer:c-old');
  });

  /**
   * 🔴 **順番そのものを pin する。**
   * ⚠ 「戻った」だけを見る assert は、この 3 つを**どれも見ていない**。
   */
  it('🔴 zip → 捨てる → 開き直す → 書き戻す → 知らせる、の順で進む', async () => {
    const h = harness();
    await rebuildContainer('c-old', 't', h.ports);

    /**
     * ⚠ **消す / 書く手だけを見る** ── 進み具合(`progress:`)は
     *   **いつ言ったか**の話なので、順番は別の it が見る(混ぜると
     *   どちらの主張も読めなくなる ── §「1 つの検査 = 1 つの主張」)。
     */
    const order = h.calls.filter(
      (c) => !c.startsWith('openContainer') && !c.startsWith('progress:'),
    );
    expect(order).toEqual([
      // 🔴 色は捨てる前に読む（#1087。捨てた後の DB からは読めない）
      'readTagColors',
      'saveArchive',
      'wipeStorage',
      'reopenStorage',
      'writeEntries:c-old:3',
      // 🔴 つながり・履歴・添付の登録行・色は、ノートの後（#1087）
      'writeRelations',
      'writeRevisions',
      'writeAssetMetas',
      'writeTagColors',
      'announceWiped',
    ]);
  });

  /**
   * 🔴 **保険が先** ── zip が落ちたら、**1 バイトも消さずに**止まる。
   * ⚠ これが逆だと、書き出せなかった人が**中身を失ったうえに手ぶら**になる。
   */
  it('🔴 zip が落ちたら、何も消さずに止まる', async () => {
    const h = harness({ failArchive: '書き出せません' });
    await expect(rebuildContainer('c-old', 't', h.ports)).rejects.toThrow('書き出せません');
    expect(h.calls, '書き出せなかったのに捨てている').not.toContain('wipeStorage');
    expect(h.calls, '書き出せなかったのに知らせている').not.toContain('announceWiped');
  });

  /**
   * 🔴 **いちばん危ない門**(実測 2026-09-18)。
   *
   * ⚠ `wipeStorage` の後にそのまま開き直すと、**例外を出さずに** `memory` へ落ちる。
   *   そこへ書き戻すと、user は「戻った」と思って書き続け、
   *   **タブを閉じた瞬間に全部消える** ── 直した当人以外、誰も気づけない。
   */
  it('🔴 退避していたら、書き戻さない(メモリ上に書いて消させない)', async () => {
    const h = harness({ fallbackReason: 'NoModificationAllowedError: …' });
    const r = await rebuildContainer('c-old', 't', h.ports);

    expect(r.outcome).toBe('memory-only');
    expect(r.restored, 'メモリ上なのに書き戻している').toBe(0);
    expect(h.calls.some((c) => c.startsWith('writeEntries')), 'メモリ上なのに書いている').toBe(
      false,
    );
    expect(h.calls.some((c) => c.startsWith('openContainer')), 'メモリ上なのに作っている').toBe(
      false,
    );
    // ⚠ 器は空になったので、他のタブへは知らせる(黙って古い一覧を持たせない)
    expect(h.calls, '空になったのに知らせていない').toContain('announceWiped');
    // 🔑 中身は消えたので、この端末の断片(コピー履歴)は落とす
    expect(h.calls, '消えたのに断片を残している').toContain('forgetLocal');
  });

  /**
   * ⚠ **対照群** ── 退避していなければ書き戻す。
   * 🔑 これが無いと、上の test は「いつも書き戻さない」実装でも通る。
   */
  it('⚠ 退避していなければ書き戻す(対照群)', async () => {
    const h = harness();
    const r = await rebuildContainer('c-old', 't', h.ports);
    expect(r.outcome).toBe('rebuilt');
    expect(h.calls.some((c) => c.startsWith('writeEntries'))).toBe(true);
  });

  /**
   * 🔴 **知らせるのは書き戻した後**(別タブの競争)。
   *
   * ⚠ 前へ出すと、他のタブが**器が空のうちに**読み込み直して**別の id を採番**する。
   *   器が 2 つ並ぶと片方だけが以後ずっと返るので、
   *   **復元した本体が誰からも見えなくなる**。
   */
  it('🔴 「知らせる」は、書き戻しより後に来る', async () => {
    const h = harness();
    await rebuildContainer('c-old', 't', h.ports);
    const write = h.calls.findIndex((c) => c.startsWith('writeEntries'));
    const tell = h.calls.indexOf('announceWiped');
    expect(write, '書き戻していない(前提が崩れている)').toBeGreaterThanOrEqual(0);
    expect(tell, '知らせていない').toBeGreaterThanOrEqual(0);
    expect(tell, '書き戻す前に知らせている(別タブが別の器を作る)').toBeGreaterThan(write);
  });

  /**
   * 🔑 **戻ったのだから、この端末の断片は落とさない。**
   * ⚠ 建て直しは lid を持ち越すので、コピー履歴の指す先は**生きている**。
   */
  it('🔑 戻ったときは、コピー履歴を落とさない', async () => {
    const h = harness();
    await rebuildContainer('c-old', 't', h.ports);
    expect(h.calls, '戻ったのに履歴を落としている').not.toContain('forgetLocal');
  });

  it('🔴 書き戻しが落ちたら、zip へ誘導する', async () => {
    const h = harness({ failWrite: 'disk full' });
    const r = await rebuildContainer('c-old', 't', h.ports);
    expect(r.outcome).toBe('write-failed');
    expect(r.error).toContain('disk full');
    expect(h.calls, '落ちたのに知らせていない').toContain('announceWiped');
    expect(rebuildDoneMessage(r), '落とした zip へ誘導していない').toContain('取り込む');
  });

  /**
   * 🔑 **予定の日付とチェックは、本文から戻る**(取り込みと同じ関数を通す)。
   * ⚠ ここを通さないと、建て直しだけが取り込みより弱くなる。
   */
  it('🔑 チェックの状態と日付が、本文から戻る', () => {
    const rows: RescuedRow[] = [
      { lid: 't1', title: '買い物', archetype: 'todo', body: '# 買い物\n\n- [x] 牛乳\n', ...NOSTAMP },
    ];
    const out = rebuiltEntries(rows);
    expect(out).toHaveLength(1);
    // ⚠ 空振り防止 ── 本文から何かが導かれていること(全部 null なら通っていない)
    const plain = rebuiltEntries([{ ...rows[0]!, archetype: 'text', body: 'ただの本文' }]);
    expect(
      out[0]!.status !== plain[0]!.status || out[0]!.archived !== plain[0]!.archived,
      '本文から何も導かれていない(extractMeta を通っていない)',
    ).toBe(true);
  });

  /** ⚠ 拾えなかった区画を、必ず字にする(「戻した件数」を「全部」と読ませない)。 */
  it('⚠ 読み込めなかった箇所を字に出し、戻らない物も言う', async () => {
    const h = harness({ skippedPerPage: 3 });
    const r = await rebuildContainer('c-old', 't', h.ports);
    const line = rebuildDoneMessage(r);
    expect(line).toContain('3 件を戻しました');
    expect(line, '読み込めなかった箇所を黙っている').toContain('読み込めなかった箇所');
    for (const lost of REBUILD_LOST) {
      expect(line, `戻らない物「${lost}」を言っていない`).toContain(lost);
    }
  });

  /**
   * 🔴 **添付は「触っていない」と言う** ── 数ではなく**事実**が知りたい所である。
   * ⚠ 0 件の人に「添付 0 件はそのままです」と書かない。
   */
  it('🔴 添付が在れば「そのまま残っている」と言い、無ければ黙る', async () => {
    const h = harness({ assets: new Map([['k1', new Blob(['AAA'])]]) });
    const r = await rebuildContainer('c-old', 't', h.ports);
    expect(rebuildDoneMessage(r), '添付が残ることを言っていない').toContain('そのまま残っています');

    const none = harness();
    const r2 = await rebuildContainer('c-old', 't', none.ports);
    expect(rebuildDoneMessage(r2), '0 件なのに添付の話をしている').not.toContain(
      'そのまま残っています',
    );
  });

  /**
   * 🔴 **zip は本物として読める** ── 「書き出した」で終わらせない。
   * ⚠ 添付の bytes まで往復することを見る(#1005 と同じ規律)。
   */
  it('🔴 落とす zip は、添付ごと読み戻せる', async () => {
    let blob: Blob | null = null;
    const h = harness({ assets: new Map([['k1', new Blob(['PNGBYTES'], { type: 'image/png' })]]) });
    const ports: RebuildPorts = {
      ...h.ports,
      saveArchive: async (source) => {
        blob = (await writeArchive(source, NOW)).blob;
      },
    };
    await rebuildContainer('c-old', 'わたしの PKC', ports);

    expect(blob, 'zip が組まれていない').not.toBeNull();
    const got = await readArchive(blob!);
    expect(got.entries.map((e) => e.title)).toEqual(THREE.map((r) => r.title));
    expect([...got.assetSources.keys()], '添付が zip に入っていない').toEqual(['k1']);
    const bytes = await readAssetSource(got.assetSources.get('k1')!);
    expect(await bytes.text()).toBe('PNGBYTES');
  });

  /** ⚠ 1 周で集めること自体を留める(2 周に変えると zip と戻した件数がずれる)。 */
  it('⚠ 壊れた DB を 1 周だけ舐める', async () => {
    let passes = 0;
    const base = fakePick({});
    const r = await collectRescued(async (after, chunks) => {
      if (after === 0) passes += 1;
      return base(after, chunks);
    });
    expect(r.rows).toHaveLength(3);
    expect(passes, '2 周以上舐めている').toBe(1);
  });

  /**
   * 🔴 **書き戻す「前」に「戻しています」と言う**(#1006)。
   *
   * ⚠ 書き戻しは 1 回の bulk なので、**終わってから言うと間に合わない** ──
   *   いちばん長い間ずっと「拾っています…」のままになり、user は**止まった**と
   *   読んで窓を閉じる(閉じられると、書き戻しが途中で終わる)。
   * ⚠ この順番は**結果を見る assert では 1 ビットも動かない** ── どちらでも
   *   「3 件戻った」は成り立つ(CLAUDE.md「挙動を変えたのに test が前も後も通るなら、
   *   それは守っていない」)。
   */
  it('🔴 「戻しています」と言ってから書き戻す', async () => {
    const h = harness();
    await rebuildContainer('c-old', 't', h.ports);
    const said = h.calls.indexOf('progress:write');
    const wrote = h.calls.findIndex((c) => c.startsWith('writeEntries:'));
    // ⚠ 空振り防止 ── どちらも本当に起きていること
    expect(said, '戻している途中を 1 度も言っていない').toBeGreaterThan(-1);
    expect(wrote, '書き戻していない').toBeGreaterThan(-1);
    expect(said, '書き戻した後に言っている(いちばん長い間、古い字のままになる)').toBeLessThan(
      wrote,
    );
    // ⚠ 対照群 ── 拾っている途中は、その前に言っている
    const picked = h.calls.indexOf('progress:pick');
    expect(picked, '拾っている途中を言っていない').toBeGreaterThan(-1);
    expect(picked, '拾うより先に戻すと言っている').toBeLessThan(said);
  });

  /**
   * 🔴 **戻らない物の一覧は、いまは空である**(#1087）。
   *
   * ⚠ 「どのフォルダに入っていたか / つながり / 履歴」は、索引だけ壊れた DB なら表走査で読める
   *   （2026-10-14 実測）ので、読めた分は戻す。空に戻したのが偽りでないことは、
   *   下の「つながり・履歴・色が戻る」と、マニュアルの表との等値（docs-parity）が見ている。
   * ⚠ 一覧に何か戻したら、押す前の窓と終わった後の字の**両方**がその語を言うこと。
   */
  it('🔴 戻らない物の呼び名が、押す前の窓と終わった後の字で揃っている', async () => {
    const before = rebuildExplainMessage({ notes: 3, assetsOnDisk: 2 });
    const after = rebuildDoneMessage(await rebuildContainer('c-old', 't', harness().ports));
    for (const lost of REBUILD_LOST) {
      expect(before, `押す前の窓が「${lost}」を言っていない`).toContain(lost);
      expect(after, `終わった後の字が「${lost}」を言っていない`).toContain(lost);
    }
    // 🔑 空のとき「戻らないもの」の節を出さない（見出しだけが残る字にしない）
    if (REBUILD_LOST.length === 0) expect(before).not.toContain('戻らないもの');
    // 読めた分は戻ることを、押す前に言う
    expect(before, '読めた分が戻ることを言っていない').toContain('読めた分');
  });

  /**
   * 🔴 **押す前の窓は「何が起きるか」を順に言う**(#1006)。
   *
   * ⚠ この口を押す人は**壊れたと言われた直後**なので、いちばん怖いのは
   *   「押したら消えるのではないか」である ── 🔑 **先に手元へ落ちること**と
   *   **落とせなければ止まること**を、窓の字で言い切る。
   */
  it('🔴 押す前の窓が、順番と「落とせなければ止まる」を言う', () => {
    const m = rebuildExplainMessage({ notes: 12, assetsOnDisk: 4 });
    expect(m, '件数を言っていない').toContain('12 件');
    expect(m, '先にファイルを落とすことを言っていない').toContain('.pkc3-part.zip');
    expect(m, '落とせなかったときに止まることを言っていない').toContain('何も消さずに止まります');
    expect(m, '添付の件数を言っていない').toContain('添付したファイル 4 件');
    expect(m, '他のタブが読み込み直されることを言っていない').toContain('他のタブ');
  });

  /**
   * 🔴 **数えられなかったときに「N 件は残ります」と書かない**(#1005 と同じ向き)。
   * ⚠ 書くと、**添付を失う側の人がいちばん安心する**。
   */
  it('🔴 添付を数えられなければ、数を言わずにそう言う', () => {
    const unknown = rebuildExplainMessage({ notes: 1, assetsOnDisk: null });
    expect(unknown, '数えられなかったことを言っていない').toContain('数えられませんでした');
    // 対照群 ── 数えられた回は、数がそのまま出る
    expect(rebuildExplainMessage({ notes: 1, assetsOnDisk: 7 })).toContain(
      '添付したファイル 7 件',
    );
    // ⚠ 0 件の人に「0 件の添付は残ります」と数で言わない
    expect(rebuildExplainMessage({ notes: 1, assetsOnDisk: 0 }), '0 件を数で言っている')
      .not.toContain('添付したファイル 0 件');
  });
});

/**
 * 🔴 **捨てた後に落ちたら、投げずに「結末」として返す**(#1006 の着地前レビューが出した)。
 *
 * ## 何が起きていたか
 *
 * 直す前は②(捨てる)③(開き直す)が**裸**で、落ちると呼び側の 1 つの `catch` へ
 * 飛んでいた ── そこは「**何も消えていません**」と言う所である。
 * 🔴 ②が通った後なら **DB はもう無い**ので、いちばん安心させる字が**いちばん嘘**になる。
 * ⚠ しかも呼び側は例外のとき**読み込み直さない**ので、`terminate()` 済みの client を
 * 握ったまま画面が残り、**以後の保存が全部落ちる**(`store client terminated`)。
 *
 * ## ⚠ この経路は、直す前は test にも実装にも 1 行も無かった
 *
 * 台は `wipeStorage` / `reopenStorage` を**どのケースでも落とさなかった**ので、
 * 「zip を落とす前だから何も消えていない」という呼び側のコメントは
 * **どの test にも検算されていなかった**(CLAUDE.md §2「経路が一度も通っていない」)。
 */
describe('🔴 捨てた後に落ちた回(#1006)', () => {
  it('🔴 捨てる所で落ちても、投げずに報告を返す', async () => {
    const h = harness({ failWipe: '消せません' });
    const r = await rebuildContainer('c-old', 't', h.ports);
    expect(r.outcome, '捨てる所で落ちたのに、結末が分けられていない').toBe('storage-lost');
    expect(r.error, '理由を持っていない').toContain('消せません');
    // ⚠ 対照群 ── ①(zip)で落ちたときは**投げる**(そちらは「何も消えていない」が真)
    const zip = harness({ failArchive: '書き出せません' });
    await expect(rebuildContainer('c-old', 't', zip.ports)).rejects.toThrow('書き出せません');
  });

  it('🔴 捨てた後に開き直しが落ちても、投げずに報告を返す', async () => {
    const h = harness({ failReopen: 'DB 画像を読み込めませんでした' });
    const r = await rebuildContainer('c-old', 't', h.ports);
    expect(r.outcome).toBe('storage-lost');
    // 🔑 ②は通っているので、捨てたことは報告に出る
    expect(r.wiped, '捨てた後なのに「捨てていない」と報告している').toBe(true);
    expect(r.restored, '書き戻していないのに件数が立っている').toBe(0);
  });

  it('🔴 落ちても、他のタブへは知らせる(器はもう無いので)', async () => {
    const h = harness({ failReopen: 'ダメ' });
    await rebuildContainer('c-old', 't', h.ports);
    expect(h.calls, '器が無いのに他のタブへ知らせていない').toContain('announceWiped');
    expect(h.calls, 'この端末の断片を落としていない').toContain('forgetLocal');
  });

  /**
   * ⚠ **知らせる所も落ちうる** ── そこで投げると、呼び側はまた例外の枝へ行き、
   *   **また「何も消えていません」と言う**(直したはずの穴が戻る)。
   */
  it('🔴 知らせる所が落ちても、報告だけは必ず返す', async () => {
    const h = harness({ failReopen: 'ダメ' });
    const ports: RebuildPorts = {
      ...h.ports,
      announceWiped: () => {
        throw new Error('知らせられません');
      },
    };
    const r = await rebuildContainer('c-old', 't', ports);
    expect(r.outcome, '知らせに失敗しただけで報告ごと失っている').toBe('storage-lost');
  });

  it('🔴 字は「何も消えていません」と言わず、ファイルが手元に在ることを言う', () => {
    const line = rebuildDoneMessage({
      outcome: 'storage-lost',
      rescued: { entries: 3, skipped: 0, empty: 0, bodyMissing: 0, assets: 0, assetBytes: 0, assetMissing: 0 },
      restored: 0,
      relationsRestored: 0,
      revisionsRestored: 0,
      extrasPartial: false,
      tagColorsRestored: 0,
      wiped: true,
      note: null,
      fallbackReason: null,
      error: 'DB 画像を読み込めませんでした',
    });
    expect(line, '捨てた後なのに「何も消えていません」と言っている').not.toContain(
      '何も消えていません',
    );
    expect(line, 'ファイルが手元に在ることを言っていない').toContain('手元にあります');
    expect(line, '読み込み直すよう言っていない').toContain('読み込み直して');
    expect(line, '戻す道(取り込む)を案内していない').toContain('取り込む');
  });
});

/**
 * 🔴 **戻った後の見え方を、先に言う**（#1006 → #1087）。
 *
 * ⚠ 以前は「全部が根元に平らに並ぶ」画面になるため、押す前にそう言っていた（#1006 の動線レビュー）。
 *   つながりを拾って戻すようになったので、平らになるのは**読めなかった分だけ**になった。
 *   ⚠ 字を残すと戻った画面と食い違うので、**読めない分は戻らない**ことを言う形に変えた。
 */
describe('🔴 戻った後の見え方を、先に言う（#1087）', () => {
  it('🔴 押す前の窓が「読めない所があるときは戻らない」と言い、平らに並ぶとは言わない', () => {
    const m = rebuildExplainMessage({ notes: 3, assetsOnDisk: 0 });
    expect(m, '読めない分が戻らないことを言っていない').toContain('その分は戻りません');
    expect(m, '戻った画面と食い違う字が残っている').not.toContain('フォルダの外の一覧にまとめて');
  });

  it('🔴 読めない区画があったとき、終わった後の字が「戻っていない」と言う（対照群つき）', async () => {
    const partial = rebuildDoneMessage(
      await rebuildContainer('c-old', 't', harness({ extrasSkipped: 2 }).ports),
    );
    expect(partial, '読めなかったつながり・履歴を黙っている').toContain('その分は戻っていません');
    const clean = rebuildDoneMessage(await rebuildContainer('c-old', 't', harness().ports));
    expect(clean, '全部読めたのに「戻っていない」と言っている').not.toContain('戻っていません');
  });

  it('🔴 押す前の窓が「途中で止められない」と言う', () => {
    expect(rebuildExplainMessage({ notes: 1, assetsOnDisk: 0 })).toContain(
      '途中で止めることはできません',
    );
  });
});

const REL: RescuedRelation = {
  rowid: 1,
  cid: 'c-old',
  id: 'r1',
  fromLid: 'a1',
  toLid: 'b2',
  kind: 'structural',
};
const REV = (over: Partial<RescuedRevision>): RescuedRevision => ({
  rowid: 1,
  cid: 'c-old',
  entryLid: 'a1',
  revOrder: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  title: '牛乳を買う',
  archetype: 'text',
  kind: 'full',
  snapshot: '古い本文',
  contentHash: null,
  ...over,
});

/**
 * 🔴 **つながり・履歴・添付の登録行・タグの色が、作り直しの後に戻る**（#1087）。
 *
 * ⚠ 作り直しは sqlite を丸ごと捨てる。ノートだけを書き戻していたので、
 *   ①添付の登録行（bytes は IndexedDB に残る）②タグの色（`settings` 表）③つながり・履歴は
 *   **黙って消えていた**。画面は「添付 N 件はそのまま残っています」と言っていた。
 */
describe('🔴 つながり・履歴・添付の登録行・色が戻る（#1087）', () => {
  it('🔴 添付の登録行を、IndexedDB に残った bytes から組み直す（hash は null）', async () => {
    const h = harness({
      assets: new Map([
        ['k1', new Blob(['PNGBYTES'], { type: 'image/png' })],
        ['k2', new Blob(['xyz'])],
      ]),
    });
    await rebuildContainer('c-old', 't', h.ports);
    expect(h.wrote.assetMetas, '登録行を戻していない（バックアップに添付が 0 件で出る）').toEqual([
      { key: 'k1', mime: 'image/png', size: 8, hash: null },
      // ⚠ 型が分からない物は null（でっち上げない）
      { key: 'k2', mime: null, size: 3, hash: null },
    ]);
  });

  it('🔴 捨てる前に読んだ色を、そのまま戻す', async () => {
    const colors = [{ tag: '仕事', color: '#ff0000' }];
    const h = harness({ tagColors: colors });
    const r = await rebuildContainer('c-old', 't', h.ports);
    expect(h.wrote.tagColors).toEqual(colors);
    expect(r.tagColorsRestored).toBe(1);
    // 🔑 読むのは捨てる前
    expect(h.calls.indexOf('readTagColors')).toBeLessThan(h.calls.indexOf('wipeStorage'));
  });

  it('🔴 保険の zip にも色が入る（メモリ上のみ / 書き戻し失敗で終わっても色が残る）', async () => {
    const colors = [{ tag: '仕事', color: '#ff0000' }];
    let blob: Blob | null = null;
    const h = harness({ tagColors: colors });
    const ports: RebuildPorts = {
      ...h.ports,
      saveArchive: async (source) => {
        blob = (await writeArchive(source, NOW)).blob;
      },
    };
    await rebuildContainer('c-old', 't', ports);
    const got = await readArchive(blob!);
    expect(got.tagColors, '色が zip に入っていない').toEqual(colors);
  });

  it('🔴 読めた並びと時刻を書き戻す・zip にも入れる。読めない分は拾った順 / null', async () => {
    const rows: RescuedRow[] = [
      { ...THREE[0]!, entryOrder: 7, createdAt: '2020-01-02 03:04:05', updatedAt: '2021-02-03 04:05:06' },
      { ...THREE[1]!, entryOrder: null, createdAt: null, updatedAt: null },
    ];
    const h = harness({ rows });
    let blob: Blob | null = null;
    const ports: RebuildPorts = {
      ...h.ports,
      saveArchive: async (source) => {
        blob = (await writeArchive(source, NOW)).blob;
      },
    };
    await rebuildContainer('c-old', 't', ports);
    const w = h.writtenFull();
    expect(w.map((e) => e.entryOrder), '並びを失っている').toEqual([7, 2]);
    expect(w[0]!.createdAt).toBe('2020-01-02 03:04:05');
    expect(w[0]!.updatedAt).toBe('2021-02-03 04:05:06');
    expect(w[1]!.createdAt, '読めない時刻をでっち上げた').toBeNull();
    const z = (await readArchive(blob!)).entries;
    expect(z.map((e) => e.entryOrder)).toEqual([7, 2]);
    expect(z[0]!.createdAt).toBe('2020-01-02 03:04:05');
    expect(z[1]!.createdAt).toBeNull();
  });

  it('🔴 色が読めなくても、建て直しは止めない', async () => {
    const h = harness();
    const ports: RebuildPorts = {
      ...h.ports,
      readTagColors: async () => {
        throw new Error('settings が読めません');
      },
    };
    const r = await rebuildContainer('c-old', 't', ports);
    expect(r.outcome).toBe('rebuilt');
    expect(r.tagColorsRestored).toBe(0);
  });

  it('🔴 つながり・履歴を戻し、件数を字で言う', async () => {
    const h = harness({
      relations: [REL],
      // ⚠ 拾う順（行番号順）は古い → 新しい ── 保存形（新しい → 古い）への並べ直しを見る
      revisions: [REV({ rowid: 1, revOrder: 1, snapshot: 'もっと古い' }), REV({ rowid: 2, revOrder: 2 })],
    });
    const r = await rebuildContainer('c-old', 't', h.ports);
    expect(h.wrote.relations.map((x) => x.id)).toEqual(['r1']);
    // 🔑 鎖は保存形の並び（新しい → 古い）
    expect([...(h.wrote.chains.get('a1') ?? [])].map((x) => x.revOrder)).toEqual([2, 1]);
    expect(r.relationsRestored).toBe(1);
    expect(r.revisionsRestored).toBe(2);
    const line = rebuildDoneMessage(r);
    expect(line).toContain('つながり 1 件');
    expect(line).toContain('履歴 2 版');
    expect(r.extrasPartial).toBe(false);
  });

  it('🔴 拾ったつながり・履歴は、zip にも入る（保険の zip が先に落ちるので）', async () => {
    let blob: Blob | null = null;
    const h = harness({ relations: [REL], revisions: [REV({})] });
    const ports: RebuildPorts = {
      ...h.ports,
      saveArchive: async (source) => {
        blob = (await writeArchive(source, NOW)).blob;
      },
    };
    await rebuildContainer('c-old', 't', ports);
    const got = await readArchive(blob!);
    expect(got.relations.map((x) => x.id), 'つながりが zip に入っていない').toEqual(['r1']);
    expect(got.revisions?.length ?? 0, '履歴が zip に入っていない').toBeGreaterThan(0);
  });

  it('🔴 器の id が違う行・拾えなかったノートに付く行は、戻さない（宙に浮くので）', async () => {
    const h = harness({
      relations: [
        REL,
        { ...REL, id: 'other-cid', cid: 'someone-else' },
        { ...REL, id: 'dangling', toLid: 'ghost' },
      ],
      revisions: [REV({}), REV({ rowid: 2, entryLid: 'ghost' }), REV({ rowid: 3, cid: 'x' })],
    });
    await rebuildContainer('c-old', 't', h.ports);
    expect(h.wrote.relations.map((x) => x.id)).toEqual(['r1']);
    expect([...h.wrote.chains.keys()]).toEqual(['a1']);
    expect(h.wrote.chains.get('a1')).toHaveLength(1);
  });

  it('🔴 つながり・履歴の書き戻しが落ちたら write-failed（黙って減らさない）', async () => {
    const h = harness({ relations: [REL] });
    const ports: RebuildPorts = {
      ...h.ports,
      writeRelations: async () => {
        throw new Error('relations が書けません');
      },
    };
    const r = await rebuildContainer('c-old', 't', ports);
    expect(r.outcome).toBe('write-failed');
    expect(r.error).toContain('relations');
  });

  it('⚠ つながりの拾い出しが丸ごと落ちても、ノートは戻し、読めなかったと言う', async () => {
    const h = harness();
    const ports: RebuildPorts = {
      ...h.ports,
      pickRelations: async () => {
        throw new Error('読めません');
      },
    };
    const r = await rebuildContainer('c-old', 't', ports);
    expect(r.outcome).toBe('rebuilt');
    expect(r.restored).toBe(3);
    expect(r.extrasPartial).toBe(true);
  });
});

/**
 * 🔴 **最大の行番号が読めないほど壊れた DB でも、拾い出しは終わる**（#1087）。
 *
 * ⚠ `maxRowid` が `null` のままだと `done` が永久に立たず、位置だけが進み続けて
 *   「作り直す」も壊れたときのバックアップも**進捗の表示のまま固まっていた**。
 */
describe('🔴 拾い出しが終わらない形を打ち切る（#1087）', () => {
  const endless = (calls: { n: number }) => async (after: number) => {
    calls.n += 1;
    // 必ず前へ進むが、何も拾えず、最大の行番号も分からず、終わらない
    return { rows: [], lastRowid: after + 4000, skipped: 1, empty: 19, maxRowid: null, done: false };
  };

  it('🔴 collectRescued は有限回で終わり、打ち切ったことが結果に出る', async () => {
    const calls = { n: 0 };
    const r = await collectRescued(endless(calls));
    expect(calls.n, '打ち切っていない（無限に回る形）').toBe(RESCUE_IDLE_PAGE_LIMIT);
    expect(r.truncated, '打ち切ったことが結果に出ていない').toBe(true);
    expect(r.rows).toEqual([]);
  });

  it('⚠ 対照群 ── 途中で拾えた回があれば、数え直す（拾えている相手を切らない）', async () => {
    let n = 0;
    const r = await collectRescued(async (after) => {
      n += 1;
      // 49 回空 → 1 回拾える → また 49 回空 …… を 3 周 → 最後は done
      const hit = n % 50 === 0;
      return {
        rows: hit ? [{ rowid: after + 1, lid: `l${n}`, title: 't', archetype: 'text', body: 'b' }] : [],
        lastRowid: after + 4000,
        skipped: 0,
        empty: 0,
        maxRowid: n >= 150 ? 150 * 4000 : null,
        done: n >= 150,
      };
    });
    expect(r.truncated, '拾えている相手を打ち切った').toBe(false);
    expect(r.rows.length).toBe(3);
  });

  it('⚠ 対照群 ── 最大の行番号が読めているときは、空の周が続いても数えない（done が終わらせる）', async () => {
    let n = 0;
    const r = await collectRescued(async (after) => {
      n += 1;
      return {
        rows: [],
        lastRowid: after + 4000,
        skipped: 0,
        empty: 20,
        maxRowid: 400_000,
        done: n >= 100,
      };
    });
    expect(r.truncated, '読めている DB を切った').toBe(false);
    expect(n).toBe(100);
  });

  it('🔴 つながり・履歴の拾い出しも、同じ守りで終わる', async () => {
    const calls = { n: 0 };
    const stub = endless(calls);
    const x = await collectRescuedExtras('c', new Set(['a']), { relations: stub, revisions: stub });
    expect(calls.n, 'どちらかが打ち切っていない').toBe(RESCUE_IDLE_PAGE_LIMIT * 2);
    expect(x.truncated).toBe(true);
  });

  it('🔴 作り直しは打ち切っても進み、字で言う', async () => {
    const calls = { n: 0 };
    const h = harness();
    const stuck = endless(calls);
    const ports: RebuildPorts = {
      ...h.ports,
      // 最初の周だけ 3 件拾え、その後は最大の行番号が読めないまま何も出ない
      pick: async (after) =>
        after === 0
          ? {
              rows: THREE.map((r, i) => ({ rowid: i + 1, ...r })),
              lastRowid: 4000,
              skipped: 0,
              empty: 0,
              maxRowid: null,
              done: false,
            }
          : stuck(after),
    };
    const r = await rebuildContainer('c-old', 't', ports);
    expect(r.outcome).toBe('rebuilt');
    expect(r.rescued.truncated).toBe(true);
    expect(rebuildDoneMessage(r)).toContain('途中で打ち切りました');
  });
});
