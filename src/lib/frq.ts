export interface FrqFrame {
    f0: number;
    amp: number;
}

export interface FrqData {
    samplesPerWindow: number;
    windowInterval: number;
    unknown20: number;
    unknown24: number;
    unknown28: number;
    unknown32: number;
    unknown36: number;
    frames: FrqFrame[];
}

export interface MrqData {
    version: number;
    entries: MrqEntry[];
}

export interface MrqEntry {
    filename: string;
    sampleRate: number;
    hopSize: number;
    f0: Float32Array;
}

interface LlsmObject {
    [key: string]: LlsmValue;
}

type LlsmValue = number | number[] | LlsmObject | null;

const HEADER_SIZE = 40;
const FRAME_SIZE = 16;
const MAGIC = 'FREQ0003';

export function parseFrq(buffer: ArrayBuffer): FrqData {
    const dataView = new DataView(buffer);

    // Verify magic
    const magicBytes = new Uint8Array(buffer, 0, 8);
    const magicStr = String.fromCharCode(...magicBytes);
    if (magicStr !== MAGIC) {
        throw new Error(`Invalid FRQ file magic: ${magicStr}`);
    }

    const samplesPerWindow = dataView.getInt32(8, true);
    const windowInterval = dataView.getFloat64(12, true);

    // Read unknown header values faithfully so we can serialize them back
    const unknown20 = dataView.getInt32(20, true);
    const unknown24 = dataView.getInt32(24, true);
    const unknown28 = dataView.getInt32(28, true);
    const unknown32 = dataView.getInt32(32, true);
    const unknown36 = dataView.getInt32(36, true);

    const numFrames = (buffer.byteLength - HEADER_SIZE) / FRAME_SIZE;
    const frames: FrqFrame[] = [];

    for (let i = 0; i < numFrames; i++) {
        const offset = HEADER_SIZE + i * FRAME_SIZE;
        const f0 = dataView.getFloat64(offset, true);
        const amp = dataView.getFloat64(offset + 8, true);
        frames.push({ f0, amp });
    }

    return {
        samplesPerWindow,
        windowInterval,
        unknown20,
        unknown24,
        unknown28,
        unknown32,
        unknown36,
        frames,
    };
}

export function writeFrq(data: FrqData): ArrayBuffer {
    const numFrames = data.frames.length;
    const bufferLength = HEADER_SIZE + numFrames * FRAME_SIZE;
    const buffer = new ArrayBuffer(bufferLength);
    const dataView = new DataView(buffer);

    // Write magic
    for (let i = 0; i < MAGIC.length; i++) {
        dataView.setUint8(i, MAGIC.charCodeAt(i));
    }

    dataView.setInt32(8, data.samplesPerWindow, true);
    dataView.setFloat64(12, data.windowInterval, true);

    dataView.setInt32(20, data.unknown20, true);
    dataView.setInt32(24, data.unknown24, true);
    dataView.setInt32(28, data.unknown28, true);
    dataView.setInt32(32, data.unknown32, true);
    dataView.setInt32(36, data.unknown36, true);

    for (let i = 0; i < numFrames; i++) {
        const offset = HEADER_SIZE + i * FRAME_SIZE;
        const frame = data.frames[i];
        dataView.setFloat64(offset, frame.f0, true);
        dataView.setFloat64(offset + 8, frame.amp, true);
    }

    return buffer;
}

export function parseMrq(buffer: ArrayBuffer): MrqData {
    const dataView = new DataView(buffer);
    const magicStr = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    if (magicStr !== 'mrq ') {
        throw new Error(`Invalid MRQ file magic: ${magicStr}`);
    }

    let pos = 4;
    const version = dataView.getInt32(pos, true); pos += 4;
    const nentries = dataView.getInt32(pos, true); pos += 4;

    const entries: MrqEntry[] = [];

    for (let i = 0; i < nentries; i++) {
        const nfilename = dataView.getInt32(pos, true); pos += 4;

        // Read UTF-16LE filename
        const filenameBytes = new Uint8Array(buffer, pos, nfilename * 2);
        const filename = new TextDecoder('utf-16le').decode(filenameBytes);
        pos += nfilename * 2;

        const size = dataView.getInt32(pos, true); pos += 4;
        const nextPos = pos + size;

        const nf0 = dataView.getInt32(pos, true); pos += 4;
        const sampleRate = dataView.getInt32(pos, true); pos += 4;
        const hopSize = dataView.getInt32(pos, true); pos += 4;

        const f0 = new Float32Array(nf0);
        for (let j = 0; j < nf0; j++) {
            f0[j] = dataView.getFloat32(pos, true);
            pos += 4;
        }

        entries.push({ filename, sampleRate, hopSize, f0 });
        pos = nextPos;
    }

    return { version, entries };
}

