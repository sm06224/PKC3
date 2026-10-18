/**
 * 🔴 **Office の保存を引き取る判断**(#205 段 B〜D)。
 *
 * ⚠ ここが守るのは**文書が消えないこと**である。落とし穴は 3 つとも
 * 「**取り込めていないのに棚から消す**」という同じ形をしている:
 *
 * 1. 編集中は `CREATE_ENTRY` / `OFFICE_ASSET_SAVED` が reducer に**黙って捨てられる**
 * 2. holder でないタブは sqlite に書けない(なのに放送は届く)
 * 3. 差し替えの dispatch が撃てなかった
 *
 * 🔑 だから test の観測点は「放送を受けた」ではなく
 * **「棚から消えたか」と「何を作ったか」**である。
 */
import { describe, expect, it, vi } from 'vitest';
import { serializeFrontmatter } from '../../src/features/markdown/frontmatter';
import { readFileSync } from 'node:fs';
import {
  confirmSavedBack,
  createOfficeSaveBack,
  LOCAL_ORPHAN_GRACE_MS,
  localOrphanImportedNotice,
  savedHeldElsewhereNotice,
  savedHeldNotice,
  originGoneImportedNotice,
  SAME_DOC_MAX,
  sharedReplaceQuestion,
  sharedSeparateImportedNotice,
  stagedSavedAt,
  type SaveBackDeps,
} from '@adapter/platform/office/office-save-back';
import type { StageDir, StagedSave } from '@adapter/platform/office/office-stage';
import { isShadowNewer } from '@features/office/office-shadow';
import { sanitizeMessageText } from '@features/message/message-log';

interface FakeStage {
  dir: StageDir;
  keys(): string[];
  put(save: Partial<StagedSave> & { key: string; omitWin?: boolean }, bytes?: Uint8Array): void;
}

