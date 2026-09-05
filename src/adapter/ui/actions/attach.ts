/**
 * 添付取込(P4a): **File → Blob 直 put**。
 *
 * PKC2 からの総合的見直し(調査 2026-07-31):
 * - base64 経路(FileReader → container.assets[key] = base64)を書き込み側から
 *   廃止 ── PKC2 の +293MB 常駐と「250MB 上限(根拠が base64 ヒープ)」を持ち込まない。
 *   上限は quota preflight(storage.estimate)に置き換える
 * - asset key 規則は `ast-<ts36>-<rand>` の **1 本**(PKC2 は 3 規則混在。
 *   旧規則は P6 import 側で受理する)
 * - dedupe は **content addressing**(key = bytes の SHA-256)── 台帳を引かずに
 *   構造的に一意になる(user 指示 2026-08-01「ZFS と同じ発想」)。実体は
 *   `storage/asset-key.ts`。PKC2 は base64 文字列 hash で、経路により
 *   「toast のみ / 再利用」が不一致だった
 * - hash/size メタは put と同時に書く(後付け reconcile 走査を構造的に不要にする
 *   ── PKC2 は走査が 500MB データで boot OOM を誘発した)
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { noteToPutInto, putAssetIntoNote } from './asset-into-note';
import { createWritableQueue } from './writable-queue';
import { attachmentBody } from '@features/flavor/attachment-flavor';
import { identifyAsset, assetKeyFromHash } from '@adapter/platform/storage/asset-key';
import { shrinkPlan, shrinkQuestion } from '@features/asset/image-shrink';
import { generateLid } from './binder';

export interface AttachDeps {
  putBlob(assetKey: string, blob: Blob): Promise<void>;
  /**
   * 🔴 **預かった取込を、資産の門(`withAssetGate`)の中で走らせる口**(#724 ⑤)。
   *
   * ⚠ 編集中に預かった `run` は、呼び側の `withAssetGate(() => attachFiles(...))` の
   *   鎖が**解けた後**に `writable-queue` から走る ── そのとき `putBlob` → `CREATE_ENTRY`
   *   の間(bytes はあるが参照が無い窓)を誰も排他していなかった。整理(未参照 GC)が
   *   重なると取込中の bytes を消す(`asset-gate.ts` が禁じている当の窓)。
   * 🔑 だから預かった `run` は**この口で包んで**走らせる。アプリは `withAssetGate.queued`
   *   を渡す(user はもう file を選んでいるので、断る側ではなく待つ側)。
   * ⚠ optional にしない ── 渡し忘れを tsc が黙ると、症状は「まれに添付が消える」という
   *   いちばん気づけない形で戻る(CLAUDE.md §7「待ちの口は optional にしない」)。
   */
  gate(run: () => Promise<void>): Promise<void>;
  putMeta(meta: {
    key: string;
    mime: string;
    size: number;
    hash: string | null;
  }): Promise<void>;
  listMetas(): Promise<
    Array<{ key: string; size: number | null; hash: string | null }>
  >;
  /** quota preflight(無い環境では省略可)。 */
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  /**
   * 🔴 **ハッシュを取る口**(P8 段㉓)。アプリからは**必ずワーカーを渡す**。
   *
   * 省略すると `identifyAsset` にそのまま落ちる = ハッシュがメインで走る。
   * 同じビルドの A/B(32MB の添付)で、メインの最大欠測が
   * **10/14ms(ワーカー)対 500/726ms(メイン)**。
   * user から実機で「添付とかでメインスレッドブロックするのは気になるね」と報告。
   *
   * ⚠ `identifyAsset` を直接 import しているとここで差し替えられない ──
   *   だから attach 側は**この口だけ**を見る。
   */
  hashBlob?(blob: Blob): Promise<string | null>;
  /**
   * 🔴 **画像を縮める口**(#412)。⚠ 復号と再符号化は重いのでワーカーへ。
   * ⚠ **渡さなければ縮めない**(元のまま入る = 安全側)。
   */
  shrinkImage?(blob: Blob, mime: string): Promise<{
    width: number;
    height: number;
    shrunk: { blob: Blob; width: number; height: number } | null;
  }>;
  /**
   * 🔴 **user に聞く口**(#412)。⚠ **渡さなければ縮めない**。
   *
   * 🔴 写真は user のものであり、縮めるのは**不可逆**である ──
   *   だから**黙って縮める道を作らない**。口が無ければ、聞けないので縮めない。
   */
  askShrink?(question: string): Promise<boolean>;
}


