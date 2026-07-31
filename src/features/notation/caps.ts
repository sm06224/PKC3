/**
 * PKC2 capacity 管理(reform-2026-05、Phase 1 PR-A、initial implementation)。
 *
 * 2 層構造:
 *
 *   HARD_CEILINGS  ── spec 固定値、絶対超えられない(security guarantee)
 *          ↑ 超えられない
 *   SOFT_DEFAULTS  ── spec 推奨値、user / Flags / frontmatter で override 可能(HARD 以下に clamp)
 *          ↑
 *   runtime override(Flags inspector / frontmatter `limits:` block / `notation_overrides` 等)
 *          ↑
 *   parser / renderer が `resolveCap()` で effective 値を取得
 *
 * effective cap = min(requested_override, HARD_CEILINGS)
 *
 * これにより:
 *
 *   - 普通 user:何もしなくても SOFT_DEFAULTS で動く、cap 触る必要なし
 *   - Pro user:Flags inspector / frontmatter で「`limits.frontmatter_bytes = 32768`」のように
 *     runtime 上書き(SOFT 値を上書き、HARD 以下まで)
 *   - Power user:本 file を fork 編集 + rebuild、HARD 値も書き換え可能
 *     (self-build territory、security guarantee は spec 固定値で保証されたもの)
 *
 * 設計詳細は `docs/development/notation-redesign-2026-05/07-security-stance.md` §7.2 参照。
 *
 * features 層に置かない理由:cap は cross-feature(frontmatter / markdown / embed /
 * renderers 全部に適用)+ runtime resolvable(Flags / frontmatter から override)+
 * spec policy で fixed(version 跨いで stable)という性質を持ち、runtime の
 * version / build constants と並ぶ住人。
 */

// ── Hard ceilings(spec 固定、絶対上限)──────────────────

export const HARD_CEILINGS = {
  frontmatter: {
    bytes: 1 * 1024 * 1024,
    keys: 10_000,
    depth: 16,
    arrayItems: 1_000_000,
    stringValueBytes: 1 * 1024 * 1024,
  },
  body: {
    bytes: 100 * 1024 * 1024,
  },
  list: {
    items: 1_000_000,
    depth: 32,
  },
  table: {
    rows: 100_000,
    cols: 1000,
  },
  codeFence: {
    bytes: 10 * 1024 * 1024,
    lines: 1_000_000,
  },
  inlineNest: {
    depth: 32,
  },
  vars: {
    expansionsPerRender: 1_000_000,
  },
  math: {
    srcBytes: 64 * 1024,
    perDoc: 100_000,
  },
  embed: {
    depth: 4,
  },
  renderers: {
    tree: { lines: 100_000, nodes: 1_000_000 },
    dbschema: { tables: 1000, fieldsPerTable: 1000 },
    objectViewer: { nodes: 100_000, depth: 32 },
    query: { resultRows: 100_000, parseSteps: 1_000_000 },
    cards: { lids: 10_000 },
    mindmap: { nodes: 10_000 },
    flow: { nodes: 10_000, edges: 100_000 },
    seq: { participants: 1000, messages: 10_000 },
    state: { states: 1000, transitions: 10_000 },
    binary: { fields: 1000, totalBytes: 65_536 },
    hexdump: { bytes: 10 * 1024 * 1024 },
    diff: { lines: 100_000 },
  },
} as const;

// ── Soft defaults(spec 推奨値、user override 可能)────────

export const SOFT_DEFAULTS = {
  frontmatter: {
    bytes: 16 * 1024,
    keys: 100,
    depth: 4,
    arrayItems: 500,
    stringValueBytes: 4 * 1024,
  },
  body: {
    bytes: 10 * 1024 * 1024,
  },
  list: {
    items: 1000,
    depth: 8,
  },
  table: {
    rows: 1000,
    cols: 50,
  },
  codeFence: {
    bytes: 64 * 1024,
    lines: 1000,
  },
  inlineNest: {
    depth: 8,
  },
  vars: {
    expansionsPerRender: 1000,
  },
  math: {
    srcBytes: 4 * 1024,
    perDoc: 1000,
  },
  embed: {
    depth: 1,
  },
  renderers: {
    tree: { lines: 1000, nodes: 5000 },
    dbschema: { tables: 50, fieldsPerTable: 100 },
    objectViewer: { nodes: 5000, depth: 8 },
    query: { resultRows: 1000, parseSteps: 10_000 },
    cards: { lids: 100 },
    mindmap: { nodes: 500 },
    flow: { nodes: 200, edges: 500 },
    seq: { participants: 30, messages: 200 },
    state: { states: 50, transitions: 200 },
    binary: { fields: 100, totalBytes: 1024 },
    hexdump: { bytes: 65_536 },
    diff: { lines: 5000 },
  },
} as const;

// ── Type-safe lookup ────────────────────────────────────

