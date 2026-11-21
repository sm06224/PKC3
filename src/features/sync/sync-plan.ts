/**
 * 🔴 **端末間の同期(#2000)段 2 ── 差分ファイルの取り込みの計画(純関数)**。
 *
 * 入力(相手の差分ファイル・こちらの現在の指紋・前回の同期の記録)から、`decideMerge`(段 1)の判定を
 * **こちらへ反映する操作の一覧(`SyncPlan`)**に直す。ここは何も書かない ── 書くのは worker の `syncApply`(1 回の tx)。
 *
 * ## 方針(設計 doc §12.1)
 * - lid を保つ合流(「新しいノートとして足して lid を振り直す」ではない)。
 * - 取り込む判定: 相手だけが変えた → 取り込む(前の本文は履歴へ残る)/ 欄ごとに合わせる / こちらだけ → 何もしない(次の書き出しで送る)/
 *   相手が消した → ゴミ箱へ / 競合 → **両方残す**(相手の版を別ノートのコピーとして足す。題名に印)。
 * - 全件の指紋(`fingerprints`)があるので、相手を常に「全件が見えている」として突き合わせる(`remoteIsComplete: true`)。
 *   ただし**本文が入っていないノート**(相手が前回から変えていない)を取り込む判定になったら、取り込めない
 *   (`needFull`)と言う ── 「すべてを書き出す」で書き出し直してもらう。
 * - 親フォルダが無い / ゴミ箱の子はルートへ置く(約束 6)。宛先の無いつながりは足さない。
 * - **同期の記録(次の前回の合意)** = 「相手がいま持っている版」。取り込んだ物は取り込み後の指紋、
 *   こちらだけの変更・合わせた結果・コピーを作った元は**相手の版**(次の書き出しで差分として送る)。
 *
 * ⚠ pure module。乱数(新しい lid)は呼び手が渡す。
 */
import { decideMerge, fpEqual, nextBaseline, relationKey, type Baseline, type Decision, type Fp, type KeyedState, type Tombstone } from './change-set';
import type { DiffFile, DiffRelation } from './diff-file';
import { isSyncRelationKind } from './sync-guard';
import { placeFp, relationFp } from './sync-fp';
import { isLabelKey, isMarkKey, isNoteKey, isPinKey, labelFp, labelKey, markKeyLid, pinFp, pinKey } from './sync-marks';

export interface PlanUpsert {
  lid: string;
  /** その lid がこちらで生きていたか(いなければ作る / ゴミ箱から戻す)。 */
  existed: boolean;
  /** 置き換える内容(無ければ内容は触らない)。 */
  content?: { title: string; archetype: string; body: string };
  /** 親フォルダを張り替える(無ければ触らない)。`null` = ルート。 */
  place?: { parentLid: string | null };
  reason: 'take' | 'merge' | 'restore' | 'copy';
  /**
   * 🔴 **計画を立てたときのこちらの指紋**(`null` = こちらで生きていなかった / 無ければ確かめない)。worker の tx が書く直前に測り直し、
   * 違っていたら(計画と反映の間にこちらが編集した)**書かずに**、相手の版を `fallback` の新しい lid のコピーとして足す(両方残す)。
   */
  expect?: Fp | null;
  /** 上の食い違いのときに足すコピー(新しい lid と題名)。内容(`content`)がある物だけ持つ。 */
  fallback?: { lid: string; title: string };
}

export interface PlanConflict {
  kind: 'both-edited' | 'first-sync' | 'deleted-here-edited-there' | 'edited-here-deleted-there';
  /** 元のノートの lid。 */
  lid: string;
  title: string;
  /** 相手の版のコピーを足したときの新しい lid。 */
  copyLid?: string;
  copyTitle?: string;
}

