// The rewrite area's dynamic routes (bench/lib/fixture.mjs): the corpus
// (bench/lib/scripts.mjs) as `/rewrite/scripts/<id>.js` and its list as
// `/rewrite/scripts.json` (`[{ id, bytes, module }]`), both no-store, from
// ensureScripts' list handed over as `ctx.rewriteScripts` (or `ctx.scripts`).
import { sendFile } from '../../lib/fixture.mjs';
import { manifest } from '../../lib/scripts.mjs';

const listOf = (ctx) => {
	const given = ctx.rewriteScripts ?? ctx.scripts;
	return Array.isArray(given) ? given : [];
};

export function handle(req, res, ctx) {
	const { pathname } = new URL(req.url, 'http://x');
	if (pathname === '/rewrite/scripts.json') {
		const body = JSON.stringify(manifest(listOf(ctx)));
		res.writeHead(200, {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body),
			'Cache-Control': 'no-store',
		});
		res.end(body);
		return true;
	}
	const match = /^\/rewrite\/scripts\/([a-z0-9-]+)\.js$/.exec(pathname);
	if (!match) return false;
	const entry = listOf(ctx).find((script) => script.id === match[1]);
	if (!entry) return false;
	sendFile(res, entry.file);
	return true;
}
