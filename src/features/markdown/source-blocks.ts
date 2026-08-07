/**
 * 🔴 **原文の行だけを見て「囲い」の範囲と開放終端を出す**
 * (2026-08-05。ライブエディタ S2 / S5b / S6。設計 doc §5.6 / §7)。
 *
 * ## 3 つの用途を 1 本の走査で持つ(規則を 2 つ書かない)
 * ① **S2 の分割**: `:::` の囲いは描画の**後処理**で 1 塊に畳まれるので、
 *    token 由来の行範囲(1 行 = 1 範囲)を囲いの範囲へ集約するのに要る
 * ② **S5b の色変え**: 閉じ終端が来ていない行を見分ける
 * ③ **S6 の釣り合い検査**: 差し替えを確定するとき、囲いが壊れていないか
 *
 * ## 実測に基づく規則(2026-08-05)
 * | 原文 | 描画 |
 * |---|---|
 * | `:::note` … `:::` | `<section>` **1 塊**(中の段落を飲む) |
 * | `:::note` … (閉じ無し) | `<section>` 1 塊。**末尾まで飲む** |
 * | `:::toc` (閉じ有無どちらでも) | `<nav>` **1 塊**。中を飲まない = **囲いではない** |
 * | ```` ```js ```` … ```` ``` ```` | 1 塊。中は parse されないので範囲も 1 個 |
 *
 * ✅ **入れ子の `:::` は 2026-08-06 に直した**(`processSectionBlocks` が入れ子を
 * 数えていなかった既存バグ)。いまは `:::section` の中の `:::note` が入れ子の
 * `<section>` になり、ここが返す範囲と一致する ── **入れ子でも行の差し替えが開く**。
 *
 * ✅ **id 無しの `:::figure` も 2026-08-06 に直した**(user 報告 minor)── 以前は
 * ここに挙げていた食い違いの実例だったが、いまは畳むので**開く**。
 *
 * ✅ **Tier 1(`:::.hl` / `::: {.hl}` / `::: bareCls`)も 2026-08-07 に直した** ──
 * `:::` の直後が英字でないので走査器が**見落としていた**のに renderer は畳むので、
 * 釣り合いが崩れて全文の入力欄へ落ちていた(catalog の simple 列の記法である)。
 *
 * ✅ **畳まれない名前(`:::foo`)も 2026-08-07 に直した。**
 *
 * かつてここは「`:::name` を一律に囲いと見なす」形で、**renderer が畳まない名前**でも
 * 1 塊に畳んでいた。すると塊の数が合わず `buildBlockPartition` が落ち、
 * 行の差し替えを**開かない**(= 全文の入力欄へ退避する)。
 * 当時のこのヘッダは「ここに directive ごとの表を持ち込まない ── 判定が 2 か所に
 * なる」と書いており、**その懸念自体は正しかった**。
 *
 * 🔑 だから**表を持ち込むのではなく、判定そのものを共有した** ──
 * `directive-open.ts` の `classifyDirectiveOpen` を renderer とここが**同じに**引く。
 * 表は 1 つしか無いので「片方だけ古くなる」は起こらない。一致は
 * `tests/features/directive-open-parity.test.ts` が機械で守る。
 *
 * ⚠ **それでも食い違う形は残っている**:`{id="あ"}` のように**使えない id** を書いた
 * figure は renderer が literal のまま残すが、ここは形だけを見るので囲いと読む。
 * そういう本文では行の差し替えを開かない(壊れた分割の上で編集させるより安全側)。
 *
 * ⚠ **pure module**。browser API を使わない ── だから `markdown-render.ts` ではなく
 * `directive-open.ts`(markdown-it を持たない)から引いている。
 */

import { classifyDirectiveOpen } from './directive-open';

/** 囲いの範囲(行は 0 始まり・両端含む)。 */
export interface ContainerSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: 'fence' | 'directive';
  /** 閉じ終端が来ていない(= 末尾まで飲んでいる)。S5b の色変えの材料。 */
  readonly open: boolean;
  /** `:::` の名前(`note` / `section` / `details` …)。fence は言語。 */
  readonly name: string;
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const DIRECTIVE_OPEN = /^:::([A-Za-z][\w-]*)/;
const DIRECTIVE_CLOSE = /^:::\s*$/;

/**
 * 🔴 **開きかどうかは `directive-open.ts` が決める**(2026-08-07)。
 *
 * 直す前はここが `:::name` を**一律に囲いと見なして**いた。ところが renderer が
 * 畳むのは**知っている名前 + Tier 0(語彙)+ Tier 1(class 連結)**だけなので、
 * `:::foo` のような**畳まれない名前**では走査器だけが 1 塊に畳み、釣り合いが崩れて
 * **行ごとの編集が全文の入力欄へ落ちて**いた(= user の動線が落ちる)。
 *
 * ⚠ かつてこのヘッダは「**表を持ち込まない**(判定が 2 か所になる)」と書いていた。
 * その懸念は正しい ── だから**表を持ち込むのではなく、判定そのものを共有**した。
 * 表は `directive-open.ts` に 1 つだけ在り、renderer もここも同じものを引く。
 * 両者が一致していることは `tests/features/directive-open-parity.test.ts` が守る。
 */
function directiveOpenName(line: string): string | null {
  const kind = classifyDirectiveOpen(line);
  if (kind === null) return null;
  const named = DIRECTIVE_OPEN.exec(line);
  return named ? named[1]! : line.slice(3).trim();
}

/** その開きが**中を飲まない**か(`:::toc`。閉じ有無どちらでも 1 塊)。 */
function isSelfContained(line: string): boolean {
  return classifyDirectiveOpen(line) === 'self-contained';
}

