/**
 * 関係の種類(#185 / 台帳 #180 の A-7)── **正本はここ 1 つ**。
 *
 * 🔴 直す前は **3 か所に散っていた**:
 * - `features/relation/tree.ts` の `STRUCTURAL = 'structural'`(居場所の判定)
 * - `features/import/pkc2-convert.ts` の `KNOWN_RELATION_KINDS`(取込の受理)
 * - `adapter/state/app-state.ts` の `kind: 'structural' as const` 2 か所(作る側)
 *
 * ⚠ 種類を 1 つ足すとき、この 3 つのうち**どれかを直し忘れる**のが確定していた
 * (§7「同じ値が複数の場所にある」)── 実際、取込は 5 種類を知っているのに、
 * user が作れるのは `structural` だけで、**残り 4 種類は取り込めるのに作れない**
 * という非対称がそのまま残っていた。
 *
 * ⚠ **名前は変えない**(PKC2 の取込が同じ語で来る = データ契約)。
 */

/** 居場所(フォルダの親子)。⚠ **この 1 種類だけが特別** ── ファイラの階層になる。 */
export const STRUCTURAL: RelationKind = 'structural';

/**
 * 受け入れる種類の全部。⚠ **並びが画面の並び**(選ぶ欄の順)。
 * 🔑 居場所を先頭にしない ── user が手で作るのは意味の関係が主で、
 * 居場所はファイラの操作で付くほうが自然である。
 */
export const RELATION_KINDS = [
  'semantic',
  'categorical',
  'temporal',
  'provenance',
  'structural',
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * 画面に出す名前。⚠ **user に `semantic` と見せない**。
 * ⚠ ここを変えたらマニュアルも直す(`docs-parity`)。
 */
export const RELATION_LABELS: Readonly<Record<RelationKind, string>> = {
  semantic: '関連',
  categorical: '分類',
  temporal: '時系列',
  provenance: '出典',
  structural: 'フォルダ',
};

export function isRelationKind(v: string): v is RelationKind {
  return (RELATION_KINDS as readonly string[]).includes(v);
}

/**
 * user が**手で作れる**種類。⚠ 居場所は除く ── あちらはファイラの
 * 並べ替え / 移動が作るもので、ここから作れると**2 つの作り方**が生まれる(§7)。
 */
export const CREATABLE_KINDS: readonly RelationKind[] = RELATION_KINDS.filter(
  (k) => k !== STRUCTURAL,
);

/**
 * 🔴 **向きに意味が無い種類**(#1163 依頼 319。Gemini の裁定 A)。A から B へ「関連」があるとき、
 * B から A への「関連」は同じつながりなので足させない(右のペインに 2 行並び、どちらを消すか迷う)。
 * ⚠ 向きに意味がある種類(出典・時系列・分類)は、逆向きを今までどおり許す。
 */
export const DIRECTIONLESS_KINDS: readonly string[] = ['semantic'];

/** 画面に出す名前(知らない種類はそのまま出す ── 黙って消さない)。 */
export function relationLabel(kind: string): string {
  return isRelationKind(kind) ? RELATION_LABELS[kind] : kind;
}
