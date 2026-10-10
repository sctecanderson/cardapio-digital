// ZIP sem compressão: fotos e vídeos já estão comprimidos. Sem dependência extra.
// ZIP64 não é necessário: o download desta versão tem limite de 128 MiB.
const LIMIT = 128 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createBackupZip(files: { path: string; bytes: Uint8Array }[]): Blob {
  if (files.length > 65535) throw new Error('Quantidade de arquivos acima do limite do ZIP.');
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > LIMIT) throw new Error('Este download pelo navegador aceita até 128 MiB. A cópia privada foi preservada.');
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let centralSize = 0;
  for (const file of files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.startsWith('/') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(file.path)) {
      throw new Error('Caminho inválido ou repetido no ZIP.');
    }
    seen.add(file.path);
    const name = new TextEncoder().encode(file.path);
    if (name.length > 65535) throw new Error('Nome de arquivo acima do limite do ZIP.');
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(12, 33, true); // 1980-01-01: data mínima representável.
    view.setUint32(14, crc, true);
    view.setUint32(18, file.bytes.length, true);
    view.setUint32(22, file.bytes.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    const directory = new Uint8Array(46 + name.length);
    const entry = new DataView(directory.buffer);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(14, 33, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, file.bytes.length, true);
    entry.setUint32(24, file.bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    directory.set(name, 46);
    parts.push(local, file.bytes);
    central.push(directory);
    offset += local.length + file.bytes.length;
    centralSize += directory.length;
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
