/**
 * 🔴 **スマートフォルダの条件**(#421 段①。user 要望 2026-08-26)。
 *
 * > 1件、追加したい機能として、iPhoneとかのメモアプリにあるスマートメモのような
 * > 整理機能が欲しいです
 *
 * ## 何のために在るか
 *
 * 「請求」タグのノートがあちこちのフォルダに散っている ── いまは絞り込み欄に
 * 毎回打つしかなく、**「請求のノート」という場所がどこにも無い**。
 * 🔑 条件を**保存して、名前を付けて、場所として置く**のがこれである。
 *
 * ## 🔴 正本は本文の frontmatter(新しい入れ物を作らない)
 *
 * タグが `tags:` で済んでいるのと**同じ理由**(`flavor/tags.ts` 冒頭
 * 「新しい概念を足さない」)。⚠ 端末の保存(localStorage)に置くと
 * **書き出しにも別の端末にも乗らない**。
 *
 * ```markdown
 * ---
 * smart-tags: [請求]
 * ---
 * 月末にまとめて処理するぶん。
 * ```
 *
 * ⚠ **入れ子は使えない** ── PKC3 の frontmatter は**平らな key しか読まない**
 * (`frontmatter.ts` が「Nested mappings」を非対応と宣言している)。だから
 * 条件は `smart-〇〇` の**平らな key を並べる**形にする(段②で増える key も同じ形)。
 *
 * ## ⚠ 条件が 1 つも無いときは「何も集めない」
 *
 * 🔑 **「全部集める」にしない。** 作った直後は条件が空なので、そこで全件が
 * 並ぶと「壊れている / 作り間違えた」と読まれる ── **空は空**として出し、
 * 画面には「条件を選んでください」と書く(呼び側の仕事)。
 *
 * ⚠ **pure module**。browser API も DB も知らない。
 */
import {
  parseFrontmatter,
  spliceFrontmatterKeys,
  type FrontmatterValue,
} from '../markdown/frontmatter';
import { isKnownArchetype } from '../flavor/archetype-label';
import { countTaskCandidates } from '../markdown/task-count';
import { MAX_TAG_CHARS, normalizeTag, sameTag, splitTags } from '../flavor/tags';
import { tagsForMatch } from '../flavor/entry-tags';

/**
 * 🔴 **この入れ物の archetype**。⚠ 綴りはここ 1 か所 ── 直書きすると、
 * 足した面だけスマートフォルダが「ふつうのノート」に見える(§7)。
 */
export const SMART_ARCHETYPE = 'smart';

/** 条件を書く frontmatter の key。⚠ 段②で増えるものも `smart-` で始める。 */
export const SMART_TAGS_KEY = 'smart-tags';

/**
 * 🔴 **列で引ける条件の key**(#421 段②)。
 *
 * 🔑 **entries 表の列**をそのまま使うので、走査が要らない ── worker が
 *   **SQL で絞ってから**、タグの分だけ本文の先頭を舐める(走査の口は 1 本のまま)。
 *
 * ⚠ **起票時の 6 条件のうち 2 つは作れない**(2026-08-26 に実装を読んで判明):
 *   ①「チェック項目がある」── `task_total` は**多めに数えた候補数**で、
 *     `task-count.ts` 自身が「表示に使わないこと」と宣言している。
 *     ⚠ 一覧に並べると**項目 0 件のノートが混ざる**うえ、走査は先頭しか読まないので
 *     その場で確定もできない
 *   ②「未処理がある」── 🔴 **列が無い**(候補数であって未処理数ではない)
 *   🔑 どちらも**列を足す段**が要るので、別に立てる。
 */
export const SMART_KIND_KEY = 'smart-kind';
export const SMART_UPDATED_KEY = 'smart-updated';
export const SMART_CREATED_KEY = 'smart-created';
export const SMART_DATED_KEY = 'smart-dated';

/**
 * 🔴 **語で絞る**(#421 段③)。⚠ 当てるのは**既存の全文検索と同じ規則**である
 *   (`planSearch` ── 3 文字以上は FTS5 の trigram、2 文字以下は LIKE)。
 *
 * 🔑 **同じ問いに答える口を 2 つ作らない**(§7)── ここで独自に
 *   `body.includes(語)` と書くと、**帯で絞った結果と探す欄の結果が食い違う**
 *   (大小・正規化・区切りの扱いが別物になる)。だから当てるのは **SQL 1 か所**で、
 *   画面側は 1 文字も当てない。
 * ⚠ そのぶん**その場で当て直せない** ── タグと違って、reducer は新しい本文を
 *   持っていても答えを出せない。`needsRescan` が true を返すのはそのためである。
 */
