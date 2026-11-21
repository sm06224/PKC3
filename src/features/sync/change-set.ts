/**
 * 🔴 **端末間の同期(#2000)段 1 ── 変更の集合の核**(照合・抽出・競合の分類)。
 *
 * ## 決めごと(user 裁定。再検討しない)
 *
 * - 競合は **両方残す**(案 A)。どちらも失わない。
 * - 別の端末で消えたノートは、こちらでは**ゴミ箱へ移す**(戻せる)。
 * - 変更されたかは **時計ではなく内容のハッシュ**で決める。`updated_at` は**判定に一切使わない**
 *   (端末の時計ずれ・巻き戻し・タイムゾーンで取りこぼしや上書きが起きるため。表示専用)。
 *
 * ## 三者比較
 *
 * 各キーについて、前回の合意(`base`)・こちら(`local`)・相手(`remote`)の 3 つの指紋を比べる。
 * `undefined` = その時点で無い。相手が消した場合は墓標(`Tombstone`)として届く。
 *
 * ## 指紋は 2 つの欄に分ける(`content` = 題名・種別・本文 / `place` = 親)
 *
 * 三者比較は**欄ごと**に行う。片方の端末で「移動」(`place`)、もう片方で「編集」(`content`)をしても自動で合わさり、
 * **同じ欄が両方で違う値になったときだけ**競合にする。つながりは作る・消すだけなので `place` を持たず、`content` は定数。
 *
 * ## 時計は入力に無い
 *
 * この module の入力(`KeyedState` / `Tombstone` / `MergeInput`)に、判定に使う**時刻の欄は無い**(型で固定。`tests` が確かめる)。
 * `Tombstone.deletedAt` は表示・古い墓標の整理(`sync-state.ts`)専用で、判定の関数は読まない。
 *
 * ## 画面に出すときの言葉
 *
 * 墓標 → 「削除の記録」/ 前回の合意 → 「同期の記録」。「墓標」「基準」「合意」は画面に出さない(`ui-terms.ts` の方針)。
 *
 * ⚠ pure module。ハッシュは呼び手が `entryFingerprintTexts` の文字列を SHA-256 して渡す。
 */

/** ノートの指紋の材料。⚠ 並び順(entry_order)・更新日時・realm は含めない(端末ごとの物 / 判定に使わない)。 */
export interface EntryFacet {
  readonly title: string;
  readonly archetype: string;
  /** 親フォルダ(structural のつながりの宛先 lid)。ルートは `null`。 */
  readonly parentLid: string | null;
  readonly body: string;
}

/**
 * 指紋にするための正規の文字列(呼び手が SHA-256 して `Fp` の各欄にする)。
 * 項目の区切りを曖昧にしないため JSON 配列で作る(先頭の語は将来の形の変更を見分ける)。
 */
export function entryFingerprintTexts(facet: EntryFacet): { readonly content: string; readonly place: string } {
  return {
    content: JSON.stringify(['pkc3-fp2c', facet.title, facet.archetype, facet.body]),
    place: JSON.stringify(['pkc3-fp2p', facet.parentLid]),
  };
}

/**
 * つながりの照合キー。⚠ id ではなく `from|to|kind`(2 つの端末が同じ A→B を別々に作っても 1 本に揃う)。
 * ノートの lid と混ざらないよう `rel:` を前に付ける。
 */
export function relationKey(r: { from: string; to: string; kind: string }): string {
  return `rel:${r.from}|${r.to}|${r.kind}`;
}

/** つながりの指紋の文字列は定数(中身はキーに全部入っている。作る・消すだけで、変更は無い)。 */
export function relationFingerprintText(): string {
  return 'pkc3-rp2';
}

/** 指紋(ハッシュ済み)。`place` はつながりには無い。 */
export interface Fp {
  readonly content: string;
  readonly place?: string;
}

/** 墓標 = 「これは消えた」。ゴミ箱を空にしても残す別の記録(`sync-state.ts`)。画面では「削除の記録」。 */
export interface Tombstone {
  readonly key: string;
  /** 消した時点の指紋(消した側が見ていた内容)。 */
  readonly lastFp: Fp;
  /** 消した端末の id と、その端末の連番(時計ではない)。 */
  readonly device: string;
  readonly seq: number;
  /**
   * 消した日時(ISO)。⚠ **表示と古い墓標の整理だけに使う。判定には使わない**(時計ずれで結果が変わらないように)。
   * 無い / 読めない = 日時不明(整理では「古さ不明」として扱う。`pruneTombstones`)。
   */
  readonly deletedAt?: string;
}

