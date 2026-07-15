const MAX_ZIP32_VALUE = 0xffffffff;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const ZIP_VERSION = 20;

export type ZipEntry = {
  name: string;
  blob: Blob;
};

export async function createStoredZip(
  entries: readonly ZipEntry[],
  onProgress?: (completed: number, total: number) => void,
): Promise<Blob> {
  if (!entries.length) throw new Error("There are no files to put in the ZIP.");
  if (entries.length > 0xffff) throw new Error("This album has too many files for a ZIP.");

  const encoder = new TextEncoder();
  const timestamp = dosTimestamp(new Date());
  const prepared: Array<{
    name: Uint8Array;
    blob: Blob;
    crc32: number;
    size: number;
    localOffset: number;
  }> = [];
  let localOffset = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const name = encoder.encode(entry.name.replace(/^\/+/, ""));
    if (!name.byteLength || name.byteLength > 0xffff) {
      throw new Error("A filename is too long for the album ZIP.");
    }
    if (entry.blob.size > MAX_ZIP32_VALUE) {
      throw new Error("A file is larger than the ZIP format supported by this browser.");
    }
    const crc32 = await crc32OfBlob(entry.blob);
    prepared.push({
      name,
      blob: entry.blob,
      crc32,
      size: entry.blob.size,
      localOffset,
    });
    localOffset += 30 + name.byteLength + entry.blob.size;
    if (localOffset > MAX_ZIP32_VALUE) {
      throw new Error(
        "This album is over 4 GB. Download the FLACs individually instead.",
      );
    }
    onProgress?.(index + 1, entries.length);
  }

  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let centralSize = 0;

  for (const entry of prepared) {
    localParts.push(
      bytesToArrayBuffer(
        localHeader(entry, timestamp.time, timestamp.date),
      ),
      entry.blob,
    );
    const central = centralHeader(entry, timestamp.time, timestamp.date);
    centralParts.push(bytesToArrayBuffer(central));
    centralSize += central.byteLength;
  }

  if (centralSize > MAX_ZIP32_VALUE || localOffset + centralSize + 22 > MAX_ZIP32_VALUE) {
    throw new Error("This album is too large for a single browser-generated ZIP.");
  }

  const end = endOfCentralDirectory(entries.length, centralSize, localOffset);
  return new Blob([...localParts, ...centralParts, bytesToArrayBuffer(end)], {
    type: "application/zip",
  });
}

function localHeader(
  entry: {
    name: Uint8Array;
    crc32: number;
    size: number;
  },
  time: number,
  date: number,
): Uint8Array {
  const output = new Uint8Array(30 + entry.name.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, STORE_METHOD, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.size, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.name.byteLength, true);
  view.setUint16(28, 0, true);
  output.set(entry.name, 30);
  return output;
}

function centralHeader(
  entry: {
    name: Uint8Array;
    crc32: number;
    size: number;
    localOffset: number;
  },
  time: number,
  date: number,
): Uint8Array {
  const output = new Uint8Array(46 + entry.name.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, STORE_METHOD, true);
  view.setUint16(12, time, true);
  view.setUint16(14, date, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.name.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.localOffset, true);
  output.set(entry.name, 46);
  return output;
}

function endOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array {
  const output = new Uint8Array(22);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return output;
}

async function crc32OfBlob(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    for (const byte of value) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();