export function writeMrq(data: MrqData): ArrayBuffer {
    // Calculate total size first
    let totalSize = 4 + 4 + 4; // magic + version + nentries
    for (const entry of data.entries) {
        totalSize += 4; // nfilename
        totalSize += entry.filename.length * 2; // UTF-16 strings take 2 bytes per char
        totalSize += 4; // size metadata
        totalSize += 12; // nf0 + sampleRate + hopSize
        totalSize += entry.f0.length * 4; // f0 floats
    }

    const buffer = new ArrayBuffer(totalSize);
    const dataView = new DataView(buffer);
    let pos = 0;

    // magic
    dataView.setUint8(pos++, 'm'.charCodeAt(0));
    dataView.setUint8(pos++, 'r'.charCodeAt(0));
    dataView.setUint8(pos++, 'q'.charCodeAt(0));
    dataView.setUint8(pos++, ' '.charCodeAt(0));

    dataView.setInt32(pos, data.version, true); pos += 4;
    dataView.setInt32(pos, data.entries.length, true); pos += 4;

    for (const entry of data.entries) {
        dataView.setInt32(pos, entry.filename.length, true); pos += 4;

        for (let i = 0; i < entry.filename.length; i++) {
            dataView.setUint16(pos, entry.filename.charCodeAt(i), true);
            pos += 2;
        }

        const payloadSize = 12 + entry.f0.length * 4;
        dataView.setInt32(pos, payloadSize, true); pos += 4;

        dataView.setInt32(pos, entry.f0.length, true); pos += 4;
        dataView.setInt32(pos, entry.sampleRate, true); pos += 4;
        dataView.setInt32(pos, entry.hopSize, true); pos += 4;

        for (let i = 0; i < entry.f0.length; i++) {
            dataView.setFloat32(pos, entry.f0[i], true);
            pos += 4;
        }
    }

    return buffer;
}

const readAscii = (bytes: Uint8Array, offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new Error('LLSM parse error: out of bounds string read');
    }
    let out = '';
    for (let i = 0; i < length; i++) {
        out += String.fromCharCode(bytes[offset + i]);
    }
    return out;
};

const readTagNode = (
    dv: DataView,
    bytes: Uint8Array,
    startOffset: number,
): { value: LlsmValue; nextOffset: number } => {
    let off = startOffset;
    if (off >= dv.byteLength) {
        throw new Error('LLSM parse error: node offset out of bounds');
    }

    const tag = dv.getUint8(off);
    off += 1;

    if (tag === 1) {
        if (off + 4 > dv.byteLength) throw new Error('LLSM parse error: invalid object node');
        const count = dv.getInt32(off, true);
        off += 4;
        if (count < 0) throw new Error('LLSM parse error: negative object field count');

        const obj: Record<string, LlsmValue> = {};
        for (let i = 0; i < count; i++) {
            if (off >= dv.byteLength) throw new Error('LLSM parse error: object key length overflow');
            const keyLen = dv.getUint8(off);
            off += 1;
            const key = readAscii(bytes, off, keyLen);
            off += keyLen;
            const child = readTagNode(dv, bytes, off);
            obj[key] = child.value;
            off = child.nextOffset;
        }
        return { value: obj, nextOffset: off };
    }

    if (tag === 3) {
        if (off + 4 > dv.byteLength) throw new Error('LLSM parse error: invalid float node');
        const value = dv.getFloat32(off, true);
        off += 4;
        return { value, nextOffset: off };
    }

    if (tag === 5) {
        if (off + 8 > dv.byteLength) throw new Error('LLSM parse error: invalid vector node');
        const n = dv.getInt32(off, true);
        off += 4;
        const kind = dv.getInt32(off, true);
        off += 4;
        if (n < 0) throw new Error('LLSM parse error: negative vector length');
        if (off + n * 4 > dv.byteLength) throw new Error('LLSM parse error: vector data overflow');

        const values: number[] = new Array(n);
        for (let i = 0; i < n; i++) {
            values[i] = kind === 2 ? dv.getInt32(off, true) : dv.getFloat32(off, true);
            off += 4;
        }
        return { value: values, nextOffset: off };
    }

    if (tag === 6) {
        if (off + 4 > dv.byteLength) throw new Error('LLSM parse error: invalid blob node');
        const n = dv.getInt32(off, true);
        off += 4;
        if (n < 0 || off + n > dv.byteLength) throw new Error('LLSM parse error: blob data overflow');
        off += n;
        return { value: null, nextOffset: off };
    }

    if (tag === 7) {
        if (off + 4 > dv.byteLength) throw new Error('LLSM parse error: invalid int array node');
        const n = dv.getInt32(off, true);
        off += 4;
        if (n < 0 || off + n * 4 > dv.byteLength) throw new Error('LLSM parse error: int array overflow');
        const values: number[] = new Array(n);
        for (let i = 0; i < n; i++) {
            values[i] = dv.getInt32(off, true);
            off += 4;
        }
        return { value: values, nextOffset: off };
    }

    throw new Error(`LLSM parse error: unsupported tag ${tag}`);
};

