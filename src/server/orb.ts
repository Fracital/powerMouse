// Opaque response blocking, as Chrome does it (ORB v0.2: by MIME type and by
// what the first bytes are, without parsing the body as a script). A no-cors
// response of another origin that is HTML, XML or JSON never reaches the
// renderer natively: a <script> that names one fires `error`, where a
// script that merely fails to parse fires `load`. Here every response is
// the worker's to hand over, so the worker decides the same way.
//
// https://github.com/annevk/orb, and Chrome's
// services/network/public/cpp/orb (the CORB sniffers it kept).

const JAVASCRIPT = new Set([
	'application/ecmascript',
	'application/javascript',
	'application/x-ecmascript',
	'application/x-javascript',
	'text/ecmascript',
	'text/javascript',
	'text/javascript1.0',
	'text/javascript1.1',
	'text/javascript1.2',
	'text/javascript1.3',
	'text/javascript1.4',
	'text/javascript1.5',
	'text/jscript',
	'text/livescript',
	'text/x-ecmascript',
	'text/x-javascript',
]);
const SAFELISTED = new Set([
	'text/css',
	'image/svg+xml',
	'application/dash+xml',
	'application/x-mpegurl',
	'application/vnd.apple.mpegurl',
	'text/vtt',
]);
const NEVER_SNIFFED = new Set([
	'application/gzip',
	'application/msexcel',
	'application/mspowerpoint',
	'application/msword',
	'application/msword-template',
	'application/pdf',
	'application/vnd.apple.pkpass',
	'application/x-gzip',
	'application/x-protobuf',
	'application/zip',
	'multipart/byteranges',
	'multipart/signed',
	'text/csv',
	'text/event-stream',
]);
const NEVER_SNIFFED_PREFIXES = [
	'application/vnd.ms-',
	'application/vnd.openxmlformats-officedocument.',
	'application/vnd.ces-quick',
	'application/vnd.presentation-openxml',
	'application/vnd.spreadsheet-openxml',
	'application/vnd.wordprocessing-openxml',
];

type Kind = 'html' | 'xml' | 'json' | 'plain' | 'other';

