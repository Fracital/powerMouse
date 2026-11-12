// What each contender ships to the browser for its own machinery (service
// worker, client bundles, rewriter, transport and their wasm), raw and as
// brotli at quality 11, from the files its adapter lists.
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';

export function measureSize(files) {
	const out = [];
	for (const entry of files) {
		let raw;
		try {
			raw = readFileSync(entry.file);
		} catch {
			continue;
		}
		const br = brotliCompressSync(raw, {
			params: {
				[constants.BROTLI_PARAM_QUALITY]: 11,
				[constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
			},
		}).length;
		out.push({
			url: entry.url,
			role: entry.role || 'other',
			raw: raw.length,
			br,
		});
	}
	return {
		files: out,
		raw_total: out.reduce((sum, f) => sum + f.raw, 0),
		br_total: out.reduce((sum, f) => sum + f.br, 0),
	};
}
