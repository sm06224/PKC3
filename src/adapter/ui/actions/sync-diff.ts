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
import { readDiffZip, writeDiffZip, DIFF_SUFFIX, type DiffAssetMeta, type DiffFile, type DiffNote } from '@features/sync/diff-file';
import { fingerprintDigest, planExport } from '@features/sync/sync-export';
import { planSyncImport, type SyncPlan } from '@features/sync/sync-plan';
import { deviceIdFromBytes, isSameDevice } from '@features/sync/sync-state';
import { seedFromBackup, type SyncSeed } from '@features/sync/sync-seed';
import { SYNC_OFF_REFUSAL } from '@features/sync/sync-setting';
import type { Baseline, KeyedState } from '@features/sync/change-set';
import { assetRefsIn } from '@features/asset/asset-ref-scan';
import { safeName } from '@features/export/file-name';
import { dayStamp } from '@features/datetime/date-math';
import { assetSourceSize, readAssetSource, type ReadableAssetSource } from '@features/import/zip-reader';
import type { ResultMap, StorageRequest, SyncUndoToken } from '@adapter/platform/storage/protocol';

type SyncOp = 'syncSnapshot' | 'syncCommitExport' | 'syncApply' | 'syncUndo' | 'syncSeed' | 'getBodies' | 'listAssetMetas';

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
  /** 結果の一覧(取り込み時の注意の面へ)。 */
  report(notes: readonly string[]): void;
  reportProblem?(message: string): void;
  /** 書き出しの結果の一覧(省略時は `report`)。⚠ 取り込みの結果の面と違い、取り消しの操作を載せない。 */
  reportExport?(notes: readonly string[]): void;
  /** 取り込み後の再読込。 */
  reload(): Promise<void>;
  /** 確認(`false` = やめる)。 */
  confirmAction(message: string): Promise<boolean>;
  genLid(): string;
  /** 乱数 8 バイト(端末 id の作り直し)。 */
  randomBytes?(n: number): Uint8Array;
  now?(): Date;
  /** 「取り込みを取り消す」の登録(1 回分)。 */
  rememberUndo?(info: { count: number; run: () => Promise<{ restored: number; skipped: number }> }): void;
  /** system 領域のメッセージ(競合の知らせ)。 */
  postMessage?(input: { kind: 'caution' | 'result'; source: string; text: string; fixedHead?: string }): void;
}

const toBaseline = (list: Record<string, { content: string; place?: string }>): Baseline => list;

/**
 * 🔴 **全体のバックアップに添える種の指紋**(設計 doc §12.1 の約束 2)。⚠ 設定がオンのときだけ。書き出す**時点**の指紋(復元後の編集を含めない)。
 * 端末 id が無ければ作る(オンの端末の書き出しだけが作る。オフのときは行を 1 本も書かない)。
 */
export async function backupSyncSeed(deps: Pick<SyncDeps, 'cid' | 'enabled' | 'request'>): Promise<SyncSeed | null> {
  if (!deps.enabled()) return null;
  const snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
  if (snap.device === null) return null;
  return {
    device: snap.device,
    fingerprints: snap.states.map((s) => (s.place === undefined ? { key: s.key, c: s.content } : { key: s.key, c: s.content, p: s.place })),
  };
}

/** バックアップの種を、書き出した端末の「前回の合意」として記録する(取り込み側)。⚠ 設定がオフなら何もしない。自分の id の種は捨てる。 */
export async function seedSyncFromBackup(deps: Pick<SyncDeps, 'cid' | 'enabled' | 'request' | 'now'>, seed: SyncSeed, keptLids: ReadonlySet<string>): Promise<void> {
  if (!deps.enabled()) return;
  const snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
  if (snap.device === null || snap.device === seed.device) return;
  const baseline = seedFromBackup(seed, keptLids);
  if (Object.keys(baseline).length === 0) return;
  await deps.request({ op: 'syncSeed', cid: deps.cid, peer: seed.device, baseline, nowIso: (deps.now?.() ?? new Date()).toISOString() });
}

