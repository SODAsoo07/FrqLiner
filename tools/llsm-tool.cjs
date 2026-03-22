#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const HEADER_ALIAS_TO_PATH = {
  _2: "data._35._2",
  _3: "data._35._3",
  _4: "data._35._4",
  _8: "data._35._8",
  _9: "data._35._9",
  _a: "data._35._a",
  _b: "data._35._b",
  _12: "data._35._12",
  _13: "data._35._13",
  nhop: "data._35._2",
  maxnhar: "data._35._3",
  maxnhare: "data._35._4",
  nnoise: "data._35._8",
  noswarp: "data._35._9",
  mvf: "data._35._a",
  nosf: "data._35._b",
  nnosband: "data._35._12",
  nosbandf: "data._35._13",
};

const EXPERIMENTAL_ALLOWED_ALIASES = new Set([
  "_2",
  "_3",
  "_4",
  "_8",
  "_9",
  "_a",
  "_b",
  "_12",
  "_13",
  "nhop",
  "maxnhar",
  "maxnhare",
  "nnoise",
  "noswarp",
  "mvf",
  "nosf",
  "nnosband",
  "nosbandf",
]);

function usage() {
  console.log("LLSM tool (pitch-first + experimental header patch)");
  console.log("");
  console.log("Main (pitch):");
  console.log("  node tools/llsm-tool.cjs pitch export <input.llsm> [--out <output.json>]");
  console.log("  node tools/llsm-tool.cjs pitch apply <input.llsm> <pitch.json> <output.llsm> [--force]");
  console.log("  node tools/llsm-tool.cjs pitch shift <input.llsm> <output.llsm> (--cents <n> | --ratio <r>) [--all]");
  console.log("");
  console.log("Experimental (restricted header patch):");
  console.log("  node tools/llsm-tool.cjs experimental header-set <input.llsm> <output.llsm> --set <key=value> [--set <key=value> ...] --experimental");
  console.log("");
  console.log("Allowed experimental keys:");
  console.log("  nhop(_2), maxnhar(_3), maxnhare(_4), nnoise(_8), noswarp(_9), mvf(_a), nosf(_b), nnosband(_12), nosbandf(_13)");
  console.log("");
  console.log("Legacy aliases:");
  console.log("  read  => pitch export");
  console.log("  write => pitch apply");
}

function i32(buf, off) {
  return buf.readInt32LE(off);
}

function f32(buf, off) {
  return buf.readFloatLE(off);
}

function parseNode(buf, start, keyPath, index) {
  let off = start;
  const tagOffset = off;
  const tag = buf[off++];
  const node = {
    keyPath,
    tag,
    tagOffset,
  };

  if (tag === 1) {
    const count = i32(buf, off);
    off += 4;
    node.count = count;
    node.children = {};
    index[keyPath] = node;

    for (let i = 0; i < count; i += 1) {
      const keyLen = buf[off++];
      const key = buf.toString("ascii", off, off + keyLen);
      off += keyLen;
      const childPath = `${keyPath}.${key}`;
      const parsed = parseNode(buf, off, childPath, index);
      off = parsed.nextOffset;
      node.children[key] = parsed.value;
    }

    return { value: node.children, nextOffset: off };
  }

  if (tag === 3) {
    node.valueOffset = off;
    node.value = f32(buf, off);
    off += 4;
    index[keyPath] = node;
    return { value: node.value, nextOffset: off };
  }

  if (tag === 5) {
    const n = i32(buf, off);
    off += 4;
    const kind = i32(buf, off);
    off += 4;
    node.n = n;
    node.kind = kind;
    node.valuesOffset = off;

    const values = [];
    for (let i = 0; i < n; i += 1) {
      if (kind === 1) {
        values.push(f32(buf, off));
      } else if (kind === 2) {
        values.push(i32(buf, off));
      } else {
        values.push(f32(buf, off));
      }
      off += 4;
    }

    node.values = values;
    index[keyPath] = node;
    return { value: { tag, kind, values }, nextOffset: off };
  }

  if (tag === 7) {
    const n = i32(buf, off);
    off += 4;
    node.n = n;
    node.valuesOffset = off;
    const values = [];
    for (let i = 0; i < n; i += 1) {
      values.push(i32(buf, off));
      off += 4;
    }
    node.values = values;
    index[keyPath] = node;
    return { value: values, nextOffset: off };
  }

  throw new Error(`Unsupported tag ${tag} at offset ${tagOffset}`);
}

