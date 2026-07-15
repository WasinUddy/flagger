const FLAC_MAGIC = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
const MAX_BLOCK_LENGTH = 0xffffff;
const MAX_METADATA_BLOCKS = 1024;
const DEFAULT_PADDING_BYTES = 16 * 1024;

export type FlacTagValue =
  | string
  | number
  | readonly (string | number)[]
  | null
  | undefined;

export type FlacTags = Record<string, FlacTagValue>;

export type FlacPicture = {
  blob: Blob;
  mimeType: "image/jpeg" | "image/png";
  width?: number;
  height?: number;
  depth?: number;
  description?: string;
};

export type ParsedFlac = {
  audioOffset: number;
  blocks: MetadataBlock[];
  channels: number;
  comments: Record<string, string[]>;
  durationSeconds: number | null;
  sampleRate: number;
  bitsPerSample: number;
  vendor: string;
};

type MetadataBlock = {
  type: number;
  body: Blob;
  length: number;
  pictureType?: number;
};

type StreamInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number | null;
};

export class FlacFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlacFormatError";
  }
}

/**
 * Reads only the FLAC metadata prefix. Audio frames remain as Blob slices and are
 * never decoded or copied into memory.
 */
export async function inspectFlac(file: Blob): Promise<ParsedFlac> {
  if (file.size < 42) {
    throw new FlacFormatError("This file is too small to be a native FLAC file.");
  }

  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!equalBytes(magic, FLAC_MAGIC)) {
    if (ascii(magic) === "OggS") {
      throw new FlacFormatError("Ogg-FLAC is not supported. Please use native .flac files.");
    }
    if (ascii(magic.slice(0, 3)) === "ID3") {
      throw new FlacFormatError("FLAC files with a leading ID3 tag are not supported.");
    }
    throw new FlacFormatError("The file does not begin with the native FLAC marker.");
  }

  let offset = 4;
  let reachedLastBlock = false;
  const blocks: MetadataBlock[] = [];
  const comments: Record<string, string[]> = {};
  let vendor = "";
  let streamInfo: StreamInfo | null = null;

  for (let blockIndex = 0; blockIndex < MAX_METADATA_BLOCKS; blockIndex += 1) {
    if (offset + 4 > file.size) {
      throw new FlacFormatError("The FLAC metadata header is truncated.");
    }

    const header = new Uint8Array(
      await file.slice(offset, offset + 4).arrayBuffer(),
    );
    const isLast = (header[0] & 0x80) !== 0;
    const type = header[0] & 0x7f;
    const length = (header[1] << 16) | (header[2] << 8) | header[3];
    const bodyStart = offset + 4;
    const bodyEnd = bodyStart + length;

    if (type === 127) {
      throw new FlacFormatError("The FLAC contains an invalid metadata block type.");
    }
    if (bodyEnd > file.size) {
      throw new FlacFormatError("A FLAC metadata block extends past the end of the file.");
    }

    const block: MetadataBlock = {
      type,
      body: file.slice(bodyStart, bodyEnd),
      length,
    };

    if (blockIndex === 0) {
      if (type !== 0 || length !== 34) {
        throw new FlacFormatError("The first FLAC metadata block must be 34-byte STREAMINFO.");
      }
      streamInfo = parseStreamInfo(
        new Uint8Array(await block.body.arrayBuffer()),
      );
    }

    if (type === 4) {
      const parsed = parseVorbisComment(
        new Uint8Array(await block.body.arrayBuffer()),
      );
      vendor ||= parsed.vendor;
      for (const [key, values] of Object.entries(parsed.comments)) {
        comments[key] = [...(comments[key] ?? []), ...values];
      }
    } else if (type === 6 && length >= 4) {
      const firstFour = new Uint8Array(
        await file.slice(bodyStart, bodyStart + 4).arrayBuffer(),
      );
      block.pictureType = readUint32BE(firstFour, 0);
    }

    blocks.push(block);
    offset = bodyEnd;
    if (isLast) {
      reachedLastBlock = true;
      break;
    }
  }

  if (!reachedLastBlock) {
    throw new FlacFormatError("The FLAC metadata does not contain a final block.");
  }
  if (!streamInfo) {
    throw new FlacFormatError("The FLAC STREAMINFO block is missing.");
  }

  return {
    audioOffset: offset,
    blocks,
    comments,
    vendor,
    ...streamInfo,
  };
}

