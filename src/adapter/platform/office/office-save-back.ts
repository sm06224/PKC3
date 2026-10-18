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
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { errorText } from '@features/error-text';
import type { AppPhase } from '../../state/app-state';
import { isLocalFileToken, localSaveFailedNotice, type LocalWriteFailure } from '@features/office/office-launch';
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
  /** いま取り込めるか(`phase === 'ready'`)。⚠ 偽なら**棚に残す**。差し替えと手元のファイルへの書き戻しはこちら。 */
  readonly canWrite: () => boolean;
  /**
   * 🔴 **新しい添付のノートを足せるか**(#1087)。読む画面か、編集中(足すだけで選択も編集も動かさない ──
   *   PDF の保存・画像の描き込みと同じ。`CREATE_ENTRY` は `keepSelection` なら編集中を受ける)。
   * ⚠ **optional にしない**(配線を落とすと、編集中の保存が新規でも終わるまで止まる形に戻る)。
   */
  readonly canCreate: () => boolean;
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
   * 🔴 **同じファイルを指す添付がほかにもあるとき、差し替える前に確かめる**(#1163 依頼 211・293)。
   *
   * 中身が同じファイルは 1 つにまとめて持っているので、差し替えると、そのファイルを指しているほかのノートのリンクも
   * 新しい版になる。ほかに同じファイルを指す添付が無ければ、聞かずに `'replace'`。
   * @returns `'replace'` = 今までどおり差し替える / `'separate'` = 差し替えず、別の添付のノートとして取り込む
   *   (リンクは変わらず、編集した内容も失わない)
   * ⚠ **optional にしない** ── 配線を落とすと、確かめずにほかのノートのリンクが変わる形に戻る。
   */
  readonly confirmShared: (lid: string, save: StagedSave) => Promise<'replace' | 'separate'>;
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
   *   `true` = 書き戻した / `false` または理由 = 書き戻せなかった(**user に伝える**)
   * ⚠ **optional にしない** ── 配線を落としても tsc が黙ると、
   *   「手元のファイルを直したのに PKC のノートが増える」という、
   *   user がいちばん気づきにくい形で壊れる(CLAUDE.md §7 の待ちの口と同じ理由)。
   */
  readonly writeLocal: (
    token: string,
    bytes: Uint8Array<ArrayBuffer>,
  ) => Promise<boolean | LocalWriteFailure | null>;
  /**
   * 🔴 **この合言葉の元のファイルを、このタブが知っているか**(#1087)。手元のファイルの合言葉は
   *   **開いたタブの中にしか無い**(`LocalOfficeFiles.byToken`)ので、知らないタブでは書けない。
   *   ⚠ 書き戻しは DB に触れないので、**holder でなくても**知っているタブが引き取る。
   * ⚠ **optional にしない**(配線を落とすと、知らないタブがノートを作る形に戻る)。
   */
  readonly knowsLocal: (token: string) => boolean;
  /** user への一言(「取り込みました」)。`openLid` があれば、知らせの「開く」でそのノートへ行ける。 */
  readonly notify: (message: string, openLid?: string) => void;
  /** 異常の報告(取り込めなかった)。 */
  readonly fail: (message: string) => void;
  /**
   * 🔴 **いまの画面の状態**(O-10)。預かった理由の言い分けに使う ── `canWrite` が偽なのは編集中だけではない。
   * ⚠ 呼ぶたびに読む(値を固めない)。
   */
  readonly phase: () => AppPhase;
  /**
   * 🔴 **取り込みの結果を、窓を開いたタブへも運ぶ**(O-8)。引き取るのは writer のタブ 1 つで、窓を開いたのが別の(follower の)タブだと
   * 「取り込みました / まだ入れていません / 失敗」をそのタブは見られない。⚠ 放送は自分には返らない ── 引き取ったタブが
   * 頼んだタブでもあるときに 2 度出ない。**optional にしない**(配線を落とすと follower が黙る形に戻る)。
   */
  readonly relay: (result: {
    readonly token: string;
    readonly kind: 'notice' | 'fail';
    readonly text: string;
    readonly openLid?: string;
  }) => void;
}