function parseRoot(buf) {
  let off = 0;
  const rootKeyLen = buf[off++];
  const rootKey = buf.toString("ascii", off, off + rootKeyLen);
  off += rootKeyLen;

  const index = {};
  const parsed = parseNode(buf, off, rootKey, index);
  return {
    rootKey,
    rootValue: parsed.value,
    rootIndex: index,
    parsedHeaderBytes: parsed.nextOffset,
  };
}

function parseFrameMeta(buf, start) {
  let off = start;
  const tag = buf[off++];
  if (tag !== 1) throw new Error(`Frame at ${start}: object tag expected, got ${tag}`);

  const fieldCount = i32(buf, off);
  off += 4;
  if (fieldCount !== 2) throw new Error(`Frame at ${start}: field count expected 2, got ${fieldCount}`);

  const key1Len = buf[off++];
  const key1 = buf.toString("ascii", off, off + key1Len);
  off += key1Len;

  const key1Tag = buf[off++];
  if (key1Tag !== 6) throw new Error(`Frame at ${start}: key1 blob tag expected 6, got ${key1Tag}`);
  const blob1Len = i32(buf, off);
  off += 4;
  const blob1Start = off;
  off += blob1Len;

  const key2Len = buf[off++];
  const key2 = buf.toString("ascii", off, off + key2Len);
  off += key2Len;

  const key2Tag = buf[off++];
  if (key2Tag !== 1) throw new Error(`Frame at ${start}: nested object tag expected 1, got ${key2Tag}`);
  const nestedCount = i32(buf, off);
  off += 4;
  if (nestedCount !== 1) throw new Error(`Frame at ${start}: nested field count expected 1, got ${nestedCount}`);

  const key3Len = buf[off++];
  const key3 = buf.toString("ascii", off, off + key3Len);
  off += key3Len;

  const key3Tag = buf[off++];
  if (key3Tag !== 6) throw new Error(`Frame at ${start}: nested blob tag expected 6, got ${key3Tag}`);
  const blob2Len = i32(buf, off);
  off += 4;
  const blob2Start = off;
  off += blob2Len;

  const pitchOffset = blob1Len >= 4 ? blob1Start : -1;
  const pitchHz = pitchOffset >= 0 ? f32(buf, pitchOffset) : 0;

  return {
    start,
    end: off,
    size: off - start,
    key1,
    key2,
    key3,
    blob1Len,
    blob1Start,
    blob2Len,
    blob2Start,
    pitchOffset,
    pitchHz,
    voiced: pitchHz > 1,
  };
}

function parseLlsm(buf) {
  const rootParsed = parseRoot(buf);
  const offsets = rootParsed.rootValue && Array.isArray(rootParsed.rootValue._3a) ? rootParsed.rootValue._3a : [];
  const frames = offsets.map((start) => parseFrameMeta(buf, start));
  return {
    ...rootParsed,
    offsets,
    frames,
  };
}

function avg(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function loadPitchArray(jsonPath) {
  const raw = fs.readFileSync(jsonPath, "utf8");
  const data = JSON.parse(raw);

  let source = null;
  if (Array.isArray(data)) {
    source = data;
  } else if (data && Array.isArray(data.pitches)) {
    source = data.pitches;
  } else if (data && Array.isArray(data.frames)) {
    source = data.frames.map((f) => {
      if (typeof f === "number") return f;
      if (f && typeof f.pitchHz === "number") return f.pitchHz;
      if (f && typeof f.f0 === "number") return f.f0;
      if (f && typeof f.pitch === "number") return f.pitch;
      return NaN;
    });
  }

  if (!source) {
    throw new Error("pitch.json format is invalid. Expected array, {pitches:[]}, or {frames:[]}");
  }

  return source.map((v) => (Number.isFinite(v) ? Number(v) : NaN));
}

function parseOption(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return idx + 1 < args.length ? args[idx + 1] : null;
}

function parseRepeatedOption(args, name) {
  const ret = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length) {
      ret.push(args[i + 1]);
      i += 1;
    }
  }
  return ret;
}

