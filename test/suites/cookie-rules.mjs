// The cookie jar follows RFC 6265bis the way a browser does: host-only
// cookies, label-boundary Domain matching with public suffixes refused,
// RFC 6265 5.1.4 path matching, Secure cookies for secure URLs only (and left
// alone by insecure origins), the __Host- and __Secure- prefixes, the
// 4096-byte cap, control characters refused, SameSite evaluated against the
// request's site, Max-Age over Expires, and the Cookie header ordered by path
// length then creation time.
//
// The matching matrix runs through controller.cookies (the jar itself, so
// any host or scheme works without a server for it); the SameSite rules,
// which need a request context the host API has no parameter for, run in
// node against the pure functions of src/server/Cookies.ts bundled with
// esbuild; and the fixture pages exercise the whole path: Set-Cookie
// sidecars, document.cookie and the Cookie header the proxy sends.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPublicSuffix } from 'tldts';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	OUT,
	sleep,
	submitLanding,
} from '../lib.mjs';

// ---------------------------------------------------------------- node part

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP cookie-rules unit checks: esbuild is not installed');
}

if (esbuild) await unit();

async function unit() {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	mkdirSync(OUT, { recursive: true });
	const entry = `${OUT}cookie-rules-entry.mjs`;
	writeFileSync(
		entry,
		`export { parseCookie, cookieMatches, defaultPath, pathMatches, domainMatches, isSecureURL, compareCookies } from ${JSON.stringify(`${root}src/server/Cookies.ts`)};\n`,
	);
	const bundle = `${OUT}cookie-rules.mjs`;
	let rules;
	try {
		await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			platform: 'node',
			format: 'esm',
			outfile: bundle,
			logLevel: 'silent',
		});
		rules = await import(`${bundle}?${Date.now()}`);
	} catch (error) {
		ok('the jar exports its matching rules', false, error.message);
		return;
	}
	const {
		parseCookie,
		cookieMatches,
		defaultPath,
		pathMatches,
		domainMatches,
		isSecureURL,
		compareCookies,
	} = rules || {};
	const page = new URL('https://www.example.com/dir/page');
	const publicSuffix = (host) =>
		getPublicSuffix(host, { allowPrivateDomains: true });
	const parse = (header, url = page, source = 'http') =>
		parseCookie(header, url, publicSuffix, { source });

	ok(
		'defaultPath follows RFC 6265 5.1.4',
		defaultPath('/dir/page') === '/dir' &&
			defaultPath('/dir/sub/') === '/dir/sub' &&
			defaultPath('/page') === '/' &&
			defaultPath('/') === '/' &&
			defaultPath('') === '/',
		JSON.stringify(
			['/dir/page', '/dir/sub/', '/page', '/', ''].map(defaultPath),
		),
	);
	ok(
		'pathMatches is boundary aware',
		pathMatches('/foo', '/foo') &&
			pathMatches('/foo/', '/foo') &&
			pathMatches('/foo/bar', '/foo') &&
			pathMatches('/foo/bar', '/foo/') &&
			!pathMatches('/foobar', '/foo') &&
			!pathMatches('/fo', '/foo') &&
			pathMatches('/anything', '/'),
	);
	ok(
		'domainMatches walks labels and never suffix-matches an IP',
		domainMatches('example.com', 'example.com') &&
			domainMatches('www.example.com', 'example.com') &&
			domainMatches('a.b.example.com', 'example.com') &&
			!domainMatches('notexample.com', 'example.com') &&
			!domainMatches('example.com', 'www.example.com') &&
			domainMatches('127.0.0.1', '127.0.0.1') &&
			!domainMatches('127.0.0.1', '0.0.1'),
	);
	ok(
		'isSecureURL: https and wss, plus loopback like Chrome',
		isSecureURL(new URL('https://a.example/')) &&
			isSecureURL(new URL('wss://a.example/')) &&
			!isSecureURL(new URL('http://a.example/')) &&
			!isSecureURL(new URL('ws://a.example/')) &&
			isSecureURL(new URL('http://localhost:8080/')) &&
			isSecureURL(new URL('http://a.localhost/')) &&
			isSecureURL(new URL('http://127.0.0.1/')) &&
			isSecureURL(new URL('http://[::1]/')),
	);

	{
		const plain = parse('a=1');
		ok(
			'a cookie without Domain is host-only at the default path, Lax',
			plain &&
				plain.hostOnly === true &&
				plain.domain === 'www.example.com' &&
				plain.path === '/dir' &&
				plain.sameSite === 'lax' &&
				plain.expires === undefined,
			JSON.stringify(plain),
		);
		const dom = parse('a=1; Domain=.Example.COM');
		ok(
			'Domain is lowercased, the leading dot dropped, hostOnly false',
			dom && dom.hostOnly === false && dom.domain === 'example.com',
			JSON.stringify(dom),
		);
		ok(
			'Domain that is not a suffix of the host is refused',
			parse('a=1; Domain=other.com') === null &&
				parse('a=1; Domain=sub.www.example.com') === null &&
				parse('a=1; Domain=xample.com') === null,
		);
		ok(
			'Domain set to a public suffix is refused (ICANN and private lists)',
			parse('a=1; Domain=com') === null &&
				parse('a=1; Domain=co.uk', new URL('https://www.bbc.co.uk/')) ===
					null &&
				parse('a=1; Domain=github.io', new URL('https://user.github.io/')) ===
					null,
		);
		const psHost = parse('a=1; Domain=localhost', new URL('http://localhost/'));
		ok(
			'Domain equal to the host, even a public suffix, becomes host-only',
			psHost && psHost.hostOnly === true && psHost.domain === 'localhost',
			JSON.stringify(psHost),
		);
		ok(
			'Path without a leading slash falls back to the default path',
			parse('a=1; Path=foo')?.path === '/dir' &&
				parse('a=1; Path=/foo')?.path === '/foo',
		);
	}

	ok(
		'Secure from an insecure URL is refused; from loopback http accepted',
		parse('a=1; Secure', new URL('http://www.example.com/')) === null &&
			parse('a=1; Secure', new URL('http://127.0.0.1/'))?.secure === true &&
			parse('a=1; Secure')?.secure === true,
	);
	ok(
		'__Host- needs Secure, no Domain and Path=/',
		parse('__Host-a=1; Secure; Path=/') !== null &&
			parse('__Host-a=1; Path=/') === null &&
			parse('__Host-a=1; Secure') === null &&
			parse('__Host-a=1; Secure; Path=/; Domain=example.com') === null &&
			parse('__HOST-a=1; Path=/') === null,
	);
	ok(
		'__Secure- needs Secure',
		parse('__Secure-a=1; Secure') !== null &&
			parse('__Secure-a=1') === null &&
			parse('__secure-a=1') === null,
	);
	ok(
		'name plus value over 4096 bytes is refused',
		parse(`big=${'x'.repeat(4093)}`) !== null &&
			parse(`big=${'x'.repeat(4094)}`) === null &&
			parse(`b=${'é'.repeat(2048)}`) === null,
	);
	ok(
		'control characters are refused, a tab is not',
		parse('a=b\u0001c') === null &&
			parse('a\u0000=b') === null &&
			parse('a=b\u007fc') === null &&
			parse('a=b\tc')?.value === 'b\tc',
	);
	ok(
		'a nameless cookie keeps its value; an empty one is refused',
		parse('justvalue')?.value === 'justvalue' &&
			parse('justvalue')?.name === '' &&
			parse('=') === null &&
			parse('') === null,
	);
	ok(
		'SameSite=None requires Secure; unknown values mean Lax',
		parse('a=1; SameSite=None') === null &&
			parse('a=1; SameSite=None; Secure')?.sameSite === 'none' &&
			parse('a=1; SameSite=Strict')?.sameSite === 'strict' &&
			parse('a=1; SameSite=bogus')?.sameSite === 'lax',
	);
	ok(
		'a script cannot set an HttpOnly cookie',
		parse('a=1; HttpOnly', page, 'script') === null &&
			parse('a=1; HttpOnly', page, 'http')?.httpOnly === true &&
			parse('a=1', page, 'script') !== null,
	);
	{
		const now = Date.now();
		const past = 'Thu, 01 Jan 1970 00:00:00 GMT';
		const maxAge = parseCookie(
			`a=1; Max-Age=60; Expires=${past}`,
			page,
			publicSuffix,
			{ now },
		);
		const expires = parseCookie(
			'a=1; Expires=Fri, 01 Jan 2100 00:00:00 GMT',
			page,
			publicSuffix,
			{ now },
		);
		const gone = parseCookie(`a=1; Expires=${past}`, page, publicSuffix, {
			now,
		});
		const zero = parseCookie('a=1; Max-Age=0', page, publicSuffix, { now });
		ok(
			'Max-Age wins over Expires, past dates expire, 400-day cap',
			maxAge?.expires === now + 60000 &&
				expires?.expires === now + 400 * 86400000 &&
				gone?.expires === 0 &&
				zero?.expires !== undefined &&
				zero.expires <= now,
			JSON.stringify([maxAge?.expires, expires?.expires, gone?.expires]),
		);
	}

	{
		const strict = parse('s=1; SameSite=Strict; Path=/');
		const lax = parse('l=1; SameSite=Lax; Path=/');
		const none = parse('n=1; SameSite=None; Secure; Path=/');
		const sent = (context) =>
			[strict, lax, none]
				.filter((cookie) => cookieMatches(cookie, page, context))
				.map((cookie) => cookie.name);
		ok(
			'same-site requests (and no context) get every cookie',
			sent(undefined).join() === 's,l,n' &&
				sent({ site: 'same-origin' }).join() === 's,l,n' &&
				sent({ site: 'same-site' }).join() === 's,l,n' &&
				sent({ site: 'none' }).join() === 's,l,n',
			JSON.stringify([sent(undefined), sent({ site: 'none' })]),
		);
		ok(
			'a cross-site subresource gets only SameSite=None',
			sent({ site: 'cross-site' }).join() === 'n' &&
				sent({
					site: 'cross-site',
					navigation: false,
					method: 'GET',
				}).join() === 'n',
			JSON.stringify(sent({ site: 'cross-site' })),
		);
		ok(
			'a cross-site GET navigation adds Lax; a POST navigation does not',
			sent({ site: 'cross-site', navigation: true, method: 'GET' }).join() ===
				'l,n' &&
				sent({
					site: 'cross-site',
					navigation: true,
					method: 'POST',
				}).join() === 'n',
			JSON.stringify([
				sent({ site: 'cross-site', navigation: true, method: 'GET' }),
				sent({ site: 'cross-site', navigation: true, method: 'POST' }),
			]),
		);
		const secure = parse('x=1; Secure; Path=/');
		ok(
			'a Secure cookie matches https, not http',
			cookieMatches(secure, new URL('https://www.example.com/')) &&
				!cookieMatches(secure, new URL('http://www.example.com/')),
		);
		const hostOnly = parse('h=1; Path=/');
		const domainWide = parse('d=1; Domain=example.com; Path=/');
		ok(
			'host-only matches the host alone; a Domain cookie its subdomains',
			cookieMatches(hostOnly, new URL('https://www.example.com/')) &&
				!cookieMatches(hostOnly, new URL('https://example.com/')) &&
				!cookieMatches(hostOnly, new URL('https://a.www.example.com/')) &&
				cookieMatches(domainWide, new URL('https://example.com/')) &&
				cookieMatches(domainWide, new URL('https://a.b.example.com/')) &&
				!cookieMatches(domainWide, new URL('https://notexample.com/')),
		);
		const early = { ...parse('e=1; Path=/'), created: 1 };
		const late = { ...parse('l=1; Path=/'), created: 2 };
		const deep = { ...parse('d=1; Path=/dir/sub'), created: 3 };
		ok(
			'order: longer path first, then earlier creation',
			[late, early, deep]
				.sort(compareCookies)
				.map((cookie) => cookie.name)
				.join() === 'd,e,l',
		);
	}
}

