// Markup parity: a page reads its own markup back exactly as it does when
// served natively. Each fixture page is loaded straight from the fixture
// site and through the proxy (both demo modes); once it has finished, the
// document's outerHTML and its body's getHTML, every element's attribute names, its `attributes`
// map and getAttribute for every name either side has are read through the
// page's own APIs and compared. An attribute only the proxy has (a marker,
// one a hook wrote that the page never did), one only the page has, or a
// value that differs fails by element and attribute name. The page's
// MutationObserver records for routed attributes (mutation-records.html)
// are compared the same way, record by record, and so are the page errors:
// one the proxied load raises and the native load does not fails.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	proxiedOnlyErrors,
	PROXY,
	sleep,
	submitLanding,
	trackErrors,
} from '../lib.mjs';

// the adversarial corpus (each page waits for its probes), and pages built
// around routed attributes and inline documents
const PAGES = [
	'adv-attrs.html',
	'adv-urls.html',
	'adv-scripts.html',
	'adv-eval.html',
	'adv-globals.html',
	'adv-protos.html',
	'adv-messages.html',
	'adv-frames.html',
	'adv-workers.html',
	'dom.html',
	'links.html',
	'carriers.html',
	'inline-docs.html',
	'srcdoc.html',
	'template.html',
	'url-defaults.html',
	'mutation-records.html',
];

/** whether the page has finished what it does on load */
const finished = () =>
	document.readyState === 'complete' &&
	(window.__adv ? window.__adv.done === true : true) &&
	(document.title === 'MUTATION RECORDS' ? !!window.__mutations : true);

/**
 * The page's view of its own markup, read with its own (hooked) APIs. An
 * element is named by its path: tag, id when it has one, index among its
 * siblings of that tag otherwise. A probe's report (<pre id="result">)
 * carries values the corpus measures elsewhere, so its text is left out.
 */
const snapshot = () => {
	// a serializable shadow root with routed loads, for getHTML's shadow
	// path: made once, the same natively and proxied
	if (!document.getElementById('shadow-host') && document.body.attachShadow) {
		const host = document.createElement('div');
		host.id = 'shadow-host';
		host
			.attachShadow({ mode: 'open', serializable: true })
			.setHTMLUnsafe?.(
				'<img src="sprite.svg?shadow"><a href="hist-1.html">s</a>',
			);
		document.body.append(host);
		// roots getHTML includes only when the page lists them: an open one
		// that is not serializable, and a closed one
		const open = document.createElement('div');
		open.id = 'listed-open';
		const openRoot = open.attachShadow({ mode: 'open' });
		openRoot.setHTMLUnsafe?.('<img src="sprite.svg?listed-open">');
		const closed = document.createElement('div');
		closed.id = 'listed-closed';
		const closedRoot = closed.attachShadow({ mode: 'closed' });
		closedRoot.setHTMLUnsafe?.('<a href="hist-1.html">closed</a>');
		document.body.append(open, closed);
		window.__listedRoots = [openRoot, closedRoot];
	}
	const name = (element) => {
		if (element.id) return `${element.localName}#${element.id}`;
		const parent = element.parentElement;
		if (!parent) return element.localName;
		const same = [...parent.children].filter(
			(child) => child.localName === element.localName,
		);
		return same.length > 1
			? `${element.localName}[${same.indexOf(element)}]`
			: element.localName;
	};
	const path = (element) => {
		const parts = [];
		for (let node = element; node; node = node.parentElement)
			parts.unshift(name(node));
		return parts.join('>');
	};
	const elements = {};
	for (const element of document.querySelectorAll('*')) {
		let key = path(element);
		while (key in elements) key += "'";
		const names = element.getAttributeNames();
		elements[key] = {
			names,
			attributes: [...element.attributes].map((attr) => [
				attr.name,
				attr.value,
			]),
			get: Object.fromEntries(
				names.map((name) => [name, element.getAttribute(name)]),
			),
		};
	}
	return {
		html: document.documentElement.outerHTML.replace(
			/(<pre id="result"[^>]*>)[\s\S]*?(<\/pre>)/,
			'$1$2',
		),
		// getHTML, the shadow-root-aware serializer, the same way
		getHTML:
			typeof document.body.getHTML === 'function'
				? document.body
						.getHTML({ serializableShadowRoots: true })
						.replace(/(<pre id="result"[^>]*>)[\s\S]*?(<\/pre>)/, '$1$2')
				: null,
		shadowHTML:
			document.getElementById('shadow-host')?.shadowRoot?.getHTML?.() ?? null,
		listedHTML:
			window.__listedRoots && typeof document.body.getHTML === 'function'
				? document.body
						.getHTML({ shadowRoots: window.__listedRoots })
						.replace(/(<pre id="result"[^>]*>)[\s\S]*?(<\/pre>)/, '$1$2')
				: null,
		elements,
		mutations: window.__mutations ?? null,
	};
};

