/**
 * 🔴 **Office の窓で保存されたものを、PKC のノートにする**(#205 段 B〜D)。
 *
 * 🔑 **`main.ts` に書かない。** あそこは原文を `readFileSync` で読む test しか無く、
 * 判断を置くと「全 tests 緑のまま取り違える」(CLAUDE.md 2026-08-08)。
 * `office-open.ts` が同じ理由で取り出されている ── その前例に揃える。
 *
 * ## 経路(窓 → 棚 → ここ)
 *
 * ```
 * [別窓] LO が保存 → FS hook が拾う → OPFS の棚へ bytes を置く → 鍵だけ放送
 * [本体] ここ ── 鍵を受ける → 棚から読む → ノートにする → 棚から捨てる
 * ```
 *
 * ## 🔴 守る 4 つ
 *
 * 1. **引き取るのは writer リースを持つタブだけ。** 放送は全タブに届くが、
 *    sqlite の `assets` 行を書けるのは 1 タブだけである(`writer-lease.ts`)。
 *    ⚠ 門を置かないと、フォロワーのタブが同じ保存を二重に取り込む
 * 2. **捨てるのは、ノートになったのを見届けてから。** at-least-once ──
 *    先に捨てると、落ちたときに **user の文書が消える**(`office-stage.ts` の表)
 * 3. 🔴 **編集中は取り込まない。捨てもしない。** `CREATE_ENTRY` も
 *    `OFFICE_ASSET_SAVED` も reducer が `phase !== 'ready'` を**黙って捨てる** ──
 *    取り込めたことにして棚から消すと、そこで文書が消える。
 *    ⚠ だから `deferred` を立て、`retryDeferred()` で撃ち直す
 * 4. **取りこぼしは遅延にしかならない。** 入口は 3 つ ── ①鍵の放送
 *    ②起動時(`drainAll`)③編集が終わったとき(`retryDeferred`)。
 *    どれも同じ `takeOne` を通るので、二重取りは棚の有無で自然に止まる
 */
import {
  discardStaged,
  listStaged,
  readStaged,
  sweepStagedOrphans,
  type StageDir,
  type StagedSave,
} from './office-stage';

/** 取り込んだ結果。⚠ `'deferred'` は**棚に残っている**(あとで撃ち直す)。 */
export type IntakeResult = 'created' | 'replaced' | 'deferred' | 'failed';

export interface SaveBackDeps {
  /** 棚。⚠ OPFS が無い環境では `null` を返す(そこでは書き戻しが効かないだけ)。 */
  readonly stage: () => Promise<StageDir | null>;
  /**
   * 🔴 **このタブが writer リースを持っているか。**
   * ⚠ 昇格で変わるので**呼ぶたびに読む**(値を closure に固定しない)。
   */
  readonly isHolder: () => boolean;
  /** いま取り込めるか(`phase === 'ready'`)。⚠ 偽なら**棚に残す**。 */
  readonly canWrite: () => boolean;
  /**
   * 合言葉のノートが**いまも添付か**を確かめる。
   * `null` = 消えた / 添付でなくなった → **新規の添付ノート**として取り込む。
   */
  readonly readAttachment: (lid: string) => Promise<{ assetKey: string } | null>;
  /** 新しい添付ノートを作る。⚠ 作れなかったら `null`(= まだ書けない)。 */
  readonly createNote: (save: StagedSave, bytes: Uint8Array<ArrayBuffer>) => Promise<string | null>;
  /** 既存の添付を差し替える。⚠ 撃てなかったら `false`(= まだ書けない)。 */
  readonly replaceAsset: (
    lid: string,
    save: StagedSave,
    bytes: Uint8Array<ArrayBuffer>,
  ) => Promise<boolean>;
  /** user への一言(「取り込みました」)。 */
  readonly notify: (message: string) => void;
  /** 異常の報告(取り込めなかった)。 */
  readonly fail: (message: string) => void;
}

export interface OfficeSaveBack {
  /** 鍵の放送を受けた。 */
  receive(key: string): Promise<IntakeResult | null>;
  /** 棚に残っているものを全部取り込む(起動時 / 窓が閉じた時)。 */
  drainAll(): Promise<number>;
  /** 編集が終わった等で、**保留したものだけ**撃ち直す。⚠ 保留が無ければ何もしない。 */
  retryDeferred(): Promise<number>;
  /** 窓が「渡せなかった」と言ってきた。 */
  reportWindowFailure(reason: string): void;
}

