// vibeOS in offline.html: the archive scripts/offline-vibeos.mjs put in the
// file, read the first time the page switches to vibeOS (pm/main.js
// loadVibe), never before. Each file becomes a Blob with a blob: URL of its
// own, the stylesheet's placeholders replaced with the URLs of the files it
// names, which come before it (a game's page names its files as data: URLs
// already). What the page gets is what the served demo
// has from its server: the module and the stylesheet to load, and a
// resolver for vibeOS's own requests (BrowserHost.assets), each of its
// root-relative paths to its file's URL, `data:,` for one the file does not
// carry, so no path is ever asked of file:.

const ID = 'pm-vibeos';
const PLACEHOLDER = /@@pm-vibeos:(\d+)@@/g;

/** whether this file carries vibeOS */
export const hasVibeOS = () => !!document.getElementById(ID);

let unpacked = null;

async function unpack() {
	const element = document.getElementById(ID);
	if (!element) throw new Error('this file carries no vibeOS');
	const packed = Uint8Array.fromBase64(element.textContent.trim());
	const plain = new Uint8Array(
		await new Response(
			new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip')),
		).arrayBuffer(),
	);
	const length = new DataView(plain.buffer).getUint32(0);
	const index = JSON.parse(
		new TextDecoder().decode(plain.subarray(4, 4 + length)),
	);
	const urls = [];
	const byPath = new Map();
	let at = 4 + length;
	for (const [path, type, size, text] of index) {
		const bytes = plain.subarray(at, at + size);
		at += size;
		const body = text
			? new TextDecoder()
					.decode(bytes)
					.replace(PLACEHOLDER, (_, n) => urls[Number(n)] ?? 'data:,')
			: bytes;
		const url = URL.createObjectURL(new Blob([body], { type }));
		urls.push(url);
		byPath.set(path, url);
	}
	// the text is not needed again: its files are Blobs now
	element.remove();
	return {
		module: byPath.get('embed.js'),
		sheet: byPath.get('embed.css'),
		assets: (path) => byPath.get(path.replace(/^\//, '')) ?? 'data:,',
	};
}

/** vibeOS's module, stylesheet and file resolver, unpacked once */
export function vibeosFiles() {
	unpacked ??= unpack().catch((error) => {
		unpacked = null;
		throw error;
	});
	return unpacked;
}
