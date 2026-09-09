/**
 * 🔴 **本文に素で書いた電話番号を、押せる形にする**(#278 段②)。
 *
 * ## user の指示と、そこから決めたこと
 *
 * > 「office、ファイラ兼エクスプローラ、シェル、PDF エディタ…、**連絡先**、
 * > タイマー、アラートは組み込みアプリでリリースしたい」(user 指示 2026-08-19)
 *
 * 連絡先の一覧では、frontmatter の `tel:` が既に押せる(`contacts.ts`)。
 * ⚠ ところが**本文にそのまま書いた番号**は素の文字のままで、電話の画面から
 * 掛けようとすると**指で選んで写す**しかない。
 *
 * 🔴 **既定は切**(user 裁定 2026-09-04 の推薦 C)── 何も選んでいない人の
 * 見え方は 1px も変わらない。入れた人だけが押せる字になる。
 *
 * ## ⚠ いちばん危ないのは「番号でないもの」を番号にすること
 *
 * `2026-09-09` を電話にしたら、**日付が押せる字になって本文が化ける**。
 * だから拾う条件を**狭く**する:
 *
 * | 拾う | 拾わない | なぜ |
 * |---|---|---|
 * | `090-1234-5678` | `2026-09-09` | 🔑 **先頭が `0` か `+`** ── 西暦は `2` で始まる |
 * | `03-1234-5678` | `1-2-3` | 数字の総数が **10 か 11**(国内)である |
 * | `+81-90-1234-5678` | `192-168-0-1` | `+` 始まりは 8〜15 桁。⚠ IP は 4 組 |
 * | `０９０－１２３４－５６７８` | `v1-2-3` | ⚠ **日本語入力のまま打った形**(§2 の教訓) |
 *
 * ⚠ 前後も見る ── 数字・英字・区切りが続いていたら**番号の一部ではない**
 * (`2026-090-1234-5678` を切り出さない)。
 *
 * ## ⚠ 何を `tel:` に載せるか
 *
 * 区切りを落とし、**半角の数字**にして載せる(`tel:09012345678`)。
 * 🔑 画面に出す字は**打ったまま**にする ── 全角で書いた人の本文を、
 * 描画が黙って半角へ直したように見せない。
 */

/** 半角へ写す(全角の数字・`＋`・`－`)。⚠ ここでしか写さない。 */
function toHalf(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  // ０(U+FF10)〜９(U+FF19)
  if (c >= 0xff10 && c <= 0xff19) return String.fromCharCode(c - 0xff10 + 0x30);
  if (ch === '＋') return '+';
  if (ch === '－' || ch === '‐' || ch === '−' || ch === '―') return '-';
  return ch;
}

const DIGIT = /[0-9０-９]/;
const SEP = /[-－‐−]/;
const PLUS = /[+＋]/;
/** ⚠ 前後にこれが在ったら、切り出した所は番号の途中である。 */
const STICKY = /[0-9０-９A-Za-z_@.\-－‐−+＋]/;

/** 見つけた 1 件。`start`/`end` は元の字の添字(`end` は含まない)。 */
export interface PhoneHit {
  readonly start: number;
  readonly end: number;
  /** 画面に出す字(**打ったまま**)。 */
  readonly raw: string;
  /** `tel:` に載せる字(半角・区切り無し)。 */
  readonly tel: string;
}

/**
 * 切り出した字が電話番号として通るか。通れば `tel:` に載せる字を返す。
 *
 * ⚠ **ここが唯一の判定**である ── 呼び側で足したり緩めたりしない
 * (CLAUDE.md §7「同じ判定が 2 か所に生えたら 1 つに寄せる」)。
 */
export function telOf(raw: string): string | null {
  const half = [...raw].map(toHalf).join('');
  // ⚠ 区切りが連続する形(`090--1234`)は打ち間違いなので拾わない
  if (/--/.test(half)) return null;
  const plus = half.startsWith('+');
  const body = plus ? half.slice(1) : half;
  if (body.startsWith('-') || body.endsWith('-')) return null;
  const digits = body.replace(/-/g, '');
  if (!/^[0-9]+$/.test(digits)) return null;
  if (plus) {
    // 国番号つき ── 8〜15 桁(E.164 の上限は 15)
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  /**
   * 🔴 **国内は「0 で始まる 10 桁か 11 桁」だけ**。
   * ⚠ ここを緩めると日付・版番号・郵便番号が全部番号になる ──
   *   `2026-09-09`(先頭が 2)/ `1-2-3`(桁が足りない)/ `123-4567`(先頭が 1)。
   */
  if (!digits.startsWith('0')) return null;
  return digits.length === 10 || digits.length === 11 ? digits : null;
}

/**
 * 字の中の電話番号を、前から順に拾う。⚠ **重ならない**(拾った先から進む)。
 *
 * 🔑 走査は**素朴に**する ── 正規表現 1 本で全角・半角・国番号・区切りを
 * まとめて書くと、次に読む人が直せない(そして直せない検査は腐る)。
 */
export function findPhones(text: string): PhoneHit[] {
  const out: PhoneHit[] = [];
  const chars = [...text];
  // ⚠ 添字は**コード単位**で返す(呼び側が `slice` する)ので、字ごとの長さを持つ
  const at: number[] = [];
  let pos = 0;
  for (const ch of chars) {
    at.push(pos);
    pos += ch.length;
  }
  at.push(pos);

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (!(PLUS.test(ch) || DIGIT.test(ch))) {
      i += 1;
      continue;
    }
    // ⚠ 直前が数字・英字・区切りなら、ここは番号の途中(頭ではない)
    if (i > 0 && STICKY.test(chars[i - 1]!)) {
      i += 1;
      continue;
    }
    let j = i;
    if (PLUS.test(chars[j]!)) j += 1;
    while (j < chars.length && (DIGIT.test(chars[j]!) || SEP.test(chars[j]!))) j += 1;
    // ⚠ 末尾の区切りは番号に含めない(`090-1234-5678-` の `-`)
    while (j > i && SEP.test(chars[j - 1]!)) j -= 1;
    // ⚠ 直後が英字・`@`・`.` なら、これは番号ではない(型番・メール・版番号)
    const after = chars[j];
    if (after !== undefined && /[A-Za-z_@.]/.test(after)) {
      i = j + 1;
      continue;
    }
    const raw = text.slice(at[i]!, at[j]!);
    const tel = raw === '' ? null : telOf(raw);
    if (tel !== null) {
      out.push({ start: at[i]!, end: at[j]!, raw, tel });
      i = j;
      continue;
    }
    i = Math.max(j, i + 1);
  }
  return out;
}
