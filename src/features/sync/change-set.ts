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
 * 各 lid について、前回の合意(`base`)・こちら(`local`)・相手(`remote`)の 3 つの指紋を比べる。
 * `undefined` = その時点で無い。相手が消した場合は墓標(`Tombstone`)として届く。
 *
 * ⚠ pure module。ハッシュは呼び手が `entryFingerprintText` の文字列を SHA-256 して渡す。
 */

/** ノートの指紋の材料。⚠ 並び順(entry_order)・更新日時・realm は含めない(端末ごとの物 / 判定に使わない)。 */
export interface EntryFacet {
  readonly title: string;
  readonly archetype: string;
  /** 居場所(structural のつながりの宛先 lid)。ルートは `null`。 */
  readonly parentLid: string | null;
  readonly body: string;
}

/** 指紋にするための正規の文字列。項目の区切りを曖昧にしないため JSON 配列で作る(先頭の語は将来の形の変更を見分ける)。 */
export function entryFingerprintText(facet: EntryFacet): string {
  return JSON.stringify(['pkc3-fp1', facet.title, facet.archetype, facet.parentLid, facet.body]);
}

/** つながり 1 本の指紋の材料。id は照合のキーなので含めない。 */
export function relationFingerprintText(r: { from: string; to: string; kind: string }): string {
  return JSON.stringify(['pkc3-rp1', r.from, r.to, r.kind]);
}

/** 墓標 = 「これは消えた」。ゴミ箱を空にしても残す別の記録(`sync-state.ts`)。 */
export interface Tombstone {
  readonly key: string;
  /** 消した時点の指紋(消した側が見ていた内容)。 */
  readonly lastHash: string;
  /** 消した端末の id と、その端末の連番(時計ではない)。 */
  readonly device: string;
  readonly seq: number;
}

/** 一方の側の 1 件。 */
export interface KeyedState {
  readonly key: string;
  readonly hash: string;
}

/** 「前回の合意」: 相手ごとに持つ、キー → 指紋。 */
export type Baseline = Readonly<Record<string, string>>;

/** 1 つの側の変更の集合(前回の合意からの差)。 */
export interface ChangeSet {
  readonly added: readonly KeyedState[];
  readonly changed: readonly KeyedState[];
  /** 消えた物。`lastHash` = 前回の合意の指紋、合意に無ければ墓標の指紋。 */
  readonly deleted: readonly { readonly key: string; readonly lastHash: string }[];
}

const byKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * 現在の状態を前回の合意と比べて、追加・変更・削除に分ける。
 *
 * - 合意に無い・現在ある → 追加 / 合意と指紋が違う → 変更 / 合意にある・現在無い → 削除(**墓標が無くても拾う**)
 * - この相手と一度も同期していない(合意に無い)のに墓標がある物 → 削除(第三の端末への伝播)
 * - 現在ある物の墓標は無視する(消したあと同じキーが戻った)。
 *
 * 順はキーの昇順で決定的にする。
 */
export function extractChanges(current: readonly KeyedState[], baseline: Baseline, tombstones: readonly Tombstone[]): ChangeSet {
  const cur = new Map(current.map((c) => [c.key, c.hash] as const));
  const added: KeyedState[] = [];
  const changed: KeyedState[] = [];
  const deleted: { key: string; lastHash: string }[] = [];
  for (const [key, hash] of cur) {
    const b = baseline[key];
    if (b === undefined) added.push({ key, hash });
    else if (b !== hash) changed.push({ key, hash });
  }
  for (const key of Object.keys(baseline)) {
    if (!cur.has(key)) deleted.push({ key, lastHash: baseline[key] as string });
  }
  for (const t of tombstones) {
    if (!cur.has(t.key) && baseline[t.key] === undefined) deleted.push({ key: t.key, lastHash: t.lastHash });
  }
  return { added: added.sort(byKey), changed: changed.sort(byKey), deleted: deleted.sort(byKey) };
}

/** 相手の側の 1 件。`deleted` は墓標が届いた場合(`lastHash` つき)。 */
export type RemoteState =
  | { readonly kind: 'present'; readonly hash: string }
  | { readonly kind: 'deleted'; readonly lastHash: string }
  | { readonly kind: 'absent' };

/** 競合の種類。⚠ どれも**何も失わない**(`resolution` を参照)。 */
export type ConflictKind =
  /** 両方が前回から変えて、内容が違う。 */
  | 'both-edited'
  /** 両方が別々に新しく作った(同じ lid・違う内容)。 */
  | 'both-added'
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

