// The worker side of the realm-surface suite, after realm-walker.js in a
// classic worker (importScripts), a module worker (import), a shared worker
// and a service worker: the realm is walked when the page asks, and the
// record goes back the way the question came.
(() => {
	const scope = globalThis;
	const walker = scope.__realmWalker;
	const run = async (data) => {
		const report = { realmSurface: data.realm };
		try {
			const result = await walker.walkSettled(scope, {
				avoid: data.avoid ?? [],
			});
			report.lines = walker.lines(result);
			report.counts = result.counts;
		} catch (error) {
			report.error = String(error?.stack ?? error);
		}
		return report;
	};
	if ('onconnect' in scope)
		scope.addEventListener('connect', (event) => {
			const port = event.ports[0];
			port.addEventListener('message', async ({ data }) =>
				port.postMessage(await run(data)),
			);
			port.start();
		});
	else if ('clients' in scope)
		scope.addEventListener('message', (event) =>
			event.waitUntil(
				run(event.data).then((report) => event.source.postMessage(report)),
			),
		);
	else
		scope.addEventListener('message', async ({ data }) => {
			if (!data.nested) {
				scope.postMessage(await run(data));
				return;
			}
			// a worker of this worker, by the same script
			const nested = new Worker(data.nested);
			nested.addEventListener('message', (event) => {
				scope.postMessage(event.data);
				nested.terminate();
			});
			nested.addEventListener('error', (event) =>
				scope.postMessage({
					realmSurface: data.realm,
					error: `nested worker error: ${event.message}`,
				}),
			);
			nested.postMessage({ realm: data.realm, avoid: data.avoid });
		});
})();