/** 差分の書き出し。 */
export async function exportSyncDiff(deps: SyncDeps, opts: { all?: boolean } = {}): Promise<void> {
  const fail = (m: string): void => {
    deps.notify?.(''); // 進行中の字を残さない(失敗の回に「書き出しています…」が居座らない)
    if (deps.reportProblem) deps.reportProblem(m);
    else deps.notify?.(m);
  };
  if (!deps.enabled()) return fail(SYNC_OFF_REFUSAL);
  try {
    deps.notify?.('差分を書き出しています…');
    await deps.settle();
    const snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
    if (snap.device === null) throw new Error('端末の記録を作れませんでした');
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    // 相手の選び方: 記録のある相手が 1 台ならその相手との差分。2 台以上・「すべて」なら全件(どの相手にも渡せる)
    const peers = Object.entries(snap.bases);
    const peer = !opts.all && peers.length === 1 ? (peers[0] as [string, { baseline: Baseline; at: string | null }])[1] : null;
    const plan = planExport({
      device: snap.device,
      seq: snap.seq + 1,
      states: snap.states,
      tombstones: snap.tombstones,
      peer: peer === null ? null : { baseline: toBaseline(peer.baseline), at: peer.at },
      all: opts.all === true,
      nowMs,
    });
    const committed = await deps.request({ op: 'syncCommitExport', cid: deps.cid, digest: fingerprintDigest(plan.fingerprints) });
    const metaByLid = new Map(snap.notes.map((n) => [n.lid, n] as const));
    const assetMetas = await deps.request({ op: 'listAssetMetas', cid: deps.cid });
    const assetKeys = assetMetas.map((a) => a.key);
    const carried = new Map<string, DiffAssetMeta>();
    const byKey = new Map(assetMetas.map((a) => [a.key, a] as const));
    async function* notes(): AsyncGenerator<DiffNote> {
      const BATCH = 200;
      for (let i = 0; i < plan.noteLids.length; i += BATCH) {
        const lids = plan.noteLids.slice(i, i + BATCH);
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
    const out = await writeDiffZip({
      manifest: { exported_at: (deps.now?.() ?? new Date()).toISOString(), device: committed.device, seq: committed.seq, cid: deps.cid, title: deps.title(), complete: plan.complete },
      notes: notes(),
      relations: snap.relations,
      tombstones: plan.tombstones,
      fingerprints: plan.fingerprints,
      peerBase: plan.peerBase,
      assets: () => [...carried.values()],
      getAssetBlob: (k) => deps.getAssetBlob(k),
    });
    deps.download(`${safeName(deps.title() || 'pkc3')}-${dayStamp(deps.now?.() ?? new Date(), '')}${DIFF_SUFFIX}`, out.blob);
    const lines = [
      `差分ファイルを書き出しました(${plan.complete ? '全件' : '前回の同期から変わった分'}: ノート ${out.counts.notes} 件 / 削除の記録 ${out.counts.deletions} 件 / 添付 ${out.counts.assets} 件)`,
    ];
    if (out.missingAssets.length > 0) lines.push(`添付の実体が見つからず、入れられなかった物が ${out.missingAssets.length} 件あります(参照は残っています)`);
    if (!plan.complete) lines.push('初めての端末や、前回から日が空いた端末には「差分を書き出す(全件)」で書き出してください');
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

/** 結果の一覧を、画面に出す文にする(取り込み結果の面へ)。 */
export function summaryLines(plan: SyncPlan, file: Pick<DiffFile, 'manifest'>, extra: { missingAssets: string[]; placedAtRoot: number; regenerated: boolean; skippedAssets: number }): string[] {
  const s = plan.summary;
  const out: string[] = [`差分ファイルを取り込みました(相手の端末 ${file.manifest.device.slice(0, 4)}…「${file.manifest.title}」)`];
  const add = (n: number, text: string): void => {
    if (n > 0) out.push(text.replace('{n}', String(n)));
  };
  add(s.created, '新しく入ったノート: {n} 件');
  add(s.updated, '相手の版に置き換えたノート: {n} 件(前の本文は履歴に残っています)');
  add(s.merged, '移動と編集を合わせたノート: {n} 件');
  add(s.restored, 'ゴミ箱から戻したノート: {n} 件(相手で編集されていたため)');
  add(s.trashed, '相手で消えたのでゴミ箱へ移したノート: {n} 件(ゴミ箱から戻せます)');
  add(s.keptLocal, 'こちらの版を残したノート: {n} 件(次に「差分を書き出す」と相手へ送られます)');
  add(s.firstSync, '初回の突き合わせ: {n} 件(両方にあって内容が違う物。こちらを残し、相手の版を別のノートとして足しました)');
  add(s.conflicts - s.firstSync, '競合: {n} 件(両方で変えた物。こちらを残し、相手の版を別のノートとして足しました)');
  add(s.relationsAdded, '足したつながり: {n} 本');
  add(s.relationsRemoved, '外したつながり: {n} 本');
  add(extra.placedAtRoot + s.orphans, '入れるフォルダが無く、いちばん上へ置いたノート: {n} 件');
  add(s.danglingRelations, 'つなぐ先のノートが無く、足さなかったつながり: {n} 本');
  for (const c of plan.conflicts) {
    const what =
      c.kind === 'first-sync'
        ? '初回の突き合わせ'
        : c.kind === 'both-edited'
          ? '両方で編集'
          : c.kind === 'deleted-here-edited-there'
            ? 'こちらで消したが相手で編集'
            : '相手で消したがこちらで編集';
    out.push(`  ・${what}: 「${c.title}」${c.copyTitle === undefined ? '' : ` → 別のノート「${c.copyTitle}」`}`);
  }
  if (plan.needFull.length > 0) {
    out.push(`本文が差分に入っていなくて取り込めなかったノート: ${plan.needFull.length} 件。相手の端末で「差分を書き出す(全件)」を選んで書き出し直してください`);
    for (const t of plan.needFull.slice(0, 20)) out.push(`  ・「${t}」`);
  }
  if (extra.missingAssets.length > 0) {
    out.push(`足りない添付: ${extra.missingAssets.length} 件(ノートの参照は残しています。相手の端末で書き出し直すと入ります)`);
    for (const t of extra.missingAssets.slice(0, 20)) out.push(`  ・${t}`);
  }
  if (extra.regenerated) out.push('この端末の記録が別の端末と重なっていたため、端末の ID を作り直しました。同期の記録は最初からになります');
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
  try {
    await deps.settle();
    const snap = await deps.request({ op: 'syncSnapshot', cid: deps.cid, ensureDevice: true });
    if (snap.device === null) return fail('端末の記録を作れませんでした');
    // ── 端末 id の重複(約束 4)
    let regenerate: string | undefined;
    if (isSameDevice(snap.device, diff.manifest.device)) {
      const mine = snap.outs[diff.manifest.seq];
      if (mine !== undefined && mine === fingerprintDigest(diff.container.fingerprints)) {
        deps.notify?.('この端末が書き出した差分ファイルです。取り込む物はありません');
        return { ok: true, count: 0 };
      }
      regenerate = deviceIdFromBytes((deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(8));
    }
    const peerDevice = diff.manifest.device;
    // 作り直す端末は、同期の記録を捨てて始める(相手との対応も含む)
    const knownPeerCid = regenerate === undefined ? snap.pairs[peerDevice] : undefined;
    // ── ワークスペースの対応(約束 1)。対応が無いまま取り込まない
    if (knownPeerCid !== undefined && knownPeerCid !== diff.manifest.cid) {
      return fail('この端末は、この相手の別のワークスペースと対応づけてあります。差分ファイルの元のワークスペースが違うので取り込みません');
    }
    if (knownPeerCid === undefined) {
      const same = diff.manifest.title === deps.title();
      const msg =
        `差分ファイルの元のワークスペース「${diff.manifest.title}」を、いまのワークスペース「${deps.title()}」と同じ物として取り込みます。` +
        (same ? '題名が同じです。' : '題名が違います。別のワークスペースへ取り込むときは、先に切り替えるか、新しく作ってから取り込んでください。') +
        '(次からは確認しません)';
      if (!(await deps.confirmAction(msg))) {
        deps.notify?.('取り込みをやめました');
        return { ok: true, count: 0 };
      }
    }
    const baseline = regenerate === undefined ? toBaseline(snap.bases[peerDevice]?.baseline ?? {}) : {};
    const localStates: KeyedState[] = snap.states.map((s) => ({ key: s.key, content: s.content, ...(s.place === undefined ? {} : { place: s.place }) }));
    const now = deps.now?.() ?? new Date();
    const plan = planSyncImport({
      remote: diff,
      localStates,
      localRelations: snap.relations,
      localTitles: new Map(snap.notes.map((n) => [n.lid, n.title] as const)),
      localTombstones: snap.tombstones,
      baseline,
      date: dateOf(now),
      genLid: deps.genLid,
    });

    // ── 添付(参照されている物だけ。先に書く)と、足りない添付の一覧
    const stored = await deps.listStoredBlobKeys();
    const available = new Map<string, ReadableAssetSource>(diff.assetSources);
    const metaByKey = new Map<string, DiffAssetMeta>(diff.container.assets.map((a) => [a.key, a] as const));
    const missing: string[] = [];
    const wrote = new Set<string>();
    for (const u of plan.upserts) {
      if (u.content === undefined) continue;
      for (const key of referencedAssets(u.content.body)) {
        if (stored.has(key) || wrote.has(key)) continue;
        const src = available.get(key);
        if (src === undefined) {
          missing.push(`「${u.content.title || '(無題)'}」の添付`);
          continue;
        }
        try {
          const blob = await readAssetSource(src);
          const meta = metaByKey.get(key);
          await deps.putBlob(key, blob);
          await deps.putAssetMeta({ key, mime: meta?.mime ?? 'application/octet-stream', size: meta?.size ?? assetSourceSize(src), hash: meta?.hash ?? null });
          wrote.add(key);
        } catch {
          missing.push(`「${u.content.title || '(無題)'}」の添付(読み込めませんでした)`);
        }
        available.delete(key); // 引くと同時に手放す(zip の参照を最後まで持たない)
      }
    }

    // ── 反映(1 つの tx)
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
        })),
        trash: plan.trash,
        relationAdds: plan.relationAdds,
        relationRemoves: plan.relationRemoves,
        baseline: plan.baseline,
        nowIso: now.toISOString(),
      },
    });
    await deps.reload();
    const token: SyncUndoToken = applied.undo;
    if (token.entries.length > 0 || token.relationsAdded.length > 0 || token.relationsRemoved.length > 0) {
      deps.rememberUndo?.({
        count: token.entries.length,
        run: async () => {
          const r = await deps.request({ op: 'syncUndo', cid: deps.cid, token });
          await deps.reload();
          return r;
        },
      });
    }
    const lines = summaryLines(plan, diff, { missingAssets: missing, placedAtRoot: applied.placedAtRoot, regenerated: regenerate !== undefined, skippedAssets: 0 });
    deps.report([...lines, ...diff.warnings]);
    if (plan.conflicts.length > 0) {
      const text = `端末間の同期で競合したノートが ${plan.conflicts.length} 件あります。題名に「同期の競合」または「初回の突き合わせ」と付いたノートを検索すると一覧できます`;
      deps.postMessage?.({ kind: 'caution', source: 'sync', text, fixedHead: text });
    }
    deps.notify?.(`差分を取り込みました(${plan.summary.created + plan.summary.updated + plan.summary.merged + plan.summary.restored + plan.summary.trashed} 件を反映、競合 ${plan.summary.conflicts} 件)`);
    return { ok: true, count: applied.written + applied.trashed };
  } catch (e) {
    return fail(`「${name}」を取り込めませんでした(何も書き込んでいません): ${errorText(e)}`);
  }
}