/**
 * file.type が空のときの拡張子 fallback(PKC2 は無くて後段の補正 hack を生んだ)。
 *
 * 🔴 **export する**(2026-08-16、着地前レビュー R11)。⚠ 同じ「拡張子 ↔ MIME」の
 * 対応が **3 か所**に在る(ここ / `pkc3-markdown-zip.ts` の `EXT_BY_MIME` /
 * `office-entry.ts` の `OFFICE_MIMES` + `OFFICE_EXTS`)── 手写しの例を並べた test
 * では**表ごと消す変異が生き延びる**ので、**母集団をここから採って全数で回す**。
 */
export const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  // 🔴 **Office**(2026-08-16、#205)。⚠ 10 種とも**1 つも入っていなかった** ──
  //    OS が MIME を付けない環境と、**Office の窓から戻ってきた bytes**
  //    (`File` ではないので `type` が無い)が全部 `application/octet-stream` に
  //    落ちていた。帰結: preview が出ない / md zip 書出しの名前が **`.bin`** になる
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  rtf: 'application/rtf',
  // ⚠ 入口(`office-entry.ts` の `OFFICE_EXTS`)には**前から在った**のに、
  //    この表と書出しの逆表に無かった ── 「開けるのに書き出すと `.bin`」だった
  odg: 'application/vnd.oasis.opendocument.graphics',
  fodt: 'application/vnd.oasis.opendocument.text-flat-xml',
  fods: 'application/vnd.oasis.opendocument.spreadsheet-flat-xml',
  fodp: 'application/vnd.oasis.opendocument.presentation-flat-xml',
};