/**
 * Rewrites metadata while preserving every original FLAC audio-frame byte.
 */
export async function rewriteFlac(
  file: Blob,
  tags: FlacTags,
  picture?: FlacPicture,
): Promise<Blob> {
  const parsed = await inspectFlac(file);
  const preserved = parsed.blocks.filter((block) => {
    if (block.type === 1 || block.type === 4) return false;
    if (block.type === 6 && picture && block.pictureType === 3) return false;
    return true;
  });

  const mergedTags: FlacTags = { ...parsed.comments };
  for (const [key, value] of Object.entries(tags)) {
    delete mergedTags[key.toUpperCase()];
    mergedTags[key] = value;
  }
  const commentBody = encodeVorbisComment(mergedTags);
  const outputBlocks: Array<{ type: number; body: Blob | Uint8Array; length: number }> =
    preserved.map((block) => ({
      type: block.type,
      body: block.body,
      length: block.length,
    }));

  outputBlocks.push({
    type: 4,
    body: commentBody,
    length: commentBody.byteLength,
  });

  if (picture) {
    const pictureBody = await encodePicture(picture);
    outputBlocks.push({
      type: 6,
      body: pictureBody,
      length: pictureBody.byteLength,
    });
  }

  const padding = new Uint8Array(DEFAULT_PADDING_BYTES);
  outputBlocks.push({ type: 1, body: padding, length: padding.byteLength });

  const parts: BlobPart[] = [arrayBufferFromBytes(FLAC_MAGIC)];
  outputBlocks.forEach((block, index) => {
    if (block.length > MAX_BLOCK_LENGTH) {
      throw new FlacFormatError(
        "A metadata block is larger than FLAC's 16 MiB block limit.",
      );
    }
    const header = createBlockHeader(
      block.type,
      block.length,
      index === outputBlocks.length - 1,
    );
    parts.push(
      arrayBufferFromBytes(header),
      block.body instanceof Blob ? block.body : arrayBufferFromBytes(block.body),
    );
  });
  parts.push(file.slice(parsed.audioOffset));

  return new Blob(parts, { type: "audio/flac" });
}

export function firstComment(
  comments: Record<string, string[]>,
  key: string,
): string {
  return comments[key.toUpperCase()]?.[0] ?? "";
}

