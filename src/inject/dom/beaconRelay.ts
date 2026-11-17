// A beacon of a document no service worker controls, sent through its
// nearest controlled ancestor (src/inject/dom/modules/Navigator.ts): what the
// browser would send and count against the document's quota. A deferred part
// (./deferred.ts): most documents send no beacon, and few of those are
// uncontrolled. Its top level reads no global (./deferredParts.ts).

/** the beacon bytes Chrome lets a document have in flight at once */
const BEACON_QUOTA = 65536;
// the body types that keep a beacon a no-cors request (the CORS-safelisted
// Content-Types); any other makes it a cors request with a preflight
const SAFELISTED_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
];
const utf8Length = (text: string) =>
	text.length > BEACON_QUOTA
		? text.length
		: new TextEncoder().encode(text).length;

/**
 * About what a FormData weighs once the browser has written it as
 * multipart/form-data (Chrome's 38-character boundary): the quota counts
 * the encoded body, which only the browser makes
 */
function formDataLength(data: FormData): number {
	// "--" + boundary + CRLF, the Content-Disposition line with its quotes,
	// the blank line, and the CRLF after the value
	const perPart = 40 + 2 + 38 + 1 + 4 + 2;
	// the closing "--" + boundary + "--" + CRLF
	let length = 44;
	data.forEach((value, name) => {
		length +=
			perPart + utf8Length(name) + 2 * (name.match(/[\r\n"]/g)?.length ?? 0);
		if (typeof value === 'string')
			length += utf8Length(value.replace(/\r\n|\r|\n/g, '\r\n'));
		else
			length +=
				// `; filename=""`, CRLF, `Content-Type: `
				13 +
				utf8Length(value.name) +
				2 +
				14 +
				(value.type || 'application/octet-stream').length +
				value.size;
	});
	return length;
}

/**
 * A beacon's payload as the browser would send it: the body, the bytes it
 * counts against the quota and the Content-Type it gets. Null for a payload
 * the browser refuses (a stream, a shared buffer), which is left to it.
 */
function beaconPayload(
	data: unknown,
	tagOf: (value: unknown) => string,
): { body: BodyInit | null; size: number; type: string | null } | null {
	if (data === undefined || data === null)
		return { body: null, size: 0, type: null };
	if (typeof data === 'object') {
		const tag = tagOf(data);
		if (tag === 'ReadableStream' || tag === 'SharedArrayBuffer') return null;
		if (ArrayBuffer.isView(data) || tag === 'ArrayBuffer')
			return {
				body: data as BodyInit,
				size: (data as ArrayBuffer).byteLength,
				type: null,
			};
		if (tag === 'Blob' || tag === 'File')
			return {
				body: data as Blob,
				size: (data as Blob).size,
				type: (data as Blob).type || null,
			};
		if (tag === 'FormData')
			return {
				body: data as FormData,
				size: formDataLength(data as FormData),
				type: 'multipart/form-data',
			};
		if (tag === 'URLSearchParams')
			return {
				body: data as URLSearchParams,
				size: utf8Length(String(data)),
				type: 'application/x-www-form-urlencoded;charset=UTF-8',
			};
	}
	const text = String(data);
	return {
		body: text,
		size: utf8Length(text),
		type: 'text/plain;charset=UTF-8',
	};
}

export interface BeaconRelay {
	/** the beacon bytes the document has in flight through an ancestor */
	own: { bytes: number };
	/** the bytes in flight through each controlled ancestor, by its client */
	relayed: WeakMap<object, number>;
	/** the nearest controlled ancestor's client */
	via: object;
	url: string;
	data: unknown;
	/** Object.prototype.toString's tag, as taken before the page ran */
	tagOf: (value: unknown) => string;
	/** a request of the ancestor's (the client's routed fetch) */
	fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Send the beacon as a request of `via`; what sendBeacon answers, or null
 * for a payload the browser refuses (a stream, a shared buffer), which is
 * left to it
 */
export function relayBeacon(relay: BeaconRelay): boolean | null {
	const { own, relayed, via, url, data, tagOf, fetch } = relay;
	const payload = beaconPayload(data, tagOf);
	if (payload === null) return null;
	const { body, size, type } = payload;
	// the quota is the document's own, as natively
	if (own.bytes + size > BEACON_QUOTA) return false;
	// the request outlives both documents while the ancestor's quota has
	// room for it; past that it lives as long as the ancestor does
	const shared = relayed.get(via) ?? 0;
	const keepalive = shared + size <= BEACON_QUOTA;
	own.bytes += size;
	if (keepalive) relayed.set(via, shared + size);
	const settled = () => {
		own.bytes -= size;
		if (keepalive) relayed.set(via, (relayed.get(via) ?? size) - size);
	};
	fetch(url, {
		method: 'POST',
		body,
		mode:
			type === null ||
			SAFELISTED_TYPES.includes(type.split(';')[0].trim().toLowerCase())
				? 'no-cors'
				: 'cors',
		credentials: 'include',
		keepalive,
	}).then((response) => {
		settled();
		// (a beacon's answer is no one's)
		response.body?.cancel().catch(() => {});
	}, settled);
	return true;
}
