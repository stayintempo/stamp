// FNV-1a 32-bit hash → 8-char lowercase hex. No crypto dependency; used only
// to give steps a short, stable identity within a doc version.

export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    h = Math.imul(h, 0x01000193);
  }
  // `>>> 0` coerces to unsigned 32-bit before hex formatting.
  return (h >>> 0).toString(16).padStart(8, '0');
}
