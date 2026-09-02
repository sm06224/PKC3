/**
 * 添付取込(P4a)の unit: File → Blob 直 put + meta 同時書き + entry 作成。
 * fake deps で put/list を記録し、dedupe / quota / mime fallback の縁を pin。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { attachFiles, resolveMime, type AttachDeps } from '../../src/adapter/ui/actions/attach';
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';
import { stubRevisionOps } from '../helpers/revision-stub';

function harness(estimate?: AttachDeps['estimate']) {
  const putBlobs: Array<{ key: string; size: number }> = [];
  const metas: Array<{ key: string; mime: string; size: number; hash: string | null }> =
    [];
  const deps: AttachDeps = {
    putBlob: async (key, blob) => {
      putBlobs.push({ key, size: blob.size });
    },
    putMeta: async (m) => {
      metas.push(m);
    },
    listMetas: async () => [...metas], // 実装内部の push と共有しない(実 API 同様に copy)
    estimate,
  };
  const d = new Dispatcher();
  const persisted: Array<{ lid: string; body: string }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => null,
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () =>
      Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push({ lid: e.lid, body: e.body });
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  /**
   * 🔴 **本文へ入った参照を採る**(#666)。⚠ `APPEND_TO_ENTRY` の reducer が出す
   *   `REQUEST_APPEND` を見る ── 「本文に入った」の観測点はここ 1 つである
   *   (`persisted` は保存の側なので、入ったかどうかは読めない)。
   */
  d.onEvent((e) => {
    if (e.type === 'REQUEST_APPEND') appendsSeen.push({ lid: e.lid, text: e.text });
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { d, deps, putBlobs, metas, persisted };
}

/** ⚠ 各 it の頭で空にする(harness ごとに張り直すので溜まる)。 */
const appendsSeen: Array<{ lid: string; text: string }> = [];

const tick = () => new Promise((r) => setTimeout(r, 10));

/**
 * 🔴 **添付は、開いていたノートの本文へ入る**(user 裁定 2026-09-02、#666)。
 *
 * > 「読んでいたノートの本文に入る」
 *
 * ## 直す前に何が起きていたか(#666 の実測)
 *
 * `attachOne` は `CREATE_ENTRY archetype:'attachment'` を撃つだけで、reducer が
 * `selectedLid` を**新しい添付へ移す** ── つまり写真を選ぶと
 * **画面が「IMG_0421.jpg」に変わり、読んでいたノートは画面から消えて**、
 * 本文には **1 文字も入らなかった**。⚠ 録音・画面録画は逆(選択を返し、参照を入れる)。
 *
 * ## この describe が守る主張
 *
 * ① 🔴 **開いていたノートへ選択が返る**(画面ごと持っていかれない)
 * ② 🔴 **本文の末尾に参照が 1 行入る**
 * ③ 🔴 **画像は `![…]`、それ以外は `[…]`**(画像は本文で描かれる)
 * ④ 🔴 **入れ先は「押した時点で開いているノート」** ── 2 枚目以降も**同じノート**へ
 *    入る(1 枚目の添付が選択を奪った後に、添付自身を入れ先だと読まない)
 * ⑤ ⚠ **ノートを開いていなければ、そこまで言う**(黙って終わらない)
 */
describe('添付を開いていたノートへ入れる(#666)', () => {
  /** ⚠ 入れ先になれるノートを 1 件作って開く(台の前提)。 */
  function withOpenNote() {
    const h = harness();
    h.d.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'n1',
      title: '買い物メモ',
      body: '# 買い物メモ',
      edit: false,
    });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '# 買い物メモ' });
    expect(h.d.getState().selectedLid, '台が開けていない(前提が崩れた)').toBe('n1');
    return h;
  }

  /** そのノートへ入った参照の行(`APPEND_TO_ENTRY` の text)。 */
  function appended(d: Dispatcher): string[] {
    return d.getState().entryMetas.has('n1')
      ? appendsSeen.filter((a) => a.lid === 'n1').map((a) => a.text)
      : [];
  }

  it('🔴 ① ② ③ 選択が返り、本文の末尾に参照が 1 行入る(画像は ![…])', async () => {
    const h = withOpenNote();
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [
      new File(['png bytes'], '猫.png', { type: 'image/png' }),
    ]);
    await tick();

    expect(h.d.getState().selectedLid, '画面ごと添付へ持っていかれた').toBe('n1');
    const lines = appended(h.d);
    expect(lines, '本文に 1 行も入っていない').toHaveLength(1);
    expect(lines[0], '画像なのに ![…] になっていない').toMatch(/^!\[猫\.png\]\(asset:/);
  });

  it('🔴 ③ 画像でなければ ![…] にしない(描けない物を描こうとしない)', async () => {
    const h = withOpenNote();
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [
      new File(['pdf bytes'], '資料.pdf', { type: 'application/pdf' }),
    ]);
    await tick();
    const lines = appended(h.d);
    expect(lines).toHaveLength(1);
    expect(lines[0], 'PDF を画像として置いている').toMatch(/^\[資料\.pdf\]\(asset:/);
  });

  /**
   * 🔴 **④ 2 枚目以降も同じノートへ入る。**
   * ⚠ 入れ先を輪の**中**で採ると、1 枚目の `CREATE_ENTRY` が `selectedLid` を
   *   奪った後なので、2 枚目は**添付自身**を入れ先だと読む(20 枚落とすと 19 枚が迷子)。
   */
  it('🔴 ④ 2 枚まとめて落としても、2 枚とも同じノートへ入る', async () => {
    const h = withOpenNote();
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]);
    await tick();
    expect(h.d.getState().selectedLid).toBe('n1');
    expect(appended(h.d), '2 枚目が別のノートへ入った').toHaveLength(2);
  });

  /**
   * 🔴 **⑥ 開いているのが「追記できない種類」なら、入れずに、そこへ戻って理由を言う。**
   *
   * ⚠ この枝は **実ブラウザ smoke が教えた**(#412 の spec が落ちた)── 添付を
   *   開いたまま 2 枚目を足すと、**開いていた添付のほうへ戻る**ので、画面は
   *   新しいほうを見せない。spec はそこを知らずに「取り込んだものが勝手に開く」に
   *   寄りかかっており、**1 枚目の大きさを 2 枚目のものとして読んでいた**。
   * 🔑 振る舞いは録音・画面録画と同じ(判定は `asset-into-note.ts` 1 か所)──
   *   user 裁定の「**読んでいたものは開いたまま**」を、入れられない回でも守る。
   */
  it('🔴 ⑥ 開いているのが添付なら、本文へ入れず、開いていたほうへ戻る', async () => {
    const h = harness();
    await attachFiles(h.d, h.deps, [new File(['a'], '1枚目.png', { type: 'image/png' })]);
    await tick();
    const first = h.d.getState().selectedLid;
    expect(first, '1 枚目が開いていない(台の前提が崩れた)').not.toBeNull();

    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [new File(['b'], '2枚目.png', { type: 'image/png' })]);
    await tick();

    expect(appendsSeen, '追記できない種類なのに本文へ書いた').toHaveLength(0);
    expect(h.d.getState().selectedLid, '開いていた添付へ戻っていない').toBe(first);
    expect(h.d.getState().notice ?? '', '黙って終わっている').toContain('追記できない種類');
  });

  /** ⚠ ⑤ 対照群 ── 開いていなければ入れず、そのことを言う(黙って終わらない)。 */
  it('🔴 ⑤ ノートを開いていなければ入れず、理由を言う', async () => {
    const h = harness();
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [new File(['x'], 'x.png', { type: 'image/png' })]);
    await tick();
    expect(appendsSeen, '開いていないのに本文へ書いた').toHaveLength(0);
    expect(h.d.getState().notice ?? '', '黙って終わっている').toContain(
      'ノートを開いていない',
    );
  });
});

