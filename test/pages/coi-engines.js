// What a page and its worker read of cross-origin isolation (coi-engines
// suite). The fixture serves this script in a document whose headers the
// URL names (test/coi-server.mjs, /coi/doc?script=/pages/coi-engines.js);
// the worker's script is answered with the same headers. The report is left
// in `window.__coiEngine`.
(() => {
	const headers = new URLSearchParams(location.search)
		.getAll('h')
		.map((header) => `&h=${encodeURIComponent(header)}`)
		.join('');
	const read = () => ({
		crossOriginIsolated: self.crossOriginIsolated,
		SharedArrayBuffer: typeof SharedArrayBuffer,
	});
	const report = { page: read() };
	const done = (worker) => {
		report.worker = worker;
		window.__coiEngine = report;
	};
	const source = `postMessage((${read})())`;
	try {
		const worker = new Worker(
			`/coi/r?k=engines&type=js&js=${encodeURIComponent(source)}${headers}`,
		);
		worker.onmessage = (event) => done(event.data);
		worker.onerror = () => done('error');
	} catch (error) {
		done(`threw ${error?.name}`);
	}
})();
