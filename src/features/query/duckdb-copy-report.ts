/**
 * 🔴 **`.sqlite` を DuckDB へ写したとき、「写せなかった物 / 形が変わった物」を画面で言う**(#682 段④d の着地後レビュー D3 / D6 / D7)。
 *
 * ## ① 何が起きていたか
 *
 * 写せなかった表(大きすぎる / 名前が空)は、**引いた回が落ちたときの断り文にしか**出なかった ──
 * 落ちなかった回(別の表を引いた・構造を見た)には 1 字も出ず、user は「在るはずの表が無い」ままだった。
 * ビューは写さないのに、**どこにもそう書いていなかった**。表を全部 VARCHAR で写した表(`asText`)も黙っていた。
 *
 * ## ② 何を出すか(出す場所は 3 つ。字は**ここ 1 か所**から ── §7)
 *
 * | 場所 | 出す物 |
 * |---|---|
 * | 選んでいる間の帯(`noteLine`) | 写せなかった表 / 写らないビュー / 全列を文字で写した表 |
 * | 構造ノート(markdown) | 写せなかった表 / ビュー + 型を 3 つへ丸めていること |
 * | つながり図 | 写せなかった表 / ビュー |
 *
 * 🔑 **並べているか**(`multi`)で逃げ道の字が変わる(D7):1 つだけなら「内蔵の sqlite なら引けます」、
 *   並べているときは engine が DuckDB に固定なので、**「file を 1 つに戻すと」**と言う(押せない道へ誘わない)。
 */

/** 写せなかった表・ビュー 1 つ。 */
export interface DuckDbRefusedItem {
  /** 器での名前(user が打つ名前。⚠ 空のことがある ── 名前の無い表)。 */
  readonly name: string;
  /** ビューか(ビューは行を持たないので写さない)。 */
  readonly view: boolean;
  /** 理由(字)。 */
  readonly why: string;
}

/**
 * 器へ写した結果の報告。⚠ `load`(器へ写す)が作り直すたびに**新しく作る**。
 *
 * 🔑 器と同じ寿命 ── 器が畳まれた後は空へ戻す(`DuckDbRunner.dropStaleRefused`)。
 */
export interface DuckDbCopyReport {
  /** 写せなかった表・ビュー(読んだ順)。 */
  readonly refused: readonly DuckDbRefusedItem[];
  /** 🔴 **全列を VARCHAR で写した表**の名前(型に入れると値が変わる表 / 型が合わなかった表)。 */
  readonly asText: readonly string[];
  /** `.sqlite` を写したか(= 構造の型は元の宣言で、器の中では 3 つへ丸めている)。 */
  readonly sqlite: boolean;
  /** 🔴 BLOB の列を持つ表を写したか(base64 の字で入る ── 案内に BLOB の注記を出すのは、在るときだけ)。 */
  readonly blob: boolean;
}

/** 何も写していない / 何も言うことが無い報告。 */
export const EMPTY_DUCK_COPY: DuckDbCopyReport = { refused: [], asText: [], sqlite: false, blob: false };

/**
 * 🔴 **内蔵の sqlite へ逃げる道の 1 文**(D7)。
 *
 * ⚠ 並べているときは engine が **DuckDB に固定**(`sql-engine.ts`)で、選び所の「内蔵の sqlite」は薄い字になる ──
 *   「内蔵の sqlite なら引けます」と言うと**押せない道を指す**。並べている file を 1 つに戻せば選べるようになる。
 */
export function sqliteFallbackHint(multi: boolean): string {
  return multi ? 'ファイルを 1 つに戻すと内蔵の sqlite で実行できます' : '内蔵の sqlite なら実行できます';
}

/** 名前を画面の字にする(空は「名前の無い表」)。 */
const shown = (name: string): string => (name === '' ? '(名前の無い表)' : name);

/**
 * 写せなかった表 / 写らないビューを、1 行にする。⚠ 無ければ `''`(出さない)。
 * 🔑 逃げ道(`sqliteFallbackHint`)は末尾に 1 度だけ添える(表ごとには言わない)。
 */
export function refusedLine(copy: DuckDbCopyReport, multi: boolean): string {
  const tables = copy.refused.filter((r) => !r.view).map((r) => shown(r.name));
  const views = copy.refused.filter((r) => r.view).map((r) => shown(r.name));
  const parts: string[] = [];
  if (tables.length > 0) parts.push(`コピーできなかった表: ${tables.join('、')}`);
  if (views.length > 0) parts.push(`コピーされないビュー: ${views.join('、')}(ビューはコピーしません)`);
  if (parts.length === 0) return '';
  return `${parts.join(' / ')}(${sqliteFallbackHint(multi)})`;
}

/** 全列を文字で写した表を、1 行にする。⚠ 無ければ `''`。 */
export function asTextLine(copy: DuckDbCopyReport): string {
  if (copy.asText.length === 0) return '';
  return `全部の列を文字にした表: ${copy.asText.map(shown).join('、')}(数として使うときは CAST で変えてください)`;
}

/**
 * 🔴 **選んでいる間の帯に足す字**。⚠ 無ければ `''`。
 * 🔑 2 つの行を ` / ` で繋ぐ(帯は 1 行 ── 行を増やして表を押し下げない)。
 */
export function copyBandNote(copy: DuckDbCopyReport | null, multi: boolean): string {
  if (copy === null) return '';
  return [refusedLine(copy, multi), asTextLine(copy)].filter((x) => x !== '').join(' / ');
}

/**
 * 🔴 **構造の型の注記**(D6)。構造ノート・つながり図が出す型は**元の `.sqlite` の宣言**だが、
 * DuckDB は 3 つ(BIGINT / DOUBLE / VARCHAR)へ丸めて持つ ── 言わないと、`CAST` を書く user が
 * 「`DECIMAL(10,2)` と書いてあるのに」と迷う。
 */
export const DUCKDB_ROUNDED_TYPES_NOTE =
  '型は元の .sqlite の宣言です。コピー先では BIGINT / DOUBLE / VARCHAR の 3 つに丸めています。';

/**
 * 🔴 **構造ノートの末尾に足す行たち**(見出しの無い文)。⚠ 無ければ空の配列。
 * 🔑 写せなかった行は**表の構造に出ない**ので、ここで言う(出さないと、ノートを AI へ貼った人が
 *   「この DB に在る表は、これで全部」と読む)。
 */
export function copyDigestNotes(copy: DuckDbCopyReport | null, multi: boolean): string[] {
  if (copy === null) return [];
  const out: string[] = [];
  const refused = refusedLine(copy, multi);
  if (refused !== '') out.push(refused);
  if (copy.sqlite) out.push(DUCKDB_ROUNDED_TYPES_NOTE);
  return out;
}
