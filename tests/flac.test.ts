import assert from "node:assert/strict";
import test from "node:test";
import { dapOrderingTags } from "../lib/dap.ts";
import { inspectFlac, rewriteFlac } from "../lib/flac.ts";

const SAMPLE_RATE = 96_000;
const TOTAL_SAMPLES = 576_000n;

function nativeFlac(audio: Uint8Array): Blob {
  const streamInfo = new Uint8Array(34);
  streamInfo[0] = 0x10;
  streamInfo[1] = 0x00;
  streamInfo[2] = 0x10;
  streamInfo[3] = 0x00;
  streamInfo[10] = (SAMPLE_RATE >>> 12) & 0xff;
  streamInfo[11] = (SAMPLE_RATE >>> 4) & 0xff;
  streamInfo[12] = ((SAMPLE_RATE & 0x0f) << 4) | (1 << 1) | 1;
  streamInfo[13] = (7 << 4) | Number((TOTAL_SAMPLES >> 32n) & 0x0fn);
  streamInfo[14] = Number((TOTAL_SAMPLES >> 24n) & 0xffn);
  streamInfo[15] = Number((TOTAL_SAMPLES >> 16n) & 0xffn);
  streamInfo[16] = Number((TOTAL_SAMPLES >> 8n) & 0xffn);
  streamInfo[17] = Number(TOTAL_SAMPLES & 0xffn);

  return new Blob([
    new Uint8Array([0x66, 0x4c, 0x61, 0x43]).buffer,
    new Uint8Array([0x80, 0x00, 0x00, 0x22]).buffer,
    new Uint8Array(streamInfo).buffer,
    new Uint8Array(audio).buffer,
  ]);
}

test("inspects STREAMINFO without reading or decoding audio", async () => {
  const source = nativeFlac(new Uint8Array([0xff, 0xf8, 0x12, 0x34]));
  const parsed = await inspectFlac(source);

  assert.equal(parsed.audioOffset, 42);
  assert.equal(parsed.sampleRate, 96_000);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.bitsPerSample, 24);
  assert.equal(parsed.durationSeconds, 6);
});

test("rewrites comments and a front cover while preserving every audio byte", async () => {
  const audio = new Uint8Array([0xff, 0xf8, 0x12, 0x34, 0x56, 0x78]);
  const source = nativeFlac(audio);
  const output = await rewriteFlac(
    source,
    {
      TITLE: "Blue in Green",
      ARTIST: "Miles Davis",
      ALBUM: "Kind of Blue",
      TRACKNUMBER: 3,
      GENRE: ["Jazz", "Modal"],
    },
    {
      blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
        type: "image/jpeg",
      }),
      mimeType: "image/jpeg",
      width: 600,
      height: 600,
      depth: 24,
    },
  );
  const parsed = await inspectFlac(output);
  const outputAudio = new Uint8Array(
    await output.slice(parsed.audioOffset).arrayBuffer(),
  );

  assert.deepEqual(outputAudio, audio);
  assert.deepEqual(parsed.comments.TITLE, ["Blue in Green"]);
  assert.deepEqual(parsed.comments.ARTIST, ["Miles Davis"]);
  assert.deepEqual(parsed.comments.GENRE, ["Jazz", "Modal"]);
  assert.ok(parsed.blocks.some((block) => block.type === 6 && block.pictureType === 3));
  assert.equal(parsed.blocks.at(-1)?.type, 1);
});

test("rejects Ogg-FLAC instead of guessing", async () => {
  await assert.rejects(
    inspectFlac(new Blob([new Uint8Array(64).fill(0).map((value, index) => {
      const magic = [0x4f, 0x67, 0x67, 0x53];
      return index < magic.length ? magic[index] : value;
    })])),
    /Ogg-FLAC/,
  );
});

test("preserves unrelated comments while replacing owned tag fields", async () => {
  const source = nativeFlac(new Uint8Array([0xff, 0xf8, 0x11, 0x22]));
  const firstPass = await rewriteFlac(source, {
    TITLE: "Old title",
    MUSICBRAINZ_ALBUMID: "release-123",
    REPLAYGAIN_ALBUM_GAIN: "-4.20 dB",
  });
  const secondPass = await rewriteFlac(firstPass, { TITLE: "New title" });
  const parsed = await inspectFlac(secondPass);

  assert.deepEqual(parsed.comments.TITLE, ["New title"]);
  assert.deepEqual(parsed.comments.MUSICBRAINZ_ALBUMID, ["release-123"]);
  assert.deepEqual(parsed.comments.REPLAYGAIN_ALBUM_GAIN, ["-4.20 dB"]);
});

test("removes stale single-disc tags while keeping a zero-padded track number", async () => {
  const source = nativeFlac(new Uint8Array([0xff, 0xf8, 0x33, 0x44]));
  const firstPass = await rewriteFlac(source, {
    TRACKNUMBER: 1,
    DISCNUMBER: 1,
    DISCTOTAL: 1,
    TOTALDISCS: 1,
    DISK: 1,
  });
  const secondPass = await rewriteFlac(
    firstPass,
    dapOrderingTags({ discNumber: 1, discTotal: 1, trackNumber: 1, trackTotal: 12 }),
  );
  const parsed = await inspectFlac(secondPass);

  assert.deepEqual(parsed.comments.TRACKNUMBER, ["01"]);
  assert.deepEqual(parsed.comments.TRACKTOTAL, ["12"]);
  assert.deepEqual(parsed.comments.TOTALTRACKS, ["12"]);
  assert.equal(parsed.comments.DISCNUMBER, undefined);
  assert.equal(parsed.comments.DISCTOTAL, undefined);
  assert.equal(parsed.comments.TOTALDISCS, undefined);
  assert.equal(parsed.comments.DISK, undefined);
});