const readFramePitch = (
    dv: DataView,
    bytes: Uint8Array,
    startOffset: number,
): { pitchHz: number; pitchOffset: number; nextOffset: number } => {
    let off = startOffset;
    if (off >= dv.byteLength) throw new Error('LLSM frame parse error: offset out of bounds');

    const tag = dv.getUint8(off);
    off += 1;

    if (tag !== 1) throw new Error(`LLSM frame parse error: expected object tag, got ${tag}`);
    if (off + 4 > dv.byteLength) throw new Error('LLSM frame parse error: invalid object');

    const count = dv.getInt32(off, true);
    off += 4;
    if (count < 0) throw new Error('LLSM frame parse error: negative object field count');

    let pitchHz = 0;
    let pitchOffset = -1;
    for (let i = 0; i < count; i++) {
        if (off >= dv.byteLength) throw new Error('LLSM frame parse error: key overflow');
        const keyLen = dv.getUint8(off);
        off += 1;
        const key = readAscii(bytes, off, keyLen);
        off += keyLen;
        if (off >= dv.byteLength) throw new Error('LLSM frame parse error: value overflow');

        const childTag = dv.getUint8(off);
        if (childTag === 6) {
            off += 1;
            if (off + 4 > dv.byteLength) throw new Error('LLSM frame parse error: invalid blob');
            const blobLen = dv.getInt32(off, true);
            off += 4;
            if (blobLen < 0 || off + blobLen > dv.byteLength) throw new Error('LLSM frame parse error: blob overflow');

            if (key === '_40' && blobLen >= 4) {
                const raw = dv.getFloat32(off, true);
                pitchHz = Number.isFinite(raw) && raw > 1 ? raw : 0;
                pitchOffset = off;
            }
            off += blobLen;
            continue;
        }

        const child = readTagNode(dv, bytes, off);
        off = child.nextOffset;
    }

    return { pitchHz, pitchOffset, nextOffset: off };
};

const asRecord = (value: LlsmValue): Record<string, LlsmValue> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

const asNumber = (value: LlsmValue): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

const asNumberArray = (value: LlsmValue): number[] =>
    Array.isArray(value) ? value.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];

export function parseLlsm(buffer: ArrayBuffer): FrqData {
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    if (dv.byteLength < 2) throw new Error('Invalid LLSM file: too short');

    let off = 0;
    const rootKeyLen = dv.getUint8(off);
    off += 1;
    const rootKey = readAscii(bytes, off, rootKeyLen);
    off += rootKeyLen;

    const rootNode = readTagNode(dv, bytes, off);
    if (rootNode.nextOffset > dv.byteLength) throw new Error('Invalid LLSM file: root overflow');

    const rootObj = asRecord(rootNode.value);
    if (!rootObj) throw new Error('Invalid LLSM file: root object missing');
    const dataObj = rootKey === 'data' ? rootObj : asRecord(rootObj.data) || rootObj;

    const configObj = asRecord(dataObj._35);
    const frameOffsets = asNumberArray(dataObj._3a).map(v => Math.trunc(v));

    const frames: FrqFrame[] = frameOffsets.map(start => {
        if (start < 0 || start >= dv.byteLength) {
            return { f0: 0, amp: 100 };
        }
        try {
            const { pitchHz } = readFramePitch(dv, bytes, start);
            return { f0: Number.isFinite(pitchHz) ? pitchHz : 0, amp: 100 };
        } catch {
            return { f0: 0, amp: 100 };
        }
    });

    const hopSize = configObj ? asNumber(configObj._2) : null;
    const hopSeconds = configObj ? asNumber(configObj._c) : null;

    return {
        samplesPerWindow: hopSize && hopSize > 0 ? Math.round(hopSize) : 256,
        windowInterval: hopSeconds && hopSeconds > 0 ? hopSeconds * 1000 : 5.805,
        unknown20: 0,
        unknown24: 0,
        unknown28: 0,
        unknown32: 0,
        unknown36: 0,
        frames,
    };
}

