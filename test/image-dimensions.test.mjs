import assert from "node:assert/strict";
import test from "node:test";

import { readImageDimensions } from "../mcp/lib/image-dimensions.mjs";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("reads bounded PNG, GIF, JPEG, and WebP headers", () => {
  assert.deepEqual(readImageDimensions(PNG_1X1, "image/png"), { width: 1, height: 1 });
  assert.deepEqual(readImageDimensions(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x03, 0x00]), "image/gif"), { width: 2, height: 3 });
  assert.deepEqual(readImageDimensions(Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x11, 0x00,
  ]), "image/jpeg"), { width: 2, height: 3 });

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  webp[24] = 1;
  webp[27] = 2;
  assert.deepEqual(readImageDimensions(webp, "image/webp"), { width: 2, height: 3 });
});

test("rejects truncated or looping image headers", () => {
  assert.throws(() => readImageDimensions(Buffer.from("not-a-png"), "image/png"));
  const truncatedWebp = Buffer.alloc(20);
  truncatedWebp.write("RIFF", 0, "ascii");
  truncatedWebp.write("WEBP", 8, "ascii");
  truncatedWebp.write("VP8X", 12, "ascii");
  truncatedWebp.writeUInt32LE(0xffffffff, 16);
  assert.throws(() => readImageDimensions(truncatedWebp, "image/webp"));
});