/** 一方の側の 1 件。 */
export interface KeyedState extends Fp {
  readonly key: string;
}

/** 「前回の合意」(画面では「同期の記録」): 相手ごとに持つ、キー → 指紋。 */
export type Baseline = Readonly<Record<string, Fp>>;

/** 1 つの側の変更の集合(前回の合意からの差)。 */
export interface ChangeSet {
  readonly added: readonly KeyedState[];
  readonly changed: readonly KeyedState[];
  /** 消えた物。`lastFp` = 前回の合意の指紋、合意に無ければ墓標の指紋。 */
  readonly deleted: readonly { readonly key: string; readonly lastFp: Fp }[];
}

const byKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function mkFp(content: string, place: string | undefined): Fp {
  return place === undefined ? { content } : { content, place };
}

/** 指紋が同じか(両方の欄)。 */
export function fpEqual(a: Fp, b: Fp): boolean {
  return a.content === b.content && a.place === b.place;
}

const toFp = (s: Fp): Fp => mkFp(s.content, s.place);

/**
 * 現在の状態を前回の合意と比べて、追加・変更・削除に分ける。
 *
 * - 合意に無い・現在ある → 追加 / 合意と指紋が違う(どちらかの欄)→ 変更 / 合意にある・現在無い → 削除(**墓標が無くても拾う**)
 * - この相手と一度も同期していない(合意に無い)のに墓標がある物 → 削除(第三の端末への伝播)
 * - 現在ある物の墓標は無視する(消したあと同じキーが戻った)。
 *
 * 順はキーの昇順で決定的にする(入力の順に依らない)。
 */
export function extractChanges(current: readonly KeyedState[], baseline: Baseline, tombstones: readonly Tombstone[]): ChangeSet {
  const cur = new Map(current.map((c) => [c.key, c] as const));
  const added: KeyedState[] = [];
  const changed: KeyedState[] = [];
  const deleted: { key: string; lastFp: Fp }[] = [];
  for (const [key, c] of cur) {
    const b = baseline[key];
    if (b === undefined) added.push({ key, ...toFp(c) });
    else if (!fpEqual(b, c)) changed.push({ key, ...toFp(c) });
  }
  for (const key of Object.keys(baseline)) {
    if (!cur.has(key)) deleted.push({ key, lastFp: baseline[key] as Fp });
  }
  // 同じキーの墓標が複数あっても 1 件だけ(入力の重複で同じ削除を 2 回送らない。先に出た物を採る)
  const seenTomb = new Set<string>();
  for (const t of tombstones) {
    if (seenTomb.has(t.key)) continue;
    seenTomb.add(t.key);
    if (!cur.has(t.key) && baseline[t.key] === undefined) deleted.push({ key: t.key, lastFp: t.lastFp });
  }
  return { added: added.sort(byKey), changed: changed.sort(byKey), deleted: deleted.sort(byKey) };
}

/** 相手の側の 1 件。`deleted` は墓標が届いた場合(`lastFp` つき)。 */
export type RemoteState =
  | { readonly kind: 'present'; readonly fp: Fp }
  | { readonly kind: 'deleted'; readonly lastFp: Fp }
  | { readonly kind: 'absent' };

/** 競合の種類。⚠ どれも**何も失わない**(`resolution` を参照)。 */
export type ConflictKind =
  /** 両方が前回から**同じ欄**を変えて、値が違う(欄は `fields`)。 */
  | 'both-edited'
  /**
   * この相手との同期の記録が無い物が、両方にあって内容が違う。
   * 同じバックアップから復元した端末どうしの初回でも起きる(`seedBaseline` で記録を作れば起きない)。
   * 段 2 の画面は「初回の同期」として出せる(通常の競合と区別する)。
   */
  | 'first-sync'
  /** こちらは消した・相手は変えた。 */
  | 'deleted-here-edited-there'
  /** こちらは変えた・相手は消した。 */
  | 'edited-here-deleted-there';

/**
 * 競合の解き方(案 A: 両方残す)。
 * - `keep-both-copy`: こちらを残し、相手の版を**別のノート(新しい lid)**として加える。競合の一覧に出す。
 * - `restore-remote`: 相手の版をこちらへ戻す(こちらで消した物を、相手の編集があるので復活させる)。
 * - `keep-local`: こちらの版を残し、相手へ送り返す(相手の削除では消さない)。
 */
