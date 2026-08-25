/**
 * `pkc.createEntry` の引数を検める(#189 / C-4 段②)。
 *
 * 🔴 **これは「外から書かせる」唯一の口である。** だから受け取り方に規律を置く:
 *
 * 1. **題名は引数で受ける。** 本文の frontmatter から拾わない ── 拾うと
 *    「取り込んだ文章の 1 行目がたまたま `---` だった」だけで meta が仕込まれる
 * 2. **上限を持つ。** 封筒の粗さは `message-bridge` が見るが、
 *    ⚠ **本文だけの上限は別に要る**(封筒が小さくても本文が長い形は作れる)
 * 3. **archetype は受けない。** 段② が作るのは `text` だけ ── 種類を外から
 *    選ばせると、増えるたびに外向きの面が広がる。増やすのは要ると分かってから
 * 4. 🔑 **題名が無いときは本文の 1 行目から作る。** ⚠ 空のまま作らない ──
 *    一覧に「無題」が並ぶのは、取り込んだ本人が後で探せなくなる形である
 *
 * ⚠ この module は pure(browser API を触らない)。
 */

/** 題名の上限。⚠ 一覧の 1 行に収まらない長さは、そこで畳んでも意味が無い。 */
export const MAX_TITLE = 200;

/** 本文の上限。⚠ 封筒の上限(256KB)より小さく採る ── 封筒には他も載る。 */
export const MAX_BODY = 200 * 1024;

/** 題名が無いときの最後の手。 */
export const FALLBACK_TITLE = '取り込んだノート';

export interface CreateEntryInput {
  title: string;
  body: string;
}

export type ParamsResult =
  | { ok: true; input: CreateEntryInput }
  | { ok: false; message: string };

/** 制御文字を落として 1 行にする(題名は 1 行のものである)。 */
function oneLine(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // ⚠ 生バイトの制御文字を題名に入れない(repo-hygiene と同じ向き)
    if (code < 0x20 || code === 0x7f) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 本文の最初の「中身のある行」から題名を作る。 */
export function titleFromBody(body: string): string {
  for (const line of body.split('\n')) {
    // 🔑 見出しの `#` は落とす(題名に `#` を残さない)
    const t = oneLine(line.replace(/^\s*#{1,6}\s*/, ''));
    if (t !== '') return t.slice(0, MAX_TITLE);
  }
  return FALLBACK_TITLE;
}

export function parseCreateEntryParams(params: unknown): ParamsResult {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p !== 'object' || Array.isArray(params)) {
    return { ok: false, message: 'params は object である必要があります' };
  }
  if (p.body !== undefined && typeof p.body !== 'string') {
    return { ok: false, message: 'body は文字列である必要があります' };
  }
  if (p.title !== undefined && typeof p.title !== 'string') {
    return { ok: false, message: 'title は文字列である必要があります' };
  }
  const body = typeof p.body === 'string' ? p.body : '';
  if (body.length > MAX_BODY) {
    return { ok: false, message: `body が長すぎます(上限 ${MAX_BODY} 文字)` };
  }
  const given = typeof p.title === 'string' ? oneLine(p.title).slice(0, MAX_TITLE) : '';
  const title = given !== '' ? given : titleFromBody(body);
  return { ok: true, input: { title, body } };
}
