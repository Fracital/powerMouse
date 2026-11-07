import GenericCodec from './Codecs';
import { assetName, type Config } from './config';
import StompURL from './StompURL';

export const ROUTE_PROTOCOLS = ['http:', 'https:'];

export function routeURL(resourceType: string, url: StompURL) {
	if (!ROUTE_PROTOCOLS.includes(url.url.protocol)) {
		// url is out of the scope of Stomp
		return url.toString();
	}

	return `${url.directory}${resourceType}/${url.encode()}`;
}

/**
 * Raw binary data
 */
export function routeBinary(resource: StompURL) {
	if (resource.url.protocol === 'data:') {
		return resource.toString();
	}

	return routeURL('binary', resource);
}

/**
 * navigator.postBeacon request
 */
export function routeXHR(resource: StompURL) {
	if (resource.url.protocol === 'data:') {
		return resource.toString();
	}

	return routeURL('xhr', resource);
}

export function injectDocumentJS(url: StompURL, config?: Config) {
	return `${url.directory}${assetName(config?.assets, 'injectDocument')}`;
}

export function injectWorkerJS(url: StompURL, config?: Config) {
	return `${url.directory}${assetName(config?.assets, 'injectWorker')}`;
}

export function geckoXHR(url: StompURL) {
	return `${url.directory}gxhr`;
}

export function queueXHR(url: StompURL) {
	return `${url.directory}xhr`;
}

/*
// url will not be unrouted
// always store original url
 export function unrouteBinary(url) {
	if (url.url.protocol === 'data:') {
		return url.toString();
	}

	return parseRoutedURL()
}*/

export interface ParsedRoutedURL {
	resource: string;
	url: StompURL;
}

export function parseRoutedURL(
	routed: string,
	codec: GenericCodec,
	directory: string,
): ParsedRoutedURL {
	if (!routed.startsWith(directory)) {
		throw new Error('Outside directory');
	}

	const hashIndex = routed.indexOf('#');

	const path =
		hashIndex === -1
			? routed.slice(directory.length)
			: routed.slice(directory.length, hashIndex);

	const split = path.indexOf('/');

	if (split === -1) {
		throw new Error('Invalid route');
	}

	const resource = path.slice(0, split);
	const encoded = path.slice(split + 1);
	const decoded = codec.decode(encoded);
	const url = new URL(decoded);

	url.hash = hashIndex === -1 ? '' : routed.slice(hashIndex);

	return {
		resource: resource,
		url: new StompURL(url, codec, directory),
	};
}

export declare interface DataURI {
	attributes: string[];
	mime: string;
	data: string;
}

export function parseDataURI(pathname: string): DataURI {
	const comma = pathname.indexOf(',');
	const type = pathname.slice(0, comma);
	let data = pathname.slice(comma + 1);
	const [mime, ...attributes] = type.split(';');

	if (attributes.includes('base64')) {
		// the bytes are text (a script, a document, a stylesheet) in UTF-8;
		// atob alone gives one character per byte and mangles anything beyond
		// Latin-1
		const binary = atob(data);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		data = new TextDecoder().decode(bytes);
	} else {
		// RFC 2397 bodies are percent-encoded (Reddit ships scripts as
		// data:text/javascript,%7B...); the parser needs the real text
		try {
			data = decodeURIComponent(data);
		} catch {
			// not valid percent-encoding, keep the raw body
		}
	}

	return {
		mime,
		attributes,
		data,
	};
}

export function createDataURI(data: DataURI) {
	return `data:${[data.mime, ...data.attributes].join(';')},${
		data.attributes.includes('base64')
			? btoa(
					Array.from(new TextEncoder().encode(data.data), (byte) =>
						String.fromCharCode(byte),
					).join(''),
				)
			: encodeURIComponent(data.data)
	}`;
}
