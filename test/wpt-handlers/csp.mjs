// The wptserve pieces the vendored content-security-policy/ tests need
// (test/wpt/lists/csp.mjs).
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

export default ({ root, setHeaders }) => {
	// wptserve's /echo WebSocket endpoint: every message back as it came
	const echo = new WebSocketServer({ noServer: true });
	return {
		handlers: {
			// common/redirect.py: a redirect to ?location=, with CORS headers
			// when asked
			'/common/redirect.py': (req, res, url) => {
				res.statusCode = Number(url.searchParams.get('status')) || 302;
				const headers = [['Location', url.searchParams.get('location') ?? '']];
				if (url.searchParams.has('enable-cors') && req.headers.origin)
					headers.push(
						['Content-Type', 'text/plain'],
						['Access-Control-Allow-Origin', req.headers.origin],
						['Access-Control-Allow-Credentials', 'true'],
					);
				setHeaders(res, headers);
				res.end();
			},
			// support/echo-policy.py: an empty document under the policy asked for
			'/content-security-policy/support/echo-policy.py': (req, res, url) => {
				res.statusCode = 200;
				setHeaders(res, [
					['Content-Type', 'text/html'],
					['Content-Security-Policy', url.searchParams.get('policy') ?? ''],
				]);
				res.end('<!DOCTYPE html><title>Echo.</title>');
			},
			// a file without an extension, typed by its sidecar alone
			'/content-security-policy/connect-src/resources/simple-event-stream': (
				req,
				res,
			) => {
				res.statusCode = 200;
				setHeaders(res, [['Content-Type', 'text/event-stream']]);
				res.end(
					readFileSync(
						`${root}content-security-policy/connect-src/resources/simple-event-stream`,
					),
				);
			},
		},
		upgrades: {
			'/echo': (req, socket, head) =>
				echo.handleUpgrade(req, socket, head, (client) =>
					client.on('message', (data, binary) => client.send(data, { binary })),
				),
		},
	};
};