export interface SyncSummary {
  /** 相手の版を取り込んだ(新しく入った / 内容を置き換えた / ゴミ箱から戻した)。 */
  created: number;
  updated: number;
  restored: number;
  /** 欄ごとに合わせた。 */
  merged: number;
  /** ゴミ箱へ移した。 */
  trashed: number;
  /** こちらだけが新しい(次の書き出しで相手へ送る)。 */
  keptLocal: number;
  /** 競合のコピー(別ノートとして足した)。通常の競合 / 初回の同期。 */
  conflicts: number;
  firstSync: number;
  relationsAdded: number;
  relationsRemoved: number;
  /** 宛先が無くてルートへ置いたノート。 */
  orphans: number;
  /** 宛先が無くて足さなかったつながり。 */
  danglingRelations: number;
  /** 色ラベル・ピン留め(段 3)。付けた / 外した(色を変えたのは付けたに数える)。 */
  labelsSet: number;
  labelsCleared: number;
  pinsAdded: number;
  pinsRemoved: number;
  /** 両方で違う色にした(こちらを残した)。 */
  labelConflicts: number;
}

export interface SyncPlan {
  upserts: PlanUpsert[];
  trash: string[];
  /** ゴミ箱へ移す物の、計画時のこちらの指紋(tx で測り直し、違えば移さない = こちらの編集を消さない)。 */
  trashExpect: Record<string, Fp>;
  relationAdds: DiffRelation[];
  relationRemoves: DiffRelation[];
  /** 色ラベル・ピン留め(段 3)。付ける(色を変える)/ 外す / 留める / 外す。 */
  labelSets: Array<{ lid: string; color: number }>;
  labelClears: string[];
  pinAdds: string[];
  pinRemoves: string[];
  /** 取り込み後に記録する、この相手の「前回の合意」。 */
  baseline: Baseline;
  conflicts: PlanConflict[];
  /** 本文が入っていなくて取り込めなかったノートの題名(こちらに題名が無ければ lid)。 */
  needFull: string[];
  summary: SyncSummary;
}

export interface PlanInput {
  remote: Pick<DiffFile, 'manifest' | 'container'>;
  /** こちらの現在の指紋(ノート = lid、つながり = `rel:…`)。 */
  localStates: readonly KeyedState[];
  localRelations: readonly DiffRelation[];
  /**
   * 相手のノート(本文つき)の指紋。⚠ **worker が測った物を渡す**(`syncMeasureNotes`)── 本文の SHA-256 を主スレッドでやらない
   * (重い処理は worker へ。設計 doc §12.1)。`remote.container.notes` の全 lid が要る(無ければ throw)。
   */
  remoteNoteFps: ReadonlyMap<string, Fp>;
  /** こちらの色ラベル(lid → 色の番号)。両方で違う色にしたときの決め方に使う(省略 = こちらを残す)。 */
  localLabelColors?: ReadonlyMap<string, number>;
  /** こちらで生きているノートの題名。 */
  localTitles: ReadonlyMap<string, string>;
  localTombstones: readonly Tombstone[];
  /** 保存してある、この相手の前回の合意。 */
  baseline: Baseline;
  /** 競合のコピーの題名に付ける日付(`YYYY-MM-DD`)。 */
  date: string;
  genLid(): string;
}

/** 競合のコピーの題名。⚠ 検索で拾える固定の語「同期の競合」を必ず入れる(競合の一覧の代わり。初回の同期は「初回の同期の競合」= 同じ語を含む)。 */
export function conflictCopyTitle(title: string, firstSync: boolean, date: string): string {
  const base = title === '' ? '(無題)' : title;
  return `${base}(${firstSync ? '初回の同期の競合' : '同期の競合'} ${date})`;
}

const emptySummary = (): SyncSummary => ({
  created: 0, updated: 0, restored: 0, merged: 0, trashed: 0, keptLocal: 0, conflicts: 0, firstSync: 0,
  relationsAdded: 0, relationsRemoved: 0, orphans: 0, danglingRelations: 0,
  labelsSet: 0, labelsCleared: 0, pinsAdded: 0, pinsRemoved: 0, labelConflicts: 0,
});

