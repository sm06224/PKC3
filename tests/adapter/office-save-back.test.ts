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
import { readFileSync } from 'node:fs';
import {
  createOfficeSaveBack,
  SAME_DOC_MAX,
  type SaveBackDeps,
} from '@adapter/platform/office/office-save-back';
import type { StageDir, StagedSave } from '@adapter/platform/office/office-stage';

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
    h.stage.put({ key: 'o1', name: 'x.odt', path: '/work/x.odt' });
    h.stage.put({ key: 'o2', name: 'x.odt', path: '/work/x.odt' });
    expect(await h.sb.drainAll()).toBe(2);
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
    h.stage.put({ key: 'o1', name: '無題 1.odt', path: '/home/web_user/無題 1.odt' });
    h.stage.put({ key: 'o2', name: '無題 1.odt', path: '/home/web_user/無題 1.odt' });
    expect(await h.sb.receive('o1')).toBe('deferred');
    expect(await h.sb.receive('o2')).toBe('deferred');
    expect(h.created, '編集中なのに作った').toEqual([]);

    ready = true;
    expect(await h.sb.retryDeferred()).toBe(2);
    expect(h.created, '同じ文書なのにノートを 2 件作った').toEqual(['無題 1.odt']);
    expect(h.replaced, '2 件目は差し替えのはず').toEqual(['new-lid']);
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
    h.stage.put({ key: 'o1', name: 'x.odt', path: '/work/x.odt', token: 'lid-gone' });
    h.stage.put({ key: 'o2', name: 'x.odt', path: '/work/x.odt', token: 'lid-gone' });
    expect(await h.sb.drainAll()).toBe(2);
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
    h.stage.put({ key: 'o1', name: '無題 1.odt', path: '/work/無題 1.odt' });
    h.stage.put({ key: 'o2', name: '無題 1.odt', path: '/work/無題 1.odt' });
    const a = h.sb.receive('o1');
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

  it('🔴 boot で取れたときと、昇格したときの**両方**で真になる', () => {
    // ⚠ 片方だけだと、もう片方の経路で保存が永久に届かない
    const assigns = code.match(/writerHolder = true;/g) ?? [];
    expect(assigns.length, 'writerHolder を真にする場所が 2 つ無い(boot / 昇格)').toBe(2);
    // 昇格の分岐の中に在ることまで見る(どこかに 2 個ある、では足りない)
    const promoted = code.slice(code.indexOf('if (promotedHost) {'));
    expect(
      promoted.slice(0, promoted.indexOf('}')),
      '昇格の分岐で holder になっていない',
    ).toContain('writerHolder = true;');
  });
});