/** 偽の棚。⚠ `.bin` の中身と `.json` の meta を**別々に**持つ(本物と同じ形)。 */
function fakeStage(): FakeStage {
  const files = new Map<string, { text?: string; bytes?: Uint8Array }>();
  const dir = {
    async getFileHandle(name: string) {
      const f = files.get(name);
      if (!f) throw new Error(`NotFound ${name}`);
      return {
        async getFile() {
          return {
            size: f.bytes?.length ?? 0,
            lastModified: 0,
            async arrayBuffer() {
              return (f.bytes ?? new Uint8Array(0)).slice().buffer;
            },
            async text() {
              return f.text ?? '';
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new Error(`NotFound ${name}`);
    },
    async *values() {
      for (const name of [...files.keys()]) yield { kind: 'file', name };
    },
  } as unknown as StageDir;
  return {
    dir,
    keys: () => [...files.keys()],
    put(save, bytes = new Uint8Array([1, 2, 3])) {
      const meta = {
        v: 1,
        key: save.key,
        name: save.name ?? 'x.odt',
        // ⚠ **既定の path は名前から引く。** 固定にすると、名前が違う別々の文書が
        //    同じ path を持ち、「同じ文書を束ねる」規則に引っかかる(実際 1 件落ちた)
        path: save.path ?? `/work/${save.name ?? 'x.odt'}`,
        size: save.size ?? bytes.length,
        at: save.at ?? 1,
        ...(save.token !== undefined ? { token: save.token } : {}),
        // ⚠ 既定で窓の id を入れる ── 本物の窓は必ず入れる。入れないと
        //    「同じ文書を束ねる」経路が**この fixture では一度も走らない**
        //    (= 測っていない次元になる)
        ...(save.omitWin === true ? {} : save.win !== undefined ? { win: save.win } : { win: 'win-1' }),
      };
      files.set(`${save.key}.json`, { text: JSON.stringify(meta) });
      files.set(`${save.key}.bin`, { bytes });
    },
  };
}

function harness(over: Partial<SaveBackDeps> = {}): {
  stage: FakeStage;
  deps: SaveBackDeps;
  created: string[];
  replaced: string[];
  adopted: string[];
  notices: string[];
  fails: string[];
  opened: string[];
  /** 窓を開いたタブへ運んだ結果(O-8)。 */
  relayed: { token: string; kind: string; text: string; openLid?: string }[];
  sb: ReturnType<typeof createOfficeSaveBack>;
} {
  const stage = fakeStage();
  const created: string[] = [];
  const replaced: string[] = [];
  const adopted: string[] = [];
  const notices: string[] = [];
  const fails: string[] = [];
  const opened: string[] = [];
  const relayed: { token: string; kind: string; text: string; openLid?: string }[] = [];
  const deps: SaveBackDeps = {
    stage: async () => stage.dir,
    isHolder: () => true,
    canWrite: () => true,
    // ⚠ 既定は「書けるときだけ足せる」── 編集中でも足せる場合は各 it が `canCreate` を渡す(#1087)
    canCreate: over.canWrite ?? (() => true),
    readAttachment: async () => ({ assetKey: 'ast-old' }),
    // ⚠ 既定は「手元のファイルではない」── #432 の分岐を素通りさせる
    //   (手元のファイルの経路は `local-office-files.test.ts` と下の describe が見る)
    writeLocal: async () => null,
    knowsLocal: () => true,
    createNote: async (save) => {
      created.push(save.name);
      return 'new-lid';
    },
    replaceAsset: async (lid) => {
      replaced.push(lid);
      return true;
    },
    // ⚠ 既定は「同じファイルを指す添付がほかに無い」── 確かめずに差し替える(共有の回は各 it が渡す。#1163 依頼 211・293)
    confirmShared: async () => 'replace',
    // ⚠ 既定は「別のタブは編集していない」(依頼 368 の回は各 it が渡す)
    editedElsewhere: async () => false,
    adopt: (key, lid) => adopted.push(`${key}=${lid}`),
    notify: (m, open) => {
      notices.push(m);
      if (open !== undefined) opened.push(open);
    },
    fail: (m) => fails.push(m),
    // ⚠ 既定は「編集中」── `canWrite` を偽にする各 it が預かる理由はこれ(他の phase は O-10 の it が渡す)
    phase: () => 'editing',
    relay: (r) => relayed.push(r),
    ...over,
  };
  return {
    stage, deps, created, replaced, adopted, notices, fails, opened, relayed,
    sb: createOfficeSaveBack(deps),
  };
}

describe('引き取り ── 新規と差し替えの分かれ道', () => {
  it('🔴 合言葉が無ければ、新しい添付ノートになる', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '無題 1.odt' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(h.created).toEqual(['無題 1.odt']);
    expect(h.replaced, '合言葉が無いのに差し替えた').toEqual([]);
    expect(h.stage.keys(), '取り込んだのに棚に残っている').toEqual([]);
    expect(h.notices[0]).toContain('無題 1.odt');
  });

  it('🔴 合言葉があれば、そのノートを差し替える', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('replaced');
    expect(h.replaced).toEqual(['lid-7']);
    expect(h.created, '差し替えるべきなのに新しいノートを作った').toEqual([]);
    expect(h.stage.keys()).toEqual([]);
  });

  it('🔴 合言葉のノートが消えていたら、新規へ倒す(存在しない lid へ書かない)', async () => {
    const h = harness({ readAttachment: async () => null });
    h.stage.put({ key: 'o1', token: 'lid-gone' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(h.replaced).toEqual([]);
    expect(h.created).toHaveLength(1);
  });
});

/**
 * 🔴 **2 回目の保存でノートを増やさない**(#217。cowork 実機 2026-08-16 で 1/1 再現)。
 *
 * ⚠ 窓が持っている合言葉は「PKC から渡した添付」の分だけなので、**窓の中で新規に
 * 作った文書**は 1 回目が合言葉なしで届く ── そこで**作ったノートを窓へ返さないと**、
 * 2 回目も合言葉なしのまま来て**また新しいノートになる**。
 *
 * 🔑 観測点は「返したか」ではなく **`(鍵, lid)` の対で返したか**である ──
 * 鍵が違うと窓は自分のどの保存の話か分からず、対応表を書き換えられない。
 */
describe('🔴 作ったノートを窓へ返す(2 回目の保存が増えない)', () => {
  it('新規に作ったら、鍵と lid を対で返す', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '無題 1.odt' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(h.adopted, '作ったノートを窓へ返していない ── 次の保存でノートが増える')
      .toEqual(['o1=new-lid']);
  });

  it('窓が既に知っている差し替えでは返さない(合言葉は既に正しい)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('replaced');
    expect(h.adopted).toEqual([]);
  });

  /**
   * 🔴 **窓が知らないまま差し替えになった保存も返す。**
   *
   * ⚠ 「新規のときだけ返す」に狭めると穴が残る:編集中に同じ文書が 2 件溜まると
   * 1 件目=新規 / **2 件目=差し替え**になり、窓が覚えているのは**新しいほうの鍵**
   * だけとは限らず(窓が覚える鍵には上限が在る ── `KEY_MEMORY_MAX`)、
   * **返事がどこにも着かないことがある**
   * → 次の保存でまたノートが増える。
   */
  it('🔴 束ねて差し替えになった保存は、その鍵でも返す', async () => {
    const h = harness();
    // ⚠ 棚に同時に溜まった同じ文書は**新しい 1 件だけ**処理する(#1087)ので、
    //    「束ねて差し替え」は**別々の引き取り**で見る(窓の放送は 1 件ずつ来る)
    h.stage.put({ key: 'o1', name: 'x.odt', path: '/work/x.odt', at: 1 });
    expect(await h.sb.receive('o1')).toBe('created');
    h.stage.put({ key: 'o2', name: 'x.odt', path: '/work/x.odt', at: 2 });
    expect(await h.sb.receive('o2')).toBe('replaced');
    expect(h.created).toEqual(['x.odt']);
    expect(h.replaced).toEqual(['new-lid']);
    expect(
      h.adopted,
      '新しいほうの鍵で返していない ── 窓は古い鍵を忘れているので届かない',
    ).toEqual(['o1=new-lid', 'o2=new-lid']);
  });

  it('🔴 取り込めていないのに返さない(保留 / 失敗)', async () => {
    const busy = harness({ canWrite: () => false });
    busy.stage.put({ key: 'o1' });
    expect(await busy.sb.receive('o1')).toBe('deferred');
    expect(busy.adopted, '保留したのにノートを名乗った').toEqual([]);

    const stuck = harness({ createNote: async () => null });
    stuck.stage.put({ key: 'o2' });
    expect(await stuck.sb.receive('o2')).toBe('deferred');
    expect(stuck.adopted).toEqual([]);
  });

  it('🔴 合言葉のノートが消えて新規へ倒れたときも返す(倒れ先を窓へ教える)', async () => {
    const h = harness({ readAttachment: async () => null });
    h.stage.put({ key: 'o1', token: 'lid-gone' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(h.adopted, '倒れ先を教えないと、以後ずっと新規になり続ける')
      .toEqual(['o1=new-lid']);
  });

  it('🔴 返せなくても、取り込みは成立して棚から消える', async () => {
    const h = harness({ adopt: () => { throw new Error('放送が閉じている'); } });
    h.stage.put({ key: 'o1' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(
      h.stage.keys(),
      '返せなかっただけで棚が残った ── 次の掃除でノートがもう 1 件できる',
    ).toEqual([]);
  });
});

/**
 * 🔴 **窓の返事が間に合わない経路**(#217 の残り。着地前レビュー 2026-08-16)。
 *
 * ⚠ 窓の表は**往復**で埋まるので、返事が返る前に次の保存が来ると素通りする。
 * そして**それは編集中に確定的に起きる** ── `canWrite()` が偽の間は棚に溜めるだけで
 * 返事を出さないので、編集を終えた瞬間に**合言葉の無い同じ文書が複数件**流れてくる。
 * 🔑 窓の表だけでは塞がらない。**引き取る側も 1 パスの中で同じ文書を束ねる**。
 *
 * ⚠ 束ねる鍵は **`win` と `path` の対**である ── path だけだと、2 枚目の窓が
 * 同じ名前で保存したときに**別の文書どうしを 1 つのノートへ潰す**。
 */
describe('🔴 編集中に溜まった同じ文書の保存を、1 件のノートに束ねる', () => {
  it('編集明けの一括取り込みで、同じ文書はノート 1 件 + 差し替え', async () => {
    let ready = false;
    const h = harness({ canWrite: () => ready });
    h.stage.put({ key: 'o1', name: '無題 1.odt', path: '/home/web_user/無題 1.odt', at: 1 });
    expect(await h.sb.receive('o1')).toBe('deferred');
    h.stage.put({ key: 'o2', name: '無題 1.odt', path: '/home/web_user/無題 1.odt', at: 2 });
    expect(await h.sb.receive('o2')).toBe('deferred');
    expect(h.created, '編集中なのに作った').toEqual([]);

    ready = true;
    // ⚠ #1087: 古い o1 は o2 が届いた時点で捨てられ、新しい 1 件だけがノートになる
    expect(await h.sb.retryDeferred()).toBe(1);
    expect(h.created, '同じ文書なのにノートを 2 件作った').toEqual(['無題 1.odt']);
    expect(h.replaced, '古い版で差し替えた').toEqual([]);
    expect(h.stage.keys(), '取り込んだのに棚に残っている').toEqual([]);
  });

  /**
   * 🔴 **合言葉が「在るが死んでいる」ときも束ねる**(2 巡目レビュー)。
   *
   * ⚠ `save.token` を無条件に優先すると、束ねの表を**一度も見ない** ──
   * 開いていた添付を user が消した状態で編集中に 2 件溜まると、
   * 1 件目=新規 / 2 件目も**新規**になり、ここでもノートが 2 件できる。
   */
  it('🔴 合言葉が死んでいても、この引き取りで作った先へ倒す', async () => {
    const h = harness({ readAttachment: async (lid) => (lid === 'new-lid' ? { assetKey: 'a' } : null) });
    h.stage.put({ key: 'o1', name: 'x.odt', path: '/work/x.odt', token: 'lid-gone', at: 1 });
    expect(await h.sb.receive('o1')).toBe('created');
    h.stage.put({ key: 'o2', name: 'x.odt', path: '/work/x.odt', token: 'lid-gone', at: 2 });
    expect(await h.sb.receive('o2')).toBe('replaced');
    expect(h.created, '死んだ合言葉を優先してノートを 2 件作った').toEqual(['x.odt']);
    expect(h.replaced).toEqual(['new-lid']);
  });

  it('🔴 path が違えば束ねない(別々の文書)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: 'あ.odt', path: '/home/web_user/あ.odt' });
    h.stage.put({ key: 'o2', name: 'い.odt', path: '/home/web_user/い.odt' });
    expect(await h.sb.drainAll()).toBe(2);
    expect(h.created).toEqual(['あ.odt', 'い.odt']);
    expect(h.replaced, '別の文書を差し替えた').toEqual([]);
  });

  it('🔴 窓が違えば束ねない(同じ path でも別の MEMFS)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '無題 1.odt', path: '/work/無題 1.odt', win: 'win-A' });
    h.stage.put({ key: 'o2', name: '無題 1.odt', path: '/work/無題 1.odt', win: 'win-B' });
    expect(await h.sb.drainAll()).toBe(2);
    expect(
      h.created,
      '別の窓の同名文書を 1 つのノートへ潰した ── 片方の中身が失われる',
    ).toEqual(['無題 1.odt', '無題 1.odt']);
    expect(h.replaced).toEqual([]);
  });

  it('🔴 窓の id が無い古い meta は束ねない(安全側へ倒す)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '無題 1.odt', path: '/work/無題 1.odt', win: '' });
    h.stage.put({ key: 'o2', name: '無題 1.odt', path: '/work/無題 1.odt', win: '' });
    expect(await h.sb.drainAll()).toBe(2);
    expect(h.created).toHaveLength(2);
    expect(h.replaced).toEqual([]);
  });

  /**
   * 🔴 **束ねる表はパスを跨いで持つ**(#220-1、2026-08-17 に反転させた)。
   *
   * ⚠ 直す前は「持ち越さない」ことを主張していたが、その理由(**窓を読み直すと
   * 同じ path に別の文書が居る**)は**成り立たない** ── `win` は窓の中で
   * `randomUUID` で作られ、読み直しは完全再読込なので **`win` ごと変わる**。
   * そして持ち越さないと、**実経路(鍵 1 件ごとの放送)では束ねが 1 度も効かない**
   * ── #217 の症状(同じ文書で 2 件できる)がタイミング次第で残っていた。
   */
  it('🔴 別々の放送でも同じ文書は束ねる(#217 の実経路)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '無題 1.odt', path: '/work/無題 1.odt' });
    expect(await h.sb.receive('o1')).toBe('created');
    h.stage.put({ key: 'o2', name: '無題 1.odt', path: '/work/無題 1.odt' });
    // ⚠ 観測点は「差し替えになったか」── `receive` は放送 1 件ごとに来るので、
    //    表が run のローカルだとここが必ず 'created' になる
    expect(await h.sb.receive('o2')).toBe('replaced');
    expect(h.created, '同じ文書でノートが 2 件できた').toHaveLength(1);
    expect(h.replaced).toEqual(['new-lid']);
  });

  it('🔴 別々の放送でも、窓が違えば束ねない(過剰な束ねの門)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '無題 1.odt', path: '/work/無題 1.odt', win: 'win-A' });
    expect(await h.sb.receive('o1')).toBe('created');
    h.stage.put({ key: 'o2', name: '無題 1.odt', path: '/work/無題 1.odt', win: 'win-B' });
    expect(await h.sb.receive('o2')).toBe('created');
    expect(h.created, '別の窓の同名文書を 1 つのノートへ潰した').toHaveLength(2);
  });

  it('🔴 表は上限で古いものから落ちる(際限なく溜めない)', async () => {
    const h = harness();
    // 上限まで**別の文書**で埋める(最初の 1 件が押し出される)
    for (let i = 0; i < SAME_DOC_MAX + 1; i += 1) {
      h.stage.put({ key: `k${i}`, name: `d${i}.odt`, path: `/work/d${i}.odt` });
      expect(await h.sb.receive(`k${i}`)).toBe('created');
    }
    // 最初の文書をもう一度 ── 忘れているので新規になる
    h.stage.put({ key: 'again', name: 'd0.odt', path: '/work/d0.odt' });
    expect(await h.sb.receive('again')).toBe('created');
  });

  it('🔴 上限は窓側の記憶(KEY_MEMORY_MAX)と同じ数(片側だけ覚えない)', () => {
    const js = readFileSync('public/office/office-save-watch.js', 'utf-8');
    const m = /KEY_MEMORY_MAX\s*=\s*(\d+)/.exec(js);
    expect(m, '窓側の上限が読めない ── 検査が空振りしている').not.toBeNull();
    expect(SAME_DOC_MAX).toBe(Number(m![1]));
  });

  /**
   * 🔴 **並行に届いても 1 本ずつ引き取る**(#220-1)。`main.ts` は `void receive(...)`
   * で撃つので、`createNote` の await 中に 2 件目が入ると**表がまだ空**で両方新規に
   * なる ── `inFlight` は同じ**鍵**しか守らない。
   */
  it('🔴 同じ文書の 2 件が同時に来ても、ノートは 1 件(直列化)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const h = harness({
      createNote: async () => {
        calls += 1;
        if (calls === 1) await gate; // 1 件目を止めたまま 2 件目を走らせる
        return 'new-lid';
      },
    });
    h.stage.put({ key: 'o1', name: '無題 1.odt', path: '/work/無題 1.odt', at: 1 });
    const a = h.sb.receive('o1');
    // 1 件目が `createNote` で止まってから 2 件目を棚に置く(#1087: 先に置くと古い o1 は捨てられる)
    await vi.waitFor(() => expect(calls).toBe(1));
    h.stage.put({ key: 'o2', name: '無題 1.odt', path: '/work/無題 1.odt', at: 2 });
    const b = h.sb.receive('o2');
    release();
    expect([await a, await b]).toEqual(['created', 'replaced']);
    // ⚠ 観測点は **`createNote` を何回呼んだか**(`h.created` は既定の実装が積むので、
    //    差し替えたこの test では使えない ── 空振りの作り方そのもの)
    expect(calls, '同時に来たら 2 件作りに行った').toBe(1);
    expect(h.replaced).toEqual(['new-lid']);
  });
});

