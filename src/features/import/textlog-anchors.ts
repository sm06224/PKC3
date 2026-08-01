/**
 * P6 import: textlog permalink の書換(**fromPkc2 より前段** ── ordering 制約)。
 *
 * PKC2 の textlog は log id(ULID / legacy `log-<ts>-<n>` 等、opaque token)で
 * `entry:X#log/<id>` 系の permalink を張る。PKC3 への変換で log id は body から
 * 消える(日時見出しの markdown 節になる)ため、id → 変換後アンカーの対応表は
 * **id がまだ残っているうちにしか作れない**。
 *
 * 対応先 = 変換で生成される見出し `## YYYY-MM-DD HH:mm:ss[ ★]` の slug
 * (markdown-render が h1-h3 に刻む id と同じ `slugifyHeading` + 衝突 counter)。
 * 時刻精度を落とさない(#day/ への丸めをしない)。
 *
 * ⚠ id は `[A-Za-z0-9_-]+` の **opaque token 前提 ── ULID 形で gate しない**
 * (PKC2 自身が legacy id の全形式を「未解明の曖昧点」と明記している)。
 * 未知 id は書き換えず broken のまま残す(壊れシグナルの保存 ── asset keyMap と
 * 同じ原則)。
 */
import { parseTextlogBody } from '../textlog/textlog-body';
import { formatHeadingTimestamp } from '../flavor/textlog-flavor';
import { extractHeadingsFromMarkdown } from '../markdown/markdown-toc';

/** 1 つの textlog entry について、log id → 変換後見出し slug の対応表を作る。 */
export function buildTextlogAnchorMap(
  pkc2Body: string,
  convertedMarkdown: string,
): Map<string, string> {
  const log = parseTextlogBody(pkc2Body);
  const map = new Map<string, string>();
  if (log.entries.length === 0) return map;
  // 変換後 markdown の見出し列(slug は renderer と同じ衝突 counter で確定済み)を
  // 前から歩き、各 log の期待見出しテキストに順番に一致させる。log text 内の
  // 見出し行が挟まっても順序一致で吸収する(次 log の見出しと同一の行が text 内に
  // あると 1 つ手前に着地しうるが、順序どおり近傍に飛ぶ ── 許容の over-approx)
  const headings = extractHeadingsFromMarkdown(convertedMarkdown);
  let cursor = 0;
  for (const e of log.entries) {
    const star = e.flags.includes('important') ? ' ★' : '';
    const expected = `${formatHeadingTimestamp(e.createdAt)}${star}`;
    for (let i = cursor; i < headings.length; i++) {
      if (headings[i]!.text === expected) {
        map.set(e.id, headings[i]!.slug);
        cursor = i + 1;
        break;
      }
    }
  }
  return map;
}

/** log id の文字集合(PKC2 entry-ref と同じ opaque token)。 */
const ID = '[A-Za-z0-9_-]+';
const DATE = '\\d{4}-\\d{2}-\\d{2}';

/**
 * 変換済み body 群の permalink を書き換える。
 * @param body 変換後の markdown(この中の参照を書き換える)
 * @param selfLid この body の entry lid(fragment-only `#log/<id>` の解決先)
 * @param anchorsByLid textlog lid → (log id → slug)
 * @param firstLogOfDay textlog lid → (yyyy-mm-dd → その日の先頭 log の slug)
 */
export function rewriteTextlogRefs(
  body: string,
  selfLid: string,
  anchorsByLid: ReadonlyMap<string, ReadonlyMap<string, string>>,
  firstLogOfDay: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string {
  const slugOf = (lid: string, id: string): string | null =>
    anchorsByLid.get(lid)?.get(id) ?? null;
  return (
    body
      // entry:X#log/<a>..<b>(range → 先頭 log)/ #log/<id>/<slug>(小見出しは
      // 落として log 見出しへ)/ #log/<id> の 3 形をまとめて処理
      .replace(
        new RegExp(`entry:(${ID})#log/(${ID})(?:\\.\\.${ID}|/${ID})?`, 'g'),
        (whole, lid: string, id: string) => {
          const slug = slugOf(lid, id);
          return slug ? `entry:${lid}#${slug}` : whole;
        },
      )
      // entry:X#day/<date> → その日の先頭 log の slug(day 節は変換後に存在しない)
      .replace(
        new RegExp(`entry:(${ID})#day/(${DATE})`, 'g'),
        (whole, lid: string, date: string) => {
          const slug = firstLogOfDay.get(lid)?.get(date);
          return slug ? `entry:${lid}#${slug}` : whole;
        },
      )
      // fragment-only #log/<id>(同一 entry 内 context-relative)── markdown link の
      // 括弧内のみ対象(散文中の偶然一致を書き換えない)
      .replace(
        new RegExp(`\\(#log/(${ID})(?:\\.\\.${ID}|/${ID})?\\)`, 'g'),
        (whole, id: string) => {
          const slug = slugOf(selfLid, id);
          return slug ? `(#${slug})` : whole;
        },
      )
      // legacy 裸 fragment entry:X#<id>(emit されないが受理されていた形)──
      // fragment がその entry の既知 log id のときだけ書き換える
      .replace(
        new RegExp(`entry:(${ID})#(${ID})`, 'g'),
        (whole, lid: string, frag: string) => {
          const slug = slugOf(lid, frag);
          return slug ? `entry:${lid}#${slug}` : whole;
        },
      )
  );
}

/** ローカル日付 key(PKC2 の day section 規約と同じ)。 */
export function localDateKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** textlog lid → (日付 → 先頭 log の slug)を対応表から組む。 */
export function buildFirstLogOfDay(
  pkc2Body: string,
  anchors: ReadonlyMap<string, string>,
): Map<string, string> {
  const log = parseTextlogBody(pkc2Body);
  const byDay = new Map<string, string>();
  for (const e of log.entries) {
    const day = localDateKey(e.createdAt);
    const slug = anchors.get(e.id);
    if (day !== '' && slug !== undefined && !byDay.has(day)) byDay.set(day, slug);
  }
  return byDay;
}