export const SMART_TEXT_KEY = 'smart-text';

/**
 * 🔴 **チェック項目で絞る**(#421 段④)。
 *
 * ⚠ **起票時は「列を足す段」として立てたが、列は要らなかった**(2026-08-26 に検算)。
 *   段② でこう書いていた ── 「`task_total` は**多めに数えた候補数**なので、
 *   一覧に並べると**項目 0 件のノートが混ざる**。走査は本文の先頭しか読まないので
 *   **その場で確定もできない**」。⚠ **後半が誤りだった。**
 *
 * 🔑 **カンバンがまさにそれをやっている**(`runTaskScan`):
 *   ① `task_total` で**候補**に縮める(索引が在る)
 *   ② 候補の本文を**丸ごと、100 件ずつ**読んで確定する
 *   ③ 塊ごとに捨てる(heap に載るのは 100 件ぶんだけ)
 *   ⚠ `task-count.ts` 自身が「多く数えるのは無害 ── 本文を読んで項目 0 件と分かる
 *   だけ」と宣言しているとおりで、**正確さは候補の本文を読んで取り戻す**設計である。
 *
 * ⚠ だからここは**列ではなく走査**の話になる ── `SmartScan.needsFullBody` が
 *   「この条件は本文を丸ごと要る」を worker へ伝える(worker が勝手に決めない)。
 */
export const SMART_TASKS_KEY = 'smart-tasks';
export const SMART_OPEN_TASKS_KEY = 'smart-open-tasks';

/**
 * 語の長さの上限。⚠ **手違いの検出**である ── 本文を丸ごと貼られると、
 * それが**その入れ物の frontmatter に書き込まれる**(条件は本文が正本なので)。
 */
export const MAX_SMART_TEXT_CHARS = 100;

/**
 * 「N 日以内」の上限。⚠ **手違いの検出**である(3650 = 10 年)── これより長い
 * 指定は「全部」と変わらないので、条件として受けない。
 */
export const MAX_SMART_DAYS = 3650;

/**
 * 1 つのスマートフォルダが持てる条件タグの数。
 * ⚠ 上限は**手違いの検出**である ── AND なので数が増えるほど当たりは減るが、
 * 帯に 50 個並ぶと条件そのものが読めなくなる。
 */
export const MAX_SMART_TAGS = 8;

/**
 * 集める上限。⚠ 超えたぶんは **lid を持たないが数は数え続ける**
 * (「N 件中 M 件を出しています」と言えるように ── `QUERY_LIMITS` と同じ規律)。
 */
export const SMART_LIMIT = 500;

/**
 * 条件。🔑 **全部 AND** ── 書いた条件を**全部**満たすノートだけ当たる。
 * ⚠ 段③(語で絞る)で増えるものも、ここへ平らに足す。
 */
export interface SmartSpec {
  /** 🔑 **AND** ── 全部付いているノートだけ当たる。 */
  readonly tags: readonly string[];
  /** 種類(`text` / `folder` …)。⚠ 作った時に決まり、本文の書換では変わらない。 */
  readonly kind: string | null;
  /** 更新が N 日以内。`null` = 見ない。 */
  readonly updatedDays: number | null;
  /** 作成が N 日以内。`null` = 見ない。 */
  readonly createdDays: number | null;
  /**
   * 先頭に日付(frontmatter の `date:`)を書いてあるか。`null` = 見ない。
   * ⚠ **本文の行に書く `@2026-08-25` は入らない** ── 列に写るのは frontmatter だけ
   *   (`readScheduleDate`)。画面の字もそう書く(「付いているのに集まらない」を作らない)。
   */
  readonly dated: boolean | null;
  /**
   * 題名か本文にこの語があるか。`null` = 見ない(#421 段③)。
   * ⚠ **当てるのは worker の SQL だけ** ── 上の `SMART_TEXT_KEY` の注記を読むこと。
   */
  readonly text: string | null;
  /**
   * チェック項目が 1 つ以上あるか。`null` = 見ない(#421 段④)。
   * ⚠ **`task_total` の値をそのまま信じない** ── あれは多めなので、
   *   確定は本文を読んで `countTaskCandidates` で取り直す。
   */
  readonly tasks: boolean | null;
  /**
   * **未処理**のチェック項目が 1 つ以上あるか。`null` = 見ない(#421 段④)。
   * 🔑 `total - done > 0`。`countTaskCandidates` は `done` を既に返しているので、
   *   新しい数え方は要らない。
   */
  readonly openTasks: boolean | null;
}

export const EMPTY_SMART: SmartSpec = {
  tags: [],
  kind: null,
  updatedDays: null,
  createdDays: null,
  dated: null,
  text: null,
  tasks: null,
  openTasks: null,
};

