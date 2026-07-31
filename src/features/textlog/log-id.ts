/**
 * ULID-based log entry ID generator.
 *
 * Implements the Slice 1 decision from
 * `docs/development/textlog-viewer-and-linkability-redesign.md`:
 *
 * - New log entries receive a 26-character Crockford Base32 ULID
 *   (48-bit millisecond timestamp + 80-bit randomness).
 * - Existing legacy IDs (e.g. `log-1744185600000-1`) are **never**
 *   rewritten. The resolver treats any non-empty opaque token of
 *   `[A-Za-z0-9_-]+` as a log-id, regardless of format.
 * - ULIDs are k-sortable so newly generated IDs compare
 *   lexicographically in time order; the rest of the system must
 *   continue to treat **storage order** (append order) as the source
 *   of truth — never derive chronological order from ID sort.
 *
 * Pure. No DOM access. `now` and `random` are injectable so tests
 * can be fully deterministic.
 *
 * Bundle-size note: we deliberately do not pull in a third-party
 * ULID package. The full Crockford alphabet + two tight loops cost
 * roughly 60 lines here and keep `dist/bundle.js` clean.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const TOTAL_LEN = TIME_LEN + RANDOM_LEN; // 26
const TIME_MAX = 2 ** 48 - 1;

export interface LogIdOptions {
  /** Override the timestamp source. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Override the randomness source. Must return a value in `[0, 1)`.
   * Defaults to `Math.random`.
   *
   * For our use case (single-user local knowledge container) the
   * probability of collision between two IDs generated in the same
   * millisecond is already `~ 1 / 32^16`, which is well below the
   * rate at which a human can append log entries. We therefore do
   * not reach for `crypto.getRandomValues` by default — keeping the
   * module dependency-free for the features layer.
   */
  random?: () => number;
}

/**
 * Generate a 26-character ULID.
 *
 * Throws only when `now()` returns a value that cannot be encoded
 * into the 48-bit timestamp slot — in practice this requires a
 * negative timestamp or a date past year 10889, both of which are
 * clearly caller bugs rather than runtime conditions.
 */
export function generateLogId(options: LogIdOptions = {}): string {
  const nowFn = options.now ?? Date.now;
  const randFn = options.random ?? Math.random;
  const t = Math.floor(nowFn());
  if (!Number.isFinite(t) || t < 0 || t > TIME_MAX) {
    throw new Error(`generateLogId: timestamp out of range (${t})`);
  }
  return encodeTime(t) + encodeRandom(randFn);
}

/** Left-padded Crockford Base32 encoding of a non-negative integer. */
function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = t % ENCODING_LEN;
    out = ENCODING.charAt(mod) + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(rand: () => number): string {
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    // `% ENCODING_LEN` guards against pathological `rand()` returning 1.0.
    const idx = Math.floor(rand() * ENCODING_LEN) % ENCODING_LEN;
    out += ENCODING.charAt(idx < 0 ? 0 : idx);
  }
  return out;
}

/**
 * True when `id` matches the ULID shape (26 Crockford Base32 chars).
 *
 * Used by debugging / audit tooling only. Resolvers must **not**
 * gate on this — legacy IDs are equally valid addresses.
 */
export function isUlid(id: string): boolean {
  if (typeof id !== 'string' || id.length !== TOTAL_LEN) return false;
  for (let i = 0; i < id.length; i++) {
    if (ENCODING.indexOf(id.charAt(i)) === -1) return false;
  }
  return true;
}
