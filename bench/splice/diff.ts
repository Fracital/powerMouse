// The splice output against the escodegen output, script by script: both
// parsed and compared as ASTs (positions, raw text and comments ignored).
// usage: node diff.mjs <index.json>...  (env ONLY=<substring of the file>)
import { parse } from 'meriyah';
import { readFileSync } from 'node:fs';
import { parseConfig } from '/tmp/stomp-splice-wt/src/config';
import { modifyJS, setSpliceOutput } from '/tmp/stomp-splice-wt/src/rewriteJS';
import StompURL from '/tmp/stomp-splice-wt/src/StompURL';

const config = { codec: 'xor', directory: '/stomp/bench0/', scope: '/stomp/' } as any;
const { codec } = parseConfig(config, 'benchkey');
const IGNORE = new Set(['range', 'loc', 'start', 'end', 'raw']);

let bigints = 0;
let lastA: any = null, lastB: any = null, textA = '', textB = '';
function firstDiff(a: any, b: any, path: string): string | null {
	if (a && typeof a === 'object' && a.range && b && b.range) { lastA = a; lastB = b; }
	if (a === b) return null;
	if (typeof a !== typeof b) return `${path}: ${typeof a} vs ${typeof b}`;
	if (a === null || b === null || typeof a !== 'object')
		return Number.isNaN(a) && Number.isNaN(b) ? null : `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
	if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b) ? null : `${path}: ${a} vs ${b}`;
	if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs not`;
	if (Array.isArray(a)) {
		if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
		for (let i = 0; i < a.length; i++) {
			const d = firstDiff(a[i], b[i], `${path}[${i}]`);
			if (d) return d;
		}
		return null;
	}
	// escodegen prints a BigInt literal without its n (0n as 0): the old
	// output is the wrong one there; counted, and compared no further
	if (a.type === 'Literal' && b.type === 'Literal' && typeof b.value === 'bigint' && typeof a.value === 'number' && Number(b.value) === a.value) {
		bigints++;
		return null;
	}
	const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !IGNORE.has(k)));
	for (const k of keys) {
		if (k === 'value' && a.type === 'TemplateElement') {
			if (a.value.cooked !== b.value.cooked) return `${path}.value.cooked differs`;
			continue;
		}
		const d = firstDiff(a[k], b[k], `${path}.${k}${k === 'type' ? '' : `<${a.type ?? ''}>`}`);
		if (d) return d;
	}
	return null;
}

const peak = () => Math.round(process.memoryUsage().heapUsed / 1048576);
let diffs = 0, files = 0, tOld = 0, tNew = 0;
for (const index of process.argv.slice(2))
	for (const entry of JSON.parse(readFileSync(index, 'utf8'))) {
		if (process.env.ONLY && !entry.file.includes(process.env.ONLY)) continue;
		const script = readFileSync(entry.file, 'utf8');
		const url = new StompURL(new URL(entry.url), codec, config.directory);
		const module = /^\s*(import|export)\b/m.test(script.slice(0, 20000));
		const type = module ? 'genericModule' : 'generic';
		setSpliceOutput(false);
		let s = performance.now();
		const before = modifyJS(script, url, config, type);
		tOld += performance.now() - s;
		const heapOld = peak();
		setSpliceOutput(true);
		s = performance.now();
		const after = modifyJS(script, url, config, type);
		tNew += performance.now() - s;
		const heapNew = peak();
		files++;
		const options = { module, next: true, globalReturn: true, webcompat: true, ranges: true } as any;
		textA = before; textB = after;
		let d: string | null;
		const tryParse = (text: string, side: string) => {
			try {
				return parse(text, options);
			} catch (error: any) {
				const m = /\[(\d+):(\d+)/.exec(String(error));
				let at = 0;
				if (m) {
					const lines = text.split('\n');
					for (let i = 0; i < +m[1] - 1; i++) at += lines[i].length + 1;
					at += +m[2];
				}
				throw new Error(`${side} does not parse: ${String(error).slice(0, 120)}\n      context: ${JSON.stringify(text.slice(Math.max(0, at - 150), at + 60))}`);
			}
		};
		try {
			d = firstDiff(tryParse(before, 'escodegen'), tryParse(after, 'splice'), 'Program');
		} catch (error) {
			d = String(error).slice(0, 700);
		}
		if (d && lastA && !d.includes('does not parse')) d += `\n      escodegen: ${JSON.stringify(textA.slice(lastA.range[0], Math.min(lastA.range[1], lastA.range[0] + 260)))}\n      splice:    ${JSON.stringify(textB.slice(lastB.range[0], Math.min(lastB.range[1], lastB.range[0] + 260)))}`;
		if (d) diffs++;
		console.log(d ? 'DIFF' : 'same', entry.file.split('/').slice(-2).join('/'), (script.length / 1024).toFixed(0) + 'K', 'out', (before.length / 1024).toFixed(0) + 'K ->', (after.length / 1024).toFixed(0) + 'K', 'heap', heapOld, heapNew, d ? '\n   ' + d : '');

		if (d && process.env.SHOW) {
			// the text around the first difference: the splice output's statement path is not kept, so show both outputs' starts
			console.log('   before:', JSON.stringify(before.slice(0, 300)));
			console.log('   after: ', JSON.stringify(after.slice(0, 300)));
		}
	}
console.log(`escodegen BigInt literals printed as numbers: ${bigints}`);
console.log(`files ${files} differences ${diffs} escodegen ${Math.round(tOld)} ms splice ${Math.round(tNew)} ms`);