describe('🔴 取り込めていないのに棚から消さない(文書が消える形)', () => {
  it('編集中は保留する ── 棚に残す', async () => {
    const h = harness({ canWrite: () => false });
    h.stage.put({ key: 'o1' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(h.created, '編集中なのに作りに行った').toEqual([]);
    expect(h.stage.keys().sort(), '保留したのに棚から消えた').toEqual(['o1.bin', 'o1.json']);
    expect(h.notices.filter((m) => m.includes('取り込みました')), '取り込んでいないのに「取り込みました」と言った').toEqual([]);
    expect(h.notices, '預かっているのに何も言わない(#1087)').toHaveLength(1);
  });

  it('作成が撃てなかったら保留する ── 棚に残す', async () => {
    const h = harness({ createNote: async () => null });
    h.stage.put({ key: 'o1' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(h.stage.keys().sort()).toEqual(['o1.bin', 'o1.json']);
  });

  it('差し替えが撃てなかったら保留する ── 棚に残す', async () => {
    const h = harness({ replaceAsset: async () => false });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(h.stage.keys().sort()).toEqual(['o1.bin', 'o1.json']);
  });

  it('🔴 holder でないタブは 1 バイトも触らない(放送は全タブに届く)', async () => {
    const h = harness({ isHolder: () => false });
    h.stage.put({ key: 'o1' });
    expect(await h.sb.receive('o1')).toBeNull();
    expect(h.created).toEqual([]);
    expect(h.stage.keys().sort(), 'holder でないのに棚を消した').toEqual(['o1.bin', 'o1.json']);
  });

  it('OPFS が無い環境では何も起きない(落ちない)', async () => {
    const h = harness({ stage: async () => null });
    expect(await h.sb.receive('o1')).toBeNull();
    expect(h.fails).toEqual([]);
  });
});

describe('保留の撃ち直し', () => {
  it('🔴 編集が終わったら、保留していたものが取り込まれる', async () => {
    let ready = false;
    const h = harness({ canWrite: () => ready });
    h.stage.put({ key: 'o1' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    ready = true;
    expect(await h.sb.retryDeferred()).toBe(1);
    expect(h.created).toHaveLength(1);
    expect(h.stage.keys()).toEqual([]);
  });

  it('🔴 保留が無ければ棚を舐めない(編集を終えるたびに走らせない)', async () => {
    const h = harness();
    const spy = vi.spyOn(h.deps, 'stage');
    expect(await h.sb.retryDeferred()).toBe(0);
    expect(spy, '保留が無いのに棚を開いた').not.toHaveBeenCalled();
  });

  it('🔑 一度撃ち直したら、次は走らない(毎回舐めない)', async () => {
    let ready = false;
    const h = harness({ canWrite: () => ready });
    h.stage.put({ key: 'o1' });
    await h.sb.receive('o1');
    ready = true;
    await h.sb.retryDeferred();
    const spy = vi.spyOn(h.deps, 'stage');
    expect(await h.sb.retryDeferred()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('起動時の掃除と全件引き取り', () => {
  it('🔴 棚に残っている全部を取り込む(放送はもう来ない)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: 'a.odt', at: 2 });
    h.stage.put({ key: 'o2', name: 'b.odt', at: 1 });
    expect(await h.sb.drainAll()).toBe(2);
    // ⚠ **古い順**(先に保存したものから戻す)
    expect(h.created).toEqual(['b.odt', 'a.odt']);
    expect(h.stage.keys()).toEqual([]);
  });

  it('壊れているもの(大きさが meta と食い違う)は捨てるが、黙らない', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: 'x.odt', size: 999 }, new Uint8Array([1]));
    expect(await h.sb.receive('o1')).toBe('failed');
    expect(h.created).toEqual([]);
    expect(h.stage.keys(), '直らないものを残した').toEqual([]);
    expect(h.fails[0], '黙って捨てた').toContain('x.odt');
  });

  it('取り込みの途中で例外が出ても、次のものへ進む', async () => {
    let n = 0;
    const h = harness({
      createNote: async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
        return 'lid';
      },
    });
    h.stage.put({ key: 'o1', name: 'a.odt', at: 1 });
    h.stage.put({ key: 'o2', name: 'b.odt', at: 2 });
    expect(await h.sb.drainAll()).toBe(1);
    expect(h.fails[0]).toContain('a.odt');
    expect(h.stage.keys().sort(), '落ちた方は棚に残す').toEqual(['o1.bin', 'o1.json']);
  });
});

describe('窓からの失敗報告', () => {
  it('🔴 「渡せなかった」を user へ出す(黙って落とさない)', () => {
    const h = harness();
    h.sb.reportWindowFailure('OPFS がありません');
    expect(h.fails[0]).toContain('OPFS がありません');
  });
});

/**
 * 🔴 **昇格したタブでも門が開く**(2026-08-16、着地前レビュー R1)。
 *
 * ⚠ この配線は `main.ts` に在り、あそこは**原文を読む test しか無い** ──
 * だから弱い pin であることを自覚して使う(CLAUDE.md §2)。
 * ⚠ 初稿は `isHolder: () => followerConn === null` と書き、コメントに
 * 「呼ぶたびに読む」とまで書いていたのに、**`followerConn` は boot 以外で
 * 代入されない**ので値が変わらなかった ── 昇格したタブでは Office の保存が
 * 棚に溜まり続け、アプリを開き直すまで届かなかった。
 *
 * 🔑 見るのは「変数名が在る」ではなく **3 つが揃っていること**:
 * ①門がその変数を読む ②boot で取れたら真 ③**昇格でも真になる**。
 */
describe('holder の門(main.ts の配線)', () => {
  const src = readFileSync('src/main.ts', 'utf-8');
  // 実行する行だけを見る(コメントに書いただけで通らないように)
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n');

  it('🔴 門は昇格で変わる値を読んでいる', () => {
    expect(code, 'isHolder が writerHolder を読んでいない').toContain(
      'isHolder: () => writerHolder',
    );
  });

  /**
   * 🔴 **撃てたかの後条件は、reducer の門を**全部**見る**(R6 / 変異 N8)。
   * ⚠ `OFFICE_ASSET_SAVED` の reducer は門を 2 つ持つ(`ready` か / いまも添付か)。
   * `phase` だけ見ていると、2 つ目で黙って捨てられたときに
   * **何も書かずに「取り込みました」と言って棚を空にする**。
   * ⚠ 同じ commit の `attachOne` は本物の後条件(`entryMetas.has(lid)`)を
   * 持っており、**非対称**だった。
   */
  it('🔴 差し替えの後条件が、archetype まで見ている', () => {
    expect(code, '後条件が phase しか見ていない ── 捨てられたのに棚を空にする').toContain(
      "after.entryMetas.get(lid)?.archetype === 'attachment'",
    );
  });

  /**
   * 🔴 **作ったノートを窓へ返す配線**(2 巡目レビュー)。
   *
   * ⚠ `main.ts` は**どの test からも import されない**ので、ここを原文で pin しないと
   * 誰も見ていない。実際、引数を入れ替える変異
   * (`officeWindow.adoptSave(lid, key)`)は **unit も smoke も typecheck も緑のまま**
   * #217 を完全に未修正へ戻す(窓は `paths[lid]` を知らないので返事が捨てられる。
   * 引数は両方 `string` なので型でも止まらない)。
   * 🔑 だから**引数の順まで**含めて等値で見る ── 「名前が在る」では足りない。
   */
  it('🔴 作ったノートを窓へ返している(引数の順まで)', () => {
    expect(
      code,
      'adopt が窓へ届いていない ── 2 回目の保存でノートが増える',
    ).toContain('adopt: (key, lid) => { officeWindow.adoptSave(key, lid); }');
  });

  /**
   * 🔴 **手元のファイルへ書き戻す口が、実際に配線されている**(#432 段②)。
   *
   * ⚠ ここを見ないと、「手元のファイルを直したのに **PKC のノートが増える**」
   *   という、user がいちばん気づきにくい形で壊れる。
   */
  it('🔴 手元のファイルの行き先が窓の合言葉から引かれている', () => {
    expect(code, '手元のファイルへ戻す口が配線されていない').toContain('writeLocal:');
    expect(
      code,
      '合言葉を見分けずに書いている(ノートの lid でも書き戻しに行く)',
    ).toContain('localOffice.nameOf(token)');
    expect(code).toContain('localOffice.writeBack(token, bytes)');
  });

  it('🔴 OS から来た Office 文書は、markdown の取り込みへ落ちない', () => {
    // ⚠ 落ちると `import-file.ts` が濾して**黙って捨てる** ── user から見ると
    //   「ダブルクリックしたのに『開けるファイルがありませんでした』」になる
    expect(code, '振り分けていない ── OS から開いても誰も受け取らない').toContain(
      'isOfficeLaunchFile(i.file.name)',
    );
    // ⚠ **取り除く側**も在ること(片方だけだと二重に処理される)
    expect(code, 'Office へ回した物を取り込みからも外していない').toContain(
      'items.filter((i) => !isOfficeLaunchFile(i.file.name))',
    );
  });

  it('🔴 起動の受け口では窓を開かない(ポップアップ遮断で消える)', () => {
    /**
     * ⚠ `launchQueue` は **user の操作ではない**ので、そこから `window.open` を
     *   呼ぶと遮断される。控えて、user が押したときに渡す形でなければならない。
     */
    // ⚠ 2026-10-02(#215 段②): 受け口を `return { … }` の中から**手前の const へ移した**
    //   (パソコンのフォルダの行を押したときも同じ口へ渡すため)。切り出す始点と終点だけ追随させた ──
    //   見ている物(窓を開かず、控える)は変えていない。
    const from = code.indexOf("importLaunchFiles: AppHandle['importLaunchFiles'] = async (items)");
    expect(from, '受け口の宣言が見つからない(切り出しが壊れた)').toBeGreaterThan(-1);
    const intake = code.slice(from);
    const body = intake.slice(0, intake.indexOf('openLocalFile = createLocalFileOpener'));
    expect(body.length, '受け口の本体が空(終点が見つからない)').toBeGreaterThan(500);
    expect(body, '起動の受け口で窓を開いている(遮断されて消える)').not.toContain(
      'officeWindow.open(',
    );
    expect(body, '控えていない').toContain('localOffice.stage(');
  });

  it('🔴 タイルを押したときに控えを渡している(user の操作の中なので遮断されない)', () => {
    const tile = code.slice(code.indexOf('const openOfficeTile'));
    const body = tile.slice(0, tile.indexOf('watchOfficeHang'));
    expect(body, '控えを取り出していない').toContain('localOffice.take()');
    // 渡す口は `provideStagedLocal`(読み直しの口を添える ── 中身は local-office-files.test.ts が本物の窓で見る)
    expect(body, '控えを渡していない').toContain('provideStagedLocal(officeWindow, localOffice, staged)');
  });

  it('🔴 boot で取れたとき・待った末に取れたとき・昇格したとき、の**3 経路とも**で真になる', () => {
    // ⚠ 1 経路でも欠けると、その経路で本体になったタブは保存が永久に届かない
    const assigns = code.match(/writerHolder = true;/g) ?? [];
    expect(assigns.length, 'writerHolder を真にする場所が 3 つ無い(boot / 待った末 / 昇格)').toBe(3);
    // 昇格の分岐の中に在ることまで見る(どこかに 2 個ある、では足りない)
    const promoted = code.slice(code.indexOf('if (promotedHost) {'));
    expect(
      promoted.slice(0, promoted.indexOf('}')),
      '昇格の分岐で holder になっていない',
    ).toContain('writerHolder = true;');
  });

  /**
   * 🔴 **待った末に lease を得た経路でも真になる**(#1409)。
   * ⚠ 本体が handshake に答えない間(旧ビルド / boot 中)は旧式の待機に落ち、
   *   `await heldP` の後に自分の worker を建てて本体になる ── 2 経路しか代入が無い間は、
   *   このタブだけ Office の保存の引き取り・索引の片づけ・縮める・起動時の検めが閉じたままだった。
   * ⚠ 数だけでは「別の場所に 3 つ目を足した」でも通るので、`await heldP` の枝の中を見る。
   */
  it('🔴 待った末の枝(await heldP の後)で holder になっている', () => {
    const from = code.indexOf('await heldP;');
    expect(from, '待った末の枝が読めない(空振り)').toBeGreaterThan(-1);
    const tail = code.slice(from);
    const end = tail.indexOf('const resolved = await resolveContainerCompat(');
    expect(end, '枝の終点が読めない(切り出しが壊れた)').toBeGreaterThan(0);
    const branch = tail.slice(0, end);
    expect(branch, '待った末の枝で StoreProxyHost を建てていない(切り出しが壊れた)').toContain(
      'new StoreProxyHost(',
    );
    expect(branch, '待った末に本体になったタブが holder にならない').toContain('writerHolder = true;');
  });
});

/**
 * 🔴 **手元のファイルから開いた回は、元のファイルへ戻す**(#432 段②)。
 *
 * ⚠ ここが効かないと「**手元のファイルを直したのに PKC のノートが増える**」に
 *   なる ── user は直したつもりで、元のファイルは古いまま残る(どちらが新しいか
 *   分からなくなる、いちばん取り返しがつかない形)。
 */
describe('手元のファイルへの書き戻し(#432)', () => {
  it('🔴 手元の合言葉なら、ノートを作らず元のファイルへ書く', async () => {
    const wrote: { token: string; n: number }[] = [];
    const h = harness({
      writeLocal: async (token, bytes) => {
        wrote.push({ token, n: bytes.length });
        return true;
      },
    });
    h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:1' });
    expect(await h.sb.receive('k1')).toBe('replaced');
    expect(wrote, '元のファイルへ書いていない').toHaveLength(1);
    expect(wrote[0]!.token).toBe('local:1');
    expect(h.created, '🔴 ノートを増やしている').toEqual([]);
    expect(h.replaced, '添付を差し替えている').toEqual([]);
    expect(h.notices.join(' ')).toContain('元のファイルへ保存しました');
    // 🔴 ファイル名は引用符で囲んである ── メッセージへ積むとき名前が残らない(#1017 C5)
    expect(sanitizeMessageText(h.notices.join(' ')), 'ファイル名がメッセージに残る').not.toContain('報告書');
    expect(h.stage.keys(), '棚から片付いていない').toEqual([]);
  });

  it('🔴 理由が分かれば理由を言い、行方(PKC3 の中に残してある)を 1 文で言う。棚は残る', async () => {
    const want: [string, string][] = [
      ['denied', '許可が得られなかった'],
      ['reopen', '開き直す必要があります'],
      ['unsupported', 'このブラウザでは元のファイルへ書き戻せません'],
    ];
    for (const [reason, phrase] of want) {
      const h = harness({ writeLocal: async () => reason as 'denied' });
      h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:1' });
      expect(await h.sb.receive('k1'), reason).toBe('deferred');
      const msg = h.fails.join(' ');
      expect(msg, `${reason} の理由を言っていない`).toContain(phrase);
      expect(msg, '行方を言っていない').toContain('編集した内容は PKC3 の中に残してあります');
      expect(h.stage.keys().length, `${reason}: 行方の主張が偽(棚が空)`).toBeGreaterThan(0);
    }
    // 対照群:理由が無い false には理由を作らない
    const h2 = harness({ writeLocal: async () => false });
    h2.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:1' });
    await h2.sb.receive('k1');
    expect(h2.fails.join(' ')).not.toMatch(/許可|開き直す|このブラウザ/);
  });

  it('🔴 書けなかったら**棚に残す**(user の編集を捨てない)', async () => {
    const h = harness({ writeLocal: async () => false });
    h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:1' });
    expect(await h.sb.receive('k1')).toBe('deferred');
    expect(h.fails.join(' '), '黙って落としている').toContain('元のファイルへ保存できません');
    expect(h.stage.keys().length, '棚から消した ── 次の起動で取り込み直せない').toBeGreaterThan(0);
    expect(h.created, '書けなかったのにノートを作った').toEqual([]);
  });

  it('🔴 書けないままの撃ち直しで、同じ赤い字を何度も出さない / 書けたら次の失敗はまた言う(#1087)', async () => {
    let ok = false;
    const h = harness({ writeLocal: async () => ok });
    h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:1' });
    expect(await h.sb.receive('k1')).toBe('deferred');
    expect(h.fails, '1 度目は言う').toHaveLength(1);
    await h.sb.retryDeferred();
    await h.sb.retryDeferred();
    expect(h.fails, '撃ち直しのたびに同じ字を出している').toHaveLength(1);
    expect(h.stage.keys(), '撃ち直しで棚から消した').toContain('k1.json');
    ok = true;
    await h.sb.retryDeferred();
    expect(h.stage.keys(), '書けたのに棚に残っている').not.toContain('k1.json');
    ok = false;
    h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:1' });
    await h.sb.receive('k1');
    expect(h.fails, '書けた後の新しい失敗を黙った').toHaveLength(2);
  });

  /**
   * ⚠ **対照群**。手元のファイルでない保存は、これまでどおり PKC のノートへ入る
   *   ── 置かないと「全部書き戻しへ落ちている」と区別がつかない。
   */
  it('⚠ 手元のファイルでなければ、これまでどおりノートへ取り込む', async () => {
    const h = harness({ writeLocal: async () => null });
    h.stage.put({ key: 'k1', name: 'a.odt', token: 'lid-1' });
    expect(await h.sb.receive('k1')).toBe('replaced');
    // ⚠ `replaced` に積まれるのは **lid**(名前ではない ── ここで 1 度外した)
    expect(h.replaced, 'ノートへの取り込みが走っていない').toEqual(['lid-1']);
  });

  it('⚠ 合言葉が無い保存は、書き戻しを 1 度も呼ばない', async () => {
    let asked = 0;
    const h = harness({
      writeLocal: async () => {
        asked += 1;
        return null;
      },
    });
    h.stage.put({ key: 'k1', name: 'a.odt' });
    await h.sb.receive('k1');
    expect(asked, '合言葉が無いのに書き戻しを引いた').toBe(0);
  });
});

/**
 * 🔴 **書き戻しが disk のノートに届いたかを確かめてから成功と言う**(#1087、添付の見直し)。
 */
describe('confirmSavedBack', () => {
  const body = (key: string, history: string[] = []): string =>
    serializeFrontmatter({ 'attachment.asset_key': key, 'attachment.history': history }) + '\n本文\n';
  const settle = async () => {};

  it('🔴 添付の key の欄が新しい key なら届いた', async () => {
    expect(await confirmSavedBack({ settle, readBody: async () => body('k-new'), key: 'k-new' })).toBe(true);
  });

  it('🔴 書けなかった(欄が古い key のまま)なら届いていない', async () => {
    expect(await confirmSavedBack({ settle, readBody: async () => body('k-old'), key: 'k-new' })).toBe(false);
  });

  it('🔴 新しい版が過去の版と同じ中身でも、版の台帳の字に救われない(着地前レビュー)', async () => {
    // 台帳に k-new が既に在る(前に同じ中身で保存した)。欄は k-old のまま = 今回は書けていない
    const b = body('k-old', ['2026-10-01T00:00:00.000Z|auto|k-new|10']);
    expect(b, '前提: 本文に新しい key の字が在る').toContain('k-new');
    expect(await confirmSavedBack({ settle, readBody: async () => b, key: 'k-new' })).toBe(false);
  });

  it('ノートが無い / 読めない / 待てないなら届いていない', async () => {
    expect(await confirmSavedBack({ settle, readBody: async () => null, key: 'k' })).toBe(false);
    expect(
      await confirmSavedBack({
        settle,
        readBody: async () => {
          throw new Error('読めない');
        },
        key: 'k',
      }),
    ).toBe(false);
    expect(
      await confirmSavedBack({
        settle: async () => {
          throw new Error('待てない');
        },
        readBody: async () => body('k'),
        key: 'k',
      }),
    ).toBe(false);
  });
});

/**
 * 🔴 **古い保存が、新しい版を上書きしない**(#1087、データ消失)。
 * 書けなかった保存 s1 が棚に残ったまま、次の保存 s2 が成功すると、後の掃除(`drainAll` /
 * `retryDeferred`)が s1 の古い bytes を書いてしまう ── 手元のファイルは履歴にも無く戻せない。
 * 「古い」は `listStaged` の順(`at` の昇順)。
 */
describe('同じ文書の古い保存を、新しい保存の後に書かない(#1087)', () => {
  const OLD = new Uint8Array([1, 1, 1]);
  const NEW = new Uint8Array([2, 2, 2]);

  it('🔴 手元のファイル: s1 が拒否 → s2 が成功 → 後の掃除は s1 の bytes を書かない', async () => {
    const file: number[][] = [];
    let denied = true;
    const h = harness({
      writeLocal: async (_t, bytes) => {
        if (denied) return 'denied';
        file.push([...bytes]);
        return true;
      },
    });
    h.stage.put({ key: 's1', token: 'local:1', at: 1 }, OLD);
    expect(await h.sb.receive('s1')).toBe('deferred');
    h.stage.put({ key: 's2', token: 'local:1', at: 2 }, NEW);
    denied = false;
    expect(await h.sb.receive('s2')).toBe('replaced');
    expect(h.stage.keys(), '古い保存が棚に残っている').toEqual([]);
    await h.sb.retryDeferred();
    await h.sb.drainAll();
    expect(file, '古い版が新しい版の後に書かれた').toEqual([[2, 2, 2]]);
  });

  it('🔴 差し替え: s1 が false → s2 が true → 後の掃除は s1 で差し替えない', async () => {
    const written: number[][] = [];
    let failing = true;
    const h = harness({
      replaceAsset: async (_lid, _save, bytes) => {
        if (failing) return false;
        written.push([...bytes]);
        return true;
      },
    });
    h.stage.put({ key: 's1', token: 'lid-7', at: 1 }, OLD);
    expect(await h.sb.receive('s1')).toBe('deferred');
    h.stage.put({ key: 's2', token: 'lid-7', at: 2 }, NEW);
    failing = false;
    expect(await h.sb.receive('s2')).toBe('replaced');
    await h.sb.retryDeferred();
    await h.sb.drainAll();
    expect(written).toEqual([[2, 2, 2]]);
    expect(h.stage.keys()).toEqual([]);
  });

  it('🔴 新規(合言葉なし): 同じ窓・同じ path の s1 が保留 → s2 で作成成功 → s1 では作らない', async () => {
    let fail = true;
    const h = harness({
      createNote: async (save) => {
        if (fail) return null;
        h.created.push(save.name);
        return 'new-lid';
      },
    });
    h.stage.put({ key: 's1', name: 'a.odt', at: 1 }, OLD);
    expect(await h.sb.receive('s1')).toBe('deferred');
    h.stage.put({ key: 's2', name: 'a.odt', at: 2 }, NEW);
    fail = false;
    expect(await h.sb.receive('s2')).toBe('created');
    await h.sb.drainAll();
    expect(h.created, '同じ文書のノートが 2 件できた').toEqual(['a.odt']);
    expect(h.stage.keys()).toEqual([]);
  });

  it('🔴 棚に同じ文書が複数あるとき、drainAll は新しい 1 件だけを処理する(古い方は書かない)', async () => {
    const file: number[][] = [];
    const h = harness({
      writeLocal: async (_t, bytes) => {
        file.push([...bytes]);
        return true;
      },
    });
    h.stage.put({ key: 's2', token: 'local:1', at: 2 }, NEW);
    h.stage.put({ key: 's1', token: 'local:1', at: 1 }, OLD);
    await h.sb.drainAll();
    expect(file).toEqual([[2, 2, 2]]);
    expect(h.stage.keys()).toEqual([]);
  });

  it('🔴 成功の後に棚へ現れた古い保存も捨てる(処理中に来た物)', async () => {
    let slipped = false;
    const h = harness({
      writeLocal: async () => {
        if (!slipped) {
          slipped = true;
          h.stage.put({ key: 's0', token: 'local:1', at: 1 }, OLD);
        }
        return true;
      },
    });
    h.stage.put({ key: 's2', token: 'local:1', at: 2 }, NEW);
    await h.sb.receive('s2');
    expect(slipped, '前提: 処理中に古い保存を置けている').toBe(true);
    expect(h.stage.keys(), '成功した保存より古い物が残っている').toEqual([]);
  });

  it('🔴 成功の後に棚へ現れた古い保存も捨てる ── 差し替え・新規の経路でも', async () => {
    for (const via of ['replace', 'create'] as const) {
      let slipped = false;
      const slip = (): void => {
        if (slipped) return;
        slipped = true;
        h.stage.put(
          via === 'replace'
            ? { key: 's0', token: 'lid-7', at: 1 }
            : { key: 's0', name: 'a.odt', at: 1 },
          OLD,
        );
      };
      const h = harness({
        replaceAsset: async () => {
          slip();
          return true;
        },
        createNote: async () => {
          slip();
          return 'new-lid';
        },
      });
      h.stage.put(
        via === 'replace' ? { key: 's2', token: 'lid-7', at: 2 } : { key: 's2', name: 'a.odt', at: 2 },
        NEW,
      );
      await h.sb.receive('s2');
      expect(slipped, `${via}: 前提`).toBe(true);
      expect(h.stage.keys(), `${via}: 古い保存が残っている`).toEqual([]);
    }
  });

  it('⚠ 別の文書の保存は捨てない(合言葉が違う / 窓が違う)', async () => {
    const h = harness({ canWrite: () => false });
    h.stage.put({ key: 'a', token: 'lid-1', at: 1 });
    h.stage.put({ key: 'b', token: 'lid-2', at: 2 });
    h.stage.put({ key: 'c', name: 'x.odt', win: 'w1', at: 3 });
    h.stage.put({ key: 'd', name: 'x.odt', win: 'w2', at: 4 });
    await h.sb.drainAll();
    expect(h.stage.keys().filter((k) => k.endsWith('.json')).sort()).toEqual([
      'a.json', 'b.json', 'c.json', 'd.json',
    ]);
  });

  it('⚠ 対照群: 1 件だけ失敗した保存は、後で撃ち直されて書かれる(捨てない)', async () => {
    const file: number[][] = [];
    let denied = true;
    const h = harness({
      writeLocal: async (_t, bytes) => {
        if (denied) return 'denied';
        file.push([...bytes]);
        return true;
      },
    });
    h.stage.put({ key: 's1', token: 'local:1', at: 1 }, OLD);
    expect(await h.sb.receive('s1')).toBe('deferred');
    expect(h.stage.keys().length).toBeGreaterThan(0);
    denied = false;
    expect(await h.sb.retryDeferred()).toBe(1);
    expect(file).toEqual([[1, 1, 1]]);
    expect(h.stage.keys()).toEqual([]);
  });
});

/**
 * 🔴 **手元のファイルの保存は、合言葉を知らないタブでノートにしない**(#1087)。
 * ⚠ 合言葉は開いたタブの中にしか無い。知らないタブが `createNote` へ落ちると、
 *   元のファイルは古いまま添付ノートが増える。
 */
describe('手元のファイルの合言葉を知らないタブ(#1087)', () => {
  it('🔴 holder が合言葉を知らないとき、ノートを作らず棚に残す', async () => {
    const h = harness({ knowsLocal: () => false, writeLocal: async () => null });
    h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:s-1', at: Date.now() });
    expect(await h.sb.receive('k1')).toBe('deferred');
    expect(h.created, '🔴 知らないタブがノートを作った').toEqual([]);
    expect(h.replaced).toEqual([]);
    expect(h.notices, '取り込んだと言っている').toEqual([]);
    expect(h.stage.keys().length, '棚から消えた').toBeGreaterThan(0);
    expect(h.fails, '保存の直後は黙って待つ').toEqual([]);
  });

  it('🔴 holder でなくても、合言葉を知っているタブが元のファイルへ書く', async () => {
    const wrote: string[] = [];
    const h = harness({
      isHolder: () => false,
      knowsLocal: (t) => t === 'local:s-1',
      writeLocal: async (t) => { wrote.push(t); return true; },
    });
    h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:s-1' });
    expect(await h.sb.receive('k1')).toBe('replaced');
    expect(wrote).toEqual(['local:s-1']);
    expect(h.created).toEqual([]);
    expect(h.stage.keys()).toEqual([]);
  });

  it('🔴 holder でなく、知らないタブは何も触らない。PKC のノートの保存も引き取らない', async () => {
    const h = harness({ isHolder: () => false, knowsLocal: () => false });
    h.stage.put({ key: 'k1', token: 'local:s-1' });
    h.stage.put({ key: 'k2', token: 'lid-7', win: 'w2' });
    expect(await h.sb.receive('k1')).toBeNull();
    expect(await h.sb.receive('k2'), 'holder でないのに DB へ書いた').toBeNull();
    expect(h.created).toEqual([]);
    expect(h.replaced).toEqual([]);
    expect(h.stage.keys().length).toBe(4);
  });

  it('🔴 古い保存を誰も書けないときは、ノートを 1 件作り、正確な一言だけを言う', async () => {
    let wrote = 0;
    const h = harness({
      knowsLocal: () => false,
      readAttachment: async () => ({ assetKey: 'ast-x' }),
      writeLocal: async () => { wrote += 1; return true; },
    });
    h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:s-1', at: Date.now() - LOCAL_ORPHAN_GRACE_MS - 1000 });
    expect(await h.sb.receive('k1')).toBe('created');
    expect(wrote, '知らない合言葉で元のファイルへ書こうとした').toBe(0);
    expect(h.created).toEqual(['報告書.docx']);
    expect(h.replaced, '手元の合言葉でノートを差し替えた').toEqual([]);
    expect(h.notices).toEqual([localOrphanImportedNotice('報告書.docx')]);
    // 🔴 依頼 95-1:つながりが切れていたことと、元のファイルは変わっていないことを言う
    expect(h.notices[0]).toContain('元のファイルとのつながりが切れていた');
    expect(h.notices[0]).toContain('元のファイルは変わっていません');
    expect(h.notices[0], '半端に書き換わったと読める旧い言い方').not.toContain('書き戻せませんでした');
    expect(h.notices.join(' '), '一般の取り込み通知も出ている').not.toContain('Office で保存した内容を取り込みました');
    expect(h.stage.keys()).toEqual([]);
  });

  it('🔴 猶予の間は、ノートを作らない', async () => {
    const h = harness({ knowsLocal: () => false });
    h.stage.put({ key: 'k1', token: 'local:s-1', at: Date.now() - LOCAL_ORPHAN_GRACE_MS + 5000 });
    expect(await h.sb.receive('k1')).toBe('deferred');
    expect(h.created).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.stage.keys().length).toBeGreaterThan(0);
  });

  it('🔴 O8: 猶予の間に保留した保存は、retryDeferred で撃ち直され、手元のファイルへ書かれる', async () => {
    let known = false;
    const wrote: string[] = [];
    const h = harness({
      knowsLocal: () => known,
      writeLocal: async (t) => { wrote.push(t); return true; },
    });
    h.stage.put({ key: 'k1', name: '報告書.docx', token: 'local:s-1', at: Date.now() });
    expect(await h.sb.receive('k1')).toBe('deferred');
    known = true;   // 合言葉を知っているタブが現れた(開いたタブの台帳が揃った)
    expect(await h.sb.retryDeferred(), '保留の印が立たず、撃ち直しが空振りしている').toBe(1);
    expect(wrote).toEqual(['local:s-1']);
    expect(h.created).toEqual([]);
  });

  it('🔴 holder でないタブは、古くてもノートを作らない', async () => {
    const h = harness({ isHolder: () => false, knowsLocal: () => false });
    h.stage.put({ key: 'k1', token: 'local:s-1', at: 1 });
    expect(await h.sb.receive('k1')).toBeNull();
    expect(await h.sb.drainAll()).toBe(0);
    expect(h.created).toEqual([]);
    expect(h.stage.keys().length).toBeGreaterThan(0);
  });

  it('配線: knowsLocal が合言葉の台帳から引かれている', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toContain('knowsLocal: (token) => localOffice.nameOf(token) !== null');
  });
});

/** 🔴 差し替えに記録する時刻は窓が保存した時刻(#1087)。 */
describe('保存した時刻(savedAt)', () => {
  it('窓の保存時刻を使い、0 / 欠けは今に倒す', () => {
    expect(stagedSavedAt(1_000_000, 9_000_000)).toBe(new Date(1_000_000).toISOString());
    expect(stagedSavedAt(0, 9_000_000)).toBe(new Date(9_000_000).toISOString());
    expect(stagedSavedAt(undefined, 9_000_000)).toBe(new Date(9_000_000).toISOString());
  });

  it('🔴 保留した保存のあとに打った控えは、書き戻しが後になっても見送られない', () => {
    const savedAtWindow = 1_000_000;
    const writeBackAt = 5_000_000; // 保留が明けて書いた時刻
    const shadowAt = 2_000_000; // Ctrl+S のあとに打った控え
    const recorded = Date.parse(stagedSavedAt(savedAtWindow, writeBackAt));
    expect(isShadowNewer(shadowAt, recorded), '控えが隠れる').toBe(true);
    // 対照: 書き戻した時刻を記録すると隠れる(直す前の挙動)
    expect(isShadowNewer(shadowAt, writeBackAt)).toBe(false);
  });

  it('配線: replaceAsset が save.at を渡している', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    // 差し替えの道は 1 本(`replaceAttachmentBlob`。#1163 依頼 212 でボタンと共有)── Office の側は窓の時刻を渡す
    expect(main).toContain('replaceAttachmentBlob(lid, save.name, new Blob([bytes]), stagedSavedAt(save.at))');
  });
});

describe('編集中の保存 ── 新しい添付は通し、差し替えは預かって、そう言う(#1087)', () => {
  const editing = { canWrite: () => false, canCreate: () => true };

  it('🔴 編集中でも、新しい添付のノートは作れる(棚から消え、作ったノートへ「開く」を渡す)', async () => {
    const h = harness(editing);
    h.stage.put({ key: 'o1', name: '無題 1.odt' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(h.created).toEqual(['無題 1.odt']);
    expect(h.stage.keys()).toEqual([]);
    expect(h.opened, '知らせの「開く」が作ったノートを指していない').toEqual(['new-lid']);
    expect(h.notices.some((m) => /編集中なのでまだ/.test(m)), '作れたのに預かったと言っている').toBe(false);
  });

  it('🔴 編集中は、差し替えを預かる(撃たない・棚に残す)── 一度だけそう言う', async () => {
    const h = harness(editing);
    h.stage.put({ key: 'o1', name: '報告.docx', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(await h.sb.retryDeferred()).toBe(0);
    expect(h.replaced, '編集中に差し替えを撃った').toEqual([]);
    expect(h.stage.keys().sort(), '預かったのに棚から消えた').toEqual(['o1.bin', 'o1.json']);
    const held = h.notices.filter((m) => m.includes('編集中なのでまだ入れていません'));
    expect(held, '預かっているのに何も言わない / 毎回言う').toHaveLength(1);
    expect(held[0]).toContain('報告.docx');
  });

  it('🔴 編集中は、手元のファイルへの書き戻しも預かる', async () => {
    const writeLocal = vi.fn(async () => true as const);
    const h = harness({ ...editing, writeLocal });
    h.stage.put({ key: 'o1', token: 'local:1' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(writeLocal).not.toHaveBeenCalled();
    expect(h.notices.filter((m) => m.includes('編集中なのでまだ入れていません'))).toHaveLength(1);
  });

  it('書けない(新規も足せない)ときも預かって、一度だけ言う。編集を終えて取り込めたら、また預かったときにもう一度言う', async () => {
    let busy = true;
    const h = harness({ canWrite: () => !busy, canCreate: () => !busy });
    h.stage.put({ key: 'o1', name: 'a.odt' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(await h.sb.retryDeferred()).toBe(0);
    expect(h.notices.filter((m) => m.includes('編集中なのでまだ'))).toHaveLength(1);
    busy = false;
    expect(await h.sb.retryDeferred()).toBe(1);
    expect(h.stage.keys()).toEqual([]);
    // 取り込めたら「言った」記録も外れる(同じ鍵は再び来ないが、別の保存は別に言う)
    busy = true;
    h.stage.put({ key: 'o2', name: 'b.odt', path: '/work/b.odt' });
    expect(await h.sb.receive('o2')).toBe('deferred');
    expect(h.notices.filter((m) => m.includes('編集中なのでまだ'))).toHaveLength(2);
  });
});

describe('元の添付が見つからない保存(#1087)', () => {
  it('🔴 合言葉のノートが消えていたら、そう言う(「取り込みました」だけにしない)', async () => {
    const h = harness({ readAttachment: async () => null });
    h.stage.put({ key: 'o1', name: '報告.docx', token: 'lid-gone' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(h.notices[0]).toBe(originGoneImportedNotice('報告.docx'));
    expect(h.notices[0]).toContain('元の添付が見つからなかったので、新しい添付のノートとして取り込みました');
    expect(h.opened).toEqual(['new-lid']);
  });

  it('対照群: 合言葉の無い新規は、いつもの一言のまま', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '無題 1.odt' });
    await h.sb.receive('o1');
    expect(h.notices[0]).toBe('Office で保存した内容を取り込みました: 「無題 1.odt」');
  });

  it('対照群: 差し替えられたときも、いつもの一言', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '報告.docx', token: 'lid-7' });
    await h.sb.receive('o1');
    expect(h.notices[0]).toBe('Office で保存した内容を取り込みました: 「報告.docx」');
    expect(h.opened, '差し替えには「開く」を付けない').toEqual([]);
  });
});

/**
 * 🔴 **預かった古い保存を、別の窓の保存が来ても黙って捨てない**(O-7)。
 *
 * ⚠ 窓を開き直す(= 別の窓の session)と、窓はノートの**古い版**から始まる ── 預かってある保存を取り込まないまま開くと、
 *   次の保存は預かった編集を含まない。同じ合言葉だからと古い側を捨てると、預かった編集がどこにも残らない。
 *   (同じ session なら新しい側が古い側を含む ── 上の「古い保存を新しい保存の後に書かない」の describe が守る。)
 * 🔑 観測点は**書かれた bytes の順**と**棚の残り** ── 「捨てなかった」だけでは、古い bytes が新しい版を上書きしても緑になる。
 */
describe('別の窓の session の古い保存は、先に取り込む(O-7)', () => {
  const K1 = new Uint8Array([1, 1, 1]);
  const K2 = new Uint8Array([2, 2, 2]);

  function writer(over: Partial<SaveBackDeps> = {}) {
    const written: number[][] = [];
    // ⚠ 拒むのは**古い側(K1)の bytes のときだけ** ── 両方を拒むと、新しい側が書かれなくても同じ結果になり、順番の門が見えない
    let failingOld = false;
    const h = harness({
      replaceAsset: async (_lid, _save, bytes) => {
        if (failingOld && bytes[0] === 1) return false;
        written.push([...bytes]);
        return true;
      },
      ...over,
    });
    return { h, written, setFailing: (v: boolean) => { failingOld = v; } };
  }

  it('🔴 預かった K1(窓 A)があるうちに K2(窓 B)が来ても、K1 を捨てずに K1 → K2 の順で取り込む', async () => {
    let busy = true;
    const { h, written } = writer({ canWrite: () => !busy, canCreate: () => !busy });
    h.stage.put({ key: 's1', token: 'lid-7', at: 1, win: 'win-A' }, K1);
    expect(await h.sb.receive('s1')).toBe('deferred');
    // 窓を開き直した(K1 を取り込まないまま)→ 古い版から始まった窓が K2 を保存した
    h.stage.put({ key: 's2', token: 'lid-7', at: 2, win: 'win-B' }, K2);
    busy = false;
    expect(await h.sb.receive('s2')).toBe('replaced');
    expect(written, '預かった K1 が取り込まれずに消えた / 順番が逆').toEqual([[1, 1, 1], [2, 2, 2]]);
    expect(h.stage.keys(), '取り込んだのに棚に残っている').toEqual([]);
  });

  it('🔴 再起動の後(預かった記録が空)でも、別の session の古い保存を drainAll が捨てない', async () => {
    const { h, written } = writer();
    h.stage.put({ key: 's1', token: 'lid-7', at: 1, win: 'win-A' }, K1);
    h.stage.put({ key: 's2', token: 'lid-7', at: 2, win: 'win-B' }, K2);
    await h.sb.drainAll();
    expect(written).toEqual([[1, 1, 1], [2, 2, 2]]);
  });

  it('🔴 古い側が取り込めないあいだは、新しい側も預かる(新しい版を先に書いて、古い版に上書きされない)', async () => {
    const { h, written, setFailing } = writer();
    setFailing(true);
    h.stage.put({ key: 's1', token: 'lid-7', at: 1, win: 'win-A' }, K1);
    expect(await h.sb.receive('s1')).toBe('deferred');
    h.stage.put({ key: 's2', token: 'lid-7', at: 2, win: 'win-B' }, K2);
    expect(await h.sb.receive('s2'), '古い側が残っているのに新しい側を書いた').toBe('deferred');
    expect(written).toEqual([]);
    expect(h.stage.keys().filter((k) => k.endsWith('.json')).sort()).toEqual(['s1.json', 's2.json']);
    setFailing(false);
    expect(await h.sb.retryDeferred()).toBe(2);
    expect(written).toEqual([[1, 1, 1], [2, 2, 2]]);
  });

  it('対照群: 同じ session の古い保存は、新しい側が含むので捨てる(従来どおり)', async () => {
    const { h, written } = writer();
    h.stage.put({ key: 's1', token: 'lid-7', at: 1, win: 'win-A' }, K1);
    h.stage.put({ key: 's2', token: 'lid-7', at: 2, win: 'win-A' }, K2);
    await h.sb.drainAll();
    expect(written).toEqual([[2, 2, 2]]);
  });

  it('対照群: 窓の id が分からない古い meta は、捨てる側へ倒さない', async () => {
    const { h, written } = writer();
    h.stage.put({ key: 's1', token: 'lid-7', at: 1, omitWin: true }, K1);
    h.stage.put({ key: 's2', token: 'lid-7', at: 2, omitWin: true }, K2);
    await h.sb.drainAll();
    expect(written, '同じ session と確かめられない古い側を捨てた').toEqual([[1, 1, 1], [2, 2, 2]]);
  });
});

describe('adoptFor ── 窓を開く前に、そのノートの預かりを取り込む(O-7)', () => {
  it('🔴 その合言葉の保存だけを取り込み、取り込めたら true', async () => {
    const h = harness();
    h.stage.put({ key: 'a', token: 'lid-7', at: 1 });
    h.stage.put({ key: 'b', token: 'lid-8', at: 2, path: '/work/other.odt' });
    expect(await h.sb.adoptFor('lid-7')).toBe(true);
    expect(h.replaced).toEqual(['lid-7']);
    expect(h.stage.keys().filter((k) => k.endsWith('.json')), '別のノートの保存まで取り込んだ').toEqual(['b.json']);
  });

  it('まだ入れられない(編集中)/ 預かりが無い / 合言葉が空 は false。預かりは残る', async () => {
    const h = harness({ canWrite: () => false, canCreate: () => false });
    h.stage.put({ key: 'a', token: 'lid-7', at: 1 });
    expect(await h.sb.adoptFor('lid-7')).toBe(false);
    expect(h.stage.keys().filter((k) => k.endsWith('.json'))).toEqual(['a.json']);
    expect(await h.sb.adoptFor('lid-none')).toBe(false);
    expect(await h.sb.adoptFor('')).toBe(false);
  });

  it('holder でないタブでは何もしない', async () => {
    const h = harness({ isHolder: () => false });
    h.stage.put({ key: 'a', token: 'lid-7', at: 1 });
    expect(await h.sb.adoptFor('lid-7')).toBe(false);
    expect(h.replaced).toEqual([]);
  });
});

/**
 * 🔴 **取り込みの結果を、窓を開いたタブへも運ぶ**(O-8)。
 * ⚠ 引き取るのは writer のタブ 1 つ。窓を開いたのが follower だと、「取り込みました / まだ入れていません / 失敗」を見られない。
 * 🔑 観測点は、運ばれた**字そのもの**が、引き取ったタブで出した字と同じであること(別の字を作らない)。
 */
describe('結果を窓を開いたタブへ運ぶ(O-8)', () => {
  it('🔴 差し替えた結果が、合言葉つきで運ばれる(出した字と同じ)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', token: 'lid-7', name: '報告.docx' });
    await h.sb.receive('o1');
    expect(h.relayed).toEqual([{ token: 'lid-7', kind: 'notice', text: h.notices[0] }]);
  });

  it('🔴 新しいノートにしたとき、「開く」の行き先ごと運ぶ', async () => {
    const h = harness({ readAttachment: async () => null });
    h.stage.put({ key: 'o1', token: 'lid-gone', name: '報告.docx' });
    await h.sb.receive('o1');
    expect(h.relayed).toHaveLength(1);
    expect(h.relayed[0]).toMatchObject({ token: 'lid-gone', kind: 'notice', openLid: 'new-lid', text: h.notices[0] });
  });

  it('🔴 預かった一言と、失敗(元のファイルへ書けない)も運ぶ', async () => {
    const hold = harness({ canWrite: () => false, canCreate: () => false });
    hold.stage.put({ key: 'o1', token: 'lid-7', name: '報告.docx' });
    await hold.sb.receive('o1');
    expect(hold.relayed).toEqual([{ token: 'lid-7', kind: 'notice', text: hold.notices[0] }]);

    const fail = harness({ writeLocal: async () => 'denied' });
    fail.stage.put({ key: 'o2', token: 'local:1', name: 'a.docx' });
    await fail.sb.receive('o2');
    expect(fail.relayed).toEqual([{ token: 'local:1', kind: 'fail', text: fail.fails[0] }]);
  });

  it('同じ一言は撃ち直しのたびに運ばない(預かった一言は 1 度だけ)', async () => {
    const h = harness({ canWrite: () => false, canCreate: () => false });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    await h.sb.receive('o1');
    await h.sb.retryDeferred();
    await h.sb.retryDeferred();
    expect(h.relayed).toHaveLength(1);
  });

  it('合言葉の無い保存(窓の中で新規に作った文書)は運ばない ── 頼んだタブが居ない', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', name: '無題 1.odt' }); // token 無し
    await h.sb.receive('o1');
    expect(h.notices).toHaveLength(1);
    expect(h.relayed).toEqual([]);
  });

  it('運ぶのが落ちても、取り込みは成立して棚から消える', async () => {
    const h = harness({ relay: () => { throw new Error('closed'); } });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('replaced');
    expect(h.stage.keys()).toEqual([]);
  });
});

/**
 * 🔴 **例外で落ちた保存も、あとで取り込み直す**(O-9)。
 * ⚠ 容量の拒否などで `takeOne` が投げると、撃ち直しの旗が立たず**次の起動まで眠っていた**。しかも一言は「取り込めませんでした」
 *   だけで、user は「失敗して無くなった」と読む。
 */
describe('例外で落ちた保存(O-9)', () => {
  it('🔴 あとで撃ち直され、取り込める。一言は「あとで取り込み直す」と言う', async () => {
    let boom = true;
    const h = harness({
      createNote: async (save) => {
        if (boom) throw new Error('QuotaExceededError');
        h.created.push(save.name);
        return 'new-lid';
      },
    });
    h.stage.put({ key: 'o1', name: 'a.odt' });
    expect(await h.sb.receive('o1')).toBe('failed');
    expect(h.stage.keys().length, '落ちたのに棚から消えた').toBeGreaterThan(0);
    expect(h.fails).toHaveLength(1);
    expect(h.fails[0]).toContain('QuotaExceededError');
    expect(h.fails[0], 'あとで取り込み直すと言っていない').toContain('あとで取り込み直します');
    boom = false;
    expect(await h.sb.retryDeferred(), '例外で落ちた保存が撃ち直されない').toBe(1);
    expect(h.created).toEqual(['a.odt']);
    expect(h.stage.keys()).toEqual([]);
  });

  it('撃ち直しでまた落ちても、同じ赤い字を何度も出さない', async () => {
    const h = harness({ createNote: async () => { throw new Error('QuotaExceededError'); } });
    h.stage.put({ key: 'o1', name: 'a.odt' });
    await h.sb.receive('o1');
    await h.sb.retryDeferred();
    await h.sb.retryDeferred();
    expect(h.fails).toHaveLength(1);
  });

  it('一言は窓を開いたタブへも運ぶ(合言葉があるとき)', async () => {
    const h = harness({ replaceAsset: async () => { throw new Error('QuotaExceededError'); } });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    await h.sb.receive('o1');
    expect(h.relayed).toEqual([{ token: 'lid-7', kind: 'fail', text: h.fails[0] }]);
  });
});

/**
 * 🔴 **預かる理由は、画面の状態で言い分ける**(O-10)。
 * ⚠ `canWrite` が偽なのは編集中だけではない。保存に失敗して止まっているとき「編集中なので」と言うと、
 *   編集を終えようとしても入らず、出口(ノートを保存し直す)も案内されない。
 */
describe('預かった理由の言い分け(O-10)', () => {
  const held = (phase: 'editing' | 'error' | 'initializing' | 'ready') => async (): Promise<string> => {
    const h = harness({ canWrite: () => false, canCreate: () => false, phase: () => phase });
    h.stage.put({ key: 'o1', token: 'lid-7', name: '報告.docx' });
    await h.sb.receive('o1');
    return h.notices[0]!;
  };

  it('🔴 編集中は従来どおり', async () => {
    const m = await held('editing')();
    expect(m).toBe('Office で保存した「報告.docx」は、編集中なのでまだ入れていません。編集を終えると入れます');
  });

  it('🔴 保存に失敗して止まっているときは、編集中と言わず、押すボタンを言う', async () => {
    const m = await held('error')();
    expect(m).not.toContain('編集中');
    expect(m).toContain('ノートの保存に失敗している');
    expect(m).toContain('「ノートを保存し直す」');
  });

  it('🔴 読み込み中は、読み込みが終わると入れると言う', async () => {
    const m = await held('initializing')();
    expect(m).not.toContain('編集中');
    expect(m).toContain('読み込み中');
    expect(m).toContain('読み込みが終わると入れます');
  });

  it('言い分けた字が、運ぶ字と同じ(follower でも同じ理由が見える)', async () => {
    const h = harness({ canWrite: () => false, canCreate: () => false, phase: () => 'error' });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    await h.sb.receive('o1');
    expect(h.relayed[0]!.text).toBe(h.notices[0]);
  });
});

/**
 * 🔴 **同じファイルを指す添付がほかにもあるとき、差し替える前に確かめる**(#1163 依頼 211・293)。
 *
 * 中身が同じファイルは 1 つにまとめて持っているので、差し替えると、そのファイルを指しているほかのノートのリンクも
 * 新しい版になる。確かめの答えが「やめる」なら、**差し替えず、保存した内容は別の添付のノートとして残す**
 * (編集した内容は失わない / リンクは変わらない)。
 */
describe('🔴 共有の確かめ(差し替える前)', () => {
  it('「別の添付として保存」を選ぶと、差し替えずに新しい添付のノートになる。棚から消え、そう言う', async () => {
    const asked: string[] = [];
    const h = harness({
      confirmShared: async (lid) => {
        asked.push(lid);
        return 'separate';
      },
    });
    h.stage.put({ key: 'o1', token: 'lid-7', name: '契約書.docx' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(asked, '差し替え先を確かめていない').toEqual(['lid-7']);
    expect(h.replaced, '「別の添付」を選んだのに差し替えた').toEqual([]);
    expect(h.created).toEqual(['契約書.docx']);
    expect(h.stage.keys(), '保存した内容が棚に残っている').toEqual([]);
    expect(h.notices[0]).toBe(sharedSeparateImportedNotice('契約書.docx'));
    expect(h.notices[0], '「元の添付が見つからなかった」と言っていない').not.toContain('見つからなかった');
    expect(h.adopted, '窓へ新しいノートを返していない(次の保存で増える)').toEqual(['o1=new-lid']);
  });

  it('対照: 「新しい版にする」なら、今までどおり差し替える', async () => {
    const h = harness({ confirmShared: async () => 'replace' });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('replaced');
    expect(h.replaced).toEqual(['lid-7']);
    expect(h.created).toEqual([]);
  });

  it('合言葉が無い新規の保存では確かめない(差し替えではない)', async () => {
    let asked = 0;
    const h = harness({
      confirmShared: async () => {
        asked += 1;
        return 'separate';
      },
    });
    h.stage.put({ key: 'o1', name: '無題 1.odt' });
    expect(await h.sb.receive('o1')).toBe('created');
    expect(asked).toBe(0);
  });

  it('編集中は確かめる前に預かる(確かめの画面で書きかけを邪魔しない)', async () => {
    let asked = 0;
    const h = harness({
      canWrite: () => false,
      canCreate: () => true,
      confirmShared: async () => {
        asked += 1;
        return 'replace';
      },
    });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(asked).toBe(0);
    expect(h.stage.keys().sort(), '預かったのに棚から消えた').toEqual(['o1.bin', 'o1.json']);
  });

  it('確かめの文: 数を入れ、リンクが無ければ「古い版のまま」と言う / 別の添付の逃げ道は出せるときだけ', () => {
    const withLinks = sharedReplaceQuestion('契約書.pdf', 1, 3, true);
    expect(withLinks).toContain('ほかに 1 件');
    expect(withLinks).toContain('リンク 3 か所も新しい版になります');
    expect(withLinks).toContain('別の添付として保存すると、リンクは変わりません');
    const noLinks = sharedReplaceQuestion('契約書.pdf', 2, 0, false);
    expect(noLinks).toContain('ほかの添付のノート自身は古い版のままです');
    expect(noLinks, 'やめる側が無いのに、別の添付の案内が出た').not.toContain('別の添付として保存');
  });
});

/**
 * 🔴 依頼 368(台帳 #1852 束 M1):別のタブがそのノートを編集中のとき、Office の保存は添付を書き換えない。
 * 直す前は自分のタブの編集中(`canWrite`)しか見なかったので、そのタブが後で保存すると添付の参照が古いほうに戻ることがあった。
 */
describe('別のタブが編集中のノートへは差し替えない(依頼 368)', () => {
  it('編集中なら棚に残して預かり、差し替えない。編集が終わって撃ち直したら入る(対照群:終わらなければ入らない)', async () => {
    let elsewhere = true;
    const h = harness({ editedElsewhere: async () => elsewhere });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(h.replaced, '別のタブが編集中なのに差し替えた').toEqual([]);
    expect(h.created, '差し替えを断ったのに新しいノートを作った').toEqual([]);
    expect(h.stage.keys(), '預かるはずの保存が棚から消えた(文書が消える)').not.toEqual([]);
    // 言い分け:自分のタブの編集中(savedHeldNotice)とは別の字で、別のタブと言う
    expect(h.notices).toEqual([savedHeldElsewhereNotice('x.odt')]);
    expect(h.notices[0]).toContain('別のタブまたはウィンドウで編集中');
    expect(h.notices[0]).not.toBe(savedHeldNotice('x.odt'));
    // まだ編集中のまま撃ち直しても入らない。同じ字を繰り返さない
    expect(await h.sb.retryDeferred()).toBe(0);
    expect(h.replaced).toEqual([]);
    expect(h.notices, '撃ち直しのたびに同じ字を出している').toHaveLength(1);
    // 編集が終わった
    elsewhere = false;
    expect(await h.sb.retryDeferred()).toBe(1);
    expect(h.replaced).toEqual(['lid-7']);
    expect(h.stage.keys()).toEqual([]);
  });

  it('対照群:別のタブが編集していなければ、これまでどおり差し替える。問い合わせるノートは差し替え先の lid', async () => {
    const asked: string[] = [];
    const h = harness({ editedElsewhere: async (lid) => (asked.push(lid), false) });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('replaced');
    expect(asked).toEqual(['lid-7']);
    expect(h.replaced).toEqual(['lid-7']);
  });

  it('main.ts の配線(原文 pin ── 弱いと自覚して使う):追記などと同じ問い合わせ(editedElsewhereReason)を通り、預かったら撃ち直しの時計を張る', () => {
    const main = readFileSync('src/main.ts', 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const i = main.indexOf('createOfficeSaveBack({');
    expect(i, 'createOfficeSaveBack の配線を引けていない').toBeGreaterThan(0);
    const wiring = main.slice(i, i + 4000);
    expect(wiring).toMatch(/editedElsewhere: async \(lid\) => \{/);
    expect(wiring).toContain('editedElsewhereReason(dispatcher, editLockPort, lid)');
    expect(wiring).toMatch(/window\.setTimeout\(\(\) => void officeSaveBack\.retryDeferred\(\)/);
  });

  it('聞く(同じファイルを指す添付の確かめ)より前に断る / 新しい添付のノートを足すだけの回は問い合わせない', async () => {
    let confirmAsked = 0;
    const asked: string[] = [];
    const h = harness({
      editedElsewhere: async (lid) => (asked.push(lid), true),
      confirmShared: async () => (confirmAsked++, 'replace'),
    });
    h.stage.put({ key: 'o1', token: 'lid-7' });
    await h.sb.receive('o1');
    expect(confirmAsked, '断る前に user へ聞いた').toBe(0);
    // 合言葉が無い(新規)なら、どのノートも書き換えないので問い合わせない
    const h2 = harness({ editedElsewhere: async () => (asked.push('new'), true) });
    asked.length = 0;
    h2.stage.put({ key: 'o2', name: '新規.odt' });
    expect(await h2.sb.receive('o2')).toBe('created');
    expect(asked, '書き換えない回まで問い合わせた').toEqual([]);
  });
});
