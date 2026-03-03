import fs from 'fs';
import path from 'path';
import { parseFrq, writeFrq } from './src/lib/frq.ts';
import { extractExpectedF0 } from './src/lib/pitch.ts';

const testFiles = [
    '_a-a-i-a-u-a-e_wav.frq',
    'fa-fi-fu-fe-fo-fa-N-fu_wav.frq',
    'kya-kyu-kye-kyo-kya_wav.frq'
];

const basePath = '../fileEx';

for (const file of testFiles) {
    const filepath = path.resolve(process.cwd(), basePath, file);
    console.log(`\nTesting ${file}...`);

    const buffer = fs.readFileSync(filepath).buffer;

    // Test parse
    const data = parseFrq(buffer);
    console.log(`Parsed ${data.frames.length} frames.`);

    // Test write
    const outputBuffer = writeFrq(data);
    const originalBytes = new Uint8Array(buffer);
    const newBytes = new Uint8Array(outputBuffer);

    if (originalBytes.length !== newBytes.length) {
        console.error(`❌ Length mismatch: Expected ${originalBytes.length}, got ${newBytes.length}`);
        continue;
    }

    let match = true;
    for (let i = 0; i < originalBytes.length; i++) {
        if (originalBytes[i] !== newBytes[i]) {
            console.error(`❌ Byte mismatch at index ${i}: Expected ${originalBytes[i]}, got ${newBytes[i]}`);
            match = false;
            break;
        }
    }

    if (match) {
        console.log(`✅ ${file} successfully parsed and re-serialized perfectly!`);
    }
}

// Test pitch extractor
console.log('\nTesting Pitch Extractor...');
const testStrings = [
    'yey_C#4_wav.frq',
    'sample_A3.wav',
    'folder_D4/file.wav',
    'test_C3_wav.frq'
];

for (const ts of testStrings) {
    const f0 = extractExpectedF0(ts);
    console.log(`${ts} -> ${f0 ? f0.toFixed(2) + 'Hz' : 'null'}`);
}
