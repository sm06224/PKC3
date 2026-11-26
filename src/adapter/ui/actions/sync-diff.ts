/**
 * 🔴 **端末間の同期(#2000)段 2 ── 差分ファイル(`*.pkc3-diff.zip`)の書き出しと取り込みの実行部**。
 *
 * 設計と約束は設計 doc §12.1。ここは配線(store → 純関数 → worker の 1 つの tx → 画面への知らせ)で、判断は
 * `features/sync/`(`sync-plan.ts` / `sync-export.ts` / `diff-file.ts`)と worker の `syncApply` が持つ。
 *
 * - 設定「端末間の同期」が切のときは、どちらも**何もせず**、設定画面の場所を言って断る(黙って無視しない)。
 * - 取り込みは **ワークスペースの対応**(`pair:<相手の端末 id>`)を初回に確認する。対応が無いまま書かない。
 * - 添付の実体は**先に**書く(参照だけ残る形を作らない。`import-pkc2.ts` と同じ順序)。足りない添付は参照を残して一覧で言う。
 * - 反映は worker の 1 回の tx。失敗したら何も書かれない(ノートも同期の記録も)。
 */
import { errorText } from '@features/error-text';
import { readDiffZip, writeDiffZip, DIFF_SUFFIX, type DiffAssetMeta, type DiffFile, type DiffFingerprint, type DiffNote } from '@features/sync/diff-file';
import { fingerprintDigest, planExport, planFolderExport, type SelectiveExport } from '@features/sync/sync-export';
import { resolveSelectiveClosure, type SelectiveClosure } from '@features/sync/selective-sync';
import { planSyncImport, type SyncPlan } from '@features/sync/sync-plan';
import { deviceIdFromBytes, isSameDevice } from '@features/sync/sync-state';
import { deviceOfFileName, folderWriteKey } from '@features/sync/sync-folder';
import { sha256Hex as blobSha256Hex } from '@adapter/platform/storage/asset-key';
import { seedFromBackup, type SyncSeed } from '@features/sync/sync-seed';
import { SYNC_FORGET_LABEL, SYNC_OFF_REFUSAL, SYNC_SETTING_LABEL } from '@features/sync/sync-setting';
import type { Baseline, Fp, KeyedState, Tombstone } from '@features/sync/change-set';
import { assetRefsIn } from '@features/asset/asset-ref-scan';
import { safeName } from '@features/export/file-name';
import { dayStamp } from '@features/datetime/date-math';
import { assetSourceSize, readAssetSource, type ReadableAssetSource } from '@features/import/zip-reader';
import type { NoticeAction } from './import-undo';
import type { ResultMap, StorageRequest, SyncUndoToken } from '@adapter/platform/storage/protocol';

type SyncOp = 'syncSnapshot' | 'syncCommitExport' | 'syncApply' | 'syncUndo' | 'syncSeed' | 'syncMeasureNotes' | 'getBodies' | 'listAssetMetas';

export interface SyncDeps {
  cid: string;
  /** いまのワークスペースの題名。 */
  title(): string;
  /** 設定「端末間の同期」。 */
  enabled(): boolean;
  request<O extends SyncOp>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  /** 飛んでいる書込が着地してから読む(書き出しは保存を追い越さない)。 */
  settle(): Promise<void>;
  getAssetBlob(key: string): Promise<Blob | null>;
  listStoredBlobKeys(): Promise<ReadonlySet<string>>;
  putBlob(key: string, blob: Blob): Promise<void>;
  putAssetMeta(meta: { key: string; mime: string; size: number; hash: string | null }): Promise<void>;
  download(name: string, blob: Blob): void;
  notify?(message: string): void;
  /** 結果の一覧(取り込み時の注意の面へ)。`conflicts` = 競合のノートを一覧する(検索する)ボタンも出す。 */
  report(notes: readonly string[], opts?: { conflicts?: boolean }): void;
  /**
   * worker への「入 / 切」の通知が済んでいることを保つ(失敗していたらやり直す。⚠ 失敗を握りつぶさない = 呼び側がメッセージへ積む)。
   * 失敗したら throw する。
   */
  ensureConfigured?(): Promise<void>;
  reportProblem?(message: string): void;
  /** 書き出しの結果の一覧(省略時は `report`)。⚠ 取り込みの結果の面と違い、取り消しの操作を載せない。 */
  reportExport?(notes: readonly string[]): void;
  /** 取り込み後の再読込。 */
  reload(): Promise<void>;
  /** 確認(`false` = やめる)。ボタンの名前を渡せる配線では渡す。 */
  confirmAction(message: string, opts?: { okLabel?: string; cancelLabel?: string }): Promise<boolean>;
  genLid(): string;
  /** 乱数 8 バイト(端末 id の作り直し)。 */
  randomBytes?(n: number): Uint8Array;
  now?(): Date;
  /** 「取り込みを取り消す」の登録(1 回分)。 */
  rememberUndo?(info: { count: number; run: () => Promise<{ restored: number; skipped: number }>; token: SyncUndoToken }): void;
  /** system 領域のメッセージ(競合の知らせ・同期の設定の失敗)。 */
  postMessage?(input: { kind: 'caution' | 'result' | 'problem'; source: string; text: string; fixedHead?: string }): void;
}

