// performance.measureUserAgentSpecificMemory() in a cross-origin isolated
// page (measured-memory suite), served by test/coi-server.mjs as
// `/coi/doc?h=<COOP>&h=<COEP>&script=/pages/measured-memory.js`. The top
// makes a frame of its own origin for each call (window.__child(id)), with
// the `src` the page writes, relative; the frame, served with the embedder
// policy only, makes one of its own (`inner`) the same way, then measures
// and posts its parent what it got: the shape of the result, its
// attribution (the page's origin and run key written as SELF and RUN, so a
// native and a proxied load compare), the raw URLs it named, and which of
// the browser's functions the suite's counting stand-in saw.
(() => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const tidy = (text) =>
		String(text)
			.split(location.origin)
			.join('SELF')
			.replace(/([?&]k=)[^&#"]*/g, '$1RUN');
	const params = new URLSearchParams(location.search);
	/** the src the page writes for its frame `id`, relative */
	const source = (id) =>
		`doc?h=${encodeURIComponent(
			'cross-origin-embedder-policy:require-corp',
		)}&script=/pages/measured-memory.js&k=${encodeURIComponent(
			params.get('k') ?? '',
		)}&frame=${encodeURIComponent(id)}`;

	if (window === window.top) {
		window.__child = (id) =>
			new Promise((resolve) => {
				const frame = document.createElement('iframe');
				frame.id = id;
				const src = source(id);
				const timer = setTimeout(() => {
					frame.remove();
					resolve({ error: 'no answer' });
				}, 40000);
				addEventListener('message', function answered(event) {
					if (event.source !== frame.contentWindow) return;
					removeEventListener('message', answered);
					clearTimeout(timer);
					frame.remove();
					resolve({
						...event.data,
						parentIsolated: self.crossOriginIsolated,
						written: tidy(src),
					});
				});
				frame.src = src;
				document.body.append(frame);
			});
		window.__ready = true;
		return;
	}

	// (the inner frame only loads)
	if (params.get('frame') === 'inner') return;
	(async () => {
		const inner = document.createElement('iframe');
		inner.id = 'inner';
		const innerSource = source('inner');
		await new Promise((resolve) => {
			inner.addEventListener('load', resolve, { once: true });
			inner.src = innerSource;
			document.body.append(inner);
		});
		const out = {
			innerWritten: tidy(innerSource),
			isolated: self.crossOriginIsolated,
			type: typeof performance.measureUserAgentSpecificMemory,
		};
		let pending = null;
		try {
			pending = performance.measureUserAgentSpecificMemory();
			out.returned = Object.prototype.toString.call(pending);
		} catch (error) {
			out.threw = String(error?.message ?? error);
		}
		if (pending) {
			// the browser measures at its next collection
			const timer = setInterval(() => typeof gc === 'function' && gc(), 200);
			const settled = await Promise.race([
				pending.then(
					(result) => ({ result }),
					(error) => ({ error: String(error?.message ?? error) }),
				),
				sleep(25000).then(() => ({})),
			]);
			clearInterval(timer);
			const result = settled.result;
			out.promise = result
				? 'resolved'
				: 'error' in settled
					? `rejected: ${settled.error}`
					: 'pending';
			if (result) {
				out.keys = Object.keys(result).join(',');
				out.bytes = [
					typeof result.bytes,
					Number.isInteger(result.bytes),
					result.bytes > 0,
				].join(',');
				out.sums =
					result.breakdown.reduce((sum, part) => sum + part.bytes, 0) ===
					result.bytes;
				out.breakdownKeys = [
					...new Set(
						result.breakdown.map((part) => Object.keys(part).join(',')),
					),
				].join(' | ');
				out.types = [...new Set(result.breakdown.flatMap((part) => part.types))]
					.sort()
					.join(',');
				const places = result.breakdown.flatMap((part) => part.attribution);
				out.attribution = [
					...new Set(
						places.map((where) =>
							tidy(
								JSON.stringify({
									keys: Object.keys(where).join(','),
									url: where.url,
									scope: where.scope,
									container: where.container ?? null,
								}),
							),
						),
					),
				].sort();
				out.raw = places.flatMap((where) =>
					[where.url, where.container?.src].filter(
						(value) => typeof value === 'string',
					),
				);
				out.frozen = Object.isFrozen(result);
			}
		}
		out.reached = [...(window.__nativeReached ?? ['no stand-in'])];
		parent.postMessage(out, '*');
	})();
})();