/** 条件が 1 つも無いか。⚠ **空は「全部」ではなく「何も」**である(上の注記)。 */
export const isSmartEmpty = (spec: SmartSpec): boolean =>
  spec.tags.length === 0 &&
  spec.kind === null &&
  spec.updatedDays === null &&
  spec.createdDays === null &&
  spec.dated === null &&
  spec.text === null &&
  spec.tasks === null &&
  spec.openTasks === null;

/**
 * 🔴 **その場では当て直せない条件を持っているか**(#421 段②③)。
 *
 * 🔑 呼び側はこれで「**新しい本文を見て手で継ぎ足してよいか**」を決める。
 *   タグだけの入れ物は本文から答えが出るが、次の 2 つは出ない:
 *   - **列の条件**(種類 / 更新 / 作成 / 日付)── `updated_at` は保存のたびに動くし、
 *     `archetype` / `created_at` / `date` は本文からは決まらない
 *   - 🔴 **語の条件**(段③)── 当てるのは **FTS5 / LIKE = SQL 1 か所**である。
 *     ⚠ ここで `body.includes(語)` と書けば手で判定できてしまうが、それは
 *     **同じ問いに答える口を 2 つ作る**ことで、帯の並びと探す欄の結果が静かに
 *     食い違う(§7)
 *   どちらも worker に集め直しを頼む。
 *
 * ⚠ **名前を `hasColumnCond` から変えた**(段③)── 語の条件は列ではないのに
 *   ここが true を返す必要がある。名前を「列」のままにすると、次に読む人が
 *   「列だけを見ている」と読み、語の条件を**その場で当てる**枝を書き足す
 *   ── CLAUDE.md §4「計器の名前が、計器の見ている範囲と違う」型である。
 */
export const needsRescan = (spec: SmartSpec): boolean =>
  spec.kind !== null ||
  spec.updatedDays !== null ||
  spec.createdDays !== null ||
  spec.dated !== null ||
  spec.text !== null ||
  /**
   * ⚠ **チェック項目の条件も、その場では当て直せない**(段④)── 本文を書けば
   *   項目の数は変わるが、判定は `countTaskCandidates` = **走査の側**が持つ。
   *   ここで数え直すと、同じ問いに答える口が 2 つになる(§7)。
   */
  spec.tasks !== null ||
  spec.openTasks !== null;

/**
 * 本文から条件を読む。
 *
 * 受ける形は 2 つ ── **user がどちらで書いても通す**(記法を減らさない。
 * `readTags` と**同じ規則**である):
 * - 配列: `smart-tags: [請求, 未処理]`
 * - 文字列: `smart-tags: 請求, 未処理`(カンマ区切り)
 *
 * ⚠ 空・重複・長すぎるものは落とす。⚠ 並べ替えない(書いた順は user の物)。
 */
export function readSmartSpec(body: string): SmartSpec {
  const { meta } = parseFrontmatter(body);
  return {
    tags: readSmartTags(meta[SMART_TAGS_KEY]),
    kind: readKind(meta[SMART_KIND_KEY]),
    updatedDays: readDays(meta[SMART_UPDATED_KEY]),
    createdDays: readDays(meta[SMART_CREATED_KEY]),
    dated: readFlag(meta[SMART_DATED_KEY]),
    text: readText(meta[SMART_TEXT_KEY]),
    tasks: readFlag(meta[SMART_TASKS_KEY]),
    openTasks: readFlag(meta[SMART_OPEN_TASKS_KEY]),
  };
}

/**
 * 語を読む。⚠ **1 行に潰す** ── 改行やタブを跨いだ語は探せない(索引は行を跨がない)
 * し、frontmatter に書き戻すと読みにくい形になる。
 * ⚠ 空・長すぎるものは**条件にしない**(黙って切り詰めない ── 切り詰めると
 *   「書いた語と集まる語が違う」という、画面に理由の出ない形になる)。
 */
function readText(raw: FrontmatterValue | undefined): string | null {
  if (typeof raw === 'number' || typeof raw === 'boolean') return normalizeText(String(raw));
  if (typeof raw !== 'string') return null;
  return normalizeText(raw);
}

const normalizeText = (raw: string): string | null => {
  const v = raw.replace(/\s+/gu, ' ').trim();
  return v === '' || [...v].length > MAX_SMART_TEXT_CHARS ? null : v;
};

