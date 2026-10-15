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
  LOCAL_SAVE_ORPHAN_NOTICE,
  SAME_DOC_MAX,
  stagedSavedAt,
  type SaveBackDeps,
} from '@adapter/platform/office/office-save-back';
import type { StageDir, StagedSave } from '@adapter/platform/office/office-stage';
import { isShadowNewer } from '@features/office/office-shadow';
import { sanitizeMessageText } from '@features/message/message-log';

interface FakeStage {
  dir: StageDir;
  keys(): string[];
  put(save: Partial<StagedSave> & { key: string }, bytes?: Uint8Array): void;
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
        ...(save.win !== undefined ? { win: save.win } : { win: 'win-1' }),
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
  sb: ReturnType<typeof createOfficeSaveBack>;
} {
  const stage = fakeStage();
  const created: string[] = [];
  const replaced: string[] = [];
  const adopted: string[] = [];
  const notices: string[] = [];
  const fails: string[] = [];
  const deps: SaveBackDeps = {
    stage: async () => stage.dir,
    isHolder: () => true,
    canWrite: () => true,
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
    adopt: (key, lid) => adopted.push(`${key}=${lid}`),
    notify: (m) => notices.push(m),
    fail: (m) => fails.push(m),
    ...over,
  };
  return {
    stage, deps, created, replaced, adopted, notices, fails,
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
    expect(h.notices, '取り込んでいないのに「取り込みました」と言った').toEqual([]);
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
    expect(body, '控えを渡していない').toContain('provideDocument(staged.name, staged.bytes, staged.token)');
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

  it('🔴 古い保存を誰も書けないときは、1 度だけ言って棚に残す', async () => {
    const h = harness({ knowsLocal: () => false });
    h.stage.put({ key: 'k1', token: 'local:s-1', at: Date.now() - LOCAL_ORPHAN_GRACE_MS - 1000 });
    await h.sb.receive('k1');
    await h.sb.receive('k1');
    expect(h.fails).toEqual([LOCAL_SAVE_ORPHAN_NOTICE]);
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
    expect(main).toContain('savedAt: stagedSavedAt(save.at)');
  });
});
