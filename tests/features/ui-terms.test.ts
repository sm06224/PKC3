/**
 * 名前の門(#1017 段⑤-1)── `src/features/ui-terms.ts` を正本にして、
 * 画面の字が §6.1(名前の規則)から外れていないかを見る。
 *
 * 🔴 **3 つの門**は、①使わない語 ②動詞句のボタン名 ③メッセージの英語識別子 を
 * **いまの残りとして等値 pin する**(burn-down。残りは 0 件)。増えたら落ちる / 減ったら
 * pin の側も直さないと落ちる ── 直したことが必ず記録に残る(CLAUDE.md「等値 pin の既知リストは良く効いた」)。
 * ①は `src` の文字列リテラルに加えて、`public/` の画面(`*.html` / `*.js`)の文字列も見る。
 *
 * ⚠ **走査対象は文字列リテラルだけ**(`codeOnly` で comment を剥いでから抜く)。
 * comment に書いた解説文が検査を満たしてしまう罠は、CLAUDE.md §1 の
 * 「5 度目・10 度目」がまさにこれ ── だから抜き出した**リテラルの中身だけ**を見る。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { codeOnly } from '../helpers/code-only';
import { BANNED_TERMS } from '../../src/features/ui-terms';
import {
  COLLECTION_COMMANDS,
  COLLECTION_PANE_COMMANDS,
  SETTINGS_COMMANDS,
} from '../../src/adapter/ui/render/commands';

const ROOTS = ['src/adapter/ui', 'src/features'];

/**
 * 🔴 **使わない語の門は `src` 全体を見る**(user 指示 2026-10-06)。
 * ⚠ 直す前は `ROOTS`(`src/adapter/ui` と `src/features`)だけで、`src/main.ts` /
 *   `src/adapter/platform` / `src/adapter/state` / `src/adapter/transport` に残った
 *   造語(器・雛形・検める・面・印 など)が**門の外**だった ── 画面に出る字は
 *   どこの層の文字列リテラルからも出るので、範囲は層ではなく `src` 全部にする。
 * ⚠ 他の 2 つの門(動詞句・英語の識別子)は従来どおり `ROOTS` のまま(範囲を変えるのは
 *   この門だけ ── 主張が違う)。
 */
const BANNED_ROOTS = ['src'];

/**
 * ⚠ **正本 `ui-terms.ts` は走査から除く**(#1017 段⑤-1)。BANNED_TERMS の
 * `banned` / `excludes` は「使わない語」そのものをデータとして持つので、
 * 除かないと**登記簿が自分自身を違反として検出する**(自己言及の空振り)。
 * ⚠ 除外は**この 1 file だけ**にする ── 走査対象を広く除くほど、
 * 直したはずの残りが見えなくなる。
 */
const REGISTRY_FILE = 'src/features/ui-terms.ts';

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      full.split('\\').join('/') !== REGISTRY_FILE
    )
      out.push(full);
  }
  return out;
}

/** 文字列・テンプレートリテラルの中身だけを抜く(囲みの引用符は含めない)。 */
function extractLiterals(code: string): string[] {
  const out: string[] = [];
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(m[0].slice(1, -1));
  return out;
}

const JAPANESE = /[\u3000-\u30ff\u4e00-\u9fff]/;

/**
 * リテラルの中の `${…}`(式)を潰す ── 式は画面の字ではなくコード(`${file.name}` の
 * `file` を「英語の素通し」と読ませない)。
 */
function maskInterpolation(literal: string): string {
  return literal.replace(/\$\{[^}]*\}/g, '\uE000');
}

/** 走査対象 file と、file ごとの「comment を剥いだリテラル本文」を 1 度だけ作る。 */
function scanTargets(): { files: string[]; literalsByFile: Map<string, string> } {
  const files = BANNED_ROOTS.flatMap((r) => walkTs(r));
  const literalsByFile = new Map<string, string>();
  for (const f of files) {
    const stripped = codeOnly(readFileSync(f, 'utf8'));
    // ⚠ 日本語を含むリテラルだけ(= 画面に出る文)。`'file'` `'lid'` のような**コードの字**
    //   (型名・property 名)を、英語の素通しと読ませない
    const screen = extractLiterals(stripped)
      .map(maskInterpolation)
      .filter((l) => JAPANESE.test(l));
    literalsByFile.set(f, screen.join('\n'));
  }
  return { files, literalsByFile };
}