const REL_PREFIX = 'rel:';

/**
 * 判定に使う前回の合意。保存してある物に、相手が「こちらの版をこう見ていた」(`peerBase`)を重ねる:
 * **こちらがまだその版のまま**のキーだけ、相手が見た版を共通の祖先にする(こちらは変えていないので、相手の変更だけを取り込む)。
 * これで、お互いが同じ版から別々に直した後の往復で、競合のコピーが増え続けない。
 */
export function effectiveBaseline(
  stored: Baseline,
  peerBase: readonly { key: string; c: string; p?: string }[],
  local: readonly KeyedState[],
  /** 相手の指紋(全件)。あれば、「相手がまだ相手が見た版のままのキー」も共通の祖先にする(フォルダ同期。下)。 */
  remote?: ReadonlyMap<string, Fp>,
): Baseline {
  const out = Object.assign(Object.create(null) as Record<string, Fp>, stored);
  const lmap = new Map(local.map((s) => [s.key, s] as const));
  for (const p of peerBase) {
    const l = lmap.get(p.key);
    const pf: Fp = p.p === undefined ? { content: p.c } : { content: p.c, place: p.p };
    if (l !== undefined && fpEqual(l, pf)) {
      out[p.key] = pf;
      continue;
    }
    // 🔴 相手が、自分の見た版のまま変えていない(相手の今の指紋 = 相手が記録しているこちらの版)。こちらだけが変えた物になる
    //   (記録が無いまま最初に取り込むと、こちらの編集が「初回の同期の競合」になってしまう。フォルダ同期は相手のファイルが先に在る)
    const r = remote?.get(p.key);
    if (l !== undefined && r !== undefined && fpEqual(r, pf)) out[p.key] = pf;
  }
  return out;
}

