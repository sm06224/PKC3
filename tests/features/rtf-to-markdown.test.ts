/**
 * 🔴 **リッチテキスト(RTF)の貼付**(user 指示 2026-08-25)。
 *
 * ⚠ **fixture は実物の出し手が書く形にする** ── RTF は「それらしく書けば通る」
 * ので、自分の実装に都合のよい綴りで試すと**同じ盲点を共有する**
 * (CLAUDE.md §1「期待値を実装と同じ文法の別の綴りで組むと、同じ盲点を持つ」)。
 * だから Word / WordPad / TextEdit が実際に書く形
 * (`{\*\generator …}` / `{\stylesheet …}` / `{\listtext …}` / `\uN\'3f`)を写す。
 */
import { describe, expect, it } from 'vitest';
import { convertPastedRtf, PASTE_RTF_MAX } from '../../src/features/markdown/rtf-to-markdown';

/** 実物の頭 ── フォント表と生成器の印が必ず付く。 */
const HEAD =
  String.raw`{\rtf1\ansi\ansicpg1252\deff0` +
  String.raw`{\fonttbl{\f0\fnil\fcharset0 Calibri;}{\f1\fnil\fcharset128 Yu Gothic;}}` +
  String.raw`{\*\generator Riched20 10.0.19041;}`;

const rtf = (body: string, opts: { styles?: string } = {}): string =>
  HEAD + (opts.styles ?? '') + String.raw`\viewkind4\uc1 ` + body + '}';

const conv = (body: string, plain = '', opts: { styles?: string } = {}): string | null =>
  convertPastedRtf({ rtf: rtf(body, opts), plain });

/**
 * `\uN`(+ 取りこぼしの代替文字)を書く。
 *
 * ⚠ **直に書かない** ── 1 稿目は fixture に `\u12354` と書いたつもりが、
 * **編集の途中で U+1235 の実体 + `4` になっていた**(CLAUDE.md「編集ツールが
 * escape を書いたつもりでも実体が入る ── 書き換えたらバイト走査する」)。
 * 🔑 数を組み立てる形にすれば、実体化しようがない。
 */
const u = (cp: number, alt = "\\'3f"): string => '\\u' + String(cp) + alt;

