// A call page displays non-HTML answers without interpreting their bytes
// as markup. Its media URLs must stay on the proxy's origin.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	screenshot,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const browser = await launch();
try {
	for (const [name, file, predicate] of [
		['png', 'object-events.png', () => document.images[0]?.naturalWidth > 0],
		['jpeg', 'dial-document.jpg', () => document.images[0]?.naturalWidth > 0],
		['svg', 'blank-pixel.svg', () => document.images[0]?.naturalWidth > 0],
		[
			'audio',
			'media-cors.wav',
			() => document.querySelector('audio')?.readyState >= 1,
		],
		[
			'video',
			'media-cors.webm',
			() => document.querySelector('video')?.readyState >= 1,
		],
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
			'pdf',
			'dial-document.pdf',
			() => !!document.querySelector('embed[type="application/pdf"]'),
		],
		[
			'text',
			'dial-document.txt',
			() =>
				document
					.querySelector('pre')
					?.textContent.includes('A plain text document'),
		],
		[
			'json',
			'dial-document.json',
			() => document.querySelector('pre')?.textContent.includes('"number": 42'),
		],
	]) {
		const page = await openDemo(browser, PROXY);
		await submitLanding(page, `${FIXTURE}pages/${file}`);
		const frame = await waitActive(page, predicate, 15000).catch(() => null);
		ok(
			`${name}: ${name === 'pdf' ? 'viewer is offered' : 'the dialed document renders'}`,
			!!frame,
		);
		if (frame) {
			const facts = await frame.evaluate(() => ({
				src:
					document.querySelector('img,video,audio')?.currentSrc ??
					document.querySelector('embed')?.src ??
					'',
				text: document.querySelector('pre')?.textContent ?? '',
				executed: !!window.dialTextExecuted,
				scripts: document.scripts.length,
				images: document.images.length,
			}));
			if (['text', 'json'].includes(name))
				ok(
					`${name}: literal markup is inert`,
					facts.text.includes('<script>') &&
						!facts.executed &&
						!facts.scripts &&
						!facts.images,
					JSON.stringify(facts),
				);
			else if (name === 'pdf') {
				const pdf = await frame.evaluate(async () => {
					const embed = document.querySelector('embed');
					const link = document.querySelector('a[download]');
					const bytes = await (await fetch(embed.src)).text();
					return (
						embed.src.startsWith('blob:') &&
						link?.href === embed.src &&
						bytes.startsWith('%PDF-')
					);
				});
				ok('pdf: viewer and fallback download receive the original bytes', pdf);
			} else
				ok(`${name}: source is routed`, facts.src.startsWith(PROXY), facts.src);
			if (name === 'json') {
				const pretty = await frame.evaluate(() => {
					const checkbox = document.querySelector('#pretty-json');
					checkbox.click();
					const formatted = document.querySelector('pre').textContent;
					checkbox.click();
					return (
						formatted.includes('\n  "number": 42') &&
						document.querySelector('pre').textContent.startsWith('{ "text"')
					);
				});
				ok('json: pretty print toggles without executing markup', pretty);
			}
			if (name === 'pdf') await page.waitForTimeout(1500);
			await screenshot(page, `dial-document-${name}`);
		}
		await page.close();
	}
} catch (error) {
	ok('dialed document suite completes', false, String(error));
} finally {
	await done(browser);
}
