/**
 * revision の同一内容 skip(P5)用の軽量 hash。FNV-1a 32bit を offset basis
 * 違いで 2 本走らせて 64bit hex にする(BigInt を避ける ── 200KB 級 body でも
 * ms オーダー)。同一文字列の同一性判定にだけ使う(暗号強度は不要。衝突の
 * 帰結は「新しい revision が 1 件 skip される」で、データ破壊ではない)。
 * PKC2 は content_hash field を作って一度も使わなかった ── PKC3 は最初から使う。
 *
 * 🚫 **この関数は言語を替えてはならない**(rust-wasm-strategy §5-2 / F1、実測で確認):
 * `charCodeAt` は **UTF-16 コードユニット**を回しており、Rust/wasm の UTF-8 バイト
 * とは非 ASCII で必ず値が違う(実測: `'日本語'` → JS `5406374eb7fb3549` /
 * wasm `805f5ce7ad9992bc`)。この値は **DB の `revisions.content_hash` 列に
 * 永続化済み**で、復元時の整合性検証(storage-worker の getRevision)と
 * checkpoint の同一内容 skip が読む。実装言語を替えた瞬間、既存 DB の全行が
 * 「知らない hash」になり **履歴復元が全滅**する。
 * 替えるなら schema migration + user_version bump が前提。
 * 恒久ルール: **UTF-16 依存の値が永続化されている関数は言語を替えない。**
 */
export function contentHash64Hex(s: string): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0xcbf29ce4 | 0; // 64bit offset basis の上位 32bit を第 2 種に流用
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}
