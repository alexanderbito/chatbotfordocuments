/**
 * Normalize a filename received from a multipart upload.
 *
 * Why it exists: multer 1.x (busboy) reads the filename in the multipart header
 * as latin-1, so any UTF-8 name turns into mojibake. macOS also stores filenames
 * in NFD (base character plus combining marks), which has to be folded to NFC so
 * display and search stay consistent with names coming from Windows and Linux.
 */
export function decodeFilename(name) {
  if (!name) return name;

  // A character outside latin-1 means the string is already valid UTF-8; just fold to NFC.
  if (/[^\x00-\xFF]/.test(name)) return name.normalize('NFC');

  // Otherwise try reinterpreting the bytes as latin-1 -> UTF-8.
  const decoded = Buffer.from(name, 'latin1').toString('utf8');

  // A replacement character (U+FFFD) means the original was already correct; keep it.
  if (decoded.includes('�')) return name.normalize('NFC');

  return decoded.normalize('NFC');
}

/**
 * Build a storage-safe key for R2/S3: strip diacritics, keep only [a-zA-Z0-9._-].
 * The name shown to people stays the original, stored in the filename column.
 */
export function toStorageSafeName(name, fallback = 'tai-lieu') {
  const base = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // drop combining accents
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (base || fallback).slice(0, 120);
}
