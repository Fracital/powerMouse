// The homepage Tor control routes proxied TCP to a configured Wisp relay.
// This suite substitutes the ordinary local relay as the Tor endpoint to
// verify client selection and isolation without depending on Tor's public
// network. tor-relay tests the server's real SOCKS5 handoff separately.
/* global TOR_REQUESTED, TOR_WISP, DIRECTORY, CACHE, HTTP3, WEB_TRANSPORT, wispURL */
import {
	activeFrame,
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

await waitForServer(PROXY);
const browser = await launch();
const errors = [];

async function until(page, read, want, limit = 25000) {
	const start = Date.now();
	let value;
	while (Date.now() - start < limit) {
		value = await page.evaluate(read).catch(() => null);
		if (want(value)) return value;
		await sleep(150);
	}
	return value;
}

const read = () => ({
	status: document.getElementById('logMsg')?.textContent ?? '',
	requested: TOR_REQUESTED,
	configured: TOR_WISP,
	endpoint: TOR_REQUESTED && TOR_WISP ? wispURL() : null,
	directory: DIRECTORY,
	cache: CACHE,
	http3: HTTP3,
	webTransport: WEB_TRANSPORT,
	checked: document.getElementById('tor')?.checked,
	disabled: document.getElementById('tor')?.disabled,
	stored: localStorage.getItem('stomp-demo:tor'),
});

// A relay is configured by the server, not by user-controlled query params.
// The fixture runs the same Wisp protocol at /wisp/, and the runtime sees it
// as an explicit configured relay. This proves no endpoint substitution or
// silent direct fallback in the browser; it does not make this fixture Tor.
async function configured(page) {
	await page.route('**/config.js', async (route) => {
		const response = await route.fetch();
		const source = await response.text();
		await route.fulfill({
			response,
			body: `${source}\nglobalThis.STOMP_CONFIG.torWisp = '/wisp/';\n`,
		});
	});
}

for (const [name, origin] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await configured(page);
	await page.goto(origin);
	let state = await until(page, read, (value) => /^Ready/.test(value?.status));
	ok(
		`${name}: Tor starts off and the ordinary controller keeps its route`,
		state.requested === false &&
			state.directory === '/stomp/' &&
			state.checked === false &&
			state.disabled === false &&
			state.cache === true,
		JSON.stringify(state),
	);
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		page.click('#tor'),
	]);
	state = await until(page, read, (value) => /^Ready/.test(value?.status));
	ok(
		`${name}: Tor takes a separate worker scope and a TCP-only relay`,
		state.requested === true &&
			state.checked === true &&
			state.stored === '1' &&
			state.directory === '/stomp-tor/' &&
			state.endpoint === state.configured &&
			state.endpoint.includes('/wisp/') &&
			state.cache === false &&
			state.http3 === false &&
			state.webTransport === false,
		JSON.stringify(state),
	);
	await submitLanding(page, `${FIXTURE}pages/bookmark-a.html`);
	const shown = await until(
		page,
		() =>
			[...document.querySelectorAll('#frames iframe')].some(
				(iframe) => !iframe.classList.contains('hidden'),
			),
		Boolean,
	);
	const frame = shown && (await activeFrame(page));
	const title = frame
		? await until(
				frame,
				() => document.title,
				(name) => name === 'Bookmark A',
			)
		: null;
	ok(
		`${name}: proxied page contents load over the selected relay`,
		title === 'Bookmark A',
		title,
	);
	await page.click('#home');
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		page.click('#tor'),
	]);
	state = await until(page, read, (value) => /^Ready/.test(value?.status));
	ok(
		`${name}: turning Tor off returns to the ordinary scope`,
		state.requested === false &&
			state.checked === false &&
			state.directory === '/stomp/' &&
			state.stored === '0' &&
			state.cache === true,
		JSON.stringify(state),
	);
	await context.close();
}

// The saved Tor choice remains selected on an unavailable deployment. It is
// not reinterpreted as direct Wisp, and the user can always turn it off.
{
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.route('**/config.js', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/javascript',
			body: 'globalThis.STOMP_CONFIG = {};',
		}),
	);
	await page.goto(`${PROXY}?tor=1&wt=1&http3=1`);
	let state = await until(page, read, (value) =>
		/Tor relay unavailable/.test(value?.status),
	);
	ok(
		'a missing relay refuses Tor without falling back to direct browsing',
		state.requested === true &&
			state.configured === null &&
			state.checked === true &&
			state.disabled === false &&
			state.directory === '/stomp-tor/' &&
			state.http3 === false &&
			state.webTransport === false,
		JSON.stringify(state),
	);
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		page.click('#tor'),
	]);
	state = await until(page, read, (value) => /^Ready/.test(value?.status));
	ok(
		'the unavailable Tor toggle can be turned off to restore browsing',
		state.requested === false &&
			state.checked === false &&
			state.disabled === true &&
			state.directory === '/stomp/',
		JSON.stringify(state),
	);
	await context.close();
}

await browser.close();
ok('no page errors', errors.length === 0, JSON.stringify(errors));
done();