/** 取り込み結果の面に出す「競合のノートを一覧する」ボタン(受け口は binder の `show-sync-conflicts`)。 */
export const SHOW_SYNC_CONFLICTS_ACTION: NoticeAction = {
  label: '競合のノートを一覧する',
  action: 'show-sync-conflicts',
  title: '題名に「同期の競合」が付いたノートを、左の一覧に絞り込んで表示します',
};

const toBaseline = (list: Record<string, { content: string; place?: string }>): Baseline => list;

/**
 * 🔴 **選択同期(#2066 段 5-A)の閉包**。設定が `'selective'` のときだけ返す(`'all'` = `null` = 今までと同じ動き)。
 * 書き出し・取り込みの両方がここを通る(同じ問いに 2 か所で答えない)。
 */
export function selectiveClosureOf(snap: ResultMap['syncSnapshot']): SelectiveClosure | null {
  if (snap.selective.mode !== 'selective') return null;
  return resolveSelectiveClosure({
    notes: snap.notes,
    relations: snap.relations,
    bodyRefs: snap.bodyRefs,
    directLids: snap.selective.directLids,
    relatedMode: snap.selective.related,
  });
}

/**
 * 🔴 **全体のバックアップに添える種の指紋**(設計 doc §12.1 の約束 2)。⚠ 設定がオンのときだけ。書き出す**時点**の指紋(復元後の編集を含めない)。
 * 端末 id が無ければ作る(オンの端末の書き出しだけが作る。オフのときは行を 1 本も書かない)。
 */
export async function backupSyncSeed(deps: Pick<SyncDeps, 'cid' | 'enabled' | 'request' | 'ensureConfigured'>): Promise<SyncSeed | null> {
  if (!deps.enabled()) return null;
  await deps.ensureConfigured?.();
  const snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
  if (snap.device === null) return null;
  return {
    device: snap.device,
    fingerprints: snap.states.map((s) => (s.place === undefined ? { key: s.key, c: s.content } : { key: s.key, c: s.content, p: s.place })),
  };
}

/** バックアップの種を、書き出した端末の「前回の合意」として記録する(取り込み側)。⚠ 設定がオフなら何もしない。自分の id の種は捨てる。 */
export async function seedSyncFromBackup(deps: Pick<SyncDeps, 'cid' | 'enabled' | 'request' | 'now' | 'ensureConfigured'>, seed: SyncSeed, keptLids: ReadonlySet<string>): Promise<void> {
  if (!deps.enabled()) return;
  await deps.ensureConfigured?.();
  const snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
  if (snap.device === null || snap.device === seed.device) return;
  const baseline = seedFromBackup(seed, keptLids);
  if (Object.keys(baseline).length === 0) return;
  await deps.request({ op: 'syncSeed', cid: deps.cid, peer: seed.device, baseline, nowIso: (deps.now?.() ?? new Date()).toISOString() });
}

/** 差分を作る先。`download` = 手で運ぶファイル(段 2)/ `folder` = 同期フォルダの自分のファイル(段 3)。 */
export type DiffTarget =
  | { kind: 'download'; all: boolean }
  | {
      kind: 'folder';
      /** 同期フォルダに居る、自分以外の端末。 */
      others: readonly string[];
      /** 自分に「全件をください」と言っている端末。 */
      wantedBy: readonly string[];
      /** 自分が「全件をください」と言う端末(取り込んだ差分に本文が足りなかった)。 */
      want: readonly string[];
      ownFilePresent: boolean;
      /** 前回書いたときの要約(同じなら書かない)。 */
      lastKey: string | null;
    };

export interface BuiltDiff {
  skipped: false;
  blob: Blob;
  counts: { notes: number; relations: number; deletions: number; assets: number; total: number };
  missingAssets: string[];
  complete: boolean;
  /** 書いた中身の要約(次に同じなら書かない)。 */
  key: string;
  device: string;
  seq: number;
}

/**
 * 🔴 **差分ファイルを作る(転送手段に依らない核)**。ダウンロード(段 2)も同期フォルダ(段 3)もここを通る。
 * ⚠ 同期フォルダで中身が前回と同じなら、連番を進めず `skipped` を返す(定期の回で同じファイルを書き続けない)。
 * ⚠ 失敗は throw する(呼び手が言い方を決める)。
 */
