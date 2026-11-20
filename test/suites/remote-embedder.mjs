// Isolation mode under a host page that sends no referrer. The controller
// frame took its embedder's origin from document.referrer, so a host page
// with `Referrer-Policy: no-referrer` (or `same-origin`, the proxy being
// another origin) left it with none: it threw on `new URL('')` when its
// meta listed origins, said "it only works embedded" when it did not, and
// RemoteController.wait() never settled either way. The frame now reads the
// parent's origin from location.ancestorOrigins (or asks the page, whose
// answer's origin the browser names), and a page it refuses (an origin its
// stomp-allowed-origins does not list, or an opaque one it cannot check)
// gets an EmbedderRefusedError from wait() at once.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	waitForServer,
} from '../lib.mjs';

await waitForServer(HOST);
const browser = await launch();
const errors = [];

/** wait() of a RemoteController made with `init` in the page, raced against `bound` ms */
const SETTLE = `window.__settle = async (init, bound) => {
	const started = performance.now();
	let remote;
	try {
		remote = new StompRemoteController(init);
		window.__remote = remote;
		await Promise.race([
			remote.wait(),
			new Promise((resolve, reject) =>
				setTimeout(() => reject(new Error('no answer in ' + bound + ' ms')), bound),
			),
		]);
		return { name: 'resolved', ms: Math.round(performance.now() - started) };
	} catch (error) {
		return {
			name: error.name,
			message: error.message,
			ms: Math.round(performance.now() - started),
		};
	}
};`;

const transport = {
	module: `${PROXY}epoxy/index.mjs`,
	options: [{ wisp: `${PROXY.replace(/^http/, 'ws')}wisp/` }],
};

async function hostPage(file) {
	const page = await browser.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${FIXTURE}pages/${file}`);
	await page.addScriptTag({ url: `${HOST}stomp/Controller.js` });
	await page.addScriptTag({ content: SETTLE });
	return page;
}

/** the title the RemoteFrame reports for a fixture page, once it has one */
async function frameTitle(page, url) {
	return page.evaluate(async (url) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = window.__remote.createFrame(element);
		await frame.go(url);
		const until = Date.now() + 20000;
		while (Date.now() < until && frame.title !== 'HIST 1')
			await new Promise((resolve) => setTimeout(resolve, 100));
		return frame.title;
	}, url);
}

for (const [file, policy] of [
	['remote-host-noref.html', 'no-referrer'],
	['remote-host-sameorigin.html', 'same-origin'],
]) {
	const page = await hostPage(file);
	const result = await page.evaluate(
		([transport, proxy]) =>
			window.__settle(
				{ proxyOrigin: proxy, directory: '/stomp/', transport, codec: 'xor' },
				30000,
			),
		[transport, PROXY],
	);
	const controllerFrame = page
		.frames()
		.find((frame) => frame.url().includes('controllerFrame.html'));
	const referrer = await controllerFrame
		?.evaluate(() => document.referrer)
		.catch((error) => String(error));
	ok(
		`a host page with Referrer-Policy: ${policy} gives the controller frame no referrer`,
		referrer === '',
		JSON.stringify(referrer),
	);
	ok(
		`RemoteController.wait() resolves under a host page with Referrer-Policy: ${policy}`,
		result.name === 'resolved',
		JSON.stringify(result),
	);
	if (result.name === 'resolved') {
		const title = await frameTitle(page, `${FIXTURE}pages/hist-1.html`);
		ok(
			`a page loads through it (${policy})`,
			title === 'HIST 1',
			String(title),
		);
	}
	await page.close();
}

// a controller frame whose meta lists another origin: the page hears why
{
	const page = await hostPage('remote-host-noref.html');
	const proxy = FIXTURE.replace('127.0.0.1', 'localhost');
	const result = await page.evaluate(
		([transport, proxy]) =>
			window.__settle(
				{
					proxyOrigin: proxy,
					directory: '/pages/',
					assets: { controllerFrame: 'cf-locked.html' },
					transport,
					codec: 'xor',
				},
				20000,
			),
		[transport, proxy],
	);
	ok(
		'a page the frame does not list gets an EmbedderRefusedError that names its origin and the meta',
		result.name === 'EmbedderRefusedError' &&
			result.message.includes(new URL(FIXTURE).origin) &&
			/stomp-allowed-origins/.test(result.message) &&
			result.ms < 10000,
		JSON.stringify(result),
	);
	await page.close();
}

// a host page of an opaque origin: a sandboxed document (whose frames are
// sandboxed too) or a data: URL frame. No controller frame can check it or
// answer it, and the page hears so instead of waiting
for (const kind of ['sandboxed', 'data: URL']) {
	const page = await hostPage('remote-host-noref.html');
	const result = await page.evaluate(
		async ([kind, host, transport, proxy, settle]) => {
			const html = `<!doctype html><script src="${host}stomp/Controller.js"></script><script>${settle}
window.__settle(${JSON.stringify({ proxyOrigin: proxy, directory: '/stomp/', id: 'opaquehost', transport, codec: 'xor' })}, 20000).then((result) => parent.postMessage({ opaque: result }, '*'), (error) => parent.postMessage({ opaque: { name: 'threw', message: String(error) } }, '*'));
</script>`;
			const element = document.createElement('iframe');
			if (kind === 'sandboxed') {
				element.sandbox = 'allow-scripts';
				element.srcdoc = html;
			} else element.src = `data:text/html,${encodeURIComponent(html)}`;
			const answer = new Promise((resolve) =>
				addEventListener('message', (event) => {
					if (event.data?.opaque) resolve(event.data.opaque);
				}),
			);
			document.body.append(element);
			return Promise.race([
				answer,
				new Promise((resolve) =>
					setTimeout(() => resolve({ name: 'no report in 30 s' }), 30000),
				),
			]);
		},
		[kind, HOST, transport, PROXY, SETTLE],
	);
	ok(
		`a host page of an opaque origin (${kind}) gets an EmbedderRefusedError that says why`,
		result.name === 'EmbedderRefusedError' &&
			/opaque/.test(result.message) &&
			result.ms < 10000,
		JSON.stringify(result),
	);
	await page.close();
}

await sleep(0);
await done(browser, errors);
