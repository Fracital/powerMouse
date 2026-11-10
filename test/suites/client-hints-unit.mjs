// The client-hint pieces of the worker, checked in node against what
// Chrome 152 sent natively (test/suites/client-hints.mjs measures the same
// in the browser): the field order of a navigation and of a subresource
// that carry every hint a site can ask for (Blink's header map iterates in
// hash order, blinkHeaderMap.ts), and the parsers of Accept-CH, Critical-CH,
// Permissions-Policy, the allow attribute and delegate-ch. Skips when
// esbuild is not installed, as rewriter-unit does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP client-hints-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}client-hints-unit-entry.mjs`;
writeFileSync(
	entry,
	`export { chromeOrderedHeaders } from ${JSON.stringify(`${root}src/server/headerOrder.ts`)};
export { blinkHeaderMapOrder } from ${JSON.stringify(`${root}src/server/blinkHeaderMap.ts`)};
export { parseAcceptCH } from ${JSON.stringify(`${root}src/server/hintNames.ts`)};
export {
	allowlistMatches,
	criticalRetry,
	metaHints,
	parseAllowAttribute,
	parsePermissionsPolicy,
	policyAllows,
} from ${JSON.stringify(`${root}src/server/clientHints.ts`)};
`,
);
const bundle = `${OUT}client-hints-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const {
	chromeOrderedHeaders,
	blinkHeaderMapOrder,
	parseAcceptCH,
	allowlistMatches,
	criticalRetry,
	metaHints,
	parseAllowAttribute,
	parsePermissionsPolicy,
	policyAllows,
} = await import(`${bundle}?${Date.now()}`);

// Chrome 152 over HTTP/1.1, every hint a site can ask for accepted (the
// fixture's recorder, Host and Connection left out)
const NATIVE_SUBRESOURCE =
	'sec-ch-ua-full-version-list sec-ch-ua-platform viewport-width device-memory sec-ch-ua sec-ch-dpr sec-ch-ua-model sec-ch-ua-mobile sec-ch-ua-form-factors sec-ch-ua-bitness sec-ch-ua-wow64 sec-ch-ua-arch sec-ch-prefers-reduced-transparency sec-ch-ua-full-version sec-ch-viewport-width downlink sec-ch-viewport-height ect sec-ch-device-memory sec-ch-prefers-reduced-motion dpr sec-ch-prefers-color-scheme user-agent rtt sec-ch-ua-platform-version accept sec-fetch-site sec-fetch-mode sec-fetch-dest referer accept-encoding accept-language';
const NATIVE_NAVIGATION =
	'device-memory sec-ch-device-memory dpr sec-ch-dpr viewport-width sec-ch-viewport-width sec-ch-viewport-height rtt downlink ect sec-ch-ua sec-ch-ua-mobile sec-ch-ua-full-version sec-ch-ua-arch sec-ch-ua-platform sec-ch-ua-platform-version sec-ch-ua-model sec-ch-ua-bitness sec-ch-ua-wow64 sec-ch-ua-full-version-list sec-ch-ua-form-factors sec-ch-prefers-color-scheme sec-ch-prefers-reduced-motion sec-ch-prefers-reduced-transparency upgrade-insecure-requests user-agent accept sec-fetch-site sec-fetch-mode sec-fetch-user sec-fetch-dest accept-encoding accept-language';
// the same request with the three default hints only
const NATIVE_DEFAULTS =
	'sec-ch-ua-platform user-agent sec-ch-ua sec-ch-ua-mobile accept sec-fetch-site sec-fetch-mode sec-fetch-dest referer accept-encoding accept-language';

const order = (native, shape) => {
	// the fields in another order than Chrome's, so only the code orders them
	const headers = new Headers();
	for (const name of [...native.split(' ')].sort()) headers.set(name, 'x');
	return chromeOrderedHeaders(headers, shape)
		.map(([name]) => name.toLowerCase())
		.filter((name) => name !== 'priority')
		.join(' ');
};
const image = {
	navigation: false,
	destination: 'image',
	mode: 'no-cors',
	method: 'GET',
};
for (const [name, native, shape] of [
	['a subresource with every hint', NATIVE_SUBRESOURCE, image],
	['a subresource with the defaults', NATIVE_DEFAULTS, image],
	[
		'a navigation with every hint',
		NATIVE_NAVIGATION,
		{
			navigation: true,
			destination: 'document',
			mode: 'navigate',
			method: 'GET',
		},
	],
]) {
	const got = order(native, shape);
	ok(
		`${name} goes out in Chrome's order`,
		got === native,
		`\n  got    ${got}\n  native ${native}`,
	);
}
ok(
	'Origin of a module script leads the map, Content-Type sits after sec-ch-ua',
	blinkHeaderMapOrder([
		'origin',
		'content-type',
		'sec-ch-ua',
		'sec-ch-ua-mobile',
		'sec-ch-ua-platform',
		'user-agent',
	]).join(' ') ===
		'origin sec-ch-ua-platform user-agent sec-ch-ua content-type sec-ch-ua-mobile',
	blinkHeaderMapOrder([
		'origin',
		'content-type',
		'sec-ch-ua',
		'sec-ch-ua-mobile',
		'sec-ch-ua-platform',
		'user-agent',
	]).join(' '),
);
// a hint's name keeps Chrome's lowercase spelling over HTTP/1.1
const spelled = chromeOrderedHeaders(
	new Headers({ dpr: '1', 'viewport-width': '800', 'user-agent': 'x' }),
	image,
).map(([name]) => name);
ok(
	'legacy hints keep their lowercase names',
	spelled.includes('dpr') && spelled.includes('viewport-width'),
	spelled.join(' '),
);