export function writeLlsm(baseBuffer: ArrayBuffer, data: FrqData): ArrayBuffer {
    const output = baseBuffer.slice(0);
    const bytes = new Uint8Array(output);
    const dv = new DataView(output);
    if (dv.byteLength < 2) throw new Error('Invalid LLSM file: too short');

    let off = 0;
    const rootKeyLen = dv.getUint8(off);
    off += 1;
    const rootKey = readAscii(bytes, off, rootKeyLen);
    off += rootKeyLen;

    const rootNode = readTagNode(dv, bytes, off);
    if (rootNode.nextOffset > dv.byteLength) throw new Error('Invalid LLSM file: root overflow');

    const rootObj = asRecord(rootNode.value);
    if (!rootObj) throw new Error('Invalid LLSM file: root object missing');
    const dataObj = rootKey === 'data' ? rootObj : asRecord(rootObj.data) || rootObj;
    const frameOffsets = asNumberArray(dataObj._3a).map(v => Math.trunc(v));
    const frameCount = Math.min(frameOffsets.length, data.frames.length);

    for (let i = 0; i < frameCount; i++) {
        const start = frameOffsets[i];
        if (start < 0 || start >= dv.byteLength) continue;
        try {
            const meta = readFramePitch(dv, bytes, start);
            if (meta.pitchOffset < 0 || meta.pitchOffset + 4 > dv.byteLength) continue;
            const originalVoiced = meta.pitchHz > 1;
            const nextPitch = data.frames[i]?.f0;
            let safePitch = 0;

            // Safety: keep originally-unvoiced frames unvoiced.
            // In libllsm2 synthesis, setting voiced F0 on frames without voiced structures
            // can make the whole chunk fail integrity checks and result in silence.
            if (originalVoiced) {
                if (!Number.isFinite(nextPitch)) {
                    safePitch = meta.pitchHz;
                } else if ((nextPitch as number) > 1) {
                    safePitch = nextPitch as number;
                } else {
                    safePitch = 0;
                }
            }

            dv.setFloat32(meta.pitchOffset, safePitch, true);
        } catch {
            // Skip malformed frame and continue patching others
        }
    }

    return output;
}

/**
 * Parse a PMK (TIPS / EFB-GW / EFB-GT WORLD vocoder) file.
 *
 * PMK stores F0 as Float32 period-in-samples:  hz = sampleRate / period
 * The header size varies per file, so we use a sliding-window correlation scan:
 * find the offset where a block of `numFrames` Float32 values best resembles
 * plausible pitch periods.
 *
 * @param buffer     Raw PMK ArrayBuffer
 * @param numFrames  Expected number of frames  (= Math.ceil(wavSamples / hopSize))
 * @param sampleRate Sample rate of the source WAV  (default 44100)
 * @param hopSize    Analysis hop size in samples    (default 256)
 */
export function parsePmk(
    buffer: ArrayBuffer,
    numFrames: number,
    sampleRate = 44100,
    hopSize = 256,
): FrqData {
    const dv = new DataView(buffer);
    const minPeriod = sampleRate / 900;  // ≈49 samples @ 44100 Hz / 900 Hz
    const maxPeriod = sampleRate / 50;   // ≈882 samples @ 44100 Hz / 50 Hz
    const maxStart = buffer.byteLength - numFrames * 4;

    let bestOffset = 0;
    let bestScore = -1;

    for (let start = 0; start <= maxStart; start += 4) {
        let pitched = 0;
        for (let i = 0; i < numFrames; i++) {
            const p = dv.getFloat32(start + i * 4, true);
            if (p >= minPeriod && p <= maxPeriod) pitched++;
        }
        const score = pitched / numFrames;
        if (score > bestScore) {
            bestScore = score;
            bestOffset = start;
            if (bestScore > 0.85) break; // Good enough — stop early
        }
    }

    // Convert period → Hz and build FrqData
    const frames: FrqFrame[] = [];
    const windowInterval = (hopSize / sampleRate) * 1000; // ms per frame

    for (let i = 0; i < numFrames; i++) {
        const period = dv.getFloat32(bestOffset + i * 4, true);
        frames.push({ f0: period > 0 ? sampleRate / period : 0, amp: 100 });
    }

    return {
        samplesPerWindow: hopSize,
        windowInterval,
        unknown20: 0, unknown24: 0, unknown28: 0, unknown32: 0, unknown36: 0,
        frames,
    };
}
