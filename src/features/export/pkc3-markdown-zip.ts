/**
 * P6d 段④: md ZIP(`.md.zip`)── **PKC3 を捨てても読める形で外に出す**。
 *
 * 1 entry = 1 `.md`、添付は `assets/<key>.<ext>`。本文中の `asset:<key>` は
 * **相対パスへ書き換える**ので、展開したフォルダをそのまま任意の markdown
 * ビューアで開ける ── ここが「外に出す」の意味であって、書き換えないと
 * PKC3 の外では画像が 1 枚も出ない。
 *
 * ⚠ **片道**。frontmatter に居場所の無いもの(relations / revisions)は落ちる。
 * PKC2 は落ちたことを user に言わずに出していた ── PKC3 は
 * **manifest に刻み、書出し後に画面で言う**(設計 doc §3-2)。
 *
 * ## 🔴 本文は**原文のまま**通す(parse → 再構築をしない)
 * frontmatter を parse して `serializeFrontmatter` で組み直すと、
 * ミニ YAML が未対応の構文(ネスト / ブロックスカラー / 非 ASCII キー /
 * コメント)を**無言で落とす**。16KB を超える frontmatter に至っては
 * `parseFrontmatter` が丸ごと諦めるので、**frontmatter が消えたうえに
 * 本文まで削れた** `.md` が出る(review H-1 で実測:17,584 文字 → 65 文字)。
 *
 * このリポジトリは既に `frontmatter.ts` に
 * 「**既存 body の部分書換には使わず `spliceFrontmatterKeys` を使う**」と
 * 明記してある(P3-4 review #5)。ここもその規律に従う ──
 * `parseFrontmatter` は**読むだけ**、書くのは原文 splice。
 *
 * ## 履歴の「落ちた件数」を数えない理由
 * revision の**本数**を数えるには entry ごとに `listRevisionMetas` を呼ぶしかなく、
 * 5000 件のノートで 5000 往復する ── **数字 1 個のために**。`listRevisionLids`
 * は 1 往復で済むので、**履歴を持つノートの件数**で言う。
 * 「N 本の履歴」ではなく「N 件のノートの履歴」と言えば嘘にならない。
 */
import {
  parseFrontmatter,
  spliceFrontmatterKeys,
  type FrontmatterValue,
} from '../markdown/frontmatter';
import { ZipWriter } from './zip-writer';
import type { ArchiveSource } from './pkc3-archive';

export const MD_FORMAT = 'pkc3-markdown';
export const MD_VERSION = 1;
const BODY_BATCH_BYTES = 4 * 1024 * 1024;
const ASSET_DIR = 'assets/';
/** 同じ注意を entry 数ぶん並べない(3000 件の `<li>` を作らせない)。 */
const WARN_CAP = 10;
/**
 * **包含**の判定に使う広い走査(段③ 可搬 HTML と同じ書式)。
 * ⚠ 書換の狭い規則と**取り違えない** ── 包含を狭くすると、アプリでは生きている
 * 参照を取りこぼして添付が消える(review H-1)。誤差は false-keep 側だけに出す。
 */
const ASSET_REF_RE = /asset:([A-Za-z0-9_.-]+)/g;

export interface MarkdownZipResult {
  blob: Blob;
  warnings: string[];
  counts: { entries: number; assets: number };
  /** 片道で落ちたもの。**manifest と同じ数字**を UI へ渡す。 */
  dropped: { relations: number; revisionEntries: number };
}