export function resolveMime(name: string, declared: string): string {
  if (declared) return declared;
  if (!name.includes('.')) return 'application/octet-stream'; // 拡張子なし
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/**
 * 取り込む 1 件。⚠ **`File` でなくてよい** ── Office の窓から戻ってきた bytes は
 * `File` ではないので、`name` / `type` を**外から**与える形にしてある(#205)。
 */
export interface AttachItem {
  readonly name: string;
  /** 宣言 MIME(空なら拡張子から引く)。 */
  readonly type: string;
  readonly size: number;
  readonly blob: Blob;
}

/** 取り込めたか。⚠ `null` = 取り込まなかった(理由は既に `OP_FAILED` で出ている)。 */
export interface AttachedOne {
  readonly lid: string;
  readonly assetKey: string;
  readonly mime: string;
  readonly hash: string | null;
}

/** 資産として置いた結果。⚠ **ノート(entry)は作らない** ── それは呼び側の仕事。 */
export interface StoredAsset {
  readonly assetKey: string;
  readonly mime: string;
  readonly hash: string | null;
}

/**
 * 🔴 **bytes を資産として置く**(2026-08-18 に `attachOne` から取り出した ── #250 で
 * **スクショの貼付**が同じ道を通るため)。
 *
 * ⚠ **ノートを作らない**のが要である。`CREATE_ENTRY` の reducer は
 * `phase !== 'ready'` を**黙って捨てる**ので、**編集中に貼った画像**をノートにしようと
 * すると bytes だけ書かれて参照が消える。編集中の貼付は「資産を置いて、本文に参照を
 * 差す」── そこが body 走査の GC に拾われるので、迷子にならない。
 *
 * ⚠ 空きが足りないときは**投げる**(呼び側が user に見える形へ変える)。
 */
export async function storeAsset(
  deps: AttachDeps,
  item: AttachItem,
  known?: Set<string>,
): Promise<StoredAsset> {
  // quota preflight ── 足りないときは黙って壊れる前に可視で止める
  if (deps.estimate) {
    const est = await deps.estimate();
    if (
      est.quota !== undefined &&
      est.usage !== undefined &&
      est.quota - est.usage < item.size * 1.2
    ) {
      throw new Error(`添付を保存する空き容量が不足しています: ${item.name}`);
    }
  }

  const mime = resolveMime(item.name, item.type);
  // key = 中身のハッシュ。同一 bytes なら**必ず**同じ key に落ちる
  // ⚠ 帰結 2 点(review #5): sqlite assets.mime は**初回 file のまま**
  // (表示は entry frontmatter 側 mime を使うので正しい ── assets.mime を
  // 信じる消費者を作らない)。asset 削除は参照カウント前提になる
  // (PKC3 の GC は body 走査ベースなので元から正しい)
  // 🔑 ハッシュは**ワーカーで取る**(段㉓)。口が無い環境だけその場で回す
  //    ── 返る key は同じ関数(`assetKeyFromHash`)から出るので、
  //    「ワーカーは速さの話であって、正しさの話ではない」が保たれる
  const { key: assetKey, hash } = deps.hashBlob
    ? assetKeyFromHash(await deps.hashBlob(item.blob))
    : await identifyAsset(item.blob);
  if (!known?.has(assetKey)) {
    await deps.putBlob(assetKey, item.blob);
    await deps.putMeta({ key: assetKey, mime, size: item.size, hash });
    known?.add(assetKey);
  }

  return { assetKey, mime, hash };
}

/**
 * 🔴 **添付 1 件を取り込む。**(2026-08-16 に `attachFiles` から取り出した ── #205 で
 * Office の保存が同じ道を通るため。⚠ **`attachFiles` をそのまま呼ばせない**:
 * あちらは「編集中なら預かる」「gate が断る」「選択を奪う」の 3 つを user のクリック
 * 前提で持っており、**別窓から非同期に届く保存**に当てると bytes ごと失われる)
 *
 * ⚠ `known` は content addressing の重複判定。**渡さなければ毎回 put する** ──
 * IDB の `put` は同じ key なら上書きなので壊れないが、無駄に書く。
 */
export async function attachOne(
  dispatcher: Dispatcher,
  deps: AttachDeps,
  item: AttachItem,
  known?: Set<string>,
): Promise<AttachedOne | null> {
  let stored: StoredAsset;
  try {
    stored = await storeAsset(deps, item, known);
  } catch (e) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: (e as Error).message });
    return null;
  }
  const { assetKey, mime, hash } = stored;

  const lid = generateLid();
  dispatcher.dispatch({
    type: 'CREATE_ENTRY',
    archetype: 'attachment',
    lid,
    title: item.name,
    body: attachmentBody({ name: item.name, mime, size: item.size, assetKey, hash }),
    edit: false, // 添付は editor に入らない(PKC2 の silent attach と同じ)
  });
  // 🔴 **作れたことを確かめてから「作れた」と言う。** `CREATE_ENTRY` の reducer は
  //    `phase !== 'ready'` を**黙って捨てる** ── 確かめないと、Office の保存を
  //    「取り込んだ」ことにして棚から消し、**文書が消える**
  if (!dispatcher.getState().entryMetas.has(lid)) return null;
  return { lid, assetKey, mime, hash };
}

/**
 * 🔴 **大きな画像なら、縮めるか聞く**(#412)。
 *
 * ⚠ **縮めてから、本当の数字で聞く** ── 見積もりを見せない
 *   (「約 1.4MB」と言って 3MB になったら、それは嘘である)。
 * ⚠ 断られたら縮めたほうを**その場で捨てる**(参照を持たないので、
 *   関数を抜けた時点で回収される ── 2026-07-27 の不可侵指示と同じ向き)。
 * 🔴 **口が 1 つでも無ければ、何もしない** ── 黙って縮める道を作らない。
 *
 * @returns 取り込む item(縮めたなら差し替わっている)
 */
export async function maybeShrink(deps: AttachDeps, item: AttachItem): Promise<AttachItem> {
  if (!deps.shrinkImage || !deps.askShrink) return item;
  const mime = resolveMime(item.name, item.type);
  // ⚠ 触る形式かどうかは**純関数が決める** ── ここで綴りを書き直さない
  if (shrinkPlan(mime, item.size, Number.MAX_SAFE_INTEGER, 1) === null) return item;
  let out;
  try {
    out = await deps.shrinkImage(item.blob, mime);
  } catch {
    // ⚠ 縮めるのに失敗しても取込は続ける(元のまま入る)
    return item;
  }
  if (out.shrunk === null) return item;
  const ok = await deps.askShrink(
    shrinkQuestion(
      { width: out.width, height: out.height, bytes: item.size },
      { width: out.shrunk.width, height: out.shrunk.height, bytes: out.shrunk.blob.size },
    ),
  );
  if (!ok) return item;
  return { ...item, size: out.shrunk.blob.size, blob: out.shrunk.blob };
}

