// What a matched rule does to a request, as Chrome does it:
// ruleset_matcher_base.cc (GetTransformedURL, GetModifiedQuery, the upgrade
// and redirect checks), regex_rules_matcher.cc (regexSubstitution) and
// web_request_api_helpers.cc (ModifyRequestHeadersForAction,
// ModifyResponseHeadersForAction and the conflicts between them).

import type { IndexedHeader, IndexedTransform } from './indexRule';
import { REQUEST_APPEND_DELIMITERS } from './indexRule';
import type { DnrAction } from './types';

/** GetModifiedQuery: null when the query is left as it is */
export function modifiedQuery(
	query: string,
	transform: IndexedTransform,
): string | null {
	const remove = transform.removeParams;
	const add = transform.addOrReplaceParams;
	if (!remove?.length && !add?.length) return null;
	const pending = add ? add.slice() : [];
	const parts: string[] = [];
	let changed = false;
	// net::QueryIterator over url::ExtractQueryKeyValue: `&` separates, the
	// first `=` ends the key, an empty piece is an empty key
	for (let at = 0; at < query.length;) {
		let end = query.indexOf('&', at);
		if (end < 0) end = query.length;
		const piece = query.slice(at, end);
		at = end + 1;
		const equals = piece.indexOf('=');
		const key = equals < 0 ? piece : piece.slice(0, equals);
		const value = equals < 0 ? '' : piece.slice(equals + 1);
		if (remove && binaryHas(remove, key)) {
			changed = true;
			continue;
		}
		const replace = pending.findIndex((pair) => pair.key === key);
		if (replace < 0) {
			parts.push(`${key}=${value}`);
			continue;
		}
		changed = true;
		parts.push(`${key}=${pending[replace].value}`);
		pending.splice(replace, 1);
	}
	for (const pair of pending)
		if (!pair.replaceOnly) {
			parts.push(`${pair.key}=${pair.value}`);
			changed = true;
		}
	return changed ? parts.join('&') : null;
}

function binaryHas(sorted: string[], key: string): boolean {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (sorted[middle] < key) low = middle + 1;
		else high = middle;
	}
	return low < sorted.length && sorted[low] === key;
}

/**
 * GetTransformedURL: GURL::ReplaceComponents, as a URL put back together
 * from its parts and parsed again (a scheme can change across the special
 * and the others, which WHATWG's setters refuse and GURL allows). Null for
 * an invalid result
 */
