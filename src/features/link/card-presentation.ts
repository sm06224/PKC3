/**
 * Card presentation — pure parser / formatter for `@[card](<target>)`.
 *
 * Spec: docs/spec/card-embed-presentation-v0.md §5 / §5.3 / §5.4 / §8.
 *
 * Slice 1 scope: **syntax-level** recognition only. No DOM, no
 * markdown-it renderer hook, no widget rendering. Given a raw string,
 * decide whether it is a card presentation notation and, if so,
 * extract the variant + target. The renderer continues to display
 * `@[card](target)` as a literal `@` followed by a plain link; the
 * widget UI is the job of a future slice.
 *
 * Grammar (v0):
 *
 *   @[card](<target>)                  → variant: 'default'
 *   @[card:compact](<target>)          → variant: 'compact'
 *   @[card:wide](<target>)             → variant: 'wide'
 *   @[card:timeline](<target>)         → variant: 'timeline'
 *
 * Target grammar is validated against the canonical v0 target forms
 * for card presentation. Spec §5.4 / §8 mark `asset:<key>` and
 * `pkc://<cid>/asset/<key>` as **❌ 非対応** for card — asset preview
 * cards are a **v0 future dialect** (see
 * `../../../docs/development/card-asset-target-coordination-audit.md`,
 * Option C). The parser therefore only accepts entry-flavoured targets:
 *
 *   entry:<lid>[#<fragment>]           — via parseEntryRef
 *   pkc://<cid>/entry/<lid>[#<frag>]   — via parsePortablePkcReference,
 *                                        `kind === 'entry'` only
 *
 * Any other scheme — including `asset:` / `pkc://<cid>/asset/<key>` /
 * ordinary `https:` / `javascript:` / External Permalink / clickable-
 * image — is rejected at parse time. Card-embed-presentation-v0.md
 * §7 / §8 mark those as 🚫 do-not-emit or ❌ invalid for card
 * presentation.
 *
 * Invariants:
 *   - pure: no side effects, no DOM, no state, no I/O
 *   - safe: malformed input produces `null`, never throws
 *   - round-trip: parse(format(input)!)?.target === input.target
 *     and parse(format(input)!)?.variant === input.variant
 *   - target preserve: `parsed.target` equals the original substring
 *     between `(` and `)`, byte-for-byte
 */

import { isValidEntryRef } from '@features/entry-ref/entry-ref';
import { parsePortablePkcReference } from '@features/link/permalink';

export type CardVariant = 'default' | 'compact' | 'wide' | 'timeline';

/**
 * Structured view of a parsed card presentation. `raw` carries the
 * original source string verbatim; `target` is the substring inside
 * the parentheses, preserved byte-for-byte.
 */
export interface ParsedCardPresentation {
  readonly variant: CardVariant;
  readonly target: string;
  readonly raw: string;
}

/**
 * Formatter input. `variant` defaults to `'default'` when omitted.
 */
export interface CardPresentationInput {
  readonly target: string;
  readonly variant?: CardVariant;
}

const CARD_RE = /^@\[card(?::([a-z]+))?\]\(([^)]*)\)$/;
const VARIANT_WHITELIST: readonly CardVariant[] = [
  'compact',
  'wide',
  'timeline',
] as const;

/**
 * Parse a card presentation string. Returns `null` for anything that
 * is not a well-formed `@[card](<target>)` with a recognised v0
 * target grammar.
 *
 * Rejected shapes include (non-exhaustive):
 *   - `[card](...)`         — missing `@` prefix, plain link
 *   - `@[card:unknown](...)` — unknown variant
 *   - `@[card]()` / `@[card]( )` — empty / whitespace-only target
 *   - `@[card](asset:key)`  — v0 future dialect (spec §5.4 ❌ 非対応)
 *   - `@[card](pkc://cid/asset/key)` — v0 future dialect
 *   - `@[card](https://...)` — ordinary URL is not a v0 target
 *   - `@[card](javascript:…)` — foreign scheme
 *   - `[![](asset:a1)](asset:a1)` — clickable-image is a different
 *     notation (§7) and shares no grammar with card
 */
export function parseCardPresentation(
  raw: string,
): ParsedCardPresentation | null {
  if (typeof raw !== 'string') return null;
  const m = CARD_RE.exec(raw);
  if (!m) return null;

  const variantToken = m[1];
  const target = m[2];
  if (typeof target !== 'string') return null;

  if (target === '' || target.trim() === '') return null;
  // No leading / trailing whitespace inside the target either — the
  // canonical form is `@[card](entry:lid)`, not `@[card]( entry:lid )`.
  if (target !== target.trim()) return null;

  let variant: CardVariant;
  if (variantToken === undefined) {
    variant = 'default';
  } else if ((VARIANT_WHITELIST as readonly string[]).includes(variantToken)) {
    variant = variantToken as CardVariant;
  } else {
    return null;
  }

  if (!isValidCardTarget(target)) return null;

  return { variant, target, raw };
}

/**
 * Format a structured card presentation back to its canonical string
 * form. Returns `null` when the target violates v0 grammar or the
 * variant is unknown.
 *
 * `@[card](target)` is the default-variant canonical form. Variant
 * forms emit `@[card:<variant>](target)`.
 */
export function formatCardPresentation(
  input: CardPresentationInput,
): string | null {
  if (input === null || typeof input !== 'object') return null;
  if (typeof input.target !== 'string') return null;
  if (!isValidCardTarget(input.target)) return null;

  const variant = input.variant ?? 'default';
  if (
    variant !== 'default' &&
    !(VARIANT_WHITELIST as readonly string[]).includes(variant)
  ) {
    return null;
  }

  if (variant === 'default') {
    return `@[card](${input.target})`;
  }
  return `@[card:${variant}](${input.target})`;
}

/**
 * True when `label` is a well-formed card presentation label (i.e.
 * the text that would appear inside the `[...]` of the markdown
 * link). Accepts `'card'` and `'card:<variant>'` for known variants.
 *
 * Intended for a future renderer hook (Slice 2) that has access to
 * markdown-it link-open tokens and wants a cheap O(1) dispatch check
 * before committing to the richer `parseCardPresentation` path.
 */
export function isCardPresentationLabel(label: string): boolean {
  if (typeof label !== 'string') return false;
  if (label === 'card') return true;
  if (!label.startsWith('card:')) return false;
  const v = label.slice('card:'.length);
  return (VARIANT_WHITELIST as readonly string[]).includes(v);
}

function isValidCardTarget(target: string): boolean {
  if (target.startsWith('entry:')) {
    return isValidEntryRef(target);
  }
  if (target.startsWith('pkc://')) {
    // Portable reference: only the `entry/` kind is canonical for
    // card in v0. `pkc://<cid>/asset/<key>` is rejected for the same
    // reason `asset:<key>` is — spec §5.4 / §8 list both as
    // ❌ 非対応 for card, see the coordination audit Option C.
    const parsed = parsePortablePkcReference(target);
    return parsed !== null && parsed.kind === 'entry';
  }
  // `asset:<key>` and everything else falls through — future dialect
  // or foreign scheme, either way not a canonical v0 card target.
  return false;
}