export type ConflictResolution = 'keep-both-copy' | 'restore-remote' | 'keep-local';

/** 欄の名前。 */
export type FpField = 'content' | 'place';

export type Decision =
  /** 同じ。何もしない(双方が同じ内容 / 双方が消した)。 */
  | { readonly action: 'noop'; readonly key: string }
  /** 相手だけが変えた(追加を含む)→ こちらへ取り込む。 */
  | { readonly action: 'take-remote'; readonly key: string; readonly fp: Fp }
  /** 相手が消し、こちらは前回から変わっていない → こちらのゴミ箱へ移す。 */
  | { readonly action: 'trash-local'; readonly key: string }
  /** こちらだけが変えた(追加を含む)→ 相手へ送る。 */
  | { readonly action: 'push-local'; readonly key: string; readonly fp: Fp }
  /** こちらが消し、相手は変わっていない → 相手のゴミ箱へ移させる。 */
  | { readonly action: 'push-delete'; readonly key: string; readonly lastFp: Fp }
  /**
   * 欄ごとに合わせた結果が、こちらとも相手とも違う(片方が移動・もう片方が編集)。
   * `fp` = 合わせた指紋。こちらへ反映し、相手へも送る。
   */
  | { readonly action: 'merge'; readonly key: string; readonly fp: Fp }
  | {
      readonly action: 'conflict';
      readonly key: string;
      readonly kind: ConflictKind;
      readonly resolution: ConflictResolution;
      /** 食い違った欄(`both-edited` / `first-sync` のとき)。 */
      readonly fields?: readonly FpField[];
      readonly local?: Fp;
      readonly remote?: Fp;
    };

const FIELDS: readonly FpField[] = ['content', 'place'];

/**
 * 1 つのキーの三者比較(欄ごと)。時計は見ない。
 *
 * 前回の合意(`base`)が無く相手が墓標のとき、墓標の `lastFp` を代わりに使う
 * (一度も同期していない端末から消えた事実が届く場合)。
 */
export function decideOne(key: string, base: Fp | undefined, local: Fp | undefined, remote: RemoteState): Decision {
  const r = remote.kind === 'present' ? remote.fp : undefined;
  const effBase = base !== undefined ? base : remote.kind === 'deleted' ? remote.lastFp : undefined;
  if (local === undefined && r === undefined) return { action: 'noop', key };
  if (local !== undefined && r !== undefined) {
    if (fpEqual(local, r)) return { action: 'noop', key };
    if (effBase === undefined) {
      const fields = FIELDS.filter((f) => local[f] !== r[f]);
      return { action: 'conflict', key, kind: 'first-sync', resolution: 'keep-both-copy', fields, local, remote: r };
    }
    const conflicted: FpField[] = [];
    const picked: Record<FpField, string | undefined> = { content: undefined, place: undefined };
    for (const f of FIELDS) {
      const lc = local[f] !== effBase[f];
      const rc = r[f] !== effBase[f];
      if (lc && rc && local[f] !== r[f]) conflicted.push(f);
      picked[f] = lc ? local[f] : r[f];
    }
    if (conflicted.length > 0) {
      return { action: 'conflict', key, kind: 'both-edited', resolution: 'keep-both-copy', fields: conflicted, local, remote: r };
    }
    const merged = mkFp(picked.content as string, picked.place);
    if (fpEqual(merged, local)) return { action: 'push-local', key, fp: local };
    if (fpEqual(merged, r)) return { action: 'take-remote', key, fp: r };
    return { action: 'merge', key, fp: merged };
  }
  if (local !== undefined) {
    // 相手には無い(消えた / 一度も無かった)
    if (effBase === undefined) return { action: 'push-local', key, fp: local };
    if (fpEqual(local, effBase)) return { action: 'trash-local', key };
    return { action: 'conflict', key, kind: 'edited-here-deleted-there', resolution: 'keep-local', local };
  }
  // こちらに無く、相手にある
  const rr = r as Fp;
  if (effBase === undefined) return { action: 'take-remote', key, fp: rr };
  if (fpEqual(rr, effBase)) return { action: 'push-delete', key, lastFp: effBase };
  return { action: 'conflict', key, kind: 'deleted-here-edited-there', resolution: 'restore-remote', remote: rr };
}

