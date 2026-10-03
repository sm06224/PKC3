/**
 * 添付を **Office の別窓**で開く(#88 / 統合設計 O3-b)。
 *
 * 🔴 **`main.ts` に書かない。** あそこは原文を `readFileSync` で読む test しか無く、
 * 判断を置くと「全 tests 緑のまま取り違える」(CLAUDE.md 2026-08-08)。
 * ここへ取り出しておけば、**判断そのものを test できる**。
 * `main.ts` の仕事は依存を渡す 3 行だけにする。
 *
 * ## 何を守るか
 *
 * - 🔑 **押しても何も起きない、を作らない。** 開けないときは**必ず理由**を返す
 * - ⚠ **窓を開くのは同期のうち**(`await` を挟むと user gesture が切れて遮断される)。
 *   したがって「能力が足りるか」「一式が在るか」は**先に手元の値で**判定し、
 *   添付の bytes は**窓を開いたあと**に放送で渡す(`OfficeWindow` の作り)
 * - ⚠ bytes の取得に失敗しても、窓は既に開いている ── **窓側が Start Center を出す**
 *   ので黙って壊れはしないが、呼び出し側へは失敗を返す
 */
import {
  officeEntry,
  readOfficeCapability,
  type OfficeCapability,
} from '../../../features/office/office-entry';
import {
  officeImageFileName,
  pickOfficeImages,
  skippedImagesNotice,
  type OfficeImageCandidate,
} from '../../../features/office/office-images';
import { SHADOW_GONE_NOTICE, SHADOW_OPENED_NOTICE } from '../../../features/office/office-shadow';
import type { OfficeDocumentSource, OfficeImagePayload, OfficeWindow } from './office-window';

/** 添付 1 件ぶんの、開くのに要る情報。 */
export interface OfficeTarget {
  readonly name: string;
  readonly mime: string;
  readonly assetKey: string;
  /**
   * 🔴 **どのノートの添付か**(#205)。⚠ **これを渡さないと、その窓での保存は
   * 「新規作成」になり、元のノートは更新されない**(新しい添付ノートが 1 件増える)。
   * ⚠ 2026-08-16 まで、開く経路は lid を**3 段で落としていた**
   * (描画 → 属性 → binder)ので、4 面まとめて直した。
   */
  readonly lid?: string;
}

export type OpenOfficeResult =
  /**
   * 開いた / 開く指示を出した。
   * 🔴 `settled` が在るとき(#1228 段 2)は、**まだ決まっていない**(控えの確認を出している)── 本当の結果は
   * `settled` が返す。⚠ 即答の `reused` は当てにしない(確認の後で決まる)。`cancelled` は user が確認で
   * 「やめる」を選んだ(何も開かない)。
   */
  | {
      readonly ok: true;
      readonly reused: boolean;
      readonly settled?: Promise<OpenOfficeResult>;
      readonly cancelled?: boolean;
    }
  /** 開けなかった ── `message` はそのまま user へ出せる文にする。 */
  | { readonly ok: false; readonly reason: 'not-office' | 'unsupported' | 'not-installed' | 'no-bytes'; readonly message: string };

/**
 * 🔴 **保存していない編集の控え(影)の口**(#1228 段 2)。`office-shadow-shelf.ts` の `OfficeShadows` に
 * 「訊く」(`ask`)を足した形 ── 画面の確認は呼び側(`main.ts`)が持つ。⚠ 全部**投げない**こと。
 */
export interface OfficeShadowPort {
  /** **同期で**答える: 控えが在るかもしれないか。偽なら今までどおり**同期で窓を開ける**。 */
  readonly mayHave: (lid: string) => boolean;
  /** 訊くべき控え(正本より新しい物だけ)。無ければ `null`。 */
  readonly find: (lid: string) => Promise<{ readonly at: number; readonly ext: string } | null>;
  readonly readBytes: (lid: string) => Promise<Uint8Array | null>;
  /** 控えを消す(「保存済みの版で開く」)。 */
  readonly discard: (lid: string) => Promise<void>;
  /** 確認を出す。`null` = やめる(何も開かない)。 */
  readonly ask: (offer: { readonly at: number; readonly ext: string }) => Promise<'shadow' | 'saved' | null>;
}

