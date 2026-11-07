// Stomp's testdriver-vendor.js: no WebDriver behind it, just enough for the
// vendored cookie and fetch-metadata tests to run to a verdict.
//
// - delete_all_cookies expires every cookie document.cookie can see, for the
//   document's own path, each ancestor path and the root. HttpOnly cookies
//   and cookies on other paths stay, so a test that relies on them failing
//   to exist fails natively and is left out of the comparison.
// - click dispatches a synthetic click: test_driver.bless() then runs its
//   action without user activation instead of waiting forever for a human,
//   so the "user activated" cases fail fast natively.
(function () {
	var internal = window.test_driver_internal;

	function expire(name, path) {
		var attrs = '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0';
		document.cookie = name + attrs + (path === null ? '' : '; path=' + path);
		document.cookie =
			name + attrs + (path === null ? '' : '; path=' + path) + '; secure';
	}

	internal.delete_all_cookies = function () {
		var names = document.cookie
			.split(';')
			.filter(function (part) {
				return part.trim().length;
			})
			.map(function (part) {
				// a part without `=` is a nameless cookie: its identity is the
				// empty name, so `=; max-age=0` is what removes it
				var eq = part.indexOf('=');
				return eq < 0 ? '' : part.slice(0, eq).trim();
			});
		var paths = [null, '/'];
		var segments = location.pathname.split('/').slice(1, -1);
		for (var i = 1; i <= segments.length; i++) {
			paths.push('/' + segments.slice(0, i).join('/'));
			paths.push('/' + segments.slice(0, i).join('/') + '/');
		}
		names.forEach(function (name) {
			paths.forEach(function (path) {
				expire(name, path);
			});
		});
		return Promise.resolve();
	};

	internal.click = function (element) {
		element.click();
		return Promise.resolve();
	};
})();