/**
 * 🔴 **手元のファイルの保存を、元のファイルへ書けず、添付のノートにしたときの一言**(#1087)。
 * ⚠ 棚の中身は user から見えないので「残してあります」とは言わない ── 開けるノートにして、そう言う。
 */
export function localOrphanImportedNotice(name: string): string {
  return `元のファイルを開いた画面が閉じられたので、Office で保存した内容は元のファイルへ書き戻せませんでした。代わりに添付のノート「${name}」として取り込みました`;
}

/**
 * 🔴 **元の添付が見つからず、新しい添付のノートにしたときの一言**(#1087)。
 * ⚠ 「取り込みました」だけだと、差し替えたつもりの user は**元のノートが更新された**と読む。
 */
export function originGoneImportedNotice(name: string): string {
  return `元の添付が見つからなかったので、新しい添付のノートとして取り込みました: 「${name}」`;
}

/**
 * 🔴 **同じファイルを指す添付がほかにもあり、差し替えずに別の添付のノートにしたときの一言**(#1163 依頼 211・293)。
 * ⚠ 「取り込みました」だけだと、差し替えたつもりの user は元のノートが更新されたと読む。
 */
export function sharedSeparateImportedNotice(name: string): string {
  return `同じファイルを指すほかの添付があるので、差し替えずに別の添付のノートとして取り込みました: 「${name}」`;
}

/**
 * 🔴 **同じファイルを指す添付がほかにもあるときの、差し替え前の確かめの文**(#1163 依頼 211・293)。
 * ⚠ 画面に出る字なので 1 か所に置く。ほかのノートのリンクの数は、書き換える側と同じ規則で数えた値。
 */
export function sharedReplaceQuestion(name: string, sharers: number, links: number, canSeparate: boolean): string {
  const tail =
    links > 0
      ? `このまま保存すると、そのファイルを指しているほかのノートのリンク ${links} か所も新しい版になります`
      : 'このまま保存すると、ほかの添付のノート自身は古い版のままです';
  const exit = canSeparate ? '別の添付として保存すると、リンクは変わりません。' : '';
  return `「${name}」と同じファイルを指す添付が、ほかに ${sharers} 件あります。${tail}。${exit}`;
}

/**
 * 🔴 **いま入れられないので、保存を預かっているときの一言**(#1087)。預かっている間は何も言わないと、
 *   user は「保存したのにノートが変わらない」と読む。書き言葉は他の「編集中なのでまだ入れていません」に揃える。
 * 🔴 **理由は画面の状態で言い分ける**(O-10)。入れられないのは編集中だけではない ── 保存に失敗して止まっているとき
 *   「編集中なので」と言うと、編集を終えようとしても入らず、出口(保存し直す)も案内されない。
 *   ⚠ 出口の字は `app-state.ts` の `SAVE_FAILED_EXIT` と同じボタン名(「ノートを保存し直す」)。
 */
export function savedHeldNotice(name: string, phase: AppPhase = 'editing'): string {
  const head = `Office で保存した「${name}」は、`;
  if (phase === 'error') return `${head}ノートの保存に失敗しているのでまだ入れていません。「ノートを保存し直す」を押すと入れます`;
  if (phase === 'initializing') return `${head}読み込み中なのでまだ入れていません。読み込みが終わると入れます`;
  return `${head}編集中なのでまだ入れていません。編集を終えると入れます`;
}

/**
 * 🔴 **取り込み中に例外が出た保存の、失敗の一言**(O-9)。例外で落ちた保存は棚に残してあり、あとで取り込み直す ──
 *   そう言わないと、user は「失敗したので無くなった」と読む。
 */
export function intakeFailedNotice(name: string, reason: string): string {
  return `Office で保存した内容を取り込めませんでした(「${name}」): ${reason}。内容は PKC3 の中に残してあり、あとで取り込み直します`;
}

/**
 * 🔴 **知らせるまでの猶予**(ms)。他のタブが知っているかは**こちらから見えない**ので、
 *   保存の直後は黙って待つ(知っているタブが数百 ms で書く)。古い保存だけ「誰も書けない」と読む。
 */
export const LOCAL_ORPHAN_GRACE_MS = 10_000;

