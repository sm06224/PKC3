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
import { readZipEntry } from '../../src/features/import/zip-reader';
import {
  collectRescued,
  rebuildContainer,
  rebuildDoneMessage,
  rebuildExplainMessage,
  rebuiltEntries,
  REBUILD_LOST,
  type RebuildPorts,
  type RescuedRow,
} from '../../src/features/storage/container-rebuild';
import type { RescuePageLike } from '../../src/features/storage/rescue-archive';

const NOW = '2026-09-18T00:00:00.000Z';

const THREE: RescuedRow[] = [
  { lid: 'a1', title: '牛乳を買う', archetype: 'text', body: '# 牛乳を買う\n\n近所で\n' },
  { lid: 'b2', title: '会議のメモ', archetype: 'text', body: '# 会議のメモ\n\n- 決めたこと\n' },
  { lid: 'c3', title: '日本語の題', archetype: 'text', body: '# 日本語の題\n\nあいうえお\n' },
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
    assets?: Map<string, Blob>;
    skippedPerPage?: number;
  } = {},
): { ports: RebuildPorts; calls: string[]; written: () => readonly { lid: string }[] } {
  const calls: string[] = [];
  let written: readonly { lid: string }[] = [];
  const idb = over.assets;
  const ports: RebuildPorts = {
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
      return { wiped: true, note: null };
    },
    reopenStorage: async () => {
      calls.push('reopenStorage');
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
  return { ports, calls, written: () => written };
}

describe('🔴 拾った中身で、その場に建て直す(#1006)', () => {
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
      'saveArchive',
      'wipeStorage',
      'reopenStorage',
      'writeEntries:c-old:3',
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
      { lid: 't1', title: '買い物', archetype: 'todo', body: '# 買い物\n\n- [x] 牛乳\n' },
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
  it('⚠ 読めなかった区画を字に出し、戻らない物も言う', async () => {
    const h = harness({ skippedPerPage: 3 });
    const r = await rebuildContainer('c-old', 't', h.ports);
    const line = rebuildDoneMessage(r);
    expect(line).toContain('3 件を戻しました');
    expect(line, '読めなかった区画を黙っている').toContain('読めなかった区画');
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
    const bytes = await readZipEntry(blob!, got.assetSources.get('k1')!.entry);
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
   * 🔴 **押す前の窓と、終わった後の字が、同じ語で戻らない物を言う**(§7)。
   *
   * ⚠ 呼び名を 2 か所に手で書くと、片方だけ直した日に user は
   *   「**別の物も消えた**」と読む ── だから `REBUILD_LOST` から引かせて、
   *   ここで**両側に届いていること**を見る。
   */
  it('🔴 戻らない物の呼び名が、押す前の窓と終わった後の字で揃っている', async () => {
    // ⚠ 空振り防止 ── 一覧が空なら、下の for は 1 度も回らない
    expect(REBUILD_LOST.length, '戻らない物の一覧が空').toBeGreaterThan(0);
    const before = rebuildExplainMessage({ notes: 3, assetsOnDisk: 2 });
    const after = rebuildDoneMessage(await rebuildContainer('c-old', 't', harness().ports));
    for (const lost of REBUILD_LOST) {
      expect(before, `押す前の窓が「${lost}」を言っていない`).toContain(lost);
      expect(after, `終わった後の字が「${lost}」を言っていない`).toContain(lost);
    }
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
    expect(m, '先にファイルを落とすことを言っていない').toContain('.pkc3.zip');
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
