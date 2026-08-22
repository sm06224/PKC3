/**
 * PKC Link — pure helpers for the 3 reference forms.
 *
 * Spec: PKC2: docs/spec/pkc-link-unification-v0.md (post-correction).
 *
 * The link layer separates **3 reference forms** (spec §3):
 *
 *   1. Internal Reference  — `entry:<lid>` / `asset:<key>`
 *      (handled by src/features/entry-ref/entry-ref.ts; not here)
 *   2. Portable PKC Reference — `pkc://<cid>/entry/<lid>[#<frag>]`
 *      Machine identifier used by paste conversion / cross-PKC
 *      marshalling. NOT clickable in external apps.
 *   3. External Permalink — `<base_url>#pkc?container=<cid>&entry=<lid>`
 *      The shareable, externally-clickable URL for Loop / Office /
 *      mail / note apps. Host URL + fragment query.
 *
 * This module owns parser / formatter for forms 2 and 3 and the
 * same-container check used by paste conversion. Form 1 lives
 * elsewhere because it predates this slice.
 *
 * Naming: the original draft conflated form 2 with "permalink".
 * The post-correction names are `*PortablePkcReference` and
 * `*ExternalPermalink`. The pre-correction `*Permalink` exports
 * remain as **@deprecated** aliases so older call sites keep
 * compiling; new call sites should use the renamed primaries.
 *
 * Invariants:
 *   - pure: no side effects, no DOM, no state, no I/O
 *   - safe: malformed input produces `null`, never throws
 *   - round-trip: `parseFoo(formatFoo(input)!)` is structurally
 *     equal to `input` modulo the optional `raw` field
 */

export const PKC_SCHEME = 'pkc://';

export type PkcRefKind = 'entry' | 'asset';

/**
 * Shared token shape with `src/features/entry-ref/entry-ref.ts`.
 * Mirrors spec §4 / §5.5 (token form is `[A-Za-z0-9_-]+`).
 */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

// ─────────────────────────────────────────────────────────────────
// Form 2: Portable PKC Reference (`pkc://<cid>/<kind>/<id>[#<frag>]`)
// ─────────────────────────────────────────────────────────────────

/**
 * Structured view of a parsed Portable PKC Reference. `fragment`
 * includes the leading `#` so callers can treat it as an opaque
 * suffix. `raw` carries the original source string verbatim.
 */
export interface ParsedPortablePkcReference {
  readonly kind: PkcRefKind;
  readonly containerId: string;
  readonly targetId: string;
  /** Includes the leading `#`. Always absent for `kind: 'asset'`. */
  readonly fragment?: string;
  readonly raw: string;
}

/**
 * Minimal formatter input. `fragment` — when provided — must already
 * carry the leading `#`.
 */
export interface PortablePkcReferenceInput {
  readonly kind: PkcRefKind;
  readonly containerId: string;
  readonly targetId: string;
  readonly fragment?: string;
}

/**
 * Parse a canonical `pkc://` Portable PKC Reference string.
 *
 * Returns `null` for any shape mismatch: unknown scheme, missing
 * segments, invalid tokens, unknown kind, extra path segments, or
 * an asset reference carrying a fragment (assets have no sub-
 * locations, spec §5.2). Non-string input is also rejected.
 */
export function parsePortablePkcReference(
  raw: string,
): ParsedPortablePkcReference | null {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith(PKC_SCHEME)) return null;

  const rest = raw.slice(PKC_SCHEME.length);
  const hashIdx = rest.indexOf('#');
  const pathPart = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  const fragmentSuffix = hashIdx === -1 ? '' : rest.slice(hashIdx);
  // Bare `#` with no body is meaningless; normalise it away so
  // parse(format(parsed)) stays a fixed point.
  const fragment = fragmentSuffix === '#' ? '' : fragmentSuffix;

  const parts = pathPart.split('/');
  if (parts.length !== 3) return null;
  const [containerId, kindRaw, targetId] = parts;
  if (containerId === undefined || !TOKEN_RE.test(containerId)) return null;
  if (targetId === undefined || !TOKEN_RE.test(targetId)) return null;
  if (kindRaw !== 'entry' && kindRaw !== 'asset') return null;

  const kind: PkcRefKind = kindRaw;
  if (kind === 'asset' && fragment !== '') return null;

  return fragment === ''
    ? { kind, containerId, targetId, raw }
    : { kind, containerId, targetId, fragment, raw };
}

