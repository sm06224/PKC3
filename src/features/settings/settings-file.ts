/**
 * 🔴 **設定だけを別の端末へ持っていく**(#414。PKC2 の「Settings File」相当)。
 *
 * ## user の物語
 *
 * 会社の PC で鍵の割当・書式・紙面・編集の仕方を整えた。**家の PC でも同じ使い勝手に
 * したい。** ⚠ いまはバックアップ(`.pkc3.zip`)を取り込むしかなく、それだと
 * **データごと**移るので**家のノートが混ざる**。移したいのは見た目と使い勝手だけである。
 *
 * ## 🔴 **移す物は名指しである**(「端末側に在る物を全部」にしない)
 *
 * ⚠ 全部にすると、**お知らせの既読**や**アプリの許可**まで別の端末へ移る。
 * 許可は**その端末でその中身を見て許した**ものなので、移すと**意味が変わる**
 * (#195 の「許可は container に入れない」と同じ理屈)。
 *
 * ## 🔴 だから「移さない物」も名指しで持つ ── 理由つきで
 *
 * 🔑 **移す一覧だけを持つと、鍵が増えた日に「入れ忘れ」と「わざと入れない」が
 *   区別できない。** ⚠ そして入れ忘れは「**書き出したのに戻らない**」という
 *   **無言の欠落**として出る(誰も気づけない)。
 * 🔑 `tests/features/settings-file.test.ts` が **`src` の `pkc3.*` を全数で拾い、
 *   どちらの一覧にも無い鍵が在れば落とす** ── 次に鍵を足す人は、
 *   **どちらかに書くまで CI が通らない**。
 *
 * ⚠ **pure module**。`localStorage` も DOM も知らない(読み書きは adapter の仕事)。
 */

/** 1 件の設定。⚠ 値は保存されている**生の文字列**のまま運ぶ(解釈しない)。 */
export interface SettingsEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * 🔴 **移す鍵**(#414)。⚠ **見た目と使い勝手で、端末に依らない物だけ**。
 * ⚠ ここへ足すときは「別の端末で**同じ意味になるか**」を問う。
 */
export const PORTABLE_KEYS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'pkc3.theme', label: '見た目' },
  { key: 'pkc3.panes', label: '列の畳み方' },
  /**
   * ⚠ **畳み方と対**(#497)── 片方だけ運ぶと「畳んだのは移ったのに幅は既定」に
   * なる。⚠ px なので端末で意味が変わりそうに見えるが、値は
   * `clamp(0px, Npx, 45vw)` として当たるので**狭い端末では自分で縮む**
   * (`pkc3.text-scale` と同じ考え方 ── 使い方の好みは人に付く)。
   */
  { key: 'pkc3.pane-sizes', label: '列の幅' },
  { key: 'pkc3.editor-mode', label: '編集の仕方' },
  { key: 'pkc3.open-in-edit', label: '「開く」で編集に入るか' },
  { key: 'pkc3.page-format', label: '紙面' },
  // ⚠ 別の端末でも**同じ意味**になる(見づらいと感じる大きさは人に付く)── 移す
  { key: 'pkc3.text-scale', label: '文字の大きさ' },
  { key: 'pkc3.read-columns', label: '本文の段組み' },
  // ⚠ 段組みと**対**(#525)── 片方だけ運ぶと「段組みは移ったのに線は既定」になる。
  //    見分けにくいと感じる濃さは**人に付く**(文字の大きさと同じ考え方)
  { key: 'pkc3.column-rule', label: '段の境界線' },
  { key: 'pkc3.tag-badge', label: '本文のタグの見せ方' },
  { key: 'pkc3.keymap', label: 'ショートカットキーの割り当て' },
  { key: 'pkc3.browse', label: '探し方のタブ' },
  { key: 'pkc3.dual-preview', label: '2 ペインのプレビュー' },
  { key: 'pkc3.paste-source', label: '貼り付けの判定' },
  { key: 'pkc3.query-key', label: '集計の束ね方' },
  { key: 'pkc3.alarm', label: '予定の時刻に知らせるか' },
];

/**
 * 🔴 **わざと移さない鍵と、その理由**(#414)。
 *
 * ⚠ **理由を書かない行を足さない** ── 理由が無いと、次に読む人が
 *   「入れ忘れでは?」と考え直すところから始める(CLAUDE.md「戒めには
 *   何のための禁止かを書く」)。
 */
