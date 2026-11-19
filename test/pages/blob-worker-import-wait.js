// A worker's import() of a blob: URL it revoked (blob-worker-import-wait.html)
const url = URL.createObjectURL(
	new Blob(['export default 1;'], { type: 'text/javascript' }),
);
URL.revokeObjectURL(url);
const started = performance.now();
import(url)
	.then(
		() => 'loaded',
		() => 'failed',
	)
	.then((result) =>
		postMessage({ result, ms: Math.round(performance.now() - started) }),
	);
