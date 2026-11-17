// A worker's global as the Origin API extracts it (origin-api.html)
const origin = Origin.from(self);
let fromLocation;
try {
	Origin.from(location);
	fromLocation = 'ok';
} catch (e) {
	fromLocation = `${e.name}: ${e.message}`;
}
postMessage([
	origin.opaque,
	origin.isSameOrigin(Origin.from(location.href)),
	origin.isSameOrigin(Origin.from(`http://localhost:${location.port}`)),
	fromLocation,
]);
