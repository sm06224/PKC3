/**
 * 添付取込(P4a)の unit: File → Blob 直 put + meta 同時書き + entry 作成。
 * fake deps で put/list を記録し、dedupe / quota / mime fallback の縁を pin。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { attachFiles, resolveMime, type AttachDeps } from '../../src/adapter/ui/actions/attach';
import { dropCursor, putAssetIntoNote } from '../../src/adapter/ui/actions/asset-into-note';
import { createWritableQueue } from '../../src/adapter/ui/actions/writable-queue';
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';
import { removeInsertedLines } from '../../src/features/markdown/append-target';
import { stubRevisionOps } from '../helpers/revision-stub';

/** ⚠ 実物の効果層を差し替える口(遅い `getBody` で錠を握らせる等)。 */
type StoreOver = {
  getBody?: (lid: string) => Promise<string | null>;
  /** 保存を横取りする(#684 段④ ── 書いた本文を disk に返して、次の 1 枚に読ませる)。 */
  onPersist?: (lid: string, body: string) => void;
};

function harness(estimate?: AttachDeps['estimate'], over?: StoreOver) {
  const putBlobs: Array<{ key: string; size: number }> = [];
  const metas: Array<{ key: string; mime: string; size: number; hash: string | null }> =
    [];
  const deps: AttachDeps = {
    gate: (run) => run(), // #724 ⑤: 単体では門を模さない(そのまま走らせる)
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
    getBody: over?.getBody ?? (async () => null),
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
      over?.onPersist?.(e.lid, e.body);
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
  function withOpenNote(over?: StoreOver) {
    const h = harness(undefined, over);
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

  /**
   * 🔴 **入れ先を名指しできる**(#826)。
   *
   * ⚠ 要るのは、**選ぶ間ずっと画面を止めていない**口(書庫の別の窓)ができたからである
   *   ── 選んでいる間に user が別のノートへ移ると、`selectedLid` は**押したときと
   *   違うノート**を指す。⚠ modal は周りを止めることで**入れ先の身元**も守っていた
   *   (CLAUDE.md §10)。
   * 🔑 見るのは「名指しした側へ入る」ことと、⚠ **対照群**(名指ししなければ今までどおり)。
   */
  it('🔴 入れ先を名指しすると、いま選んでいるノートが動いていてもそちらへ入る', async () => {
    const h = withOpenNote();
    appendsSeen.length = 0;
    h.d.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'n2',
      title: 'ほかのノート',
      body: '# ほかのノート',
      edit: false,
    });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(h.d.getState().selectedLid, '台が崩れた(移れていない)').toBe('n2');

    await attachFiles(
      h.d,
      h.deps,
      [new File(['a'], 'a.png', { type: 'image/png' })],
      '',
      undefined,
      'n1',
    );
    await tick();
    expect(appended(h.d), '名指しした n1 へ入っていない').toHaveLength(1);
    expect(
      appendsSeen.filter((a) => a.lid === 'n2'),
      '移った先(n2)へ入った ── 名指しが効いていない',
    ).toHaveLength(0);
  });

  /** ⚠ 対照群 ── 名指ししなければ、これまでどおり**いま選んでいるノート**へ入る。 */
  it('名指ししなければ、いま選んでいるノートへ入る', async () => {
    const h = withOpenNote();
    appendsSeen.length = 0;
    h.d.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'n2',
      title: 'ほかのノート',
      body: '# ほかのノート',
      edit: false,
    });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    await attachFiles(h.d, h.deps, [new File(['a'], 'a.png', { type: 'image/png' })]);
    await tick();
    expect(appended(h.d), '名指ししていないのに n1 へ入った').toHaveLength(0);
    expect(appendsSeen.filter((a) => a.lid === 'n2')).toHaveLength(1);
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
   * 🔴 **⑦ 3 枚まとめて落としても、1 枚も落とさず、落とした順に入る。**
   *
   * ⚠ これは **`attachFiles` が本物の `writable-queue` を通していること**を見る
   *   (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも
   *   書けない」)── `writable-queue.test.ts` は器を単体で見ているので、
   *   **呼び側が本物を渡しているか**は誰も見ていなかった。配線を
   *   「その場で走らせるだけの偽の器」に差し替えると、ここが落ちる。
   * 🔑 台は **`getBody` を遅くして錠を握らせる**(実物では worker の往復が
   *   これに当たる)── `APPEND_TO_ENTRY` は錠が立っている間の要求を**捨てる**ので、
   *   預かりが効いていなければ 2 枚目以降が消える。
   */
  it('🔴 ⑦ 3 枚まとめて落としても、1 枚も落とさず順番どおり入る', async () => {
    const h = withOpenNote({
      getBody: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return '# 買い物メモ';
      },
    });
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
      new File(['3'], 'c.png', { type: 'image/png' }),
    ]);
    // ⚠ 預かりが解けるのを待つ(錠は効果層の答えで解ける)
    await new Promise((r) => setTimeout(r, 300));

    const lines = appended(h.d);
    expect(lines, '3 枚のうち何枚かが黙って消えた').toHaveLength(3);
    expect(
      lines.map((t) => /!\[([^\]]+)\]/.exec(t)?.[1]),
      '落とした順と本文の並びが違う',
    ).toEqual(['a.png', 'b.png', 'c.png']);
  });

  /**
   * 🔴 **⑧ `file.type` が空でも、拡張子から画像だと分かる。**
   *
   * ⚠ OS が MIME を付けない経路が実在する(共有 / D&D / Office の窓から戻る bytes ──
   *   `EXT_MIME` に Office 10 種を足したのはまさにこの形)。そこで `file.type` を
   *   そのまま渡すと、`猫.png` が **ただのリンク**になって**絵が出ない** ──
   *   お知らせ・マニュアル・CHANGELOG の 3 か所が「画像は絵が出る形で入ります」と
   *   書いているので、そこが嘘になる。
   */
  it('🔴 ⑧ file.type が空でも、拡張子が画像なら絵として入る', async () => {
    const h = withOpenNote();
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [new File(['png bytes'], '猫.png', { type: '' })]);
    await tick();
    const lines = appended(h.d);
    expect(lines).toHaveLength(1);
    expect(lines[0], '拡張子から画像だと解けていない(絵が出ない)').toMatch(
      /^!\[猫\.png\]\(asset:/,
    );
  });

  /**
   * 🔴 **⑨ 何も開いていないまま 3 枚落としても、3 枚とも同じ理由で断る。**
   *
   * ⚠ ここが **`into` を輪の外で採ること**の**唯一の**観測点である
   *   (#666 の着地前レビュー 2)── ノートを開いていれば `SELECT_ENTRY` が選択を
   *   同期に返すので、輪の中で採っても結果は変わらない(実測で知らせの列まで一致)。
   * 🔑 開いていないときだけ差が出る:輪の中で採ると 2 枚目以降が**1 枚目の添付**を
   *   入れ先だと読み、理由が「ノートを開いていないので」から
   *   「追記できない種類なので」へ**化ける** ── user は開いてもいないノートの
   *   種類を理由に断られる。
   */
  it('🔴 ⑨ 開いていないまま 3 枚落としても、3 枚とも「開いていない」と言う', async () => {
    const h = harness();
    const notices: string[] = [];
    h.d.onState(() => {
      const n = h.d.getState().notice;
      if (n !== null && notices[notices.length - 1] !== n) notices.push(n);
    });
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
      new File(['3'], 'c.png', { type: 'image/png' }),
    ]);
    await tick();

    expect(appendsSeen, '開いていないのに本文へ書いた').toHaveLength(0);
    expect(notices, '3 枚ぶんの理由が出ていない(台の空振り)').toHaveLength(3);
    for (const n of notices)
      expect(n, `理由が化けている: ${n}`).toContain('ノートを開いていないので');
  });

  /**
   * 🔴 **⑩ 事情(`why`)は、取込の知らせと同じ 1 行に出る。**
   *
   * ⚠ 呼び側が別の `OP_FAILED` で言うと **`CREATE_ENTRY` の reducer が
   *   `error: null` を書く**ので、**添付を作った瞬間に消える**(user は一度も
   *   読めない)── 貼り付けの落ち先が実際にそうなっていた(#666 レビュー 1)。
   */
  it('🔴 ⑩ 渡した事情が、取込の知らせの頭に付く', async () => {
    const h = withOpenNote();
    appendsSeen.length = 0;
    await attachFiles(
      h.d,
      h.deps,
      [new File(['x'], 'x.png', { type: 'image/png' })],
      '編集欄が閉じたため、打っていた所へは差せませんでした。',
    );
    await tick();
    expect(h.d.getState().notice ?? '', '事情が消えている').toBe(
      '編集欄が閉じたため、打っていた所へは差せませんでした。「x.png」を本文のいちばん下に入れました',
    );
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
    // ⚠ #668 A で字が変わった ── 「追記できない種類」ではなく、開いている物の種類を名指す
    // ⚠ #809-3 で括弧を外した ── 種類には付けない(名前と見分けられなくなる)
    expect(h.d.getState().notice ?? '', '黙って終わっている').toContain('開いているのは添付なので');
  });

  /**
   * 🔴 **A: 入れられない回は、何を開いているか・何なら入るかを言い、「開く」を添える**
   *   (#668 A。PR #667 の着地前レビュー)。
   *
   * ## 直す前に何が起きていたか
   *
   * 「追記できない種類なので本文には入れていません」── user は**開いている物の種類も、
   * どれなら入るのかも、作られた添付がどこへ行ったのかも**読めなかった。
   * 一覧は絞りで隠れていることがある(#668 D で添付の作成は絞りを外さなくなった)ので、
   * 作られた物へ行く道が**画面のどこにも無い**。
   *
   * ## この it が守る主張
   *
   * ① 字に**開いている物の種類**(『フォルダ』)と**入れられる種類**(ノートとログ)が出る
   * ② 🔴 **「開く」の身元**(`noticeOpen`)が**作られた添付**を指す ── 押すとそれが選ばれる
   * ③ 対照群 ── 本文へ入れられた回は身元を添えない(押す口を出さない)
   */
  it('🔴 A 入れられない種類なら、種類の名前と入れられる種類を言い、「開く」の身元を添える(#668)', async () => {
    const h = harness();
    h.d.dispatch({ type: 'CREATE_ENTRY', archetype: 'folder', lid: 'f1', title: '資料', edit: false });
    expect(h.d.getState().selectedLid, '台の前提: フォルダが開いていない').toBe('f1');
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [new File(['pdf'], '見積.pdf', { type: 'application/pdf' })]);
    await tick();

    const st = h.d.getState();
    expect(appendsSeen, 'フォルダの本文へ書いた').toHaveLength(0);
    // ① 字 ── 種類の名前は `archetypeLabel`、入れられる種類は `appendableKindsLabel` から来る
    expect(st.notice).toBe(
      '「見積.pdf」を添付にしました(開いているのはフォルダなので、本文には入れていません。本文に入れられるのはノートとログだけです)',
    );
    // ② 身元 ── 作られた添付を指し、押すと選ばれる
    const attached = [...st.entryMetas.values()].find((m) => m.archetype === 'attachment');
    expect(attached, '添付が作られていない(台の前提が崩れた)').toBeDefined();
    expect(st.noticeOpen, '「開く」の身元が添えられていない').toBe(attached!.lid);
    expect(st.selectedLid, '開いていたフォルダへ戻っていない').toBe('f1');
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: st.noticeOpen! });
    expect(h.d.getState().selectedLid, '「開く」の身元を押しても添付が開かない').toBe(attached!.lid);
  });

  /**
   * 🔴 **C: まとめて入れた回は「元に戻す」1 回でまとめて戻る**(#668 C)。
   *
   * ⚠ 直す前は `lastAppend` が**最後の 1 本**しか持たなかった ── 3 枚落として
   *   「元に戻す」を押すと 3 枚目だけ消え、残り 2 枚は本文を開いて消すしかない
   *   (user がやったことは 1 回なのに、戻すのは 1/3)。
   * 🔑 台は **`getBody` が育つ**形にする ── 本物の worker と同じく、前の追記が
   *   済んだ本文を次の追記の基底にする。固定の基底では 3 本の `inserted` が
   *   全部同じ場所を指し、「継いだ行を 1 手で消せる」は**見られない**。
   *
   * 観測点は 2 つ:
   * ① `removeInsertedLines(最終の本文, lastAppend.lines)` が**元の本文**へ戻る
   *    (= 3 行が連続した 1 手として持たれている)
   * ② 🔴 `UNDO_APPEND` を撃つと、実物の効果層が**元の本文を書き戻す**
   */
  function growingNote() {
    let persistedRef: Array<{ lid: string; body: string }> = [];
    const h = withOpenNote({
      getBody: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return persistedRef.filter((p) => p.lid === 'n1').at(-1)?.body ?? '# 買い物メモ';
      },
    });
    persistedRef = h.persisted;
    const bodyNow = (): string => h.persisted.filter((p) => p.lid === 'n1').at(-1)?.body ?? '';
    return { h, bodyNow };
  }

  it('🔴 C 3 枚まとめて入れたら、「元に戻す」1 回で 3 行とも消える(#668)', async () => {
    const { h, bodyNow } = growingNote();
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
      new File(['3'], 'c.png', { type: 'image/png' }),
    ]);
    await new Promise((r) => setTimeout(r, 400));

    // 前提 ── 3 本とも本文に入っている(台が育っていなければここで止まる)
    const full = bodyNow();
    for (const n of ['a.png', 'b.png', 'c.png'])
      expect(full, `前提が崩れた: ${n} が本文に無い`).toContain(`![${n}](asset:`);
    const last = h.d.getState().lastAppend;
    expect(last?.lid, '直前の追記が別のノートを指している').toBe('n1');
    // ① 3 行が 1 手 ── 消すと元の本文へ戻る(最後の 1 枚しか持っていなければ 2 行残る)
    expect(removeInsertedLines(full, last!.lines), '3 行が 1 手になっていない').toBe(
      '# 買い物メモ',
    );

    // ② 実物の効果層で戻す ── user が「元に戻す」を押したのと同じ
    h.d.dispatch({ type: 'UNDO_APPEND' });
    await new Promise((r) => setTimeout(r, 100));
    expect(bodyNow(), '「元に戻す」で 3 行とも消えていない').toBe('# 買い物メモ');
    expect(h.d.getState().lastAppend, '1 手で使い切っていない').toBeNull();
  });

  it('⚠ C 対照群 ── 1 枚なら、その 1 行だけが 1 手', async () => {
    const { h, bodyNow } = growingNote();
    await attachFiles(h.d, h.deps, [new File(['1'], 'solo.png', { type: 'image/png' })]);
    await new Promise((r) => setTimeout(r, 200));
    const last = h.d.getState().lastAppend;
    expect(last?.lines.filter((l) => l.includes('](asset:')), '1 枚なのに複数の参照を持つ').toHaveLength(1);
    expect(removeInsertedLines(bodyNow(), last!.lines)).toBe('# 買い物メモ');
  });

  /**
   * ⚠ **C 対照群 ── 回の印が違えば継がない。** 間に手で足した追記(印なし)が入ると、
   *   そこで手が切れる ── 「元に戻す」で、手で足した字だけが消える(写真まで巻き添えにしない)。
   *   🔑 これが無いと「印を見ずに全部継ぐ」変異が素通りする。
   */
  it('⚠ C 対照群 ── 手で足した追記は、前の回に継がれない', async () => {
    const { h, bodyNow } = growingNote();
    await attachFiles(h.d, h.deps, [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(bodyNow(), '前提が崩れた').toContain('![b.png](asset:');
    h.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: '手で足したメモ', heading: null, target: null });
    await new Promise((r) => setTimeout(r, 200));
    const last = h.d.getState().lastAppend;
    expect(last?.lines.join('\n'), '手で足した追記が無い(前提が崩れた)').toContain('手で足したメモ');
    expect(last?.lines.join('\n'), '前の回の写真まで 1 手に継がれている').not.toContain('](asset:');
  });

  /**
   * 🔴 **E: まとめて入れた回は、件数で締める**(#668 E)。
   *
   * ⚠ 知らせの行は 1 本なので、3 枚落とすと user が最後に読むのは 3 枚目の 1 行だけ ──
   *   1・2 枚目が入ったかは本文を見に行かないと分からなかった。
   * 🔑 締めは**全部入ってから**(2 枚目以降は錠が解けるまで預かられる)── 台は
   *   `growingNote`(錠が実際に立つ)で、最後の知らせが件数の 1 行であることを見る。
   */
  it('🔴 E 3 枚まとめて入れると、最後の知らせは件数で締まる(#668)', async () => {
    const { h, bodyNow } = growingNote();
    const notices: string[] = [];
    h.d.onState(() => {
      const n = h.d.getState().notice;
      if (n !== null && notices[notices.length - 1] !== n) notices.push(n);
    });
    await attachFiles(h.d, h.deps, [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
      new File(['3'], 'c.png', { type: 'image/png' }),
    ]);
    await new Promise((r) => setTimeout(r, 400));
    expect(bodyNow(), '前提が崩れた: 3 枚とも入っていない').toContain('![c.png](asset:');
    expect(notices.at(-1), '件数で締まっていない').toBe('3 件を本文に入れました(c.png ほか)');
    // ⚠ 1 枚ずつの知らせも出ている(締めが**上書き**した ── 黙らせたのではない)
    expect(notices, '1 枚ずつの知らせが消えている').toContain('「a.png」を本文のいちばん下に入れました');
  });

  /**
   * ⚠ **E 対照群 ── 数え終わる前に締めない。** 3 枚目のハッシュが遅く、その間に 1・2 枚目が
   *   入り切ると、`put === expected === 2` の瞬間が輪の途中に来る ── そこで締めると
   *   「2 件を本文に入れました」が先に出て、user は 3 枚目が落ちたと読む。
   * 🔑 台は **`hashBlob` を 3 枚目だけ遅くし、`getBody` は速く**する(錠がすぐ解ける)。
   */
  it('⚠ E 対照群 ── 数え終わる前に途中の件数で締めない', async () => {
    const h = withOpenNote();
    const deps: AttachDeps = {
      ...h.deps,
      hashBlob: async (blob) => {
        if (blob.size >= 3) await new Promise((r) => setTimeout(r, 80));
        return null;
      },
    };
    const notices: string[] = [];
    h.d.onState(() => {
      const n = h.d.getState().notice;
      if (n !== null && notices[notices.length - 1] !== n) notices.push(n);
    });
    await attachFiles(h.d, deps, [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
      new File(['333'], 'c.png', { type: 'image/png' }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(notices.at(-1), '前提が崩れた: 3 枚で締まっていない').toBe('3 件を本文に入れました(c.png ほか)');
    expect(notices, '数え終わる前に 2 件で締めた').not.toContain('2 件を本文に入れました(b.png ほか)');
  });

  it('⚠ E 対照群 ── 1 枚なら件数で締めない(場所を言う 1 行のまま)', async () => {
    const { h } = growingNote();
    await attachFiles(h.d, h.deps, [new File(['1'], 'solo.png', { type: 'image/png' })]);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.d.getState().notice).toBe('「solo.png」を本文のいちばん下に入れました');
  });

  /**
   * ⚠ **E 対照群 ── 入れなかった物は数えない。** 入れられない種類を開いたまま 2 枚落とすと、
   *   2 枚とも「添付にしました(…入れていません)」で、「2 件を本文に入れました」とは言わない。
   */
  it('⚠ E 対照群 ── 本文へ入れなかった回は件数で締めない', async () => {
    const h = harness();
    h.d.dispatch({ type: 'CREATE_ENTRY', archetype: 'folder', lid: 'f1', title: '資料', edit: false });
    await attachFiles(h.d, h.deps, [
      new File(['1'], 'a.pdf', { type: 'application/pdf' }),
      new File(['2'], 'b.pdf', { type: 'application/pdf' }),
    ]);
    await tick();
    expect(h.d.getState().notice ?? '', '入れていないのに件数で締めた').not.toContain('件を本文に入れました');
    expect(h.d.getState().notice ?? '').toContain('「b.pdf」を添付にしました');
  });

  it('⚠ A 対照群 ── 本文へ入れられた回は「開く」の身元を添えない', async () => {
    const h = withOpenNote();
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [new File(['x'], 'x.png', { type: 'image/png' })]);
    await tick();
    expect(appended(h.d), '前提: 本文へ入っていない').toHaveLength(1);
    expect(h.d.getState().noticeOpen, '入れたのに「開く」を出している').toBeNull();
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

  /**
   * 🔴 **B: 編集中に添付しても断らず、預かって、編集を終えたら入る**(#668 B)。
   *
   * ⚠ 直す前(P4a review #1)は「編集を終了してから添付してください」と断っていた ──
   *   この it はその test を**書き換えた**もの。守るものは 3 つ:
   *   ① 編集中は **bytes を 1 バイトも書かない**(orphan asset を作らない ── 元の主張)
   *   ② 🔴 **断らない**(`error` は立てず、「預かりました」と言う)
   *   ③ 🔴 **編集を終えると、編集していたノートの本文に入る**(選択もそのノートのまま)
   * 🔑 ①は直す前と同じ主張である ── 預かりは `run` ごと(台帳を引く前から)なので、
   *   編集中に put が走る形にはならない。
   */
  it('🔴 B 編集中は断らず預かり、編集を終えると本文に入る(#668)', async () => {
    const { d, deps, putBlobs, metas } = harness();
    /**
     * 🔴 #724 ⑤: 預かった `run` は**門の中**で走る ── 門が呼ばれた時点で bytes は 0、
     *   門が解けた時点で 1。⚠ 直す前は門を通らず(`gated` が空のまま)緑だった。
     */
    const gated: Array<{ before: number; after: number }> = [];
    deps.gate = async (run) => {
      const before = putBlobs.length;
      await run();
      gated.push({ before, after: putBlobs.length });
    };
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'lid-editing', title: 'draft' });
    expect(d.getState().phase).toBe('editing');
    appendsSeen.length = 0;

    await attachFiles(d, deps, [new File(['x'], 'late.txt', { type: 'text/plain' })]);
    await tick();

    // ① 預かっている間は bytes も entry も作らない(orphan asset を作らない)
    expect(putBlobs).toHaveLength(0);
    expect(metas).toHaveLength(0);
    expect(d.getState().entryMetas.size).toBe(1);
    // ② 断らない ── 預かったことを言う
    expect(d.getState().error, '断っている(直す前の症状)').toBeNull();
    expect(d.getState().notice ?? '', '預かったことを言っていない').toBe(
      '「late.txt」を預かりました(編集を終えたら本文に入れます)',
    );
    expect(d.getState().phase).toBe('editing'); // draft は無傷

    // ③ 編集を終えると入る ── 本文は変えていないので commit は書込を起こさず ready へ戻る
    d.dispatch({ type: 'COMMIT_EDIT' });
    expect(d.getState().phase, '台の前提: 編集が終わっていない').toBe('ready');
    await tick();
    await tick();
    expect(putBlobs, '編集を終えても取り込まれない(預かりが捨てられた)').toHaveLength(1);
    expect(gated, '預かった取込が資産の門の外で走った(#724 ⑤)').toEqual([{ before: 0, after: 1 }]);
    expect(d.getState().entryMetas.size, '添付が作られていない').toBe(2);
    const lines = appendsSeen.filter((a) => a.lid === 'lid-editing').map((a) => a.text);
    expect(lines, '編集していたノートの本文に入っていない').toHaveLength(1);
    expect(lines[0]).toMatch(/^\[late\.txt\]\(asset:/);
    expect(d.getState().selectedLid, '画面が添付へ移った').toBe('lid-editing');
  });

  /**
   * ⚠ **B 対照群 ── 編集していなければ、約束は取込が済んでから解ける。**
   * 🔑 `withAssetGate` は取込と整理(未参照 GC)を**この約束で**排他している ──
   *   預かりを足すときに ready 側まで `void run()` にすると、bytes を書いている最中に
   *   整理が走れる(tick を挟まずに見るのが要 ── 挟むと差が消える)。
   */
  it('⚠ B 対照群 ── 編集中でなければ、attachFiles は取込が済んでから返る', async () => {
    const { d, deps, putBlobs } = harness();
    await attachFiles(d, deps, [new File(['x'], 'now.txt', { type: 'text/plain' })]);
    expect(putBlobs, '約束が bytes を書く前に解けている').toHaveLength(1);
    expect(d.getState().entryMetas.size).toBe(1);
  });

  it('⚠ B 対照群 ── 2 件まとめて預かると件数で言う', async () => {
    const { d, deps } = harness();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'lid-editing', title: 'draft' });
    await attachFiles(d, deps, [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
    ]);
    await tick();
    expect(d.getState().notice ?? '').toBe('2 件を預かりました(編集を終えたら本文に入れます)');
  });

  it('mime fallback: file.type 空は拡張子から解決(PKC2 の欠落 hack を作らない)', () => {
    expect(resolveMime('doc.md', '')).toBe('text/markdown');
    expect(resolveMime('img.PNG', '')).toBe('image/png');
    expect(resolveMime('unknown.zzz', '')).toBe('application/octet-stream');
    expect(resolveMime('x.md', 'text/plain')).toBe('text/plain'); // 宣言優先
  });
});