describe('画面の字に使わない語(ui-terms.ts の BANNED_TERMS)', () => {
  const { files, literalsByFile } = scanTargets();

  it('空振り防止:走査対象は src の 500 file・5000 リテラルを超える', () => {
    expect(files.length).toBeGreaterThan(500);
    const totalLiterals = [...literalsByFile.values()].reduce(
      (n, text) => n + (text.length > 0 ? text.split('\n').length : 0),
      0,
    );
    expect(totalLiterals).toBeGreaterThan(5000);
    // 範囲が `src` 全体であること(層で切っていない)── main.ts と platform と state が入っている
    expect(files).toContain('src/main.ts');
    expect(files.some((f) => f.startsWith('src/adapter/platform/'))).toBe(true);
    expect(files.some((f) => f.startsWith('src/adapter/state/'))).toBe(true);
  });

  it('self-test:わざと入れた 1 件は検出できる', () => {
    const term = BANNED_TERMS.find((t) => t.banned === '壊れ');
    if (!term) throw new Error('BANNED_TERMS に「壊れ」が無い(自己診断が壊れている)');
    expect(term.pattern().test('この file は壊れています')).toBe(true);
    // ⚠ 除外の対照群:同じ pattern を「面」に当て、"画面" を誤検知しないことを見る
    const menTerm = BANNED_TERMS.find((t) => t.banned === '面');
    if (!menTerm) throw new Error('BANNED_TERMS に「面」が無い');
    expect(menTerm.pattern().test('画面に出します')).toBe(false);
    expect(menTerm.pattern().test('本文の面へ移ります')).toBe(true);
  });

  /**
   * 🔑 **2026-10-06 の総直しで足した語を、1 語ずつ「当たる文」と「当たらない文」で見る**
   * (user 指示:造語・直訳を一般的な用語へ)。
   * ⚠ 「当たる」だけだと、除外を足しすぎて何も見ない語が生き延びる ── 対照群を必ず置く。
   * ⚠ 期待値は `BANNED_TERMS` の配列を種にしない(配列から語を落とすと、検査も同時に縮む)。
   */
  const FIND: readonly [banned: string, hit: string, ok: string][] = [
    ['近道', '近道キーで開きます', 'ショートカットキーで開きます'],
    ['鍵', '同じ鍵が 2 回', '暗号鍵の字'],
    ['窓', '別の窓に出ます', '窓口に問い合わせる'],
    ['小窓', '▾ の小窓', '別ウィンドウ'],
    ['帯', '上の帯に並びます', '時間帯で見る'],
    ['焼', '1 枚に焼く', '描いた図'],
    ['栞', '栞を付ける', 'ブックマーク'],
    ['留め', '場所を留める', 'スタックに載せたパネル'],
    ['写す', '表を写す', 'コピーする'],
    ['写し', '写しの途中', 'コピーの途中'],
    ['影', '影の表', '影響が出る'],
    ['目録', '目録が読めません', 'ファイル一覧が読めません'],
    ['ひとそろい', 'Office のひとそろい', 'Office の一式'],
    ['持ち歩', '持ち歩ける 1 枚', '1 ファイルの HTML'],
    ['持ち出し', '設定の持ち出し', '設定の書き出し'],
    ['読み直', 'アプリを読み直す', 'アプリを再読み込みする'],
    ['畳', '一覧を畳む', '一覧を折りたたむ'],
    ['取っ手', '取っ手をつかむ', 'つまみをつかむ'],
    ['左の列', '左の列で探す', '左のペインで探す'],
    ['この版では', 'この版では使えません', 'このバージョンでは使えません'],
    ['塊', '本文の塊', '本文のブロック'],
    ['取り直', '取り直してください', '取得し直してください'],
    ['取ってこ', '取ってこられません', '取得できません'],
    ['配る', '配る物がありません', '配布する物がありません'],
    ['在る', '中に在る表', '中にある表'],
    ['居る', 'そこに居る人', 'そこにいる人'],
    ['繋', '繋がりの線', 'つながりの線'],
    ['ごみ箱', 'ごみ箱へ移す', 'ゴミ箱へ移す'],
    ['file', 'この file を選ぶ', 'このファイルを選ぶ'],
    ['lid', 'lid が違います', 'ID が違います'],
    ['asset key', 'asset key が重複', '添付の ID が重複'],
    ['🔴', '🔴 戻らないもの', '戻らないもの'],
    ['──', '押せません ── 理由', '押せません。理由'],
    ['焦点', '欄に焦点を移す', '欄にフォーカスを移す'],
    ['引く', '答えを引く', '線を引く'],
    ['引け', 'DuckDB で引けます', '線が引けません'],
    ['当たり', '当たりへ送る', '一致へ送る'],
    ['当てて', '当ててください', '割り当ててください'],
    ['落と', '本文へ落としてください', '段落と同じ左端'],
    ['組んで', '一式を組んでいます', '一式を作っています'],
    ['入れ物', '入れ物を作り直す', '保存領域を作り直す'],
    ['拾', '拾い出しました', '取り出しました'],
    ['片道', '片道です', '取り込み直せません'],
    ['電波', '電波が要ります', 'ネットワークが必要です'],
    ['頁', '前の頁へ', '前のページへ'],
    ['升', '升ごとの字', 'セルごとの字'],
    ['箱', '埋め込みの箱', 'ゴミ箱を空にする'],
    ['預か', '預かりました', '保留しました'],
    ['採れ', '採れません', '取得できません'],
    ['採り', '先の方を採ります', '先のほうを使います'],
    ['積み', '上に積みます', '積み重ねた表'],
    ['書庫', '書庫の中', 'zip ファイルの中'],
    ['鍵盤', '鍵盤の字', 'キーボードの字'],
    ['持ち手', '持ち手をつかむ', 'つまみをつかむ'],
    ['構成ファイル', '構成ファイルが読めません', 'ファイル一覧が読めません'],
    ['入 / 切', '入 / 切', 'オン / オフ'],
    ['既定は切', '(既定は切)', '(既定はオフ)'],
    ['既定は入', '(既定は入)', '(既定はオン)'],
    ['切のまま', '切のままなら', 'オフのままなら'],
    ['入のまま', '入のままなら', 'オンのままなら'],
    ['切ると、', '切ると、日付は', '区切ると、日付は'],
    ['入にし', '入にしてください', '導入にしてください'],
    ['入にす', '入にすると', '導入にすると'],
    ['切にし', '切にしてください', 'オフにしてください'],
    ['切にす', '切にすると', 'オフにすると'],
    ['掴', '掴んで動かす', 'ドラッグして動かす'],
    ['取込', '取込完了', '取り込み完了'],
    ['書出', '書出し', '書き出し'],
    ['書込', '書込は', '書き込みは'],
    ['貼付', '貼付画像', '貼り付け画像'],
  ];

  /**
   * 🔑 **使わない語の一覧そのものを等値 pin する**(語を 1 つ落とすと、その語を見る検査が
   * 黙って無くなる ── `FIND` は一部の語しか持たないので、一覧の削りはこちらが止める)。
   * ⚠ 語を足す / 外すときは、この一覧と `FIND` の両方を直す。
   */
  it('使わない語の一覧が、手書きの一覧と一致する(語を黙って削れない)', () => {
    expect(BANNED_TERMS.map((b) => b.banned)).toEqual([
      '面',
      '口',
      '札',
      '検め',
      '区画',
      '小窓',
      '近道',
      '鍵',
      '窓',
      '帯',
      '焼',
      '栞',
      '留め',
      '写し',
      '写す',
      '写せ',
      '写ら',
      '影',
      '目録',
      '構成ファイル',
      'ひとそろい',
      '持ち歩',
      '可搬',
      '持ち出し',
      '読み直',
      '畳',
      '取っ手',
      '焦点',
      '状態の行',
      '状態の帯',
      '左の列',
      '右の列',
      'この版では',
      '新しい版に切り替',
      '新しい版が',
      '古い版のタブ',
      '別の版が',
      '別の版で',
      '塊',
      '取り直',
      '取ってこ',
      '配っ',
      '配る',
      '配り方',
      '在る',
      '居る',
      '居ない',
      '在り',
      '在っ',
      '繋',
      'ごみ箱',
      'file',
      'lid',
      'asset key',
      '添付 key',
      '添付の key',
      '🔴',
      '🔑',
      '──',
      '引く',
      '引け',
      '引いて',
      '引きま',
      '当たり',
      '当たる',
      '当てて',
      '当てる',
      '落と',
      '組む',
      '組んで',
      '組んだ',
      '組め',
      '組み直',
      '添付の控え',
      '器',
      '印',
      '雛形',
      '紙面',
      '居場所',
      '解放',
      '壊れ',
      '破損',
      '最後の手',
      '拾う',
      '捨てる',
      '危険',
      '救出',
      '復旧',
      '入れ物',
      '拾',
      '片道',
      '電波',
      '頁',
      '升',
      '箱',
      '預か',
      '採れ',
      '採り',
      '積み',
      '書庫',
      '鍵盤',
      '持ち手',
      '入 / 切',
      '既定は切',
      '既定は入',
      '切のまま',
      '入のまま',
      '切ると、',
      '入にし',
      '入にす',
      '切にし',
      '切にす',
      '掴',
      '取込',
      '書出',
      '書込',
      '貼付',
    ]);
  });

  it.each(FIND)('「%s」は当たる文を見つけ、置き換えた文は見つけない', (word, hit, ok) => {
    const t = BANNED_TERMS.find((b) => b.banned === word);
    if (!t) throw new Error(`BANNED_TERMS に「${word}」が無い`);
    expect(t.pattern().test(hit), `当たる文: ${hit}`).toBe(true);
    // 置き換えた文を、全部の使わない語に当てて 1 件も当たらないこと(別の語が拾っても同じ)
    for (const b of BANNED_TERMS) {
      expect(b.pattern().test(ok), `${ok} が「${b.banned}」に当たった`).toBe(false);
    }
  });

  /**
   * 🔑 **使わない語が 0 件であること**(CLAUDE.md「`KNOWN_BANNED` は 0 件を保つ。増やさない」)。
   * ⚠ 配布済みのお知らせの字も直した(user 指示 2026-10-06「全部」)ので、`notice-log.ts` も 0 件。
   * ⚠ 増えたら落ちる。**直せない理由があっても、この表に足さない**(足すと 0 件の規律が崩れる)
   *   ── 普通の語として使っている物は、下の `ORDINARY_USES` に**理由つき**で置く。
   */
  const KNOWN_BANNED: readonly [file: string, banned: string, count: number][] = [];

  /**
   * 🔑 **普通の語として使っている物**(造語ではない。理由を 1 行ずつ)。
   * ⚠ 件数まで等値で pin する ── 件数が動いたら(別の所にも増えたら)落ちる。
   */
  const ORDINARY_USES: readonly [file: string, banned: string, count: number, why: string][] = [
    // 操作を探すときの旧い呼び名(別名)。画面には出ない ── 旧い呼び名で探した人を新しい名前へ案内する
    ['src/features/keymap.ts', '小窓', 1, '検索用の旧い別名(画面には出ない)'],
    ['src/features/keymap.ts', '窓', 1, '同じ別名(「小窓」が「窓」にも当たる)'],
    // アイコン「key」の呼び名 ── 物としての鍵(ショートカットキーの意味ではない)
    ['src/features/icon/tile-icons.ts', '鍵', 1, '絵の名前(物としての鍵)'],
    // 旧い呼び名で探した人を新しい名前へ案内する別名(画面には出ない)── 「畳む」を「折りたたむ」へ改めた 4 命令
    ['src/features/keymap.ts', '畳', 4, '旧い呼び名(畳む)の別名。画面には出ない'],
  ];

  type Row = [file: string, banned: string, count: number];
  const cmp = (a: Row, b: Row): number =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1;

  function currentRows(): Row[] {
    const rows: Row[] = [];
    for (const f of files) {
      const text = literalsByFile.get(f) ?? '';
      for (const t of BANNED_TERMS) {
        const matches = text.match(t.pattern());
        if (matches && matches.length > 0) {
          rows.push([relative('.', f).split('\\').join('/'), t.banned, matches.length]);
        }
      }
    }
    return rows.sort(cmp);
  }

  /**
   * 🔴 **飾り記号は、日本語を含まないリテラルにも当てる**(`${}` を伏せると日本語が残らない行が
   * 「画面の字ではない」と読まれて素通りしていた ── `${x} ── ${y}` が 7 か所残っていた)。
   * ⚠ 飾り記号は日本語の有無に関係なく**画面の字には要らない**ので、フィルタを外しても誤検知しない。
   */
  it('飾り記号(🔴 / 🔑 / ──)は、日本語を含まない文字列リテラルにも無い', () => {
    const decor = BANNED_TERMS.filter((b) => b.reason === '飾り記号');
    expect(decor.length).toBeGreaterThanOrEqual(3);
    const hits: string[] = [];
    let literals = 0;
    for (const f of files) {
      const stripped = codeOnly(readFileSync(f, 'utf8'));
      for (const lit of extractLiterals(stripped)) {
        literals += 1;
        const masked = maskInterpolation(lit);
        // 主キーの列に付ける絵(物としての鍵 🔑)── 説明文の飾りではない
        if (f === 'src/features/query/er-layout.ts' && lit === ' 🔑') continue;
        for (const d of decor) if (d.pattern().test(masked)) hits.push(`${f}: 「${d.banned}」 ${lit.slice(0, 60)}`);
      }
    }
    expect(literals).toBeGreaterThan(5000);
    // self-test:補間だけが日本語の行(`${a} ── ${b}`)を、この門は見つける
    const dash = decor.find((d) => d.banned === '──');
    expect(dash?.pattern().test(maskInterpolation('${a} ── ${b}'))).toBe(true);
    expect(JAPANESE.test(maskInterpolation('${a} ── ${b}'))).toBe(false);
    expect(hits).toEqual([]);
  });

  it('普通の語として使う物は、件数まで当たっている(増えても減っても落ちる)', () => {
    const rows = currentRows();
    for (const [file, word, count] of ORDINARY_USES) {
      const row = rows.find((r) => r[0] === file && r[1] === word);
      expect(row, `${file} に「${word}」が無い(理由が消えたなら行を消す)`).toBeDefined();
      expect(row?.[2], `${file} の「${word}」の件数`).toBe(count);
    }
  });

  it('いまの残りと一致する(増えたら落ちる。直したら KNOWN_BANNED から消す)', () => {
    const ordinary = new Set(ORDINARY_USES.map(([f, w]) => `${f}\u0000${w}`));
    const rows = currentRows().filter((r) => !ordinary.has(`${r[0]}\u0000${r[1]}`));
    expect(rows).toEqual([...KNOWN_BANNED].sort(cmp));
  });

  /**
   * 🔑 **「⚠」は危険・不可逆を言う文の先頭にだけ**(user 指示 2026-10-06)。
   * ⚠ 字の意味(危険か)は機械では読めないので、**残ってよい file と件数を等値で pin する**
   *   ── 増えたら落ちる(足した人が「これは危険を言う文か」を 1 度考える)。
   */
  const WARNING_MARKS: readonly [file: string, count: number][] = [
  ['src/adapter/ui/actions/binder.ts', 1], // 取り込みで長すぎる電話・メールを外した(データが減る)
  ['src/adapter/ui/render/commands.ts', 2], // 作り直し・全消去の確認(戻せない)
  ['src/adapter/ui/render/office-pack-panel.ts', 1], // Office で書いたマクロが消える
  ['src/features/asset/image-shrink.ts', 1], // 縮めると元の細かさは戻らない
  ['src/features/entry-actions.ts', 1], // CSV にすると桁揃えが落ちる
  ['src/features/query/sql-to-note.ts', 1], // 上限で切っている(出力が欠ける)
  ['src/features/selfhost/bundle.ts', 3], // 番号を変えると前のノートが見えなくなる(3 つのスクリプト)
  ['src/features/storage/container-rebuild.ts', 7], // 作り直しの結末・戻らないもの
  ['src/features/storage/container-reset.ts', 4], // 全消去の確認(取り出していない・消える)/ 消せなかった添付がある
  ['src/features/storage/db-rescue.ts', 1], // 読めなかった所がある
  ['src/features/storage/rescue-archive.ts', 2], // 本文を読めなかった・つながりと履歴は戻せない
  ['src/features/storage/storage-notice.ts', 1], // この画面だけ(閉じると消える)
  ['src/features/structure/structure-text.ts', 1], // 件数が多くて一部だけ出している
  ['src/main.ts', 4], // 保存できなかった・添付が読めなかった・本体への切り替え失敗・相手の編集を上書きする
];

  it('「⚠」を使っている file と件数が、pin と一致する', () => {
    const rows: [string, number][] = [];
    for (const f of files) {
      const n = (literalsByFile.get(f) ?? '').split('⚠').length - 1;
      if (n > 0) rows.push([relative('.', f).split('\\').join('/'), n]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    expect(rows).toEqual([...WARNING_MARKS].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  });
});

/**
 * 🔴 **`public/` の画面の字も同じ門で見る**(2026-10-06)。PDF を読むウィンドウと Office のウィンドウは
 * `src` の外(`public/**` の素の HTML / JS)にあり、直す前は走査の外で「頁」「窓」「ノートへ引く」が残っていた。
 * ⚠ 見るのは**画面に出る字**だけ:JS は文字列リテラル、HTML は `<script>` / `<style>` / コメントを
 *   除いた本文の字と属性の値。コードの字(識別子・CSS)を英語の素通しと読ませない。
 */
describe('public の画面の字に使わない語', () => {
  function walkPublic(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkPublic(full, out);
      else if (name.endsWith('.html') || name.endsWith('.js')) out.push(full.split('\\').join('/'));
    }
    return out;
  }

  function screenTexts(file: string): string[] {
    const raw = readFileSync(file, 'utf8');
    const lits = (js: string): string[] =>
      extractLiterals(codeOnly(js))
        .map(maskInterpolation)
        .filter((l) => JAPANESE.test(l));
    if (file.endsWith('.js')) return lits(raw);
    const scripts: string[] = [];
    const rest = raw
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
        scripts.push(body);
        return '';
      })
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const out: string[] = scripts.flatMap(lits);
    // 属性の値(`title="…"` / `aria-label="…"` / `placeholder="…"`)
    for (const m of rest.matchAll(/="([^"]*)"/g)) if (m[1] !== undefined && JAPANESE.test(m[1])) out.push(m[1]);
    // タグの間の本文の字
    for (const m of rest.matchAll(/>([^<>]+)</g)) if (m[1] !== undefined && JAPANESE.test(m[1])) out.push(m[1]);
    return out;
  }

  const files = walkPublic('public');

  it('空振り防止:public の HTML / JS と画面の字を数えている(pdf と office が入っている)', () => {
    expect(files).toContain('public/pdf/host.html');
    expect(files).toContain('public/pdf/reader.js');
    expect(files).toContain('public/office/host.html');
    const total = files.reduce((n, f) => n + screenTexts(f).length, 0);
    expect(total).toBeGreaterThan(80);
  });

  it('self-test:public の HTML の本文・属性・JS の文字列から、使わない語を見つける', () => {
    const hit = (word: string, s: string): boolean => {
      const t = BANNED_TERMS.find((b) => b.banned === word);
      if (!t) throw new Error(`BANNED_TERMS に「${word}」が無い`);
      return t.pattern().test(s);
    };
    expect(hit('頁', '前の頁へ')).toBe(true);
    expect(hit('頁', '前のページへ')).toBe(false);
  });

  it('使わない語が 1 件も無い(増えたら落ちる)', () => {
    const rows: string[] = [];
    for (const f of files) {
      for (const text of screenTexts(f)) {
        for (const b of BANNED_TERMS) if (b.pattern().test(text)) rows.push(`${f}: 「${b.banned}」 ${text.slice(0, 50)}`);
      }
    }
    expect(rows).toEqual([]);
  });
});

