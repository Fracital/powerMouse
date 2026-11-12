// What the stack may negotiate (docs/webrtc-over-wisp.md, section 16): the
// codecs and header extensions of this browser, read from an offer its own
// RTCPeerConnection wrote (the template: the page's stand-in asks a native
// connection for one once per document and never sets it anywhere). So the
// payload types, the format parameters and the extension ids a peer sees
// are this Chrome's, whichever version it is, and nothing here is a table
// of them.
import { all, parseSdp } from './sdp';

/**
 * Audio the worker can neither encode nor decode, which is therefore not
 * offered: WebCodecs has no G.722.
 */
const NOT_CARRIED = new Set(['g722']);

/** the stack's `codecs` and `exts` configuration fields */
export interface Formats {
	codecs: string;
	exts: string;
}

/**
 * A template offer as the stack's configuration: its `a=rtpmap` and
 * `a=fmtp` lines as `pt,name,clock,channels,fmtp` entries in the offer's
 * order, and its `a=extmap` lines as `id:uri` entries. null for an offer
 * without audio or video (a browser that would not make one).
 */
export function stackFormats(template: string): Formats | null {
	const codecs: string[] = [];
	const exts: string[] = [];
	const payloads = new Set<string>();
	const ids = new Set<string>();
	for (const media of parseSdp(template).medias) {
		if (media.kind !== 'audio' && media.kind !== 'video') continue;
		const maps = new Map<string, string>();
		for (const value of all(media.attributes, 'rtpmap')) {
			const at = value.indexOf(' ');
			if (at !== -1) maps.set(value.slice(0, at), value.slice(at + 1).trim());
		}
		const parameters = new Map<string, string>();
		for (const value of all(media.attributes, 'fmtp')) {
			const at = value.indexOf(' ');
			if (at !== -1)
				parameters.set(value.slice(0, at), value.slice(at + 1).trim());
		}
		for (const pt of media.formats) {
			const map = maps.get(pt);
			if (!map || payloads.has(pt)) continue;
			const [name, clock, channels = ''] = map.split('/');
			if (NOT_CARRIED.has(name.toLowerCase())) continue;
			payloads.add(pt);
			codecs.push(
				`${pt},${name},${clock},${channels},${parameters.get(pt) ?? ''}`,
			);
		}
		for (const value of all(media.attributes, 'extmap')) {
			// `id[/direction] uri [attributes]`
			const [id, uri] = value.split(' ');
			const number = id.split('/')[0];
			if (!uri || ids.has(number)) continue;
			ids.add(number);
			exts.push(`${number}:${uri}`);
		}
	}
	if (!codecs.length) return null;
	return { codecs: codecs.join('|'), exts: exts.join('|') };
}

/** a payload a section negotiated */
export interface Payload {
	pt: number;
	/** the codec's name as SDP writes it (`opus`, `PCMU`, `VP8`) */
	name: string;
	/** the clock the stack counts the payload's frames in */
	clock: number;
	channels: number;
	/** the `a=fmtp` parameters, by name */
	parameters: Record<string, string>;
}

/** an `a=fmtp` value's `name=value` parameters */
export function parseParameters(fmtp: string): Record<string, string> {
	const parameters: Record<string, string> = Object.create(null);
	for (const part of fmtp.split(';')) {
		const at = part.indexOf('=');
		if (at !== -1)
			parameters[part.slice(0, at).trim()] = part.slice(at + 1).trim();
	}
	return parameters;
}

/** the stack's `payloads` list (`pt,name,clock,channels,fmtp` entries) */
export function parsePayloads(list: string): Payload[] {
	const out: Payload[] = [];
	for (const entry of list.split('|')) {
		if (!entry) continue;
		const parts = entry.split(',');
		out.push({
			pt: Number(parts[0]),
			name: parts[1] ?? '',
			clock: Number(parts[2]) || 0,
			channels: Number(parts[3]) || 1,
			parameters: parseParameters(parts.slice(4).join(',')),
		});
	}
	return out;
}
