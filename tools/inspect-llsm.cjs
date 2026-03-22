#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

function usage() {
  console.log("Usage: node tools/inspect-llsm.cjs <path-to-llsm> [--json <output.json>]");
}

function readI32(buf, off) {
  return buf.readInt32LE(off);
}

function readF32(buf, off) {
  return buf.readFloatLE(off);
}

function parseRoot(buf) {
  let off = 0;

  function readKey() {
    const n = buf[off++];
    const key = buf.toString("ascii", off, off + n);
    off += n;
    return key;
  }

  function parseValue() {
    const tag = buf[off++];
    if (tag === 1) {
      const count = readI32(buf, off);
      off += 4;
      const obj = {};
      for (let i = 0; i < count; i += 1) {
        obj[readKey()] = parseValue();
      }
      return obj;
    }
    if (tag === 3) {
      const value = readF32(buf, off);
      off += 4;
      return value;
    }
    if (tag === 5) {
      const n = readI32(buf, off);
      off += 4;
      const kind = readI32(buf, off);
      off += 4;
      const arr = [];
      for (let i = 0; i < n; i += 1) {
        arr.push(readF32(buf, off));
        off += 4;
      }
      return { tag, kind, values: arr };
    }
    if (tag === 7) {
      const n = readI32(buf, off);
      off += 4;
      const arr = [];
      for (let i = 0; i < n; i += 1) {
        arr.push(readI32(buf, off));
        off += 4;
      }
      return arr;
    }
    throw new Error(`Unsupported root tag ${tag} at offset ${off - 1}`);
  }

  const rootKey = readKey();
  const rootValue = parseValue();
  return { rootKey, rootValue, parsedBytes: off };
}

function parseFrameAt(buf, start) {
  let p = start;

  const tag = buf[p++];
  if (tag !== 1) {
    throw new Error(`Frame at ${start} does not start with object tag(1): ${tag}`);
  }
  const frameFieldCount = readI32(buf, p);
  p += 4;
  if (frameFieldCount !== 2) {
    throw new Error(`Unexpected frame field count ${frameFieldCount} at ${start}`);
  }

  const key1Len = buf[p++];
  const key1 = buf.toString("ascii", p, p + key1Len);
  p += key1Len;
  const key1Tag = buf[p++];
  if (key1Tag !== 6) {
    throw new Error(`Unexpected frame first blob tag ${key1Tag} at ${start}`);
  }
  const blob1Len = readI32(buf, p);
  p += 4;
  const blob1Start = p;
  p += blob1Len;

  const key2Len = buf[p++];
  const key2 = buf.toString("ascii", p, p + key2Len);
  p += key2Len;
  const key2Tag = buf[p++];
  if (key2Tag !== 1) {
    throw new Error(`Unexpected nested object tag ${key2Tag} at ${start}`);
  }
  const nestedCount = readI32(buf, p);
  p += 4;
  if (nestedCount !== 1) {
    throw new Error(`Unexpected nested field count ${nestedCount} at ${start}`);
  }
  const key3Len = buf[p++];
  const key3 = buf.toString("ascii", p, p + key3Len);
  p += key3Len;
  const key3Tag = buf[p++];
  if (key3Tag !== 6) {
    throw new Error(`Unexpected nested blob tag ${key3Tag} at ${start}`);
  }
  const blob2Len = readI32(buf, p);
  p += 4;
  p += blob2Len;

  const pitchHz = blob1Len >= 4 ? readF32(buf, blob1Start) : 0;
  return {
    start,
    size: p - start,
    key1,
    blob1Len,
    key2,
    key3,
    blob2Len,
    pitchHz,
  };
}

function histogram(values) {
  const map = new Map();
  for (const v of values) map.set(v, (map.get(v) || 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const jsonIdx = args.indexOf("--json");
  const jsonPath = jsonIdx >= 0 ? path.resolve(args[jsonIdx + 1] || "llsm-inspect.json") : null;

  const buf = fs.readFileSync(inputPath);
  const { rootKey, rootValue, parsedBytes } = parseRoot(buf);
  const offsets = rootValue._3a || [];
  const frameRows = offsets.map((off) => parseFrameAt(buf, off));
  const gapRows = offsets.slice(1).map((off, i) => off - offsets[i]);

  const output = {
    file: inputPath,
    sizeBytes: buf.length,
    parsedHeaderBytes: parsedBytes,
    rootKey,
    version: rootValue.version,
    durationSec: rootValue.duration,
    config: rootValue._35,
    frameIndexCount: offsets.length,
    frameOffsetMin: offsets.length ? Math.min(...offsets) : 0,
    frameOffsetMax: offsets.length ? Math.max(...offsets) : 0,
    frameGapHistogram: histogram(gapRows),
    frameBlob1Histogram: histogram(frameRows.map((r) => r.blob1Len)),
    frameBlob2Histogram: histogram(frameRows.map((r) => r.blob2Len)),
    firstFrames: frameRows.slice(0, 12),
    lastFrames: frameRows.slice(-8),
  };

  console.log(JSON.stringify(output, null, 2));

  if (jsonPath) {
    fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.error(`Wrote ${jsonPath}`);
  }
}

main();
