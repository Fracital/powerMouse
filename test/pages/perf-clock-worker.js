// A worker of the clocks fixture (performance-clocks suite): its own time
// origin and clock, and what it has of the memory interfaces.
const firstNow = performance.now();
const step = (read) => {
	let smallest = Infinity;
	let last = read();
	for (let i = 0; i < 200000 && smallest > 0.0051; i++) {
		const next = read();
		if (next !== last) {
			smallest = Math.min(smallest, next - last);
			last = next;
		}
	}
	return Math.round(smallest * 1000);
};
const report = () => ({
	timeOrigin: performance.timeOrigin,
	firstNow,
	now: performance.now(),
	date: Date.now(),
	nowStep: step(() => performance.now()),
	crossOriginIsolated: self.crossOriginIsolated,
	memory: typeof performance.memory,
	measure: typeof performance.measureUserAgentSpecificMemory,
	json: Object.keys(performance.toJSON()).join(','),
});
if (
	typeof onconnect === 'undefined' ||
	self.constructor.name !== 'SharedWorkerGlobalScope'
)
	postMessage(report());
else self.onconnect = (event) => event.ports[0].postMessage(report());
