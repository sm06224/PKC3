/**
 * attachment フレーバー: frontmatter(asset_key / mime ほか)+ 説明 markdown。
 * asset の bytes は IDB Blob 側(§4.2)── body はメタとポインタのみを持ち、
 * 表示は `lendObjectUrl`(dispose 規律)で行う(P4 で結線)。
 */
import {
  parseFrontmatter,
  serializeFrontmatter,
  type FrontmatterValue,
} from '../markdown/frontmatter';
import { type FlavorSpec } from './flavor-spec';
import { extractSchedule } from '../schedule/schedule-keys';

/** PKC3 での新規添付 entry の body(P4a)。frontmatter メタ + 空の説明領域。 */
export function attachmentBody(meta: {
  name: string;
  mime: string;
  size: number;
  assetKey: string;
  hash?: string | null;
}): string {
  const fm: Record<string, FrontmatterValue> = {
    'attachment.name': meta.name,
    'attachment.mime': meta.mime,
    'attachment.size': meta.size,
    'attachment.asset_key': meta.assetKey,
  };
  if (meta.hash) fm['attachment.hash'] = meta.hash;
  return serializeFrontmatter(fm);
}

/** 表示・DL が使う読み口(単一の解釈点)。不足 field は null。 */
export function readAttachmentMeta(body: string): {
  name: string;
  mime: string;
  size: number | null;
  assetKey: string | null;
} {
  const { meta } = parseFrontmatter(body);
  return {
    name: typeof meta['attachment.name'] === 'string' ? meta['attachment.name'] : '',
    mime:
      typeof meta['attachment.mime'] === 'string'
        ? meta['attachment.mime']
        : 'application/octet-stream',
    size: typeof meta['attachment.size'] === 'number' ? meta['attachment.size'] : null,
    assetKey:
      typeof meta['attachment.asset_key'] === 'string'
        ? meta['attachment.asset_key']
        : null,
  };
}

/**
 * 🔴 **改名欄が「いまのファイル名」を持つ印**(#1264 §1)。⚠ 欄の字(題名)とファイル名が
 * 食い違っているかを、**欄を離れたとき / Enter のとき**に判定するために描く。
 * 判定は `attachmentFileName(題名, いまの名前) !== いまの名前` の 1 本(規則を 2 本持たない)。
 */
export const ATTACHMENT_NAME_ATTR = 'data-pkc-attachment-name';

/**
 * 🔴 **添付の改名欄で打った字から、ダウンロードのファイル名を作る**(#1220 穴②、裁定 A)。
 *
 * > user の物語:添付の名前の欄に「請求書」と打った。ノートの題名が「請求書」になり、
 * > ダウンロードしたファイルも「請求書.pdf」になってほしい(拡張子を打ち直させない)。
 *
 * ⚠ 中身は変わらない(種類と大きさは中身から決まる)ので、**拡張子は偽らせない**:
 *   ① 打った字が元の拡張子で終わっていれば、そのまま ② 拡張子が無ければ元の拡張子を足す
 *   ③ **別の拡張子で終わっていても変えない** ── 元の拡張子を付け直す
 *   (元 `scan.pdf` に `請求書.txt` → `請求書.txt.pdf`。`.txt` に見せかけた pdf を作らない)。
 * ⚠ 元が拡張子を持たない(`README` / `.gitignore` のように先頭だけが `.`)なら、打った字のまま。
 * ⚠ 拡張子は**最後の `.` から後ろ**だけ(`a.tar.gz` なら `.gz`)。大文字小文字は区別せず比べる
 *   (`.PDF` と `.pdf` は同じ拡張子)。空白を含む後ろ(`報告 v1.2 最終`)は拡張子と見なさない。
 * ⚠ ファイル名に使えない字(`/ \ : * ? " < > |` と制御文字)は `_` に置き換える。
 *   ⚠ 書き出しの名前の規則(`export/file-name.ts` の `safeName`)は**別物**:あちらは `-` に
 *   置き換え・空白も落とし・60 字で切る(書き出す一式の名前用)。ここは user が付けた名前を
 *   できるだけそのまま残す側なので、規則を流用すると名前が黙って縮む。
 * ⚠ 打った字は前後の空白を落とす。落とした後に何も残らなければ元の名前のまま。
 *
 * @param typed    改名欄に打たれた字(ノートの題名と同じ字)
 * @param original いま本文にあるファイル名(`attachment.name`)── 呼び側は **disk の値**を渡す
 */