export async function buildSyncDiff(deps: SyncDeps, target: DiffTarget): Promise<BuiltDiff | { skipped: true; key: string }> {
  await deps.ensureConfigured?.();
  await deps.settle();
  const snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
  if (snap.device === null) throw new Error('端末の記録を作れませんでした');
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  // 🔴 選択同期: 運ぶ集合 S と、こちらで生きている全部のキー(選択から外れただけの物を削除と取り違えない)
  const closure = selectiveClosureOf(snap);
  const selected = closure === null ? null : new Set(closure.lids);
  // 削除の記録を運んでよい物: 直接指定・どの相手との記録にも在った物・選択のフォルダの中で消した物(`scopeParents`)
  const shared = new Set(snap.selective.directLids);
  for (const b of Object.values(snap.bases)) for (const k of Object.keys(b.baseline)) shared.add(k);
  const selective: SelectiveExport | undefined =
    closure === null || selected === null
      ? undefined
      : { selectedLids: selected, allLiveKeys: new Set(snap.states.map((x) => x.key)), sharedKeys: shared, scopeParents: closure.directAndDescendant };
  let plan: { scope: 'all' | 'selective'; complete: boolean; noteLids: string[]; tombstones: Tombstone[]; fingerprints: DiffFingerprint[]; peerBase: DiffFingerprint[]; peerBases?: Record<string, DiffFingerprint[]> };
  let key: string;
  if (target.kind === 'folder') {
    // 🔴 フォルダに自分しか居ない間は、置いたファイル(最初の回の全件)をそのままにする ── 読む相手が居ないのに書き直さない。
    //   新しい端末が加わると `others` に入り、記録の無い相手が居るので次の回に全件を書き直す(古いままにはならない)
    if (target.others.length === 0 && target.ownFilePresent) return { skipped: true, key: target.lastKey ?? '' };
    const fp = planFolderExport({
      device: snap.device,
      seq: snap.seq + 1,
      states: snap.states,
      tombstones: snap.tombstones,
      bases: Object.fromEntries(Object.entries(snap.bases).map(([d, b]) => [d, { baseline: toBaseline(b.baseline), at: b.at }])),
      others: target.others,
      wantedBy: target.wantedBy,
      ownFilePresent: target.ownFilePresent,
      nowMs,
      ...(selective === undefined ? {} : { selective }),
    });
    key = folderWriteKey(fp.writeKey, target.want, snap.pairs);
    if (target.ownFilePresent && target.lastKey === key) return { skipped: true, key };
    plan = { ...fp, peerBase: [] };
  } else {
    // 相手の選び方: 記録のある相手が 1 台ならその相手との差分。2 台以上・「すべて」なら全件(どの相手にも渡せる)
    const peers = Object.entries(snap.bases);
    const peer = !target.all && peers.length === 1 ? (peers[0] as [string, { baseline: Baseline; at: string | null }])[1] : null;
    plan = planExport({
      device: snap.device,
      seq: snap.seq + 1,
      states: snap.states,
      tombstones: snap.tombstones,
      peer: peer === null ? null : { baseline: toBaseline(peer.baseline), at: peer.at },
      all: target.all,
      nowMs,
      ...(selective === undefined ? {} : { selective }),
    });
    key = '';
  }
  const committed = await deps.request({ op: 'syncCommitExport', cid: deps.cid, digest: fingerprintDigest(plan.fingerprints) });
  const metaByLid = new Map(snap.notes.map((n) => [n.lid, n] as const));
  const assetMetas = await deps.request({ op: 'listAssetMetas', cid: deps.cid });
  const assetKeys = assetMetas.map((a) => a.key);
  const carried = new Map<string, DiffAssetMeta>();
  const byKey = new Map(assetMetas.map((a) => [a.key, a] as const));
  const noteLids = plan.noteLids;
  async function* notes(): AsyncGenerator<DiffNote> {
    const BATCH = 200;
    for (let i = 0; i < noteLids.length; i += BATCH) {
      const lids = noteLids.slice(i, i + BATCH);
      const rows = await deps.request({ op: 'getBodies', cid: deps.cid, lids });
      for (const r of rows) {
        const m = metaByLid.get(r.lid);
        if (m === undefined) continue;
        for (const k of assetRefsIn(r.body, assetKeys)) {
          const a = byKey.get(k);
          if (a !== undefined && !carried.has(k)) carried.set(k, { key: k, mime: a.mime ?? 'application/octet-stream', size: a.size ?? 0, hash: a.hash });
        }
        yield { lid: r.lid, title: m.title, archetype: m.archetype, parentLid: m.parentLid, body: r.body };
      }
    }
  }
  const want = target.kind === 'folder' && target.want.length > 0 ? { want: [...target.want].sort() } : {};
  // 同期フォルダでは、確認済みの対応も添える(相手が自分の id を見つけたら、初回の確認を省ける)
  const pairs = target.kind === 'folder' && Object.keys(snap.pairs).length > 0 ? { pairs: { ...snap.pairs } } : {};
  // 🔴 選択同期: つながり(両端が S)・色ラベル・ピン留めも S の中だけ(S の外のノートの存在を 1 つも出さない)。範囲を書くとバージョン 3
  const relations = selected === null ? snap.relations : snap.relations.filter((r) => selected.has(r.from) && selected.has(r.to));
  const labels = selected === null ? snap.labels : snap.labels.filter((l) => selected.has(l.lid));
  const pins = selected === null ? snap.pins : snap.pins.filter((lid) => selected.has(lid));
  const scope = plan.scope === 'selective' ? { scope: 'selective' as const } : {};
  const out = await writeDiffZip({
    manifest: { exported_at: (deps.now?.() ?? new Date()).toISOString(), device: committed.device, seq: committed.seq, cid: deps.cid, title: deps.title(), complete: plan.complete, ...want, ...pairs, ...scope },
    notes: notes(),
    relations,
    tombstones: plan.tombstones,
    fingerprints: plan.fingerprints,
    peerBase: plan.peerBase,
    ...(plan.peerBases === undefined ? {} : { peerBases: plan.peerBases }),
    labels,
    pins,
    assets: () => [...carried.values()],
    getAssetBlob: (k) => deps.getAssetBlob(k),
  });
  return { skipped: false, blob: out.blob, counts: out.counts, missingAssets: out.missingAssets, complete: plan.complete, key, device: committed.device, seq: committed.seq };
}