/**
 * 🔴 **落とした所へ入れる**(#684 段④)。
 *
 * > issue の一覧:「**添付を本文の好きな位置へ** … 🔴 0 件(**入るのは末尾**)」
 *
 * ## 守る主張
 *
 * 1. 🔴 落とした所へ入る(末尾ではない)── `REQUEST_BODY_REWRITE { insert-lines }`
 * 2. 🔴 まとめて落とした 2 枚目は **1 枚目の下**(落とした順と本文の並びが揃う)
 * 3. 🔴 落としてから書くまでに本文が動いていたら、**位置を使わず末尾**へ(黙って別の所へ入れない)
 * 4. 🔴 「元に戻す」が残る ── まとめて落とした回は **1 手**で全部消える
 * 5. 位置を渡さない経路(添付ボタン / 貼付)は**これまでどおり末尾**
 *
 * ⚠ 効果層は本物(`connectStoreEffects`)を通す ── disk を読み直して書き戻す所まで
 *   走らせないと、2 枚目が「1 枚目の入った本文」を見られない。
 */
describe('落とした所へ入れる(#684 段④)', () => {
  const DOC = ['# 買い物メモ', '', '牛乳', '', 'パン', ''].join('\n');

  /** disk の本文を持つ台(書換が実際に効いて、次の 1 枚がそれを読む)。 */
  function withBody(body = DOC) {
    let disk = body;
    /** ⚠ `getBody` を遅くして錠を握らせる口(③-b)── 実物では worker の往復。 */
    let delay = 0;
    const h = harness(undefined, {
      getBody: async () => {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        return disk;
      },
      // ⚠ **書いたら disk に返す** ── 返さないと 2 枚目が「1 枚目の入る前」を読み、
      //    台のほうが本物より甘くなる(§3「stub は本物の意味論を真似る」)
      onPersist: (lid, b) => {
        if (lid === 'n1') disk = b;
      },
    });
    h.d.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'n1',
      title: '買い物メモ',
      body: disk,
      edit: false,
    });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: disk });
    return {
      ...h,
      disk: () => disk,
      slow: (ms: number) => void (delay = ms),
      /** ⚠ **disk だけ**を動かす(画面と落とした時の本文は据え置き)── 別の窓の書込を模す。 */
      setDisk: (b: string) => void (disk = b),
    };
  }

  const png = (n: string, bytes: string) => new File([bytes], n, { type: 'image/png' });
  /**
   * 落とした所 = 「牛乳」の後(生 3 行目 = 空行の前)。
   * ⚠ 落とした時の本文と、落とした塊の開き行(目印)も一緒に渡る。
   */
  const AFTER_MILK = { lid: 'n1', toBefore: 3, body: DOC, anchor: { line: 2, text: '牛乳' } };

  it('🔴 ① 落とした所へ入る(末尾ではない)', async () => {
    const h = withBody();
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK);
    await tick();
    const rows = h.disk().split('\n');
    const i = rows.findIndex((r) => r.startsWith('!['));
    expect(i, '参照が本文に入っていない').toBeGreaterThan(-1);
    expect(rows[i - 2] ?? rows[i - 1], '「牛乳」の下に入っていない').toBe('牛乳');
    expect(rows.indexOf('パン'), '「パン」の下(= 末尾寄り)へ落ちた').toBeGreaterThan(i);
    // ⚠ **どこに入ったかを字で言う**(押した場所と文言が対 ── 着地前レビュー G)
    expect(h.d.getState().notice ?? '', 'どこに入ったかを言っていない').toContain('落とした所');
  });

  /**
   * 🔴 **横に枠を留めているときは、中央へ入った回も名前を言う**(#809-2、2026-09-09)。
   *
   * ## 直す前、画面で何が起きていたか
   *
   * 中央のノートへ入った回の字は「「猫.png」を落とした所に入れました」で、
   * **どのノートかを 1 文字も言わなかった** ── 枠を 2〜3 枚並べていると、
   * 画面には本文が 3 つ出ているので、**どの本文に入ったのか字から読めない**。
   */
  it('🔴 枠を留めているときは、中央へ入った回も名前を言う', async () => {
    const h = withBody();
    h.d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n2', title: 'さきの予定', body: 'あ\n', edit: false });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    h.d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    expect(h.d.getState().splitLids, '台の前提: 枠が留まっていない').toEqual(['n2']);
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK);
    await tick();
    expect(
      h.d.getState().notice ?? '',
      '本文が 3 つ出ているのに、どれに入ったかを言っていない',
    ).toContain('『買い物メモ』');
  });

  /**
   * 🔴 **対照群 ── 枠を留めていないときは、1 語も増やさない**。
   * ⚠ これが無いと「いつも名前を言う」実装(推薦 B)と区別がつかない ──
   *   本文が 1 つしか無いなら「どれに入ったか」は自明で、要らない字である。
   */
  it('🔴 枠を留めていなければ、名前は出ない(字を増やさない)', async () => {
    const h = withBody();
    expect(h.d.getState().splitLids, '台の前提: 枠が留まっている').toEqual([]);
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK);
    await tick();
    const said = h.d.getState().notice ?? '';
    expect(said, '入った知らせが出ていない(空振り)').toContain('落とした所に入れました');
    expect(said, '枠を使わない user にまで名前が出ている').not.toContain('『買い物メモ』');
  });

  it('🔴 ② まとめて落とした 2 枚目は 1 枚目の下(落とした順と並びが揃う)', async () => {
    const h = withBody();
    await attachFiles(h.d, h.deps, [png('猫.png', 'a'), png('犬.png', 'b')], '', AFTER_MILK);
    await tick();
    await tick();
    const rows = h.disk().split('\n');
    const cat = rows.findIndex((r) => r.includes('猫.png'));
    const dog = rows.findIndex((r) => r.includes('犬.png'));
    expect(cat, '1 枚目が入っていない').toBeGreaterThan(-1);
    expect(dog, '2 枚目が入っていない').toBeGreaterThan(-1);
    expect(cat < dog, '2 枚目が 1 枚目の上に入った(落とした順と逆)').toBe(true);
    expect(rows.indexOf('パン'), '2 枚とも「パン」より上に居ない').toBeGreaterThan(dog);
  });

  it('🔴 ③ 書けるようになるまで待った回は、位置を捨てて末尾へ(黙って別の所へ入れない)', async () => {
    const h = withBody();
    appendsSeen.length = 0;
    const events: string[] = [];
    h.d.onEvent((e) => events.push(e.type));
    // ⚠ **実物の経路で編集へ入れる**(state を手で捏ねない)── ここで落としたぶんは預かられる
    h.d.dispatch({ type: 'START_EDIT' });
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK);
    await tick();
    expect(appendsSeen.filter((a) => a.lid === 'n1'), '預かる前に書いた').toHaveLength(0);
    // 編集を抜けると預かりが流れる ── そこで入るのは**末尾**である
    h.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    await tick();
    expect(appendsSeen.filter((a) => a.lid === 'n1'), '預かったぶんが入っていない').toHaveLength(1);
    expect(
      events.filter((t) => t === 'REQUEST_BODY_REWRITE'),
      '待たされたのに、落とした所の行番号で書いた',
    ).toHaveLength(0);
    // ⚠ 末尾へ落ちた回に「落とした所」と言わない(着地前レビュー G)
    expect(h.d.getState().notice ?? '', '末尾へ落ちたのに「落とした所」と言っている').toContain(
      'いちばん下',
    );
  });

  it('🔴 ④ 「元に戻す」の材料が残り、まとめて落とした回は 1 手で全部消える', async () => {
    const h = withBody();
    await attachFiles(h.d, h.deps, [png('猫.png', 'a'), png('犬.png', 'b')], '', AFTER_MILK);
    await tick();
    await tick();
    const last = h.d.getState().lastAppend;
    expect(last, '差し込んだのに「元に戻す」の材料が無い').not.toBeNull();
    expect(last!.lid).toBe('n1');
    expect(last!.lines.filter((l) => l.includes('asset:')), '2 枚とも 1 手に継がれていない').toHaveLength(2);
    // 🔴 その材料で、実際に元の本文へ戻る(材料が在るだけでは戻せない)
    const undone = removeInsertedLines(h.disk(), last!.lines);
    expect(undone, '材料が本文の中で連続していない(1 手で消せない)').not.toBeNull();
    expect(undone).toBe(DOC);
  });

  /**
   * 🔴 **③-b 別の書込が錠を握っている間に落ちた回も、末尾へ**(変異試験 M7 が SURVIVED で教えた)。
   *
   * ⚠ ③ が見ているのは**取込ごと預かった**形(`attach.ts` の門)で、こちらは
   *   **1 枚ずつの門**(`asset-into-note.ts` の `canWriteBody`)である ── 取込は走れるが
   *   本文だけ書けない、という状態は**錠**で起きる(録音の保存・追記が飛んでいる最中)。
   * 🔑 台は **`getBody` を遅くして錠を握らせる**(実物では worker の往復がこれに当たる)。
   */
  it('🔴 ③-b 別の書込が錠を握っている間に落とした回も、末尾へ', async () => {
    const h = withBody();
    // ⚠ 追記を 1 本飛ばして錠を握らせる(`getBody` が遅いので解けない)
    h.slow(200);
    h.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: '手で足した行', heading: null, target: null });
    expect(h.d.getState().writeLock, '台の前提: 錠が立っていない').not.toBeNull();
    appendsSeen.length = 0;
    const events: string[] = [];
    h.d.onEvent((e) => events.push(e.type));
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK);
    await new Promise((r) => setTimeout(r, 400));
    expect(appendsSeen.filter((a) => a.lid === 'n1'), '末尾へ落ちていない').toHaveLength(1);
    expect(
      events.filter((t) => t === 'REQUEST_BODY_REWRITE'),
      '錠が立っている間に落としたのに、落とした所の行番号で書いた',
    ).toHaveLength(0);
  });

  /**
   * 🔴 **落とした本文と入れ先が違う回は、位置を使わない**(変異試験 M-A / 着地前レビュー A)。
   * ⚠ 横に留めた枠(別のノート)へ落としても、添付が入るのは**主の枠のノート**である
   *   ── そこで留めた枠の行番号を信じると、**別のノートの段落の途中へ刺さる**
   *   (#277 で 1 度塞いだ「別のノートの同じ行番号を書く」の再来)。
   * 🔑 そこへ線を出さないのは binder の側(`body-block-drag.test.ts`)。
   */
  it('🔴 落とした本文が入れ先と違うノートなら、位置は使わない', async () => {
    const h = withBody();
    appendsSeen.length = 0;
    const events: string[] = [];
    h.d.onEvent((e) => events.push(e.type));
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', { ...AFTER_MILK, lid: 'other' });
    await tick();
    expect(appendsSeen.filter((a) => a.lid === 'n1'), '末尾へ落ちていない').toHaveLength(1);
    expect(
      events.filter((t) => t === 'REQUEST_BODY_REWRITE'),
      '別のノートの行番号で本文へ書いた',
    ).toHaveLength(0);
  });

  /**
   * 🔴 **落とした所と末尾が混ざった回は、「元に戻す」を 1 手に継がない**
   * (着地前レビュー F / UX レビュー 6)。
   *
   * ⚠ `nextLastAppend` は「継いだ行は本文の中で**連続している**」を前提にしている。
   *   1 枚目が本文の途中・2 枚目が末尾だと連続しないので、継ぐと
   *   `removeInsertedLines` が **1 行も消せずに断る** ── しかも押した時点で材料は
   *   捨てられるので、**ボタンごと消えて押し直せない**。
   */
  it('🔴 途中と末尾が混ざった回は、「元に戻す」が本当に消せる形で残る', async () => {
    const h = withBody();
    h.d.onState(() => undefined);
    // 1 枚目 ── 落とした所へ
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK);
    await tick();
    expect(h.disk(), '前提: 1 枚目が途中に入っていない').toContain('猫.png');
    const rows1 = h.disk().split('\n');
    expect(rows1.indexOf('パン')).toBeGreaterThan(rows1.findIndex((r) => r.includes('猫.png')));
    // 2 枚目 ── 錠が握られている間に落として末尾へ(同じ回の印は付いている)
    h.slow(200);
    h.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: '手で足した行', heading: null, target: null });
    await attachFiles(h.d, h.deps, [png('犬.png', 'b')], '', AFTER_MILK);
    await new Promise((r) => setTimeout(r, 500));
    const last = h.d.getState().lastAppend;
    expect(last, '材料が無い').not.toBeNull();
    // 🔴 材料は**本当に消せる**もの ── 継いで連続しなくなっていたら `null` が返る
    expect(
      removeInsertedLines(h.disk(), last!.lines),
      '「元に戻す」が 1 行も消せない(途中と末尾を 1 手に継いだ)',
    ).not.toBeNull();
  });

  /**
   * 🔴 **落としてから書くまでに別の窓が書いていたら、当てずっぽうな所へ入れない**
   * (着地前レビュー D / UX レビュー 7、変異試験 N4 / N5)。
   *
   * ⚠ 兄弟の書換(`move-lines` / `place-move` / `undo-append`)は全部「掴んだ時点の字」を
   *   disk 側と突き合わせる。差し込みだけが番号しか見ておらず、**段④ は落としてから
   *   書くまで待つ**(縮める / bytes を置く / 添付のノートを作る)ので、その間に行が
   *   増えると**段落の途中へ黙って刺さる**。
   */
  it('🔴 落としてから書くまでに本文が動いていたら、当てずっぽうに書かない', async () => {
    const h = withBody();
    // ⚠ **台のノートが disk に届くまで待ってから**動かす ── 待たずに書き換えると、
    //    後から届く `CREATE_ENTRY` の保存が元へ戻して、この test は何も検めない
    await tick();
    // ⚠ **disk だけ**を動かす(画面と落とした時の本文は据え置き)── 別の窓が上へ 1 行足した形
    h.setDisk(`別の窓が足した行\n${DOC}`);
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK);
    await tick();
    await tick();
    expect(h.disk(), '本文が動いているのに書き込んだ').not.toContain('asset:');
    expect(h.d.getState().error ?? '', '黙って諦めた(理由が出ていない)').toContain('本文が変わっている');
    // ⚠ 対照群 ── 動いていなければ、同じ落とし方でちゃんと入る
    const ok = withBody();
    await tick();
    await attachFiles(ok.d, ok.deps, [png('猫.png', 'a')], '', AFTER_MILK);
    await tick();
    expect(ok.disk(), '対照群が入っていない(この test は空振り)').toContain('asset:');
  });

  /**
   * 🔴 **回の途中で末尾へ落ちたら、「元に戻す」を 1 手に継がない**
   * (着地前レビュー F / UX レビュー 6、変異試験 N2 / N3)。
   *
   * ⚠ 台は **2 枚目の bytes を置く瞬間に別の追記を走らせて錠を握らせる**
   *   ── 実物では録音の保存・追記がこれに当たる(1 回の落としの途中で錠が立つ)。
   */
  /**
   * 🔴 **1 回の落としで途中と末尾が混ざっても、「元に戻す」が本当に消せる**
   * (着地前レビュー F / UX レビュー 6)。
   *
   * ⚠ `nextLastAppend` は「継いだ行は本文の中で**連続している**」を前提にしている。
   *   1 枚目が本文の途中・2 枚目が末尾だと連続しないので、そこを 1 手に継ぐと
   *   `removeInsertedLines` は **1 行も消せずに断る**(押した時点で材料も捨てられるので
   *   押し直しもできない)。この test は**そうなっていないこと**を実際に消して確かめる。
   *
   * 🔑 **末尾へ落ちる引き金は「錠」しか無い**(`writeLock` を立てるのは
   *   `APPEND_TO_ENTRY` **1 か所**。編集に入る道は `CREATE_ENTRY` ごと黙殺されるので
   *   回の途中では起きない)── その錠を立てた追記自身が `lastAppend` を差し替えるため、
   *   鎖はそこで切れる。⚠ だから `asset-into-note.ts` の「継がない」門は**等価**である
   *   (変異試験 N2 / N3 が SURVIVED で教えた)── 門を外しても結果は変わらない。
   *   🔑 それでも門を残すのは、**引き金が増えた日**(錠を立てる 2 か所目・編集の途中入り)に
   *   ここが壊れないようにするため。この test は**結果**を守る(門ではなく)。
   */
  it('🔴 1 回の落としで途中と末尾が混ざっても、「元に戻す」が本当に消せる', async () => {
    const h = withBody();
    await tick();
    let n = 0;
    const putBlob = h.deps.putBlob;
    h.deps.putBlob = async (key, blob) => {
      n += 1;
      // ⚠ 2 枚目の取込が始まった所で、別の追記が錠を握る(実物では録音の保存・追記)
      if (n === 2) {
        h.slow(200);
        h.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: '別の追記', heading: null, target: null });
      }
      await putBlob(key, blob);
    };
    await attachFiles(h.d, h.deps, [png('猫.png', 'a'), png('犬.png', 'b')], '', AFTER_MILK);
    await new Promise((r) => setTimeout(r, 1500));
    const rows = h.disk().split('\n');
    const cat = rows.findIndex((r) => r.includes('猫.png'));
    const dog = rows.findIndex((r) => r.includes('犬.png'));
    expect(cat, '1 枚目が入っていない').toBeGreaterThan(-1);
    expect(dog, '2 枚目が入っていない').toBeGreaterThan(-1);
    // 🔴 台の前提 ── 途中と末尾に**分かれて**いる(分かれていなければこの test は空振り)
    expect(rows.indexOf('パン'), '前提が崩れた: 2 枚とも同じ所に入っている').toBeGreaterThan(cat);
    expect(rows.indexOf('パン'), '前提が崩れた: 2 枚とも同じ所に入っている').toBeLessThan(dog);
    const last = h.d.getState().lastAppend;
    expect(last, '材料が無い').not.toBeNull();
    expect(
      removeInsertedLines(h.disk(), last!.lines),
      '「元に戻す」が 1 行も消せない(途中と末尾を 1 手に継いだ)',
    ).not.toBeNull();
  });

  it('位置を渡さない経路(添付ボタン / 貼付)は、これまでどおり末尾', async () => {
    const h = withBody();
    appendsSeen.length = 0;
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')]);
    await tick();
    expect(appendsSeen.filter((a) => a.lid === 'n1'), '末尾の経路が消えた').toHaveLength(1);
    expect(h.d.getState().error ?? '', '断りが出ている').toBe('');
  });
});

