/**
 * 🔴 **OS から開いた md を、元ファイルに紐づけたまま持つ**(2026-08-05、user 報告
 * 「マークダウンファイルに紐付けれるけど、取り込みもスポットの編集プレビュー導線も
 * 存在しない」)。
 *
 * 直す前は `launchQueue` の受け口が `getFile()` だけ呼んで **handle を捨てて**いた。
 * だから取り込んだ後は「元がどのファイルだったか」を誰も知らず、
 *   ① 同じファイルを 2 回開くと**ノートが 2 件**に増え
 *   ② 直したものを**元ファイルへ戻す道が無い**(= その場編集にならない)
 * の 2 つが同時に起きていた。
 *
 * ## ⚠ ここは**このセッションだけ**の記憶(どこにも保存しない)
 * handle は IndexedDB に入れられる形だが、**入れない**:
 *   - 保存すると、次の起動で「昔どこかで開いたファイル」への書込権を
 *     アプリが黙って持ち続けることになる(user が意識していない同意の延命)
 *   - ページを読み直したら紐づけは消える ── それが**正直な寿命**である
 *     (同じ md をもう一度開けば、また紐づく)
 * これは「素のまま起動を許した添付」を session 限りにしたのと同じ判断
 * (`main.ts` の `sameOriginAllowed`)。
 *
 * ## ⚠ 状態(AppState)に handle を置かない
 * reducer が持つのは **見せる材料(ファイル名)だけ**。handle は不透明な
 * ブラウザ objects で、比較も複製もできない ── 純粋な reducer に混ぜない。
 */

/**
 * 🔴 **取り込んだ後にパソコン側で変わっていたときの字**(#1264 §2 欠陥 1。🟣 Gemini 裁定 2026-10-02)。
 * 同じ字を 2 か所で出す(書き戻す前の確認 / 同じ行を押し直したときの下の 1 行)ので 1 か所に置く。
 */
export const CHANGED_OUTSIDE_WRITE_BACK_NOTE =
  'このファイルは取り込んだ後にパソコン側で変わっています。書き戻すと、その変更は消えます';
export const CHANGED_OUTSIDE_REOPEN_NOTE =
  'このファイルは取り込んだ後にパソコン側で変わっています(PKC3 のノートは取り込んだ時の中身です)';

/**
 * 🔴 **差分のために読む file の上限**(#1231 段②)。⚠ 超えたら**差分を出さない**だけ ── 書き戻しは止めない。
 * 理由は「読む量」ではなく**主スレッドで行を比べる量**(`diffLines` は編集距離に予算があるが、
 * 分割そのものは長さに比例する)。取り込み側(`file.text()`)は上限が無いので、これは**差分の門**である。
 */
export const DIFF_READ_LIMIT_BYTES = 2 * 1024 * 1024;

/** 大きすぎて読まなかった(`readForCompare` の返り)。⚠ `null`(読めなかった)と**分ける** ── 言う字が違う。 */
export interface LinkedFileTooLarge {
  readonly tooLarge: true;
}

