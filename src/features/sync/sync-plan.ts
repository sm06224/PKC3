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
import { labelFp, pinFp, placeFp, relationFp } from './sync-fp';
import { attrLidOf, isAttrKey, isNoteKey, isRelKey, labelKey, pinKey, LABEL_PREFIX } from './sync-attr';

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
  /** 色ラベル・ピン留めを相手に合わせた数(付けた・変えた・外した)。 */
  labelsChanged: number;
  pinsChanged: number;
  /** 両方で違う色を付けた(こちらを残した)。 */
  attrConflicts: number;
  /**
   * 🔴 選択同期(#2066 段 5-A): こちらが選択同期のとき、**こちらの選択の外のノート**(と、それに付いた印・つながり)への
   * 相手からの変更・削除を反映しなかった数。こちらの原本と同期の記録はそのまま。
   */
  skippedUnselected: number;
}

export interface SyncPlan {
  upserts: PlanUpsert[];
  trash: string[];
  /** ゴミ箱へ移す物の、計画時のこちらの指紋(tx で測り直し、違えば移さない = こちらの編集を消さない)。 */
  trashExpect: Record<string, Fp>;
  relationAdds: DiffRelation[];
  relationRemoves: DiffRelation[];
  /** 色ラベルを付ける・変える(`color`)/ 外す(`null`)。 */
  labelSets: Array<{ lid: string; color: number | null }>;
  /** ピン留めを付ける(`on: true`)/ 外す。 */
  pinSets: Array<{ lid: string; on: boolean }>;
  /** 取り込み後に記録する、この相手の「前回の合意」。 */
  baseline: Baseline;
  conflicts: PlanConflict[];
  /** 本文が入っていなくて取り込めなかったノートの題名(こちらに題名が無ければ lid)。 */
  needFull: string[];
  /**
   * 🔴 選択同期(#2066 段 5-A): こちらが選択同期のとき、相手から新しく入るノートのうち、こちらの直接指定に足す lid
   * (親がこちらの `direct ∪ descendant` にも、今回入る新しいフォルダの中にも無い物)。足さないと、次の書き出しで相手へ返らない。
   */
  selectiveSelectAdds: string[];
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
  /** こちらで生きているノートの題名。 */
  localTitles: ReadonlyMap<string, string>;
  localTombstones: readonly Tombstone[];
  /** 保存してある、この相手の前回の合意。 */
  baseline: Baseline;
  /** 競合のコピーの題名に付ける日付(`YYYY-MM-DD`)。 */
  date: string;
  genLid(): string;
  /**
   * 🔴 こちらが選択同期のとき(#2066 段 5-A)。`selectedLids` = こちらの対象の集合 S(閉包)/
   * `directAndDescendantLids` = こちらの `direct ∪ descendant`。省略 = こちらは全部のノート(今までと同じ)。
   */
  localSelective?: { selectedLids: ReadonlySet<string>; directAndDescendantLids: ReadonlySet<string> };
}

/** 競合のコピーの題名。⚠ 検索で拾える固定の語「同期の競合」を必ず入れる(競合の一覧の代わり。初回の同期は「初回の同期の競合」= 同じ語を含む)。 */
export function conflictCopyTitle(title: string, firstSync: boolean, date: string): string {
  const base = title === '' ? '(無題)' : title;
  return `${base}(${firstSync ? '初回の同期の競合' : '同期の競合'} ${date})`;
}

const emptySummary = (): SyncSummary => ({
  created: 0, updated: 0, restored: 0, merged: 0, trashed: 0, keptLocal: 0, conflicts: 0, firstSync: 0,
  relationsAdded: 0, relationsRemoved: 0, orphans: 0, danglingRelations: 0, labelsChanged: 0, pinsChanged: 0, attrConflicts: 0,
  skippedUnselected: 0,
});

/** つながりのキー(`rel:<from>|<to>|<kind>`)の両端。 */
function relEndsOf(key: string): [string, string] {
  const [from, to] = key.slice(4).split('|');
  return [from ?? '', to ?? ''];
}

