// src/rewriteHTML.ts as the access API uses it, for the differential harness:
// the route of a document another window is navigated to, which here only
// has to be told from the URL the page wrote (test/differential/harness.mjs
// reads it back with `unrouted`).
export const ROUTED = 'routed:';

export function routeHTML(resource: { url: URL } | URL | string): string {
	const url = (resource as { url?: URL }).url ?? resource;
	return ROUTED + String(url);
}
