#!/usr/bin/env node
// The protected demo site's canaries (scripts/build-demo-site.mjs): every
// string that names what the site is, which no file it serves may carry, in
// the shape estrogen's --canary reads ({"canaries":[{value,reason}]}).
//
// Derived from the source each build, so a new global or header is a canary
// the day it lands: the names below, then every `__stomp*` global,
// `$stomp$*` message, `x-stomp-*` header and `stomp*` store or key that src/,
// demo/ and the transports name.
//
// Usage: node scripts/demo-canaries.mjs [<out.json>] (stdout without one)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** the names themselves, each as it is written somewhere in the source */
const NAMES = [
	['STomp', 'product name'],
	['Stomp', 'product name'],
	['stomp', 'product name, routes and stores'],
	['STOMP', 'product name, config global and environment'],
	['powerMouse', 'project name'],
	['powermouse', 'project and package name'],
	['PowerMouse', 'project name'],
	['POWERMOUSE', 'project name'],
	['holywisp', 'the relay host'],
	['fracit.al', 'the deployment domain'],
	['fracital', 'the organisation'],
	['Fracital', 'the organisation'],
	['wisp', 'the relay protocol and its route'],
	['Wisp', 'the relay protocol'],
	['WISP', 'the relay protocol'],
	['epoxy', 'the transport'],
	['Epoxy', 'the transport'],
	['libcurl', 'the transport'],
	['mercuryworkshop', 'the transports and bare-mux package scope'],
	['MercuryWorkshop', 'the transports and bare-mux package scope'],
	['bare-mux', 'transport multiplexer'],
	['BareMux', 'transport multiplexer'],
	['BareClient', 'transport multiplexer client'],
	['bare-server', 'bare protocol'],
	['scramjet', 'the proxy STomp is held against'],
	['Scramjet', 'the proxy STomp is held against'],
	['ultraviolet', 'a proxy name'],
	['Ultraviolet', 'a proxy name'],
	['wss://holywisp.fracit.al/', 'the relay URL'],
	['tor-js', 'Tor client package'],
	['tor_js', 'Tor client wasm'],
];

/** patterns a name in the source matches, and why it is a canary */
const PATTERNS = [
	[/__stomp[A-Za-z0-9_$]*/g, 'STomp global'],
	[/\$stomp\$[A-Za-z0-9_]*/g, 'STomp message or marker'],
	[/x-stomp-[a-z0-9-]+/g, 'STomp header'],
	[/\bstomp[A-Z][A-Za-z0-9]*/g, 'STomp store or key'],
	[/\bSTOMP_[A-Z0-9_]+/g, 'STomp config or environment name'],
	[/__pm[A-Z][A-Za-z0-9_]*/g, 'powerMouse global'],
];
const SOURCES = ['src', 'demo/public', 'demo/server.js', 'demo/offline'];

function* files(path) {
	const stat = statSync(path);
	if (stat.isFile()) {
		if (/\.(ts|mjs|js|html|css)$/.test(path)) yield path;
		return;
	}
	for (const name of readdirSync(path))
		if (name !== 'node_modules') yield* files(join(path, name));
}

const found = new Map(NAMES);
for (const source of SOURCES)
	for (const file of files(join(root, source))) {
		const text = readFileSync(file, 'utf8');
		for (const [pattern, reason] of PATTERNS)
			for (const [name] of text.matchAll(pattern))
				if (!found.has(name)) found.set(name, reason);
	}

const canaries = [...found].map(([value, reason]) => ({ value, reason }));
const json = `${JSON.stringify({ canaries }, null, '\t')}\n`;
const out = process.argv[2];
if (out) writeFileSync(out, json);
else process.stdout.write(json);