/**
 * mime → 拡張子。⚠ **付けないと外で開けない**(OS はほぼ拡張子で判定する)。
 * 知らない mime は `.bin` ── 嘘の拡張子を付けるより開けない方がまし。
 */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function extForMime(mime: string | null): string {
  if (!mime) return 'bin';
  return EXT_BY_MIME[mime.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
}

/** Windows が**ファイル名として使えない**予約語(拡張子を付けても駄目)。 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * 題名 → ファイル名。**CJK は残す**(実データの題名はほぼ日本語で、
 * ローマ字化すると user が自分のノートを見つけられない)。
 */
export function slugForTitle(title: string): string {
  // ⚠ 制御文字は正規表現に書かない(no-control-regex。範囲を読み違えやすく、
  // PKC2 では生バイトがファイル名に入っていた)
  const cleaned = [...title]
    .map((ch) => (ch.codePointAt(0)! < 0x20 || ch === '\u007f' ? '-' : ch))
    .join('');
  const s = cleaned
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
  // ⚠ `slice` はサロゲートペアを割る(絵文字や一部の漢字が壊れる)
  const capped = [...s].slice(0, 60).join('').replace(/[-.\s]+$/, '');
  if (capped === '') return 'untitled';
  // ⚠ Win32 は**最初のドットより前**でデバイス解決する ── `con.txt.md` も作れない
  return RESERVED.has(capped.split('.')[0]!.toLowerCase()) ? `${capped}-` : capped;
}

/**
 * ファイル名の同一視キー。⚠ 小文字化だけでは足りず **NFC 正規化も要る** ──
 * macOS(APFS/HFS+)は正規化に依存せず同一視するので、NFC と NFD の「が」を
 * 両方入れると展開時に片方が消える(review M-2 で実測)。
 */
const fold = (s: string): string => s.normalize('NFC').toLowerCase();

/**
 * ZIP 内で一意な名前を配る。
 *
 * ⚠ **大文字小文字(と正規化)を同一視して**衝突を見る。macOS / Windows は
 * `Memo.md` と `memo.md` を同じファイルとして展開するので、両方入れると
 * **ノートが消える**(review H-3 で実測:3 件入れて展開したら 1 件だけ残った)。
 * ⚠ 番号は base ごとに継続する ── 毎回 2 から数え直すと同題 8000 件で O(k²)
 * になる(実測 7.6 秒 → 159ms)。
 */
class NameAllocator {
  private readonly taken = new Set<string>();
  private readonly next = new Map<string, number>();

  claim(base: string, ext: string): string {
    const key = fold(`${base}.${ext}`);
    if (!this.taken.has(key)) {
      this.taken.add(key);
      return `${base}.${ext}`;
    }
    let n = this.next.get(fold(base)) ?? 2;
    for (;;) {
      const name = `${base}-${n}.${ext}`;
      n++;
      if (!this.taken.has(fold(name))) {
        this.taken.add(fold(name));
        this.next.set(fold(base), n);
        return name;
      }
    }
  }
}

/** PKC3 側が正とするメタ(最小)。値のあるものだけ書く(`null` を刻まない)。 */
function pkc3Meta(m: {
  title: string;
  archetype: string;
  created_at: string | null;
  updated_at: string | null;
}): Record<string, FrontmatterValue> {
  const meta: Record<string, FrontmatterValue> = { title: m.title, archetype: m.archetype };
  if (m.created_at) meta['created_at'] = m.created_at;
  if (m.updated_at) meta['updated_at'] = m.updated_at;
  return meta;
}

/** markdown のリンクラベルに入れて安全な形にする(`]` 1 個でリンクが死ぬ)。 */
function escapeLabel(s: string): string {
  // ⚠ 改行が入ると markdown-it が段落を割ってリンクが死ぬ ── 1 行に潰す
  return s.replace(/\s*\n\s*/g, ' ').replace(/[[\]\\]/g, '\\$&');
}

/**
 * 🔴 `asset:<key>` を**リンク/画像の宛先に限って**相対パスへ書き換える。
 *
 * ⚠ 生テキスト全体を舐めてはいけない(review H-2 で実測した誤爆):
 * - コードフェンス内の `asset:ast-1`(= 書式の説明文)が改変される
 * - `https://example.com/asset:ast-1/path` のような **URL が壊れる**
 * - 素の文章に書いた `asset:ast-1` が勝手にパスになる
 *
 * アプリ本体(`markdown-render.ts`)は `href` / `src` の宛先だけを見るので、
 * ここも**宛先が `asset:` で始まるときだけ**書き換える。加えて
 * fence / inline code は丸ごと飛ばす。
 */
function rewriteAssetLinks(
  text: string,
  resolve: (key: string) => string | undefined,
): { text: string; openFence: string | null } {
  let out = '';
  let i = 0;
  let openFence: string | null = null;
  const n = text.length;
  const atLineStart = (): boolean => i === 0 || text[i - 1] === '\n';
  /** 直前の連続バックスラッシュが奇数個 = この文字はエスケープされている。 */
  const escaped = (): boolean => {
    let k = i - 1;
    let c = 0;
    while (k >= 0 && text[k] === '\\') {
      c++;
      k--;
    }
    return c % 2 === 1;
  };

  while (i < n) {
    const ch = text[i]!;

    // ── コードフェンス(``` / ~~~ が行頭)は閉じるまで丸ごと通す。
    // ⚠ 閉じ fence は **3 スペースまで字下げできる**(CommonMark)── 桁 0 固定で
    // 探すと「閉じない fence」と誤判定して**以降の本文を全部飲む**(review H-1)
    if ((ch === '`' || ch === '~') && atLineStart()) {
      const m = /^(`{3,}|~{3,})/.exec(text.slice(i));
      if (m) {
        const fence = m[1]!;
        const closeRe = new RegExp(`\\n {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \t]*(?:\\n|$)`);
        const rest = text.slice(i + fence.length);
        const cm = closeRe.exec(rest);
        if (cm) {
          const end = i + fence.length + cm.index + cm[0].length;
          out += text.slice(i, end);
          i = end;
        } else {
          out += text.slice(i); // 閉じない fence = ここから末尾まで全部コード
          i = n;
          openFence = fence;
        }
        continue;
      }
    }

    // ── インラインコード(バッククォート連の対応する閉じまで)。
    // ⚠ markdown-it は**ブロックを越えて**コードスパンを作らない ── 空行を
    // 跨いで対応付けると、野良バッククォート 2 個の間が丸ごと飛ぶ(review H-1)
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const limit = text.indexOf('\n\n', i);
      const close = text.indexOf(run, i + run.length);
      if (close !== -1 && (limit === -1 || close < limit)) {
        out += text.slice(i, close + run.length);
        i = close + run.length;
        continue;
      }
    }

    // ── `](asset:key)` / `](<asset:key>)`。**宛先が asset: で始まるときだけ**
    if (ch === ']' && text[i + 1] === '(' && !escaped()) {
      const m = /^\]\(\s*<?(asset:([A-Za-z0-9_.-]+))>?(\s*(?:"[^"]*"|'[^']*'))?\s*\)/.exec(
        text.slice(i),
      );
      if (m) {
        const path = resolve(m[2]!);
        if (path !== undefined) {
          out += `](${path}${m[3] ?? ''})`;
          i += m[0]!.length;
          continue;
        }
      }
    }

    out += ch;
    i++;
  }
  return { text: out, openFence };
}

/**
 * md ZIP を書く。
 * @throws entry 0 件のときは**断る**(「書き出したつもりで空」を作らない)
 */
export async function writeMarkdownZip(
  src: ArchiveSource,
  exportedAt: string,
): Promise<MarkdownZipResult> {
  const warnings: string[] = [];
  /**
   * 同種の注意は上限まで ── 3000 件並べると誰も読まない(review L-2)。
   * ⚠ 畳んだ件数を言うとき、**内部の bucket 名を user に見せない**
   * (`overwrite-title` のような英字スラグが日本語 UI に出ていた ── review M-1)。
   */
  const counted = new Map<string, { n: number; label: string }>();
  const warnCapped = (bucket: string, label: string, message: string): void => {
    const c = counted.get(bucket) ?? { n: 0, label };
    c.n++;
    counted.set(bucket, c);
    if (c.n <= WARN_CAP) warnings.push(message);
  };

  const metas = await src.listEntryMetas();
  // ⚠ 断るなら読み出しの前に断る(捨てるためだけに store を舐めない)
  if (metas.length === 0) throw new Error('書き出せる entry が 1 件もありません');
  const metaOf = new Map(metas.map((m) => [m.lid, m]));

  // 添付の拡張子は**本文を書く前に**要る(参照を相対パスへ書き換えるため)
  const assetMetas = await src.listAssetMetas();
  const names = new NameAllocator();
  const mimeOf = new Map(assetMetas.map((a) => [a.key, a.mime]));
  // ⚠ 名前は**大文字小文字を同一視して**一意にする(`AST-1` と `ast-1` は
  // macOS / Windows で同じファイル ── 片方が別の画像で上書きされる)
  const pathOf = new Map(
    assetMetas.map((a) => [a.key, ASSET_DIR + names.claim(a.key, extForMime(a.mime))]),
  );
  /** 本文に現れうる添付 key(frontmatter の中に埋もれた参照も拾う)。 */
  const KEYISH = /[A-Za-z0-9_.-]*ast-[A-Za-z0-9_.-]+/g;

  const w = new ZipWriter();
  const mdNames = new NameAllocator();
  const used = new Set<string>();
  let entryCount = 0;
  let after: { entryOrder: number; lid: string } | undefined;

  for (;;) {
    const { rows, done, next } = await src.listBodies(after, BODY_BATCH_BYTES);
    for (const r of rows) {
      const m = metaOf.get(r.lid);
      if (!m) {
        warnCapped('orphan-body', '一覧に無い entry の注意', `本文はあるが一覧に無い entry を飛ばしました: ${r.lid}`);
        continue;
      }
      // ⚠ **読むだけ**。書くのは原文 splice(冒頭の解説)
      const parsed = parseFrontmatter(r.body);
      for (const pw of parsed.warnings) {
        warnCapped(
          `fm-${pw.kind}`,
          'frontmatter の読み取りの注意',
          `frontmatter を読み切れませんでした(${pw.detail}): ${m.title || m.lid}`,
        );
      }

      const mine = pkc3Meta(m);
      // ⚠ cap 超過で meta が空になった frontmatter では、上書きしたかどうかを
      // **判定できない**。黙ると「上書きしていない」に見える(review H-2)
      const blind = parsed.warnings.some((pw) => pw.kind === 'size_limit');
      if (blind) {
        warnCapped(
          'fm-blind',
          'frontmatter の読み取りの注意',
          `frontmatter を読み切れないので title / archetype を上書きしたか確認できません: ${m.title || m.lid}`,
        );
      } else {
        for (const [k, v] of Object.entries(mine)) {
          if (k in parsed.meta && parsed.meta[k] !== v) {
            warnCapped(
              `overwrite-${k}`,
              `frontmatter の ${k} の上書き`,
              `frontmatter の ${k} を entry の値で上書きしました: ${m.title || m.lid}`,
            );
          }
        }
      }

      // 🔴 **包含は広く、書換は狭く**(review H-1)。
      // 書き換えの規則(リンクの宛先だけ)を「ZIP に入れるか」の判定にも使うと、
      // 参照リンク定義 / 字下げされた閉じ fence / 段落を跨ぐバッククォート のように
      // **アプリでは生きている参照**を取りこぼし、添付が丸ごと消える。しかも
      // 「参照されていない」と嘘の注意まで出る。
      // このリポジトリの規律は `asset-gc.ts` にある ── 誤差は **false-keep 側に
      // しか出さない**(無関係な散文が key を偶然含む)。段③(可搬 HTML)も
      // 同じく本文全体の raw 走査で包含を決めている。ここだけ狭くしない
      const mark = (token: string): string | undefined => {
        // 末尾の句読点を剥がして引き直す(`asset:ast-1.` のような書き方)
        const key = pathOf.has(token) ? token : token.replace(/[.\-_]+$/, '');
        if (!pathOf.has(key)) return undefined;
        used.add(key);
        return pathOf.get(key);
      };
      ASSET_REF_RE.lastIndex = 0;
      for (let mm = ASSET_REF_RE.exec(r.body); mm; mm = ASSET_REF_RE.exec(r.body)) mark(mm[1]!);
      // frontmatter に埋もれた参照(`attachment.asset_key` / `extra` の JSON)。
      // ⚠ **原文全体**に掛ける ── parse できなかった frontmatter の中にも参照は居る
      KEYISH.lastIndex = 0;
      for (let mm = KEYISH.exec(r.body); mm; mm = KEYISH.exec(r.body)) mark(mm[0]);

      // 添付 entry のリンク行に使う参照(こちらは meta が読めた時だけ = best effort)
      const fmRefs: Array<{ key: string; label: string }> = [];
      for (const [k, v] of Object.entries(parsed.meta)) {
        if (!k.endsWith('asset_key') || typeof v !== 'string' || v === '') continue;
        if (!pathOf.has(v) || fmRefs.some((x) => x.key === v)) continue;
        const nameKey = `${k.slice(0, -'asset_key'.length)}name`;
        const label =
          typeof parsed.meta[nameKey] === 'string' && parsed.meta[nameKey] !== ''
            ? String(parsed.meta[nameKey])
            : m.title || v;
        fmRefs.push({ key: v, label });
      }

      // 🔑 本文の `asset:` 参照 → 相対パス(**宛先だけ**。fence / 素の文章は触らない)。
      // ⚠ **原文全体に掛ける**。`parsed.body` を使って前後を継ぐ形にすると壊れる ──
      // `parseFrontmatter` は返す body の **CRLF を LF へ正規化する**ので、
      // 「残骸は原文の suffix」という長さ演算が CRLF の本文で崩れ、
      // 切り出し位置がずれて**本文に 1 文字混入した**(実測で踏んだ)。
      // 宛先限定の書き換えなら frontmatter 部分を通しても実害が無い
      const { text, openFence } = rewriteAssetLinks(r.body, (key) => pathOf.get(key));

      // 書き換えられずに残った参照は**外では開けない** ── 黙って出さない
      ASSET_REF_RE.lastIndex = 0;
      let leftover = 0;
      for (let mm = ASSET_REF_RE.exec(text); mm; mm = ASSET_REF_RE.exec(text)) {
        if (mark(mm[1]!) !== undefined) leftover++;
      }
      if (leftover > 0) {
        warnCapped(
          'leftover-ref',
          'リンクの形になっていない添付参照の注意',
          `リンクの形になっていない添付参照 ${leftover} 件はそのまま残ります(外では開けません): ${m.title || m.lid}`,
        );
      }

      // 添付 entry は body が frontmatter だけ ── 何も書かないと**空の .md** になる。
      // 外で開いて中身に辿り着けるよう、参照行を 1 本だけ足す
      const extra: string[] = [];
      for (const ref of fmRefs) {
        const p = pathOf.get(ref.key)!;
        if (text.includes(p) || extra.some((l) => l.includes(p))) continue;
        const isImage = (mimeOf.get(ref.key) ?? '')?.startsWith('image/') ?? false;
        extra.push(`${isImage ? '!' : ''}[${escapeLabel(ref.label)}](${p})`);
      }

      // 🔴 本文は原文のまま。PKC3 のメタは**原文へ splice** する
      let doc = text;
      if (extra.length > 0) {
        // ⚠ 本文が**開いたままの fence** で終わっていると、足した参照行が
        // コードブロックの中に入って死ぬ ── 添付 entry では唯一の導線(review M-3)
        const close = openFence ? `${doc.endsWith('\n') ? '' : '\n'}${openFence}\n` : '';
        doc += close + `${doc.endsWith('\n') || doc === '' ? '' : '\n'}\n${extra.join('\n')}\n`;
      }
      doc = spliceFrontmatterKeys(doc, mine);

      await w.add(mdNames.claim(slugForTitle(m.title), 'md'), [doc]);
      entryCount++;
    }
    if (done || !next) break;
    if (
      after !== undefined &&
      !(next.entryOrder > after.entryOrder ||
        (next.entryOrder === after.entryOrder && next.lid > after.lid))
    ) {
      throw new Error('本文の読み出しが進みません(カーソルが前進していません)');
    }
    after = next;
  }

  if (entryCount === 0) throw new Error('書き出せる entry が 1 件もありません');
  // 🔴 一覧にあって本文が返らなかった ── 黙って消すと manifest の件数まで嘘になる
  if (entryCount < metas.length) {
    warnings.push(`一覧にあって本文が取れなかった entry が ${metas.length - entryCount} 件あります`);
  }

  // ── 添付: **参照されているものだけ**。中身は Blob をそのまま(コピーしない)
  const missing: string[] = [];
  let assetCount = 0;
  for (const a of assetMetas) {
    if (!used.has(a.key)) continue;
    const blob = await src.getAssetBlob(a.key);
    if (!blob) {
      // 参照は本文に残したまま ── 壊れた参照を隠さない(P6c §4-A と同じ規約)
      missing.push(a.key);
      warnCapped('missing-asset', '中身の無い添付の注意', `添付の中身が見つかりませんでした: ${a.key}`);
      continue;
    }
    await w.add(pathOf.get(a.key)!, [blob]);
    assetCount++;
  }
  const skipped = assetMetas.length - used.size;
  if (skipped > 0) {
    warnings.push(`どの本文からも参照されていない添付 ${skipped} 件は含めませんでした`);
  }

  // ── 落ちるものを刻む(§3-2)
  const relations = (await src.listRelations()).length;
  const revisionEntries = (await src.listRevisionLids()).length;
  if (relations > 0) warnings.push(`関連 ${relations} 件は markdown に居場所が無いので落ちます`);
  if (revisionEntries > 0) {
    warnings.push(`履歴を持つノート ${revisionEntries} 件の履歴は落ちます`);
  }
  // 上限で畳んだぶんを最後に言う(黙って減らすと「全部出た」に見える)
  for (const c of counted.values()) {
    if (c.n > WARN_CAP) warnings.push(`${c.label}はほか ${c.n - WARN_CAP} 件あります`);
  }

  await w.add('manifest.json', [
    JSON.stringify(
      {
        format: MD_FORMAT,
        version: MD_VERSION,
        exported_at: exportedAt,
        source_cid: src.cid,
        title: src.title,
        // 🔴 「戻せない」を**機械可読に**刻む。後から見分けられない形にしない
        reversible: false,
        note: 'PKC3 から外へ出すための片道形式です。関連・履歴は含まれません。',
        entry_count: entryCount,
        asset_count: assetCount,
        dropped: { relations, revision_entries: revisionEntries },
        missing_assets: missing,
      },
      null,
      2,
    ),
  ]);

  return {
    blob: w.finish(),
    warnings,
    counts: { entries: entryCount, assets: assetCount },
    dropped: { relations, revisionEntries },
  };
}
