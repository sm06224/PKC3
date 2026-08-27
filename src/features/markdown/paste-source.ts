/**
 * 🔴 **貼り付けたとき、どの形を読むか**(user 指示 2026-08-25、3 通目)。
 *
 * > 「**無言でHTMLペーストを取得する以外のスイッチ経路を用意するなど、
 * > 実用とデバッグを兼用する工夫をしなさい / そのために設定やフラグはあるんだから!**」
 *
 * ## なぜ切替が要るのか(調べて分かったこと。2026-08-25)
 *
 * クリップボードには**同じ内容が複数の形**で載る(`text/html` / `text/rtf` /
 * `text/plain`)。⚠ **どれが忠実かは出し手による**:
 *
 * - **生成 AI の「コピー」ボタンは、近年 markdown 原文ではなくリッチな形を載せる**
 *   ようになった(OpenAI の利用者フォーラムに苦情が並んでいる)。⚠ そのぶん
 *   **Alt / Option を押しながらコピーすると markdown 原文が載る**という逃げ道もある
 * - `text/rtf` を**取れるのは Chromium 系**である。Firefox は
 *   `text/rtf` の受け渡しに既知の不具合を抱えている(Bugzilla 938991 / 1246194)
 * - 出し手が **RTF しか載せない**ことも、**HTML しか載せない**こともある
 *
 * 🔑 つまり「自動でいちばん良いものを選ぶ」は**当たらない回がある** ── そのとき
 * user が**自分で切り替えられなければ、直しようがない**。だから設定にする。
 *
 * ## 設定(ここ)とフラグの役割分担
 *
 * | | 何をするか |
 * |---|---|
 * | **設定**(この file の 4 択) | **どれを読むか**を決める ── user のもの、消さない |
 * | **フラグ** `paste.inspect` | **何が届いて、どれを使ったか**を画面に出す ── 開発者・パワーユーザーのもの、いつか畳む |
 *
 * 🔑 **2 つで 1 組**である ── フラグで「HTML が 12KB 届いていて、それを使った」と
 * 見えるから、user は設定でどれに切り替えればよいか**分かる**。
 * ⚠ 切替だけだと当てずっぽうになり、表示だけだと直せない。
 *
 * ## ⚠ 判定はこの file の 1 か所だけ
 *
 * 呼び側(`binder.ts`)で条件を足さない ── 足すと「経路ごとに挙動が違う」形になる
 * (CLAUDE.md §7)。
 */

/**
 * 設定の 4 択。⚠ **flag ではない**(flag 枠 15 とは別)── これは user の判断である。
 * ⚠ 並びは「おまかせ → 明示 → 何もしない」。既定は先頭の `auto`。
 */
export const PASTE_SOURCES = [
  {
    id: 'auto',
    label: '自動',
    hint: 'ウェブページの形を優先し、無ければリッチテキストを読みます(おすすめ)',
  },
  {
    id: 'html',
    label: 'ウェブページの形だけ',
    hint: 'リッチテキストは読みません。リッチテキストの変換が合わないときに',
  },
  {
    id: 'rtf',
    label: 'リッチテキストを優先',
    hint: 'ウェブページの形より先にリッチテキストを読みます。生成 AI の貼付が崩れるときに',
  },
  {
    id: 'html-fence',
    label: 'ウェブページの形をそのまま(html の囲み)',
    hint: '見た目のまま残します。色や段組が消えては困るときに(あとで直すには HTML を触ります)',
  },
  {
    id: 'plain',
    label: '変換しない',
    hint: 'コピーした文字をそのまま貼ります',
  },
] as const;

export type PasteSource = (typeof PASTE_SOURCES)[number]['id'];

/** 既定。⚠ **`auto` にする** ── 設定を知らない人が、いままでと同じ挙動になる。 */
export const DEFAULT_PASTE_SOURCE: PasteSource = 'auto';

const SOURCE_IDS: readonly string[] = PASTE_SOURCES.map((s) => s.id);

export function isPasteSource(v: string): v is PasteSource {
  return SOURCE_IDS.includes(v);
}

/** 実際に使った形。 */
export type PasteUsed = 'permalink' | 'html' | 'html-fence' | 'rtf' | 'plain';

/** 見送った形と、その理由(⚠ **デバッグの本体**はここである)。 */
export interface PasteSkip {
  readonly kind: 'html' | 'rtf' | 'permalink';
  readonly why: string;
}

/** 貼付 1 回ぶんの記録。 */
export interface PasteAttempt {
  /** そのとき効いていた設定。 */
  readonly source: PasteSource;
  /** 届いた形と、その大きさ(バイトではなく文字数)。 */
  readonly sizes: { readonly html: number; readonly rtf: number; readonly plain: number };
  readonly used: PasteUsed;
  readonly skipped: readonly PasteSkip[];
}

const LABEL: Record<PasteUsed, string> = {
  permalink: 'ノートへのリンク',
  html: 'ウェブページの形',
  'html-fence': 'ウェブページの形(html の囲み)',
  rtf: 'リッチテキスト',
  plain: 'そのままの文字',
};