describe('介入しない場面', () => {
  it('RTF でないものは触らない', () => {
    expect(convertPastedRtf({ rtf: '', plain: 'x' })).toBeNull();
    expect(convertPastedRtf({ rtf: 'ただの文字', plain: 'x' })).toBeNull();
    expect(convertPastedRtf({ rtf: '<p>html</p>', plain: 'x' })).toBeNull();
  });

  it('🔴 RTF でないのに RTF らしい字が混じっていても、解釈しない', () => {
    /**
     * ⚠ 上の 3 つは**別の門(得るものが無い)が救っていた** ── 変異試験 R1 が
     *   SURVIVED で教えた(CLAUDE.md §1「救い手が変わっただけ」)。
     * 🔑 だから「頭の `{\rtf` を見ていなければ**化ける**」入力で見る。
     *   ⚠ これは実害である:`\b` を含む文書を貼ると**勝手に太字になる**。
     */
    const notRtf = String.raw`{\b これは RTF ではない\b0}`;
    expect(convertPastedRtf({ rtf: notRtf, plain: 'これは RTF ではない' })).toBeNull();
  });

  it('大きすぎる RTF は解析しない(貼付でメインスレッドを止めない)', () => {
    const huge = rtf(String.raw`\b ` + 'あ'.repeat(PASTE_RTF_MAX));
    expect(huge.length).toBeGreaterThan(PASTE_RTF_MAX); // 空振り防止
    expect(convertPastedRtf({ rtf: huge, plain: 'あ' })).toBeNull();
  });

  it('🔴 平文が既に markdown 原文なら触らない(原文のほうが正確)', () => {
    // AI の「コピー」は原文を text/plain に、描画済みを text/html / text/rtf に載せる
    expect(conv(String.raw`\b 見出し\b0\par`, '# 見出し')).toBeNull();
  });

  it('🔴 飾りも構造も無いなら触らない(平文の貼付のほうが正確)', () => {
    /**
     * ⚠ **平文を渡さない形で見る**(変異試験 R4 が SURVIVED で教えた)──
     *   `plain` を同じ文字にすると「平文と同じなら触らない」の門が救ってしまい、
     *   **「得るものが無い」の門を外しても緑**だった。
     */
    expect(conv(String.raw`ただの一行です\par`, '')).toBeNull();
    expect(conv(String.raw`一行目\par二行目\par`, '')).toBeNull();
    // ⚠ 空振り防止 ── 飾りが 1 つ在れば介入する
    expect(conv(String.raw`\b ただの一行です\b0\par`, '')).not.toBeNull();
  });

  it('平文と同じものを作っただけなら触らない(undo の段数だけ増やさない)', () => {
    /**
     * ⚠ **平文が「markdown らしく見えない」形で見る**(変異試験 R5 が SURVIVED で
     *   教えた)── `**あ**` を平文に置くと、手前の
     *   「平文が markdown 原文らしい」の門が救ってしまう。
     * 🔑 `- 項` はどちらの門にも引っかからないので、この門だけを鳴らせる。
     */
    const listRtf = String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}項\par`;
    expect(conv(listRtf, '- 項')).toBeNull();
    // ⚠ 空振り防止 ── 平文が違えば入る
    expect(conv(listRtf, '項')).toBe('- 項');
  });
});

describe('飾り', () => {
  it('太字 / 斜体 / 取り消し', () => {
    expect(conv(String.raw`\b 太\b0 と\i 斜\i0 と\strike 消\strike0\par`)).toBe(
      '**太**と*斜*と~~消~~',
    );
  });

  it('🔴 空白は包みの外へ出す(`** 太 **` は強調にならない)', () => {
    expect(conv(String.raw`前\b  太字 \b0 後\par`)).toBe('前 **太字** 後');
  });

  it('下線は簡易 inline 記法にする(PKC3 の動線を落とさない)', () => {
    // ⚠ `\ulnone` の直後の空白 1 つは**区切り**であって文字ではない(RTF の規約)
    expect(conv(String.raw`\ul 下線\ulnone です\par`)).toBe(':下線:underline:です');
  });

  it('⚠ `:` を含む文字には下線を掛けない(記法が閉じられない)── 文字は残す', () => {
    const out = conv(String.raw`\ul 12:30\ulnone\par`)!;
    expect(out).toContain('12:30');
    expect(out).not.toContain('underline');
  });

  it('隣り合う同じ飾りは 1 つに畳む(`**あ****い**` を作らない)', () => {
    expect(conv(String.raw`\b あ\b い\b0\par`)).toBe('**あい**');
  });

  it('🔴 隠し文字は出さない(`\\v` は画面に出ない字である)', () => {
    expect(conv(String.raw`見える\v 隠し\v0\b !\b0\par`)).toBe('見える**!**');
  });
});

describe('段落と改行', () => {
  it('`\\par` は段落、`\\line` は改行', () => {
    expect(conv(String.raw`\b 一\b0\line 二\par\b 三\b0\par`)).toBe('**一**\n二\n\n**三**');
  });

  it('RTF の生の改行は意味を持たない(行を折っただけ)', () => {
    expect(conv('\\b あ\\b0\n\nい\\par')).toBe('**あ**い');
  });
});

describe('見出し ── スタイルシートを読んで決める', () => {
  const STYLES =
    String.raw`{\stylesheet{\s0 Normal;}{\s1\sbasedon0 heading 1;}{\s2\sbasedon0 heading 2;}}`;

  it('🔴 `\\s1` が見出し 1 になる(RTF に見出しという概念は無い)', () => {
    expect(conv(String.raw`\pard\s1 大見出し\par\pard\s2 中見出し\par\pard 本文\par`, '', {
      styles: STYLES,
    })).toBe('# 大見出し\n\n## 中見出し\n\n本文');
  });

  it('⚠ スタイルシートが無ければ見出しにしない(在りもしない段を作らない)', () => {
    expect(conv(String.raw`\pard\s1 ただの段落\par\b !\b0\par`)).toBe('ただの段落\n\n**!**');
  });

  it('日本語のスタイル名(見出し 1)も読む', () => {
    expect(
      conv(String.raw`\pard\s1 題\par`, '', { styles: String.raw`{\stylesheet{\s1 見出し 1;}}` }),
    ).toBe('# 題');
  });

  it('⚠ スタイルシートの中身は本文に出さない', () => {
    const out = conv(String.raw`\pard\s1 題\par`, '', { styles: STYLES })!;
    expect(out).not.toContain('Normal');
    expect(out).not.toContain('heading');
  });
});

describe('リスト', () => {
  it('印が `•` なら箇条書き、`1.` なら番号付き', () => {
    expect(
      conv(
        String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}りんご\par` +
          String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}みかん\par`,
      ),
    ).toBe('- りんご\n\n- みかん');
    expect(
      conv(String.raw`\pard\ls2\ilvl0{\listtext 1.\tab}ひとつ\par`),
    ).toBe('1. ひとつ');
  });

  it('入れ子は深さぶん字下げする', () => {
    expect(
      conv(
        String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}親\par` +
          String.raw`\pard\ls1\ilvl1{\listtext\'b7\tab}子\par`,
      ),
    ).toBe('- 親\n\n  - 子');
  });

  it('⚠ 印そのものは本文に出さない(`•` が行頭に残らない)', () => {
    expect(conv(String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}項\par`)).not.toContain('·');
  });

  it('`\\pard` でリストから抜ける(次の段落まで箇条書きにしない)', () => {
    expect(
      conv(
        String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}項\par\pard \b 後\b0\par`,
      ),
    ).toBe('- 項\n\n**後**');
  });

  it('🔴 `\\par` を挟まない `\\pard` でも抜ける(段落の property を戻す語である)', () => {
    /**
     * ⚠ 上の test は **`\par` が段落ごと作り直すので救われていた**
     *   (変異試験 R14 が SURVIVED で教えた)── `\pard` を外しても緑だった。
     * 🔑 `\par` を挟まずに `\pard` が来る形なら、この語だけを鳴らせる。
     */
    expect(conv(String.raw`\ls1\ilvl0 項\pard \b 後\b0\par`)).toBe('項**後**');
  });
});