/**
 * Produce a canonical `pkc://` Portable PKC Reference from a
 * structured input. Returns `null` when any field violates the
 * grammar.
 */
export function formatPortablePkcReference(
  input: PortablePkcReferenceInput,
): string | null {
  if (input.kind !== 'entry' && input.kind !== 'asset') return null;
  if (!TOKEN_RE.test(input.containerId)) return null;
  if (!TOKEN_RE.test(input.targetId)) return null;

  const fragment = input.fragment;
  if (fragment !== undefined) {
    if (input.kind === 'asset') return null; // §5.2
    if (!fragment.startsWith('#') || fragment.length < 2) return null;
  }

  const base = `${PKC_SCHEME}${input.containerId}/${input.kind}/${input.targetId}`;
  return fragment === undefined ? base : `${base}${fragment}`;
}

/**
 * True when a parsed Portable Reference targets the caller's own
 * container. Exact, case-sensitive comparison. Empty / non-string
 * `currentContainerId` returns `false` so a bootstrap glitch can
 * never silently flip cross-container content into local namespace.
 */
export function isSamePortableContainer(
  parsed: ParsedPortablePkcReference | ParsedExternalPermalink,
  currentContainerId: string,
): boolean {
  if (typeof currentContainerId !== 'string') return false;
  if (currentContainerId === '') return false;
  return parsed.containerId === currentContainerId;
}

// ─────────────────────────────────────────────────────────────────
// Form 3: External Permalink (`<base>#pkc?container=&entry=...`)
// ─────────────────────────────────────────────────────────────────

/**
 * Structured view of a parsed External Permalink. The `baseUrl`
 * field carries the host URL (everything before `#pkc?`) so a
 * receiver can reconstruct the same canonical form, and the
 * `kind` / `containerId` / `targetId` / `fragment` mirror the
 * Portable PKC Reference shape so `paste-conversion` can route
 * both forms through one demotion path.
 */
export interface ParsedExternalPermalink {
  readonly kind: PkcRefKind;
  readonly containerId: string;
  readonly targetId: string;
  /** Already-decoded value, no leading `#`. Always absent for assets. */
  readonly fragment?: string;
  readonly baseUrl: string;
  readonly raw: string;
}

/**
 * External Permalink formatter input.
 *
 * `baseUrl` should be the host URL with any pre-existing `#fragment`
 * already stripped (typically `window.location.href.split('#')[0]`).
 */
export interface ExternalPermalinkInput {
  readonly baseUrl: string;
  readonly kind: PkcRefKind;
  readonly containerId: string;
  readonly targetId: string;
  /** Fragment value with NO leading `#`. Optional, entry only. */
  readonly fragment?: string;
}

const PKC_FRAGMENT_PREFIX = '#pkc?';

/**
 * Parse an External Permalink (`<base>#pkc?container=&entry=...` or
 * `&asset=...`). Returns `null` on any malformed input. Order of
 * query keys is not enforced; encoding survives a single
 * `decodeURIComponent` round.
 */