export function planSyncImport(input: PlanInput): SyncPlan {
  const { remote } = input;
  const c = remote.container;
  const noteByLid = new Map(c.notes.map((n) => [n.lid, n] as const));
  // ── 相手の指紋(全件)。本文のある物は本文から測り直す(信用しすぎない)。つながりは目録(relations)が正本。
  const remoteFp = new Map<string, Fp>();
  for (const f of c.fingerprints) {
    if (f.key.startsWith(REL_PREFIX) || isMarkKey(f.key)) continue; // つながり・印は、下で目録(relations / labels / pins)から作る
    remoteFp.set(f.key, f.p === undefined ? { content: f.c } : { content: f.c, place: f.p });
  }
  for (const n of c.notes) {
    const fp = input.remoteNoteFps.get(n.lid);
    if (fp === undefined) throw new Error(`相手のノートの指紋が測られていません: ${n.lid}`);
    remoteFp.set(n.lid, fp);
  }
  const remoteRel = new Map<string, DiffRelation>();
  for (const r of c.relations) {
    if (!isSyncRelationKind(r.kind)) continue; // 運べない種類(structural・知らない種類)は判定に入れない
    const k = relationKey({ from: r.from, to: r.to, kind: r.kind });
    remoteRel.set(k, r);
    remoteFp.set(k, relationFp());
  }
  // 色ラベル・ピン留め(段 3)。⚠ 相手のファイルが運んでいない種類(段 2 までのファイル)は、判定に入れない
  const labelsCarried = c.labels !== null;
  const pinsCarried = c.pins !== null;
  const remoteLabelColor = new Map<string, number>();
  for (const l of c.labels ?? []) {
    remoteLabelColor.set(l.lid, l.color);
    remoteFp.set(labelKey(l.lid), labelFp(l.color));
  }
  for (const lid of c.pins ?? []) remoteFp.set(pinKey(lid), pinFp());
  const isUncarried = (key: string): boolean => (isLabelKey(key) && !labelsCarried) || (isPinKey(key) && !pinsCarried);
  const localRel = new Map(input.localRelations.map((r) => [relationKey({ from: r.from, to: r.to, kind: r.kind }), r] as const));
  const localFp = new Map(input.localStates.map((s) => [s.key, s] as const));
  const remoteStates: KeyedState[] = [...remoteFp].map(([key, fp]) => ({ key, ...fp }));
  const baselineAll = effectiveBaseline(input.baseline, c.peerBase, input.localStates, remoteFp);
  const baseline = Object.create(null) as Record<string, Fp>;
  for (const [k, fp] of Object.entries(baselineAll)) if (!isUncarried(k)) baseline[k] = fp;
  const decisions = decideMerge({
    baseline,
    local: input.localStates.filter((x) => !isUncarried(x.key)),
    remote: remoteStates,
    remoteTombstones: c.tombstones,
    localTombstones: input.localTombstones,
    remoteIsComplete: true,
  });

  // こちらで生きているノート(つながりでない物)。後でゴミ箱・新規で更新して「取り込み後に生きている」集合にする。
  const finalLive = new Set<string>();
  for (const s of input.localStates) if (isNoteKey(s.key)) finalLive.add(s.key);
  for (const d of decisions) {
    if (!isNoteKey(d.key)) continue;
    if (d.action === 'trash-local') finalLive.delete(d.key);
    else if (d.action === 'take-remote' || (d.action === 'conflict' && d.resolution === 'restore-remote')) finalLive.add(d.key);
  }

  const upserts: PlanUpsert[] = [];
  const trash: string[] = [];
  const trashExpect: Record<string, Fp> = Object.create(null) as Record<string, Fp>;
  const relationAdds: DiffRelation[] = [];
  const relationRemoves: DiffRelation[] = [];
  const labelSets: Array<{ lid: string; color: number }> = [];
  const labelClears: string[] = [];
  const pinAdds: string[] = [];
  const pinRemoves: string[] = [];
  const conflicts: PlanConflict[] = [];
  const needFull: string[] = [];
  const next = Object.create(null) as Record<string, Fp>;
  const s = emptySummary();
  const titleOf = (lid: string): string => input.localTitles.get(lid) ?? noteByLid.get(lid)?.title ?? lid;

  /** 取り込む親フォルダ。宛先が取り込み後に無ければルート(約束 6)。 */
  const resolveParent = (parentLid: string | null): { parent: string | null; orphan: boolean } =>
    parentLid !== null && !finalLive.has(parentLid) ? { parent: null, orphan: true } : { parent: parentLid, orphan: false };

  // 取り込む物の指紋を決めるため、新しい lid の親は「コピー・取り込み後の集合」を見る(上の finalLive は判定結果ぶん)。
  const copies: Array<{ lid: string; note: NonNullable<ReturnType<typeof noteByLid.get>> }> = [];
  for (const d of decisions) {
    if (d.action === 'conflict' && d.resolution === 'keep-both-copy') {
      const n = noteByLid.get(d.key);
      if (n !== undefined) {
        const lid = input.genLid();
        copies.push({ lid, note: n });
        finalLive.add(lid);
      }
    }
  }
  const copyOf = new Map(copies.map((x) => [x.note.lid, x.lid] as const));

  /** 計画時のこちらの状態(tx で測り直して比べる)と、食い違ったときのコピーの置き場。 */
  const guard = (key: string, title: string): Pick<PlanUpsert, 'expect' | 'fallback'> => {
    const l = localFp.get(key);
    return {
      expect: l === undefined ? null : { content: l.content, ...(l.place === undefined ? {} : { place: l.place }) },
      fallback: { lid: input.genLid(), title: conflictCopyTitle(title, false, input.date) },
    };
  };
  const takeRemote = (key: string, fp: Fp, reason: PlanUpsert['reason'], existed: boolean): void => {
    const n = noteByLid.get(key);
    if (n === undefined) {
      needFull.push(titleOf(key));
      if (baseline[key] !== undefined) next[key] = baseline[key] as Fp;
      return;
    }
    const { parent, orphan } = resolveParent(n.parentLid);
    if (orphan) s.orphans++;
    upserts.push({ lid: key, existed, content: { title: n.title, archetype: n.archetype, body: n.body }, place: { parentLid: parent }, reason, ...guard(key, n.title) });
    next[key] = { content: fp.content, place: orphan ? placeFp(null) : (fp.place as string) };
  };

  // 相手が運んでいない種類の印は、記録(前回の合意)をそのまま持ち越す
  for (const [k, fp] of Object.entries(baselineAll)) if (isUncarried(k)) next[k] = fp;

  /** 色ラベル・ピン留めの 1 件(段 3)。宛先のノートが取り込み後に生きていなければ何もしない(ゴミ箱の物の印は残す)。 */
  const markDecision = (d: Decision, R: Fp | undefined): void => {
    const lid = markKeyLid(d.key) as string;
    const isLabel = isLabelKey(d.key);
    const live = finalLive.has(lid);
    const takeRemoteMark = (): void => {
      if (!live) return;
      if (isLabel) {
        const color = remoteLabelColor.get(lid);
        if (color === undefined) return;
        labelSets.push({ lid, color });
        s.labelsSet++;
      } else {
        pinAdds.push(lid);
        s.pinsAdded++;
      }
      if (R !== undefined) next[d.key] = R;
    };
    switch (d.action) {
      case 'noop': {
        const l = localFp.get(d.key);
        if (l !== undefined) next[d.key] = { content: l.content };
        break;
      }
      case 'take-remote':
        takeRemoteMark();
        break;
      case 'trash-local':
        if (!live) break;
        if (isLabel) {
          labelClears.push(lid);
          s.labelsCleared++;
        } else {
          pinRemoves.push(lid);
          s.pinsRemoved++;
        }
        break;
      case 'push-local':
      case 'push-delete':
      case 'merge':
        if (R !== undefined) next[d.key] = R;
        break;
      case 'conflict':
        if (d.resolution === 'restore-remote') {
          takeRemoteMark();
          break;
        }
        // 色ラベルは 2 つの色を「両方残す」ことができない。両方の端末が同じ色に収まるよう、**色の番号が大きい方**を採る
        // (時計を使わず、どちらの端末で判定しても同じ結果になる = 往復で食い違いが残らない)。こちらで付けて相手で外した物はこちらを残す
        if (isLabel && d.kind !== 'edited-here-deleted-there') {
          s.labelConflicts++;
          const rc = remoteLabelColor.get(lid);
          const lc = input.localLabelColors?.get(lid);
          if (rc !== undefined && lc !== undefined && rc > lc) {
            takeRemoteMark();
            break;
          }
        }
        if (R !== undefined) next[d.key] = R;
        break;
    }
  };

  for (const d of decisions as readonly Decision[]) {
    const isRel = d.key.startsWith(REL_PREFIX);
    const R = remoteFp.get(d.key);
    if (isMarkKey(d.key)) {
      markDecision(d, R);
      continue;
    }
    if (isRel) {
      if (d.action === 'take-remote') {
        const r = remoteRel.get(d.key);
        if (r !== undefined && finalLive.has(r.from) && finalLive.has(r.to)) {
          relationAdds.push(r);
          s.relationsAdded++;
          next[d.key] = relationFp();
        } else {
          s.danglingRelations++;
        }
      } else if (d.action === 'trash-local') {
        const r = localRel.get(d.key);
        if (r !== undefined) {
          relationRemoves.push(r);
          s.relationsRemoved++;
        }
      } else if (d.action === 'noop') {
        if (localFp.has(d.key)) next[d.key] = relationFp();
      } else if (R !== undefined) {
        next[d.key] = R;
      }
      continue;
    }
    switch (d.action) {
      case 'noop': {
        const l = localFp.get(d.key);
        if (l !== undefined) next[d.key] = { content: l.content, ...(l.place === undefined ? {} : { place: l.place }) };
        break;
      }
      case 'take-remote': {
        const existed = localFp.has(d.key);
        const before = upserts.length;
        takeRemote(d.key, d.fp, 'take', existed);
        if (upserts.length > before) {
          if (existed) s.updated++;
          else s.created++;
        }
        break;
      }
      case 'trash-local': {
        trash.push(d.key);
        const l = localFp.get(d.key);
        if (l !== undefined) trashExpect[d.key] = { content: l.content, ...(l.place === undefined ? {} : { place: l.place }) };
        s.trashed++;
        break;
      }
      case 'push-local':
      case 'push-delete':
        s.keptLocal++;
        if (R !== undefined) next[d.key] = R;
        break;
      case 'merge': {
        const l = localFp.get(d.key) as KeyedState;
        const r = R as Fp;
        const n = noteByLid.get(d.key);
        const content = d.fp.content === l.content ? undefined : n;
        const wantPlace = d.fp.place !== l.place;
        if (d.fp.content !== l.content && n === undefined) {
          needFull.push(titleOf(d.key));
          if (baseline[d.key] !== undefined) next[d.key] = baseline[d.key] as Fp;
          break;
        }
        if (wantPlace && n === undefined && d.fp.place === r.place) {
          needFull.push(titleOf(d.key));
          if (baseline[d.key] !== undefined) next[d.key] = baseline[d.key] as Fp;
          break;
        }
        const up: PlanUpsert = { lid: d.key, existed: true, reason: 'merge', ...(content !== undefined ? guard(d.key, content.title) : { expect: localFp.has(d.key) ? { content: l.content, ...(l.place === undefined ? {} : { place: l.place }) } : null }) };
        if (content !== undefined) up.content = { title: content.title, archetype: content.archetype, body: content.body };
        if (wantPlace && n !== undefined) {
          const { parent, orphan } = resolveParent(n.parentLid);
          if (orphan) s.orphans++;
          up.place = { parentLid: parent };
        }
        upserts.push(up);
        s.merged++;
        next[d.key] = r;
        break;
      }
      case 'conflict': {
        const base: PlanConflict = { kind: d.kind, lid: d.key, title: titleOf(d.key) };
        if (d.resolution === 'keep-both-copy') {
          const n = noteByLid.get(d.key);
          const lid = copyOf.get(d.key);
          if (n === undefined || lid === undefined) {
            needFull.push(titleOf(d.key));
            if (baseline[d.key] !== undefined) next[d.key] = baseline[d.key] as Fp;
            break;
          }
          const first = d.kind === 'first-sync';
          const copyTitle = conflictCopyTitle(n.title, first, input.date);
          const { parent, orphan } = resolveParent(n.parentLid);
          if (orphan) s.orphans++;
          upserts.push({ lid, existed: false, content: { title: copyTitle, archetype: n.archetype, body: n.body }, place: { parentLid: parent }, reason: 'copy' });
          conflicts.push({ ...base, copyLid: lid, copyTitle });
          s.conflicts++;
          if (first) s.firstSync++;
          if (R !== undefined) next[d.key] = R;
        } else if (d.resolution === 'restore-remote') {
          const before = upserts.length;
          takeRemote(d.key, d.remote as Fp, 'restore', false);
          if (upserts.length > before) {
            s.restored++;
            conflicts.push(base);
          }
        } else {
          // こちらを残し、相手へ送り返す(相手の削除では消さない)。相手はもう持っていないので記録には載せない
          conflicts.push(base);
          s.keptLocal++;
        }
        break;
      }
    }
  }
  return { upserts, trash, trashExpect, relationAdds, relationRemoves, labelSets, labelClears, pinAdds, pinRemoves, baseline: nextBaseline(Object.entries(next).map(([key, fp]) => ({ key, ...fp }))), conflicts, needFull, summary: s };
}
