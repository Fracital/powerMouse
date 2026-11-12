// The rewrite corpus: real-world JavaScript, pinned by exact version and by
// the sha256 of each file, for the rewrite throughput scenarios (offline,
// bench/lib/rewrite-offline.mjs, and in the browser, bench/fixtures/rewrite/).
// Framework runtimes, app-like bundles, ES modules and one stress case
// (typescript.js, 8.9 MB), 14.9 MB in all. Each file is fetched from
// jsDelivr's npm mirror once and kept in a cache directory.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @typedef {object} CorpusEntry
 * @property {string} id the script's name in results and URLs
 * @property {string} pkg the npm package
 * @property {string} version its exact version
 * @property {string} path the file in the package
 * @property {number} bytes the file's length
 * @property {string} sha256 the file's digest
 * @property {boolean} module whether it is an ES module (else a classic script)
 * @property {string} kind what sort of code it is
 */

/** @type {CorpusEntry[]} */
export const CORPUS = [
	{
		id: 'react-dom',
		pkg: 'react-dom',
		version: '18.3.1',
		path: 'umd/react-dom.production.min.js',
		bytes: 131835,
		sha256: '35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d',
		module: false,
		kind: 'framework runtime, minified UMD',
	},
	{
		id: 'vue',
		pkg: 'vue',
		version: '3.5.12',
		path: 'dist/vue.global.prod.js',
		bytes: 159082,
		sha256: '89bc6871c5ebe1f55e65deca4de0c81b37ffea58720f601a9617794c4e9e1e36',
		module: false,
		kind: 'framework runtime, minified IIFE',
	},
	{
		id: 'jquery',
		pkg: 'jquery',
		version: '3.7.1',
		path: 'dist/jquery.js',
		bytes: 285314,
		sha256: '78a85aca2f0b110c29e0d2b137e09f0a1fb7a8e554b499f740d6744dc8962cfe',
		module: false,
		kind: 'library, unminified UMD',
	},
	{
		id: 'd3',
		pkg: 'd3',
		version: '7.9.0',
		path: 'dist/d3.min.js',
		bytes: 279706,
		sha256: 'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539',
		module: false,
		kind: 'library, minified UMD',
	},
	{
		id: 'lodash',
		pkg: 'lodash',
		version: '4.17.21',
		path: 'lodash.js',
		bytes: 544098,
		sha256: '4c04561befdf653aef017a42ac5addf68ea943cdfca6bdee5ce04e04e8139f54',
		module: false,
		kind: 'library, unminified UMD, ES5',
	},
	{
		id: 'echarts',
		pkg: 'echarts',
		version: '5.5.1',
		path: 'dist/echarts.min.js',
		bytes: 1030855,
		sha256: 'e84270bd0cd5bdf60fefc26d00c2a391cb2e81f4d26a7a9ee16185a54773a3cf',
		module: false,
		kind: 'app-like bundle, minified UMD',
	},
	{
		id: 'typescript',
		pkg: 'typescript',
		version: '5.6.3',
		path: 'lib/typescript.js',
		bytes: 8927529,
		sha256: 'f316520790d4db220a10d890c5f85310e26a1bd3c104b8d3b5eb62ba0491651b',
		module: false,
		kind: 'stress case: compiler, unminified, one 8.9 MB script',
	},
	{
		id: 'three',
		pkg: 'three',
		version: '0.170.0',
		path: 'build/three.module.js',
		bytes: 1314681,
		sha256: 'ce1fa418de16a19495a9f72495580e3015d7745c296d3ce0485897f902ddedfb',
		module: true,
		kind: 'ES module, unminified, self-contained',
	},
	{
		id: 'pdfjs',
		pkg: 'pdfjs-dist',
		version: '4.8.69',
		path: 'build/pdf.mjs',
		bytes: 628531,
		sha256: 'f772d1fe04307d5cae6630e1321349e146834060b5368e2416faa2a62b2b7af0',
		module: true,
		kind: 'ES module, webpack output, self-contained',
	},
	{
		id: 'angular-core',
		pkg: '@angular/core',
		version: '18.2.13',
		path: 'fesm2022/core.mjs',
		bytes: 1617165,
		sha256: '66cb2b13c4f52b116fed07b7e46636eb4546621488fa53653fe0ccc29560b7b3',
		module: true,
		kind: 'ES module, framework runtime (imports rxjs by bare specifier: in a page it fails to link after it was fetched and parsed)',
	},
];

/** where jsDelivr serves an entry */
export const corpusURL = (entry) =>
	`https://cdn.jsdelivr.net/npm/${entry.pkg}@${entry.version}/${entry.path}`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** the file's bytes when it is there and is the pinned file, else null */
async function cached(file, entry) {
	try {
		const bytes = await readFile(file);
		return sha256(bytes) === entry.sha256 ? bytes : null;
	} catch {
		return null;
	}
}

async function download(entry, file) {
	const url = corpusURL(entry);
	let lastError;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(120_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const bytes = Buffer.from(await response.arrayBuffer());
			const digest = sha256(bytes);
			if (digest !== entry.sha256)
				throw new Error(
					`sha256 ${digest}, pinned ${entry.sha256} (${bytes.length} bytes)`,
				);
			const partial = `${file}.${process.pid}.part`;
			await writeFile(partial, bytes);
			await rename(partial, file);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`corpus ${entry.id}: ${url}: ${lastError?.message}`);
}

/**
 * Every corpus file in `cacheDir` as `<id>.js` (downloaded when missing or
 * not the pinned bytes, and checked against its sha256).
 *
 * @param {string} cacheDir
 * @returns {Promise<{ id: string, url: string, file: string, bytes: number, module: boolean, pkg: string, version: string, sha256: string }[]>}
 */
export async function ensureScripts(cacheDir) {
	await mkdir(cacheDir, { recursive: true });
	const list = [];
	for (const entry of CORPUS) {
		const file = join(cacheDir, `${entry.id}.js`);
		if ((await cached(file, entry)) === null) {
			await rm(file, { force: true });
			await download(entry, file);
		}
		list.push({
			id: entry.id,
			url: corpusURL(entry),
			file,
			bytes: entry.bytes,
			module: entry.module,
			pkg: entry.pkg,
			version: entry.version,
			sha256: entry.sha256,
		});
	}
	return list;
}

/** what the in-browser fixture reads (`rewrite/scripts.json`) */
export const manifest = (scripts) =>
	scripts.map(({ id, bytes, module }) => ({ id, bytes, module }));