export interface OfficeOpenerDeps {
  /** 🔴 編集の控えの口(#1228 段 2)。⚠ 省けば訊かない(今までと同じ)。 */
  readonly shadow?: OfficeShadowPort;
  readonly officeWindow: OfficeWindow;
  /** 一式が入っているか。⚠ **同期で答えられる値**(起動時と設置後に更新した控え)。 */
  readonly isPackInstalled: () => boolean;
  /** 添付の実体。窓を開いたあとに読む(同期を邪魔しない)。 */
  readonly readAsset: (assetKey: string) => Promise<Uint8Array | null>;
  readonly capability?: () => OfficeCapability;
  /**
   * 🔴 **「挿入 → 画像」に並べる候補**(#146)。ノート(lid)の本文が使っている画像を返す。
   * ⚠ 省けば何も並べない(今までと同じ)。⚠ **投げない**こと(`office-note-images.ts`)。
   */
  readonly listNoteImages?: (lids: readonly string[]) => Promise<readonly OfficeImageCandidate[]>;
  /** いま開いているノート(主の枠)。⚠ 添付のノートと違うことがある(横に留めた枠から押したとき)。 */
  readonly openNoteLid?: () => string | null;
  /**
   * 🔴 **その文書の添付を、本文で使っているノート**(#146)。
   *
   * ⚠ 添付は**単独のノート**で、ノートとの結びつきは本文の `asset:` だけである。だから
   * 文書(添付ノート)を開いたとき、画像を持っているのは**その文書を本文に載せたノート**の側 ──
   * 引かないと、いちばん普通の動線(ノートに画像と docx を貼り、docx を開く)で
   * 一覧が**空のまま**になる。⚠ 投げない / 上限は呼び側(数件で切る)。
   */
  readonly usersOfAsset?: (assetKey: string) => Promise<readonly string[]>;
  /**
   * 🔴 **そのノートの「いま」の添付 key**(#1228 穴①)。窓の中で保存すると添付は
   * **別の key に差し替わる**ので、停止の帯の「読み込み直す」で窓が作り直されたとき、
   * 最初に開いた key のままだと**保存前の版**を渡してしまう(その版へ上書き保存すると
   * 先の保存が消える)。⚠ 省くか `null` なら開いた時の key で読む。⚠ 投げない。
   */
  readonly currentAssetKey?: (lid: string) => Promise<string | null>;
  /** 並べなかった件数を user へ言う 1 行の出口(`showStatus`)。 */
  readonly notify?: (text: string) => void;
}

export interface OfficeOpener {
  /** ⚠ **click ハンドラの同期の中から呼ぶこと。** */
  open(target: OfficeTarget): OpenOfficeResult;
}

