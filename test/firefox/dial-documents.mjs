// Focused Firefox counterpart of demo-dial-documents and
// demo-image-hydration. Set STOMP_DEMO_SITE to test the protected demo.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchFirefox } from './bidi.mjs';
import { startServers } from './servers.mjs';

const firefox = await launchFirefox();
if (!firefox) process.exit(0);
const out = fileURLToPath(new URL('../out/', import.meta.url));
if (process.env.SHOTS) mkdirSync(out, { recursive: true });
let servers;
let failures = 0;
const ok = (name, condition) => {
	if (!condition) failures++;
	console.log((condition ? 'PASS ' : 'FAIL ') + name);
};
try {
	servers = await startServers({ env: { STOMP_DIALING: '1' }, slots: 0 });
	for (const [name, file, predicate] of [
		[
			'hydration',
			'image-hydration.html',
			() =>
				document.body?.dataset.loaded === 'yes' &&
				document.body.dataset.realm === 'true',
		],
		['png', 'object-events.png', () => document.images[0]?.naturalWidth > 0],
		['jpeg', 'dial-document.jpg', () => document.images[0]?.naturalWidth > 0],
		['svg', 'blank-pixel.svg', () => document.images[0]?.naturalWidth > 0],
		[
			'mp3',
			'dial-document.mp3',
			() => document.querySelector('audio')?.readyState >= 1,
		],
		[
			'mp4',
			'dial-document.mp4',
			() => document.querySelector('video')?.readyState >= 1,
		],
		[
			'text',
			'dial-document.txt',
			() =>
				document.querySelector('pre')?.textContent.includes('<script>') &&
				!window.dialTextExecuted &&
				!document.scripts.length,
		],
		[
			'json',
			'dial-document.json',
			() =>
				document.querySelector('pre')?.textContent.includes('"number": 42') &&
				!window.dialTextExecuted &&
				!document.scripts.length,
		],
		[
			'pdf',
			'dial-document.pdf',
			() =>
				document.querySelector('embed')?.src.startsWith('blob:') &&
				document.querySelector('a[download]')?.href.startsWith('blob:'),
		],
	]) {
		const tab = await firefox.newTab();
		try {
			await tab.go(servers.proxy);
			if (
				!(await tab.until(
					() =>
						document.getElementById('logMsg')?.textContent.startsWith('Ready'),
					{ timeout: 60000 },
				))
			)
				throw new Error('demo not ready');
			await tab.eval(
				(url) => {
					const form = document.getElementById('mainForm');
					form.url.value = url;
					form.requestSubmit();
				},
				servers.fixture + 'pages/' + file,
			);
			const frame = await tab.find(predicate, {
				skipTop: true,
				timeout: 20000,
			});
			ok(
				name +
					': ' +
					(name === 'pdf' ? 'viewer and fallback offered' : 'document renders'),
				!!frame,
			);
			if (frame && process.env.SHOTS) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				await tab.screenshot(out + 'firefox-dial-document-' + name + '.png');
			}
		} finally {
			await tab.close();
		}
	}
} catch (error) {
	console.error(error);
	failures++;
} finally {
	servers?.stop();
	await firefox.close();
}
process.exit(failures ? 1 : 0);