/**
 * 🔴 **横に留めた枠の本文へ落とした file は、その枠のノートへ入る**(#684 ㋑)。
 *
 * ## 直す前に何が起きていたか
 *
 * 入れ先は **`selectedLid` 固定**だった ── 留めた枠の「牛乳」の下へ落としても、
 * その本文には **1 バイトも入らず**、主の枠のノートのいちばん下へ落ちていた。
 * ⚠ 同じ枠へ**塊**(段③)や**一覧の行**(段②)を落とすとその枠のノートへ書くので、
 * **file だけ行き先が違う**という覚え直しになっていた。
 *
 * ## 守る主張
 *
 * ① 🔴 **落とした本文のノート**へ、落とした所に入る(主の枠の本文は 1 バイトも動かない)
 * ② 🔴 **画面は動かさない** ── 選択は主の枠のノートへ返る(補助的な枠が主を奪わない)
 * ③ 🔴 知らせが**行き先の名前**を言う(見ている本文と違う所へ入るので、名前が要る)
 * ④ ⚠ **入れられない種類**へ落ちた回は、これまでどおり開いているノートの末尾
 */
describe('横に留めた枠へ落とした file は、その枠のノートへ入る(#684 ㋑)', () => {
  const MAIN = ['# 買い物メモ', '', '卵', ''].join('\n');
  const SIDE = ['# さきの予定', '', '牛乳', '', 'パン', ''].join('\n');
  /** 留めた枠の「牛乳」の後(生 3 行目)。 */
  const AFTER_MILK_ON_SIDE = { lid: 'n2', toBefore: 3, body: SIDE, anchor: { line: 2, text: '牛乳' } };
  const png = (n: string, bytes: string) => new File([bytes], n, { type: 'image/png' });

  /** 2 つのノートが disk に在る台(書換が効いて、読み直すとその本文が返る)。 */
  function withNotes(sideArchetype: 'text' | 'folder' = 'text') {
    const disks: Record<string, string> = { n1: MAIN, n2: SIDE };
    /** ⚠ `getBody` を遅くして錠を握らせる口(`withBody` と同じ作法)。 */
    let delay = 0;
    const h = harness(undefined, {
      getBody: async (lid) => {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        return disks[lid] ?? null;
      },
      onPersist: (lid, b) => {
        if (lid in disks) disks[lid] = b;
      },
    });
    h.d.dispatch({ type: 'CREATE_ENTRY', archetype: sideArchetype, lid: 'n2', title: 'さきの予定', body: SIDE, edit: false });
    h.d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n1', title: '買い物メモ', body: MAIN, edit: false });
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: MAIN });
    appendsSeen.length = 0;
    return { ...h, disks, slow: (ms: number) => void (delay = ms) };
  }

  it('🔴 ① ② ③ 落とした枠のノートの、落とした所へ入る(画面は動かず、名前で言う)', async () => {
    const h = withNotes();
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK_ON_SIDE);
    await tick();
    const rows = h.disks.n2!.split('\n');
    const i = rows.findIndex((r) => r.startsWith('!['));
    expect(i, '留めた枠の本文に入っていない').toBeGreaterThan(-1);
    expect(rows[i - 2] ?? rows[i - 1], '「牛乳」の下に入っていない').toBe('牛乳');
    expect(rows.indexOf('パン'), '末尾へ落ちた(落とした所ではない)').toBeGreaterThan(i);
    // ② 画面は主の枠のまま ── 選択を留めた枠へ移さない
    expect(h.d.getState().selectedLid, '見ていたノートから画面を持っていかれた').toBe('n1');
    // ① 主の枠の本文は 1 バイトも動かない
    expect(h.disks.n1, '見ていたノートの本文が動いた').toBe(MAIN);
    expect(appendsSeen.filter((a) => a.lid === 'n1'), '見ていたノートの末尾へも入れた').toHaveLength(0);
    // ③ 行き先の名前を言う(見ている本文と違う所へ入るので)
    expect(h.d.getState().notice ?? '', '行き先の名前を言っていない').toContain('『さきの予定』');
    /**
     * 🔴 **戻す道を残す**(「片道の操作を作らない」── user 指示 2026-08-23)。
     * ⚠ 追記欄の「元に戻す」は**開いているノートの欄にしか出ない**
     *   (`append-box.ts` の `lastAppend?.lid === mode.lid`)ので、留めた枠へ入れた
     *   1 行は**そのノートを開くまで戻す口が画面に無い**。
     * 🔑 だから知らせの隣に行き先を添える ── `paintStatusOpen` がそれで「開く」を出す。
     */
    expect(h.d.getState().noticeOpen, '行き先へ行く道が知らせに添えられていない').toBe('n2');
    // ⚠ 材料そのものは行き先のノートに付く(開けばそこで「元に戻す」が出る)
    expect(h.d.getState().lastAppend?.lid, '戻す材料が行き先のノートに付いていない').toBe('n2');
  });

  it('⚠ 対照群 ── 開いているノート自身へ落とした回は、名前を言わない', async () => {
    const h = withNotes();
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', {
      lid: 'n1',
      toBefore: 3,
      body: MAIN,
      anchor: { line: 2, text: '卵' },
    });
    await tick();
    expect(h.disks.n1!.includes('!['), '開いているノートへ入っていない').toBe(true);
    expect(h.d.getState().notice ?? '', '1 つしか見ていないのに名前が出た').not.toContain('『');
    expect(h.d.getState().notice ?? '', 'どこに入ったかを言っていない').toContain('落とした所');
    // ⚠ 開いているノート自身へ入れた回は道を添えない(押しても何も起きない口を出さない)
    expect(h.d.getState().noticeOpen, '開いているノート自身へ「開く」を添えた').toBeNull();
  });

  /**
   * 🔴 **編集中に留めた枠へ落としても、落とした所へ入る**(#684 ㋑ × #668 B、
   *   着地前レビュー 重大 ②)。
   *
   * ⚠ 預かった回が落とした所を捨てるのは、**編集していたノートの本文が
   *   待っているあいだに別物になる**からである ── 留めた枠は編集していないので
   *   本文は動かない。ここで捨てると「線を出した所に入らない」という
   *   **守れない約束**になる(編集中でも留めた枠には線が出る)。
   * 🔑 万一動いていても、書く直前に**目印**で突き合わせて断る側に倒れる。
   */
  it('🔴 編集中に留めた枠へ落としても、編集を終えると落とした所へ入る', async () => {
    const h = withNotes();
    h.d.dispatch({ type: 'START_EDIT' });
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK_ON_SIDE);
    await tick();
    expect(h.disks.n2, '預かる前に書いた').toBe(SIDE);
    // 預かった時点で、どのノートのどこへ入るかを言い切る
    expect(h.d.getState().notice ?? '', '預かった 1 行が行き先を言っていない').toContain(
      '『さきの予定』',
    );
    h.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    await tick();
    const rows = h.disks.n2!.split('\n');
    const i = rows.findIndex((r) => r.startsWith('!['));
    expect(i, '留めた枠のノートに入っていない').toBeGreaterThan(-1);
    expect(rows[i - 2] ?? rows[i - 1], '落とした所(「牛乳」の下)ではない').toBe('牛乳');
    expect(rows.indexOf('パン'), 'いちばん下へ落ちた(線を出した所ではない)').toBeGreaterThan(i);
    expect(h.disks.n1, '見ていたノートの本文が動いた').toBe(MAIN);
    expect(h.d.getState().noticeOpen, '預かった回にも行き先へ行く道が要る').toBe('n2');
  });

  /**
   * ⚠ **対照群 ── 編集していたノート自身へ落とした回は、これまでどおり末尾**。
   * (待っているあいだにその本文は別物になるので、落とした時の行番号は別の所を指す)
   */
  it('⚠ 対照群 ── 編集していたノート自身へ落とした回は、これまでどおり末尾', async () => {
    const h = withNotes();
    h.d.dispatch({ type: 'START_EDIT' });
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', {
      lid: 'n1',
      toBefore: 3,
      body: MAIN,
      anchor: { line: 2, text: '卵' },
    });
    await tick();
    h.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    await tick();
    expect(appendsSeen.filter((a) => a.lid === 'n1'), '末尾へ入っていない').toHaveLength(1);
  });

  /**
   * 🔴 **まとめて落とした回の締めでも、行き先と戻す道を落とさない**(#684 ㋑)。
   * ⚠ 締めの 1 行は知らせを**上書きする**ので、添えないと
   *   「行き先の名前」と「開く」が**2 枚以上落とした user だけ**消える。
   */
  it('🔴 2 枚まとめて落としても、締めの 1 行が行き先と道を持っている', async () => {
    const h = withNotes();
    await attachFiles(h.d, h.deps, [png('猫.png', 'a'), png('犬.png', 'b')], '', AFTER_MILK_ON_SIDE);
    await tick();
    await tick();
    const rows = h.disks.n2!.split('\n');
    expect(rows.filter((r) => r.startsWith('![')), '2 枚とも入っていない').toHaveLength(2);
    // 🔴 台の前提 ── 締めが出る回である(1 枚だけの回と取り違えない)
    expect(h.d.getState().notice ?? '', '締めの 1 行が出ていない').toContain('2 件');
    expect(h.d.getState().notice ?? '', '締めが行き先の名前を落とした').toContain('『さきの予定』');
    expect(h.d.getState().noticeOpen, '締めが行き先へ行く道を落とした').toBe('n2');
    expect(h.disks.n1, '見ていたノートの本文が動いた').toBe(MAIN);
  });

  /**
   * 🔴 **何も開いていない回でも、画面は動かない**(#684 ㋑、着地前レビュー 欠陥 2 / 要修正 A)。
   *
   * ⚠ 開き直した直後は中央に何も開いていない(留めた枠だけが復元される)。そこで
   *   留めた枠へ落とすと、`CREATE_ENTRY` が選択を**作った添付へ移す**ので、
   *   返し先が無いと **中央が「猫.png」の画面に化ける** ── お知らせにもマニュアルにも
   *   「画面は動きません」と書いた当の約束が、いちばん起きやすい入り口で破れる。
   */
  it('🔴 何も開いていないまま留めた枠へ落としても、中央に添付が開かない', async () => {
    const h = withNotes();
    h.d.dispatch({ type: 'DESELECT_ENTRY' });
    expect(h.d.getState().selectedLid, '台の前提: 何も開いていない').toBeNull();
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK_ON_SIDE);
    await tick();
    expect(h.disks.n2!.includes('!['), '留めた枠のノートへ入っていない').toBe(true);
    expect(h.d.getState().selectedLid, '作った添付が中央に開いた(画面が動いた)').toBeNull();
  });

  /**
   * 🔴 **別のノートへの書込が錠を握っていても、こちらの位置は残る**
   *   (#684 ㋑、変異試験 I16 が SURVIVED で教えた)。
   *
   * ⚠ 直す前の門は「**いま書けるか**」だけを見ていた ── 錠は**全体で 1 本**なので、
   *   見ていたノートを保存している最中に留めた枠へ落とすと、**無関係なのに**
   *   落とした所が捨てられて末尾へ入っていた。
   * 🔑 待っているあいだに動くのは**錠を握られている本文**だけである。
   */
  it('🔴 別のノートを書いている最中でも、留めた枠は落とした所へ入る', async () => {
    const h = withNotes();
    h.slow(60); // ⚠ 見ていたノートの追記を、錠を握ったまま止める
    h.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: '卵 2 個', heading: null, target: null });
    expect(h.d.getState().writeLock?.lid, '台の前提: 錠が n1 に握られていない').toBe('n1');
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK_ON_SIDE);
    // ⚠ 錠が解けるまで待つ(解けた瞬間に預かりが流れる)
    await new Promise((r) => setTimeout(r, 300));
    expect(h.d.getState().writeLock, '台の前提: 錠がまだ解けていない').toBeNull();
    const rows = h.disks.n2!.split('\n');
    const i = rows.findIndex((r) => r.startsWith('!['));
    expect(i, '留めた枠のノートに入っていない').toBeGreaterThan(-1);
    expect(rows[i - 2] ?? rows[i - 1], '落とした所ではなく末尾へ落ちた').toBe('牛乳');
  });

  /**
   * 🔴 **入れ先そのものを編集していたら、位置は捨てる**(#684 ㋑、変異試験 I23 が
   *   SURVIVED で教えた)。
   *
   * ⚠ `attachFiles` 越しには**この形へ到達できない** ── あちらの入れ先は
   *   「落とした本文のノート」か「開いているノート」で、編集しているのは
   *   **開いているノート**だから、`elsewhere` と「編集中の入れ先」は排他になる。
   * 🔑 だから**共有の口を直に叩いて**確かめる ── `putAssetIntoNote` は録音・画面録画も
   *   通る 1 か所なので、次の呼び手が編集中に位置を渡した日に静かに壊れないための門である。
   * ⚠ 位置を残すと、書く直前の目印の突き合わせで**断られて 1 行も入らない**
   *   (末尾へ落ちるより悪い)。
   */
  it('🔴 入れ先そのものを編集中に落とした回は、位置を捨てて末尾へ(共有の口を直に)', async () => {
    const h = withNotes();
    const said: string[] = [];
    h.d.dispatch({ type: 'START_EDIT' });
    expect(h.d.getState().phase, '台の前提: 編集に入っていない').toBe('editing');
    putAssetIntoNote({
      dispatcher: h.d,
      queue: createWritableQueue(h.d),
      notify: (t) => void said.push(t),
      into: { lid: 'n1', archetype: 'text' },
      attachedLid: 'a1',
      assetKey: 'ast-x',
      name: '猫.png',
      mime: 'image/png',
      why: '',
      place: dropCursor({ lid: 'n1', toBefore: 3, body: MAIN, anchor: { line: 2, text: '卵' } }),
    });
    h.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    await tick();
    const rows = h.disks.n1!.split('\n');
    const i = rows.findIndex((r) => r.startsWith('!['));
    expect(i, '本文に入っていない').toBeGreaterThan(-1);
    expect(rows[i - 1] ?? '', '落とした所(「卵」の下)へ入れた ── 本文はもう別物である').not.toBe(
      '卵',
    );
    expect(said.join(' / '), 'いちばん下へ入れたと言っていない').toContain('いちばん下');
  });

  it('🔴 ④ 入れられない種類の本文へ落ちた回は、開いているノートの末尾へ', async () => {
    const h = withNotes('folder');
    await attachFiles(h.d, h.deps, [png('猫.png', 'a')], '', AFTER_MILK_ON_SIDE);
    await tick();
    expect(appendsSeen.filter((a) => a.lid === 'n1'), '開いているノートの末尾へ入っていない').toHaveLength(1);
    expect(h.disks.n2, '入れられない種類の本文へ書いた').toBe(SIDE);
    expect(h.d.getState().error ?? '', '断りが出ている(開いているノートには入れられる)').toBe('');
  });
});
