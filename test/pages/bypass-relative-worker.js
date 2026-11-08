// a dedicated or shared worker under a deeper path than its page: its
// relative URLs (importScripts, fetch, XHR, a nested worker) resolve against
// the worker script's URL (bypass-relative.html)
const name = self.name || 'worker';
try {
	importScripts(`../i/inline-script.js?rb=${name}-importScripts`);
} catch (error) {
	// inline-script.js touches window: the request is what is measured
}
fetch(`../j/echo.json?rb=${name}-fetch`).catch(() => {});
const xhr = new XMLHttpRequest();
xhr.open('GET', `../j/echo.json?rb=${name}-xhr`);
xhr.send();
if (name === 'dedicated' && typeof Worker === 'function')
	new Worker('../n/bypass-relative-worker.js?rb=nested-worker', {
		name: 'nested',
	});