/** getAttribute on one element for names the other side has */
const getAttributes = ([elementPath, names]) => {
	const match = [...document.querySelectorAll('*')].filter((element) => {
		const parts = [];
		for (let node = element; node; node = node.parentElement) {
			let part = node.localName;
			if (node.id) part += `#${node.id}`;
			else if (node.parentElement) {
				const same = [...node.parentElement.children].filter(
					(child) => child.localName === node.localName,
				);
				if (same.length > 1) part += `[${same.indexOf(node)}]`;
			}
			parts.unshift(part);
		}
		return parts.join('>') === elementPath.replace(/'+$/, '');
	})[elementPath.length - elementPath.replace(/'+$/, '').length];
	if (!match) return null;
	return Object.fromEntries(
		names.map((name) => [
			name,
			[match.hasAttribute(name), match.getAttribute(name)],
		]),
	);
};

/**
 * A blob: URL names a fresh UUID on every load: the two sides are compared
 * with it masked, origin kept
 */
const normalize = (snapshot) =>
	JSON.parse(
		JSON.stringify(snapshot).replace(
			/(blob:[a-z]+:\/\/[^/"\s]+\/)[0-9a-f-]{36}/g,
			'$1<uuid>',
		),
	);

/** the proxied page's frame: a direct child of the host document */
const proxiedFrame = (page) =>
	page
		.frames()
		.find(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html\//.test(f.url()),
		);

async function waitFor(getFrame) {
	const started = Date.now();
	while (Date.now() - started < 45000) {
		const frame = getFrame();
		if (await frame?.evaluate(finished).catch(() => false)) {
			// late writes (timers a probe left behind) settle first
			await sleep(500);
			return frame;
		}
		await sleep(250);
	}
	return null;
}

const show = (value) =>
	value === undefined ? 'absent' : JSON.stringify(value)?.slice(0, 160);

/** every difference between the two views, by element and attribute */
async function compare(native, proxied, frame) {
	const differences = [];
	for (const key of new Set([
		...Object.keys(native.elements),
		...Object.keys(proxied.elements),
	])) {
		const a = native.elements[key];
		const b = proxied.elements[key];
		if (!a || !b) {
			differences.push(`${key}: element ${a ? 'missing' : 'extra'} proxied`);
			continue;
		}
		const names = [...new Set([...a.names, ...b.names])];
		for (const name of names) {
			if (!a.names.includes(name) || !b.names.includes(name))
				differences.push(
					`${key} [${name}]: ${a.names.includes(name) ? 'missing' : 'extra'} in getAttributeNames()`,
				);
			else if (a.get[name] !== b.get[name])
				differences.push(
					`${key} [${name}]: getAttribute native ${show(a.get[name])} proxied ${show(b.get[name])}`,
				);
		}
		if (
			a.names.length === b.names.length &&
			a.names.every((name) => b.names.includes(name)) &&
			JSON.stringify(a.names) !== JSON.stringify(b.names)
		)
			differences.push(
				`${key}: attribute order native ${a.names.join(' ')} proxied ${b.names.join(' ')}`,
			);
		if (JSON.stringify(a.attributes) !== JSON.stringify(b.attributes))
			for (const name of names) {
				const x = a.attributes.find(([n]) => n === name);
				const y = b.attributes.find(([n]) => n === name);
				if (JSON.stringify(x) !== JSON.stringify(y))
					differences.push(
						`${key} [${name}]: attributes native ${show(x?.[1])} proxied ${show(y?.[1])}`,
					);
			}
		// a name only the native page has is asked of the proxied element too
		const asked = a.names.filter((name) => !b.names.includes(name));
		if (asked.length) {
			const seen = await frame
				.evaluate(getAttributes, [key, asked])
				.catch(() => null);
			for (const name of asked)
				if (seen && seen[name] && seen[name][1] !== a.get[name])
					differences.push(
						`${key} [${name}]: getAttribute native ${show(a.get[name])} proxied ${show(seen[name][1])}`,
					);
		}
	}
	return differences;
}

/** the first place two serialisations part, with some context */
function firstDifference(a, b) {
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return `at ${i}: native ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 80))} proxied ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 80))}`;
}

const browser = await launch();
for (const file of PAGES) {
	const url = `${FIXTURE}pages/${file}`;
	const nativePage = await browser.newPage();
	const nativeErrors = trackErrors(nativePage);
	await nativePage.goto(url).catch(() => {});
	const nativeFrame = await waitFor(() => nativePage.mainFrame());
	const native = nativeFrame
		? normalize(await nativeFrame.evaluate(snapshot))
		: null;
	await nativePage.close();
	ok(`${file}: the page finishes natively`, !!native);
	if (!native) continue;

	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		await submitLanding(page, url);
		const frame = await waitFor(() => proxiedFrame(page));
		const proxied = frame ? normalize(await frame.evaluate(snapshot)) : null;
		ok(`${mode}: ${file} finishes through the proxy`, !!proxied);
		if (proxied) {
			const differences = await compare(native, proxied, frame);
			ok(
				`${mode}: ${file} every element's attributes read back as natively`,
				differences.length === 0,
				differences.slice(0, 20).join('; ') +
					(differences.length > 20
						? `; ...${differences.length - 20} more`
						: ''),
			);
			ok(
				`${mode}: ${file} document outerHTML reads back as natively`,
				native.html === proxied.html,
				native.html === proxied.html
					? ''
					: firstDifference(native.html, proxied.html),
			);
			ok(
				`${mode}: ${file} a shadow root's getHTML reads back as natively`,
				native.shadowHTML === proxied.shadowHTML,
				JSON.stringify({
					native: native.shadowHTML,
					proxied: proxied.shadowHTML,
				}),
			);
			ok(
				`${mode}: ${file} getHTML with roots the page lists reads back as natively`,
				native.listedHTML === proxied.listedHTML,
				native.listedHTML === proxied.listedHTML
					? ''
					: firstDifference(native.listedHTML ?? '', proxied.listedHTML ?? ''),
			);
			ok(
				`${mode}: ${file} getHTML reads back as natively`,
				native.getHTML === proxied.getHTML,
				native.getHTML === proxied.getHTML
					? ''
					: firstDifference(native.getHTML ?? '', proxied.getHTML ?? ''),
			);
			if (native.mutations)
				for (const [name, seen] of Object.entries(native.mutations)) {
					const theirs = proxied.mutations?.[name];
					ok(
						`${mode}: ${file} MutationObserver: ${name}`,
						JSON.stringify(seen) === JSON.stringify(theirs),
						JSON.stringify(seen) === JSON.stringify(theirs)
							? JSON.stringify(seen).slice(0, 200)
							: `native ${JSON.stringify(seen)} proxied ${JSON.stringify(theirs)}`,
					);
				}
		}
		// an error only the proxied load raises is code that throws through
		// the proxy and runs natively (rewritten code in a realm the inject
		// never reached throws a ReferenceError for the access helper)
		const extra = proxiedOnlyErrors(
			nativeErrors,
			page.errors,
			page.errorStacks,
		);
		ok(
			`${mode}: ${file} raises no page error it does not raise natively`,
			extra.length === 0,
			JSON.stringify(extra),
		);
		await page.close();
	}
}
await done(browser);
