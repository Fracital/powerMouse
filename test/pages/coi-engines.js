// What a page, its workers and its frames read of cross-origin isolation
// (coi-engines suite). The fixture serves this script in a document whose
// headers the URL names (test/coi-server.mjs, /coi/doc?script=/pages/coi-engines.js);
// a worker's script is answered with the same headers, a blob: worker (a
// classic one and a module) is made of the same source, and a blob: script
// says whether it ran. With `frames=<origin>` the page also makes the
// frames FRAMES names (each a document of this script with `frame=<name>`,
// which posts its report to its parent; another origin's is of `<origin>`).
// The report is left in `window.__coiEngine`: { page, worker, blobWorker,
// blobModuleWorker, blobScript, frames: { name: report | 'no report' } }.
(() => {
	const query = new URLSearchParams(location.search);
	const own = query.getAll('h');
	const headers = (list) =>
		list.map((header) => `&h=${encodeURIComponent(header)}`).join('');
	const read = () => ({
		crossOriginIsolated: self.crossOriginIsolated,
		SharedArrayBuffer: typeof SharedArrayBuffer,
	});
	const source = `postMessage((${read})())`;
	const started = (make) =>
		new Promise((resolve) => {
			try {
				const worker = make();
				worker.onmessage = (event) => resolve(event.data);
				worker.onerror = () => resolve('error');
			} catch (error) {
				resolve(`threw ${error?.name}`);
			}
		});
	const reports = [
		started(
			() =>
				new Worker(
					`/coi/r?k=engines&type=js&js=${encodeURIComponent(source)}${headers(own)}`,
				),
		),
		started(
			() =>
				new Worker(
					URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
				),
		),
		started(
			() =>
				new Worker(
					URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
					{ type: 'module' },
				),
		),
		new Promise((resolve) => {
			const script = document.createElement('script');
			script.src = URL.createObjectURL(
				new Blob(['self.coiBlobScript = "ran"'], { type: 'text/javascript' }),
			);
			script.onload = () => resolve(self.coiBlobScript ?? 'no run');
			script.onerror = () => resolve('error');
			document.documentElement.append(script);
		}),
	];
	const RC = 'cross-origin-embedder-policy:require-corp';
	const CORP = 'cross-origin-resource-policy:cross-origin';
	// name: [headers, attributes, of the other origin]
	const FRAMES = {
		'of its origin, giving up the permission': [
			[RC],
			{ allow: "cross-origin-isolated 'none'" },
		],
		'of another origin': [[RC, CORP], {}, true],
		'with COEP credentialless': [
			['cross-origin-embedder-policy:credentialless'],
			{},
		],
		'credentialless, without an embedder policy': [[], { credentialless: '' }],
	};
	const other = query.get('frames');
	const frames = {};
	if (other)
		for (const [name, [frameHeaders, attributes, cross]] of Object.entries(
			FRAMES,
		))
			reports.push(
				new Promise((resolve) => {
					const frame = document.createElement('iframe');
					for (const [attribute, value] of Object.entries(attributes))
						frame.setAttribute(attribute, value);
					const timer = setTimeout(() => resolve('no report'), 8000);
					addEventListener('message', (event) => {
						if (event.data?.coiFrame !== name) return;
						clearTimeout(timer);
						resolve(event.data.report);
					});
					frame.src = `${cross ? other : ''}/coi/doc?script=/pages/coi-engines.js&frame=${encodeURIComponent(name)}${headers(frameHeaders)}`;
					document.body.append(frame);
				}).then((report) => {
					frames[name] = report;
				}),
			);
	Promise.all(reports).then(
		([worker, blobWorker, blobModuleWorker, blobScript]) => {
			const report = {
				page: read(),
				worker,
				blobWorker,
				blobModuleWorker,
				blobScript,
			};
			if (other) report.frames = frames;
			const frame = query.get('frame');
			if (frame) parent.postMessage({ coiFrame: frame, report }, '*');
			else window.__coiEngine = report;
		},
	);
})();
