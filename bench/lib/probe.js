// Runs in an isolated world ("bench") of every document the browser loads,
// natively and through every proxy alike (Page.addScriptToEvaluateOnNewDocument
// with a worldName). An isolated world shares the DOM but none of the page's
// JavaScript objects, so nothing a proxy hooks in the page's world changes
// what is read here. lib/browser.mjs calls __benchProbe.snapshot().
(() => {
	if (globalThis.__benchProbe) return;
	const errors = [];
	const marks = { start: Date.now() };
	const paint = {};
	addEventListener(
		'error',
		(event) => {
			if (!(event instanceof ErrorEvent)) return;
			errors.push(
				String(event.message || event.error || 'error').slice(0, 300),
			);
		},
		true,
	);
	addEventListener('unhandledrejection', (event) => {
		let reason;
		try {
			reason = String(event.reason && (event.reason.message || event.reason));
		} catch {
			reason = 'unhandled rejection';
		}
		errors.push(('unhandledrejection: ' + reason).slice(0, 300));
	});
	addEventListener('DOMContentLoaded', () => (marks.dcl = performance.now()));
	addEventListener('load', () => {
		marks.load = performance.now();
		marks.loadWall = Date.now();
	});
	// a document a page or proxy writes with document.open() has no load
	// event of its own here; its readyState still reaches complete
	document.addEventListener('readystatechange', () => {
		if (document.readyState === 'complete') marks.completeWall = Date.now();
	});
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries())
				if (entry.name === 'first-contentful-paint')
					paint.fcp = entry.startTime;
		}).observe({ type: 'paint', buffered: true });
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) paint.lcp = entry.startTime;
		}).observe({ type: 'largest-contentful-paint', buffered: true });
	} catch {
		// no observer for this document type
	}
	const CHALLENGE_TEXT =
		/just a moment\.\.\.|verify you are (a )?human|checking (if the site connection is secure|your browser)|are you a robot|unusual traffic from your computer|press (&|and) hold|complete the security check|enable javascript and cookies to continue|attention required|please verify you are a human|captcha|not able to serve your requests this quickly|too many requests|you have been blocked|access denied/i;
	const CHALLENGE_SELECTOR =
		'#challenge-running, #challenge-form, #cf-challenge-running, .cf-turnstile, [name="cf-turnstile-response"], .g-recaptcha, .h-captcha, #px-captcha, iframe[title*="challenge" i], iframe[title*="captcha" i], #captcha-container, [data-sitekey]';
	function snapshot({ text = true } = {}) {
		const doc = document;
		const body = doc.body;
		let innerText = '';
		if (text && body) {
			try {
				innerText = body.innerText || '';
			} catch {
				innerText = '';
			}
		}
		const nav = performance.getEntriesByType('navigation')[0];
		const resources = performance.getEntriesByType('resource');
		let failed = 0;
		let transfer = 0;
		for (const entry of resources) {
			if (entry.responseStatus >= 400) failed++;
			transfer += entry.transferSize || 0;
		}
		const challenge =
			CHALLENGE_TEXT.test(doc.title) ||
			(innerText.length < 3000 && CHALLENGE_TEXT.test(innerText)) ||
			!!doc.querySelector(CHALLENGE_SELECTOR);
		return {
			href: location.href,
			title: doc.title,
			readyState: doc.readyState,
			timeOrigin: performance.timeOrigin,
			start: marks.start,
			// a timing of 0 means the event has not happened yet
			dcl: marks.dcl ?? ((nav && nav.domContentLoadedEventEnd) || null),
			load: marks.load ?? ((nav && nav.loadEventEnd) || null),
			loadWall: marks.loadWall ?? null,
			completeWall: marks.completeWall ?? null,
			fcp: paint.fcp ?? null,
			lcp: paint.lcp ?? null,
			errors: errors.slice(0, 200),
			errorCount: errors.length,
			elements: doc.getElementsByTagName('*').length,
			text: innerText.slice(0, 200000),
			textLength: innerText.length,
			scrollHeight: doc.documentElement ? doc.documentElement.scrollHeight : 0,
			scrollY: scrollY,
			resources: resources.length,
			failedResources: failed,
			transfer: transfer + ((nav && nav.transferSize) || 0),
			challenge,
			now: performance.now(),
			benchResult: doc.documentElement
				? doc.documentElement.getAttribute('data-bench-result')
				: null,
		};
	}
	globalThis.__benchProbe = { snapshot, errors, marks, paint };
})();
