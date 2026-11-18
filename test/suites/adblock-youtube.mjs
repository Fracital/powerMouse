// YouTube's ads through the built-in blocker (docs/adblock.md, "YouTube"):
// they come in the same JSON as the video, in the page's
// ytInitialPlayerResponse and in what /youtubei/v1/player answers, so no
// network rule reaches them, and uBlock Origin's lists remove them with
// scriptlets (set-constant on the page's variable, json-prune on JSON.parse,
// json-prune-fetch-response and json-prune-xhr-response on the player's
// requests, trusted-replace-fetch-response and trusted-replace-xhr-response
// on their text, replace-node-text on an inline script) and hide the
// companion, feed and overlay slots with cosmetic rules.
//
// The fixture (test/pages/adblock-yt.html) has those shapes, the list
// (test/pages/adblock-yt.txt) has the lists' own rules for them with the
// fixture's host in place of YouTube's, and the scriptlets are the ones the
// blocker runs by default: uBlock Origin's, the directory's
// adblock-resources.json (scripts/adblock-resources.mjs).
//
// Natively and through the proxy with the blocker off, the page has every ad
// field and shows every slot. The oracle for the blocker is the page loaded
// natively with the engine's own scriptlets for it run at document start, as
// Brave runs them (the engine in node, the same blocker.wasm, list and
// resources): through the proxy with the blocker on the page reads what it
// reads there, field for field, and only the ad slots are hidden.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, FIXTURE, launch, ok, OUT, PROXY } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP adblock-youtube: esbuild is not installed');
	process.exit(0);
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const site = `${FIXTURE}pages/adblock-yt.html`;
const PLAYER = `${FIXTURE}pages/deep/youtubei/v1/player?prettyPrint=false`;
const AD_KEYS = ['playerAds', 'adPlacements', 'adSlots'];
const ADS = ['feed-ad', 'companion', 'masthead-ad', 'overlay', 'sticker'];
const KEPT = ['feed-video', 'kept'];
const reads = ['initial', 'fetched', 'text', 'xhr', 'xhrJson'];