// ------------------------------------------------------------- browser part

const browser = await launch();
const page = await openDemo(browser, HOST);
const other = FIXTURE.replace('127.0.0.1', 'localhost');

const api = (op, args) =>
	page.evaluate(
		([op, args]) => window.controller.cookies[op](...args),
		[op, args],
	);
const set = (url, header) => api('set', [url, header]);
const get = (url) => api('get', [url]);
const has = (header, name) =>
	header.split('; ').some((pair) => pair.split('=')[0] === name);
const names = (header) =>
	header
		.split('; ')
		.filter(Boolean)
		.map((pair) => pair.split('=')[0]);

await api('clear', []);

// domain rules
await set('https://www.example.com/', 'ho=1; Path=/');
await set('https://www.example.com/', 'dom=1; Domain=example.com; Path=/');
await set('https://www.example.com/', 'dot=1; Domain=.example.com; Path=/');
await set('https://www.example.com/', 'bad=1; Domain=other.com; Path=/');
await set(
	'https://www.example.com/',
	'sub=1; Domain=a.www.example.com; Path=/',
);
await set('https://www.example.com/', 'tld=1; Domain=com; Path=/');
ok(
	'host-only cookie goes to its host alone',
	has(await get('https://www.example.com/'), 'ho') &&
		!has(await get('https://example.com/'), 'ho') &&
		!has(await get('https://a.www.example.com/'), 'ho'),
	JSON.stringify([
		await get('https://www.example.com/'),
		await get('https://example.com/'),
		await get('https://a.www.example.com/'),
	]),
);
ok(
	'Domain cookie reaches the domain and its subdomains by label',
	names(await get('https://example.com/')).join() === 'dom,dot' &&
		names(await get('https://deep.a.example.com/')).join() === 'dom,dot' &&
		(await get('https://notexample.com/')) === '' &&
		(await get('https://xexample.com/')) === '',
	JSON.stringify([
		await get('https://example.com/'),
		await get('https://notexample.com/'),
	]),
);
ok(
	'Domain not a suffix of the host, or a public suffix, is refused',
	!has(await get('https://www.example.com/'), 'bad') &&
		!has(await get('https://www.example.com/'), 'sub') &&
		!has(await get('https://www.example.com/'), 'tld') &&
		(await get('https://other.com/')) === '' &&
		(await get('https://x.com/')) === '',
	JSON.stringify([
		await get('https://www.example.com/'),
		await get('https://x.com/'),
	]),
);
await set('https://user.github.io/', 'gh=1; Domain=github.io; Path=/');
ok(
	'a private-list public suffix (github.io) is refused too',
	(await get('https://user.github.io/')) === '' &&
		(await get('https://other.github.io/')) === '',
	await get('https://other.github.io/'),
);
await set('http://127.0.0.1/', 'ip=1; Domain=127.0.0.1; Path=/');
await set('http://127.0.0.1/', 'ipbad=1; Domain=0.0.1; Path=/');
ok(
	'an IP host takes Domain only when identical',
	(await get('http://127.0.0.1/')) === 'ip=1',
	await get('http://127.0.0.1/'),
);