describe('表', () => {
  it('GFM にする ── 🔴 見出し行が無ければ空の見出しを足す(1 行消さない)', () => {
    const body =
      String.raw`\trowd\intbl A\cell B\cell\row` + String.raw`\trowd\intbl C\cell D\cell\row`;
    expect(conv(body)).toBe('|  |  |\n| --- | --- |\n| A | B |\n| C | D |');
  });

  it('`\\trhdr` の行は見出しになる', () => {
    const body =
      String.raw`\trowd\trhdr\intbl 名\cell 数\cell\row` + String.raw`\trowd\intbl 林檎\cell 3\cell\row`;
    expect(conv(body)).toBe('| 名 | 数 |\n| --- | --- |\n| 林檎 | 3 |');
  });

  it('セルの中の飾りも残る', () => {
    const body = String.raw`\trowd\intbl \b 太\b0\cell 素\cell\row`;
    expect(conv(body)).toContain('| **太** | 素 |');
  });

  it('幅の違う行は、いちばん広い行に合わせる(欠けは空セル)', () => {
    const body = String.raw`\trowd\intbl A\cell B\cell C\cell\row` + String.raw`\trowd\intbl D\cell\row`;
    expect(conv(body)).toBe('|  |  |  |\n| --- | --- | --- |\n| A | B | C |\n| D |  |  |');
  });
});

describe('リンク', () => {
  const link = (url: string, text: string) =>
    String.raw`{\field{\*\fldinst{HYPERLINK "` + url + String.raw`"}}{\fldrslt ` + text + '}}';

  it('`\\field` の HYPERLINK を markdown のリンクにする', () => {
    expect(conv(link('https://example.com/a', 'ここ') + String.raw`\par`)).toBe(
      '[ここ](https://example.com/a)',
    );
  });

  it('🔴 リンクの外の文まで飲み込まない', () => {
    expect(conv('前' + link('https://example.com/', '中') + '後' + String.raw`\par`)).toBe(
      '前[中](https://example.com/)後',
    );
  });

  it('🔴 押すと危ない宛先はリンクにしない(文字は残す)', () => {
    const out = conv(link('javascript:alert(1)', '押すな') + String.raw`\par\b !\b0\par`)!;
    expect(out).toContain('押すな');
    expect(out).not.toContain('javascript:');
  });

  it('⚠ HYPERLINK の指示そのものは本文に出さない', () => {
    expect(conv(link('https://example.com/', 'ここ') + String.raw`\par`)).not.toContain(
      'HYPERLINK',
    );
  });
});

