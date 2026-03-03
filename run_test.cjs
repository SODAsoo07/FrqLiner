const { execSync } = require('child_process');
try {
    const output = execSync('npx tsx verify_frq.ts', { encoding: 'utf-8' });
    console.log('SUCCESS:');
    console.log(output);
} catch (e) {
    console.log('ERROR STATUS:', e.status);
    console.log('STDOUT:', e.stdout);
    console.log('STDERR:', e.stderr);
}