export function attachmentFileName(typed: string, original: string): string {
  const cleaned = [...typed.trim()]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      // ⚠ 制御文字は正規表現に書かない(no-control-regex / 生バイト混入の予防)
      return c < 0x20 || c === 0x7f || '\\/:*?"<>|'.includes(ch) ? '_' : ch;
    })
    .join('');
  if (cleaned === '') return original;
  const dot = original.lastIndexOf('.');
  // 先頭だけの `.`(隠しファイル名)と、末尾の `.`(拡張子が空)は拡張子と見なさない
  if (dot <= 0 || dot === original.length - 1) return cleaned;
  const ext = original.slice(dot);
  // ⚠ 空白を含む後ろ(`報告 v1.2 最終`)は拡張子ではない ── 足すと名前が壊れる
  if (/\s/.test(ext)) return cleaned;
  // ⚠ 拡張子だけを打った(`.pdf`)ときは「名前が無い」ので足す(`.pdf.pdf`)
  if (cleaned.length > ext.length && cleaned.toLowerCase().endsWith(ext.toLowerCase())) return cleaned;
  return cleaned + ext;
}

/**
 * PKC2 attachment-presenter.ts の AttachmentBody と同じ field 集合・同じ寛容 parse。
 * launcher / extension 系のメタ(#790 / #796 / #926 / #928)も欠損なく写す。
 */
interface Pkc2Attachment {
  name: string;
  mime: string;
  size?: number;
  asset_key?: string;
  data?: string; // legacy: base64 が body に内蔵されている旧形式
  sandbox_allow?: string[];
  registered_as_app?: boolean;
  app_icon?: string;
  app_icon_asset_key?: string;
  pkc_extension?: boolean;
  startup?: boolean;
  extension_manifest?: { tier?: 'sandboxed' | 'trusted'; capabilities?: string[] };
  launcher_url?: string;
  app_group?: string;
  app_order?: number;
  /** 既知 field 以外の残余(未知 / 将来 field)。黙って落とさず保全する。 */
  extra?: Record<string, unknown>;
}

/** 既知 field 集合(PKC2 AttachmentBody の全 field。data は legacy 検査用)。 */
const KNOWN_ATTACHMENT_KEYS: ReadonlySet<string> = new Set([
  'name',
  'mime',
  'size',
  'asset_key',
  'data',
  'sandbox_allow',
  'registered_as_app',
  'app_icon',
  'app_icon_asset_key',
  'pkc_extension',
  'startup',
  'extension_manifest',
  'launcher_url',
  'app_group',
  'app_order',
]);

function parsePkc2Attachment(body: string): Pkc2Attachment {
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    const manifest =
      p.extension_manifest && typeof p.extension_manifest === 'object'
        ? (p.extension_manifest as Record<string, unknown>)
        : undefined;
    const tier =
      manifest?.tier === 'trusted' || manifest?.tier === 'sandboxed'
        ? manifest.tier
        : undefined;
    const capabilities = Array.isArray(manifest?.capabilities)
      ? manifest.capabilities.filter((c): c is string => typeof c === 'string')
      : undefined;
    return {
      name: typeof p.name === 'string' ? p.name : '',
      mime: typeof p.mime === 'string' ? p.mime : 'application/octet-stream',
      size: typeof p.size === 'number' ? p.size : undefined,
      asset_key: typeof p.asset_key === 'string' ? p.asset_key : undefined,
      data: typeof p.data === 'string' ? p.data : undefined,
      sandbox_allow: Array.isArray(p.sandbox_allow)
        ? p.sandbox_allow.filter((v): v is string => typeof v === 'string')
        : undefined,
      registered_as_app:
        typeof p.registered_as_app === 'boolean' ? p.registered_as_app : undefined,
      app_icon: typeof p.app_icon === 'string' ? p.app_icon : undefined,
      app_icon_asset_key:
        typeof p.app_icon_asset_key === 'string' ? p.app_icon_asset_key : undefined,
      pkc_extension: typeof p.pkc_extension === 'boolean' ? p.pkc_extension : undefined,
      startup: typeof p.startup === 'boolean' ? p.startup : undefined,
      extension_manifest:
        tier !== undefined || capabilities !== undefined
          ? { ...(tier ? { tier } : {}), ...(capabilities ? { capabilities } : {}) }
          : undefined,
      launcher_url: typeof p.launcher_url === 'string' ? p.launcher_url : undefined,
      app_group: typeof p.app_group === 'string' ? p.app_group : undefined,
      app_order: typeof p.app_order === 'number' ? p.app_order : undefined,
      extra: (() => {
        // whitelist copy は未知 field を無言で破壊する ── PKC2 で launcher 設定
        // 消失事故として教訓化済みの型(attachment-presenter.ts の警句)。
        // 未知 / 将来 field は verbatim で保全する(review #3)
        const rest = Object.entries(p).filter(([k]) => !KNOWN_ATTACHMENT_KEYS.has(k));
        return rest.length > 0 ? Object.fromEntries(rest) : undefined;
      })(),
    };
  } catch {
    return { name: '', mime: 'application/octet-stream' };
  }
}

