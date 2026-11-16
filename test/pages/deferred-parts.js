// What a document answers of the APIs whose code is a deferred part of the
// document bundle (src/inject/dom/deferredParts.ts): the service worker
// container and the Cookie Store API (the suite deferred-parts). Loaded by
// deferred-parts.html and by each child it makes; a child posts its answers
// to its parent.
window.__deferredAnswers = async function () {
	const out = {};
	const failure = (error) =>
		`${error && error.name}: ${error && error.message}`;
	const read = (get) => {
		try {
			return get();
		} catch (error) {
			return failure(error);
		}
	};
	out.container = read(() => String(navigator.serviceWorker));
	out.controller = read(() => String(navigator.serviceWorker.controller));
	try {
		const pending = navigator.serviceWorker.getRegistrations();
		// made in this document's realm, as the browser's
		out.ownPromise = pending instanceof Promise;
		out.registrations = (await pending).length;
	} catch (error) {
		out.registrations = failure(error);
	}
	try {
		await navigator.serviceWorker.register('https://elsewhere.invalid/sw.js');
		out.foreign = 'registered';
	} catch (error) {
		out.foreign = failure(error);
		out.foreignOwn = error instanceof DOMException;
		out.foreignStack = /\/stomp\/|rewriterLib/i.test(
			String(error && error.stack),
		);
	}
	if (typeof cookieStore === 'undefined') out.cookieStore = 'none';
	else {
		const outcome = async (call) => {
			try {
				const value = await call();
				return value && typeof value === 'object' ? value.value : value;
			} catch (error) {
				return failure(error);
			}
		};
		out.set = await outcome(() => cookieStore.set('dfp', 'one'));
		out.get = await outcome(() => cookieStore.get('dfp'));
		out.deleted = await outcome(async () => {
			await cookieStore.delete('dfp');
			return cookieStore.get('dfp');
		});
		// the byte limits, counted in UTF-8 (two bytes a letter, a lone
		// surrogate three)
		for (const [key, name] of [
			['twoByteAtLimit', 'é'.repeat(2048)],
			['twoByteOver', 'é'.repeat(2049)],
			['surrogateUnder', '\ud800'.repeat(1365)],
			['surrogateOver', '\ud800'.repeat(1366)],
			['pairOver', '😀'.repeat(1025)],
		]) {
			out[key] = await outcome(() => cookieStore.set(name, ''));
			await outcome(() => cookieStore.delete(name));
		}
		out.ownRejection = await cookieStore
			.get({ url: 'https://elsewhere.invalid/' })
			.then(
				() => 'resolved',
				(error) => error instanceof TypeError,
			);
	}
	out.names = Object.getOwnPropertyNames(window).filter((name) =>
		/stompDeferred|stompParts/i.test(name),
	);
	return out;
};
if (parent !== window)
	window
		.__deferredAnswers()
		.then((answers) =>
			parent.postMessage({ deferred: answers, name: window.name }, '*'),
		);
