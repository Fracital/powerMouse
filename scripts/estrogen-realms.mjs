// Compatibility with the pinned @sysce/estrogen 0.5.9 VM runtime. Its
// Function.toString registration walks descendant windows and installs
// document methods made in the host realm. Chrome then gives parser nodes
// the host's prototypes: Svelte hydration bypasses the proxy's DOM hooks.
// The host marks frames whose own runtime handles native APIs. Leave that
// subtree alone; keep the VM, its native appearance and all other realms.
// Replace this adapter with an upstream realm opt-out when available.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function* files(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* files(path);
		else if (/\.m?js$/.test(entry.name)) yield path;
	}
}

export function keepNativeRealms(site) {
	let changed = 0;
	for (const path of files(site)) {
		const source = readFileSync(path, 'utf8');
		// The VM's cross-realm registrar protocol, and its minified window
		// walker. Names change between chunks; the structure does not.
		if (!source.includes('q7Xv0k2Lm9')) continue;
		const walker =
			/function ([$\w]+)\(([$\w]+)\)\{if\(!\2\)return;try\{[$\w]+\(\2\)\}catch\([$\w]+\)\{\}let /g;
		const matches = [...source.matchAll(walker)];
		// Do not silently ship the known-broken combination if the VM
		// runtime changes. The normal canary/coverage gate still runs.
		if (matches.length !== 1)
			throw new Error(`Unrecognized estrogen realm walker in ${path}`);
		const match = matches[0];
		const win = match[2];
		const at = match.index + `function ${match[1]}(${win}){`.length;
		const guard = `try{if(${win}!==globalThis&&${win}.frameElement?.hasAttribute("data-native-realm"))return}catch{}`;
		writeFileSync(path, source.slice(0, at) + guard + source.slice(at));
		changed++;
	}
	if (!changed) throw new Error('Missing estrogen VM realm walker');
	console.log(`build-demo-site: native realm boundary in ${changed} VM chunks`);
}