/**
 * Top-level cap categories(`HARD_CEILINGS` / `SOFT_DEFAULTS` の key と一致)。
 */
export type CapCategory =
  | 'frontmatter'
  | 'body'
  | 'list'
  | 'table'
  | 'codeFence'
  | 'inlineNest'
  | 'vars'
  | 'math'
  | 'embed'
  | 'renderers';

/**
 * Renderer 名の閉集合(`HARD_CEILINGS.renderers` と `SOFT_DEFAULTS.renderers` の key)。
 */
export type RendererName =
  | 'tree'
  | 'dbschema'
  | 'objectViewer'
  | 'query'
  | 'cards'
  | 'mindmap'
  | 'flow'
  | 'seq'
  | 'state'
  | 'binary'
  | 'hexdump'
  | 'diff';

// ── resolveCap helper ───────────────────────────────────

/**
 * Effective cap を返す。`override` 指定時は HARD 以下に clamp。
 *
 *   resolveCap('frontmatter', 'bytes')               → SOFT_DEFAULTS.frontmatter.bytes(16 KB)
 *   resolveCap('frontmatter', 'bytes', 32 * 1024)    → 32 KB(SOFT 上書き、HARD 内)
 *   resolveCap('frontmatter', 'bytes', 999_999_999)  → HARD_CEILINGS.frontmatter.bytes(1 MB clamp)
 */
export function resolveCap(
  category: Exclude<CapCategory, 'renderers'>,
  name: string,
  override?: number,
): number {
  const ceiling = (HARD_CEILINGS[category] as Record<string, number>)[name];
  const dflt = (SOFT_DEFAULTS[category] as Record<string, number>)[name];
  if (ceiling === undefined || dflt === undefined) {
    throw new Error(`unknown cap: ${category}.${name}`);
  }
  const requested = override ?? dflt;
  return Math.min(requested, ceiling);
}

/**
 * Renderer 用の effective cap 取得。
 *
 *   resolveRendererCap('tree', 'lines')                    → 1000(SOFT)
 *   resolveRendererCap('tree', 'lines', 10_000)            → 10_000(override、HARD 100,000 内)
 *   resolveRendererCap('tree', 'lines', 99_999_999)        → 100_000(HARD clamp)
 */
export function resolveRendererCap(
  renderer: RendererName,
  name: string,
  override?: number,
): number {
  const ceiling = (HARD_CEILINGS.renderers[renderer] as Record<string, number>)[name];
  const dflt = (SOFT_DEFAULTS.renderers[renderer] as Record<string, number>)[name];
  if (ceiling === undefined || dflt === undefined) {
    throw new Error(`unknown renderer cap: renderers.${renderer}.${name}`);
  }
  const requested = override ?? dflt;
  return Math.min(requested, ceiling);
}

// ── Asserter(build 時の整合 check)──────────────────────

/**
 * 各 renderer が HARD と SOFT 両方に entry を持ち、SOFT ≤ HARD であることを確認。
 * build asserter / unit test から呼ぶ。
 *
 * 不整合があれば throw。
 */
export function assertCapsConsistency(): void {
  const renderers = Object.keys(HARD_CEILINGS.renderers);
  for (const renderer of renderers) {
    const hard = (HARD_CEILINGS.renderers as Record<string, Record<string, number>>)[renderer];
    const soft = (SOFT_DEFAULTS.renderers as Record<string, Record<string, number>>)[renderer];
    if (!hard || !soft) {
      throw new Error(`renderer ${renderer} missing entry in HARD_CEILINGS or SOFT_DEFAULTS`);
    }
    for (const key of Object.keys(hard)) {
      const h = hard[key]!;
      const s = soft[key];
      if (s === undefined) {
        throw new Error(`renderer ${renderer}.${key} missing in SOFT_DEFAULTS`);
      }
      if (s > h) {
        throw new Error(
          `renderer ${renderer}.${key}: SOFT (${s}) > HARD (${h}) — invalid`,
        );
      }
    }
  }

  // top-level categories(renderers 以外)も同 check
  const topLevel: Exclude<CapCategory, 'renderers'>[] = [
    'frontmatter',
    'body',
    'list',
    'table',
    'codeFence',
    'inlineNest',
    'vars',
    'math',
    'embed',
  ];
  for (const cat of topLevel) {
    const hard = HARD_CEILINGS[cat] as Record<string, number>;
    const soft = SOFT_DEFAULTS[cat] as Record<string, number>;
    for (const key of Object.keys(hard)) {
      const h = hard[key]!;
      const s = soft[key];
      if (s === undefined) {
        throw new Error(`${cat}.${key} missing in SOFT_DEFAULTS`);
      }
      if (s > h) {
        throw new Error(`${cat}.${key}: SOFT (${s}) > HARD (${h}) — invalid`);
      }
    }
  }
}
