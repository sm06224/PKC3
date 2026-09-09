/**
 * 🔴 **打たれた SQL が「読むだけ」か**(#681 段①)。
 *
 * > user の言葉 2026-09-03:「**内蔵の sqlite を最大限活用したインスタントな
 * > csv や sqliteDB のクエリアプリ**」
 *
 * ## なぜ門が要るか ── 取り消せない壊し方を作らない
 *
 * ノートの正本は同じ sqlite の中に在る。⚠ そこへ `UPDATE` / `DROP` を打てる口を
 * 作ると、**user が自分の全ノートを 1 行で消せる**(不可侵の「不可逆・外向き」)。
 * 🔑 だから**読むだけを既定**にする ── 書きたい要求が出たら、そのときに
 * 「取り込んだ DB にだけ書ける」形で別に作る。
 *
 * ## 🔴 ここは**境ではない** ── 断る理由を**字で言う**ための門である
 *
 * ⚠ この一言が無いと、次に読む人(= 自分)は**字の検査を安全の境と読む**。
 *   字で見分ける以上、知らない書き方が出れば漏れうる ── 漏れたときに
 *   「通っているのだから安全なはず」と読まれるのが、いちばん悪い形である。
 *
 * 🔑 **本当の境は sqlite の側に置く**(2026-09-09 に同梱の 3.53.0 で実測):
 * - `PRAGMA query_only = 1` ── 書き込みは `SQLITE_READONLY` で**engine が断る**
 *   (実測:`create table` は落ち、`select` は通る)
 * - `sqlite3_progress_handler` ── 終わらない問い合わせを**止められる**
 *   (実測:直積を **3ms** で `SQLITE_INTERRUPT`)。⚠ ノートの DB を持つ worker は
 *   アプリの生命線なので、止められない問い合わせは**保存ごと固める**
 *
 * ⚠ つまり 2 つは**同じ判定の 2 か所**ではない(§7 の罠ではない)──
 *   こちらは**打つ前に読める字**、あちらは**engine の境**で、役目が違う。
 *   ⚠ どちらか一方だけにしない:字だけでは漏れ、engine だけでは
 *   「SQLITE_READONLY」としか出ない(user には読めない)。
 *
 * ## ⚠ 字面で見分けるので、**騙されない前処理**が要る
 *
 * `SELECT 'DROP TABLE'` は読むだけだが、素朴に語を探すと止めてしまう。逆に
 * `/* ok *\/ DROP TABLE t` は書き込みなのに、先頭だけ見ると `/` に見える。
 * 🔑 だから**注釈と文字列を先に落としてから**、残った字で見分ける。
 *
 * ⚠ これは**構文解析ではない**。だから判定は**安全側**へ倒す ──
 * 「読むだけと**確信できる形**」以外は全部断る(白名簿。⚠ 黒名簿にしない ──
 * 知らない書き方が出たときに**通してしまう**側へ倒れる)。
 */

/** 判定の結果。⚠ 断るときは**理由を字で**返す(無言で断らない)。 */
export interface SqlCheck {
  readonly ok: boolean;
  /** 断る理由(`ok` のときは空)。⚠ そのまま画面に出せる字にする。 */
  readonly why: string;
  /**
   * 🔴 **実際に打つべき字**(全角を半角へ直した後)。
   * ⚠ 呼ぶ側は**これを打つ** ── 元の字を打つと、日本語入力のまま書いた人だけ
   *   sqlite の構文エラーになる(門は通ったのに動かない、が最悪の形である)。
   *
   * 🔴 **約束を型で守るのは、ここではなく実行の口である**(着地前レビュー 2026-09-09)。
   *   ⚠ `ok` だけ見て**元の字を打つ**書き方をしても、この形では tsc が黙る。
   *   🔑 だから段② の実行の口は**生の文字列を受けない** ── `SqlCheck` そのものを
   *   受け取る形にする(CLAUDE.md #178「衝突は、検出するより**起こらなくする**ほうが
   *   強い」)。⚠ `ok:false` の側にも `sql` を残すのは、断り文の隣に
   *   **直した後の字**を出して「なぜ断られたか」を読めるようにするためである。
   */
  readonly sql: string;
}

/**
 * 注釈と文字列・識別子の中身を落とす(**長さは保つ**)。
 *
 * ⚠ 落とすのではなく**空白へ置き換える** ── 位置がずれると、後で
 *   「何文字目が悪いか」を言えなくなる。
 * ⚠ SQLite の文字列は `'...'`(中の `''` は 1 つの `'`)、識別子は `"..."` /
 *   `` `...` `` / `[...]`。
 */
