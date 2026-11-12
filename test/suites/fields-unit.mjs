// The request fields a transport is handed (serveTransport's fitHeaders),
// checked in node: epoxy keeps Chrome's Priority (to HTTP/2) and its
// Accept-Encoding, a transport that says nothing gets neither, and the
// HTTP/3 wrapper keeps Priority when its base does. The wrapper declared
// nothing, so a host that turned HTTP/3 on (the live demo) sent no
// Priority on any request, where Chrome sends one on every request but a
// script's (browserleaks' IP page showed it missing). Skips when esbuild
// is not installed, as rewriter-unit does.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP fields-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}fields-unit-entry.mjs`;
writeFileSync(
	entry,
	`export { fitHeaders } from ${JSON.stringify(`${root}src/transport/serveTransport.ts`)};
export { default as Http3Transport, h3RequestHeaders } from ${JSON.stringify(`${root}src/transport/http3/Http3Transport.ts`)};
`,
);
const bundle = `${OUT}fields-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const { fitHeaders, Http3Transport, h3RequestHeaders } = await import(
	`${bundle}?${Date.now()}`
);

const fields = [
	['user-agent', 'UA'],
	['accept', '*/*'],
	['accept-encoding', 'gzip, deflate, br, zstd'],
	['priority', 'u=1, i'],
];
const names = (headers) => headers.map(([name]) => name).join(' ');
const epoxy = {
	ready: true,
	fieldSupport: { acceptEncoding: 'gzip, deflate, br, zstd', priority: true },
};
const plain = { ready: true };

ok(
	'epoxy keeps Priority and Accept-Encoding',
	names(fitHeaders(epoxy, fields)) ===
		'user-agent accept accept-encoding priority',
	names(fitHeaders(epoxy, fields)),
);
ok(
	'a transport that declares nothing gets neither',
	names(fitHeaders(plain, fields)) === 'user-agent accept',
	names(fitHeaders(plain, fields)),
);
ok(
	'the HTTP/3 wrapper over epoxy keeps Priority',
	names(fitHeaders(new Http3Transport(epoxy), fields)) ===
		'user-agent accept priority',
	names(fitHeaders(new Http3Transport(epoxy), fields)),
);
ok(
	'the HTTP/3 wrapper over a transport without it sends none',
	names(fitHeaders(new Http3Transport(plain), fields)) === 'user-agent accept',
	names(fitHeaders(new Http3Transport(plain), fields)),
);

// A body-bearing request goes up over HTTP/3 with the Content-Length
// stomp-h3 measured: without it a server that needs a length refuses the
// body (IIS answers 411 Length Required, as every Bing API POST did).
// hyper adds it for HTTP/1 and HTTP/2 on its own; stomp-h3 does not, so the
// wrapper's header list must carry it.
const clOf = (headers) =>
	headers.find(([name]) => name === 'content-length')?.[1] ?? null;
const body = new TextEncoder().encode('a=1&b=2'); // 7 bytes
ok(
	'a measured POST body over h3 carries its Content-Length',
	clOf(
		h3RequestHeaders('POST', [['content-type', 'text/plain']], null, body),
	) === '7',
	JSON.stringify(h3RequestHeaders('POST', [], null, body)),
);
ok(
	'an empty-string POST body over h3 says Content-Length 0',
	clOf(h3RequestHeaders('POST', [], null, new Uint8Array(0))) === '0',
	JSON.stringify(h3RequestHeaders('POST', [], null, new Uint8Array(0))),
);
ok(
	'a bodyless POST over h3 still says Content-Length 0, as before',
	clOf(h3RequestHeaders('POST', [], null, null)) === '0',
	JSON.stringify(h3RequestHeaders('POST', [], null, null)),
);
ok(
	'a GET over h3 carries no Content-Length',
	clOf(h3RequestHeaders('GET', [], null, null)) === null,
	JSON.stringify(h3RequestHeaders('GET', [], null, null)),
);
ok(
	'a stream body of unknown length goes up without one, as natively',
	clOf(h3RequestHeaders('POST', [], null, new ReadableStream())) === null,
	JSON.stringify(h3RequestHeaders('POST', [], null, new ReadableStream())),
);
ok(
	"the caller's own Content-Length is kept, never doubled",
	(() => {
		const out = h3RequestHeaders(
			'POST',
			[['content-length', '99']],
			null,
			body,
		);
		return (
			out.filter(([name]) => name === 'content-length').length === 1 &&
			clOf(out) === '99'
		);
	})(),
	JSON.stringify(
		h3RequestHeaders('POST', [['content-length', '99']], null, body),
	),
);

await done();
