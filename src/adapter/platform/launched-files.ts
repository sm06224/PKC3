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
}

export class LaunchedFiles {
  private readonly byLid = new Map<string, Link>();

  /** lid ↔ ファイルを結ぶ。同じ lid への再登録は上書き(開き直しで handle が変わる)。 */
  remember(lid: string, handle: LaunchedHandle, name: string): void {
    this.byLid.set(lid, { handle, name });
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
export async function splitAlreadyOpen<T extends { handle: LaunchedHandle }>(
  items: readonly T[],
  launched: LaunchedFiles,
  isPresent: (lid: string) => boolean,
): Promise<{ fresh: T[]; reopened: string[] }> {
  const fresh: T[] = [];
  const reopened: string[] = [];
  for (const item of items) {
    const known = await launched.findLid(item.handle);
    // ⚠ 紐づけが残っていても **entry が消えていれば取り込み直す**
    //    (ゴミ箱へ入れた後に同じ md を開いたら、また開けるべき)
    if (known !== null && isPresent(known)) {
      reopened.push(known);
      continue;
    }
    fresh.push(item);
  }
  return { fresh, reopened };
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
      return { ok: false, reason: 'ファイルへの書込を許可されませんでした' };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `書込の許可を確かめられませんでした: ${e instanceof Error ? e.message : String(e)}`,
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