export function parseExternalPermalink(raw: string): ParsedExternalPermalink | null {
  if (typeof raw !== 'string') return null;
  const idx = raw.indexOf(PKC_FRAGMENT_PREFIX);
  if (idx === -1) return null;

  const baseUrl = raw.slice(0, idx);
  if (baseUrl === '') return null;

  const queryString = raw.slice(idx + PKC_FRAGMENT_PREFIX.length);
  if (queryString === '') return null;

  // Tolerate both `&` and `;` separators; URLSearchParams handles
  // standard URL encoding once.
  const params = new URLSearchParams(queryString);
  const containerId = params.get('container');
  if (!containerId || !TOKEN_RE.test(containerId)) return null;

  const entryId = params.get('entry');
  const assetId = params.get('asset');
  // Exactly one of entry / asset must be present.
  if ((entryId == null) === (assetId == null)) return null;

  let kind: PkcRefKind;
  let targetId: string;
  if (entryId != null) {
    kind = 'entry';
    targetId = entryId;
  } else {
    // assetId is non-null per the XOR guard above.
    kind = 'asset';
    targetId = assetId as string;
  }
  if (!TOKEN_RE.test(targetId)) return null;

  const rawFragment = params.get('fragment');
  if (kind === 'asset' && rawFragment != null) return null;
  const fragment = rawFragment ?? undefined;

  return fragment === undefined
    ? { kind, containerId, targetId, baseUrl, raw }
    : { kind, containerId, targetId, fragment, baseUrl, raw };
}

/**
 * Produce an External Permalink from `baseUrl` + structured input.
 *
 * The `baseUrl` is appended verbatim — the caller is responsible
 * for stripping any pre-existing `#` fragment before calling. We
 * intentionally do NOT silently strip it here so a stale fragment
 * doesn't get hidden inside the produced URL.
 */
export function formatExternalPermalink(
  input: ExternalPermalinkInput,
): string | null {
  if (input.kind !== 'entry' && input.kind !== 'asset') return null;
  if (!TOKEN_RE.test(input.containerId)) return null;
  if (!TOKEN_RE.test(input.targetId)) return null;
  if (typeof input.baseUrl !== 'string' || input.baseUrl === '') return null;
  if (input.baseUrl.includes('#')) return null;

  const fragment = input.fragment;
  if (fragment !== undefined) {
    if (input.kind === 'asset') return null;
    if (fragment === '') return null;
  }

  // Build query in canonical order: container → entry|asset → fragment.
  const parts: string[] = [
    `container=${encodeURIComponent(input.containerId)}`,
    `${input.kind}=${encodeURIComponent(input.targetId)}`,
  ];
  if (fragment !== undefined) {
    parts.push(`fragment=${encodeURIComponent(fragment)}`);
  }
  return `${input.baseUrl}${PKC_FRAGMENT_PREFIX}${parts.join('&')}`;
}

// ─────────────────────────────────────────────────────────────────
// Form 3b: View deep link (`<base>#pkc?view=<name>`)
// ─────────────────────────────────────────────────────────────────

/**
 * 🔴 **「この画面で開く」のディープリンク**(#300 段②、2026-08-22)。
 *
 * ## なぜ要るか
 *
 * 組み込みアプリ(カレンダー / やることの板 / 2 ペイン)を**別窓で開く**とき、
 * 窓に「どの面を出すか」を伝える口が要る。⚠ その口を**クエリパラメータの
 * 切替**にしてはいけない ── user 指示 2026-08-07(不可侵)は
 * 「クエリパラメータを読んでよいのは **flag の解決**と
 * **パーマリンク / ディープリンク**だけ」と定めている。
 * 🔑 だから**ディープリンクとして**足す ── 既存の External Permalink と
 * 同じ `#pkc?` の断片を使い、`view` という key を 1 つ増やすだけにする。
 *
 * ## この関数の受け持ち
 *
 * ⚠ **文字列を読むだけ。** この file は「pure: no side effects, no DOM,
 * no state, no I/O」を名乗っている(冒頭)ので、`location` は読まない ──
 * 読むのは adapter(`src/adapter/platform/deep-link.ts`)である。
 * ⚠ **面の名前が正しいかは判定しない**(`ViewMode` は adapter 層の型で、
 * features からは引けない)。ここは**綴りの検査まで**で、実在の照合は呼び側。
 *
 * ## 受ける形
 *
 * - `…#pkc?view=calendar` → `'calendar'`
 * - `…#pkc?container=c1&entry=e1&view=dual` → `'dual'`(他の key と併記できる)
 * - `#pkc?view=calendar` → `'calendar'`(⚠ base が無い断片だけでも受ける ──
 *   `location.hash` はこの形で来る)
 * - `view` が無い / 空 → `null`
 *
 * ⚠ **綴りの検査はしない**(2026-08-22 に外した)。初稿は `TOKEN_RE` で弾いて
 * いたが、そうすると `#pkc?view=カレンダー`(綴りを日本語で書いた形)が
 * **`null` と見分けがつかず、呼び側は黙って本文を開く**しかなかった ──
 * 動線レビューが「断り文が絶対に効かない書き方へ誘導する」として拾った当の穴である。
 * 🔑 ここは**取り出すだけ**にして、「使える名前か」の判定と**断り文**は呼び側へ寄せる。
 */
