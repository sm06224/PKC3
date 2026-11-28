/**
 * 🔴 **ノート内データフローの DAG**(#2115 Phase 1 / PR-2)。
 *
 * 本文 → データセット + ビュー → 依存の辺 → 循環の検出 → 評価の順 → 1 つを評価するのに要る最小の計画 →
 * その計画の入力だけから作るキャッシュの鍵。評価そのもの(SQLite に流す)は PR-3 の adapter 層。
 *
 * ## 依存の辺の取り方(誤差の向き)
 *
 * - **ビュー → データセット**: SQL に語として出てくる名前(`sqlMentions` = `csvTablesMentioned` の 1 本)。
 *   多めに拾っても上流の表が 1 つ余分に組まれるだけなので、少なく拾う側へ倒さない。
 * - **ビュー → ビュー**: `FROM` / `JOIN` の位置に書かれた名前だけ(`sqlFromTables`)。
 *   ⚠ ここを「語として出てくるか」で取ると、`SELECT sum(金額) AS 合計` の列の別名が同じ名前のビューへの辺になり、
 *   **起きていない循環**を言ってしまう(`sql view=合計` は自分自身を引くことになる)。循環は評価を止めるので、
 *   ビュー同士の辺は確かな位置だけで取る。
 * - どちらも `WITH` の CTE と同じ名前は数えない(CTE が隠す)。
 *
 * ## 入力の指紋(`computeDataflowHash`)
 *
 * 計画に入った上流のデータセットの中身(列と行 / 添付の鍵と指紋)と、上流のビューの SQL だけから作る。
 * 行番号・`embed` の有無・囲みの種類(csv か Markdown の表か)は入れない ── 無関係な段落を足して行がずれても、
 * 表の書き方を csv ⇄ Markdown に作り変えても、答えが変わらない限り鍵は変わらない(無駄な評価をしない)。
 *
 * ⚠ pure module。
 */
import { CSV_TABLE_RESERVED } from '@features/query/csv-tables';
import { sha256Hex } from '@features/sync/sha256';
import { foldName } from './names';
import { collectExplicitDatasets, collectImplicitAssetDatasets } from './note-datasets';
import { cteNames, findMissingRefs, sqlFromTables, sqlMentions, sqlReferenceText } from './sql-refs';
import { extractNoteSqlViews } from './sql-views';
import type {
  DataflowDiagnostic,
  NoteDataflowGraph,
  NoteDataset,
  NoteSqlView,
  NoteSqlViewDef,
  ViewEvaluationPlan,
  ViewEvaluationPlanOk,
} from './types';

/** ハッシュの形の版。⚠ 並べ方を変えたら上げる(古い鍵が新しい答えに当たらないように)。 */
export const DATAFLOW_HASH_VERSION = 'pkc-dataflow-hash/1';

/** 名前の一覧だけを持つ形(`NoteDataflowGraph` も満たす)。 */
export interface DataflowNames {
  readonly datasets: ReadonlyMap<string, unknown>;
  readonly views: ReadonlyMap<string, unknown>;
}

/** 利用できる名前(データセット → ビューの定義順)。 */
function availableNames(graph: DataflowNames): string[] {
  return [...graph.datasets.keys(), ...graph.views.keys()];
}

/**
 * 🔴 **名前が見つからないときの 1 文**(改名・削除のあと、ビューが古い名前を引いているとき)。
 * 候補の名前を添える ── 何に直せばよいかが画面だけで分かるように。
 */
export function formatMissingSourceError(
  missingName: string,
  graph: DataflowNames,
): string {
  const names = availableNames(graph);
  const head = `データセットまたはビュー「${missingName}」が見つかりません。`;
  if (names.length === 0) {
    return `${head}このノートには利用できるデータセット・ビューがありません(表に名前を付けると使えます)`;
  }
  return `${head}このノートで利用可能な名前: ${names.join('、')}`;
}

/** 名前を正規の綴りへ引く(ASCII の大小は畳む)。 */
function resolve(graph: NoteDataflowGraph, name: string): { kind: 'dataset' | 'view'; name: string } | null {
  const k = foldName(name);
  for (const n of graph.datasets.keys()) if (foldName(n) === k) return { kind: 'dataset', name: n };
  for (const n of graph.views.keys()) if (foldName(n) === k) return { kind: 'view', name: n };
  return null;
}

