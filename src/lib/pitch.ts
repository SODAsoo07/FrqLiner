// pitch.ts

/**
 * Note frequencies based on A4 = 440 Hz
 */
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Parses a note string like "C4", "D#3", "A2" and returns its frequency in Hz.
 * If invalid, returns null.
 */
export function getFrequencyFromNote(noteString: string): number | null {
    const match = noteString.match(/^([A-G]#?)([0-9])$/i);
    if (!match) return null;

    const note = match[1].toUpperCase();
    const octave = parseInt(match[2], 10);

    const noteIndex = NOTES.indexOf(note);
    if (noteIndex === -1) return null;

    // A4 (index 9, octave 4) is 440Hz
    // Calculate half-steps from A4
    const stepsFromA4 = (octave - 4) * 12 + (noteIndex - 9);

    return 440 * Math.pow(2, stepsFromA4 / 12);
}

/**
 * Extracts the expected pitch from a filename or foldername if it matches standard UTAU conventions.
 * Conventions usually include a suffix like "_D4", "_C#3", etc.
 */
export function extractExpectedF0(filename: string, foldername?: string): number | null {
    // Common UTAU convention is to append the pitch like _C4 or -C4
    const pitchRegex = /[_\\-]([A-G]#?[0-9])/i;

    let match = filename.match(pitchRegex);
    if (match) {
        const freq = getFrequencyFromNote(match[1]);
        if (freq) return freq;
    }

    if (foldername) {
        match = foldername.match(pitchRegex);
        if (match) {
            const freq = getFrequencyFromNote(match[1]);
            if (freq) return freq;
        }
    }

    return null;
}