const n = (v: number): string => v.toLocaleString('en-US');

/**
 * 🔴 **何が届いて、どれを使ったか**を 1 行にする(フラグ `paste.inspect` が出す)。
 *
 * ⚠ **中身は 1 文字も出さない** ── 貼ったものは user の私物であり、
 * 画面に出した文字は**お知らせの履歴に残る**。出すのは**大きさと判断**だけである。
 */
export function describePaste(a: PasteAttempt): string {
  const got = [
    a.sizes.html > 0 ? `ウェブページ ${n(a.sizes.html)} 字` : null,
    a.sizes.rtf > 0 ? `リッチテキスト ${n(a.sizes.rtf)} 字` : null,
    a.sizes.plain > 0 ? `文字 ${n(a.sizes.plain)} 字` : null,
  ].filter((s): s is string => s !== null);
  const head = `貼付: ${got.length > 0 ? got.join(' / ') : '何も届いていません'} → ${LABEL[a.used]}を使いました`;
  const tail = a.skipped.map((s) => `${LABEL[s.kind === 'permalink' ? 'permalink' : s.kind]}は${s.why}`);
  const setting = a.source === 'auto' ? '' : `(設定: ${PASTE_SOURCES.find((s) => s.id === a.source)!.label})`;
  return [head + setting, ...tail].join(' ── ');
}

/** 変換の口(呼び側が渡す。⚠ **遅延**である ── 使わない形は解析しない)。 */
export interface PasteConverters {
  readonly permalink: () => string | null;
  readonly html: () => string | null;
  /** 🔴 変換せず ` ```html ` の囲みにする(user 要望 2026-08-27)。 */
  readonly htmlFence: () => string | null;
  readonly rtf: () => string | null;
}

/**
 * 🔴 **貼付をどう読むかの唯一の判定**。
 *
 * ⚠ **遅延で呼ぶ** ── 設定が `plain` のとき 1MB の HTML を解析しない、
 * `html` のとき RTF を解析しない。**押した瞬間に止まらない**ための作法である。
 *
 * @returns `text` が `null` なら介入しない(既定の貼付に委ねる)
 */
export function choosePaste(args: {
  source: PasteSource;
  sizes: { html: number; rtf: number; plain: number };
  convert: PasteConverters;
}): { text: string | null; attempt: PasteAttempt } {
  const { source, sizes, convert } = args;
  const skipped: PasteSkip[] = [];
  const done = (used: PasteUsed, text: string | null): ReturnType<typeof choosePaste> => ({
    text,
    attempt: { source, sizes, used, skipped },
  });

  if (source === 'plain') {
    /**
     * ⚠ **パーマリンクの書き換えも止める** ── 「変換しない」と書いてあるのに
     * 1 種類だけ書き換わるのは、**設定の字が嘘になる**。
     */
    if (sizes.html > 0) skipped.push({ kind: 'html', why: '設定で読まない形です' });
    if (sizes.rtf > 0) skipped.push({ kind: 'rtf', why: '設定で読まない形です' });
    return done('plain', null);
  }

  const permalink = convert.permalink();
  if (permalink !== null) return done('permalink', permalink);

  /**
   * 🔴 **そのまま囲みにする**(user 要望 2026-08-27)。⚠ **変換を試さない** ──
   * この設定を選んだ user は「変換すると落ちるものが在る」と言っている。
   * ⚠ RTF も見送る(囲みにできるのは HTML だけ)── **理由は残す**。
   */
  if (source === 'html-fence') {
    if (sizes.rtf > 0) skipped.push({ kind: 'rtf', why: '囲みにできるのは HTML だけです' });
    if (sizes.html === 0) {
      skipped.push({ kind: 'html', why: '届いていません' });
      return done('plain', null);
    }
    const fence = convert.htmlFence();
    if (fence !== null) return done('html-fence', fence);
    skipped.push({ kind: 'html', why: '大きすぎて囲みにできませんでした' });
    return done('plain', null);
  }

  /**
   * 🔑 **順番は設定が決める。** `auto` / `html` は HTML が先、`rtf` は RTF が先。
   * ⚠ 「HTML だけ」は RTF を**見送った理由まで**残す(黙って落とすと、
   *   フラグを点けても「なぜ使われなかったか」が分からない)。
   */
  // ⚠ `html-fence` は上で返しているので、ここへは来ない
  const order: ReadonlyArray<'html' | 'rtf'> =
    source === 'rtf' ? ['rtf', 'html'] : source === 'html' ? ['html'] : ['html', 'rtf'];

  if (source === 'html' && sizes.rtf > 0)
    skipped.push({ kind: 'rtf', why: '設定で読まない形です' });

  for (const kind of order) {
    if (sizes[kind] === 0) {
      skipped.push({ kind, why: '届いていません' });
      continue;
    }
    const text = convert[kind]();
    if (text !== null) return done(kind, text);
    skipped.push({ kind, why: '変換しても得るものがありませんでした' });
  }
  return done('plain', null);
}
