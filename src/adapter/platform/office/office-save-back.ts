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

/**
 * 「同じ文書」の表に置く上限(#220-1)。
 *
 * 🔑 **窓側の `KEY_MEMORY_MAX` と同じ数**にする(`public/office/office-save-watch.js`)。
 * 揃えるのは見栄えではなく、**両側が同じ寿命で忘れる**ようにするためである ──
 * 片方だけ覚えていると「窓は忘れたのに本体は束ねる / その逆」が起きる。
 * ⚠ 数は `tests/adapter/office-save-back.test.ts` の parity test が突き合わせる。
 */
export const SAME_DOC_MAX = 64;

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
  /**
   * 🔴 **「この保存はこのノートになった」と窓へ返す**(#217)。
   *
   * ⚠ 返さないと、**同じ文書を 2 回保存するとノートが 2 件できる**(cowork 実機
   * 2026-08-16 で 1/1 再現)── 窓が持っている合言葉は「PKC から渡した添付」の
   * 分だけなので、**窓の中で新規に作った文書**は 2 回目も合言葉が無いままになる。
   *
   * 🔑 呼ぶのは **窓が合言葉を知らなかった保存**のときだけ ── 新規に作った場合と、
   * **こちらで束ねて差し替えた場合**の両方である(`sameDoc`)。
   * ⚠ 「新規のときだけ」に狭めると**穴が残る**:編集中に 2 件溜まると
   * 1 件目=新規 / 2 件目=差し替えになり、**2 件目の鍵には返事が来ない**。
   * 窓が覚えている鍵には上限が在る(`office-save-watch.js` の `KEY_MEMORY_MAX`)ので、
   * 取りこぼしを「古い鍵が生きているはず」に頼らない。
   */
  readonly adopt: (key: string, lid: string) => void;
  /**
   * 🔴 **手元のファイルへ書き戻す**(#432 段②)。合言葉が「手元のファイル」の
   * 名前空間なら、PKC のノートではなく**元のファイル**が行き先である。
   *
   * @returns `null` = この保存は手元のファイルではない(いつもの取り込みへ) /
   *   `true` = 書き戻した / `false` = 書き戻せなかった(**user に伝える**)
   * ⚠ **optional にしない** ── 配線を落としても tsc が黙ると、
   *   「手元のファイルを直したのに PKC のノートが増える」という、
   *   user がいちばん気づきにくい形で壊れる(CLAUDE.md §7 の待ちの口と同じ理由)。
   */
  readonly writeLocal: (token: string, bytes: Uint8Array<ArrayBuffer>) => Promise<boolean | null>;
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

  /**
   * 窓へ「このノートになった」と返す。
   * ⚠ **投げさせない** ── ここで抜けると呼び元が棚を消さず、次の掃除で**もう 1 件
   * ノートができる**(この file が守っている物のちょうど逆向き)。
   */
  function announce(key: string, lid: string): void {
    try {
      deps.adopt(key, lid);
    } catch {
      // 返せなくても**取り込みは成功している**。棚は消してよい
    }
  }

  /**
   * 🔴 **「同じ文書」→ 作ったノート**の表(#217 の残り / #220-1)。
   *
   * ⚠ **1 回の引き取りの中だけ**では足りない(2026-08-17 に直した)。放送は
   * 鍵 1 件ごとに来る(`main.ts` の `receive(ev.key)`)ので、表を `run()` の
   * ローカルに置くと **放送経路では 1 度も効かない** ── 2 回目の Ctrl+S が
   * 1 回目の 0.7〜1.0 秒後に来て、本体の取り込みが数百 ms 掛かると窓の返事が
   * 間に合わず、**同じ文書のノートが 2 件**できる。
   *
   * ⚠ 初稿のコメントは「跨ぐと、窓が読み直されて同じ path に別の文書が居るときに
   * 取り違える」と書いていたが、**この理由は成り立たない** ── `win` は
   * `armSaveWatch` の中で `randomUUID` で作られ(`public/office/host.html`)、
   * 読み直しは `location.replace` / `location.reload` の**完全再読込**なので、
   * 読み直せば `win` が変わり、跨いだ項目は当たらない。
   * 🔑 残る本当の危険(**同じページのまま**同じ名前で別の文書を保存する)は、
   * 窓側の表(`office-save-watch.js` の `tokens`)が**同じ粒度**で持っているので、
   * こちらへ上げても露出は増えない。しかも `takeOne` は `readAttachment` で
   * 生死を確かめて死んでいれば新規へ倒す。
   */
  const madeHere = new Map<string, string>();
  /** 最近使った順に保ち、上限を超えたら**古いものから**落とす。 */
  function rememberHere(group: string, lid: string): void {
    madeHere.delete(group);
    madeHere.set(group, lid);
    while (madeHere.size > SAME_DOC_MAX) {
      const oldest = madeHere.keys().next().value;
      if (oldest === undefined) break;
      madeHere.delete(oldest);
    }
  }

  /**
   * 🔴 **引き取りは 1 本ずつ**(#220-1)。`main.ts` は `void officeSaveBack.receive(...)`
   * で撃つので、大きい文書で hash / 資産ゲートが詰まると **1 件目の `createNote` を
   * await している間に 2 件目が走る** ── そのとき表はまだ空なので、両方が新規を作る。
   * ⚠ `inFlight` は同じ**鍵**しか守らない(同じ**文書**の別の保存は別の鍵である)。
   * 🔑 下流(`withAssetGate`)は既に直列なので、待ち時間は実質増えない。
   */
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = chain.then(job, job);
    chain = next.catch(() => undefined);
    return next;
  }

  /**
   * 🔴 **「同じ文書」を指す鍵**(#217 の残り、着地前レビュー)。
   *
   * ⚠ 窓からの返事(`adopted`)は**往復**なので、返る前に次の保存が来ると間に合わない。
   * そして**それは編集中に確定的に起きる**:`canWrite()` が偽の間は棚に溜まるだけで
   * 返事を出さないので、編集を終えた瞬間に**合言葉の無い同じ文書が複数件**流れてくる。
   * 窓の表だけでは塞がらない ── **引き取る側にも同じ表が要る**。
   *
   * ⚠ 鍵は **`win` と `path` の対**である。path だけで束ねると、2 枚目の窓が同じ名前で
   * 保存したときに**別の文書どうしを 1 つのノートへ潰す**(`/work/報告.odt` は窓ごとに
   * 別の MEMFS に在る)。⚠ `win` を持たない古い meta は**束ねない**(安全側)。
   */
  function sameDoc(save: StagedSave): string | null {
    if (save.win === undefined || save.path === '') return null;
    // ⚠ 区切りは `|` ── 窓の id は 16 進 / base36 と `-` だけで `|` を含まないので、
    //    分かち書きが**曖昧にならない**。
    //    🔑 制御文字を区切りに使わない ── `tests/repo-hygiene.test.ts` が生バイトを止める。
    //    実際この行の初稿で編集ツールが U+0000 を生バイトで書き、そこで捕まった
    return `${save.win}|${save.path}`;
  }

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

    /**
     * 🔴 **手元のファイルから開いた回は、元のファイルへ戻す**(#432 段②)。
     *
     * ⚠ **PKC の合言葉を解く前**に見る ── 後ろに置くと `readAttachment` が
     *   `local:1` を lid として引きに行き、見つからないので**新しい添付ノートを作る**
     *   (= 手元のファイルを直したのにノートが増える、という user がいちばん
     *   気づきにくい壊れ方になる)。
     * ⚠ 書けなかったら**棚から捨てない** ── 捨てると user の編集が消える。
     *   残しておけば、次の起動でもう一度取り込みを試せる。
     */
    const local = save.token === undefined ? null : await deps.writeLocal(save.token, bytes);
    if (local !== null) {
      if (!local) {
        deps.fail(`元のファイルへ保存できませんでした(${save.name})`);
        deferred = true;
        return 'deferred';
      }
      await discardStaged(dir, save.key);
      deps.notify(`元のファイルへ保存しました: ${save.name}`);
      return 'replaced';
    }

    // 合言葉があれば差し替え、無ければ新規(#205 §2 の 2 行そのもの)。
    // ⚠ **合言葉のノートが消えていたら新規へ倒す** ── 存在しない lid へ書くより、
    //    新しい添付ノートで残すほうが user の文書が残る
    // ⚠ 合言葉が無くても、**既に同じ文書のノートを作っていたら**それを使う
    //    (窓の返事が間に合わない経路 ── 上の `madeHere` の注記)
    const group = sameDoc(save);
    // 🔴 **窓が知っていたか。** 知らなかった保存は、取り込み先を**必ず返す**
    //    ── 新規でも差し替えでも同じ(`adopt` の注記)
    const windowKnew = save.token !== undefined;
    const mine = group === null ? undefined : madeHere.get(group);
    let token = save.token ?? mine;
    let target = token === undefined ? null : await deps.readAttachment(token);
    // ⚠ **合言葉が「在るが死んでいる」ときも束ねへ倒す**(2 巡目レビュー)。
    //    倒さないと、開いていた添付を user が消した状態で編集中に 2 件溜まった場合、
    //    1 件目=新規 / 2 件目も**新規**になり、ここでもノートが 2 件できる
    if (target === null && mine !== undefined && mine !== token) {
      token = mine;
      target = await deps.readAttachment(mine);
    }
    if (token !== undefined && target !== null) {
      const ok = await deps.replaceAsset(token, save, bytes);
      if (!ok) {
        deferred = true;
        return 'deferred';
      }
      if (!windowKnew) announce(save.key, token);
      await discardStaged(dir, save.key);
      deps.notify(`Office の保存を取り込みました: ${save.name}`);
      return 'replaced';
    }
    const lid = await deps.createNote(save, bytes);
    if (lid === null) {
      deferred = true;
      return 'deferred';
    }
    // ⚠ **次の保存に効かせる。** 窓の返事を待つ経路とは別に、いま作ったノートを
    //    同じ文書の次の 1 件へ渡す(放送 1 件ごとの `receive` / 編集明けの一括、両方)
    if (group !== null) rememberHere(group, lid);
    // 🔴 **窓へも返す**(#217)。⚠ 返し忘れると次の**別の**引き取りでまた新規になる。
    //    ⚠ 窓が既に閉じていても放送は投げるだけ ── 誰も聞かなくても害は無い
    announce(save.key, lid);
    await discardStaged(dir, save.key);
    deps.notify(`Office の保存を取り込みました: ${save.name}`);
    return 'created';
  }

  function run(pick: (all: StagedSave[]) => StagedSave[]): Promise<IntakeResult[]> {
    // 🔴 **1 本ずつ**(上の `serial` の注記)── 並行に走ると、表がまだ空のまま
    //    同じ文書のノートを 2 件作る
    return serial(async () => {
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
    });
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