/** `launchQueue` から来る handle(必要な部分だけ)。 */
export interface LaunchedHandle {
  /** `'file'` / `'directory'`。実装によっては未定義。 */
  kind?: string;
  getFile?(): Promise<File>;
  /** 同じファイルか(同名の別ファイルを取り違えないための唯一の手段)。 */
  isSameEntry?(other: LaunchedHandle): Promise<boolean>;
  queryPermission?(descriptor: { mode: string }): Promise<string>;
  requestPermission?(descriptor: { mode: string }): Promise<string>;
  createWritable?(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

/** `FileSystemWritableFileStream`(必要な部分だけ)。 */
export interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface Link {
  handle: LaunchedHandle;
  name: string;
  /**
   * 🔴 **取り込んだときの file の `lastModified`**(#1264 §2 欠陥 1)。⚠ 無ければ `null`
   * (添付・連絡先の記憶は書き戻さないので持たない = 比べない)。
   * 外のエディタで直されたかを、**押し直したとき**と**書き戻す直前**に比べる材料である。
   */
  modifiedAt: number | null;
}

/** 取り込み時の `lastModified` を持つ file(必要な部分だけ)。 */
interface HasModified {
  lastModified: number;
}

export class LaunchedFiles {
  private readonly byLid = new Map<string, Link>();

  /**
   * lid ↔ ファイルを結ぶ。同じ lid への再登録は上書き(開き直しで handle が変わる)。
   * `modifiedAt` = 取り込んだ file の `lastModified`(渡さなければ「比べない」)。
   */
  remember(lid: string, handle: LaunchedHandle, name: string, modifiedAt: number | null = null): void {
    this.byLid.set(lid, { handle, name, modifiedAt });
  }

  /** 取り込んだときの `lastModified`(無ければ `null`)。 */
  modifiedOf(lid: string): number | null {
    return this.byLid.get(lid)?.modifiedAt ?? null;
  }

  /**
   * 書き戻した直後に、**いまの `lastModified`** を取り込み時の時刻として憶え直す(#1264 §2 欠陥 1)。
   * ⚠ 憶え直さないと、自分が書いた時刻を**外での変更**と読んで、次の書き戻し・押し直しで言ってしまう。
   * 読めなければ**憶えたまま**にする(=「変わっています」が出る側。黙って消すより安全)。
   */
  async refreshModified(lid: string): Promise<void> {
    const link = this.byLid.get(lid);
    if (link === undefined || typeof link.handle.getFile !== 'function') return;
    try {
      link.modifiedAt = (await link.handle.getFile()).lastModified;
    } catch {
      /* 読めなかった ── 古い時刻のまま(次に言う側へ倒れる) */
    }
  }

  /**
   * 🔴 **取り込んだ後に、パソコン側で変わったか**(#1264 §2 欠陥 1)。
   * ⚠ **`getFile()` を呼ぶ**(いまの `lastModified` を読むため)── 呼んでよいのは
   * **書き戻す直前**だけ(一覧では呼ばない = #1271)。
   * ⚠ **読めない・比べられないときは `false`** ── 「変わったかもしれない」と言って
   * 毎回脅さない(確認の窓は元から出る)。取り込み時の時刻を持たない lid も `false`。
   */
  async changedSince(lid: string): Promise<boolean> {
    const link = this.byLid.get(lid);
    if (link === undefined || link.modifiedAt === null) return false;
    if (typeof link.handle.getFile !== 'function') return false;
    try {
      const file = await link.handle.getFile();
      return file.lastModified !== link.modifiedAt;
    } catch {
      return false;
    }
  }

  /**
   * 🔴 **書き戻す直前に、file の今の姿を 1 回だけ読む**(#1231 段②)── 「外で変わったか」と
   * 「今の中身」(確認の小窓に出す差分の相手)を**同じ `getFile()` 1 回**から採る。
   * ⚠ 呼んでよいのは `changedSince` と同じく**書き戻す直前だけ**(一覧では呼ばない = #1271)。
   * ⚠ 読めない・`getFile` が無い・大きすぎる(`DIFF_READ_LIMIT_BYTES` 超)ときは `text: null`
   *   (差分なしで今までどおりの確認)。`changed` は `changedSince` と同じ規則。
   * 🔴 大きすぎて読まなかったときだけ **`tooLarge: true`** が付く(読めなかったのと分ける ── 履歴の面が言う字を変える)。
   * @returns link が無ければ `null`
   */
  async readCurrent(
    lid: string,
  ): Promise<{ changed: boolean; text: string | null; tooLarge?: true } | null> {
    const link = this.byLid.get(lid);
    if (link === undefined || typeof link.handle.getFile !== 'function') return null;
    try {
      const file = await link.handle.getFile();
      const changed = link.modifiedAt !== null && file.lastModified !== link.modifiedAt;
      let text: string | null = null;
      if (typeof file.size === 'number' && file.size > DIFF_READ_LIMIT_BYTES)
        return { changed, text, tooLarge: true };
      try {
        text = await file.text();
      } catch {
        /* 中身だけ読めなかった ── 差分なしで進める */
      }
      return { changed, text };
    } catch {
      return null;
    }
  }

  /**
   * 🔴 **履歴の面の「くらべる相手 = PC のファイル」の読み口**(#1231 着地後レビュー)。`readCurrent` と同じ読み(新しい読み方を作らない)。
   * 本文 = 読めた / `{ tooLarge: true }` = 大きすぎて読まなかった / `null` = 読めなかった・結びついていない。
   */
  async readForCompare(lid: string): Promise<string | LinkedFileTooLarge | null> {
    const r = await this.readCurrent(lid);
    if (r === null) return null;
    if (r.tooLarge === true) return { tooLarge: true };
    return r.text;
  }

  nameOf(lid: string): string | null {
    return this.byLid.get(lid)?.name ?? null;
  }

  handleOf(lid: string): LaunchedHandle | null {
    return this.byLid.get(lid)?.handle ?? null;
  }

  forget(lid: string): void {
    this.byLid.delete(lid);
  }

  /**
   * 同じファイルに紐づいた lid を探す。
   *
   * ⚠ **名前で照合しない** ── 別のフォルダの同名 md を「同じ」と判定すると、
   * 開いたはずのファイルではないノートを見せる(しかも書き戻すと**別のファイルを
   * 壊す**)。`isSameEntry` を持たないブラウザでは **null を返す**
   * (= 重複を許す)── 取り違えるより増えるほうが安全側である。
   */
  async findLid(handle: LaunchedHandle): Promise<string | null> {
    if (typeof handle.isSameEntry !== 'function') return null;
    for (const [lid, link] of this.byLid) {
      try {
        if (await handle.isSameEntry(link.handle)) return lid;
      } catch {
        // 照合できない handle は「別物」として扱う(増えるほうへ倒す)
      }
    }
    return null;
  }
}

/**
 * 🔴 **同じファイルを 2 回開いても増やさない**(2026-08-05)。
 *
 * 直す前は開くたびに別ノートになり、どれが本物か分からなくなっていた
 * (しかも handle を捨てていたので、後から気づいても突き合わせられない)。
 *
 * ⚠ **`main.ts` の closure に書かない**。書くと test は「main と同じ形の写し」を
 * 検査するだけになり、main 側の間違いを一切捕まえられない
 * (CLAUDE.md「stub は本物の意味論を真似る」の裏返し ── 本物を test する)。
 *
 * @param isPresent その lid がいま一覧に居るか(消したノートに戻さないため)
 * @returns `fresh` = 取り込む物 / `reopened` = すでに開いていた lid(表示するだけ)
 */
export async function splitAlreadyOpen<T extends { handle: LaunchedHandle; file?: HasModified }>(
  items: readonly T[],
  launched: LaunchedFiles,
  isPresent: (lid: string) => boolean,
): Promise<{ fresh: T[]; reopened: string[]; changed: string[] }> {
  const fresh: T[] = [];
  const reopened: string[] = [];
  /** 🔴 `reopened` のうち、**取り込んだ後に file の更新時刻が動いている**もの(#1264 §2 欠陥 1)。 */
  const changed: string[] = [];
  for (const item of items) {
    const known = await launched.findLid(item.handle);
    // ⚠ 紐づけが残っていても **entry が消えていれば取り込み直す**
    //    (ゴミ箱へ入れた後に同じ md を開いたら、また開けるべき)
    if (known !== null && isPresent(known)) {
      reopened.push(known);
      // ⚠ 押した 1 件の file は呼び側が読み済み(`getFile()` を足さない)。取り込み時の時刻が無ければ比べない
      const was = launched.modifiedOf(known);
      if (was !== null && item.file !== undefined && item.file.lastModified !== was) changed.push(known);
      continue;
    }
    fresh.push(item);
  }
  return { fresh, reopened, changed };
}

/** 書き戻しの結果。⚠ 失敗の**理由を持って**返る(黙って終えない)。 */
export type WriteBackResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 本文を元ファイルへ書き戻す。
 *
 * ⚠ **許可を毎回確かめる**(`queryPermission` → 足りなければ `requestPermission`)。
 * 呼び出しは user のクリック直後でなければならない ── ブラウザは gesture の無い
 * `requestPermission` を拒否する。
 * ⚠ `createWritable()` は既定で**中身を切り詰める**(`keepExistingData: false`)。
 * 本文全体を書くのでそれが正しいが、**途中で失敗したらファイルは空になりうる**
 * ── だから失敗は必ず理由つきで返し、上位が可視化する。
 */
export async function writeBackFile(
  handle: LaunchedHandle,
  body: string,
): Promise<WriteBackResult> {
  if (typeof handle.createWritable !== 'function') {
    return { ok: false, reason: 'このブラウザはファイルへの書き戻しに対応していません' };
  }
  try {
    const want = { mode: 'readwrite' };
    let state = (await handle.queryPermission?.(want)) ?? 'granted';
    if (state !== 'granted') state = (await handle.requestPermission?.(want)) ?? 'denied';
    if (state !== 'granted') {
      return { ok: false, reason: 'ファイルへの書き込みを許可されませんでした' };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `書き込みの許可を確かめられませんでした: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let writable: WritableLike;
  try {
    writable = await handle.createWritable();
  } catch (e) {
    return {
      ok: false,
      reason: `ファイルを開けませんでした: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  try {
    await writable.write(body);
    await writable.close();
    return { ok: true };
  } catch (e) {
    // ⚠ **閉じない**まま抜けない(切り詰めたまま残る)。abort が無ければ close を試す
    try {
      if (typeof writable.abort === 'function') await writable.abort();
      else await writable.close();
    } catch {
      /* 後始末の失敗は元エラーを優先 */
    }
    return {
      ok: false,
      reason: `書き戻せませんでした: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