function ensureFiniteNumber(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number`);
  return n;
}

function patchPitches(buf, frames, pitches, force) {
  if (!force && pitches.length !== frames.length) {
    throw new Error(`Pitch length mismatch: llsm=${frames.length}, json=${pitches.length}. Use --force to patch by min length.`);
  }

  const limit = Math.min(frames.length, pitches.length);
  let patched = 0;
  let skipped = 0;
  const before = [];
  const after = [];

  for (let i = 0; i < limit; i += 1) {
    const value = pitches[i];
    if (!Number.isFinite(value)) {
      skipped += 1;
      continue;
    }
    const frame = frames[i];
    if (frame.pitchOffset < 0) {
      skipped += 1;
      continue;
    }
    before.push(frame.pitchHz);
    buf.writeFloatLE(value, frame.pitchOffset);
    frame.pitchHz = value;
    after.push(value);
    patched += 1;
  }

  return { patched, skipped, beforeMean: avg(before), afterMean: avg(after) };
}

function pitchExportCommand(inputPath, outPath) {
  const absIn = path.resolve(inputPath);
  const buf = fs.readFileSync(absIn);
  const parsed = parseLlsm(buf);
  const voiced = parsed.frames.filter((f) => f.voiced);

  const report = {
    file: absIn,
    version: parsed.rootValue.version,
    durationSec: parsed.rootValue.duration,
    frameCount: parsed.frames.length,
    voicedCount: voiced.length,
    unvoicedCount: parsed.frames.length - voiced.length,
    meanPitchHz: avg(voiced.map((f) => f.pitchHz)),
    pitches: parsed.frames.map((f) => f.pitchHz),
    frames: parsed.frames.map((f, i) => ({
      index: i,
      pitchHz: f.pitchHz,
      voiced: f.voiced,
    })),
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    const absOut = path.resolve(outPath);
    fs.writeFileSync(absOut, json, "utf8");
    console.error(`Wrote ${absOut}`);
  } else {
    process.stdout.write(json);
  }
}

function pitchApplyCommand(inputPath, pitchJsonPath, outputPath, force) {
  const absIn = path.resolve(inputPath);
  const absPitch = path.resolve(pitchJsonPath);
  const absOut = path.resolve(outputPath);

  const buf = Buffer.from(fs.readFileSync(absIn));
  const parsed = parseLlsm(buf);
  const pitches = loadPitchArray(absPitch);
  const patched = patchPitches(buf, parsed.frames, pitches, force);

  fs.writeFileSync(absOut, buf);
  console.log(
    JSON.stringify(
      {
        input: absIn,
        pitchJson: absPitch,
        output: absOut,
        frameCount: parsed.frames.length,
        pitchCount: pitches.length,
        ...patched,
        force,
      },
      null,
      2,
    ),
  );
}

function pitchShiftCommand(inputPath, outputPath, cents, ratio, allFrames) {
  const absIn = path.resolve(inputPath);
  const absOut = path.resolve(outputPath);

  if (cents == null && ratio == null) {
    throw new Error("pitch shift needs --cents <n> or --ratio <r>");
  }
  if (cents != null && ratio != null) {
    throw new Error("Use either --cents or --ratio, not both.");
  }

  const pitchRatio = ratio != null ? ensureFiniteNumber(ratio, "ratio") : Math.pow(2, ensureFiniteNumber(cents, "cents") / 1200);
  if (!(pitchRatio > 0)) throw new Error("ratio must be > 0");

  const buf = Buffer.from(fs.readFileSync(absIn));
  const parsed = parseLlsm(buf);

  let patched = 0;
  const before = [];
  const after = [];
  for (const frame of parsed.frames) {
    if (frame.pitchOffset < 0) continue;
    if (!allFrames && frame.pitchHz <= 1) continue;
    const nextHz = frame.pitchHz * pitchRatio;
    before.push(frame.pitchHz);
    after.push(nextHz);
    buf.writeFloatLE(nextHz, frame.pitchOffset);
    frame.pitchHz = nextHz;
    patched += 1;
  }

  fs.writeFileSync(absOut, buf);
  console.log(
    JSON.stringify(
      {
        input: absIn,
        output: absOut,
        frameCount: parsed.frames.length,
        patched,
        ratio: pitchRatio,
        cents: 1200 * Math.log2(pitchRatio),
        beforeMean: avg(before),
        afterMean: avg(after),
        allFrames,
      },
      null,
      2,
    ),
  );
}

function parseSetArgument(setArg) {
  const idx = setArg.indexOf("=");
  if (idx <= 0 || idx === setArg.length - 1) {
    throw new Error(`Invalid --set format: ${setArg}. Expected key=value.`);
  }
  const key = setArg.slice(0, idx).trim();
  const valueRaw = setArg.slice(idx + 1).trim();
  if (!key || !valueRaw) throw new Error(`Invalid --set: ${setArg}`);
  return { key, valueRaw };
}

function parseHeaderValue(aliasKey, valueRaw) {
  const canonical = aliasKey.toLowerCase();
  if (canonical === "_13" || canonical === "nosbandf") {
    return valueRaw.split(",").map((x) => ensureFiniteNumber(x.trim(), canonical));
  }
  return ensureFiniteNumber(valueRaw, canonical);
}

function validateHeaderChanges(changes, parsed) {
  const key12Path = "data._35._12";
  const key13Path = "data._35._13";
  const current12 = parsed.rootIndex[key12Path].value;
  const current13Len = parsed.rootIndex[key13Path].n;

  const next12 = changes.has(key12Path) ? changes.get(key12Path) : current12;
  const next13 = changes.has(key13Path) ? changes.get(key13Path) : parsed.rootIndex[key13Path].values;
  const next13Len = Array.isArray(next13) ? next13.length : current13Len;

  if (Math.round(next12) !== next13Len + 1) {
    throw new Error(`Header consistency check failed: nnosband(_12)=${next12}, nosbandf(_13).length=${next13Len}. Required: _12 = _13.length + 1`);
  }

  if (Array.isArray(next13)) {
    for (let i = 1; i < next13.length; i += 1) {
      if (!(next13[i] > next13[i - 1])) {
        throw new Error("nosbandf(_13) must be strictly ascending");
      }
    }
  }

  const positivePaths = new Set([
    "data._35._2",
    "data._35._3",
    "data._35._4",
    "data._35._8",
    "data._35._9",
    "data._35._a",
    "data._35._b",
    "data._35._12",
  ]);

  for (const [keyPath, value] of changes.entries()) {
    if (positivePaths.has(keyPath) && !(Number(value) > 0)) {
      throw new Error(`${keyPath} must be > 0`);
    }
  }
}

function experimentalHeaderSetCommand(inputPath, outputPath, setArgs, experimentalFlag) {
  if (!experimentalFlag) {
    throw new Error("header-set is experimental. Add --experimental to proceed.");
  }
  if (setArgs.length === 0) {
    throw new Error("header-set requires at least one --set key=value");
  }

  const absIn = path.resolve(inputPath);
  const absOut = path.resolve(outputPath);
  const buf = Buffer.from(fs.readFileSync(absIn));
  const parsed = parseLlsm(buf);

  const changes = new Map();
  for (const raw of setArgs) {
    const { key, valueRaw } = parseSetArgument(raw);
    const alias = key.toLowerCase();
    if (!EXPERIMENTAL_ALLOWED_ALIASES.has(alias)) {
      throw new Error(`Key '${key}' is not allowed in experimental mode.`);
    }
    const keyPath = HEADER_ALIAS_TO_PATH[alias];
    if (!keyPath) throw new Error(`Unknown key alias: ${key}`);
    if (!parsed.rootIndex[keyPath]) throw new Error(`Key path not found in file: ${keyPath}`);
    changes.set(keyPath, parseHeaderValue(alias, valueRaw));
  }

  validateHeaderChanges(changes, parsed);

  const applied = [];
  for (const [keyPath, value] of changes.entries()) {
    const node = parsed.rootIndex[keyPath];
    if (node.tag === 3) {
      buf.writeFloatLE(Number(value), node.valueOffset);
      applied.push({ keyPath, old: node.value, new: Number(value), mode: "float32" });
      continue;
    }
    if (node.tag === 5) {
      if (!Array.isArray(value)) throw new Error(`${keyPath} requires array value`);
      if (node.kind !== 1) throw new Error(`${keyPath} kind=${node.kind} is not supported`);
      if (value.length !== node.n) {
        throw new Error(`${keyPath} length must remain ${node.n} (got ${value.length})`);
      }
      for (let i = 0; i < value.length; i += 1) {
        buf.writeFloatLE(value[i], node.valuesOffset + i * 4);
      }
      applied.push({ keyPath, old: node.values, new: value, mode: "float32-array" });
      continue;
    }
    throw new Error(`${keyPath} tag ${node.tag} is not writable`);
  }

  fs.writeFileSync(absOut, buf);
  console.log(
    JSON.stringify(
      {
        input: absIn,
        output: absOut,
        experimental: true,
        appliedCount: applied.length,
        applied,
      },
      null,
      2,
    ),
  );
}

function runLegacyCommand(args) {
  const cmd = args[0];
  if (cmd === "read") {
    const input = args[1];
    if (!input) throw new Error("read requires <input.llsm>");
    const outPath = parseOption(args, "--out");
    pitchExportCommand(input, outPath);
    return true;
  }
  if (cmd === "write") {
    const input = args[1];
    const pitchJson = args[2];
    const output = args[3];
    if (!input || !pitchJson || !output) throw new Error("write requires <input.llsm> <pitch.json> <output.llsm>");
    const force = args.includes("--force");
    pitchApplyCommand(input, pitchJson, output, force);
    return true;
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  if (runLegacyCommand(args)) return;

  const cmd = args[0];

  if (cmd === "pitch") {
    const sub = args[1];
    if (sub === "export") {
      const input = args[2];
      if (!input) throw new Error("pitch export requires <input.llsm>");
      const outPath = parseOption(args, "--out");
      pitchExportCommand(input, outPath);
      return;
    }
    if (sub === "apply") {
      const input = args[2];
      const pitchJson = args[3];
      const output = args[4];
      if (!input || !pitchJson || !output) throw new Error("pitch apply requires <input.llsm> <pitch.json> <output.llsm>");
      const force = args.includes("--force");
      pitchApplyCommand(input, pitchJson, output, force);
      return;
    }
    if (sub === "shift") {
      const input = args[2];
      const output = args[3];
      if (!input || !output) throw new Error("pitch shift requires <input.llsm> <output.llsm>");
      const cents = parseOption(args, "--cents");
      const ratio = parseOption(args, "--ratio");
      const all = args.includes("--all");
      pitchShiftCommand(input, output, cents, ratio, all);
      return;
    }
    throw new Error(`Unknown pitch subcommand: ${sub}`);
  }

  if (cmd === "experimental") {
    const sub = args[1];
    if (sub === "header-set") {
      const input = args[2];
      const output = args[3];
      if (!input || !output) throw new Error("experimental header-set requires <input.llsm> <output.llsm>");
      const setArgs = parseRepeatedOption(args, "--set");
      const experimental = args.includes("--experimental");
      experimentalHeaderSetCommand(input, output, setArgs, experimental);
      return;
    }
    throw new Error(`Unknown experimental subcommand: ${sub}`);
  }

  usage();
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`[llsm-tool] ${err.message}`);
  process.exit(1);
}
