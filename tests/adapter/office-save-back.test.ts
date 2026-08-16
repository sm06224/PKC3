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
        path: save.path ?? '/work/x.odt',
        size: save.size ?? bytes.length,
        at: save.at ?? 1,
        ...(save.token !== undefined ? { token: save.token } : {}),
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

  it('差し替えたときは返さない(窓の合言葉は既に正しい)', async () => {
    const h = harness();
    h.stage.put({ key: 'o1', token: 'lid-7' });
    expect(await h.sb.receive('o1')).toBe('replaced');
    expect(h.adopted).toEqual([]);
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
