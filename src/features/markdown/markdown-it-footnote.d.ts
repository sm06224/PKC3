/**
 * Type declaration for `markdown-it-footnote`(no official @types).
 *
 * 最小 shape:plugin function を default export として受け取り、
 * `md.use(plugin)` で attach する形。PR-W18 で HTML footnote 経路に投入。
 */
declare module 'markdown-it-footnote' {
  // ⚠ v15 の既定 export は**値**(呼び出し互換の callable)なので、型は
  // 名前付き export から取る(`import type MarkdownIt from` は型にならない)。
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}
