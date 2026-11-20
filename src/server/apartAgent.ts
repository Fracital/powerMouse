import { APART_ROUTE } from '../isolation';

// The agent of the documents a Document-Isolation-Policy of the proxy's own
// isolates (src/controller/apart.ts): a hidden document of the proxy's
// origin the controller starts, served with that policy so that it is in
// their agent cluster, which reaches them and answers the controller for
// them. Its route answers only a token the controller gave over its own
// channel, once: a page that navigates a frame there gets nothing.

const tokens = new Map<string, string>();
/** how many tokens wait at most (a controller asks for one at a time) */
const KEPT = 8;

/** the controller starts an agent at the route with `token`, which runs `script` */
export function allowApartAgent(token: string, script: string) {
	if (typeof token !== 'string' || !/^[\w-]{16,64}$/.test(token)) return;
	try {
		const url = new URL(script);
		if (url.origin !== location.origin) return;
	} catch (error) {
		return;
	}
	if (tokens.size >= KEPT) tokens.delete(tokens.keys().next().value!);
	tokens.set(token, script);
}

/** the agent's document for the route's `token`, once; null for any other */
export function apartAgentResponse(token: string): Response | null {
	const script = tokens.get(token);
	if (script === undefined) return null;
	tokens.delete(token);
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>STomp</title><script src="${script.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"></script>`,
		{
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				// in the cluster of the documents this policy isolates (either
				// value: two such documents of one origin reach each other)
				'document-isolation-policy': 'isolate-and-credentialless',
			},
		},
	);
}

/** the route's pattern under the scope, with the token as its group */
export const APART_AGENT_PATH = new RegExp(`^/${APART_ROUTE}/([\\w-]{16,64})$`);

// The clients the proxy serves with that policy, by id: an inline document
// one of them registers (an about:blank or javascript: document's copy, a
// data: or blob: document: src/server/inline.ts) is served with it too,
// in their cluster, as natively such a document inherits its creator's
const apartClients = new Set<string>();
const KEPT_CLIENTS = 512;

/** the document the client `id` makes is served with the proxy's Document-Isolation-Policy */
export function rememberApartClient(id: string | undefined) {
	if (!id) return;
	apartClients.delete(id);
	if (apartClients.size >= KEPT_CLIENTS)
		apartClients.delete(apartClients.values().next().value!);
	apartClients.add(id);
}

/** whether any document was served with the proxy's Document-Isolation-Policy (since the worker started) */
export function anyApartClient(): boolean {
	return apartClients.size > 0;
}

/** whether the client `id`'s document was served with the proxy's Document-Isolation-Policy */
export function apartClient(id: string | undefined): boolean {
	return !!id && apartClients.has(id);
}
