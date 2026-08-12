const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

export function readImageDimensions(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("Image data must be a Buffer.");
  if (mimeType === "image/png") return readPng(bytes);
  if (mimeType === "image/jpeg") return readJpeg(bytes);
  if (mimeType === "image/webp") return readWebp(bytes);
  if (mimeType === "image/gif") return readGif(bytes);
  if (mimeType === "image/svg+xml") return {};
  throw new Error("Unsupported image type.");
}

function readPng(bytes) {
  if (
    bytes.length < 24
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) throw new Error("Invalid PNG header.");
  return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function readGif(bytes) {
  if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    throw new Error("Invalid GIF header.");
  }
  return dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
}

function readJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid JPEG header.");
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) throw new Error("Truncated JPEG segment.");
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new Error("Invalid JPEG segment length.");
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7) throw new Error("Invalid JPEG frame header.");
      return dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += segmentLength;
  }
  throw new Error("JPEG dimensions were not found.");
}

function readWebp(bytes) {
  if (
    bytes.length < 20
    || bytes.subarray(0, 4).toString("ascii") !== "RIFF"
    || bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) throw new Error("Invalid WebP header.");
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.subarray(offset, offset + 4).toString("ascii");
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const chunkEnd = payload + chunkLength;
    if (chunkEnd > bytes.length) throw new Error("Truncated WebP chunk.");
    if (chunkType === "VP8X" && chunkLength >= 10) {
      return dimensions(readUInt24LE(bytes, payload + 4) + 1, readUInt24LE(bytes, payload + 7) + 1);
    }
    if (chunkType === "VP8L" && chunkLength >= 5 && bytes[payload] === 0x2f) {
      const bits = bytes.readUInt32LE(payload + 1);
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (
      chunkType === "VP8 "
      && chunkLength >= 10
      && bytes[payload + 3] === 0x9d
      && bytes[payload + 4] === 0x01
      && bytes[payload + 5] === 0x2a
    ) {
      return dimensions(bytes.readUInt16LE(payload + 6) & 0x3fff, bytes.readUInt16LE(payload + 8) & 0x3fff);
    }
    const next = chunkEnd + (chunkLength % 2);
    if (next <= offset || next > bytes.length) throw new Error("Invalid WebP chunk length.");
    offset = next;
  }
  throw new Error("WebP dimensions were not found.");
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid image dimensions.");
  }
  return { width, height };
}