export function parseViewDeepLink(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const idx = raw.indexOf(PKC_FRAGMENT_PREFIX);
  if (idx === -1) return null;
  const queryString = raw.slice(idx + PKC_FRAGMENT_PREFIX.length);
  const view = new URLSearchParams(queryString).get('view');
  return view === null || view === '' ? null : view;
}

/**
 * 🔴 **断片から `view` だけを落とす**(#300 段②のレビュー、2026-08-22)。
 *
 * ⚠ 初稿は「断片ごと落とす」だった ── `#pkc?container=c1&entry=e1&view=dual` の
 * ように**併記された相手を道連れにする**。いま `container` / `entry` の消費者は
 * 0 件なので実害は出ていないが、`parseViewDeepLink` の docstring と
 * `tests/adapter/deep-link.test.ts` は**併記できると書いている** ── 段③ で必ず踏む。
 *
 * @returns 落とした後の断片(先頭 `#` 付き)。⚠ **何も残らなければ空文字**
 *   (`#pkc?` だけの断片をアドレスに残さない)
 */
export function dropViewFromHash(raw: string): string {
  if (typeof raw !== 'string') return '';
  const idx = raw.indexOf(PKC_FRAGMENT_PREFIX);
  if (idx === -1) return raw;
  const params = new URLSearchParams(raw.slice(idx + PKC_FRAGMENT_PREFIX.length));
  params.delete('view');
  const rest = params.toString();
  const before = raw.slice(0, idx);
  return rest === '' ? before : `${before}${PKC_FRAGMENT_PREFIX}${rest}`;
}

/**
 * `<base>#pkc?view=<name>` を組む。
 *
 * ⚠ `formatExternalPermalink` と同じ作法で、**`baseUrl` に `#` が残っていたら
 * 断る** ── 黙って剥がすと、古い断片が新しい URL の中に隠れる。
 */
export function formatViewDeepLink(baseUrl: string, view: string): string | null {
  if (typeof baseUrl !== 'string' || baseUrl === '') return null;
  if (baseUrl.includes('#')) return null;
  if (!TOKEN_RE.test(view)) return null;
  return `${baseUrl}${PKC_FRAGMENT_PREFIX}view=${encodeURIComponent(view)}`;
}

// ─────────────────────────────────────────────────────────────────
// Deprecated aliases (pre-correction names, kept for back-compat)
// ─────────────────────────────────────────────────────────────────

/** @deprecated Use `ParsedPortablePkcReference`. */
export type ParsedPermalink = ParsedPortablePkcReference;

/** @deprecated Use `PortablePkcReferenceInput`. */
export type PermalinkInput = PortablePkcReferenceInput;

/** @deprecated Use `PkcRefKind`. */
export type PkcPermalinkKind = PkcRefKind;

/** @deprecated Use `parsePortablePkcReference`. */
export const parsePermalink = parsePortablePkcReference;

/** @deprecated Use `formatPortablePkcReference`. */
export const formatPermalink = formatPortablePkcReference;

/** @deprecated Use `isSamePortableContainer`. */
export const isSamePermalinkContainer = isSamePortableContainer;