function readSmartTags(raw: FrontmatterValue | undefined): readonly string[] {
  if (raw === undefined || raw === null) return [];
  /**
   * ⚠ **空の要素は `null` で来る**(frontmatter の parser がそう返す)── そのまま
   *   `String()` すると **`"null"` という名前のタグ**が条件になる(`readTags` が
   *   同じ罠を踏んで直してある)。
   */
  const parts: string[] = Array.isArray(raw)
    ? raw.filter((v) => v !== null && v !== undefined).map((v) => String(v))
    /**
     * 🔴 **割り方は `splitTags` 1 か所**(#637。§7)── 直す前はここだけ
     *   `split(',')` を書いていたので、`smart-tags: #請求 #未払` と手で書くと
     *   **「請求 未払」という 1 つの条件**になり、1 件も集まらなかった
     *   (打つ欄・`tags:` と**同じ字が別の意味**になっていた)。
     * ⚠ 上限だけはここが持つ(`MAX_SMART_TAGS` = 8 は `MAX_TAGS` = 32 より狭い)
     *   ── 下の輪が数え直すので、`splitTags` の上限は通過点にすぎない。
     */
    : splitTags(String(raw));
  const out: string[] = [];
  for (const part of parts) {
    const t = normalizeTag(part);
    if (t === '' || [...t].length > MAX_TAG_CHARS) continue;
    if (out.some((x) => sameTag(x, t))) continue;
    out.push(t);
    if (out.length >= MAX_SMART_TAGS) break;
  }
  return out;
}

/**
 * 種類を読む。⚠ **知らない綴りは条件にしない** ── 受けると
 * 「書いたのに 1 件も集まらない」だけの入れ物ができ、理由が画面に出ない。
 */
function readKind(raw: FrontmatterValue | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v !== '' && isKnownArchetype(v) ? v : null;
}

/**
 * 「N 日以内」を読む。受ける形は **`30d`** と **`30`** の両方
 * (記法を減らさない ── user がどちらで書いても通す)。
 * ⚠ 0 以下・上限超え・数でないものは**条件にしない**。
 */
function readDays(raw: FrontmatterValue | undefined): number | null {
  if (typeof raw === 'number') return normalizeDays(raw);
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d+)\s*d?\s*$/i.exec(raw);
  return m === null ? null : normalizeDays(Number(m[1]));
}

const normalizeDays = (n: number): number | null =>
  Number.isInteger(n) && n >= 1 && n <= MAX_SMART_DAYS ? n : null;

/**
 * 有無の条件を読む。受ける形は `true` / `false`(と `yes` / `no`)。
 * ⚠ 読めない綴りは `null`(= 見ない)── 黙って `true` に倒さない。
 */
function readFlag(raw: FrontmatterValue | undefined): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === 'yes') return true;
  if (v === 'false' || v === 'no') return false;
  return null;
}

/**
 * 条件を書き換えた結果。
 *
 * 🔴 **「変わらなかった」を 1 つに畳まない**(#421 着地前の変異試験)。
 * ⚠ 畳むと呼び側は**黙って捨てるしかなくなる** ── user は 9 個目の条件を
 *   足したつもりで、**何も起きない画面**を見る(理由がどこにも出ない)。
 * 🔑 だから「押しても同じ」(`unchanged`)と「**受けられなかった**」
 *   (`limit` / `invalid`)を分ける ── 前者は黙ってよいが、後者は画面に出す。
 */
export type SmartCondResult =
  | { readonly ok: true; readonly spec: SmartSpec }
  | { readonly ok: false; readonly reason: 'unchanged' | 'limit' | 'invalid' };

/** 条件のタグを 1 つ足す / 外す。⚠ 判定はここ 1 か所(§7)。 */
export function withSmartTag(
  spec: SmartSpec,
  tag: string,
  mode: 'add' | 'remove',
): SmartCondResult {
  const t = normalizeTag(tag);
  if (t === '' || [...t].length > MAX_TAG_CHARS) return { ok: false, reason: 'invalid' };
  const has = spec.tags.some((x) => sameTag(x, t));
  if (mode === 'add') {
    if (has) return { ok: false, reason: 'unchanged' };
    // ⚠ 上限に当たったら**足さない**(黙って古い方を落とさない ── `withTag` と同じ)
    if (spec.tags.length >= MAX_SMART_TAGS) return { ok: false, reason: 'limit' };
    return { ok: true, spec: { ...spec, tags: [...spec.tags, t] } };
  }
  if (!has) return { ok: false, reason: 'unchanged' };
  return { ok: true, spec: { ...spec, tags: spec.tags.filter((x) => !sameTag(x, t)) } };
}

/**
 * 🔴 **列で引く条件の名前**(#421 段②)。⚠ **綴りを直書きしない**
 * (画面・reducer・effect の 3 か所に散ると、1 つ直し忘れが静かに効く)。
 */