/** the MIME type's essence, lower case ('' when the header has none) */
function essence(headers: Headers): string {
	return (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}
function kindOf(type: string): Kind {
	if (type === 'text/html') return 'html';
	if (
		type === 'application/json' ||
		type === 'text/json' ||
		type === 'text/x-json' ||
		type.endsWith('+json')
	)
		return 'json';
	if (
		type === 'text/xml' ||
		type === 'application/xml' ||
		type.endsWith('+xml')
	)
		return 'xml';
	if (type === 'text/plain') return 'plain';
	return 'other';
}

/**
 * What the headers alone decide of a no-cors response of another origin:
 * it goes, it is blocked, or its first bytes decide (`orbSniff`).
 */
export function orbByHeaders(
	headers: Headers,
	status: number,
): 'allow' | 'block' | 'sniff' {
	const type = essence(headers);
	if (JAVASCRIPT.has(type) || SAFELISTED.has(type)) return 'allow';
	if (
		NEVER_SNIFFED.has(type) ||
		NEVER_SNIFFED_PREFIXES.some((prefix) => type.startsWith(prefix))
	)
		return 'block';
	const kind = kindOf(type);
	const listed = kind === 'html' || kind === 'xml' || kind === 'json';
	if (status === 206 && listed) return 'block';
	const nosniff =
		headers
			.get('x-content-type-options')
			?.split(',')[0]
			.trim()
			.toLowerCase() === 'nosniff';
	if (nosniff && (listed || kind === 'plain')) return 'block';
	return 'sniff';
}

const starts = (bytes: Uint8Array, ...signature: number[]) =>
	signature.every((byte, index) => byte < 0 || bytes[index] === byte);
/** an image, a sound or a video, by its first bytes */
export function orbMedia(bytes: Uint8Array): boolean {
	return (
		starts(bytes, 0x89, 0x50, 0x4e, 0x47) || // PNG
		starts(bytes, 0xff, 0xd8, 0xff) || // JPEG
		starts(bytes, 0x47, 0x49, 0x46, 0x38) || // GIF
		starts(bytes, 0x42, 0x4d) || // BMP
		starts(bytes, 0x00, 0x00, 0x01, 0x00) || // ICO
		starts(bytes, 0x00, 0x00, 0x02, 0x00) || // CUR
		starts(bytes, 0x52, 0x49, 0x46, 0x46) || // RIFF: WebP, WAV, AVI
		starts(bytes, 0x4f, 0x67, 0x67, 0x53) || // Ogg
		starts(bytes, 0x1a, 0x45, 0xdf, 0xa3) || // WebM, Matroska
		starts(bytes, 0x49, 0x44, 0x33) || // MP3 with ID3
		starts(bytes, 0x66, 0x4c, 0x61, 0x43) || // FLAC
		starts(bytes, -1, -1, -1, -1, 0x66, 0x74, 0x79, 0x70) || // MP4, AVIF
		// an MPEG audio frame (MP3 without ID3, AAC in ADTS): eleven sync
		// bits and a layer; 0xFF 0xFE is UTF-16's byte order mark, not sound
		(bytes[0] === 0xff &&
			(bytes[1] & 0xe0) === 0xe0 &&
			bytes[1] !== 0xfe &&
			bytes[1] !== 0xff)
	);
}

const HTML_TAGS = [
	'<!doctype html',
	'<script',
	'<html',
	'<head',
	'<iframe',
	'<h1',
	'<div',
	'<font',
	'<table',
	'<a',
	'<style',
	'<title',
	'<b',
	'<body',
	'<br',
	'<p',
];
function html(text: string): boolean {
	let rest = text.trimStart();
	// comments before the first tag are skipped
	while (rest.startsWith('<!--')) {
		const end = rest.indexOf('-->');
		if (end < 0) return false;
		rest = rest.slice(end + 3).trimStart();
	}
	const lower = rest.slice(0, 16).toLowerCase();
	return HTML_TAGS.some((tag) => lower.startsWith(tag));
}
const xml = (text: string) => text.trimStart().startsWith('<?xml');
/** an object with a first key: `{ "key" :` */
const json = (text: string) => /^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:/.test(text);
/** the prefixes sites put before JSON so that it is no script */
const FETCH_ONLY = [")]}'", '{}&&', 'for(;;);', 'while(1);'];
const fetchOnly = (text: string) => {
	const compact = text.trimStart().replace(/\s+/g, '').toLowerCase();
	return FETCH_ONLY.some((prefix) => compact.startsWith(prefix));
};

/** whether the first bytes of a response `orbByHeaders` left to them block it */
export function orbSniff(
	headers: Headers,
	status: number,
	head: Uint8Array,
): boolean {
	if (orbMedia(head)) return false;
	if (status < 200 || status > 299) return true;
	const type = essence(headers);
	if (type === '') return false;
	if (/^(?:audio|image|video)\//.test(type)) return true;
	let text = '';
	for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
	// a byte order mark is not content
	text = text.replace(/^(?:\xef\xbb\xbf|\xfe\xff|\xff\xfe)/, '');
	switch (kindOf(type)) {
		case 'html':
			return html(text);
		case 'xml':
			return xml(text);
		case 'json':
			return json(text);
		case 'plain':
			return html(text) || xml(text) || json(text);
		default:
			return json(text) || fetchOnly(text);
	}
}

/** how much of a body the sniffers look at */
export const ORB_SNIFF_BYTES = 1024;

/**
 * The first bytes of a body, and the body again: what was read, then the
 * rest of the stream.
 */
export async function peekBody(
	stream: ReadableStream<Uint8Array>,
	bytes: number,
): Promise<{ head: Uint8Array; body: ReadableStream<Uint8Array> }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let ended = false;
	while (size < bytes) {
		const { done, value } = await reader.read();
		if (done) {
			ended = true;
			break;
		}
		chunks.push(value);
		size += value.byteLength;
	}
	const head = new Uint8Array(Math.min(size, bytes));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= head.length) break;
		head.set(chunk.subarray(0, head.length - offset), offset);
		offset += chunk.byteLength;
	}
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			if (ended) controller.close();
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return { head, body };
}
