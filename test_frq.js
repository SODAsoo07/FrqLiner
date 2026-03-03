const fs = require('fs');
const filepath = 'c:/Users/oyh57/SODAsoo1/Devs/Frqliner/fileEx/_a-a-i-a-u-a-e_wav.frq';
const buffer = fs.readFileSync(filepath);

console.log('File size:', buffer.length);
console.log('Magic:', buffer.toString('ascii', 0, 8));
console.log('Int1 (samplesPerWindow?):', buffer.readInt32LE(8));
console.log('Double1 (windowInterval?):', buffer.readDoubleLE(12));
console.log('Int2 (something?):', buffer.readInt32LE(20));
console.log('Int3 (something?):', buffer.readInt32LE(24));
console.log('Int4 (something?):', buffer.readInt32LE(28));
console.log('Int5 (something?):', buffer.readInt32LE(32));
console.log('Int6 (something?):', buffer.readInt32LE(36));
console.log('Data length:', buffer.length - 40);

const frames = (buffer.length - 40) / 16;
console.log('Frames if header is 40 and frame is 16 bytes:', frames);

for(let i = 0; i < 5; i++) {
  const offset = 40 + i * 16;
  const f0 = buffer.readDoubleLE(offset);
  const amp = buffer.readDoubleLE(offset + 8);
  console.log(`Frame ${i}: f0=${f0}, amp=${amp}`);
}