export type SmartField =
  | 'kind'
  | 'updated'
  | 'created'
  | 'dated'
  | 'text'
  | 'tasks'
  | 'openTasks';

export const SMART_FIELDS: readonly SmartField[] = [
  'kind',
  'updated',
  'created',
  'dated',
  'text',
  'tasks',
  'openTasks',
];

/**
 * 列で引く条件を 1 つ決める / 外す。
 *
 * @param value 画面から来た生の値。**空文字 = 指定しない**(条件を外す)
 * @returns 変わらないときは `unchanged`、受けられない値は `invalid`
 *
 * ⚠ **判定はここ 1 か所**(§7)── `readSmartSpec` と同じ規則を通すので、
 *   「画面から選べるのに本文からは読めない」食い違いが起きない。
 */
export function withSmartField(
  spec: SmartSpec,
  field: SmartField,
  value: string,
): SmartCondResult {
  const raw = value.trim();
  const cleared = raw === '';
  /**
   * 🔴 **語**(#421 段③)。⚠ 読む規則は `readSmartSpec` と**同じ関数**を通す ──
   *   「画面から入れられるのに本文からは読めない」食い違いを作らない。
   */
  if (field === 'text') {
    const next = cleared ? null : normalizeText(raw);
    if (!cleared && next === null) return { ok: false, reason: 'invalid' };
    return next === spec.text
      ? { ok: false, reason: 'unchanged' }
      : { ok: true, spec: { ...spec, text: next } };
  }
  if (field === 'kind') {
    const next = cleared ? null : readKind(raw);
    if (!cleared && next === null) return { ok: false, reason: 'invalid' };
    return next === spec.kind ? { ok: false, reason: 'unchanged' } : { ok: true, spec: { ...spec, kind: next } };
  }
  /**
   * ⚠ 有無の条件は 3 つ(日付 / チェック項目 / 未処理)── **読み方は 1 本**
   *   (`readFlag`)。field ごとに書き分けると、綴りが片方だけずれる(§7)。
   */
  if (field === 'dated' || field === 'tasks' || field === 'openTasks') {
    const next = cleared ? null : readFlag(raw);
    if (!cleared && next === null) return { ok: false, reason: 'invalid' };
    const now = field === 'dated' ? spec.dated : field === 'tasks' ? spec.tasks : spec.openTasks;
    if (next === now) return { ok: false, reason: 'unchanged' };
    return {
      ok: true,
      spec:
        field === 'dated'
          ? { ...spec, dated: next }
          : field === 'tasks'
            ? { ...spec, tasks: next }
            : { ...spec, openTasks: next },
    };
  }
  const next = cleared ? null : readDays(raw);
  if (!cleared && next === null) return { ok: false, reason: 'invalid' };
  const now = field === 'updated' ? spec.updatedDays : spec.createdDays;
  if (next === now) return { ok: false, reason: 'unchanged' };
  return {
    ok: true,
    spec:
      field === 'updated' ? { ...spec, updatedDays: next } : { ...spec, createdDays: next },
  };
}

/**
 * その条件の**いまの値**を、画面の `<select>` に入れる形で返す。
 * ⚠ 読む側と書く側で綴りが食い違わないよう、**ここ 1 か所**で決める。
 */
export function smartFieldValue(spec: SmartSpec, field: SmartField): string {
  if (field === 'text') return spec.text ?? '';
  if (field === 'kind') return spec.kind ?? '';
  if (field === 'dated' || field === 'tasks' || field === 'openTasks') {
    const v = field === 'dated' ? spec.dated : field === 'tasks' ? spec.tasks : spec.openTasks;
    return v === null ? '' : v ? 'true' : 'false';
  }
  const days = field === 'updated' ? spec.updatedDays : spec.createdDays;
  return days === null ? '' : `${String(days)}d`;
}

/**
 * 断り文。⚠ **押した場所の言葉で書く**(「条件」「タグ」)── 内部の語を出さない。
 * @returns 黙ってよいとき(`unchanged`)は `null`
 */
export function smartCondError(reason: 'unchanged' | 'limit' | 'invalid'): string | null {
  if (reason === 'unchanged') return null;
  if (reason === 'limit') return `条件は ${MAX_SMART_TAGS} つまでです(1 つ外してから足してください)`;
  return `そのタグは条件にできません(空か、${MAX_TAG_CHARS} 文字を超えています)`;
}

