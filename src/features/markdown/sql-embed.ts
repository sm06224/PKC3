/**
 * 🔴 **本文に SQL の答えを埋め込む**(#1223。Gemini 裁定 2026-10-01)。
 *
 * ````
 * ```sql embed
 * SELECT 地域, sum(金額) FROM 売上 GROUP BY 地域
 * ```
 * ````
 *
 * と書くと、**そのコード枠の下に答えの表**が出る。
 *
 * ## 綴り(Q1 = B)
 *
 * 見出しの**後ろに語を足す**(`csv name=売上` と同じ形)。🔑 今の ` ```sql ` は
 * **1 バイトも変えない** ── だから `sql` を fence の登録(`RENDERABLE_FENCE_LANGS`)へ
 * 足さない(足すと `-render` / `-norender` の接尾辞や切替の ‹/› まで受けてしまい、
 * 今の色づけだけの囲みが別物になる)。
 *
 * ## 相手は**この PKC のノート(sqlite)だけ**で、**読むだけ**
 *
 * 引く口は SQL を打つ面と**同じ**(`runReadOnlySql`)で、字の門(`sql-guard.ts`)と
 * `PRAGMA query_only` の両方を通る。⚠ DuckDB は含めない(「使うときだけ載せる」裁定に
 * 当たる)。
 *
 * ## ⚠ ここは features 層 ── 引かない
 *
 * ここが持つのは**綴りの判定・上限の数・答えの表の組み立て**だけ。引くのは adapter
 * (`sql-embed-hydrate.ts`)で、書き出しの焼き込み(`bakeSqlEmbeds`)も同じ答えの形を使う。
 */

/** 器の印。⚠ 描く側(`markdown-render.ts`)・埋める側・書き出し・コピーが**同じ綴りを読む**。 */
export const SQL_EMBED_ATTR = 'data-pkc-sql-embed';
/** 原文の SQL(属性にエスケープして持つ)。⚠ 器だけを見て引けるように。 */
export const SQL_EMBED_SRC_ATTR = 'data-pkc-sql-embed-src';
/** 「さらに N 行」の押し所の `data-pkc-field`。 */
export const SQL_EMBED_MORE_FIELD = 'sql-embed-more';
/** 答えの下の注記(行が無い / 打ち切り / 引けなかった)の `data-pkc-field`。 */
export const SQL_EMBED_NOTE_FIELD = 'sql-embed-note';

/**
 * 🔴 **閲覧用の上限は、SQL を打つ面と別に、小さく持つ**(Q4 = 200 行)。
 *
 * ⚠ **測って決める数ではなく、2026-10-02 の初期値**である(測ったら直す)。
 * ⚠ SQL を打つ面の上限(`store-effects.ts` の `SQL_MAX_*` = 20 万行 / 20 万歩 / 8 秒)は
 *   **調べる人が自分で押す**ための数で、**本文を開くたびに走る**この埋め込みには大きすぎる。
 *   本文を開いただけで 8 秒止まる / 20 万行を詰めると、**保存を待たせる**
 *   (同じ worker・同じ接続で走る)。
 */
/** 画面に出す行数(超えたら「さらに N 行」で次の 200)。 */
export const SQL_EMBED_PAGE_ROWS = 200;
/**
 * 1 回の問い合わせで受け取る行数の天井。⚠ 「さらに N 行」の**材料**であって、
 * 画面に出す数ではない(5 ページぶん)。これを超えたら打ち切り、そう言う。
 */
export const SQL_EMBED_FETCH_ROWS = 1000;
/**
 * 時間の天井(ms)。⚠ 別窓(follower)は本体タブへの依頼を 10 秒で諦める
 * (`SQL_MAX_MS` の注記)── それより**ずっと手前**で止める。
 */
export const SQL_EMBED_MAX_MS = 2000;
/**
 * 歩数の天井。⚠ SQL を打つ面(`store-effects.ts` の `SQL_MAX_STEPS` = 20 万)の
 * **1/10**(門は `tests/adapter/sql-embed-hydrate.test.ts` が両方を読んで突き合わせる)。
 */
export const SQL_EMBED_MAX_STEPS = 20_000;

/** 答え。⚠ `runReadOnlySql` が返す形のうち、表に要る所だけ(`ms` は使わない)。 */
export interface SqlEmbedAnswer {
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | null>>;
  /** 受け取る天井(`SQL_EMBED_FETCH_ROWS`)で切ったか。 */
  readonly truncated: boolean;
}

/**
 * ` ```sql embed ` の見出しか。
 *
 * - **先頭語が `sql`、2 語目が `embed`**(語の区切りは空白 1 つ以上、大小は問わない)
 * - ⚠ `sql:embed` / `sql-embed` / `embed sql` は**そうではない**(先頭語は言語名。
 *   `csv name=` の読み方と同じで、語順は動かさない)
 * - ⚠ 3 語目以降は見ない(将来 `limit=` 等を足せる余地。いまは無視する)
 */
export function isSqlEmbedInfo(info: string | null | undefined): boolean {
  if (!info) return false;
  const words = info.trim().split(/\s+/);
  return words[0]?.toLowerCase() === 'sql' && words[1]?.toLowerCase() === 'embed';
}

/** HTML の字を逃がす。⚠ `markdown-render.ts` の `md.utils.escapeHtml` と同じ 4 つ。 */
export function escapeSqlEmbedHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 上の逆。⚠ 器の属性から原文を戻すときだけ使う(この 4 つ以外は出てこない)。 */
export function unescapeSqlEmbedHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** 表の値を字にする。⚠ `null` と空文字を**見分けられる**ようにする(SQL を打つ面と同じ)。 */
export function sqlCellText(v: string | number | null): string {
  return v === null ? '(なし)' : String(v);
}