export const attachmentFlavor: FlavorSpec = {
  archetype: 'attachment',
  /**
   * 🔴 **frontmatter の `date` / `status` は、アーキタイプによらず効く**
   * (2026-08-20。user 指示「カレンダーを利用するための導線が不足している」の調査で判明)。
   *
   * ⚠ 直す前は `NO_EXTRACT` を返しており、**書いても列に入らなかった**。
   *   #276 で `text` だけを `extractSchedule` へ直したときに、
   *   **同型の 4 つが取り残された**(CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
   * 🔴 症状は「効かない」で済まない ── カレンダーの日を押すと
   *   ①本文には `date` が入る ②カレンダーには出ない ③もう一度押すと
   *   **「本文が変わっているため反映できませんでした」という嘘の理由**が出る
   *   (列が `null` のままなので、トグルが毎回「付ける」側を送り、
   *   2 回目の splice が同値 = 変化なしになる)④外すこともできない。
   * 🔑 **founding 裁定 2026-07-30「アーキタイプ = フレーバー(見せ方・編集の仕方)」**
   *   に照らすと、`date` の意味が archetype で変わるほうが誤りである
   *   ── 見せ方が違うだけで、**書いた日付は日付**である。
   * ⚠ 鍵の名前と受理形は `schedule-keys.ts` の 1 か所(判定を増やさない)。
   * ⚠ `archived` はここでは写さない ── 理由は `extractSchedule` の docstring。
   */
  extract: (body) => ({ ...extractSchedule(body), archived: false }),
  fromPkc2(body) {
    const a = parsePkc2Attachment(body);
    if (a.data !== undefined) {
      // 旧形式(base64 内蔵)は pure な文字列変換では移せない ── bytes は
      // Blob storage へ移してから来ること(P6 importer の前段責務)。黙って
      // bytes を落とす変換を作らない(S3 型のデータ消失を構造的に拒否)
      throw new Error(
        'attachment fromPkc2: legacy inline data は事前に asset externalize が必要(P6 importer の前段で bytes を Blob storage へ移し、asset_key 形式にしてから変換する)',
      );
    }
    const meta: Record<string, FrontmatterValue> = {
      'attachment.name': a.name,
      'attachment.mime': a.mime,
    };
    if (a.size !== undefined) meta['attachment.size'] = a.size;
    if (a.asset_key !== undefined) meta['attachment.asset_key'] = a.asset_key;
    if (a.sandbox_allow !== undefined) meta['attachment.sandbox_allow'] = a.sandbox_allow;
    if (a.registered_as_app !== undefined)
      meta['attachment.registered_as_app'] = a.registered_as_app;
    if (a.app_icon !== undefined) meta['attachment.app_icon'] = a.app_icon;
    if (a.app_icon_asset_key !== undefined)
      meta['attachment.app_icon_asset_key'] = a.app_icon_asset_key;
    if (a.pkc_extension !== undefined) meta['attachment.pkc_extension'] = a.pkc_extension;
    if (a.startup !== undefined) meta['attachment.startup'] = a.startup;
    if (a.extension_manifest !== undefined)
      // flat YAML はネストを持たないため JSON 文字列で保持(quoted scalar round-trip)
      meta['attachment.extension_manifest'] = JSON.stringify(a.extension_manifest);
    if (a.launcher_url !== undefined) meta['attachment.launcher_url'] = a.launcher_url;
    if (a.app_group !== undefined) meta['attachment.app_group'] = a.app_group;
    if (a.app_order !== undefined) meta['attachment.app_order'] = a.app_order;
    if (a.extra !== undefined) meta['attachment.extra'] = JSON.stringify(a.extra);
    // body(説明 markdown 領域)は空で始める ── PKC2 の attachment body に自由記述は無い
    return serializeFrontmatter(meta);
  },
};
