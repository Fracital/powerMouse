// Build-time stand-in for crypto-js in the lite inject bundles
// (injectDocumentLite, injectWorkerLite in build.js). Those bundles are
// served to the xor and generic codecs, which never touch crypto-js: the
// AES and Base64 codecs (src/Codecs.ts) are the only readers, and the
// service worker hands a document or worker the full bundle whenever its
// codec is aes or base64 (src/routeURL.ts). So nothing here is ever reached
// at run time; it exists only to keep crypto-js (about 19 KB of the document
// bundle, 38 KB of the worker's, plus its import-time lookup tables, roughly
// 40 KB of heap and 167 KB of resident memory per proxied frame as measured)
// out of the bundle the common deployment evaluates in every frame.
//
// Every access, call or construction throws, so a bundle that somehow routed
// an aes or base64 codec to the lite file fails loudly at the first seal
// rather than mis-routing a URL. crypto-js is imported only through its
// default export in Codecs.ts, so a single throwing Proxy covers AES, the
// Base64 and Utf8 encoders and MD5 alike.
const unavailable = (): never => {
	throw new Error(
		'Stomp: the lite inject bundle carries no crypto codec; the aes and base64 codecs need the full bundle',
	);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub: any = new Proxy(function () {}, {
	get: unavailable,
	apply: unavailable,
	construct: unavailable,
});

export default stub;
