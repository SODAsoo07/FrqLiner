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
