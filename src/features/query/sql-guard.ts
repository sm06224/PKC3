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
 * 「取り込んだ DB にだけ書ける」形で別に作る(**判定はここ 1 か所**)。
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
   * ⚠ 実測(直す前):`SELECT '<絵文字 3 つ>'; DROP TABLE t` は `; DR` まで
   *   食べられて `OP TABLE t` になり、**`;` も `DROP` も消えて `ok: true`** ──
   *   つまり**全ノートを消す 2 文目が門を素通りする**。
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

  const body = bare.replace(/;\s*$/, '');
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
   * ⚠ **数字も語の一部に数える** ── `[a-z_]+` だけで切ると `insert2` が
   *   `insert` に化け、**そういう名前の列を持つ user の表が引けなくなる**
   *   (断る側へ倒れる誤りなので、鳴っても不具合に見えない ── だから書いておく)。
   */
  const words = body.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const hit = words.find((w) => WRITE_WORDS.includes(w as (typeof WRITE_WORDS)[number]));
  if (hit !== undefined) {
    return {
      ok: false,
      why: `読み取り専用です ── \`${hit.toUpperCase()}\` は打てません`,
      sql,
    };
  }
  return { ok: true, why: '', sql };
}