/**
 * 🔴 **差し替えに記録する「保存した時刻」**(#1087)。窓が保存した時刻(`StagedSave.at`)を使う。
 * ⚠ 書き戻した**今**にすると、保留した保存のあとに打った控えが「古い」と読まれて見送られる
 *   (`isShadowNewer`)。0 / 欠けは今に倒す。
 */
export function stagedSavedAt(at: number | undefined, now: number = Date.now()): string {
  const t = typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : now;
  return new Date(t).toISOString();
}

export interface OfficeSaveBack {
  /** 鍵の放送を受けた。 */
  receive(key: string): Promise<IntakeResult | null>;
  /** 棚に残っているものを全部取り込む(起動時 / 窓が閉じた時)。 */
  drainAll(): Promise<number>;
  /** 編集が終わった等で、**保留したものだけ**撃ち直す。⚠ 保留が無ければ何もしない。 */
  retryDeferred(): Promise<number>;
  /**
   * 🔴 **その合言葉(ノート)の保存を、先に取り込む**(O-7)。窓を開く / 読み直す前に呼び、預かってある保存をノートへ入れる。
   * @returns 取り込めた(ノートの添付が替わった)なら `true`。編集中などで入れられなければ `false`(預かったまま)
   */
  adoptFor(token: string): Promise<boolean>;
  /** 窓が「渡せなかった」と言ってきた。 */
  reportWindowFailure(reason: string): void;
}