export interface MergeInput {
  readonly baseline: Baseline;
  readonly local: readonly KeyedState[];
  readonly remote: readonly KeyedState[];
  /** 相手から届いた墓標。 */
  readonly remoteTombstones: readonly Tombstone[];
  /**
   * こちらの墓標(こちらで消した記録。ゴミ箱を空にしても残っている)。
   * 前回の合意が無く、こちらに無い物は、墓標の指紋を前回の合意の代わりにする
   * (空にしたノートが、まだ同期していない相手から「新しいノート」として戻らないように)。
   */
  readonly localTombstones: readonly Tombstone[];
  /**
   * 相手の全体が見えているか。
   * - `true`(相手の全件を受け取った): 合意にあって相手に無い物は「相手が消した」と見なす
   * - `false`(差分だけ): 相手に無いのは「変えていない」(墓標のある物だけが削除)
   */
  readonly remoteIsComplete: boolean;
}

/** 全キーについて決める。結果はキーの昇順(決定的)。 */
export function decideMerge(input: MergeInput): readonly Decision[] {
  const local = new Map(input.local.map((s) => [s.key, s] as const));
  const remote = new Map(input.remote.map((s) => [s.key, s] as const));
  const tombs = new Map(input.remoteTombstones.map((t) => [t.key, t] as const));
  const localTombs = new Map(input.localTombstones.map((t) => [t.key, t] as const));
  const keys = new Set<string>([...local.keys(), ...remote.keys(), ...tombs.keys(), ...localTombs.keys(), ...Object.keys(input.baseline)]);
  const out: Decision[] = [];
  for (const key of [...keys].sort()) {
    const base = input.baseline[key];
    const ls = local.get(key);
    const rs0 = remote.get(key);
    const tomb = tombs.get(key);
    let rs: RemoteState;
    // ⚠ 相手に在る(present)が墓標より先。同じキーが両方にあれば「消した後に戻った」= 在る方が事実
    if (rs0 !== undefined) rs = { kind: 'present', fp: toFp(rs0) };
    else if (tomb) rs = { kind: 'deleted', lastFp: tomb.lastFp };
    else if (base !== undefined) rs = input.remoteIsComplete ? { kind: 'deleted', lastFp: base } : { kind: 'present', fp: base };
    else rs = { kind: 'absent' };
    // こちらに無く、合意も無い → こちらの墓標の指紋を前回の合意の代わりにする
    const effBase = base !== undefined ? base : ls === undefined ? localTombs.get(key)?.lastFp : undefined;
    out.push(decideOne(key, effBase, ls === undefined ? undefined : toFp(ls), rs));
  }
  return out;
}

/**
 * 同期が済んだ後の「前回の合意」を作る。反映後にこちらが持つ指紋の全件をそのまま次の合意にする
 * (消えたキーは載らないので合意から外れる。競合のコピーの新 lid は呼び手が足して渡す)。
 */
export function nextBaseline(finalState: readonly KeyedState[]): Baseline {
  // ⚠ 差分のキーで引く表なので、`__proto__` などの名前が混ざっても prototype を書き換えない
  const out = Object.create(null) as Record<string, Fp>;
  for (const s of finalState) out[s.key] = toFp(s);
  return out;
}

/**
 * 🔴 **種の「前回の合意」**: ある時点の指紋の一覧(バックアップ / 差分ファイルを書き出した瞬間の物)から作る。
 *
 * 同じバックアップから復元した 2 台は、互いの記録が無いまま最初の同期をすると、**編集したノートが全部競合**になる。
 * 段 2 は「バックアップ・差分を書き出す / 取り込む」とき、その時点の指紋の一覧から種を作って記録に書く(設計 doc §12.1)。
 * 種があれば、その後の編集は三者比較で自動的に合わさる。
 * ⚠ 種の指紋は**書き出した時点**の物でなければならない(復元後の編集を含めると、編集を「前回から変わっていない」と誤る)。
 * 空の指紋は捨てる。同じキーが重なれば後の物を採る。
 */
export function seedBaseline(snapshot: readonly KeyedState[]): Baseline {
  // ⚠ 差分のキーで引く表なので、`__proto__` などの名前が混ざっても prototype を書き換えない
  const out = Object.create(null) as Record<string, Fp>;
  for (const s of snapshot) if (s.content !== '') out[s.key] = toFp(s);
  return out;
}
