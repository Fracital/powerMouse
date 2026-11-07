/* global add_completion_callback, setup */

// Stomp's testharnessreport.js: when a page's tests finish, keep the results
// on the window (window.__wptResults) and post them to the fixture
// (/_wpt/report, same origin as the test, so through the proxy they travel the
// proxied path too), where test/wpt.mjs collects them.
//
// The harness timeout is doubled: a page's requests go through a service
// worker, a MessagePort and a wisp relay when proxied, and the same budget
// applies natively so the two runs stay comparable.
(function () {
	setup({ timeout_multiplier: 2 });

	var TEST_STATUS = [
		'PASS',
		'FAIL',
		'TIMEOUT',
		'NOTRUN',
		'PRECONDITION_FAILED',
	];
	var HARNESS_STATUS = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'];

	add_completion_callback(function (tests, status) {
		var report = {
			path: location.pathname,
			href: location.href,
			status: {
				status: HARNESS_STATUS[status.status] || String(status.status),
				message: status.message || null,
			},
			tests: tests.map(function (test) {
				return {
					name: test.name,
					status: TEST_STATUS[test.status] || String(test.status),
					message: test.message || null,
				};
			}),
		};
		self.__wptResults = report;
		// no keepalive: Chrome sends keepalive requests past the service
		// worker, so through the proxy the report would never arrive
		try {
			fetch('/_wpt/report', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(report),
			}).catch(function () {});
		} catch (e) {
			// no fetch: the suite falls back to window.__wptResults
		}
	});
})();