/**
 * 🔴 **落として入れられるか / ここから外せるか**(#421 段②の穴。2026-08-26 に実測)。
 *
 * ## 何が起きていたか
 *
 * 落とす動線(`SMART_TAGS`)は「**条件のタグを本文に付ける**」ことで実現している。
 * ⚠ ところが段② で**タグを 1 つも持たない入れ物**(「更新が 30 日以内」だけ、など)が
 * 作れるようになり、そこへ落とすと **付けるタグが 0 個 = 何も起きない**まま
 * 集め直しへ進んでいた ── **画面には何も出ない**。
 *
 * 🔑 実測(対照群つき): タグの条件を持つ入れ物へ落とすと本文に `tags: [請求]` が
 *   付いたのに対し、`smart-updated: 30d` だけの入れ物では**本文も断り文も 0 バイト**。
 *   ⚠ user から見ると「掴んで落としたのに、入らないし理由も無い」である。
 *
 * ## なぜ「付けられない」のか(user へ出す理由の中身)
 *
 * 種類 / 更新 / 作成 / 日付 / 語は、**落とした側の本文を書き換えても満たせない**
 * (更新時刻は保存が決める / 種類は作った時に決まる / 語は本文そのもの)。
 * 🔑 だから**断る** ── 起票時の ⚠「書き換えられない条件では、落とすのを断る。
 * 断り文になぜを出す」がここに当たる。
 *
 * @returns 通してよいときは `null`
 */
export function smartWriteError(spec: SmartSpec, mode: 'add' | 'remove'): string | null {
  if (isSmartEmpty(spec))
    return 'このスマートフォルダにはまだ条件がありません(先にタグを選んでください)';
  if (spec.tags.length > 0) return null;
  // ⚠ **押した動作の言葉で書く** ── 「落とした」と「外した」では、次にすることが違う
  return mode === 'add'
    ? 'このスマートフォルダはタグ以外の条件で集めています(ドラッグして入れることはできません)── 条件にタグを足すと入れられます'
    : 'このスマートフォルダはタグ以外の条件で集めています(ここから外すことはできません)── 集まるかどうかはノートの中身が決めます';
}

/**
 * 条件を本文へ書き戻す(**原文 splice** ── 説明文も他の key も無傷)。
 * ⚠ 空になったら **key ごと消す**(`smart-tags: []` を残すと、次に読んだとき
 *   「条件が在るのに当たらない」に見える)。
 */
export function writeSmartSpec(body: string, spec: SmartSpec): string {
  return spliceFrontmatterKeys(body, {
    [SMART_TAGS_KEY]: spec.tags.length === 0 ? undefined : [...spec.tags],
    [SMART_KIND_KEY]: spec.kind ?? undefined,
    // ⚠ 書き戻す形は **`30d`** に揃える(読むほうは `30` も受ける)
    [SMART_UPDATED_KEY]: spec.updatedDays === null ? undefined : `${String(spec.updatedDays)}d`,
    [SMART_CREATED_KEY]: spec.createdDays === null ? undefined : `${String(spec.createdDays)}d`,
    [SMART_DATED_KEY]: spec.dated === null ? undefined : spec.dated,
    [SMART_TEXT_KEY]: spec.text ?? undefined,
    [SMART_TASKS_KEY]: spec.tasks ?? undefined,
    [SMART_OPEN_TASKS_KEY]: spec.openTasks ?? undefined,
  });
}

/**
 * 🔴 **条件の「タグの分だけ」を当てる**(#421 段②で名前を直した)。
 *
 * ⚠ **名前を主張に合わせてある** ── 列の条件(種類 / 更新 / 作成 / 日付)は
 *   ここでは見ない。見るのは **SQL の側 1 か所**である(条件どうしは重ならないので、
 *   同じ問いに 2 か所が答えることにはならない)。
 * ⚠ 旧名 `matchesSmart` のままにすると、次に列の条件を足す人が
 *   「ここが全部答えている」と読む ── それが CLAUDE.md の
 *   「計器の名前が、計器の見ている範囲より広い」型である。
 *
 * 🔑 **AND**(条件のタグを全部持っている)。⚠ 突き合わせは大小無視(`sameTag`)。
 * ⚠ 条件が 1 つも無ければ `false`(空は「全部」ではなく「何も」)。
 */
export function matchesSmartTags(spec: SmartSpec, tags: readonly string[]): boolean {
  if (isSmartEmpty(spec)) return false; // ⚠ 空は「何も集めない」
  return spec.tags.every((want) => tags.some((have) => sameTag(have, want)));
}