/** 取込本体。file ごとに独立に成否を扱う(1 個の失敗が batch を殺さない)。 */
export async function attachFiles(
  dispatcher: Dispatcher,
  deps: AttachDeps,
  files: readonly File[],
  /**
   * 文頭に付ける事情(「編集欄が閉じたため、打っていた所へは差せませんでした。」)。
   *
   * 🔴 **呼び側が別の 1 行で言ってはいけない**(#666 の着地前レビュー 1)。
   * ⚠ `OP_FAILED` に載せると **`CREATE_ENTRY` の reducer が `error: null` を書く**
   *   ので、**添付を作った瞬間に消える** ── user は一度も読めない。
   *   `capture.ts` の同じ注記が既にこれを戒めていた(そこを踏み直した)。
   * 🔑 だから事情は**取込の知らせと同じ 1 行**に載せる ── 録音の
   *   「共有が終わったので画面収録を止めました。」と同じ seam である。
   */
  why = '',
): Promise<void> {
  if (files.length === 0) return;

  /**
   * 🔴 **入れ先は「押した時点で開いているノート」を先に控える**(user 裁定
   * 2026-09-02、#666「読んでいたノートの本文に入る」)。
   *
   * ⚠ **輪の外で採る理由を、実測に合わせて書き直した**(#666 の着地前レビュー 2)──
   *   1 稿目は「中で採ると 20 枚落として 19 枚が迷子になる」と書いたが、**それは
   *   起きない**。`putAssetIntoNote` が `SELECT_ENTRY` で選択を**同期に返す**ので、
   *   ノートを開いていれば次の周回でも同じノートが読める(変異試験で 5 枚落として
   *   知らせの列まで完全に一致した ── CLAUDE.md §1「外して壊れるのを見る」)。
   * 🔑 **本当に変わるのは「何も開いていないとき」だけ**である ── 中で採ると
   *   2 枚目以降は**1 枚目の添付**を入れ先だと読み、断り文が
   *   「ノートを開いていないので」から「追記できない種類なので」へ**化ける**
   *   (user は開いてもいないノートの種類を理由に断られる)。
   *   `attach-intake.test.ts` の「開いていないまま 3 枚」がそこを pin する。
   * 🔑 選択を返す / 本文へ入れる / 書けないなら預かるは `asset-into-note.ts`
   *   **1 か所** ── 録音・画面録画と同じ口である(CLAUDE.md §7)。
   */
  const into = noteToPutInto(dispatcher);
  const queue = createWritableQueue(dispatcher);
  /**
   * 🔴 **この 1 回の取り込みの印**(#668 C)── 同じ印で入れた行は「元に戻す」1 回で
   *   まとめて消える(3 枚落としたら 3 行が 1 手)。⚠ 直す前は最後の 1 枚しか戻らなかった。
   */
  const batch = generateLid();
  // 🔑 `open` は「開く」の身元(#668 A)── state へ運ぶのはここ 1 か所
  const notify = (text: string, open?: string): void =>
    dispatcher.dispatch({ type: 'OP_NOTICE', message: text, ...(open === undefined ? {} : { open }) });

  /**
   * 🔴 **まとめて入れた回は、件数で締める**(#668 E)──「3 件を本文に入れました(c.png ほか)」。
   *
   * ⚠ 知らせの行は 1 本なので、3 枚落とすと user が最後に読むのは **3 枚目の 1 行**だけ
   *   である ── 1・2 枚目が入ったかは、本文を見に行かないと分からない。
   * 🔑 `put` は**本文へ入った物**(`onPut`)、`expected` は**添付になった物**。入れ先
   *   (`into`)は回の全件で同じなので、入るなら全件・入らないなら 0 件 ── 両者が揃うのは
   *   **全部入ったとき**だけで、入れられない種類の回は締めない(件数が嘘にならない)。
   *   ⚠ 「入れる予定か」を `putAssetIntoNote` に返させて数え分ける形は、差を作れない
   *   冗長だった(変異試験 S2 が SURVIVED で教えた)── 無条件に数える。
   * ⚠ 締めるのは**全部入ってから** ── 2 枚目以降は錠が解けるまで預かられるので、
   *   輪を抜けた時点ではまだ入っていない(`intakeDone` と `put === expected` の両方を見る)。
   * ⚠ 1 件だけの回は締めない(F の「本文のいちばん下に入れました」がそのまま残る)。
   */
  const tally = { expected: 0, put: 0, last: '' };
  let intakeDone = false;
  const summarize = (): void => {
    if (!intakeDone || tally.expected < 2 || tally.put !== tally.expected) return;
    notify(`${why}${tally.put} 件を本文に入れました(${tally.last} ほか)`);
  };

  /**
   * 取込の本体。⚠ **bytes を置くのもここから**(編集中は 1 バイトも書かない ──
   *   `CREATE_ENTRY` が黙殺されて参照されない asset が残留する、を作らない。P4a review #1)。
   */
  const run = async (): Promise<void> => {
    // content addressing なので**台帳を引かない**。同じ bytes は同じ key に落ちる
    // ので、既に持っているかは key の存在だけで決まる(batch 内の重複も自動で潰れる)
    const known = new Set(
      (await deps.listMetas().catch(() => [])).map((m) => m.key),
    );

    for (const file of files) {
      try {
        const item = await maybeShrink(deps, {
          name: file.name,
          type: file.type,
          size: file.size,
          blob: file,
        });
        const attached = await attachOne(dispatcher, deps, item, known);
        // ⚠ `null` は `attachOne` が既に理由を出している(二重に言わない)
        if (attached === null) continue;
        putAssetIntoNote({
          dispatcher,
          queue,
          notify,
          into,
          attachedLid: attached.lid,
          assetKey: attached.assetKey,
          name: item.name,
          // 🔑 **拡張子から解いた mime を渡す**(`file.type` ではない)── OS が
          //    MIME を付けない経路(共有 / D&D / Office の窓)でも、`猫.png` が
          //    ちゃんと**絵として**入る(`attach-intake.test.ts` が pin)
          mime: attached.mime,
          why,
          batch,
          onPut: (n) => {
            tally.put += 1;
            tally.last = n;
            summarize();
          },
        });
        // ⚠ 1 枚目は `onPut` が**この行より先に**同期で走ることがある ── だから
        //    `summarize` は `intakeDone` も見る(数え終わる前に締めない)
        tally.expected += 1;
      } catch (e) {
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `添付の取込に失敗しました(${file.name}): ${String(e)}`,
        });
      }
    }
    intakeDone = true;
    summarize();
  };

  const phase = dispatcher.getState().phase;
  if (phase === 'ready') {
    // ⚠ **待ってから返す** ── 呼び側(`withAssetGate`)は取込と整理を排他している
    await run();
    return;
  }
  /**
   * 🔴 **編集中は断らず、預かる**(#668 B。PR #667 の着地前レビュー)。
   *
   * ⚠ 直す前は「編集を終了してから添付してください」と断っていた ── user は
   *   ファイルの選択をやり直すことになる(選び直す間に、何を添えようとしたかを
   *   忘れる)。録音・画面録画は**編集中に終わっても預かる**(`capture.ts`)のに、
   *   同じ帯の隣の「添付」だけが断る、という釣り合いの崩れでもあった。
   * 🔑 預かりの仕掛けは `writable-queue.ts` の **1 本**(録音と同じ口)──
   *   編集が終わって書けるようになった瞬間に `run` が走る。
   * ⚠ **`await` しない** ── 編集が終わるまで解けない約束を返すと、`withAssetGate`
   *   の鎖が編集の間ずっと詰まり、整理(未参照 GC)まで待たされる。
   * ⚠ 入れ先(`into`)は**押した時点**で控えてある ── 編集していたノートに入る。
   * ⚠ `editing` 以外の `ready` でない相(起動前 / 致命エラー)は、これまでどおり断る
   *   ── 「編集を終えたら」と言っても、その日は来ない。
   */
  if (phase !== 'editing') {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '編集を終了してから添付してください',
    });
    return;
  }
  // 🔴 門の中で走らせる(#724 ⑤)── `queue` が走らせる時点では呼び側の鎖は解けている
  queue.push(() => deps.gate(run));
  const what = files.length === 1 ? `「${files[0]!.name}」` : `${files.length} 件`;
  notify(`${why}${what}を預かりました(編集を終えたら本文に入れます)`);
}