// path rules
await set('https://p.example/dir/sub/page', 'dp=1');
await set('https://p.example/dir/sub/page', 'pp=1; Path=/foo');
await set('https://p.example/dir/sub/page', 'pr=1; Path=/');
await set('https://p.example/dir/sub/page', 'pbad=1; Path=foo');
ok(
	'default path is the request directory, matched on a boundary',
	names(await get('https://p.example/dir/sub')).join() === 'dp,pbad,pr' &&
		names(await get('https://p.example/dir/sub/x/y')).join() === 'dp,pbad,pr' &&
		names(await get('https://p.example/dir/subx')).join() === 'pr' &&
		names(await get('https://p.example/dir')).join() === 'pr' &&
		names(await get('https://p.example/')).join() === 'pr',
	JSON.stringify([
		await get('https://p.example/dir/sub'),
		await get('https://p.example/dir/subx'),
		await get('https://p.example/dir'),
	]),
);
ok(
	'Path=/foo matches /foo and /foo/bar, not /foobar',
	names(await get('https://p.example/foo')).join() === 'pp,pr' &&
		names(await get('https://p.example/foo/')).join() === 'pp,pr' &&
		names(await get('https://p.example/foo/bar')).join() === 'pp,pr' &&
		names(await get('https://p.example/foobar')).join() === 'pr' &&
		names(await get('https://p.example/fo')).join() === 'pr',
	JSON.stringify([
		await get('https://p.example/foo/bar'),
		await get('https://p.example/foobar'),
	]),
);