/**
 * 器の HTML(描くときに置く物)。⚠ **中身は空** ── 答えは埋める側が入れる。
 * 🔑 `markdown-render.ts` はこれを**コード枠の末尾**に足す(枠そのものは ` ```sql ` と
 * 1 バイトも違わない ── 差はこの 1 要素だけ)。
 */
export function sqlEmbedHostHtml(sql: string): string {
  return `<div ${SQL_EMBED_ATTR} ${SQL_EMBED_SRC_ATTR}="${escapeSqlEmbedHtml(sql)}"></div>`;
}

/**
 * 答えを HTML にする。
 *
 * ⚠ **中身は全部エスケープする**(`textContent` と同じ安全 ── 呼び側は `innerHTML` に入れる)。
 * @param shown 出す行数(先頭から)
 * @param interactive 画面のとき `true`(「さらに N 行」を押し所にする)/
 *   書き出しは `false`(押せない字の注記にする ── 閲覧側に受け手が居ない)
 */
export function sqlEmbedAnswerHtml(
  answer: SqlEmbedAnswer,
  shown: number,
  interactive: boolean,
): string {
  const note = (text: string): string =>
    `<p data-pkc-field="${SQL_EMBED_NOTE_FIELD}">${escapeSqlEmbedHtml(text)}</p>`;
  if (answer.rows.length === 0) {
    return note('該当する行はありません');
  }
  const head = answer.columns.map((c) => `<th>${escapeSqlEmbedHtml(c)}</th>`).join('');
  const rows = answer.rows
    .slice(0, shown)
    .map(
      (r) =>
        `<tr>${r.map((v) => `<td>${escapeSqlEmbedHtml(sqlCellText(v))}</td>`).join('')}</tr>`,
    )
    .join('');
  let out = `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  const remaining = answer.rows.length - shown;
  if (remaining > 0) {
    if (interactive) {
      const n = Math.min(remaining, SQL_EMBED_PAGE_ROWS);
      out +=
        `<button type="button" data-pkc-field="${SQL_EMBED_MORE_FIELD}">` +
        `さらに ${String(n)} 行</button>`;
    } else {
      out += note(`ほかに ${String(remaining)} 行あります(ここには ${String(shown)} 行まで出しています)`);
    }
  } else if (answer.truncated) {
    out += note(`先頭の ${String(answer.rows.length)} 行までです(これより先は出していません)`);
  }
  return out;
}

/** 引けなかったときの 1 行(原文のコード枠はそのまま残る)。 */
export function sqlEmbedFailureHtml(why: string): string {
  return `<p data-pkc-field="${SQL_EMBED_NOTE_FIELD}">${escapeSqlEmbedHtml(`答えを引けませんでした: ${why}`)}</p>`;
}

/** 器の HTML を取り出す正規表現。⚠ `sqlEmbedHostHtml` が組む形と**同じ綴り**(門は test)。 */
const HOST_RE = new RegExp(
  `<div ${SQL_EMBED_ATTR} ${SQL_EMBED_SRC_ATTR}="([^"]*)"></div>`,
  'g',
);

/**
 * 🔴 **書き出す HTML へ、書き出した時点の答えを焼く**(Q3 = B)。
 *
 * 描いた**後の HTML** の器(`sqlEmbedHostHtml` の形)を見つけ、答えを引いて中へ入れる。
 * 原文のコード枠は**そのまま残る**(器の外にある)。
 *
 * 🔑 **描いた後の HTML から読む**(`collectFenceAssetKeys` のように本文を読み直さない)── 前処理
 *   (`{{vars}}` の展開など)の後の字が、**実際に描かれた SQL** だからである。本文を別の
 *   経路で読むと、描いた字と引く字がずれうる。
 * ⚠ **同じ SQL は 1 回しか引かない**。⚠ 引くのは**直列**(1 本ずつ待つ ── 保存を待たせない)。
 * ⚠ **引けなかったら 1 行の注記**(黙って空にしない)。他の SQL は続ける。
 * ⚠ 器が 0 個なら**何も呼ばない**(`ask` を 1 度も呼ばない = 本文に埋め込みの無いノートの
 *   書き出しは 1 バイトも変わらない)。
 */
export async function bakeSqlEmbeds(
  html: string,
  ask: (sql: string) => Promise<SqlEmbedAnswer>,
): Promise<string> {
  if (!html.includes(SQL_EMBED_ATTR)) return html;
  const answers = new Map<string, string>();
  const matches = [...html.matchAll(HOST_RE)];
  for (const m of matches) {
    const sql = unescapeSqlEmbedHtml(m[1] ?? '');
    if (answers.has(sql)) continue;
    try {
      const a = await ask(sql);
      answers.set(sql, sqlEmbedAnswerHtml(a, SQL_EMBED_PAGE_ROWS, false));
    } catch (e) {
      answers.set(sql, sqlEmbedFailureHtml(e instanceof Error ? e.message : String(e)));
    }
  }
  return html.replace(HOST_RE, (whole, src: string) => {
    const inner = answers.get(unescapeSqlEmbedHtml(src));
    if (inner === undefined) return whole;
    return `<div ${SQL_EMBED_ATTR} ${SQL_EMBED_SRC_ATTR}="${src}" data-pkc-sql-embed-state="baked">${inner}</div>`;
  });
}