export const SKIPPED_KEYS: readonly { readonly key: string; readonly why: string }[] = [
  {
    key: 'pkc3.split-lids',
    why: '中身が lid そのもの(#505 段②)── 別の端末・別の container へ運ぶと、そこに居ないノートを指す枠が復活する。並べ方は運べても「どのノートか」は運べない',
  },
  {
    key: 'pkc3.flags',
    why: 'flag は設定ではない(15 枠 + 畳む条件の宣言 + フラグ画面という別の機構)。運ぶと畳む条件を跨いで別の端末へ持ち込むことになる',
  },
  {
    key: 'pkc3.external-images',
    why: '許可である ── その端末でその中身を見て許したもの',
  },
  {
    key: 'pkc3.extension-grants',
    why: '許可である ── その端末でその相手を見て許したもの',
  },
  {
    key: 'pkc3.same-origin-grants',
    why: '許可である ── その端末でその相手を見て許したもの',
  },
  {
    key: 'pkc3.embed-origins',
    why: '許可である ── その端末でその相手を見て許したもの',
  },
  {
    key: 'pkc3.notices.seen',
    why: '既読はその端末で読んだ事実。運ぶと、別の端末でまだ読んでいないお知らせが消える',
  },
  {
    key: 'pkc3.notices.off',
    why: 'お知らせを止めたかどうかは、その端末での選択である',
  },
  {
    key: 'pkc3.dual-bookmarks',
    why: '🔴 lid を持つ ── 別の端末では別のノートを指す(あるいはどこも指さない)',
  },
  {
    key: 'pkc3.app.storage',
    why: '保存の鍵ではない ── 組み込みアプリとのやりとりに使う合図の名前',
  },
  {
    key: 'pkc3.ext.port',
    why: '保存の鍵ではない ── 拡張とのやりとりに使う合図の名前',
  },
  {
    key: 'pkc3.opened-by-us',
    why: '🔴 その窓 1 枚だけの事実(付箋として開いたか)── `sessionStorage` に在り、運ぶ物ではない',
  },
];

/** 書き出す形の目印。⚠ 版が変わっても**読めるところまでは読む**(下の注記)。 */
export const SETTINGS_FILE_KIND = 'pkc3-settings';
export const SETTINGS_FILE_VERSION = 1;

/** 1 件の値の上限。⚠ **手違いの検出**(壊れた保存を運ばない)。 */
export const MAX_SETTING_CHARS = 64_000;

export interface SettingsFile {
  readonly kind: string;
  readonly version: number;
  readonly entries: readonly SettingsEntry[];
}

/** 書き出す。⚠ **無い鍵は入れない**(空文字と「設定していない」を混ぜない)。 */
export function buildSettingsFile(read: (key: string) => string | null): SettingsFile {
  const entries: SettingsEntry[] = [];
  for (const { key } of PORTABLE_KEYS) {
    const value = read(key);
    if (value === null || value === '') continue;
    if (value.length > MAX_SETTING_CHARS) continue;
    entries.push({ key, value });
  }
  return { kind: SETTINGS_FILE_KIND, version: SETTINGS_FILE_VERSION, entries };
}

/**
 * 落とす file の名前。⚠ **日付を入れる**(2 つ持っていてもどちらが新しいか分かる)。
 *
 * ⚠ **器の題名は入れない** ── `AppState` は器の題名を持っていない(`cid` だけ)。
 *   🔑 埋められない引数を口に残すと、呼び側が毎回 `''` を渡す**嘘の引数**になる
 *   (CLAUDE.md「計器の名前が、見ている範囲と違う」の API 版)。
 */
export function settingsFileName(today: string): string {
  return `PKC3-settings-${today}.json`;
}

/**
 * 読み込んだ物の中身。
 *
 * 🔴 **「変わるもの」と「知らない鍵」を分ける** ── 前者は当てる前に見せ、
 *   後者は**件数を言う**(黙って捨てない ── 版が違う設定ファイルを読んだとき、
 *   user は「全部入った」と思ってしまう)。
 */