// secure rules
await set('https://s.example/', 'sec=1; Secure; Path=/');
await set('https://s.example/', 'plain=1; Path=/');
ok(
	'Secure cookie is sent to https only',
	names(await get('https://s.example/')).join() === 'sec,plain' &&
		names(await get('http://s.example/')).join() === 'plain',
	JSON.stringify([
		await get('https://s.example/'),
		await get('http://s.example/'),
	]),
);
await set('http://s.example/', 'sec=2; Path=/');
await set('http://s.example/', 'sec=3; Path=/deeper');
await set('http://s.example/', 'nosec=1; Secure; Path=/');
ok(
	'an insecure origin can neither overwrite nor shadow a Secure cookie',
	(await get('https://s.example/deeper/x')) === 'sec=1; plain=1' &&
		(await get('http://s.example/')) === 'plain=1',
	JSON.stringify([
		await get('https://s.example/deeper/x'),
		await get('http://s.example/'),
	]),
);
await set('http://s.example/', 'plain=2; Path=/');
ok(
	'an insecure origin still overwrites its own non-Secure cookie',
	(await get('http://s.example/')) === 'plain=2',
	await get('http://s.example/'),
);
await set('http://localhost:8080/', 'loop=1; Secure; Path=/');
ok(
	'loopback over http counts as secure (Chrome behaviour)',
	(await get('http://localhost:8080/')) === 'loop=1',
	await get('http://localhost:8080/'),
);