describe('attachFiles (P4a intake)', () => {
  it('Blob 直 put + meta(hash/size 同時)+ 非編集 entry 作成', async () => {
    const { d, deps, putBlobs, metas } = harness();
    await attachFiles(d, deps, [new File(['hello bytes'], 'note.txt', { type: 'text/plain' })]);
    await tick();

    expect(putBlobs).toHaveLength(1);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ mime: 'text/plain', size: 11 });
    expect(metas[0]!.hash).toMatch(/^[0-9a-f]{64}$/); // put と同時に SHA-256 が書かれる

    const s = d.getState();
    expect(s.phase).toBe('ready'); // editor に入らない(silent attach)
    expect(s.freshLid).toBeNull(); // fresh 掃除の対象外
    const meta = [...s.entryMetas.values()][0]!;
    expect(meta.archetype).toBe('attachment');
    expect(meta.title).toBe('note.txt');
    expect(s.selectedLid).toBe(meta.lid);
    // body は frontmatter メタ(JSON body を作らない)
    const att = readAttachmentMeta(s.openBody!.body);
    expect(att).toMatchObject({ name: 'note.txt', mime: 'text/plain', size: 11 });
    expect(att.assetKey).toBe(putBlobs[0]!.key);
  });

  it('同一 bytes(hash+size 一致)は既存 asset を再利用 ── put しない', async () => {
    const { d, deps, putBlobs, persisted } = harness();
    const bytes = 'same content';
    await attachFiles(d, deps, [new File([bytes], 'a.txt', { type: 'text/plain' })]);
    await attachFiles(d, deps, [new File([bytes], 'b.txt', { type: 'text/plain' })]);
    await tick();

    expect(putBlobs).toHaveLength(1); // 2 回目は bytes を書かない
    expect(persisted).toHaveLength(2); // entry は 2 つ
    const keys = persisted.map((e) => readAttachmentMeta(e.body).assetKey);
    expect(keys[0]).toBe(keys[1]); // 両 entry が同じ asset_key を参照
    expect(d.getState().entryMetas.size).toBe(2);
  });

  it('quota 不足は可視エラーで file 単位 skip(batch は続行)', async () => {
    const { d, deps, putBlobs } = harness(async () => ({ usage: 90, quota: 100 }));
    await attachFiles(d, deps, [new File(['0123456789'], 'big.bin', { type: '' })]);
    expect(putBlobs).toHaveLength(0);
    expect(d.getState().error).toMatch(/空き容量/);
    expect(d.getState().phase).toBe('ready'); // 非致命
  });

  it('編集中(phase!==ready)は put 前に可視ブロック ── bytes も entry も作らない', async () => {
    const { d, deps, putBlobs, metas } = harness();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'lid-editing', title: 'draft' });
    expect(d.getState().phase).toBe('editing');

    await attachFiles(d, deps, [new File(['x'], 'late.txt', { type: 'text/plain' })]);
    await tick();

    // put の前に止まる ── orphan asset(bytes だけ書かれ entry 黙殺)を作らない
    expect(putBlobs).toHaveLength(0);
    expect(metas).toHaveLength(0);
    expect(d.getState().entryMetas.size).toBe(1); // draft entry のみ、添付 entry は増えない
    expect(d.getState().error).toMatch(/編集を終了/); // 無言拒否にしない(可視)
    expect(d.getState().phase).toBe('editing'); // draft は無傷
  });

  it('mime fallback: file.type 空は拡張子から解決(PKC2 の欠落 hack を作らない)', () => {
    expect(resolveMime('doc.md', '')).toBe('text/markdown');
    expect(resolveMime('img.PNG', '')).toBe('image/png');
    expect(resolveMime('unknown.zzz', '')).toBe('application/octet-stream');
    expect(resolveMime('x.md', 'text/plain')).toBe('text/plain'); // 宣言優先
  });
});
