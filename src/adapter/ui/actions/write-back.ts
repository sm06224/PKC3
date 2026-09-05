/**
 * 🔴 **元の md へ書き戻す**の中身(#732、2026-09-05 に `main.ts` から取り出した)。
 *
 * ## なぜ取り出したか
 *
 * 直す前は `main.ts` に直書きで、**飛んでいる書込を待たずに** disk の本文を読んでいた
 * ── つまり保存の直後に押すと、**保存前の本文が user のファイルへ書かれる**。
 * ⚠ 確認文言が言うとおり「**ファイルの元の内容は失われます(取り消せません)**」なので、
 *   これは PKC3 で**いちばん取り返しのつかない**読み違いである。
 * ⚠ そして `main.ts` は**どの test からも実行されない**(原文を読む test しか無い ──
 *   CLAUDE.md §2)。直しても、その直しを守る物が 1 つも無かった。
 * 🔑 だから**順番を持つ部分だけ**をここへ出す ── 待つ / 読む / 書く の 3 つは
 *   注入されるので、`tests/adapter/write-back.test.ts` が**書かれた中身**で見られる。
 *
 * ## ⚠ `settle` は optional にしない
 *
 * 渡し忘れても tsc が黙る形にすると、戻ってくる症状は
 * 「**保存したのに古い本文でファイルが上書きされた**」── いちばん気づけない壊れ方である
 * (2026-08-17 に書き出しで踏んだ形と同じ)。
 */

/** 書き戻しの結果(`platform/launched-files.ts` の `WriteBackResult` と同じ形)。 */
export type WriteBackOutcome = { ok: true } | { ok: false; reason: string };

export interface WriteBackDeps {
  /**
   * 🔴 **飛んでいる書込が着地するまで待つ**(`connectStoreEffects().settled()`)。
   * ⚠ **必須**(上の docstring)。
   */
  readonly settle: () => Promise<void>;
  /** disk の本文を読む。⚠ 画面が持っている下書きではない。 */
  readonly getBody: () => Promise<string | null>;
  /** user のファイルへ書く。 */
  readonly write: (body: string) => Promise<WriteBackOutcome>;
  /** 上書きの確認(取り消せない操作なので必ず通す)。 */
  readonly confirm: () => Promise<boolean>;
  /** 済んだことを画面へ出す。 */
  readonly done: (message: string) => void;
  /** 理由つきで断る / 失敗を出す。 */
  readonly fail: (message: string) => void;
  /** user に見せるファイル名(文言に出る)。 */
  readonly name: string;
}

/**
 * 確認 → **飛んでいる書込を待つ** → disk の本文を読む → ファイルへ書く。
 *
 * ⚠ **待つのは確認の後**である ── 確認で「やめる」を選ぶ人にまで走査や書込の
 *   着地を待たせない(押した瞬間に閉じるのが正しい)。
 * ⚠ そして**待つのは読む前**でなければならない ── 逆にすると、待っている間に
 *   着地した書込を読み落とす。
 */
export async function writeBackEntry(deps: WriteBackDeps): Promise<void> {
  if (!(await deps.confirm())) return;
  await deps.settle();
  const body = await deps.getBody();
  if (body === null) {
    deps.fail('本文が見つかりません(整理された可能性)');
    return;
  }
  const result = await deps.write(body);
  if (result.ok) deps.done(`書き戻しました: ${deps.name}`);
  else deps.fail(`${deps.name}: ${result.reason}`);
}
