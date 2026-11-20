// Gives every relative import in the emitted declarations (dist/types) its
// file's extension, as `./config.js` or `./http3/index.js`. The sources import
// their siblings without one (moduleResolution bundler, esbuild), and so does
// tsc's declaration emit; a consumer whose moduleResolution is nodenext or
// node16 refuses such an import in a .d.ts (TS2834) and reads every type
// behind it as `any`. Run by `npm run build` after tsc;
// scripts/check-types.mjs (`npm run check:types`) checks the result.
//   node scripts/types-extensions.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = fileURLToPath(new URL('../dist/types', import.meta.url));
// `from './x'`, `export * from './x'` and `import('./x')`
const SPECIFIER = /(\bfrom\s*|\bimport\(\s*)(['"])(\.\.?\/[^'"]*)\2/g;

function declarations(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return declarations(path);
		return entry.name.endsWith('.d.ts') ? [path] : [];
	});
}

let fixed = 0;
const problems = [];
for (const file of declarations(TYPES)) {
	const text = readFileSync(file, 'utf8');
	const out = text.replace(SPECIFIER, (match, head, quote, specifier) => {
		if (/\.(m|c)?js$/.test(specifier)) return match;
		const base = join(dirname(file), specifier);
		let resolved;
		if (existsSync(`${base}.d.ts`)) resolved = `${specifier}.js`;
		else if (existsSync(join(base, 'index.d.ts')))
			resolved = `${specifier.replace(/\/$/, '')}/index.js`;
		else {
			problems.push(`${file}: no declaration for '${specifier}'`);
			return match;
		}
		fixed++;
		return `${head}${quote}${resolved}${quote}`;
	});
	if (out !== text) writeFileSync(file, out);
}
if (problems.length) {
	console.error(problems.join('\n'));
	process.exit(1);
}
console.log(`dist/types: ${fixed} relative imports given their extension`);
