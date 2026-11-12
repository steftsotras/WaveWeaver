// Production entry: `npm run build && npm start`.
//
// adapter-node caps request bodies at 512 KB by default, which would reject
// every real upload. Uploads stream straight to disk, so lift the cap.
process.env.BODY_SIZE_LIMIT ??= 'Infinity';
process.env.PORT ??= '5190';

// The desktop app holds our stdin open. If it dies without stopping us, the
// pipe closes and we go too, rather than sitting on the port forever.
if (process.env.WAVEWEAVER_DESKTOP) {
	process.stdin.resume();
	process.stdin.on('end', () => process.exit());
}

await import('../build/index.js');
