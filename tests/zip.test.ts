import assert from "node:assert/strict";
import test from "node:test";
import { createStoredZip } from "../lib/zip.ts";

test("creates a UTF-8 store-only ZIP with valid local headers and CRC", async () => {
  const zip = await createStoredZip([
    { name: "01 - hello.flac", blob: new Blob(["hello"]) },
    { name: "02 - café.flac", blob: new Blob(["world"]) },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();

  assert.equal(zip.type, "application/zip");
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x0800);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint32(14, true), 0x3610a686);
  assert.equal(view.getUint32(18, true), 5);
  const firstNameLength = view.getUint16(26, true);
  assert.equal(decoder.decode(bytes.slice(30, 30 + firstNameLength)), "01 - hello.flac");
  assert.equal(
    decoder.decode(bytes.slice(30 + firstNameLength, 35 + firstNameLength)),
    "hello",
  );

  const secondOffset = 30 + firstNameLength + 5;
  assert.equal(view.getUint32(secondOffset, true), 0x04034b50);
  const secondNameLength = view.getUint16(secondOffset + 26, true);
  assert.equal(
    decoder.decode(bytes.slice(secondOffset + 30, secondOffset + 30 + secondNameLength)),
    "02 - café.flac",
  );
  assert.equal(view.getUint32(bytes.byteLength - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.byteLength - 12, true), 2);
});
