/**
 * 本文の改行コードを決める(#1384)。**CRLF が 1 つでも在れば CRLF、無ければ LF**。
 *
 * 🔑 書き換え系が「新しく足す行」に使う改行を、本文の流儀に合わせるための 1 つの判定。
 * ⚠ 既存の行の改行は触らない(混在した本文を 1 種類に揃えて join しない ── `body-rewrite.ts` の注釈)。
 * ⚠ 向きは常に「CRLF 寄り」── 足した行だけが LF で浮かない側へ倒す。ここ 1 か所を直せば全部の経路が揃う。
 * 純粋関数の leaf module(他の markdown module を import しない)。`text-ops.ts` からも再 export する。
 */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