// prefixes
await set('https://h.example/dir/x', '__Host-ok=1; Secure; Path=/');
await set('https://h.example/dir/x', '__Host-nosec=1; Path=/');
await set('https://h.example/dir/x', '__Host-nopath=1; Secure');
await set(
	'https://h.example/dir/x',
	'__Host-dom=1; Secure; Path=/; Domain=h.example',
);
await set('https://h.example/dir/x', '__HOST-case=1; Path=/');
await set('https://h.example/dir/x', '__Secure-ok=1; Secure; Path=/');
await set('https://h.example/dir/x', '__Secure-nosec=1; Path=/');
ok(
	'__Host- and __Secure- prefixes are enforced',
	(await get('https://h.example/dir/x')) === '__Host-ok=1; __Secure-ok=1',
	await get('https://h.example/dir/x'),
);

// size and control characters
await set('https://z.example/', `big=${'x'.repeat(4093)}; Path=/`);
await set('https://z.example/', `huge=${'x'.repeat(4094)}; Path=/`);
await set('https://z.example/', 'ctl=a\u0001b; Path=/');
await set('https://z.example/', 'tab=a\tb; Path=/');
await set('https://z.example/', 'bare; Path=/');
{
	const header = await get('https://z.example/');
	ok(
		'4096 bytes fit, 4098 do not; CTLs refused, tab kept, nameless value plain',
		names(header).join() === 'big,tab,bare' &&
			header.endsWith('tab=a\tb; bare'),
		JSON.stringify(names(header)),
	);
}

// expiry
await set(
	'https://e.example/',
	'past=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
);
await set(
	'https://e.example/',
	'ma=1; Max-Age=600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
);
await set('https://e.example/', 'sess=1; Path=/');
ok(
	'a past Expires deletes; Max-Age wins over Expires',
	(await get('https://e.example/')) === 'ma=1; sess=1',
	await get('https://e.example/'),
);
await set('https://e.example/', 'ma=1; Max-Age=0; Path=/');
ok(
	'Max-Age=0 deletes, the session cookie stays',
	(await get('https://e.example/')) === 'sess=1',
	await get('https://e.example/'),
);
{
	const records = await api('list', ['https://e.example']);
	ok(
		'list() reports a session cookie with expires null',
		records.length === 1 &&
			records[0].name === 'sess' &&
			records[0].expires === null,
		JSON.stringify(records),
	);
}

// precedence
await set('https://o.example/', 'b=1; Path=/');
await set('https://o.example/', 'a=1; Path=/');
await set('https://o.example/', 'c=1; Path=/dir');
await set('https://o.example/', 'b=2; Path=/');
ok(
	'Cookie header: longer paths first, then creation order (kept on re-set)',
	(await get('https://o.example/dir/x')) === 'c=1; b=2; a=1',
	await get('https://o.example/dir/x'),
);