export function createOfficeOpener(deps: OfficeOpenerDeps): OfficeOpener {
  const capability = deps.capability ?? ((): OfficeCapability => readOfficeCapability(globalThis));
  /**
   * 文書の bytes と画像の候補は**並べて**引く(画像のせいで文書が遅れない)。
   * 🔑 最初に開くときと、窓が作り直されて読み直すときの**同じ 1 本**(§7)。
   */
  const load = async (target: OfficeTarget): Promise<OfficeDocumentSource | null> => {
    const [bytes, images] = await Promise.all([
      deps.readAsset(target.assetKey).catch(() => null),
      collectImages(deps, target),
    ]);
    if (bytes === null || bytes.byteLength === 0) return null;
    return { bytes, images };
  };
  /**
   * 🔴 **保存していない編集の控えの版を読む**(#1228 段 2)。⚠ 読めなければ `null`(消えた / 空)──
   * 呼び側は**保存済みの版へ戻る**(控えが消えたからといって、開けなくしない)。
   */
  const loadShadow = async (target: OfficeTarget): Promise<OfficeDocumentSource | null> => {
    const lid = target.lid ?? '';
    if (deps.shadow === undefined || lid === '') return null;
    const bytes = await deps.shadow.readBytes(lid).catch(() => null);
    if (bytes === null || bytes.byteLength === 0) return null;
    return { bytes, images: await collectImages(deps, target), fromShadow: true };
  };
  /** 控えで開いた窓が読み直すとき、まだ控えが在れば**控えを**、無ければ保存済みの最新を渡す(`refresh`)。 */
  const reload = async (target: OfficeTarget, fromShadow: boolean): Promise<OfficeDocumentSource | null> => {
    if (fromShadow) {
      const s = await loadShadow(target);
      if (s !== null) return s;
    }
    const key = target.lid ? await deps.currentAssetKey?.(target.lid).catch(() => null) : null;
    return load(key ? { ...target, assetKey: key } : target);
  };
  /** 窓を開き、文書を後渡しする。⚠ **同期のうちに窓を開く**(user gesture を切らない)。 */
  const openNow = (target: OfficeTarget, wantShadow: boolean): OpenOfficeResult => {
    // 🔑 **ここで開く**(同期 ── user gesture を切らない)。
    //    ⚠ `open()` を 2 回呼んではいけない。1 回目の時点では生存通知が
    //    まだ届いておらず `isProbablyOpen()` が false なので、**窓が 2 つ開く**。
    //    宣言してから `provideDocument()` で後渡しする。
    const outcome = deps.officeWindow.open({ name: target.name, expectDocument: true });
    void (async () => {
      // 🔴 控えの版を頼まれたら先に読む。読めなければ保存済みの版へ戻る(開けなくしない)
      const shadowSrc = wantShadow ? await loadShadow(target) : null;
      const loaded = shadowSrc ?? (await load(target));
      if (loaded === null) return;
      const { bytes, images } = loaded;
      const fromShadow = shadowSrc !== null;
      // 🔴 何で開くかを言う(#1228 段 2)。⚠ **開けた版**を言う ── 控えを頼まれて読めなかったときは、保存済みの版で開くと言う
      if (wantShadow) deps.notify?.(fromShadow ? SHADOW_OPENED_NOTICE : SHADOW_GONE_NOTICE);
      // 🔴 **合言葉(= このノートの lid)を預ける**(#205)── 保存が戻って
      //    きたとき、**このノートを更新する**ために要る。
      //    ⚠ 無ければ空文字 = 窓は「新規作成」として返す(新しい添付ノートになる)。
      //    🔑 **key ではなく lid を預ける** ── 2 回目の保存の時点で key は既に
      //    変わっている(1 回目で差し替わる)ので、key を預けると迷子になる。
      //    どの asset を差し替えるかは、**そのノートの現在の frontmatter**が決める
      // 🔴 作り直された窓が文書を求め直したとき(#1228 穴①)、**いま**の添付を引き直す口を添える
      deps.officeWindow.provideDocument(
        target.name,
        bytes,
        target.lid ?? '',
        images,
        () => reload(target, fromShadow),
        fromShadow,
      );
    })();
    return { ok: true, reused: outcome.kind === 'already-open' };
  };

  /** いま控えを訊いているノート。⚠ 同じノートの 2 回目の押しで確認を重ねない。 */
  const asking = new Set<string>();
  /**
   * 🔴 **控えが在れば訊いてから開く**(#1228 段 2、裁定 Q1 = A)。
   * ⚠ ここへ来るのは `mayHave` が真のときだけ(= 控えが在るかもしれない)。**確認の答えを押した click の続き**で窓を開く
   * (確認自体が user の操作なので、ポップアップ遮断に当たらない)。控えが無かったときは同期ではなくなる(1 回の非同期の後)。
   */
  const askThenOpen = async (target: OfficeTarget, lid: string): Promise<OpenOfficeResult> => {
    const sh = deps.shadow!;
    try {
      const offer = await sh.find(lid);
      if (offer === null) return openNow(target, false);
      let answer: 'shadow' | 'saved' | null;
      try {
        answer = await sh.ask(offer);
      } catch {
        // 確認を出せなかった ── 控えは触らず、今までどおり保存済みの版で開く(開けなくしない。控えは残る)
        return openNow(target, false);
      }
      if (answer === null) return { ok: true, reused: false, cancelled: true };
      if (answer === 'saved') {
        await sh.discard(lid);
        return openNow(target, false);
      }
      return openNow(target, true);
    } finally {
      asking.delete(lid);
    }
  };

  return {
    open(target: OfficeTarget): OpenOfficeResult {
      const entry = officeEntry({
        mime: target.mime,
        fileName: target.name,
        packInstalled: deps.isPackInstalled(),
        capability: capability(),
      });
      if (entry.kind === 'none') {
        return { ok: false, reason: 'not-office', message: 'この添付は Office 文書ではありません' };
      }
      if (entry.kind === 'unsupported') {
        return { ok: false, reason: 'unsupported', message: entry.reason };
      }
      if (entry.kind === 'setup') {
        return { ok: false, reason: 'not-installed', message: entry.reason };
      }

      // 🔴 **保存していない編集の控えが在るかもしれないときだけ**、訊いてから開く(#1228 段 2)。
      //    ⚠ 開いている窓へ頼むとき(`isProbablyOpen`)は訊かない ── 控えはその窓が書いた物で、窓は
      //    自分の保存していない変更を自分で確かめて訊く(穴②)。ここでも訊くと**同じ文書を 2 度訊く**
      const lid = target.lid ?? '';
      if (
        deps.shadow !== undefined &&
        lid !== '' &&
        !deps.officeWindow.isProbablyOpen() &&
        deps.shadow.mayHave(lid)
      ) {
        // 同じノートの確認が出ている間の 2 回目の押しは、重ねずに畳む(1 つ目の答えが開く)
        if (asking.has(lid)) return { ok: true, reused: false, cancelled: true };
        asking.add(lid);
        return { ok: true, reused: false, settled: askThenOpen(target, lid) };
      }
      return openNow(target, false);
    },
  };
}