export function createOfficeSaveBack(deps: SaveBackDeps): OfficeSaveBack {
  /** いま処理中の鍵。⚠ 放送と起動時 sweep が重なると同じ鍵を 2 回引く。 */
  const inFlight = new Set<string>();
  /** 🔴 編集中で取り込めなかった ── **これが立っている間だけ**撃ち直す。 */
  let deferred = false;
  /**
   * 🔴 **元のファイルへ書けなかったと、もう言った保存**(#1087 の見直し)── 撃ち直しは編集を終えるたびに
   *   走るので、書けないままだと**同じ赤い字が毎回出る**。⚠ 言うのはこの起動で 1 度だけ(書けたら外す)。
   *   次の起動では空なので、もう一度言う。
   */
  const toldLocalFail = new Set<string>();
  /** 🔴 編集中なので預かっていると、もう言った保存(#1087)── 撃ち直しのたびに同じ字を出さない。取り込めたら外す。 */
  const toldHeld = new Set<string>();
  /**
   * 🔴 **例外で落ちたと、もう言った保存**(O-9)── 撃ち直しのたびに同じ赤い字を出さない。取り込めたら外す。
   */
  const toldThrown = new Set<string>();
  /**
   * 🔴 **一言と、窓を開いたタブへの運び**(O-8)。⚠ 一言を出す口はここ 1 本 ── 口ごとに運ぶと、運び忘れた口だけ follower が黙る。
   */
  function tell(save: StagedSave, message: string, openLid?: string): void {
    deps.notify(message, openLid);
    relay(save, 'notice', message, openLid);
  }
  function complain(save: StagedSave, message: string): void {
    deps.fail(message);
    relay(save, 'fail', message);
  }
  function relay(save: StagedSave, kind: 'notice' | 'fail', text: string, openLid?: string): void {
    if (save.token === undefined || save.token === '') return;
    try {
      deps.relay({ token: save.token, kind, text, ...(openLid !== undefined ? { openLid } : {}) });
    } catch {
      // 運べなくても、このタブの一言は出ている
    }
  }
  function hold(save: StagedSave): IntakeResult {
    deferred = true;
    if (!toldHeld.has(save.key)) {
      toldHeld.add(save.key);
      tell(save, savedHeldNotice(save.name, deps.phase()));
    }
    return 'deferred';
  }

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

  /**
   * 🔴 **同じ文書の保存か**(#1087)。合言葉(`token`)が同じ、または `sameDoc` の鍵が同じ。
   * ⚠ どちらも無い(古い meta)は**別扱い** ── 束ねて古い版を捨てる側へは倒さない。
   */
  /**
   * 🔴 **古い側が、新しい側の「前の版」と言えるか**(O-7)。同じ窓の session(`win`)の保存なら、新しい側は古い側の編集を
   * 含んでいる(続きを打って保存した)。⚠ 窓が替わっている(読み込み直した / 開き直した)と、**新しい側は古い側を含まないことがある** ──
   * 預かった保存を取り込まないまま窓を開き直すと、窓はノートの古い版から始まる。捨てると預かった編集が誰にも残らない。
   * 窓の id が分からない古い meta も、捨てる側へは倒さない。
   */
  function sameSession(a: StagedSave, b: StagedSave): boolean {
    return a.win !== undefined && a.win === b.win;
  }

  function sameDocument(a: StagedSave, b: StagedSave): boolean {
    // 合言葉を両方が持つなら**それだけ**で決める(別のノートが同じ窓・path を持ちうる)
    if (a.token !== undefined && b.token !== undefined) return a.token === b.token;
    const ga = sameDoc(a);
    return ga !== null && ga === sameDoc(b);
  }

  /**
   * 🔴 **新しい保存が届いたら、同じ文書の古い保存を棚から捨てる**(#1087、データ消失)。
   * ⚠ 保留した古い版(書けなかった / 編集中)が棚に残ったまま新しい版が成功すると、
   *   窓を閉じる掃除(`drainAll`)や撃ち直しが**古い bytes で新しい版を上書きする**
   *   (手元のファイルでは履歴にも無く、戻せない)。
   * ⚠ 「古い」は `listStaged` が返す順(`at` の昇順。同時刻は読み出し順)で、`save` より前にある物。
   * 🔴 捨てるのは**同じ窓の session の古い保存だけ**(O-7)── 別の session の古い保存は、取り込めていないなら**残す**
   *   (新しい側が含んでいない編集かもしれない。`run` が先に取り込む)。
   * @returns 捨てなかった物(`save` を含む)
   */
  async function dropOlder(dir: StageDir, all: StagedSave[], save: StagedSave): Promise<StagedSave[]> {
    const idx = all.findIndex((s) => s.key === save.key);
    if (idx < 0) return all;
    const keep: StagedSave[] = [];
    for (let i = 0; i < all.length; i += 1) {
      const s = all[i]!;
      if (i < idx && s.key !== save.key && sameDocument(s, save) && sameSession(s, save) && !inFlight.has(s.key)) {
        await discardStaged(dir, s.key);
      } else {
        keep.push(s);
      }
    }
    return keep;
  }

  /** 成功した `save` より古い同じ文書の保存を捨てる(棚を引き直して見る)。 */
  async function supersedeOlder(dir: StageDir, save: StagedSave): Promise<void> {
    await dropOlder(dir, await listStaged(dir), save);
  }

  async function takeOne(dir: StageDir, save: StagedSave): Promise<IntakeResult> {
    const bytes = await readStaged(dir, save);
    if (bytes === null) {
      // 大きさが meta と食い違う = 書きかけのまま `.json` が置かれた(壊れている)。
      // ⚠ 残しても永久に直らないので捨てる ── ただし**黙らない**
      await discardStaged(dir, save.key);
      complain(save, `Office で保存した内容を取り込めませんでした(「${save.name}」: 中身が読めません)`);
      return 'failed';
    }
    // ⚠ **`ready` を先に見る。** 見ないと reducer に黙って捨てられ、
    //    「取り込んだ」ことにして棚から消す = 文書が消える
    //    ⚠ 新しい添付のノートを足すだけなら編集中でも通す(下の `createNote` の前で、もう一度 `canCreate` を見る)
    if (!deps.canWrite() && !deps.canCreate()) return hold(save);

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
    // 🔴 **知らないタブでは、手元の合言葉をノートにしない**(#1087)。合言葉は開いたタブの中にしか無いので、
    //   `writeLocal` が `null` を返して下の取り込みへ落ち、**元のファイルは古いまま添付ノートが増える**。
    //   ⚠ 猶予の間は棚に残す(別のタブが知っているかもしれない)。猶予を過ぎたら誰も書けないと読み、
    //   holder が添付のノートにする(棚の中身は user から見えないので、開けるノートにして残す)。
    //   ⚠ holder でないタブは、知らない合言葉の保存をここへ持ち込まない(`run` の絞り込みが唯一の門)
    let orphan = false;
    if (save.token !== undefined && isLocalFileToken(save.token) && !deps.knowsLocal(save.token)) {
      if (Date.now() - save.at <= LOCAL_ORPHAN_GRACE_MS) {
        // 🔴 `deferred` を立てる(O8)── 立てないと `retryDeferred` が空振りし、猶予が明けても撃ち直されない
        deferred = true;
        return 'deferred';
      }
      orphan = true;
    }
    // ⚠ 手元のファイルへの書き戻しは**書ける画面**でだけ(編集中に通すのは新しい添付を足すことだけ)
    if (save.token !== undefined && !orphan && isLocalFileToken(save.token) && !deps.canWrite()) return hold(save);
    const local = save.token === undefined || orphan ? null : await deps.writeLocal(save.token, bytes);
    if (local !== null) {
      if (local !== true) {
        if (!toldLocalFail.has(save.key)) {
          toldLocalFail.add(save.key);
          complain(save, localSaveFailedNotice(save.name, local === false ? null : local));
        }
        deferred = true;
        return 'deferred';
      }
      // ⚠ 自分を捨てる**前**に呼ぶ(棚の順の中で自分の位置を引くため)
      await supersedeOlder(dir, save);
      await discardStaged(dir, save.key);
      toldLocalFail.delete(save.key);
      toldHeld.delete(save.key);
      toldThrown.delete(save.key);
      tell(save, `元のファイルへ保存しました: 「${save.name}」`);
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
    // 🔴 孤児の保存は手元の合言葉でノートを引かない(添付ではない)。同じ文書で先に作ったノートがあればそれ
    let token = orphan ? mine : (save.token ?? mine);
    let target = token === undefined ? null : await deps.readAttachment(token);
    // ⚠ **合言葉が「在るが死んでいる」ときも束ねへ倒す**(2 巡目レビュー)。
    //    倒さないと、開いていた添付を user が消した状態で編集中に 2 件溜まった場合、
    //    1 件目=新規 / 2 件目も**新規**になり、ここでもノートが 2 件できる
    if (target === null && mine !== undefined && mine !== token) {
      token = mine;
      target = await deps.readAttachment(mine);
    }
    let sharedSeparate = false;
    if (token !== undefined && target !== null) {
      if (!deps.canWrite()) return hold(save);
      // 🔴 同じファイルを指す添付がほかにもあれば、差し替えの前に確かめる(#1163 依頼 211・293)。
      //    やめる側は「別の添付として取り込む」── 保存した内容は失わず、ほかのノートのリンクは変わらない
      if ((await deps.confirmShared(token, save)) === 'separate') {
        sharedSeparate = true;
        token = undefined;
        target = null;
      }
    }
    if (token !== undefined && target !== null) {
      const ok = await deps.replaceAsset(token, save, bytes);
      if (!ok) {
        deferred = true;
        return 'deferred';
      }
      if (!windowKnew) announce(save.key, token);
      // ⚠ 自分を捨てる**前**に呼ぶ(棚の順の中で自分の位置を引くため)
      await supersedeOlder(dir, save);
      await discardStaged(dir, save.key);
      toldHeld.delete(save.key);
      toldThrown.delete(save.key);
      tell(save, `Office で保存した内容を取り込みました: 「${save.name}」`);
      return 'replaced';
    }
    // 🔴 元の添付が無い回(合言葉も、先に作ったノートも死んでいる)は、そう言う(#1087)
    const originGone = !sharedSeparate && !orphan && (save.token !== undefined || mine !== undefined);
    if (!deps.canCreate()) return hold(save);
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
    // ⚠ 自分を捨てる**前**に呼ぶ(棚の順の中で自分の位置を引くため)
    await supersedeOlder(dir, save);
    await discardStaged(dir, save.key);
    toldHeld.delete(save.key);
    toldThrown.delete(save.key);
    tell(
      save,
      orphan
        ? localOrphanImportedNotice(save.name)
        : sharedSeparate
          ? sharedSeparateImportedNotice(save.name)
          : originGone
          ? originGoneImportedNotice(save.name)
          : `Office で保存した内容を取り込みました: 「${save.name}」`,
      lid,
    );
    return 'created';
  }

  function run(pick: (all: StagedSave[]) => StagedSave[]): Promise<IntakeResult[]> {
    // 🔴 **1 本ずつ**(上の `serial` の注記)── 並行に走ると、表がまだ空のまま
    //    同じ文書のノートを 2 件作る
    return serial(async () => {
      // 🔴 **holder だけ**(放送は全タブに届く)。⚠ 例外: 手元のファイルの書き戻しは DB に触れないので、
      //    その合言葉を知っているタブが引き取る(#1087)
      const holder = deps.isHolder();
      const dir = await deps.stage();
      if (dir === null) return [];
      const listed = await listStaged(dir);
      const all = holder
        ? listed
        : listed.filter((s) => s.token !== undefined && isLocalFileToken(s.token) && deps.knowsLocal(s.token));
      if (all.length === 0) return [];
      // 🔴 同じ文書の保存が複数あるときは**一番新しい 1 件だけ**を処理する(#1087)。
      //    古い版を後から書くと、新しい版を上書きして戻せない
      let live = all;
      for (const s of all) live = await dropOlder(dir, live, s);
      const out: IntakeResult[] = [];
      const done = new Set<string>();
      /**
       * 1 件取り込む。@returns まだ棚に残っている(あとで撃ち直す)なら `true`。
       * 🔴 例外で落ちた保存も**あとで撃ち直す**(O-9)── 立てないと、容量の拒否などで落ちた保存は次の起動まで眠る。
       */
      const attempt = async (save: StagedSave): Promise<boolean> => {
        inFlight.add(save.key);
        done.add(save.key);
        try {
          const r = await takeOne(dir, save);
          out.push(r);
          return r === 'deferred';
        } catch (e) {
          deferred = true;
          // 同じ赤い字を撃ち直しのたびに出さない(この起動で 1 度だけ)
          if (!toldThrown.has(save.key)) {
            toldThrown.add(save.key);
            complain(save, intakeFailedNotice(save.name, errorText(e)));
          }
          out.push('failed');
          return true;
        } finally {
          inFlight.delete(save.key);
        }
      };
      for (const save of pick(live)) {
        if (done.has(save.key) || inFlight.has(save.key)) continue;
        // 🔴 **別の窓の session の古い保存が残っていれば、先に取り込む**(O-7)。後から書くと新しい版を古い版で上書きし、
        //   捨てると預かった編集が消える。⚠ 古い側が取り込めない間は、新しい側も預かる(順番を守る)
        const idx = live.findIndex((s) => s.key === save.key);
        let blocked = false;
        for (let i = 0; i < idx; i += 1) {
          const older = live[i]!;
          if (done.has(older.key) || inFlight.has(older.key) || !sameDocument(older, save)) continue;
          if (await attempt(older)) blocked = true;
        }
        if (blocked) {
          deferred = true;
          out.push('deferred');
          continue;
        }
        await attempt(save);
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

    async adoptFor(token) {
      if (token === '') return false;
      const got = await run((all) => all.filter((s) => s.token === token));
      return got.some((r) => r === 'created' || r === 'replaced');
    },

    reportWindowFailure(reason) {
      deps.fail(`Office で保存した内容を PKC3 へ渡せませんでした: ${reason}`);
    },
  };
}

/**
 * 🔴 **書き戻しが本当に disk のノートへ届いたか**(#1087、添付の見直し)。
 * ⚠ 書くのは非同期の効果で、容量の拒否・DB の破損で落ちうる。撃った直後に成功と言うと、棚を捨ててから
 *   失敗が出て、新しい版の bytes はどのノートからも指されないまま次の整理で消えていた。
 * ⚠ 比べるのは本文の**添付の key の欄**(`attachment.asset_key`)だけ ── 本文全体の部分一致にすると、
 *   新しい版が過去の版と同じ中身のとき(版の台帳に同じ key が既に在る)に、書けていなくても真になる。
 * ⚠ 確かめられなければ `false`(棚は残り、次に取り込み直す)。
 */
export async function confirmSavedBack(deps: {
  readonly settle: () => Promise<void>;
  readonly readBody: () => Promise<string | null>;
  readonly key: string;
}): Promise<boolean> {
  try {
    await deps.settle();
    const body = await deps.readBody();
    return body !== null && readAttachmentMeta(body).assetKey === deps.key;
  } catch {
    return false;
  }
}
