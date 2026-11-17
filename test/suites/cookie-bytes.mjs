// A cookie a script writes with text a byte cannot hold (`Zürich☃`) no
// longer fails the site's requests. The jar's Cookie header carried the
// text as it was, Headers refused it, and every request of the site that
// carried the cookie failed: the tab showed the error page ("String
// contains non ISO-8859-1 code point") the next time the page loaded, as
// CNN's did a few minutes in. The header carries the text's UTF-8 bytes now,
// as the browser sends it, and the server gets those bytes as natively: the
// transport worker hands them to the transport as the text it sends as
// UTF-8 (each byte past 0x7f arrived as two before).
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const ROUTE = /\/stomp\/[\w-]+\/html\//;
const VALUE = 'Zürich☃';

/** the bytes of the Cookie header the fixture got, as hex, after the write */
const writeAndEcho = (frame) =>
	frame.evaluate(async (value) => {
		document.cookie = `bytes=${value}; path=/`;
		const response = await fetch('/echo-headers?cookie-bytes');
		const text = await response.text();
		let cookie;
		try {
			cookie = JSON.parse(text).cookie ?? null;
		} catch {
			return { status: response.status, error: text.slice(0, 200) };
		}
		const pair = (cookie ?? '')
			.split('; ')
			.find((part) => part.startsWith('bytes='));
		return {
			status: response.status,
			// the fixture reads each header byte as one character
			hex: pair
				? [...pair]
						.map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
						.join('')
				: null,
			read: document.cookie,
		};
	}, VALUE);

const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(`${FIXTURE}landed?cookie-bytes`);
const native = await writeAndEcho(nativePage.mainFrame());
await nativePage.reload();
const nativeReload = await nativePage.title();
await nativePage.close();

const tab = await openDemo(browser);
await submitLanding(tab, `${FIXTURE}landed?cookie-bytes`);
const site = () =>
	tab
		.frames()
		.find((f) => f.parentFrame() === tab.mainFrame() && ROUTE.test(f.url()));
for (let i = 0; i < 120 && !site(); i++) await sleep(250);
await site().waitForFunction(() => document.title === 'LANDED', null, {
	timeout: 30000,
});
const proxied = await writeAndEcho(site());
await site().evaluate(() => location.reload());
let reloaded = null;
for (let i = 0; i < 80 && reloaded === null; i++) {
	await sleep(250);
	try {
		const title = await site()?.evaluate(() =>
			document.readyState === 'complete' ? document.title : null,
		);
		if (title) reloaded = title;
	} catch {
		// navigating
	}
}

ok(
	'natively the cookie goes as its UTF-8 bytes',
	native.hex === Buffer.from(`bytes=${VALUE}`, 'utf8').toString('hex') &&
		nativeReload === 'LANDED',
	JSON.stringify({ native, nativeReload }),
);
ok(
	'a request with the cookie answers',
	proxied.status === 200 && !proxied.error,
	JSON.stringify(proxied),
);
ok(
	'the server gets the cookie as natively',
	typeof proxied.hex === 'string' && proxied.hex === native.hex,
	`proxied ${proxied.hex} native ${native.hex}`,
);
ok(
	'the page reads the cookie back as it wrote it',
	proxied.read?.includes(`bytes=${VALUE}`),
	proxied.read ?? '',
);
ok(
	'the page loads again with the cookie',
	reloaded === 'LANDED',
	`title ${reloaded}`,
);

await done(browser);
