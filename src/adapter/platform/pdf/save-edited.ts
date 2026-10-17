/**
 * PDF の窓で編集した PDF を、**新しい添付**にする(#275 段②-1b)── 本体側の判断。
 *
 * ## 経路(窓 → 棚 → ここ)
 *
 * ```
 * [窓]  worker が新しい PDF を作る → OPFS の棚へ bytes を置く → 鍵だけ放送(`edited`)
 * [本体] ここ ── 鍵を受ける → 棚から読む → 新しい添付を作る → 棚から捨てる → 窓へ結果を返す
 * ```
 *
 * Office の窓の保存(`../office/office-save-back.ts`)と同じ鎖である。棚の読み手は `office-stage.ts`
 * (`listStaged` / `readStaged` / `discardStaged`)をそのまま使う。置く側は `public/pdf/edit-stage.js`
 * (素の JS)── 別 realm なので共有できるのは**棚の名前と file の綴りだけ**で、
 * `tests/adapter/pdf-edit-stage.test.ts` が両方の file を読んで突き合わせる。
 *
 * ## 守る 5 つ
 *
 * 1. 🔴 **作るのは writer リースを持つタブだけ**(sqlite の `assets` 行を書けるのは 1 タブ ── `writer-lease.ts`)。
 * 2. 🔴 **元の添付は触らない。** 新しい添付を 1 つ足すだけ ── 元は書き換えない(設計 doc §1)。
 * 3. 🔴 **置き場は元の添付と同じフォルダ。つながりは張らない**(つながりは user のもの)。
 *    ⚠ **いま読んでいるノートの画面は動かさない**(`keepSelection`。#683 の「切り出したら読んでいたノートが消えた」)。
 * 4. **作れたのを確かめてから「できた」と言い、棚を捨てる**(`office-save-back.ts` の at-least-once と同じ向き)。
 *    ⚠ 断った回も棚は捨てる ── 窓は編集の状態を持ち続けるので、user はもう一度押せる(棚に残すと、押し直すたびに溜まる)。
 * 5. 棚の掃除: 書きかけの残骸と、引き取られないまま 1 時間を過ぎた置き物を消す(落ちた回の残り)。
 */
import { PDF_SAVED_NOTICE_TAIL } from '@features/pdf/pdf-attachments';
import {
  discardStaged,
  listStaged,
  readStaged,
  sweepStagedOrphans,
  type StageDir,
} from '../office/office-stage';
import type { PdfEditResult, PdfSession } from './pdf-window';

/** 棚の名前。⚠ `public/pdf/edit-stage.js` の `STAGE_DIR` と同じ綴り(Office の棚とは別)。 */
export const PDF_STAGE_DIR = 'pkc3-pdf-stage';

/** 引き取られないまま、この時間を過ぎた置き物は掃除で消す(ms)。 */
export const PDF_STAGE_STALE_MS = 60 * 60 * 1000;

export const SAVE_NOT_HOLDER =
  'このウィンドウには保存できません。ノートを編集できる PKC3 のウィンドウから、もう一度開いてください';
export const SAVE_NO_STAGE = '保存した内容を受け取れませんでした。もう一度押してください';
export const SAVE_BUSY = 'いまは保存できません。少し待ってから、もう一度押してください';

export interface SaveEditedDeps {
  /** 棚。⚠ OPFS が無い環境では `null`。 */
  readonly stage: () => Promise<StageDir | null>;
  /** 🔴 このタブが writer リースを持っているか。⚠ 昇格で変わるので呼ぶたびに読む。 */
  readonly isHolder: () => boolean;
  /** いま添付を足せるか(読む画面か、編集中。足すだけで選択も編集も動かさない)。 */
  readonly canWrite: () => boolean;
  /** 元の添付の置き場(フォルダの ID)。ルートなら `null`。 */
  readonly parentOf: (lid: string) => string | null;
  /**
   * 新しい添付を作る。作れたらそのノートの ID、作れなければ `null`(理由は呼び側が既に言っている)。
   * ⚠ 選択を動かさず、つながりは張らない(フォルダの中に置くだけ)。
   */
  readonly createAttachment: (args: {
    name: string;
    bytes: Uint8Array<ArrayBuffer>;
    parentLid: string | null;
  }) => Promise<string | null>;
  /** できたことを本体の画面へ言う(「開く」つき)。 */
  readonly notify: (text: string, openLid: string) => void;
  readonly now?: () => number;
}

