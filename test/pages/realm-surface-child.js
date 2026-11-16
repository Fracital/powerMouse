// A document of the realm-surface suite that walks its own realm and
// reports to the page that made it (its opener, or its parent). The realm's
// name is in the document's address, or in this script's (a document made
// from markup: srcdoc, data:, javascript:, document.write).
(async () => {
	const walker = globalThis.__realmWalker;
	const own = document.currentScript?.src ?? '';
	const params = new URLSearchParams(
		own.includes('?') ? own.slice(own.indexOf('?')) : location.search,
	);
	const realm = params.get('realm');
	const report = { realmSurface: realm };
	try {
		const result = await walker.walkSettled(window, {
			skip: ['__realmSurface'],
			avoid: JSON.parse(params.get('avoid') ?? '[]'),
		});
		report.lines = walker.lines(result);
		report.counts = result.counts;
	} catch (error) {
		report.error = String(error?.stack ?? error);
	}
	const to = window.opener ?? window.parent;
	// a frame of another process loses a message sent while the page shows
	// nothing of its own: sent until the page says it has it
	let heard = false;
	addEventListener('message', (event) => {
		if (event.data?.realmSurfaceHeard === realm) heard = true;
	});
	for (let i = 0; i < 40 && !heard; i++) {
		to.postMessage(report, '*');
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
})();