ok(
	'Accept-CH: known tokens, case-insensitive, unknown ones dropped',
	JSON.stringify(parseAcceptCH('Sec-CH-UA-Arch, dpr, foo, sec-ch-ua-arch')) ===
		'["sec-ch-ua-arch","dpr"]',
);
ok('Accept-CH: blank clears', JSON.stringify(parseAcceptCH(' ')) === '[]');
ok(
	'Accept-CH: a value that is no token list is ignored',
	parseAcceptCH('"sec-ch-ua-arch"') === null,
);
ok(
	'Critical-CH: a retry only for an accepted hint the request lacked',
	criticalRetry('sec-ch-ua-arch', new Set(['sec-ch-ua-arch']), new Set()) &&
		!criticalRetry(
			'sec-ch-ua-arch',
			new Set(['sec-ch-ua-arch']),
			new Set(['sec-ch-ua-arch']),
		) &&
		!criticalRetry('sec-ch-ua-arch', new Set(['dpr']), new Set()),
);

const policy = parsePermissionsPolicy(
	'ch-ua-arch=*, ch-dpr=(self "https://cdn.example"), ch-viewport-width=(), geolocation=self',
);
const doc = {
	self: 'https://a.example',
	disabled: new Set(),
	declared: policy,
};
ok(
	'Permissions-Policy: * delegates to any origin',
	policyAllows(doc, 'ch-ua-arch', 'https://b.example'),
);
ok(
	'Permissions-Policy: a named origin and self',
	policyAllows(doc, 'ch-dpr', 'https://cdn.example') &&
		policyAllows(doc, 'ch-dpr', 'https://a.example') &&
		!policyAllows(doc, 'ch-dpr', 'https://b.example'),
);
ok(
	'Permissions-Policy: () turns a hint off, even for self',
	!policyAllows(doc, 'ch-viewport-width', 'https://a.example'),
);
ok(
	'undeclared: self for a high-entropy hint, * for sec-ch-ua',
	policyAllows(doc, 'ch-ua-model', 'https://a.example') &&
		!policyAllows(doc, 'ch-ua-model', 'https://b.example') &&
		policyAllows(doc, 'ch-ua', 'https://b.example'),
);
const allow = parseAllowAttribute(
	"ch-ua-arch; ch-dpr 'self'; geolocation https://b.example",
	'https://frame.example',
);
ok(
	'allow attribute: a bare feature names the frame, self the parent',
	allowlistMatches(
		allow.get('ch-ua-arch'),
		'https://frame.example',
		'https://a.example',
	) &&
		allowlistMatches(
			allow.get('ch-dpr'),
			'https://a.example',
			'https://a.example',
		) &&
		!allowlistMatches(
			allow.get('ch-dpr'),
			'https://frame.example',
			'https://a.example',
		),
);
const meta = metaHints(
	`<head><meta http-equiv="Accept-CH" content="sec-ch-ua-arch, DPR"><META HTTP-EQUIV=delegate-ch CONTENT="sec-ch-dpr https://b.example https://c.example; sec-ch-ua-model https://b.example"></head>`,
);
ok(
	'metas: Accept-CH and delegate-ch read from markup',
	JSON.stringify(meta.accept) === '["sec-ch-ua-arch","dpr"]' &&
		JSON.stringify([...meta.delegate]) ===
			'[["sec-ch-dpr",["https://b.example","https://c.example"]],["sec-ch-ua-model",["https://b.example"]]]',
	JSON.stringify([meta.accept, [...meta.delegate]]),
);

await done();