export function createOfficeSaveBack(deps: SaveBackDeps): OfficeSaveBack {
  /** いま処理中の鍵。⚠ 放送と起動時 sweep が重なると同じ鍵を 2 回引く。 */
  const inFlight = new Set<string>();
  /** 🔴 編集中で取り込めなかった ── **これが立っている間だけ**撃ち直す。 */
  let deferred = false;

  async function takeOne(dir: StageDir, save: StagedSave): Promise<IntakeResult> {
    const bytes = await readStaged(dir, save);
    if (bytes === null) {
      // 大きさが meta と食い違う = 書きかけのまま `.json` が置かれた(壊れている)。
      // ⚠ 残しても永久に直らないので捨てる ── ただし**黙らない**
      await discardStaged(dir, save.key);
      deps.fail(`Office の保存を取り込めませんでした(${save.name}: 中身が壊れています)`);
      return 'failed';
    }
    // ⚠ **`ready` を先に見る。** 見ないと reducer に黙って捨てられ、
    //    「取り込んだ」ことにして棚から消す = 文書が消える
    if (!deps.canWrite()) {
      deferred = true;
      return 'deferred';
    }

    // 合言葉があれば差し替え、無ければ新規(#205 §2 の 2 行そのもの)。
    // ⚠ **合言葉のノートが消えていたら新規へ倒す** ── 存在しない lid へ書くより、
    //    新しい添付ノートで残すほうが user の文書が残る
    const token = save.token;
    const target = token === undefined ? null : await deps.readAttachment(token);
    if (token !== undefined && target !== null) {
      const ok = await deps.replaceAsset(token, save, bytes);
      if (!ok) {
        deferred = true;
        return 'deferred';
      }
      await discardStaged(dir, save.key);
      deps.notify(`Office の保存を取り込みました: ${save.name}`);
      return 'replaced';
    }
    const lid = await deps.createNote(save, bytes);
    if (lid === null) {
      deferred = true;
      return 'deferred';
    }
    await discardStaged(dir, save.key);
    deps.notify(`Office の保存を取り込みました: ${save.name}`);
    return 'created';
  }

  async function run(pick: (all: StagedSave[]) => StagedSave[]): Promise<IntakeResult[]> {
    // 🔴 **holder だけ**(放送は全タブに届く)
    if (!deps.isHolder()) return [];
    const dir = await deps.stage();
    if (dir === null) return [];
    const all = await listStaged(dir);
    const out: IntakeResult[] = [];
    for (const save of pick(all)) {
      if (inFlight.has(save.key)) continue;
      inFlight.add(save.key);
      try {
        out.push(await takeOne(dir, save));
      } catch (e) {
        deps.fail(`Office の保存を取り込めませんでした(${save.name}): ${String(e)}`);
        out.push('failed');
      } finally {
        inFlight.delete(save.key);
      }
    }
    return out;
  }

  return {
    async receive(key) {
      const got = await run((all) => all.filter((s) => s.key === key));
      // ⚠ 空 = **holder でない / 既に誰かが引き取った**。どちらも異常ではない
      return got[0] ?? null;
    },

    async drainAll() {
      // 🔴 **先に書きかけの残骸を掃除する**(B5)。⚠ 揃っているものは消さない
      if (deps.isHolder()) {
        const dir = await deps.stage();
        if (dir !== null) await sweepStagedOrphans(dir).catch(() => 0);
      }
      const got = await run((all) => all);
      return got.filter((r) => r === 'created' || r === 'replaced').length;
    },

    async retryDeferred() {
      if (!deferred) return 0;
      // ⚠ **先に下ろす。** 下ろさないと、また保留になったとき立て直せない…
      //    のではなく、**成功しても立ったまま**になり毎回舐めることになる
      deferred = false;
      const got = await run((all) => all);
      return got.filter((r) => r === 'created' || r === 'replaced').length;
    },

    reportWindowFailure(reason) {
      deps.fail(`Office の保存を PKC へ渡せませんでした: ${reason}`);
    },
  };
}