export type Decision =
  /** 同じ。何もしない(双方が同じ内容 / 双方が消した)。 */
  | { readonly action: 'noop'; readonly key: string }
  /** 相手だけが変えた(追加を含む)→ こちらへ取り込む。 */
  | { readonly action: 'take-remote'; readonly key: string; readonly hash: string }
  /** 相手が消し、こちらは前回から変わっていない → こちらのゴミ箱へ移す。 */
  | { readonly action: 'trash-local'; readonly key: string }
  /** こちらだけが変えた(追加を含む)→ 相手へ送る。 */
  | { readonly action: 'push-local'; readonly key: string; readonly hash: string }
  /** こちらが消し、相手は変わっていない → 相手のゴミ箱へ移させる。 */
  | { readonly action: 'push-delete'; readonly key: string; readonly lastHash: string }
  | {
      readonly action: 'conflict';
      readonly key: string;
      readonly kind: ConflictKind;
      readonly resolution: ConflictResolution;
      readonly localHash?: string;
      readonly remoteHash?: string;
    };

/**
 * 1 つのキーの三者比較。時計は見ない。
 *
 * `base` が無く相手が墓標のとき、墓標の `lastHash` を前回の合意の代わりに使う
 * (一度も同期していない端末から消えた事実が届く場合)。
 */
export function decideOne(key: string, base: string | undefined, local: string | undefined, remote: RemoteState): Decision {
  const r = remote.kind === 'present' ? remote.hash : undefined;
  const effBase = base ?? (remote.kind === 'deleted' ? remote.lastHash : undefined);
  if (local === r) return { action: 'noop', key };
  const localChanged = local !== effBase;
  const remoteChanged = r !== effBase;
  if (!localChanged && remoteChanged) {
    return r === undefined ? { action: 'trash-local', key } : { action: 'take-remote', key, hash: r };
  }
  if (localChanged && !remoteChanged) {
    return local === undefined ? { action: 'push-delete', key, lastHash: effBase as string } : { action: 'push-local', key, hash: local };
  }
  // 両方が変えた(local !== r は確定)
  if (local !== undefined && r !== undefined) {
    return {
      action: 'conflict',
      key,
      kind: effBase === undefined ? 'both-added' : 'both-edited',
      resolution: 'keep-both-copy',
      localHash: local,
      remoteHash: r,
    };
  }
  if (local === undefined && r !== undefined) {
    return { action: 'conflict', key, kind: 'deleted-here-edited-there', resolution: 'restore-remote', remoteHash: r };
  }
  return { action: 'conflict', key, kind: 'edited-here-deleted-there', resolution: 'keep-local', localHash: local };
}

export interface MergeInput {
  readonly baseline: Baseline;
  readonly local: readonly KeyedState[];
  readonly remote: readonly KeyedState[];
  /** 相手から届いた墓標。 */
  readonly remoteTombstones: readonly Tombstone[];
  /**
   * 相手の全体が見えているか。
   * - `true`(相手の全件を受け取った): 合意にあって相手に無い物は「相手が消した」と見なす
   * - `false`(差分だけ): 相手に無いのは「変えていない」(墓標のある物だけが削除)
   */
  readonly remoteIsComplete: boolean;
}

/** 全キーについて決める。結果はキーの昇順(決定的)。 */
export function decideMerge(input: MergeInput): readonly Decision[] {
  const local = new Map(input.local.map((s) => [s.key, s.hash] as const));
  const remote = new Map(input.remote.map((s) => [s.key, s.hash] as const));
  const tombs = new Map(input.remoteTombstones.map((t) => [t.key, t] as const));
  const keys = new Set<string>([...local.keys(), ...remote.keys(), ...tombs.keys(), ...Object.keys(input.baseline)]);
  const out: Decision[] = [];
  for (const key of [...keys].sort()) {
    const base = input.baseline[key];
    const rh = remote.get(key);
    const tomb = tombs.get(key);
    let rs: RemoteState;
    if (rh !== undefined) rs = { kind: 'present', hash: rh };
    else if (tomb) rs = { kind: 'deleted', lastHash: tomb.lastHash };
    else if (base !== undefined) rs = input.remoteIsComplete ? { kind: 'deleted', lastHash: base } : { kind: 'present', hash: base };
    else rs = { kind: 'absent' };
    out.push(decideOne(key, base, local.get(key), rs));
  }
  return out;
}

/**
 * 同期が済んだ後の「前回の合意」を作る。反映後にこちらが持つ指紋の全件をそのまま次の合意にする
 * (消えたキーは載らないので合意から外れる。競合のコピーの新 lid は呼び手が足して渡す)。
 */
export function nextBaseline(finalHashes: readonly KeyedState[]): Baseline {
  const out: Record<string, string> = {};
  for (const s of finalHashes) out[s.key] = s.hash;
  return out;
}