/**
 * 最上位の囲いを文書順に返す。**入れ子は外側だけ**を返す
 * (中の囲いは外側の範囲に含まれるので、分割には外側だけが要る)。
 */
export function scanContainers(text: string): ContainerSpan[] {
  const lines = text.split('\n');
  const out: ContainerSpan[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const name = (fence[3] ?? '').trim().split(/\s+/)[0] ?? '';
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        // ⚠ 閉じは**同じ種類で同じ長さ以上**(``` の中の ~~~ は閉じない)
        const m = FENCE_OPEN.exec(lines[j]!);
        if (m && m[2]!.startsWith(marker[0]!) && m[2]!.length >= marker.length && (m[3] ?? '').trim() === '') {
          closed = true;
          break;
        }
        j += 1;
      }
      const end = closed ? j : lines.length - 1;
      out.push({ start: i, end, kind: 'fence', open: !closed, name });
      i = end + 1;
      continue;
    }
    const name = directiveOpenName(line);
    if (name !== null) {
      if (isSelfContained(line)) {
        // 中を飲まない ── 自分の行(と、あれば直後の閉じ)だけ
        const closer = lines[i + 1];
        const end = closer !== undefined && DIRECTIVE_CLOSE.test(closer) ? i + 1 : i;
        out.push({ start: i, end, kind: 'directive', open: false, name });
        i = end + 1;
        continue;
      }
      // 深さを数えて閉じを探す(入れ子は外側の範囲に含める)
      let depth = 1;
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const l = lines[j]!;
        if (DIRECTIVE_CLOSE.test(l)) {
          depth -= 1;
          if (depth === 0) {
            closed = true;
            break;
          }
        } else {
          // ⚠ 入れ子の数えも**同じ判定**を使う(Tier 1 の入れ子で深さを取りこぼさない)
          const inner = directiveOpenName(l);
          if (inner !== null && isSelfContained(l)) {
            /**
             * 🔴 **中を飲まない directive の「閉じ」は、その directive のもの**
             * (2026-08-05 実測)。`:::section` の中に `:::toc` / `:::` が在ると、
             * 描画側はその `:::` を **toc の閉じ**として食い、外側は閉じないまま
             * **末尾まで飲む**。ここで数えてしまうと走査器だけ「閉じた」と言い、
             * 分割が描画と食い違ったまま**通ってしまう**(= 壊れた分割で編集させる)。
             */
            const after = lines[j + 1];
            if (after !== undefined && DIRECTIVE_CLOSE.test(after)) j += 1;
          } else if (inner !== null) {
            depth += 1;
          }
        }
        j += 1;
      }
      const end = closed ? j : lines.length - 1;
      out.push({ start: i, end, kind: 'directive', open: !closed, name });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * その行を含む囲いを探す。無ければ null。
 * ⚠ 走査で組む(囲いは 1 文書あたり数〜数十なので線形で足りる)。
 */
export function containerAtLine(spans: readonly ContainerSpan[], line: number): ContainerSpan | null {
  for (const s of spans) if (line >= s.start && line <= s.end) return s;
  return null;
}

/** 行内の対になる記号。⚠ **fence の中では数えない**(コードの `**` は装飾ではない)。 */
const INLINE_PAIRS: readonly { open: string; close: string; name: string }[] = [
  { open: '**', close: '**', name: '太字' },
  { open: '~~', close: '~~', name: '打消' },
  { open: '==', close: '==', name: '強調印' },
  { open: '`', close: '`', name: 'コード' },
];

/**
 * 🔴 **開放終端(閉じ記号が来ていない)の行を出す**(S5b。user 提案 2026-08-05)。
 *
 * 返すのは「その行/囲いが**まだ閉じていない**」という事実だけ。原文には触らない。
 *
 * ⚠ **行内とブロックで意味が違う**(実測):
 * - 行内(`**` / `` ` `` / `==` / `~~` / `[`)は**描画も原文どおりに見える**ので
 *   害は小さい ── 色を付ける価値は「**待っていることを見せる**」ことにある
 * - 🔴 ブロック(```` ``` ```` / `:::`)は閉じないと**後続を飲み込む**。ここが本題
 */
export interface OpenEnd {
  /** 行(0 始まり)。囲いの場合は開始行。 */
  readonly line: number;
  readonly kind: 'inline' | 'fence' | 'directive';
  /** 何が閉じていないか(user に出す文言の材料)。 */
  readonly what: string;
}

export function findOpenEnds(text: string): OpenEnd[] {
  const spans = scanContainers(text);
  const out: OpenEnd[] = [];
  for (const s of spans) {
    if (s.open) {
      out.push({
        line: s.start,
        kind: s.kind,
        what: s.kind === 'fence' ? `\`\`\`${s.name}` : `:::${s.name}`,
      });
    }
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // 囲いの中(fence)は数えない。`:::` の中身は普通の本文なので数える
    const c = containerAtLine(spans, i);
    if (c && c.kind === 'fence') continue;
    if (c && c.kind === 'directive' && (i === c.start || i === c.end)) continue;
    for (const p of INLINE_PAIRS) {
      if (countOccurrences(lines[i]!, p.open) % 2 === 1) {
        out.push({ line: i, kind: 'inline', what: p.name });
      }
    }
    // `[` と `]` の釣り合い(リンクを打ちかけ)
    if (countOccurrences(lines[i]!, '[') !== countOccurrences(lines[i]!, ']')) {
      out.push({ line: i, kind: 'inline', what: 'リンク' });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

function countOccurrences(line: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = line.indexOf(needle, from);
    if (i < 0) return n;
    n += 1;
    from = i + needle.length;
  }
}
