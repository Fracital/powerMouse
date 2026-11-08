// a dedicated or shared worker: its own requests (importScripts, fetch)
// name the fixture like any page's
const mark = (name) => new URL(`echo.json?bypass=${name}`, location.href).href;
try {
	importScripts(
		new URL('inline-script.js?bypass=importScripts', location.href).href,
	);
} catch (error) {
	// a module worker or a refused import: the request is what is measured
}
fetch(mark(`${self.name || 'worker'}-fetch`)).catch(() => {});