export interface SaveEdited {
  /** 窓が「置いた」と言ってきた。投げない(結果は窓へ返す字)。 */
  receive(session: PdfSession, key: string): Promise<PdfEditResult>;
}

/** 名前を添付の名前にする(区切りを除き、`.pdf` で終える)。 */
function attachmentName(raw: string): string {
  const flat = raw.replace(/[\\/]/g, '_').trim();
  const base = flat === '' ? 'document' : flat;
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

export function createSaveEdited(deps: SaveEditedDeps): SaveEdited {
  const now = deps.now ?? ((): number => Date.now());
  /** 1 本ずつ(同じフォルダへ続けて作っても、順に作る)。 */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job);
    chain = next.catch(() => undefined);
    return next;
  };

  /** 掃除。⚠ 失敗しても保存の結果を変えない。 */
  async function sweep(dir: StageDir, keep: string): Promise<void> {
    try {
      await sweepStagedOrphans(dir, { now });
      for (const s of await listStaged(dir)) {
        if (s.key !== keep && now() - s.at > PDF_STAGE_STALE_MS) await discardStaged(dir, s.key);
      }
    } catch {
      /* 次の保存でまた掃除する */
    }
  }

  async function take(session: PdfSession, key: string): Promise<PdfEditResult> {
    // 🔴 窓の言い分(鍵)を信じて何でも読まない: 棚の中の、揃った置き物の鍵だけ
    const dir = await deps.stage();
    if (dir === null) return { ok: false, message: SAVE_NO_STAGE };
    if (!deps.isHolder()) {
      // 書けないタブ: この窓の置き物は誰も引き取らない(窓を開いたのはこのタブ)── 棚へ残さず捨てる(窓は押し直せる)
      await discardStaged(dir, key);
      return { ok: false, message: SAVE_NOT_HOLDER };
    }
    try {
      const save = (await listStaged(dir)).find((s) => s.key === key);
      if (save === undefined) return { ok: false, message: SAVE_NO_STAGE };
      const bytes = await readStaged(dir, save);
      if (bytes === null) return { ok: false, message: SAVE_NO_STAGE };
      if (!deps.canWrite()) return { ok: false, message: SAVE_BUSY };
      const name = attachmentName(save.name);
      const parentLid = session.lid === null ? null : deps.parentOf(session.lid);
      const lid = await deps.createAttachment({ name, bytes, parentLid });
      if (lid === null) return { ok: false, message: '保存できませんでした。もう一度押してください' };
      const message = `「${name}」${PDF_SAVED_NOTICE_TAIL}`;
      deps.notify(message, lid);
      return { ok: true, message };
    } catch {
      return { ok: false, message: '保存できませんでした。もう一度押してください' };
    } finally {
      await discardStaged(dir, key);
      await sweep(dir, key);
    }
  }

  return { receive: (session, key) => serial(() => take(session, key)) };
}

/**
 * 棚を開く。⚠ 無い環境では `null`(落とさない)。作る側(窓)が先に作るので、`create: false` で見るだけ。
 * 棚の型は Office の棚と同じ(`StageDir`)。
 */
export async function openPdfStageDir(storage?: {
  getDirectory(): Promise<{
    getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<StageDir>;
  }>;
}): Promise<StageDir | null> {
  const s =
    storage ??
    (globalThis.navigator as unknown as { storage?: typeof storage } | undefined)?.storage;
  if (!s || typeof s.getDirectory !== 'function') return null;
  try {
    const root = await s.getDirectory();
    return await root.getDirectoryHandle(PDF_STAGE_DIR, { create: false });
  } catch {
    return null;
  }
}