/** ビュー同士の辺(`FROM` / `JOIN` の位置の名前だけ。CTE は外す)。 */
function viewEdges(def: NoteSqlViewDef, viewByFold: ReadonlyMap<string, string>): string[] {
  const ctes = new Set(cteNames(sqlReferenceText(def.sql)).map(foldName));
  const out: string[] = [];
  for (const t of sqlFromTables(def.sql)) {
    const k = foldName(t);
    if (ctes.has(k)) continue;
    const v = viewByFold.get(k);
    if (v !== undefined && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 強連結成分(Tarjan)。⚠ 再帰しない(ビューが多いノートでもスタックを積まない)。 */
function stronglyConnected(nodes: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const succ = edges.get(top.node) ?? [];
      if (top.next < succ.length) {
        const w = succ[top.next]!;
        top.next += 1;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter += 1;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(top.node, Math.min(low.get(top.node)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(top.node)!));
      if (low.get(top.node) === index.get(top.node)) {
        const comp: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
          if (w === top.node) break;
        }
        out.push(comp);
      }
    }
  }
  return out;
}

/** 成分の中で `start` から `start` へ戻る鎖(最短)。 */
function cycleChain(start: string, members: ReadonlySet<string>, edges: ReadonlyMap<string, readonly string[]>): string[] {
  const prev = new Map<string, string>();
  const queue: string[] = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const w of edges.get(u) ?? []) {
      if (!members.has(w)) continue;
      if (w === start) {
        const chain = [start];
        for (let x: string | undefined = u; x !== undefined && x !== start; x = prev.get(x)) chain.splice(1, 0, x);
        chain.push(start);
        return chain;
      }
      if (seen.has(w)) continue;
      seen.add(w);
      prev.set(w, u);
      queue.push(w);
    }
  }
  return [start, start];
}

/**
 * 🔴 **本文からデータフローの DAG を組む**。
 *
 * 名乗る順は ① 明示のデータセット ② ビュー(データセットと同じ名前は断る)③ 添付リンクの自動候補
 * (どちらとも同じ名前なら静かに譲る)。
 */
export function buildNoteDataflow(body: string): NoteDataflowGraph {
  const explicit = collectExplicitDatasets(body);
  const viewDefs = extractNoteSqlViews(
    body,
    explicit.datasets.map((d) => d.name),
  );
  const implicit = collectImplicitAssetDatasets(body, [
    ...explicit.datasets.map((d) => d.name),
    ...viewDefs.views.map((v) => v.name),
  ]);
  const datasetList: NoteDataset[] = [...explicit.datasets, ...implicit].sort((a, b) => a.line - b.line);
  const datasets = new Map<string, NoteDataset>(datasetList.map((d) => [d.name, d]));
  const datasetNames = [...datasets.keys()];
  const viewByFold = new Map<string, string>(viewDefs.views.map((v) => [foldName(v.name), v.name]));
  const known = [...datasetNames, ...viewDefs.views.map((v) => v.name)];
  const diagnostics: DataflowDiagnostic[] = [...explicit.diagnostics, ...viewDefs.diagnostics];
  const names: DataflowNames = { datasets, views: new Map(viewDefs.views.map((v) => [v.name, v])) };

  // 辺
  const edges = new Map<string, readonly string[]>();
  const views = new Map<string, NoteSqlView>();
  for (const def of viewDefs.views) {
    const vEdges = viewEdges(def, viewByFold);
    edges.set(def.name, vEdges);
    const dsDeps = sqlMentions(def.sql, datasetNames);
    const missingRefs = findMissingRefs(def.sql, known, CSV_TABLE_RESERVED);
    views.set(def.name, { ...def, deps: [...dsDeps, ...vEdges], missingRefs });
    for (const m of missingRefs) {
      diagnostics.push({
        kind: 'missing-ref',
        name: def.name,
        line: def.line,
        why: `ビュー「${def.name}」: ${formatMissingSourceError(m, names)}`,
      });
    }
  }

  // 循環
  const viewNames = viewDefs.views.map((v) => v.name);
  const lineOf = new Map(viewDefs.views.map((v) => [v.name, v.line]));
  const cyclic = new Set<string>();
  const cycles: string[][] = [];
  for (const comp of stronglyConnected(viewNames, edges)) {
    const self = comp.length === 1 && (edges.get(comp[0]!) ?? []).includes(comp[0]!);
    if (comp.length < 2 && !self) continue;
    const members = new Set(comp);
    const start = [...comp].sort((a, b) => lineOf.get(a)! - lineOf.get(b)!)[0]!;
    const chain = cycleChain(start, members, edges);
    cycles.push(chain);
    for (const m of comp) cyclic.add(m);
    for (const m of comp) {
      diagnostics.push({
        kind: 'cycle',
        name: m,
        line: lineOf.get(m)!,
        why: `ビュー「${m}」は循環して参照しています: ${chain.join(' → ')}`,
      });
    }
  }
  cycles.sort((a, b) => lineOf.get(a[0]!)! - lineOf.get(b[0]!)!);

  // 循環の下流(評価できない)
  const blocked = new Map<string, string>();
  const reachesCycle = (v: string, seen: Set<string>): string | null => {
    if (cyclic.has(v)) return v;
    if (seen.has(v)) return null;
    seen.add(v);
    for (const w of edges.get(v) ?? []) {
      const hit = reachesCycle(w, seen);
      if (hit !== null) return hit;
    }
    return null;
  };
  for (const v of viewNames) {
    if (cyclic.has(v)) continue;
    const hit = reachesCycle(v, new Set());
    if (hit === null) continue;
    blocked.set(v, hit);
    diagnostics.push({
      kind: 'blocked',
      name: v,
      line: lineOf.get(v)!,
      why: `ビュー「${v}」は、循環しているビュー「${hit}」を上流に持つため評価できません`,
    });
  }

  // 評価の順(Kahn。同順位は定義順)
  const live = viewNames.filter((v) => !cyclic.has(v) && !blocked.has(v));
  const indeg = new Map<string, number>(live.map((v) => [v, (edges.get(v) ?? []).length]));
  const users = new Map<string, string[]>();
  for (const v of live) for (const w of edges.get(v) ?? []) users.set(w, [...(users.get(w) ?? []), v]);
  const order: string[] = [];
  const ready = live.filter((v) => indeg.get(v) === 0);
  while (ready.length > 0) {
    ready.sort((a, b) => lineOf.get(a)! - lineOf.get(b)!);
    const v = ready.shift()!;
    order.push(v);
    for (const u of users.get(v) ?? []) {
      const d = (indeg.get(u) ?? 0) - 1;
      indeg.set(u, d);
      if (d === 0) ready.push(u);
    }
  }

  diagnostics.sort((a, b) => a.line - b.line);
  return { datasets, views, order, cycles, diagnostics };
}