describe('文字の符号化', () => {
  it('`\\uN` を読み、取りこぼし用の代替文字を飛ばす(`\\uc1`)', () => {
    // Word は非 ASCII を `ስ4\'3f`(= あ + 取りこぼしの ?)と書く
    expect(conv(String.raw`\b ` + u(12354) + u(12356) + String.raw`\b0\par`)).toBe('**あい**');
  });

  it('サロゲートペア(絵文字)も戻る', () => {
    expect(conv(String.raw`\b ` + u(-10179) + u(-8704) + String.raw`\b0\par`)).toBe('**😀**');
  });

  it('`\\uc0` のときは代替文字が無い', () => {
    expect(conv(String.raw`\uc0\b ` + u(12354, ' ') + u(12356, ' ') + String.raw`\b0\par`)).toBe(
      '**あい**',
    );
  });

  it("`\\'hh` は cp1252 として読む", () => {
    expect(conv(String.raw`\b caf\'e9\b0\par`)).toBe('**café**');
    expect(conv(String.raw`\b \'93引用\'94\b0\par`)).toBe('**“引用”**');
  });

  it('escape された `\\` `{` `}` は文字として出る', () => {
    expect(conv(String.raw`\b a\\b\{c\}\b0\par`)).toBe('**a\\\\b{c}**');
  });

  it('記号の制御語(`\\bullet` / `\\emdash`)を出す', () => {
    expect(conv(String.raw`\b \bullet\emdash\b0\par`)).toBe('**•—**');
  });
});

describe('捨てるもの', () => {
  it('🔴 知らない `{\\*\\…}` は中身ごと捨てる(RTF の規約)', () => {
    /**
     * ⚠ **名前を知らない destination で見る**(変異試験 R22 が SURVIVED で教えた)
     *   ── `themedata` / `datastore` は**名指しの一覧にも載っている**ので、
     *   `\*` の規約を外しても一覧のほうが救っていた。
     * 🔑 一覧に無い名前(将来 Word が足すもの)こそ、この規約が守る相手である。
     */
    expect(conv(String.raw`{\*\madeupthing 未知の中身}\b 本文\b0\par`)).toBe('**本文**');
    // ⚠ 空振り防止 ── `\*` が無ければ中身は出る(規約が効いていることの裏)
    expect(conv(String.raw`{\madeupthing 未知の中身}\b 本文\b0\par`)).toContain('未知の中身');
  });

  it('フォント表・色表・情報は出さない', () => {
    expect(
      conv(String.raw`{\colortbl ;\red0\green0\blue0;}{\info{\title 題}}\b 本文\b0\par`),
    ).toBe('**本文**');
  });

  it('ヘッダ・フッタ・脚注は出さない', () => {
    expect(
      conv(String.raw`{\header 頁の上}{\footer 頁の下}\b 本文\b0\par`),
    ).toBe('**本文**');
  });
});

describe('画像', () => {
  /** 1x1 の PNG。 */
  const PNG_HEX =
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082';

  it('PNG は `data:` URL の画像にする(資産へ逃がすのは呼び側の仕事)', () => {
    const out = conv(String.raw`{\pict\pngblip\picw16\pich16 ` + PNG_HEX + '}' + String.raw`\par`)!;
    expect(out).toMatch(/^!\[\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)$/);
    // 🔑 中身が往復する(印で預かって最後に開く ── escape で壊していない)
    const b64 = /base64,([^)]+)\)/.exec(out)![1]!;
    const back = Buffer.from(b64, 'base64').toString('hex');
    expect(back).toBe(PNG_HEX);
  });

  it('🔴 描けない形式(WMF)は落とす ── 壊れた画像を貼らない', () => {
    /**
     * ⚠ **中身を十分な長さにする**(変異試験 R24 が SURVIVED で教えた)── 1 稿目の
     *   16 進は 16 桁しかなく、**「短すぎる」の門が救っていた**ので、形式の門を
     *   外しても緑だった。
     */
    const long = '0102030405060708'.repeat(8);
    const out = conv(String.raw`{\pict\wmetafile8\picw16\pich16 ` + long + '}' + String.raw`\b 文\b0\par`)!;
    expect(out).toBe('**文**');
    expect(out, '描けない形式を data: にしている').not.toContain('data:');
  });
});

describe('実物に近い一式', () => {
  it('WordPad が書く形をひととおり通す', () => {
    const out = conv(
      String.raw`\pard\s1 買い物\par` +
        String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}\b 牛乳\b0 を 2 本\par` +
        String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}\i 卵\i0\par` +
        String.raw`\pard 詳しくは{\field{\*\fldinst{HYPERLINK "https://example.com/"}}{\fldrslt こちら}}\par`,
      '',
      { styles: String.raw`{\stylesheet{\s1 heading 1;}}` },
    );
    expect(out).toBe(
      '# 買い物\n\n- **牛乳**を 2 本\n\n- *卵*\n\n詳しくは[こちら](https://example.com/)',
    );
  });
});