// the engine's scriptlets for the fixture page, as the worker's engine
// answers them: the list compiled trusted, the default resources loaded
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}adblock-youtube-entry.mjs`;
writeFileSync(
	entry,
	`export { BlockerInstance, OP, FLAG_TRUSTED } from ${JSON.stringify(`${root}src/blocker/instance.ts`)};\n` +
		`export { compileModule } from ${JSON.stringify(`${root}src/wasm/module.ts`)};\n`,
);
const bundle = `${OUT}adblock-youtube.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'es2022',
	outfile: bundle,
	logLevel: 'silent',
});
const { BlockerInstance, OP, FLAG_TRUSTED, compileModule } = await import(
	bundle
);
const module = await compileModule(readFileSync(`${root}dist/blocker.wasm`));
const builder = new BlockerInstance(module);
builder.call(
	readFileSync(`${root}test/pages/adblock-yt.txt`, 'utf8'),
	OP.addList | FLAG_TRUSTED,
);
builder.call('', OP.build);
const engine = new BlockerInstance(module);
engine.call(builder.bytes(), OP.load);
engine.call(
	readFileSync(`${root}dist/adblock-resources.json`, 'utf8'),
	OP.resources,
);
engine.call(site, OP.cosmetic);
const scriptlets = JSON.parse(engine.text()).injected_script;
ok(
	'the engine has scriptlets for the fixture page from the default resources',
	/^setConstant\(/m.test(scriptlets) &&
		/^jsonPruneFetchResponse\(/m.test(scriptlets) &&
		/^replaceNodeText\(/m.test(scriptlets),
	scriptlets.slice(0, 200),
);

const browser = await launch();
const waitReport = async (target) => {
	await target.waitForFunction(() => !!window.__adblockReport, null, {
		timeout: 20000,
	});
	return target.evaluate(() => window.__adblockReport());
};
/** the fixture loaded natively, with `script` run at document start */
const nativeReport = async (script) => {
	const page = await browser.newPage();
	if (script)
		await page.addInitScript(
			`(function () {\nconst scriptletGlobals = {};\n${script}\n})();`,
		);
	await page.goto(site);
	const report = await waitReport(page);
	await page.close();
	return report;
};

// natively: the page's own answer, with every ad field and slot
const native = await nativeReport('');
ok(
	'natively the page reads the ad fields everywhere and shows every slot',
	reads.every((read) => AD_KEYS.every((key) => native[read]?.includes(key))) &&
		native.parsed.includes('adPlacements') &&
		native.serverContract === true &&
		JSON.stringify(native.rpnt) === '[null,null]' &&
		Object.values(native.shown).every((shown) => shown === true),
	JSON.stringify(native),
);
const blocked = await nativeReport(scriptlets);
ok(
	'natively with the scriptlets, the ad fields are gone wherever the page reads them',
	reads.every(
		(read) =>
			!blocked[read].includes('adPlacements') &&
			!blocked[read].includes('adSlots'),
	) &&
		!blocked.initial.includes('playerAds') &&
		JSON.stringify(blocked.parsed) === JSON.stringify(['videoDetails']) &&
		JSON.stringify(blocked.rpnt) === JSON.stringify(['ran', 2]),
	JSON.stringify(blocked),
);

const page = await browser.newPage();
await page.goto(`${PROXY}?noadblock`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);

/** a controller with `adblock`, a frame on the fixture page, and its report */
const visit = (adblock) =>
	page.evaluate(
		async ({ adblock, site }) => {
			const controller = new window.StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: window.controller.directory.pathname,
				codec: 'xor',
				cache: false,
				adblock,
			});
			await controller.wait();
			const element = document.createElement('iframe');
			document.body.append(element);
			const frame = controller.createFrame(element);
			const load = new Promise((resolve) =>
				element.addEventListener('load', resolve, { once: true }),
			);
			await frame.go(site);
			await load;
			const win = element.contentWindow;
			for (let i = 0; i < 100 && !win.__adblockReport; i++)
				await new Promise((resolve) => setTimeout(resolve, 100));
			let report;
			try {
				report = await win.__adblockReport();
			} catch (error) {
				report = { threw: String(error?.stack ?? error) };
			}
			element.remove();
			return report;
		},
		{ adblock, site },
	);

const off = await visit(false);
ok(
	'through the proxy with the blocker off, the page reads what it reads natively',
	JSON.stringify(off) === JSON.stringify(native),
	JSON.stringify([off, native]),
);

// on, with the fixture's list and the default resources (the directory's
// copy of uBlock Origin's scriptlets)
const on = await visit({
	lists: [{ url: `${FIXTURE}pages/adblock-yt.txt`, trusted: true }],
});
ok(
	'on: ytInitialPlayerResponse has no ad field (set-constant), as natively with the scriptlets',
	JSON.stringify(on.initial) === JSON.stringify(blocked.initial) &&
		on.initialVideo === 'stompFixture',
	JSON.stringify([on.initial, blocked.initial, on.threw]),
);
ok(
	'on: fetch, its text and XHR read the player answer as natively with the scriptlets (json-prune-*-response, trusted-replace-*-response)',
	['fetched', 'text', 'xhr', 'xhrJson'].every(
		(read) => JSON.stringify(on[read]) === JSON.stringify(blocked[read]),
	),
	JSON.stringify(reads.map((read) => [read, on[read], blocked[read]])),
);
ok(
	'on: the pruned answer is still the response of the real URL',
	on.fetchedUrl === PLAYER &&
		blocked.fetchedUrl === PLAYER &&
		on.fetchedStatus === 200,
	JSON.stringify([on.fetchedUrl, on.fetchedStatus]),
);
ok(
	'on: JSON.parse of a player response loses the ad fields (json-prune)',
	JSON.stringify(on.parsed) === JSON.stringify(blocked.parsed),
	JSON.stringify(on.parsed),
);
ok(
	'on: replace-node-text edits an inline script before it runs, as natively, and the script still runs',
	JSON.stringify(on.rpnt) === JSON.stringify(blocked.rpnt) &&
		on.serverContract === true,
	JSON.stringify([on.rpnt, on.serverContract, on.threw]),
);
ok(
	'on: the companion, feed, masthead, overlay and sticker slots are hidden, nothing else',
	ADS.every((id) => on.shown?.[id] === false) &&
		KEPT.every((id) => on.shown?.[id] === true),
	JSON.stringify(on.shown),
);

await browser.close();
done();