/**
 * 判定に使う前回の合意。保存してある物に、相手が「こちらの版をこう見ていた」(`peerBase`)を重ねる:
 * **こちらがまだその版のまま**のキーだけ、相手が見た版を共通の祖先にする(こちらは変えていないので、相手の変更だけを取り込む)。
 * これで、お互いが同じ版から別々に直した後の往復で、競合のコピーが増え続けない。
 */
export function effectiveBaseline(stored: Baseline, peerBase: readonly { key: string; c: string; p?: string }[], local: readonly KeyedState[]): Baseline {
  const out = Object.assign(Object.create(null) as Record<string, Fp>, stored);
  const lmap = new Map(local.map((s) => [s.key, s] as const));
  for (const p of peerBase) {
    const l = lmap.get(p.key);
    if (l === undefined) continue;
    const pf: Fp = p.p === undefined ? { content: p.c } : { content: p.c, place: p.p };
    if (fpEqual(l, pf)) out[p.key] = pf;
  }
  return out;
}

export function planSyncImport(input: PlanInput): SyncPlan {
  const { remote } = input;
  const c = remote.container;
  const noteByLid = new Map(c.notes.map((n) => [n.lid, n] as const));
  // ── 相手の指紋(全件)。本文のある物は本文から測り直す(信用しすぎない)。つながりは目録(relations)が正本。
  const remoteFp = new Map<string, Fp>();
  /**
   * 🔴 **印(色ラベル・ピン留め)を運ぶファイルか**。運ばない(バージョン 1)なら、印は判定に入れず、記録の印はそのまま持ち越す ──
   * 入れると「相手は印を全部外した」と読んで、こちらの印を外してしまう。
   */
  const carriesAttrs = c.labels !== undefined && c.pins !== undefined;
  for (const f of c.fingerprints) {
    if (!isNoteKey(f.key)) continue;
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
  const remoteLabel = new Map<string, number>();
  if (carriesAttrs) {
    for (const l of c.labels ?? []) {
      remoteLabel.set(l.lid, l.color);
      remoteFp.set(labelKey(l.lid), labelFp(l.color));
    }
    for (const lid of c.pins ?? []) remoteFp.set(pinKey(lid), pinFp());
  }
  const localRel = new Map(input.localRelations.map((r) => [relationKey({ from: r.from, to: r.to, kind: r.kind }), r] as const));
  const judgedLocal = carriesAttrs ? input.localStates : input.localStates.filter((x) => !isAttrKey(x.key));
  const localFp = new Map(judgedLocal.map((s) => [s.key, s] as const));
  const remoteStates: KeyedState[] = [...remoteFp].map(([key, fp]) => ({ key, ...fp }));
  const fullBaseline = effectiveBaseline(input.baseline, c.peerBase, input.localStates);
  const baseline: Baseline = carriesAttrs
    ? fullBaseline
    : Object.fromEntries(Object.entries(fullBaseline).filter(([k]) => !isAttrKey(k)));
  /**
   * 🔴 **相手が選択同期のファイル(`scope: 'selective'`)は、相手の全体ではない**(#2066 段 5-A)。
   * 一覧に無いノートを「相手が消した」と見なさない(`remoteIsComplete: false`)── 消えたノートは削除の記録で届く。
   * ただし、相手の一覧に**両端のノートが載っている**つながり・**ノートが載っている**印は、相手の全体が見えている:
   * 記録に在って相手に無ければ外した物(つながり・印は削除の記録を持たないので、ここで同じ形の記録に直して判定へ渡す)。
   */
  const remoteSelective = remote.manifest.scope === 'selective';
  const remoteTombs: Tombstone[] = [...c.tombstones];
  if (remoteSelective) {
    const tombKeys = new Set(remoteTombs.map((t) => t.key));
    for (const [k, fp] of Object.entries(baseline)) {
      if (remoteFp.has(k) || tombKeys.has(k)) continue;
      let covered = false;
      if (isRelKey(k)) {
        const [a, b] = relEndsOf(k);
        covered = remoteFp.has(a) && remoteFp.has(b);
      } else if (isAttrKey(k)) {
        covered = remoteFp.has(attrLidOf(k) ?? '');
      }
      if (covered) remoteTombs.push({ key: k, lastFp: fp as Fp, device: remote.manifest.device, seq: remote.manifest.seq });
    }
  }
  const decisions = decideMerge({
    baseline,
    local: judgedLocal,
    remote: remoteStates,
    remoteTombstones: remoteTombs,
    localTombstones: input.localTombstones,
    remoteIsComplete: !remoteSelective,
  });

  // こちらで生きているノート(つながりでない物)。後でゴミ箱・新規で更新して「取り込み後に生きている」集合にする。
  const finalLive = new Set<string>();
  for (const s of input.localStates) if (isNoteKey(s.key)) finalLive.add(s.key);
  /**
   * 🔴 **こちらの選択の外を守る**(#2066 段 5-A)。こちらが選択同期のとき、こちらで生きていて選択の外のノート
   * (と、それに付いた印・それに触れるつながり)には、相手からの変更・削除を反映しない。
   */
  const localLiveNotes = new Set(finalLive);
  const ls = input.localSelective;
  const outside = (lid: string): boolean => ls !== undefined && localLiveNotes.has(lid) && !ls.selectedLids.has(lid);
  const isProtected = (key: string): boolean => {
    if (ls === undefined) return false;
    if (isRelKey(key)) {
      const [a, b] = relEndsOf(key);
      return outside(a) || outside(b);
    }
    if (isAttrKey(key)) return outside(attrLidOf(key) ?? '');
    return outside(key);
  };
  for (const d of decisions) {
    if (!isNoteKey(d.key) || isProtected(d.key)) continue;
    if (d.action === 'trash-local') finalLive.delete(d.key);
    else if (d.action === 'take-remote' || (d.action === 'conflict' && d.resolution === 'restore-remote')) finalLive.add(d.key);
  }

  const upserts: PlanUpsert[] = [];
  const trash: string[] = [];
  const trashExpect: Record<string, Fp> = Object.create(null) as Record<string, Fp>;
  const relationAdds: DiffRelation[] = [];
  const relationRemoves: DiffRelation[] = [];
  const labelSets: SyncPlan['labelSets'] = [];
  const pinSets: SyncPlan['pinSets'] = [];
  const conflicts: PlanConflict[] = [];
  const needFull: string[] = [];
  const next = Object.create(null) as Record<string, Fp>;
  const s = emptySummary();
  /**
   * 相手が選択同期で、一覧に載っていないキー(相手の選択の外)は、相手の版が見えていない ── 記録を落とさず持ち越す
   * (落とすと、次の往復で相手の持っている版を「無い」と読み違える)。
   */
  const keepUnseen = (key: string): void => {
    if (!remoteSelective) return;
    const b = input.baseline[key];
    if (b !== undefined) next[key] = b;
  };
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

  /** 印 1 件の決め。⚠ ノートが取り込み後に居ない印は付けない / ノートがゴミ箱へ行く印は外さない(ゴミ箱の印は残す作法)。 */
  const decideAttr = (d: Decision): void => {
    const lid = attrLidOf(d.key) as string;
    const isLabel = d.key.startsWith(LABEL_PREFIX);
    const R = remoteFp.get(d.key);
    const L = localFp.get(d.key);
    const setRemote = (): boolean => {
      if (!finalLive.has(lid)) return false;
      if (isLabel) {
        const color = remoteLabel.get(lid);
        if (color === undefined) return false;
        labelSets.push({ lid, color });
        s.labelsChanged++;
      } else {
        pinSets.push({ lid, on: true });
        s.pinsChanged++;
      }
      return true;
    };
    const keepLocalFp = (): void => {
      if (L !== undefined) next[d.key] = { content: L.content };
    };
    switch (d.action) {
      case 'noop':
        keepLocalFp();
        return;
      case 'take-remote':
        if (setRemote()) next[d.key] = d.fp;
        return;
      case 'trash-local':
        // ノートごと消える(ゴミ箱へ行く)印は外さない
        if (!finalLive.has(lid)) return;
        // 🔴 相手にノートそのものが無い(相手がゴミ箱へ入れ、こちらは編集していたので残した)ときは、相手が印を外したのではない。
        //   印は外さず、前回の合意を持ち越す(外すと、残したノートから色・ピン留めが黙って消える)
        if (!remoteFp.has(lid)) {
          const b = baseline[d.key];
          if (b !== undefined) next[d.key] = b as Fp;
          return;
        }
        if (isLabel) {
          labelSets.push({ lid, color: null });
          s.labelsChanged++;
        } else {
          pinSets.push({ lid, on: false });
          s.pinsChanged++;
        }
        return;
      case 'push-local':
      case 'push-delete':
        if (R !== undefined) next[d.key] = R;
        else if (d.action === 'push-local') keepUnseen(d.key);
        return;
      case 'merge':
        // 印に place は無いので来ない。来たら相手の版を記録に残し、こちらはそのまま(次の書き出しで送る)
        if (R !== undefined) next[d.key] = R;
        return;
      case 'conflict':
        if (d.resolution === 'restore-remote') {
          if (setRemote() && R !== undefined) next[d.key] = R;
          return;
        }
        // 両方で違う色 / 初回で違う色 / こちらで付け直し相手が外した → こちらを残す(コピーは作れない)。相手の版を記録して次の書き出しで送る
        s.attrConflicts++;
        if (R !== undefined) next[d.key] = R;
        return;
    }
  };

  for (const d of decisions as readonly Decision[]) {
    if (d.action !== 'noop' && isProtected(d.key)) {
      // こちらを書き換える判定だけを数える(相手へ送る判定は、こちらを触らない)
      if (d.action === 'take-remote' || d.action === 'trash-local' || d.action === 'merge' || d.action === 'conflict') s.skippedUnselected++;
      const b = input.baseline[d.key];
      if (b !== undefined) next[d.key] = b;
      continue;
    }
    if (isAttrKey(d.key)) {
      decideAttr(d);
      continue;
    }
    const isRel = isRelKey(d.key);
    const R = remoteFp.get(d.key);
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
      } else if (d.action === 'push-local') {
        keepUnseen(d.key);
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
        else if (d.action === 'push-local') keepUnseen(d.key);
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
  // 印を運ばないファイルでは、記録の印をそのまま持ち越す(判定に入れていないので、消えたことにしない)
  if (!carriesAttrs) {
    for (const [k, fp] of Object.entries(input.baseline)) if (isAttrKey(k)) next[k] = fp;
  }
  // 🔴 こちらが選択同期: 新しく入るノートを直接指定へ足す(親がこちらの対象の下 / 今回入る新しいフォルダの下なら、足さなくても子孫で入る)
  const selectiveSelectAdds: string[] = [];
  if (ls !== undefined) {
    const fresh = new Set(upserts.filter((u) => !u.existed).map((u) => u.lid));
    for (const u of upserts) {
      if (u.existed) continue;
      const parent = u.place?.parentLid ?? null;
      if (parent !== null && (ls.directAndDescendantLids.has(parent) || fresh.has(parent))) continue;
      selectiveSelectAdds.push(u.lid);
    }
    selectiveSelectAdds.sort();
  }
  return {
    upserts,
    trash,
    trashExpect,
    relationAdds,
    relationRemoves,
    labelSets,
    pinSets,
    baseline: nextBaseline(Object.entries(next).map(([key, fp]) => ({ key, ...fp }))),
    conflicts,
    needFull,
    selectiveSelectAdds,
    summary: s,
  };
}
