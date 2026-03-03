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
