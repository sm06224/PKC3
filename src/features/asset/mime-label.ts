/**
 * 🔴 **ファイルの種類の、短い名前**(#1163 依頼 164。Gemini の裁定:「PDF」などの短い名前でよい)。
 *
 * 添付ノートの右のペインに「種類 添付 (PDF)」と出す。`application/pdf` のような正式な名前は user には読みにくい。
 * ⚠ 知らない種類は**正式な名前をそのまま出す**(黙って空にしない)。⚠ pure module。
 */
const BY_MIME: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'application/json': 'JSON',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.sqlite3': 'SQLite',
  'application/x-sqlite3': 'SQLite',
  'text/plain': 'テキスト',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
  'text/html': 'HTML',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/svg+xml': 'SVG',
};

export function mimeLabel(mime: string): string {
  const key = mime.split(';')[0]!.trim().toLowerCase();
  const known = BY_MIME[key];
  if (known !== undefined) return known;
  if (key === '' || key === 'application/octet-stream') return 'ファイル';
  if (key.startsWith('image/')) return '画像';
  if (key.startsWith('audio/')) return '音声';
  if (key.startsWith('video/')) return '動画';
  return key;
}
