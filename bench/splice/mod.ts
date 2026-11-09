// modifyJS alone over the corpus in one mode (SPLICE=1 for the splice output), best of ITER per script, and the peak heap
import { readFileSync } from 'node:fs';
import { parseConfig } from '/tmp/stomp-splice-wt/src/config';
import { modifyJS, setSpliceOutput } from '/tmp/stomp-splice-wt/src/rewriteJS';
import StompURL from '/tmp/stomp-splice-wt/src/StompURL';
const config = { codec: 'xor', directory: '/stomp/bench0/', scope: '/stomp/' } as any;
const { codec } = parseConfig(config, 'benchkey');
setSpliceOutput(process.env.SPLICE === '1');
const ITER = Number(process.env.ITER || 3);
let total = 0, peak = 0;
for (const index of process.argv.slice(2))
	for (const entry of JSON.parse(readFileSync(index, 'utf8'))) {
		if (process.env.ONLY && !entry.file.includes(process.env.ONLY)) continue;
		const script = readFileSync(entry.file, 'utf8');
		const url = new StompURL(new URL(entry.url), codec, config.directory);
		const type = /^\s*(import|export)\b/m.test(script.slice(0, 20000)) ? 'genericModule' : 'generic';
		let best = Infinity;
		for (let i = 0; i < ITER; i++) {
			const s = performance.now();
			modifyJS(script, url, config, type);
			best = Math.min(best, performance.now() - s);
			peak = Math.max(peak, process.memoryUsage().heapUsed);
		}
		total += best;
	}
console.log((process.env.SPLICE === '1' ? 'splice' : 'escodegen') + ' best-of-' + ITER + ' ms', Math.round(total), 'peak heap MB', Math.round(peak / 1048576));
