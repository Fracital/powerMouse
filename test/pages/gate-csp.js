// The load gate under a document's policy (sop-escapes `csp/` cases): an
// image of another site (`?b=`) in an about:blank frame this document
// writes, and what the browser's own fetch reads of the URL the element
// holds. Natively that is the other site's URL, which CORS refuses; through
// the proxy it is a copy's, which must name nothing by then, whatever the
// document's policy lets its workers do. The case is named by `?name=`.
(() => {
	const query = new URLSearchParams(location.search);
	const B = query.get('b');
	const name = query.get('name');
	const out = (window.__gateCsp = { cases: {}, done: false });
	// the browser's own functions, as a realm without the inject's hooks
	// holds them (the suite takes them before anything runs)
	const N = window.__sopNative ?? {
		fetch: window.fetch,
		text: Response.prototype.text,
		getAttribute: Element.prototype.getAttribute,
	};
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const run = async () => {
		const frame = document.createElement('iframe');
		document.body.append(frame);
		const written = frame.contentDocument;
		written.open();
		written.write('<body>');
		written.close();
		const element = written.createElement('img');
		written.body.append(element);
		const event = await new Promise((resolve) => {
			for (const type of ['load', 'error'])
				element.addEventListener(type, () => resolve(type), { once: true });
			element.src = new URL(`/sop/r?type=png&k=gate-csp-${name}`, B).href;
		});
		let held = null;
		for (let i = 0; i < 40 && !held; i++) {
			held = N.getAttribute.call(element, 'src');
			if (!held) await sleep(50);
		}
		let read = 'no URL';
		if (held)
			try {
				const response = await N.fetch.call(window, held);
				read = `read ${(await N.text.call(response)).length}`;
			} catch (error) {
				read = `${error.name}: ${error.message}`;
			}
		return { event, width: element.naturalWidth, read };
	};
	addEventListener('load', async () => {
		try {
			out.cases[name] = await run();
		} catch (error) {
			out.cases[name] = { threw: `${error.name}: ${error.message}` };
		}
		out.done = true;
	});
})();