// clear(origin) follows the same matching
await set('https://www.example.com/', 'wwwonly=1; Path=/');
await api('clear', ['https://example.com']);
ok(
	'clear(origin) drops what that origin receives and keeps a subdomain host-only cookie',
	(await get('https://example.com/')) === '' &&
		(await get('https://www.example.com/')) === 'ho=1; wwwonly=1',
	JSON.stringify([
		await get('https://example.com/'),
		await get('https://www.example.com/'),
	]),
);
await api('clear', []);

// end to end through the fixture: Set-Cookie sidecar plus document.cookie on
// 127.0.0.1, read back as document.cookie and as the Cookie header to
// /echo-headers (path /); then localhost, a different host, sees none of it
async function visit(url, probe) {
	await page.click('#home');
	await submitLanding(page, url);
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => f.url().includes('/stomp/html/'));
		try {
			const value = await frame.evaluate(probe);
			if (value !== null && value !== undefined) return { frame, value };
		} catch (error) {
			// navigating
		}
	}
	return { frame: null, value: null };
}

const { value: cr } = await visit(`${FIXTURE}pages/cookie-rules.html`, () =>
	window.__cr?.done ? window.__cr : null,
);
const doc = names(cr?.document || '');
const sent = names(cr?.sent || '');
ok(
	'cookie-rules page ran',
	cr?.done && cr.error === undefined,
	JSON.stringify(cr?.error),
);
ok(
	'Set-Cookie sidecar: plain, prefixed-with-Secure and SameSite cookies stored',
	['hdr', 'hdrdp', '__Host-hdr', '__Secure-hdr', 'strict', 'lax', 'none'].every(
		(name) => doc.includes(name),
	),
	JSON.stringify(doc),
);
ok(
	'Set-Cookie sidecar: bad prefixes, None without Secure, foreign Domain refused',
	[
		'__Host-nosecure',
		'__Secure-nosecure',
		'nonenosecure',
		'otherdom',
		'ipsuffix',
	].every((name) => !doc.includes(name) && !sent.includes(name)),
	JSON.stringify(doc),
);
ok(
	'document.cookie: plain, default-path, 4096-byte, tab, __Host- with Secure, nameless kept',
	['js', 'jsdp', 'big', 'tab', '__Host-js', 'novalue'].every((name) =>
		doc.includes(name),
	),
	JSON.stringify(doc),
);
ok(
	'document.cookie: oversize, control character and __Host- without Secure refused',
	['huge', 'ctl', '__Host-jsbad'].every((name) => !doc.includes(name)),
	JSON.stringify(doc),
);
ok(
	'document.cookie hides HttpOnly, the Cookie header carries it',
	!doc.includes('http') && sent.includes('http'),
	JSON.stringify([doc, sent]),
);
ok(
	'default-path cookies (/pages) are not sent to /echo-headers',
	!sent.includes('hdrdp') &&
		!sent.includes('jsdp') &&
		sent.includes('hdr') &&
		sent.includes('js'),
	JSON.stringify(sent),
);

const { frame: otherFrame, value: otherDoc } = await visit(
	`${other}pages/cookie-show.html`,
	() =>
		document.title === 'COOKIES'
			? document.getElementById('c').textContent
			: null,
);
ok(
	'another host sees none of those cookies (host-only, foreign Domain refused)',
	otherDoc === '',
	JSON.stringify(otherDoc),
);
if (otherFrame) {
	// the proxy calls the jar without a request context today, so every
	// cookie goes cross-site; with the rewrites.ts hunk from the report this
	// header carries none=1 alone (and __Host-hdr, __Secure-hdr, hdr, js, ...
	// stay home). Measured, not asserted.
	const cross = await otherFrame.evaluate(async (url) => {
		try {
			return (await (await fetch(url)).json()).cookie || '';
		} catch (error) {
			return `error ${error}`;
		}
	}, `${FIXTURE}echo-headers`);
	console.log(
		`INFO cross-site fetch from localhost to 127.0.0.1 carried: ${JSON.stringify(cross)}`,
	);
}

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
