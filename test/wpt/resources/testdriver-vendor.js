// STomp's testdriver-vendor.js: no WebDriver behind it, just enough for the
// vendored cookie and fetch-metadata tests to run to a verdict.
//
// - delete_all_cookies expires every cookie document.cookie can see, for the
//   document's own path, each ancestor path and the root. HttpOnly cookies
//   and cookies on other paths stay, so a test that relies on them failing
//   to exist fails natively and is left out of the comparison. It settles
//   in a later task, like WebDriver, and spreads its writes over tasks:
//   through the proxy each document.cookie access is a beacon that only
//   completes in a later task, and Chrome refuses a beacon past 64 KiB in
//   flight per document, so a cleanup between subtests that never yields
//   (or a dozen writes of a 4 KiB name) would run the page out of beacons.
// - click dispatches a synthetic click: test_driver.bless() then runs its
//   action without user activation instead of waiting forever for a human,
//   so the "user activated" cases fail fast natively.
(function () {
	var internal = window.test_driver_internal;
	// what one task may write before the next write waits for a new task
	var TASK_BUDGET = 16384;

	function nextTask() {
		return new Promise(function (resolve) {
			setTimeout(resolve, 0);
		});
	}

	internal.delete_all_cookies = async function () {
		var names = document.cookie
			.split(';')
			.filter(function (part) {
				return part.trim().length;
			})
			.map(function (part) {
				// a part without `=` is a nameless cookie: its identity is the
				// empty name
				var eq = part.indexOf('=');
				return eq < 0 ? '' : part.slice(0, eq).trim();
			});
		var paths = [null, '/'];
		var segments = location.pathname.split('/').slice(1, -1);
		for (var i = 1; i <= segments.length; i++) {
			paths.push('/' + segments.slice(0, i).join('/'));
			paths.push('/' + segments.slice(0, i).join('/') + '/');
		}
		var writes = [];
		names.forEach(function (name) {
			// an empty name with an empty value is ignored (RFC 6265bis 5.7),
			// so a nameless cookie is expired with a placeholder value
			var expired =
				name +
				(name === '' ? '=x' : '=') +
				'; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0';
			paths.forEach(function (path) {
				var line = expired + (path === null ? '' : '; path=' + path);
				writes.push(line, line + '; secure');
			});
		});
		var written = 0;
		for (var w = 0; w < writes.length; w++) {
			if (written > 0 && written + writes[w].length > TASK_BUDGET) {
				await nextTask();
				written = 0;
			}
			document.cookie = writes[w];
			// the beacon carries the line plus its envelope
			written += writes[w].length + 256;
		}
		await nextTask();
	};

	internal.click = function (element) {
		element.click();
		return Promise.resolve();
	};
})();
