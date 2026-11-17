// src/inject/modules/Unroute.ts as the access API uses it, for the
// differential harness: an import's failure names the URL the harness
// routed it to, which is the page's own, and so does what a module's
// import.meta.resolve answers.
export function unrouteText(_client: unknown, text: string): string {
	return text;
}
export function unrouteURL(_client: unknown, url: string): string | null {
	return url;
}
export function routedPrefix(_client: unknown): string {
	return '';
}