/**
 * 🔴 **「N 日以内」を境目の時刻に直す**(#421 段②)。
 *
 * 🔑 **時計を worker に持ち込まない** ── 境目をここで作って渡せば、worker は
 *   `>= ?` を撃つだけになり、**test が時刻を決められる**(worker の中で
 *   `Date.now()` を読むと、走らせるたびに答えが変わる)。
 * ⚠ 比べる相手は entries の `created_at` / `updated_at`(ISO 文字列)なので、
 *   こちらも ISO で返す ── 文字列の大小比較がそのまま時刻の大小になる。
 */
export function smartCutoff(days: number | null, nowMs: number): string | null {
  if (days === null) return null;
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 🔴 **worker へ渡す形**(#421 段②)。条件を**そのまま**送らないのは、
 * 「N 日以内」が**時計に依る**からである(上の `smartCutoff`)。
 */
export interface SmartQuery {
  readonly tags: readonly string[];
  readonly kind: string | null;
  readonly updatedFrom: string | null;
  readonly createdFrom: string | null;
  readonly dated: boolean | null;
  /** 題名か本文にこの語(#421 段③)。⚠ 引き方は `planSearch` が 1 か所で持つ。 */
  readonly text: string | null;
  /** チェック項目がある / 無い(#421 段④)。⚠ 確定は本文を読む側が持つ。 */
  readonly tasks: boolean | null;
  /** 未処理のチェック項目がある / 無い(#421 段④)。 */
  readonly openTasks: boolean | null;
}

/**
 * 条件 → worker へ渡す形。⚠ **直し方はここ 1 か所**(§7)── 呼び手ごとに
 * 組み立てると、ある経路だけ境目の日数が違う、が静かに起きる。
 */
export function smartQueryOf(spec: SmartSpec, nowMs: number): SmartQuery {
  return {
    tags: [...spec.tags],
    kind: spec.kind,
    updatedFrom: smartCutoff(spec.updatedDays, nowMs),
    createdFrom: smartCutoff(spec.createdDays, nowMs),
    dated: spec.dated,
    text: spec.text,
    tasks: spec.tasks,
    openTasks: spec.openTasks,
  };
}

/** 走査の結果。⚠ `total` は**上限で切る前**の数。 */
export interface SmartHit {
  readonly lids: readonly string[];
  readonly total: number;
}

export interface SmartScan {
  /**
   * 🔴 **この走査は本文を丸ごと要るか**(#421 段④)。
   *
   * 🔑 **決めるのはここ、読むのは worker** ── worker が「チェック項目の条件が
   *   在るなら丸ごと」と自前で判断すると、**同じ問いに答える口が 2 つ**になり、
   *   条件を 1 つ足したときに片方だけ直し忘れる(§7)。
   * ⚠ 忘れると**静かに間違える** ── 先頭しか渡されないと、本文の後ろにある
   *   チェック項目が見えず、**当たるはずのノートが黙って落ちる**。
   *   `tests/adapter/storage-worker.test.ts` が「本文の**末尾**に項目を置いた
   *   ノートが当たること」で機械的に見ている。
   */
  readonly needsFullBody: boolean;
  /**
   * ノートの本文を食わせる(呼ぶのは storage worker)。
   * ⚠ `needsFullBody` が false のときは**先頭だけ**でよい / true のときは**丸ごと**。
   */
  feed(rows: readonly SmartScanRow[]): void;
  finish(): SmartHit;
}

/**
 * 走査へ食わせる 1 行(#550 段②)。
 *
 * ⚠ `body` は `needsFullBody` に従う ── false なら**先頭だけ**である。
 * 🔴 だから**本文中のタグはここには載っていない**(本文のどこにでも書けるので)。
 *   代わりに保存時に集約した索引(`entries.body_tags`)を `bodyTags` で渡す。
 * ⚠ `null` = **まだ集約していない行**(旧ビルドが書いた / 移行前)── そのときは
 *   文書タグだけで当てる(壊れではなく遅れ。次の起動の埋め戻しで揃う)。
 */
export interface SmartScanRow {
  readonly lid: string;
  readonly body: string;
  readonly bodyTags?: readonly string[] | null;
}

/**
 * 🔴 **チェック項目の条件を持つか**(#421 段④)。
 * ⚠ **`needsFullBody` の正本はここ 1 か所** ── 呼び側が独自に判定しない。
 */
export const hasTaskCond = (spec: SmartSpec): boolean =>
  spec.tasks !== null || spec.openTasks !== null;

/**
 * 🔴 **チェック項目の条件を、本文を読んで確定する**(#421 段④)。
 *
 * ⚠ **`task_total` の値をそのまま信じてはいけない** ── あれは
 *   `task-count.ts` が宣言しているとおり**多めに数えた候補数**で、
 *   一覧にそのまま並べると**項目が 1 つも無いノートが混ざる**。
 * 🔑 だから候補の本文を読んで `countTaskCandidates` で取り直す ──
 *   **数え方は 1 か所のまま**(カンバンと同じ関数)。
 *
 * @param body ノートの本文(⚠ **丸ごと**。先頭だけだと後ろの項目が見えない)
 */
export function matchesSmartTasks(spec: SmartSpec, body: string): boolean {
  /**
   * ⚠ **この行は「正しさ」を守っていない ── 費用の門である**(2026-08-26、変異試験
   *   N3 が SURVIVED で教えた)。条件が無ければ下の 2 つの `if` はどちらも
   *   素通りするので、**外しても答えは 1 バイトも変わらない**。
   * 🔑 それでも残すのは、**外すと本文を毎行数えることになる**からである ──
   *   タグだけの入れ物でも 1 塊 500 行ぶんの本文を `countTaskCandidates` に
   *   通してしまう(答えは同じ、仕事だけ増える)。
   * ⚠ **だから変異試験では生き延びるのが正しい。** 守っている test は無い
   *   (CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」──
   *   外しても壊れなかったので、そう書いてある)。
   */
  if (!hasTaskCond(spec)) return true;
  const { total, done } = countTaskCandidates(body);
  if (spec.tasks !== null && total > 0 !== spec.tasks) return false;
  if (spec.openTasks !== null && total - done > 0 !== spec.openTasks) return false;
  return true;
}

/**
 * 🔴 **当てるのはここ 1 か所**(#421)。worker も test も同じ関数を通る。
 *
 * ⚠ **走査は集計と同じ型**(`createQueryScan`)── 本文の先頭だけを 500 件ずつ
 *   舐め、主スレッドへ返すのは **lid だけ**である(不可侵指示「ゼロコピー」)。
 * ⚠ **自分自身は当てない** ── スマートフォルダに条件タグを書いた本文が
 *   自分の中に並ぶと、開くたびに入れ子が 1 段深く見える。
 *
 * @param selfLid そのスマートフォルダ自身の lid(除くため)
 */
export function createSmartScan(spec: SmartSpec, selfLid: string): SmartScan {
  const lids: string[] = [];
  let total = 0;
  return {
    /**
     * 🔑 **本文を丸ごと要るのは、チェック項目の条件を持つときだけ**(段④)。
     * ⚠ 常に丸ごと読ませない ── タグだけの入れ物でも全件の本文が heap に載る。
     */
    needsFullBody: hasTaskCond(spec),
    feed(rows) {
      /**
       * ⚠ **空のときの早期 return をここに置かない**(§7)。
       *   「条件が空 → 何も集めない」は `matchesSmartTags` が答えているので、
       *   ここに書いても**出る答えは 1 バイトも変わらない**
       *   (変異試験 S5 が SURVIVED で教えた ── 消しても誰も困らない行だった)。
       * 🔑 **走査そのものを止めるのは、ここではなく呼び側である** ──
       *   `REQUEST_SMART_SCAN` が条件 0 件のとき worker を呼ばない
       *   (作った直後のスマートフォルダを開くだけで全件走査が走るのを止める)。
       *   ⚠ その門は `tests/adapter/smart-folder.test.ts` が
       *   「**頼まなかったこと**」で見ている ── ここに書き戻すと、
       *   同じ判定が 2 か所になり、片方を壊しても鳴らなくなる。
       */
      for (const row of rows) {
        if (row.lid === selfLid) continue;
        /**
         * ⚠ **タグの読み方は 1 本**(§7)── ここに独自の読み方を書くと、
         *   一覧に出る札と「当たるかどうか」が静かに食い違う。
         * 🔴 **2026-08-29(#550 段②)から、文書タグ + 本文中タグの両方**である。
         *   合わせるのは `tagsForMatch` ── `readTags` を直に呼ぶと**本文中タグが
         *   当たらない**(そして落ちるノートは黙って消えるので、誰も気づかない)。
         */
        if (!matchesSmartTags(spec, tagsForMatch(row.body, row.bodyTags ?? null)))
          continue;
        /**
         * 🔴 **チェック項目は本文を読んで確定する**(段④)── `task_total` は
         *   多めなので、SQL が縮めた候補をここで正確な数に取り直す。
         * ⚠ 順番が要る:**先にタグで落としてから**読む(タグで落ちるノートの
         *   本文を数えるのは、そのぶん丸損である)。
         */
        if (!matchesSmartTasks(spec, row.body)) continue;
        total += 1;
        // ⚠ 上限を超えたぶんは lid を持たないが、**数は数え続ける**
        if (lids.length < SMART_LIMIT) lids.push(row.lid);
      }
    },
    finish() {
      return { lids, total };
    },
  };
}