function parseStreamInfo(bytes: Uint8Array): StreamInfo {
  if (bytes.byteLength !== 34) {
    throw new FlacFormatError("STREAMINFO must be exactly 34 bytes.");
  }

  const sampleRate = (bytes[10] << 12) | (bytes[11] << 4) | (bytes[12] >> 4);
  const channels = ((bytes[12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((bytes[12] & 0x01) << 4) | (bytes[13] >> 4)) + 1;
  const totalSamples =
    (BigInt(bytes[13] & 0x0f) << 32n) |
    (BigInt(bytes[14]) << 24n) |
    (BigInt(bytes[15]) << 16n) |
    (BigInt(bytes[16]) << 8n) |
    BigInt(bytes[17]);

  return {
    sampleRate,
    channels,
    bitsPerSample,
    durationSeconds:
      sampleRate > 0 && totalSamples > 0n
        ? Number(totalSamples) / sampleRate
        : null,
  };
}

function parseVorbisComment(bytes: Uint8Array): {
  vendor: string;
  comments: Record<string, string[]>;
} {
  let offset = 0;
  const decoder = new TextDecoder("utf-8");
  const vendorLength = readLengthLE(bytes, offset, "vendor length");
  offset += 4;
  ensureAvailable(bytes, offset, vendorLength, "vendor string");
  const vendor = decoder.decode(bytes.slice(offset, offset + vendorLength));
  offset += vendorLength;

  const commentCount = readLengthLE(bytes, offset, "comment count");
  offset += 4;
  if (commentCount > 100_000) {
    throw new FlacFormatError("The Vorbis comment count is not plausible.");
  }

  const comments: Record<string, string[]> = {};
  for (let index = 0; index < commentCount; index += 1) {
    const length = readLengthLE(bytes, offset, "comment length");
    offset += 4;
    ensureAvailable(bytes, offset, length, "comment value");
    const entry = decoder.decode(bytes.slice(offset, offset + length));
    offset += length;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).toUpperCase();
    const value = entry.slice(separator + 1);
    comments[key] = [...(comments[key] ?? []), value];
  }

  return { vendor, comments };
}

function encodeVorbisComment(tags: FlacTags): Uint8Array {
  const encoder = new TextEncoder();
  const vendor = encoder.encode("Flagger 1.0 — local FLAC tagger");
  const entries: Uint8Array[] = [];

  for (const [rawKey, rawValue] of Object.entries(tags)) {
    const key = rawKey.trim().toUpperCase();
    if (!key || !/^[\x20-\x3c\x3e-\x7d]+$/.test(key)) continue;
    if (key === "COVERART" || key === "METADATA_BLOCK_PICTURE") continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const stringValue = String(value).trim();
      if (!stringValue) continue;
      entries.push(encoder.encode(`${key}=${stringValue}`));
    }
  }

  const totalLength =
    4 +
    vendor.byteLength +
    4 +
    entries.reduce((sum, entry) => sum + 4 + entry.byteLength, 0);
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  let offset = 0;

  view.setUint32(offset, vendor.byteLength, true);
  offset += 4;
  output.set(vendor, offset);
  offset += vendor.byteLength;
  view.setUint32(offset, entries.length, true);
  offset += 4;

  for (const entry of entries) {
    view.setUint32(offset, entry.byteLength, true);
    offset += 4;
    output.set(entry, offset);
    offset += entry.byteLength;
  }

  return output;
}

async function encodePicture(picture: FlacPicture): Promise<Uint8Array> {
  if (picture.blob.size <= 0) {
    throw new FlacFormatError("The cover image is empty.");
  }

  const encoder = new TextEncoder();
  const mime = encoder.encode(picture.mimeType);
  const description = encoder.encode(picture.description ?? "Front cover");
  const image = new Uint8Array(await picture.blob.arrayBuffer());
  const totalLength = 32 + mime.byteLength + description.byteLength + image.byteLength;
  if (totalLength > MAX_BLOCK_LENGTH) {
    throw new FlacFormatError("The cover is too large to fit in a FLAC PICTURE block.");
  }

  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  let offset = 0;
  const write = (value: number) => {
    view.setUint32(offset, Math.max(0, value) >>> 0, false);
    offset += 4;
  };

  write(3);
  write(mime.byteLength);
  output.set(mime, offset);
  offset += mime.byteLength;
  write(description.byteLength);
  output.set(description, offset);
  offset += description.byteLength;
  write(picture.width ?? 0);
  write(picture.height ?? 0);
  write(picture.depth ?? 0);
  write(0);
  write(image.byteLength);
  output.set(image, offset);

  return output;
}

function createBlockHeader(type: number, length: number, isLast: boolean): Uint8Array {
  if (type < 0 || type > 126 || length < 0 || length > MAX_BLOCK_LENGTH) {
    throw new FlacFormatError("Cannot encode this FLAC metadata block.");
  }
  return new Uint8Array([
    type | (isLast ? 0x80 : 0),
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  ]);
}

function readLengthLE(bytes: Uint8Array, offset: number, label: string): number {
  ensureAvailable(bytes, offset, 4, label);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  ensureAvailable(bytes, offset, 4, "32-bit value");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    false,
  );
}

function ensureAvailable(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new FlacFormatError(`The Vorbis ${label} is truncated.`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function ascii(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