export function transformUrl(
	url: URL,
	transform: IndexedTransform,
): string | null {
	const scheme = transform.scheme ?? url.protocol.slice(0, -1);
	const username = transform.username ?? url.username;
	const password = transform.password ?? url.password;
	const host = transform.host ?? url.hostname;
	const port = transform.clearPort ? '' : (transform.port ?? url.port);
	let path = transform.clearPath ? '' : (transform.path ?? url.pathname);
	if (path && path[0] !== '/') path = `/${path}`;
	// a replaced component is canonicalized as that component (GURL's
	// ReplaceComponents), never reparsed as a URL: what would end it is escaped
	if (transform.path !== undefined && !transform.clearPath)
		path = path.replace(/[ ?#]/g, (c) =>
			c === ' ' ? '%20' : c === '?' ? '%3F' : '%23',
		);
	let query: string | null;
	if (transform.clearQuery) query = null;
	else if (transform.query !== undefined)
		query = transform.query.replace(/#/g, '%23');
	else {
		// the URL's own query: "?" alone is an empty one, kept as it is
		const own = url.search
			? url.search.slice(1)
			: url.href.slice(0, url.href.length - url.hash.length).endsWith('?')
				? ''
				: null;
		const modified = modifiedQuery(own ?? '', transform);
		query = modified === null ? own : modified === '' ? null : modified;
	}
	let fragment: string | null;
	if (transform.clearFragment) fragment = null;
	else if (transform.fragment !== undefined) fragment = transform.fragment;
	else fragment = url.hash ? url.hash.slice(1) : null;
	const userinfo =
		username || password ? `${username}${password ? `:${password}` : ''}@` : '';
	const text = `${scheme}://${userinfo}${host}${port ? `:${port}` : ''}${path}${
		query !== null ? `?${query}` : ''
	}${fragment !== null ? `#${fragment}` : ''}`;
	try {
		return new URL(text).href;
	} catch {
		return null;
	}
}

/** GetUpgradedUrl: http and ftp go to https, the rest of the URL kept */
export function upgradeUrl(url: URL): string | null {
	if (url.protocol !== 'http:' && url.protocol !== 'ftp:') return null;
	try {
		return new URL(`https:${url.href.slice(url.protocol.length)}`).href;
	} catch {
		return null;
	}
}

/** a header list the request goes out with, in the order it has */
export interface HeaderList {
	get(name: string): string | null;
	has(name: string): boolean;
	set(name: string, value: string): void;
	delete(name: string): void;
}

/** a response's header lines, as net::HttpResponseHeaders keeps them (repeats and order) */
export type HeaderLines = [name: string, value: string][];

/** the first DNR operation on each header, for webRequest's conflicts with it (dnr_header_actions) */
export type HeaderOps = Map<
	string,
	{ operation: IndexedHeader['operation']; extensionId: string }[]
>;

function conflicts(
	first: { operation: IndexedHeader['operation']; extensionId: string },
	next: IndexedHeader,
	extensionId: string,
) {
	switch (first.operation) {
		case 'append':
			return next.operation !== 'append';
		case 'set':
			return first.extensionId !== extensionId || next.operation !== 'append';
		default:
			return true;
	}
}

export interface RequestHeaderResult {
	/** the actions that changed something, which count as matched */
	applied: DnrAction[];
	ops: HeaderOps;
	removed: Set<string>;
	set: Set<string>;
}

/** MergeOnBeforeSendHeadersResponses's DNR part: actions in their order, highest first */
export function applyRequestHeaders(
	headers: HeaderList,
	actions: DnrAction[],
): RequestHeaderResult {
	const ops: HeaderOps = new Map();
	const removed = new Set<string>();
	const set = new Set<string>();
	const applied: DnrAction[] = [];
	for (const action of actions) {
		if (!action.requestHeaders) continue;
		let modified = false;
		for (const info of action.requestHeaders as IndexedHeader[]) {
			const header = info.header;
			const existing = ops.get(header);
			if (existing && conflicts(existing[0], info, action.extensionId))
				continue;
			const entry = {
				operation: info.operation,
				extensionId: action.extensionId,
			};
			if (existing) existing.push(entry);
			else ops.set(header, [entry]);
			if (info.operation === 'remove') {
				if (headers.has(header)) {
					headers.delete(header);
					removed.add(header);
					modified = true;
				}
				continue;
			}
			const current = headers.get(header);
			const value =
				current !== null && info.operation === 'append'
					? `${current}${REQUEST_APPEND_DELIMITERS[header]}${info.value}`
					: info.value!;
			headers.set(header, value);
			set.add(header);
			modified = true;
		}
		if (modified) applied.push(action);
	}
	return { applied, ops, removed, set };
}

export interface ResponseHeaderResult {
	applied: DnrAction[];
	ops: HeaderOps;
	/** null when no header changed */
	lines: HeaderLines | null;
}

/** MergeOnHeadersReceivedResponses's DNR part, on the response's header lines */
export function applyResponseHeaders(
	original: HeaderLines,
	actions: DnrAction[],
	hidden?: (header: string) => boolean,
): ResponseHeaderResult {
	const ops: HeaderOps = new Map();
	const applied: DnrAction[] = [];
	let lines: HeaderLines | null = null;
	const current = () => lines ?? original;
	const has = (header: string) =>
		current().some(([name]) => name.toLowerCase() === header);
	const remove = (header: string) => {
		lines = current().filter(([name]) => name.toLowerCase() !== header);
	};
	for (const action of actions) {
		if (!action.responseHeaders) continue;
		let modified = false;
		for (const info of action.responseHeaders as IndexedHeader[]) {
			const header = info.header;
			if (hidden?.(header)) continue;
			const existing = ops.get(header);
			if (existing && conflicts(existing[0], info, action.extensionId))
				continue;
			const entry = {
				operation: info.operation,
				extensionId: action.extensionId,
			};
			if (existing) existing.push(entry);
			else ops.set(header, [entry]);
			if (info.operation === 'remove') {
				if (has(header)) {
					remove(header);
					modified = true;
				}
			} else {
				if (info.operation === 'set') remove(header);
				lines = [...current(), [header, info.value!]];
				modified = true;
			}
		}
		if (modified) applied.push(action);
	}
	return { applied, ops, lines };
}