export interface SettingsPlan {
  /** 当てると変わるもの(いまの値と違う)。 */
  readonly changes: readonly {
    readonly key: string;
    readonly label: string;
    readonly from: string | null;
    readonly to: string;
  }[];
  /** 読めたが、いまと同じだったもの。 */
  readonly same: number;
  /** 🔴 **移さないと決めている鍵**が入っていた(古い版 / 手で足した)。 */
  readonly refused: readonly string[];
  /** 🔴 **こちらが知らない鍵**(新しい版で書かれた)。 */
  readonly unknown: readonly string[];
  /** 読めなかった理由。`null` なら読めた。 */
  readonly error: string | null;
}

const EMPTY_PLAN: SettingsPlan = {
  changes: [],
  same: 0,
  refused: [],
  unknown: [],
  error: null,
};

/**
 * 読んだ JSON を「何が変わるか」に直す。
 *
 * ⚠ **当てない。見せるだけ** ── 当てるのは呼び側(user が押してから)。
 * ⚠ **知らない鍵で止めない** ── 読めるところまで読んで、残りは件数で言う
 *   (新しい版の設定を古い版で読んだとき、**全部拒むほうが害が大きい**)。
 */
export function planSettingsImport(
  text: string,
  read: (key: string) => string | null,
): SettingsPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...EMPTY_PLAN, error: '設定ファイルとして読めませんでした' };
  }
  if (typeof raw !== 'object' || raw === null)
    return { ...EMPTY_PLAN, error: '設定ファイルとして読めませんでした' };
  const o = raw as Record<string, unknown>;
  if (o['kind'] !== SETTINGS_FILE_KIND)
    return {
      ...EMPTY_PLAN,
      error: 'これは PKC3 の設定ファイルではありません(バックアップの取り込みは左下です)',
    };
  const list = Array.isArray(o['entries']) ? o['entries'] : [];
  const labelOf = new Map(PORTABLE_KEYS.map((p) => [p.key, p.label]));
  const skipped = new Set(SKIPPED_KEYS.map((s) => s.key));
  const changes: { key: string; label: string; from: string | null; to: string }[] = [];
  const refused: string[] = [];
  const unknown: string[] = [];
  let same = 0;
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const key = typeof e['key'] === 'string' ? e['key'] : '';
    const value = typeof e['value'] === 'string' ? e['value'] : '';
    // ⚠ 同じ鍵が 2 度書いてあっても 1 度しか数えない(後勝ちにしない ── 先を採る)
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (value.length > MAX_SETTING_CHARS) continue;
    if (skipped.has(key)) {
      refused.push(key);
      continue;
    }
    const label = labelOf.get(key);
    if (label === undefined) {
      unknown.push(key);
      continue;
    }
    const from = read(key);
    if (from === value) {
      same += 1;
      continue;
    }
    changes.push({ key, label, from, to: value });
  }
  return { changes, same, refused, unknown, error: null };
}

/**
 * 下見の 1 行。⚠ **中身(値)は出さない** ── 鍵の割当は長く、紙面は JSON である。
 *   出しても読めないので、**何が変わるか**だけを言う。
 */
export function settingsChangeText(c: {
  readonly label: string;
  readonly from: string | null;
}): string {
  return c.from === null ? `${c.label} を設定します` : `${c.label} を入れ替えます`;
}

/** 下見のまとめ。⚠ **0 件でもそう言う**(押しても何も起きない理由を出す)。 */
export function settingsPlanNote(plan: SettingsPlan): string {
  if (plan.error !== null) return plan.error;
  const parts: string[] = [];
  parts.push(
    plan.changes.length === 0 ? '変わるものはありません' : `${plan.changes.length} 件が変わります`,
  );
  if (plan.same > 0) parts.push(`${plan.same} 件はいまと同じです`);
  // 🔴 **黙って捨てない**(版が違う設定ファイルを読んだとき、全部入ったと思われる)
  if (plan.refused.length > 0)
    parts.push(`${plan.refused.length} 件は運ばない決まりのもの(許可・フラグ・お知らせの既読)なので入れません`);
  if (plan.unknown.length > 0)
    parts.push(`${plan.unknown.length} 件はこの版が知らない設定なので入れません`);
  return `${parts.join('。')}。`;
}

/** 当ててよいか。⚠ 変わるものが 1 件も無ければ押せない(空押しを作らない)。 */
export const canApplySettings = (plan: SettingsPlan): boolean =>
  plan.error === null && plan.changes.length > 0;