describe('ボタンの label に動詞句(「て、」)を禁止', () => {
  const VERB_PHRASE = /て、/;

  function findsVerbPhrases(labels: readonly string[]): string[] {
    return labels.filter((l) => VERB_PHRASE.test(l));
  }

  it('空振り防止:検める label は 5 件を超える', () => {
    const all = [...COLLECTION_COMMANDS, ...SETTINGS_COMMANDS, ...COLLECTION_PANE_COMMANDS];
    expect(all.length).toBeGreaterThan(5);
  });

  it('self-test:わざと入れた 1 件は検出できる', () => {
    expect(findsVerbPhrases(['拾って、戻せる形で書き出す'])).toEqual([
      '拾って、戻せる形で書き出す',
    ]);
    expect(findsVerbPhrases(['バックアップ'])).toEqual([]);
  });

  /**
   * 🔑 **画面の字から引く**(CLAUDE.md #996「押してください、と書いた物が画面に
   * 実在するか」と同じ作法)── 期待値を手で書かない。3 つの登記簿の `label` を
   * そのまま検める。2026-09-21 実測:0 件(§1017 段④b で既に直っている)。
   */
  const KNOWN_VERB_PHRASES: readonly string[] = [];

  it('登記された label に動詞句が残っていない(増えたら落ちる)', () => {
    const labels = [...COLLECTION_COMMANDS, ...SETTINGS_COMMANDS, ...COLLECTION_PANE_COMMANDS].map(
      (c) => c.label,
    );
    expect(findsVerbPhrases(labels)).toEqual([...KNOWN_VERB_PHRASES]);
  });

  /**
   * 🔴 `iconButton(action, label)` の呼び出しと、`document.createElement('button')`
   * で作った変数への `.textContent = '…'` も同じ規則で検める(登記簿の外にも
   * ボタンが在るため ── `container-repair` の `toggle` 等)。
   */
  it('src/adapter/ui の iconButton(...) / ボタンの textContent にも動詞句が無い', () => {
    const files = walkTs('src/adapter/ui');
    expect(files.length).toBeGreaterThan(30);
    const found: string[] = [];
    for (const f of files) {
      const stripped = codeOnly(readFileSync(f, 'utf8'));
      const btnVars = new Set<string>();
      const declRe = /const\s+(\w+)\s*=\s*document\.createElement\(\s*['"`]button['"`]\s*\)/g;
      let dm: RegExpExecArray | null;
      while ((dm = declRe.exec(stripped))) if (dm[1] !== undefined) btnVars.add(dm[1]);
      for (const v of btnVars) {
        const tcRe = new RegExp(`${v}\\.textContent\\s*=\\s*(['"\`])((?:[^\\\\]|\\\\.)*?)\\1`, 'g');
        let m: RegExpExecArray | null;
        while ((m = tcRe.exec(stripped))) {
          const val = m[2] ?? '';
          if (VERB_PHRASE.test(val)) found.push(`${f}:${v}=${val}`);
        }
      }
      const iconRe = /iconButton\([^,]+,\s*(['"`])((?:[^\\]|\\.)*?)\1/g;
      let im: RegExpExecArray | null;
      while ((im = iconRe.exec(stripped))) {
        const val = im[2] ?? '';
        if (VERB_PHRASE.test(val)) found.push(`${f}:iconButton=${val}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe('メッセージの文に英語の識別子を禁止', () => {
  /**
   * ⚠ **`STANDARD_TERMS` に加えて、この門だけの追加許可が要る**(§6.1 の 24 語の
   * 表を勝手に増やさない ── ここは「型・ボタンの名前」ではなく「文中に出てよい
   * 固有名詞・プロトコル名」なので別枠にする):
   * - `PKC` / `PKC2` / `PKC3` … アプリ自身の名前(製品名は識別子ではない)
   * - `http` / `https` … アドレスの書き方を説明する文に出る、プロトコルの名前
   * - `vCard` … user が扱う既知の外部形式名(.vcf の正式名)
   */
  const MESSAGE_ENGLISH_ALLOW = new Set(
    ['Markdown', 'HTML', 'PDF', 'Word', 'PowerPoint', 'zip', 'CSV', 'SQL', 'JSON', 'URL',
      'PKC', 'PKC2', 'PKC3', 'http', 'https', 'vCard'].map((s) => s.toUpperCase()),
  );

  const LIT = "(['\"`])((?:[^\\\\]|\\\\.)*?)\\1";
  const PATTERNS: readonly [RegExp, string][] = [
    [new RegExp(`type:\\s*'OP_FAILED'[\\s\\S]{0,300}?error:\\s*${LIT}`, 'g'), 'OP_FAILED.error'],
    [new RegExp(`type:\\s*'OP_NOTICE'[\\s\\S]{0,300}?message:\\s*${LIT}`, 'g'), 'OP_NOTICE.message'],
    [new RegExp(`showStatus\\??\\.?\\(\\s*${LIT}`, 'g'), 'showStatus(...)'],
    [new RegExp(`appMessagePost\\.post\\([\\s\\S]{0,300}?text:\\s*${LIT}`, 'g'), 'appMessagePost.post().text'],
  ];

  function englishIdentifiers(literal: string): string[] {
    const withoutInterpolation = literal.replace(/\$\{[^}]*\}/g, ' ');
    const idents = withoutInterpolation.match(/[A-Za-z_][A-Za-z_]{2,}/g) ?? [];
    return idents.filter((w) => !MESSAGE_ENGLISH_ALLOW.has(w.toUpperCase()));
  }

  it('self-test:わざと入れた 1 件は検出できる', () => {
    expect(englishIdentifiers('worker がまだ起動していません')).toEqual(['worker']);
    expect(englishIdentifiers('PKC2 の書出しは 1 つずつ')).toEqual([]);
  });

  const KNOWN_ENGLISH_IN_MESSAGES: readonly [file: string, place: string, literal: string][] = [];

  it('OP_FAILED.error / OP_NOTICE.message / showStatus / appMessagePost.post().text に英語識別子が無い', () => {
    const files = ROOTS.flatMap((r) => walkTs(r));
    let opFailedHits = 0;
    const found: [string, string, string][] = [];
    for (const f of files) {
      const stripped = codeOnly(readFileSync(f, 'utf8'));
      opFailedHits += (stripped.match(/type:\s*'OP_FAILED'/g) ?? []).length;
      for (const [re, label] of PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped))) {
          const val = m[2] ?? '';
          if (englishIdentifiers(val).length > 0) {
            found.push([relative('.', f).split('\\').join('/'), label, val]);
          }
        }
      }
    }
    // 空振り防止:設計 doc §7 が言う「OP_FAILED(241 か所)」の規模を裏取りする
    expect(opFailedHits).toBeGreaterThan(100);
    found.sort((a, b) => (a[0] === b[0] ? (a[2] < b[2] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    expect(found).toEqual([...KNOWN_ENGLISH_IN_MESSAGES]);
  });
});
