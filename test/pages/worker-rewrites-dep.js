// imported by worker-rewrites.js: served through the proxy, so rewritten
// before the worker sees it
self.viaImport = function () {
	return [location.href, new Function('return location.pathname;')()];
};