export function stripSqlNoise(sql: string): string {
  /**
   * 🔴 **符号単位で切る。** `[...sql]` は**符号点**で切るので、絵文字 1 つにつき
   *   位置が 1 つずれ、**文字列の後ろを絵文字の数だけ余計に塗り潰す**。
   *
   * ⚠ 実測(直す前):`SELECT '<絵文字 3 つ>'; DROP TABLE t` は閉じ引用符の後ろを
   *   3 字ぶん余計に塗り潰して **`ROP TABLE t`** になり、**`;` も `DROP` も消えて
   *   `ok: true`** ── つまり**全ノートを消す 2 文目が門を素通りする**。
   * ⚠ 絵文字 **1〜2 個では旧実装でも断れていた**(`DROP` が残るため)── だから
   *   test は **3 個**でなければ、この門を守っている証拠にならない。
   */
  const out = sql.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      blank(i, end < 0 ? sql.length : end);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      blank(i, end < 0 ? sql.length : end + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      /**
       * ⚠ **`''`(中の 1 つの `'`)を特別扱いしない。**
       *
       * 1 稿目は「`''` は 1 つの `'` なので、そこで切ってはいけない」と書いて
       * 分岐を持っていたが、🔴 **外しても結果が 1 バイトも変わらなかった**
       * (変異試験 S11 が SURVIVED で教えた)── 素朴に閉じると
       * `'a''b'` は `'a'` + `'b'` の 2 本になるが、**塗り潰す字は同じ**である
       * (2 本は隣り合っているので隙間ができない)。
       * 🔑 ここが欲しいのは**境界**ではなく「**中身を語として数えない**」ことだけ
       *   なので、分岐は要らない(CLAUDE.md「これが無いと壊れる、と書く前に
       *   外して壊れるのを見る」)。
       */
      const end = sql.indexOf(c, i + 1);
      blank(i, end < 0 ? sql.length : end + 1);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (c === '[') {
      const end = sql.indexOf(']', i);
      blank(i, end < 0 ? sql.length : end + 1);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * 🔴 **日本語入力のまま打たれた字を直す**(全角 → 半角)。
 *
 * ⚠ user は**IME を切らずに**打つ(#764 で実測 ── `２＋３＝` で何も起きなかった)。
 *   SQL も同じで、`ＳＥＬＥＣＴ` は sqlite にとってただの構文エラーである。
 *
 * 🔑 直すのは**文字列と注釈の外だけ** ── `WHERE s LIKE '％ＡＢＣ％'` の中まで
 *   直すと、**user が探したい字そのものを書き換えてしまう**。
 * ⚠ 見分けには `stripSqlNoise`(長さを保つ)を使う ── 塗り潰されなかった位置が
 *   「外」である。⚠ 全部を全角で打った人は引用符も全角なので文字列が 1 つも
 *   見つからず、**丸ごと直る**(それが望みの動きである)。
 */
export function normalizeSqlInput(sql: string): string {
  const mask = stripSqlNoise(sql);
  return sql
    .split('')
    .map((ch, i) => {
      if (mask[i] !== ch) return ch;
      if (ch === '\u3000') return ' ';
      const code = ch.charCodeAt(0);
      return code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
    })
    .join('');
}

/**
 * 🔴 **書き込む語**(白名簿の外にあるもの)。⚠ ここは**補助**であって
 * 判定の本体ではない ── 本体は「先頭が読む語か」である。
 * 🔑 `WITH` は読むだけにも書き込みにも使えるので、**中身も見る**必要がある。
 *
 * ⚠ **この一覧のうち、実際に書き込みが届くのは 4 語だけ**である
 *   (着地前レビュー 2026-09-09 の実測):
 * - 🔴 `insert` / `update` / `delete` / `replace` ── **`WITH … ` の後ろに置けて、
 *   実際に行が動く**。だから **1 語ずつ**「その語だけが鳴る場面」を test に持つ
 *   (`WRITE_WORDS` を丸ごと殺す変異では、この 4 つの穴は見えない)
 * - 残りは `WITH` の後ろに置けないので、届くのは `EXPLAIN <書き込み>` の形だけ ──
 *   ⚠ **`EXPLAIN` は文を実行しない**ので実害は無い(**それでも残す** ── 打った人に
 *   「読み取り専用です」と言うほうが、意味の無い実行計画を出すより親切である)
 */
const WRITE_WORDS = [
  'insert',
  'update',
  'delete',
  'replace',
  'drop',
  'create',
  'alter',
  'attach',
  'detach',
  'vacuum',
  'reindex',
  'analyze',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'pragma',
] as const;

/** 読むだけと確信できる先頭の語(白名簿)。 */
const READ_HEADS = ['select', 'with', 'values', 'explain'] as const;

/**
 * 打たれた SQL が「読むだけ」か。
 *
 * ⚠ **1 文だけ**しか受けない ── `SELECT 1; DROP TABLE t` を通さないため。
 *   末尾の `;` は許す(打ち慣れた人が付けるので、そこで断るのは意地悪である)。
 */
export function checkReadOnlySql(input: string): SqlCheck {
  const sql = normalizeSqlInput(input);
  const bare = stripSqlNoise(sql).trim();
  if (bare === '') return { ok: false, why: 'SQL が空です', sql };

  // ⚠ `bare` は `trim()` 済みなので `;\s*$` の `\s*` は**到達しない**(no-op を残さない)
  const body = bare.replace(/;$/, '');
  if (body.includes(';')) {
    return { ok: false, why: '1 度に打てるのは 1 文だけです(`;` で区切らないでください)', sql };
  }

  /**
   * ⚠ **先頭の丸括弧を数に入れない** ── `(SELECT 1) UNION SELECT 2` は読むだけだが、
   *   素直に先頭を読むと `(` になり、白名簿から落ちる(**書ける物が書けなくなる**)。
   * 🔑 落とすのは括弧と空白だけで、**判定そのものは緩めない**
   *   (`(FOOBAR)` は `foobar` として白名簿に当たり、やはり断る)。
   */
  const openless = body.replace(/^[\s(]+/, '');
  const head = /^[a-z]+/i.exec(openless)?.[0]?.toLowerCase() ?? '';
  if (!READ_HEADS.includes(head as (typeof READ_HEADS)[number])) {
    return {
      ok: false,
      why: `読み取り専用です ── \`${head === '' ? body.slice(0, 8) : head.toUpperCase()}\` は打てません(打てるのは SELECT / WITH / VALUES / EXPLAIN です)`,
      sql,
    };
  }

  /**
   * ⚠ **`WITH … INSERT` は SQLite で書ける** ── 先頭だけ見ると読むだけに見える。
   * 🔑 だから**語として**書き込みの語が混じっていないかを見る
   *   (部分一致にしない ── `updated_at` という列名で止めない)。
   *
   * ⚠ **語の切り方を間違えると、断る側へ倒れる** ── 鳴っても不具合に見えないので、
   *   実測した 2 つを書いておく:
   *   - **数字**も語の一部(`insert2` を `insert` に化けさせない)
   *   - **`$`** も語の一部(SQLite の識別子文字。`a$insert` で止めない)
   *
   * 🔴 **直後が `(` なら関数呼び出しとみなして通す**(着地前レビュー 2026-09-09)。
   *   ⚠ `replace()` は SQLite の標準の関数で、**文字列を置き換えるいちばん普通の書き方**
   *   である ── 止めると `SELECT replace(title,'a','b')` が打てない。
   *   🔑 緩めても抜け道にならないことは実測した:`REPLACE (…)` / `DELETE (a) FROM …` /
   *   `UPDATE (t) SET …` / `INSERT (INTO) …` は**どれも sqlite が構文エラーで断る**
   *   (文としての書き込みは、必ず語の後ろに `(` 以外が来る)。
   * ⚠ **その事実は engine 側の話なので、engine の側で pin する** ──
   *   `tests/adapter/sqlite-capabilities.test.ts` が同梱の sqlite に当てて確かめる。
   *   そこが通るようになった日が、この緩和を取り消す合図である。
   */
  const hit = [...body.toLowerCase().matchAll(/([a-z0-9_$]+)(\s*\()?/g)].find(
    (m) => m[2] === undefined && WRITE_WORDS.includes(m[1] as (typeof WRITE_WORDS)[number]),
  )?.[1];
  if (hit !== undefined) {
    return {
      ok: false,
      why: `読み取り専用です ── \`${hit.toUpperCase()}\` は打てません`,
      sql,
    };
  }
  return { ok: true, why: '', sql };
}
