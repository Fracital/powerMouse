// Screenshot and text similarity between a proxied load and the native one.
// Images are compared in a plain page of the native browser (canvas
// decoding, no dependencies): both are scaled to 320x200 grey, then the mean
// SSIM over 8x8 windows and the Hamming distance of a 64-bit difference
// hash. Text is compared as sets of word tokens.

const COMPARE = `async ([a, b]) => {
	const load = (src) => new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
	const grey = (img, w, h) => {
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext('2d');
		ctx.drawImage(img, 0, 0, w, h);
		const data = ctx.getImageData(0, 0, w, h).data;
		const out = new Float64Array(w * h);
		for (let i = 0; i < out.length; i++)
			out[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
		return out;
	};
	const [ia, ib] = await Promise.all([load(a), load(b)]);
	const W = 320, H = 200, S = 8;
	const ga = grey(ia, W, H), gb = grey(ib, W, H);
	const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
	let total = 0, count = 0;
	for (let y = 0; y + S <= H; y += S / 2)
		for (let x = 0; x + S <= W; x += S / 2) {
			let ma = 0, mb = 0;
			for (let j = 0; j < S; j++)
				for (let i = 0; i < S; i++) {
					ma += ga[(y + j) * W + x + i];
					mb += gb[(y + j) * W + x + i];
				}
			ma /= S * S; mb /= S * S;
			let va = 0, vb = 0, cov = 0;
			for (let j = 0; j < S; j++)
				for (let i = 0; i < S; i++) {
					const da = ga[(y + j) * W + x + i] - ma, db = gb[(y + j) * W + x + i] - mb;
					va += da * da; vb += db * db; cov += da * db;
				}
			va /= S * S - 1; vb /= S * S - 1; cov /= S * S - 1;
			total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
			count++;
		}
	const dhash = (img) => {
		const g = grey(img, 9, 8);
		const bits = [];
		for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(g[y * 9 + x] < g[y * 9 + x + 1]);
		return bits;
	};
	const da = dhash(ia), db = dhash(ib);
	let dist = 0;
	for (let i = 0; i < 64; i++) if (da[i] !== db[i]) dist++;
	return { ssim: total / count, phash_dist: dist };
}`;

/** compares two JPEG/PNG buffers in `page` (a plain page of a browser) */
export async function compareImages(page, a, b) {
	const url = (buf) =>
		`data:image/${buf[0] === 0x89 ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
	return page.evaluate(`(${COMPARE})(${JSON.stringify([url(a), url(b)])})`);
}

export function tokens(text) {
	const set = new Set();
	for (const match of String(text || '')
		.toLowerCase()
		.matchAll(/[\p{L}\p{N}]{2,}/gu))
		set.add(match[0]);
	return set;
}

/** the share of `reference`'s tokens that `other` also has (0..1) */
export function textOverlap(reference, other) {
	if (!reference.size) return other.size ? 0 : 1;
	let shared = 0;
	for (const token of reference) if (other.has(token)) shared++;
	return shared / reference.size;
}