/**
 * 🔴 **1 つの名前を評価するのに要る最小の計画**(遅延評価の核)。
 *
 * 推移的に要る上流のデータセット(定義順)と上流のビュー(評価の順)だけを返す ── 無関係な表は組まない。
 * 対象がデータセットなら、それ 1 つだけ。見つからない / 循環している / 上流が循環しているなら `ok: false`。
 */
export function planViewEvaluation(graph: NoteDataflowGraph, targetName: string): ViewEvaluationPlan {
  const hit = resolve(graph, targetName);
  if (hit === null) return { ok: false, error: formatMissingSourceError(targetName, graph) };
  if (hit.kind === 'dataset') {
    return { ok: true, target: hit.name, targetKind: 'dataset', datasets: [graph.datasets.get(hit.name)!], views: [] };
  }
  if (!graph.order.includes(hit.name)) {
    const chain = graph.cycles.find((c) => c.includes(hit.name));
    if (chain !== undefined) {
      return { ok: false, error: `ビュー「${hit.name}」は循環して参照しています: ${chain.join(' → ')}` };
    }
    const why = graph.diagnostics.find((d) => d.kind === 'blocked' && d.name === hit.name)?.why;
    return { ok: false, error: why ?? `ビュー「${hit.name}」は評価できません` };
  }
  const need = new Set<string>();
  const walk = [hit.name];
  while (walk.length > 0) {
    const n = walk.pop()!;
    if (need.has(n)) continue;
    need.add(n);
    for (const d of graph.views.get(n)?.deps ?? []) walk.push(d);
  }
  const datasets = [...graph.datasets.values()].filter((d) => need.has(d.name));
  const views = graph.order.filter((v) => need.has(v)).map((v) => graph.views.get(v)!);
  return { ok: true, target: hit.name, targetKind: 'view', datasets, views };
}

/**
 * 🔴 **計画の入力だけから作る、決定論的なキャッシュの鍵**(SHA-256 の hex 64 字・同期)。
 *
 * @param assetFingerprints 添付の鍵 → 中身の指紋(adapter が知っている物)。無ければ `null` として混ぜる
 *   (⚠ その場合、添付の中身が変わっても鍵は変わらない ── 呼び手は指紋を渡すこと)。
 */
export function computeDataflowHash(
  plan: ViewEvaluationPlanOk,
  assetFingerprints?: ReadonlyMap<string, string>,
): string {
  const datasets = plan.datasets.map((d) =>
    d.kind === 'asset'
      ? ['asset', d.name, d.assetKey, d.format, d.noHeader, assetFingerprints?.get(d.assetKey) ?? null]
      : ['inline', d.name, d.columns, d.rows],
  );
  const views = plan.views.map((v) => [v.name, v.sql]);
  return sha256Hex(JSON.stringify([DATAFLOW_HASH_VERSION, plan.target, datasets, views]));
}
