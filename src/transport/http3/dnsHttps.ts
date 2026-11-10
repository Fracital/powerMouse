// HTTPS resource records (RFC 9460) over DNS-over-HTTPS (RFC 8484): Chrome
// reads one alongside the A/AAAA lookup and connects with QUIC at once when
// its `alpn` names h3, before any Alt-Svc. A proxied page has no resolver of
// its own, so the query goes to a DoH server through the base transport.

/** what an HTTPS record says about HTTP/3 for the name */
export interface HttpsRecord {
	h3: boolean;
	/** the record's `port`, when it names one */
	port?: number;
	/** seconds the answer may be kept */
	ttl: number;
}

const TYPE_HTTPS = 65;
const KEY_ALPN = 1;
const KEY_PORT = 3;

/** the wire-format query for `name` IN HTTPS, id 0 as RFC 8484 asks */
export function httpsQuery(name: string): Uint8Array {
	const labels = name.replace(/\.$/, '').split('.');
	const out: number[] = [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
	for (const label of labels) {
		const bytes = new TextEncoder().encode(label);
		if (!bytes.length || bytes.length > 63) throw new Error('bad DNS name');
		out.push(bytes.length, ...bytes);
	}
	out.push(0, 0, TYPE_HTTPS, 0, 1);
	return new Uint8Array(out);
}

export function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** offset just past the (possibly compressed) name at `offset` */
function skipName(view: DataView, offset: number): number {
	for (;;) {
		const len = view.getUint8(offset);
		if (len === 0) return offset + 1;
		if ((len & 0xc0) === 0xc0) return offset + 2;
		offset += len + 1;
	}
}

/**
 * The first ServiceMode HTTPS record in a DoH answer, or `null` when there
 * is none (an AliasMode record, or no record at all, names nothing here).
 * A record for the CNAME target the resolver followed counts as the name's.
 */
export function parseHttpsAnswer(message: ArrayBuffer): HttpsRecord | null {
	const view = new DataView(message);
	if (view.byteLength < 12) return null;
	const rcode = view.getUint8(3) & 0x0f;
	if (rcode !== 0) return null;
	const questions = view.getUint16(4);
	const answers = view.getUint16(6);
	let offset = 12;
	for (let i = 0; i < questions; i++) offset = skipName(view, offset) + 4;
	for (let i = 0; i < answers; i++) {
		offset = skipName(view, offset);
		const type = view.getUint16(offset);
		const ttl = view.getUint32(offset + 4);
		const length = view.getUint16(offset + 8);
		const start = offset + 10;
		const end = start + length;
		offset = end;
		if (type !== TYPE_HTTPS || end > view.byteLength) continue;
		const priority = view.getUint16(start);
		if (priority === 0) continue;
		// the target name is never compressed in RDATA (RFC 9460 2.2)
		let at = skipName(view, start + 2);
		const record: HttpsRecord = { h3: false, ttl };
		while (at + 4 <= end) {
			const key = view.getUint16(at);
			const len = view.getUint16(at + 2);
			const value = at + 4;
			if (key === KEY_ALPN) {
				for (let p = value; p < value + len;) {
					const n = view.getUint8(p);
					const id = new TextDecoder().decode(
						new Uint8Array(message, p + 1, n),
					);
					if (id === 'h3') record.h3 = true;
					p += n + 1;
				}
			} else if (key === KEY_PORT && len === 2) {
				record.port = view.getUint16(value);
			}
			at = value + len;
		}
		return record;
	}
	return null;
}