/** 差分の書き出し(ダウンロード)。 */
export async function exportSyncDiff(deps: SyncDeps, opts: { all?: boolean } = {}): Promise<void> {
  const fail = (m: string): void => {
    deps.notify?.(''); // 進行中の字を残さない(失敗の回に「書き出しています…」が居座らない)
    if (deps.reportProblem) deps.reportProblem(m);
    else deps.notify?.(m);
  };
  if (!deps.enabled()) return fail(SYNC_OFF_REFUSAL);
  try {
    deps.notify?.('差分を書き出しています…');
    const out = await buildSyncDiff(deps, { kind: 'download', all: opts.all === true });
    if (out.skipped) return; // ダウンロードでは起きない(型の都合)
    deps.download(`${safeName(deps.title() || 'pkc3')}-${dayStamp(deps.now?.() ?? new Date(), '')}${DIFF_SUFFIX}`, out.blob);
    const lines = [
      `差分ファイルを書き出しました(${out.complete ? '全件' : '前回の同期から変わった分'}: ノート ${out.counts.notes} 件 / 削除の記録 ${out.counts.deletions} 件 / 添付 ${out.counts.assets} 件)`,
    ];
    if (out.missingAssets.length > 0) lines.push(`添付の実体が見つからず、入れられなかった物が ${out.missingAssets.length} 件あります(参照は残っています)`);
    if (!out.complete) lines.push('初めての端末や、前回から日が空いた端末には「差分を書き出す(全件)」で書き出してください');
    deps.notify?.(lines[0] as string);
    if (lines.length > 1) (deps.reportExport ?? deps.report)(lines);
  } catch (e) {
    fail(`差分を書き出せませんでした: ${errorText(e)}`);
  }
}

/** 本文が参照する添付の key(`asset:<key>`)。 */
function referencedAssets(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/asset:([A-Za-z0-9_.-]+)/g)) out.add(m[1] as string);
  return [...out];
}

