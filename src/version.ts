// The build this bundle came from, baked in by esbuild's define: STOMP_BUILD
// (version plus git sha or timestamp, when build.js provides it) or the
// package version. Every bundle carries it; the service worker, the
// controller and the inject bundles compare theirs, because a deploy that
// replaces one without the others fails in ways that look like anything else.
// esbuild replaces these at build time (build.js `define`); there is no
// Node here, so the name is declared for the type checker only
declare const process: { env: Record<string, string | undefined> };

export const BUILD: string =
	(process.env.STOMP_BUILD as string | undefined) ??
	(process.env.STOMP_VERSION as string | undefined) ??
	'dev';
