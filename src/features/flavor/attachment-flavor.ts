/**
 * attachment フレーバー: frontmatter(asset_key / mime ほか)+ 説明 markdown。
 * asset の bytes は IDB Blob 側(§4.2)── body はメタとポインタのみを持ち、
 * 表示は `lendObjectUrl`(dispose 規律)で行う(P4 で結線)。
 */
import { serializeFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { NO_EXTRACT, type FlavorSpec } from './flavor-spec';

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
  extract: () => NO_EXTRACT,
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
