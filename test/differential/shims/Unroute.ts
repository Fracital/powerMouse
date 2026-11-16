// src/inject/modules/Unroute.ts as the access API uses it, for the
// differential harness: an import's failure names the URL the harness
// routed it to, which is the page's own.
export function unrouteText(_client: unknown, text: string): string {
	return text;
}
