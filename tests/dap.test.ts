import assert from "node:assert/strict";
import test from "node:test";
import {
  compareDapOrder,
  dapOrderingTags,
  dapOutputFileName,
  paddedOrdinal,
} from "../lib/dap.ts";

test("zero-pads track and disc ordinals for lexical DAP sorting", () => {
  assert.equal(paddedOrdinal(1, 12), "01");
  assert.equal(paddedOrdinal(10, 12), "10");
  assert.equal(paddedOrdinal(1, 120), "001");

  assert.equal(
    dapOutputFileName(
      { discNumber: 1, discTotal: 1, trackNumber: 1, trackTotal: 12 },
      "Opening / Theme",
    ),
    "01 - Opening - Theme.flac",
  );
  assert.equal(
    dapOutputFileName(
      { discNumber: 2, discTotal: 2, trackNumber: 10, trackTotal: 12 },
      "Finale",
    ),
    "02-10 - Finale.flac",
  );
});

test("omits single-disc tags that can confuse SnowSky album ordering", () => {
  assert.deepEqual(
    dapOrderingTags({ discNumber: 1, discTotal: 1, trackNumber: 1, trackTotal: 12 }),
    {
      TRACKNUMBER: "01",
      TRACKTOTAL: 12,
      TOTALTRACKS: 12,
      DISCNUMBER: null,
      DISCTOTAL: null,
      TOTALDISCS: null,
      DISC: null,
      DISK: null,
      DISKNUMBER: null,
    },
  );

  assert.deepEqual(
    dapOrderingTags({ discNumber: 2, discTotal: 3, trackNumber: 1, trackTotal: 10 }),
    {
      TRACKNUMBER: "01",
      TRACKTOTAL: 10,
      TOTALTRACKS: 10,
      DISCNUMBER: "02",
      DISCTOTAL: 3,
      TOTALDISCS: 3,
      DISC: null,
      DISK: null,
      DISKNUMBER: null,
    },
  );
});

test("sorts ZIP entries in disc and track order before writing", () => {
  const tracks = [
    { discNumber: 2, trackNumber: 1 },
    { discNumber: 1, trackNumber: 10 },
    { discNumber: 1, trackNumber: 2 },
    { discNumber: 1, trackNumber: 1 },
  ].sort(compareDapOrder);

  assert.deepEqual(tracks, [
    { discNumber: 1, trackNumber: 1 },
    { discNumber: 1, trackNumber: 2 },
    { discNumber: 1, trackNumber: 10 },
    { discNumber: 2, trackNumber: 1 },
  ]);
});