const pad = (n: number): string => String(n).padStart(2, '0');
function dateOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 書き出した日時(端末の時刻で `YYYY-MM-DD HH:mm`)。読めなければ空。 */
export function exportStamp(iso: string): string {
  const t = new Date(iso);
  if (iso === '' || Number.isNaN(t.getTime())) return '';
  return `${dateOf(t)} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** 画面に出す相手の呼び方(端末 id の先頭 4 文字)。 */
export const peerLabel = (device: string): string => `相手の端末(${device.slice(0, 4)})`;

/** 競合したノートの直し方(取り込み結果・メッセージ・マニュアルで同じ文を使う)。 */
export const CONFLICT_HOWTO =
  '競合したノートは、題名に「同期の競合」が付いた別のノートとして残っています。見比べて、不要な方をゴミ箱へ移し、残す方の題名から「(同期の競合 日付)」の部分を消してください';

/** 取り消しの限界(取り込み結果の最後の行)。 */
export const UNDO_LIMIT_LINE = '取り消せるのは最新の取り込み 1 回分だけで、画面を再読み込みするまでです。取り込み後に編集したノートは、取り消してもそのままにします';

/** 結果の一覧を、画面に出す文にする(取り込み結果の面へ)。 */
export function summaryLines(
  plan: SyncPlan,
  file: Pick<DiffFile, 'manifest' | 'dropped'>,
  extra: {
    missingAssets: string[];
    placedAtRoot: number;
    regenerated: boolean;
    /** 内容が添付の一覧の hash と合わず、取り込まなかった添付。 */
    badAssets: string[];
    /** 計画の後・反映の前にこちらで編集されていた物。 */
    raced: ReadonlyArray<{ lid: string; title: string; copyLid?: string; copyTitle?: string; trash?: boolean }>;
    warnings: readonly string[];
    undoable: boolean;
  },
): string[] {
  const s = plan.summary;
  const when = exportStamp(file.manifest.exported_at);
  const out: string[] = [`差分ファイルを取り込みました(${peerLabel(file.manifest.device)}「${file.manifest.title}」${when === '' ? '' : `、書き出し ${when}`})`];
  const add = (n: number, text: string): void => {
    if (n > 0) out.push(text.replace('{n}', String(n)));
  };
  const racedCopies = extra.raced.filter((x) => x.copyLid !== undefined);
  add(s.created, '新しく入ったノート: {n} 件');
  add(s.updated, '相手の版に置き換えたノート: {n} 件(前の本文は履歴に残っています)');
  add(s.merged, '移動と編集を合わせたノート: {n} 件');
  add(s.restored, 'ゴミ箱から戻したノート: {n} 件(相手で編集されていたため)');
  add(s.trashed, '相手で消えたのでゴミ箱へ移したノート: {n} 件(ゴミ箱から戻せます)');
  add(s.keptLocal, 'こちらの版を残したノート: {n} 件(次に「差分を書き出す」と相手へ送られます)');
  add(s.firstSync, '初回の同期で内容が違った物: {n} 件(両方にあって内容が違う物。こちらを残し、相手の版を別のノートとして足しました)');
  add(s.conflicts - s.firstSync, '競合: {n} 件(両方で変えた物。こちらを残し、相手の版を別のノートとして足しました)');
  add(racedCopies.length, '取り込む直前にこちらで編集されたノート: {n} 件(こちらを残し、相手の版を別のノートとして足しました)');
  add(extra.raced.filter((x) => x.copyLid === undefined).length, '取り込む直前にこちらで編集されたため、反映しなかったノート: {n} 件(こちらの版を残しています)');
  add(s.relationsAdded, '足したつながり: {n} 本');
  add(s.relationsRemoved, '外したつながり: {n} 本');
  add(extra.placedAtRoot + s.orphans, '入れるフォルダが無く、いちばん上へ置いたノート: {n} 件');
  add(s.danglingRelations, 'つなぐ先のノートが無く、足さなかったつながり: {n} 本');
  add(s.labelsChanged, '相手に合わせた色ラベル: {n} 件');
  add(s.pinsChanged, '相手に合わせたピン留め: {n} 件');
  add(s.attrConflicts, '両方で違う色ラベル・ピン留めにしていた物: {n} 件(こちらの色ラベル・ピン留めを残しました。次の同期で相手へ送ります)');
  add(
    s.skippedUnselected,
    'この端末で同期の対象に選んでいないため、相手からの変更を反映しなかった物: {n} 件(対象外のノートと、その色ラベル・ピン留め・つながり。こちらのノートはそのままです)',
  );
  for (const c of plan.conflicts) {
    const what =
      c.kind === 'first-sync'
        ? '初回の同期で内容が違う'
        : c.kind === 'both-edited'
          ? '両方で編集'
          : c.kind === 'deleted-here-edited-there'
            ? 'こちらで消したが相手で編集'
            : '相手で消したがこちらで編集';
    out.push(`  ・${what}: 「${c.title}」${c.copyTitle === undefined ? '' : ` → 別のノート「${c.copyTitle}」`}`);
  }
  for (const x of racedCopies) out.push(`  ・取り込む直前に編集: 「${x.title}」 → 別のノート「${x.copyTitle ?? ''}」`);
  if (plan.conflicts.length + racedCopies.length > 0) out.push(CONFLICT_HOWTO);
  if (plan.needFull.length > 0) {
    out.push(`本文が差分に入っていなくて取り込めなかったノート: ${plan.needFull.length} 件。相手の端末で「差分を書き出す(全件)」を選んで書き出し直してください`);
    for (const t of plan.needFull.slice(0, 20)) out.push(`  ・「${t}」`);
  }
  if (extra.missingAssets.length > 0) {
    out.push(`足りない添付: ${extra.missingAssets.length} 件(ノートの参照は残しています。相手の端末で書き出し直すと入ります)`);
    for (const t of extra.missingAssets.slice(0, 20)) out.push(`  ・${t}`);
  }
  if (extra.badAssets.length > 0) {
    out.push(`内容が差分ファイルの添付の一覧(hash)と合わず、取り込まなかった添付: ${extra.badAssets.length} 件(ファイルが読めない状態か、書き換えられた可能性があります。参照は残しています)`);
    for (const t of extra.badAssets.slice(0, 20)) out.push(`  ・${t}`);
  }
  if (file.dropped.reserved > 0) out.push(`アプリ自身のノート(システム領域)を指す行が ${file.dropped.reserved} 件あったので、取り込みませんでした`);
  if (file.dropped.relations > 0) out.push(`取り込めない種類のつながりが ${file.dropped.relations} 本あったので、足しませんでした(フォルダの親子は、ノートの置き場所として別に取り込みます)`);
  if (extra.regenerated) out.push('この端末の記録が別の端末と重なっていたため、端末の ID を作り直しました。同期の記録は最初からになります');
  out.push(...extra.warnings);
  // ⚠ 最後の行は取り消しの限界(取り消せる回だけ)
  if (extra.undoable) out.push(UNDO_LIMIT_LINE);
  return out;
}

/** 相手のノートの指紋を worker で測る(本文を主スレッドで SHA-256 しない)。 */
async function measureRemoteNotes(deps: SyncDeps, notes: readonly DiffNote[]): Promise<Map<string, Fp>> {
  const out = new Map<string, Fp>();
  const BATCH = 200;
  for (let i = 0; i < notes.length; i += BATCH) {
    const rows = await deps.request({ op: 'syncMeasureNotes', notes: notes.slice(i, i + BATCH).map((n) => ({ lid: n.lid, title: n.title, archetype: n.archetype, parentLid: n.parentLid, body: n.body })) });
    for (const r of rows) out.set(r.lid, { content: r.content, place: r.place });
  }
  return out;
}

/** 差分の取り込み。⚠ 呼ぶのは `import-pkc2.ts`(manifest.format が `pkc3-diff` のとき)。 */
export async function importSyncDiff(deps: SyncDeps, file: File | Blob, name: string): Promise<{ ok: boolean; count: number }> {
  const fail = (m: string): { ok: false; count: 0 } => {
    deps.notify?.(''); // 進行中の字を残さない
    (deps.reportProblem ?? deps.notify)?.(m);
    return { ok: false, count: 0 };
  };
  if (!deps.enabled()) return fail(SYNC_OFF_REFUSAL);
  let diff: DiffFile;
  try {
    deps.notify?.('取り込み中…(差分ファイルを読んでいます)');
    diff = await readDiffZip(file);
  } catch (e) {
    return fail(`「${name}」: ${errorText(e)}`);
  }
  const r = await applySyncDiff(deps, diff, name);
  return { ok: r.ok, count: r.count };
}

/** 取り込みの結果(同期フォルダが次の回の振る舞いを決めるのに使う)。 */
export interface ApplyOutcome {
  ok: boolean;
  count: number;
  /**
   * 無人の回(`auto`)で、人の確認が要るので取り込まなかった理由。`pair` = 初めての相手(ワークスペースの対応)/
   * `device` = 自分の端末 id のファイルが自分の記録に無い(端末のデータの複製)。手で同期すると確認を出す。
   */
  pending?: 'pair' | 'device';
  /** 手で同期した回で、確認に「やめる」と答えた(取り込んでいない ── 取り込んだことにしない)。 */
  declined?: boolean;
  /** 取り込めなかった理由(`ok: false`)。⚠ 無人の回は自分では言わず、ここで返す(呼び手が同じ理由を繰り返さないように束ねる)。 */
  reason?: string;
  /** 本文が入っていなくて取り込めなかったノートがある(相手に全件を頼む)。 */
  needFull: boolean;
  /** 反映した件数(ノート・印)と競合の数。 */
  changed: number;
  conflicts: number;
}

/**
 * 🔴 **読んだ差分ファイルを取り込む(転送手段に依らない核)**。手で選んだファイル(段 2)も同期フォルダ(段 3)もここを通る。
 * `auto`(同期フォルダの定期の回)では**確認を出さない** ── 確認が要る物(初めての相手・端末 id の重複)は取り込まずに `pending` を返し、
 * 結果の面も「何か変わった・注意がある」ときだけ出す(何も変わらない回に面を出さない)。
 */
export async function applySyncDiff(
  deps: SyncDeps,
  diff: DiffFile,
  name: string,
  /**
   * `auto` = 無人の回。`folder` = 同期フォルダから読んだ(user が選んだフォルダの中のファイル)──
   * このときだけ、相手のファイルが言う「確認済みの対応」(`manifest.pairs`)で初回の確認を省く。手で選んだファイルでは省かない。
   */
  opts: { auto?: boolean; folder?: boolean } = {},
): Promise<ApplyOutcome> {
  const auto = opts.auto === true;
  const fail = (m: string): ApplyOutcome => {
    deps.notify?.(''); // 進行中の字を残さない
    // 🔴 無人の回は言わない(5 分ごとに同じ問題をメッセージへ積まない)── 理由を返し、同期フォルダの係が 1 度だけ言う
    if (!auto) (deps.reportProblem ?? deps.notify)?.(m);
    return { ok: false, count: 0, needFull: false, changed: 0, conflicts: 0, reason: m };
  };
  const quiet = (extra: Partial<ApplyOutcome> = {}): ApplyOutcome => ({ ok: true, count: 0, needFull: false, changed: 0, conflicts: 0, ...extra });
  if (!deps.enabled()) return fail(SYNC_OFF_REFUSAL);
  // 🔴 同期フォルダのファイルは、名前の端末 id と中身の端末 id が同じでなければ読まない(名前で「誰のファイルか」を決めているため)
  if (opts.folder === true && deviceOfFileName(name) !== diff.manifest.device) {
    return fail(`「${name}」は、ファイル名と中身の端末が違うため取り込みませんでした(名前を変えたファイルか、別の端末のファイルをコピーした可能性があります)`);
  }
  let committed = false;
  try {
    await deps.ensureConfigured?.();
    await deps.settle();
    const snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
    if (snap.device === null) return fail('端末の記録を作れませんでした');
    const peerDevice = diff.manifest.device;
    const from = `${peerLabel(peerDevice)}、${exportStamp(diff.manifest.exported_at) || '書き出しの日時は不明'}`;
    // ── 端末 id の重複(約束 4)
    let regenerate: string | undefined;
    if (isSameDevice(snap.device, peerDevice)) {
      // 🔴 自分の差分を、別のワークスペースへ取り込もうとしている(複製ではない)── 記録を巻き込まないよう断る
      if (diff.manifest.cid !== deps.cid) {
        return fail(
          `この差分ファイルは、この端末の別のワークスペース「${diff.manifest.title}」から書き出した物です(書き出した端末が同じ)。このワークスペースへは取り込めません。` +
            `別の端末のファイルを取り込んでください。端末の記録を最初からにしたいときは、設定の「${SYNC_SETTING_LABEL}」の「${SYNC_FORGET_LABEL}」を使います`,
        );
      }
      const mine = snap.outs[diff.manifest.seq];
      if (mine !== undefined && mine === fingerprintDigest(diff.container.fingerprints)) {
        deps.notify?.('この端末が書き出した差分ファイルです。取り込む物はありません');
        return quiet();
      }
      // 無人の回は確認を出さない(作り直しは同期の記録を全部消すので、人が見ているときだけ)
      if (auto) return quiet({ pending: 'device' });
      // 🔴 自分の記録に無い(古い・端末のデータの複製)── 端末 ID の作り直しは同期の記録を全部消すので、専用の確認を取る
      const ok = await deps.confirmAction(
        'この差分ファイルは、この端末が書き出した物に見えますが、この端末の記録にはありません(記録が古くなったか、端末のデータを複製した可能性があります)。' +
          '続けると、この端末の ID を作り直し、すべての同期の記録(相手との対応・前回の同期の記録)を最初からにします。作り直して取り込みますか?',
        { okLabel: '作り直して取り込む', cancelLabel: 'やめる' },
      );
      if (!ok) {
        deps.notify?.('取り込みをやめました');
        return quiet({ declined: true });
      }
      regenerate = deviceIdFromBytes((deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(8));
    }
    // 作り直す端末は、同期の記録を捨てて始める(相手との対応も含む)
    const knownPeerCid = regenerate === undefined ? snap.pairs[peerDevice] : undefined;
    // ── ワークスペースの対応(約束 1)。対応が無いまま取り込まない
    if (knownPeerCid !== undefined && knownPeerCid !== diff.manifest.cid) {
      return fail(
        `${peerLabel(peerDevice)}の、別のワークスペースと対応づけてあるため、この差分ファイル(元のワークスペース「${diff.manifest.title}」)は取り込めません。` +
          `対応づけを最初からにするには、設定の「${SYNC_SETTING_LABEL}」の「${SYNC_FORGET_LABEL}」を押してください(ノートは消えません)`,
      );
    }
    // 🔴 無人の回で初めての相手: 相手の側で、この端末のこのワークスペースとの対応を人が確認済みなら、そのまま取り込む(確認は 1 度で済む)
    const confirmedThere = opts.folder === true && diff.manifest.pairs?.[snap.device] === deps.cid;
    if (knownPeerCid === undefined && auto && !confirmedThere) return quiet({ pending: 'pair' });
    if (knownPeerCid === undefined && !confirmedThere) {
      const same = diff.manifest.title === deps.title();
      const msg =
        `相手の端末のワークスペース「${diff.manifest.title}」を、このワークスペース「${deps.title()}」と同じ物として取り込みますか?(次からは確認しません)` +
        (same ? '' : '\n題名が違います。別のワークスペースへ取り込むときは、いったんやめて、先に切り替えるか新しく作ってから取り込んでください。') +
        `\n(${from})`;
      if (!(await deps.confirmAction(msg, { okLabel: '同じ物として取り込む', cancelLabel: 'やめる' }))) {
        deps.notify?.('取り込みをやめました');
        return quiet({ declined: true });
      }
    }
    const baseline = regenerate === undefined ? toBaseline(snap.bases[peerDevice]?.baseline ?? {}) : {};
    const localStates: KeyedState[] = snap.states.map((s) => ({ key: s.key, content: s.content, ...(s.place === undefined ? {} : { place: s.place }) }));
    const now = deps.now?.() ?? new Date();
    // 🔴 本文の指紋は worker で測る(主スレッドで SHA-256 しない)
    const remoteNoteFps = await measureRemoteNotes(deps, diff.container.notes);
    // 🔴 1 つのファイルを複数の相手が読む形(同期フォルダ)では、自分宛ての記録を使う(競合の連鎖を止める `peerBase`)
    const mineBase = diff.container.peerBases?.[snap.device];
    const remote = mineBase === undefined ? diff : { ...diff, container: { ...diff.container, peerBase: mineBase } };
    // 🔴 こちらが選択同期: 対象の外のノートへの相手の変更・削除を反映しない / 新しく入るノートを直接指定へ足す
    const localClosure = selectiveClosureOf(snap);
    const plan = planSyncImport({
      remote,
      remoteNoteFps,
      localStates,
      localRelations: snap.relations,
      localTitles: new Map(snap.notes.map((n) => [n.lid, n.title] as const)),
      localTombstones: snap.tombstones,
      baseline,
      date: dateOf(now),
      genLid: deps.genLid,
      ...(localClosure === null ? {} : { localSelective: { selectedLids: new Set(localClosure.lids), directAndDescendantLids: localClosure.directAndDescendant } }),
    });

    // ── 反映(1 つの tx)。⚠ 添付の実体は**反映のあとに**書く(失敗したら何も書かれていない = 言葉どおり)
    const applied = await deps.request({
      op: 'syncApply',
      cid: deps.cid,
      input: {
        peer: peerDevice,
        peerCid: diff.manifest.cid,
        peerSeq: diff.manifest.seq,
        ...(regenerate === undefined ? {} : { regenerateDevice: regenerate }),
        upserts: plan.upserts.map((u) => ({
          lid: u.lid,
          ...(u.content === undefined ? {} : { content: u.content }),
          ...(u.place === undefined ? {} : { place: u.place }),
          ...(u.expect === undefined ? {} : { expect: u.expect }),
          ...(u.fallback === undefined ? {} : { fallback: u.fallback }),
        })),
        trash: plan.trash,
        trashExpect: plan.trashExpect,
        relationAdds: plan.relationAdds,
        relationRemoves: plan.relationRemoves,
        labelSets: plan.labelSets,
        pinSets: plan.pinSets,
        ...(plan.selectiveSelectAdds.length === 0 ? {} : { selectiveSelectAdds: plan.selectiveSelectAdds }),
        baseline: plan.baseline,
        nowIso: now.toISOString(),
      },
    });
    committed = true;

    // ── 添付(参照されている物だけ)と、足りない添付・内容が合わない添付の一覧
    const stored = await deps.listStoredBlobKeys();
    const available = new Map<string, ReadableAssetSource>(diff.assetSources);
    const metaByKey = new Map<string, DiffAssetMeta>(diff.container.assets.map((a) => [a.key, a] as const));
    const missing: string[] = [];
    const bad: string[] = [];
    const done = new Set<string>();
    for (const u of plan.upserts) {
      if (u.content === undefined) continue;
      for (const key of referencedAssets(u.content.body)) {
        if (stored.has(key) || done.has(key)) continue;
        const label = `「${u.content.title || '(無題)'}」の添付`;
        const src = available.get(key);
        if (src === undefined) {
          missing.push(label);
          continue;
        }
        done.add(key);
        try {
          const blob = await readAssetSource(src);
          const meta = metaByKey.get(key);
          // 🔴 添付の一覧の hash と内容が合うか(合わなければ置かない。内容が違う添付を、正しい key の下へ入れない)
          if (meta?.hash != null && (await blobSha256Hex(blob)) !== meta.hash) {
            bad.push(label);
            continue;
          }
          // 🔴 hash を持たない添付(大きくて hash を取らなかった物)は、大きさだけでも合わせる(#2000 段 4a-1 のついで。user 指摘)
          //   ── 途中で切れた・取り違えた添付を、正しい key の下へ黙って入れない
          //   ⚠ 大きさが 0 の目録は照合しない(読む側は欠けた大きさを 0 で埋める ── 0 と比べると正しい添付を落とす)
          if (meta?.hash == null && typeof meta?.size === 'number' && meta.size > 0 && blob.size !== meta.size) {
            bad.push(label);
            continue;
          }
          await deps.putBlob(key, blob);
          await deps.putAssetMeta({ key, mime: meta?.mime ?? 'application/octet-stream', size: meta?.size ?? assetSourceSize(src), hash: meta?.hash ?? null });
        } catch {
          missing.push(`${label}(読み込めませんでした)`);
        }
        available.delete(key); // 引くと同時に手放す(zip の参照を最後まで持たない)
      }
    }

    await deps.reload();
    const token: SyncUndoToken = applied.undo;
    // 🔴 無人の回(`auto`)は「取り込みを取り消す」を登録しない ── 登録は 1 回分なので、直前に人が手で取り込んだ回の取り消しを奪ってしまう
    const undoable = !auto && (token.entries.length > 0 || token.relationsAdded.length > 0 || token.relationsRemoved.length > 0 || (token.attrs?.length ?? 0) > 0);
    if (undoable) {
      deps.rememberUndo?.({
        count: token.entries.length,
        token,
        run: async () => {
          const r = await deps.request({ op: 'syncUndo', cid: deps.cid, token });
          await deps.reload();
          return r;
        },
      });
    }
    const lines = summaryLines(plan, diff, {
      missingAssets: missing,
      placedAtRoot: applied.placedAtRoot,
      regenerated: regenerate !== undefined,
      badAssets: bad,
      raced: applied.raced,
      warnings: diff.warnings,
      undoable,
    });
    const conflictCount = plan.conflicts.length + applied.raced.filter((x) => x.copyLid !== undefined).length;
    const changed = applied.written + applied.trashed + applied.relationsAdded + applied.relationsRemoved + applied.labelsChanged + applied.pinsChanged;
    const worthReport = changed > 0 || conflictCount > 0 || plan.needFull.length > 0 || missing.length > 0 || bad.length > 0 || plan.summary.attrConflicts > 0 || regenerate !== undefined;
    // 無人の回は、何も変わらず注意も無ければ面を出さない(5 分ごとに空の結果を出さない)
    if (!auto || worthReport) deps.report(lines, { conflicts: conflictCount > 0 });
    if (conflictCount > 0) {
      const text = `端末間の同期で競合したノートが ${conflictCount} 件あります。${CONFLICT_HOWTO}。一覧は、ノートの検索で「同期の競合」を探すと出せます(取り込み結果の「競合のノートを一覧する」ボタンでも探せます)`;
      deps.postMessage?.({ kind: 'caution', source: 'sync', text, fixedHead: text });
    }
    deps.notify?.(`差分を取り込みました(${plan.summary.created + plan.summary.updated + plan.summary.merged + plan.summary.restored + plan.summary.trashed} 件を反映、競合 ${conflictCount} 件)`);
    return { ok: true, count: applied.written + applied.trashed, needFull: plan.needFull.length > 0, changed, conflicts: conflictCount };
  } catch (e) {
    return fail(
      committed
        ? `「${name}」の取り込みは反映済みですが、後の処理で失敗しました(画面を再読み込みしてください): ${errorText(e)}`
        : `「${name}」を取り込めませんでした(何も書き込んでいません): ${errorText(e)}`,
    );
  }
}