/**
 * 🔴 **窓へ渡す画像を選んで読む**(#146)。
 *
 * - 引く元は **文書のノート** / **いま開いているノート** / **その文書を本文に載せたノート**
 * - 合計の上限で**大きい順に外す**(`pickOfficeImages`)── 外した件数は user へ **1 度だけ**言う
 * - bytes は**選ばれた物だけ**読む(読めなかった 1 枚は黙って外さず、件数に足す)
 * - 0 件なら `[]`(窓へ何も渡さない)
 * ⚠ **投げない** ── 画像のしくじりで文書まで開かなくなってはならない。
 */
async function collectImages(
  deps: OfficeOpenerDeps,
  target: OfficeTarget,
): Promise<OfficeImagePayload[]> {
  if (!deps.listNoteImages) return [];
  try {
    const users = await (deps.usersOfAsset?.(target.assetKey) ?? Promise.resolve([])).catch(
      () => [] as readonly string[],
    );
    // 🔑 文書のノート → いま開いているノート → 文書を本文に載せたノート の順(重複は引く側で 1 件にする)
    const lids = [target.lid, deps.openNoteLid?.(), ...users].filter(
      (l): l is string => typeof l === 'string' && l !== '',
    );
    if (lids.length === 0) return [];
    const { picked, skipped } = pickOfficeImages(await deps.listNoteImages(lids));
    const out: OfficeImagePayload[] = [];
    let unread = 0;
    for (const c of picked) {
      const bytes = await deps.readAsset(c.key).catch(() => null);
      if (bytes === null || bytes.byteLength === 0) {
        unread += 1;
        continue;
      }
      out.push({ name: officeImageFileName(c), bytes });
    }
    const note = skippedImagesNotice(skipped, unread);
    if (note !== '') deps.notify?.(note);
    return out;
  } catch {
    return [];
  }
}
