// The wptserve python handlers behind the vendored navigation-api tests,
// reimplemented: each entry names the .py file it stands for.
export default ({ stash, setHeaders }) => {
	const send = (res, status, headers, body) => {
		res.statusCode = status;
		setHeaders(res, headers);
		res.end(body);
	};
	const NO_STORE = ['Cache-Control', 'no-cache, no-store, must-revalidate'];
	return {
		handlers: {
			// an empty page a second late, never kept
			'/navigation-api/navigation-methods/resources/slow-no-store.py': async (
				req,
				res,
			) => {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				send(res, 200, [NO_STORE], '');
			},
			// a page on the first visit of `key`, a 301 to `remote_origin`'s
			// blank page on every later one
			'/navigation-api/navigate-event/resources/cross-origin-redirect-on-second-visit.py':
				(req, res, url) => {
					const key = `nav-redirect|${url.searchParams.get('key')}`;
					const visited = stash.has(key);
					stash.set(key, true);
					const headers = [
						NO_STORE,
						['Pragma', 'no-cache'],
						['Content-Type', 'text/html'],
					];
					if (!visited) return send(res, 200, headers, 'body');
					send(
						res,
						301,
						[
							...headers,
							[
								'Location',
								`${url.searchParams.get('remote_origin')}/common/blank.html`,
							],
						],
						'redirect_body',
					);
				},
			// a POST with ?action= keeps it under ?id; a GET takes it: no
			// action is the initial page, else a 204, a 205 or a download
			'/navigation-api/navigation-methods/return-value/resources/204-205-download-on-second-visit.py':
				(req, res, url) => {
					const key = `nav-second|${url.searchParams.get('id')}`;
					if (req.method === 'POST') {
						stash.set(key, url.searchParams.get('action'));
						return send(res, 204, [], '');
					}
					if (req.method !== 'GET') return send(res, 400, [], '');
					const action = stash.get(key);
					stash.delete(key);
					if (action === undefined)
						return send(
							res,
							200,
							[
								['Content-Type', 'text/html'],
								['Cache-Control', 'no-store'],
							],
							'initial page',
						);
					if (action === '204') return send(res, 204, [], '');
					if (action === '205') return send(res, 205, [], '');
					if (action === 'download')
						return send(
							res,
							200,
							[
								['Content-Type', 'text/plain'],
								['Content-Disposition', 'attachment'],
							],
							'some text to download',
						);
					send(res, 400, [], '');
				},
		},
	};
};
