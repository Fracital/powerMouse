// A call whose code is a deferred part of the document bundle
// (src/inject/dom/deferredParts.ts) refuses when the parts cannot be had,
// and never reaches the browser's own API in their place: getUserMedia, a
// position request, Notification.requestPermission, a track's settings and
// constraints, setSinkId, an AudioContext's sinkId, RTCPeerConnection, an
// XHR's misuse and its response document, an identity credential's get and
// disconnect (FedCM), a same-origin download link's click, a form a
// frame submits to its proxied parent (its submit event, or submit()) and
// a link it clicks aimed there, a link and a form's submit() aimed by name
// at a frame on its initial about:blank, a sandboxed frame's write of a
// part of its parent's location, a frame's navigation of another
// window (`w.location = url`); and a call of no function through the
// access API throws the TypeError the call threw (only its wording is a
// part, src/inject/accessFailures.ts); navigator.storage.estimate()
// rejects before the browser is asked (src/inject/storageUsage.ts); a
// Worker's construction throws before the browser's
// (src/inject/workerStart.ts), and so do a WebSocket's and a
// WebSocketStream's (src/inject/bareClient.ts socketStandIns) and a
// fetchLater() call (src/inject/dom/fetchLater.ts), and an array method
// called with a window as its receiver (src/inject/windowArrays.ts) and
// Origin.from() (src/inject/originFrom.ts), and caches.match() and a
// cache's add() reject before the browser's caches are asked
// (src/inject/cacheCalls.ts), and a tainted source as a VideoFrame, a WebGL
// texture or an OffscreenCanvas's export, or a tainted ImageBitmap cloned,
// refuses with the parts' own error instead of Chrome's
// (src/inject/dom/taintRefusals.ts), and navigator.login.setStatus()
// rejects (src/inject/dom/credentialFlows.ts); an
// image in a frame
// no service worker controls keeps its route and loads nothing (its copy
// is a part, src/inject/dom/uncontrolledCopies.ts); an XML document a
// frame loads lands none of its tree (its load is a part,
// src/inject/dom/instructions.ts); a protocol handler's registration throws
// (its checks are a part, src/inject/dom/protocolHandlers.ts); execCommand's
// insertHTML and Range's createContextualFragment throw before the browser
// parses the markup, and so do setHTML, setHTMLUnsafe and getHTML on an
// element of a frame on its initial about:blank, which its creator's
// bundle hooks (src/inject/dom/markupSinks.ts); window.open() throws
// and opens nothing (src/inject/dom/windowOpen.ts); under a policy of the
// page's own that allows them, an eval throws, and an inline script and an
// inline style the page inserts run and apply nothing, and a frame it
// refuses still loads nothing (the policy's checks are a part,
// src/inject/dom/policyChecks.ts), in a frame sandboxed to an opaque origin
// too, which makes the checks itself from its top's text, and runs none of
// its markup's code under a header policy that governs code, nor applies
// its styles (and so where its top has no text to give, the case of a top
// of another build, and the file it reads instead cannot be had); a
// document the page makes in a frame whose shell is a part
// (src/htmlShell.ts: an srcdoc, a javascript: URL's markup; a data: frame, src/inject/dom/rareAttributes.ts) is never given
// to the frame, unrewritten or at all, an <object>'s HTML document (its
// load is a part, src/inject/dom/objectLoads.ts, and its copy's shell that
// part too) fails as a failed fetch does natively, an
// error and no document, and a refresh meta has no content
// for the browser; a base a report-only base-uri refuses is refused, its
// report being a part. A part is made synchronously within the call that
// needs it, so no page code runs between the hook and the part (a
// download's copy is made after the click went through the page, which the
// browser's own download had been cancelled for as it started); what is
// left to check is the part that throws instead.
// (performance.measureUserAgentSpecificMemory(), which only a cross-origin
// isolated page has, is checked the same way by measured-memory, under an
// isolated host.)
//
// The tab's documents get, before any script of theirs (and so before the
// inject takes the browser's functions), counting stand-ins for the
// browser's functions behind those calls: the ones that would ask for a
// device, a position, a permission or a credential refuse instead of
// asking. The proxied top then hands a frame under it a parts statement
// that throws (as one of another build, deferred-parts, would hand none),
// and the frame makes the calls: each throws, or rejects where the call
// answers with a promise; an XHR with a document response refuses (its
// open() of a method that needs a check throws, since the check is a part
// too, xhrChecks.ts; a GET needs none, and the request fails as on a
// network error: its error event, no document); a download link saves
// nothing (neither the copy nor the browser's download of the route); a
// form aimed at the frame navigates
// nothing (neither the copy nor the browser's own submission); and no
// stand-in counted a call. The same frame with the parts counts the calls
// that do reach the browser (a track's settings, the XHR document's
// request), gets FedCM's answers, saves the download and lands where the
// form went, so neither count is vacuous.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/deferred-refusals.html`;
/**
 * The calls the page's own policy judges (a meta the child inserts first,
 * which allows the code and refuses the frame: the checks are a deferred
 * part, src/inject/dom/policyChecks.ts), made last: an eval, an inline
 * script and style, a frame. (A synchronous request's and a WebSocket's checks are
 * reached only past parts of their own, xhrChecks.ts and bareClient.ts)
 */
const POLICED = ['cspEval', 'cspScript', 'cspStyle', 'cspFrame'];
/**
 * What a frame sandboxed to an opaque origin under a header policy that
 * governs code ran (test/pages/deferred-refusals-opaque.html): what it
 * posted, and read in the frame (`name`), whether its markup's scripts ran
 * and its styles apply
 */
async function opaqueOutcome(page, answer) {
	const { name, posted } = answer ?? {};
	const frame = page
		.frames()
		.reverse()
		.find((frame) => frame.name() === name);
	const read = await frame
		?.evaluate(() => ({
			allowedRan: window.__allowedRan === true,
			refusedRan: window.__refusedRan === true,
			allowed: getComputedStyle(document.getElementById('allowed')).color,
			refused: getComputedStyle(document.getElementById('refused')).color,
		}))
		.catch((error) => ({ error: String(error) }));
	return { posted, read: read ?? null };
}
/** an opaque frame's outcome (opaqueOutcome) as its policy has it */
const opaqueAsAllowed = ({ posted, read }) =>
	posted?.refusedRan === false &&
	posted.eval === 2 &&
	posted.allowed === 'rgb(1, 2, 3)' &&
	posted.refused !== 'rgb(4, 5, 6)' &&
	read?.allowedRan === true &&
	read.refusedRan === false;
/** an opaque frame's outcome where its checks refuse: no script ran, no style applies */
const opaqueRefused = ({ posted, read }) =>
	posted === null &&
	read?.allowedRan === false &&
	read.refusedRan === false &&
	typeof read.allowed === 'string' &&
	read.allowed !== 'rgb(1, 2, 3)' &&
	read.refused !== 'rgb(4, 5, 6)';
/** the policed calls' outcome as the child's policy has it (`out` their answers) */
const policedAsAllowed = (out) =>
	out?.cspEval?.returned === 'number' &&
	out.cspScript?.ran === true &&
	out.cspStyle?.color === 'rgb(1, 2, 3)' &&
	out.cspFrame?.title === null;
/** the policed calls' outcome where their checks refuse (`error` the eval's) */
const policedRefused = (out, error) =>
	out?.cspEval?.threw === error &&
	out.cspScript?.ran === false &&
	typeof out.cspStyle?.color === 'string' &&
	out.cspStyle.color !== 'rgb(1, 2, 3)' &&
	out.cspFrame?.title === null;
const REFUSING = [
	'getUserMedia',
	'getCurrentPosition',
	'watchPosition',
	'requestPermission',
	'getSettings',
	'applyConstraints',
	'setSinkId',
	'audioContext',
	'peer',
	'peerSubclass',
	'peerReflect',
	'webkitPeer',
	'misuse',
	'xmlDocument',
	'identity',
	'disconnect',
	'download',
	'blankLink',
	'blankSubmit',
	'sandboxedHash',
	'navigateOther',
	'estimate',
	'worker',
	'protocolHandler',
	'webSocket',
	'webSocketStream',
	'fetchLater',
	'windowArray',
	'originFrom',
	'cacheMatch',
	'cacheAdd',
	'taintVideoFrame',
	'taintTexture',
	'taintExport',
	'loginStatus',
	'execCommand',
	'contextualFragment',
	'open',
];
/**
 * the documents a frame of the child is given whose code is a part, asked
 * on their own (each waits a while for what does not come)
 */
const DOCUMENTS = [
	'srcdoc',
	'javascriptDocument',
	'dataFrame',
	'refresh',
	'freshFrame',
];
/**
 * an <object>'s HTML document, untyped and typed, in a child of its own (it
 * waits a while for each object)
 */
const OBJECT = ['objectDocument', 'typedObjectDocument'];
/**
 * the refusing calls that navigate the child itself unless refused, each
 * made in a child of its own: one let through would answer for the others
 */
const AIMED = ['formAimed', 'submitAimed', 'linkAimed'];
/** the calls that answer with a promise, which rejects */
const PROMISED = [
	'getUserMedia',
	'requestPermission',
	'setSinkId',
	'applyConstraints',
	'identity',
	'disconnect',
	'estimate',
	'cacheMatch',
	'cacheAdd',
	'taintVideoFrame',
	'taintTexture',
	'taintExport',
	'loginStatus',
];

/** counting stand-ins for the browser's functions, in every document */
function countNatives() {
	const reached = (window.__nativeReached = []);
	const refuse = (name) =>
		function () {
			reached.push(name);
			return Promise.reject(new Error('the browser was asked'));
		};
	const counted = (name, native) =>
		function (...args) {
			reached.push(name);
			return Reflect.apply(native, this, args);
		};
	const constructs = (name, Native) =>
		new Proxy(Native, {
			construct(target, args, newTarget) {
				reached.push(name);
				return Reflect.construct(target, args, newTarget);
			},
		});
	if (window.MediaDevices)
		MediaDevices.prototype.getUserMedia = refuse('getUserMedia');
	if (window.Geolocation) {
		Geolocation.prototype.getCurrentPosition = function () {
			reached.push('getCurrentPosition');
		};
		Geolocation.prototype.watchPosition = function () {
			reached.push('watchPosition');
			return 0;
		};
	}
	if (window.Notification)
		Notification.requestPermission = refuse('requestPermission');
	if (window.HTMLMediaElement)
		HTMLMediaElement.prototype.setSinkId = refuse('setSinkId');
	if (window.AudioContext) {
		AudioContext.prototype.setSinkId = refuse('setSinkId');
		window.AudioContext = constructs('AudioContext', AudioContext);
	}
	if (window.MediaStreamTrack) {
		const prototype = MediaStreamTrack.prototype;
		for (const name of ['getSettings', 'applyConstraints'])
			prototype[name] = counted(name, prototype[name]);
	}
	if (window.Worker) window.Worker = constructs('Worker', Worker);
	if (Navigator.prototype.registerProtocolHandler)
		Navigator.prototype.registerProtocolHandler = function () {
			reached.push('registerProtocolHandler');
		};
	if (window.WebSocket)
		window.WebSocket = constructs('WebSocket', window.WebSocket);
	if (window.WebSocketStream)
		window.WebSocketStream = constructs(
			'WebSocketStream',
			window.WebSocketStream,
		);
	if (window.fetchLater)
		window.fetchLater = counted('fetchLater', window.fetchLater);
	Array.prototype.at = counted('arrayAt', Array.prototype.at);
	if (window.Origin?.from) Origin.from = counted('originFrom', Origin.from);
	// (each refuses a tainting source with the parts too: neither is
	// counted either way)
	if (window.VideoFrame)
		window.VideoFrame = constructs('VideoFrame', window.VideoFrame);
	if (window.WebGLRenderingContext) {
		const prototype = WebGLRenderingContext.prototype;
		prototype.texImage2D = counted('texImage2D', prototype.texImage2D);
	}
	if (window.NavigatorLogin)
		NavigatorLogin.prototype.setStatus = refuse('setStatus');
	if (window.CacheStorage) {
		CacheStorage.prototype.keys = counted(
			'cacheKeys',
			CacheStorage.prototype.keys,
		);
		Cache.prototype.put = counted('cachePut', Cache.prototype.put);
	}
	Document.prototype.execCommand = counted(
		'execCommand',
		Document.prototype.execCommand,
	);
	Range.prototype.createContextualFragment = counted(
		'createContextualFragment',
		Range.prototype.createContextualFragment,
	);
	// (opens nothing: the page gets null, as from a popup blocker)
	window.open = function () {
		reached.push('open');
		return null;
	};
	if (window.StorageManager) {
		const prototype = StorageManager.prototype;
		prototype.estimate = counted('estimate', prototype.estimate);
	}
	if (window.RTCPeerConnection)
		window.RTCPeerConnection = constructs(
			'RTCPeerConnection',
			RTCPeerConnection,
		);
	if (window.CredentialsContainer) {
		const identityGet = refuse('credentialsGet');
		// only an identity request is FedCM's: the passkeys part asks the
		// browser's get which members it reads, with an object that names
		// none, and reaches no authenticator
		CredentialsContainer.prototype.get = function (options) {
			if (options?.identity !== undefined) return identityGet();
			return Promise.reject(new Error('the browser was asked'));
		};
	}
	if (window.IdentityCredential)
		IdentityCredential.disconnect = refuse('disconnect');
	// a document's markup the page made that reaches the browser as it is:
	// an srcdoc, or a frame's data: URL, with no shell (`createClient` is in
	// every shell's script)
	const raw = (name, value) =>
		((/^srcdoc$/i.test(name) ||
			(/^src$/i.test(name) && /^\s*data:text\/html/i.test(value))) &&
			!value.includes('createClient')) ||
		// (and a refresh meta's content, unrouted)
		(/^content$/i.test(name) && /url=deferred-refusals-landed/.test(value));
	const setAttribute = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (name, value) {
		if (raw(String(name), String(value))) reached.push('rawDocument');
		return Reflect.apply(setAttribute, this, [name, value]);
	};
	const setAttributeNS = Element.prototype.setAttributeNS;
	Element.prototype.setAttributeNS = function (namespace, name, value) {
		if (raw(String(name), String(value))) reached.push('rawDocument');
		return Reflect.apply(setAttributeNS, this, [namespace, name, value]);
	};
	// the realm's own request the inject makes a response document with
	const open = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (...args) {
		const url = String(args[1]);
		if (url.startsWith('data:') || url.includes('/echo/'))
			reached.push('xhrDocument');
		return Reflect.apply(open, this, args);
	};
}

const browser = await launch();
const page = await openDemo(browser, PROXY);
await page.addInitScript(countNatives);
// a download the browser starts, the proxy's copy or its own of the route
const downloads = [];
page.on('download', (download) => downloads.push(download.suggestedFilename()));
/** the downloads started since `from`, once a click's copy had time to land */
const downloadsSince = async (from) => {
	await sleep(1500);
	return downloads.slice(from);
};
await submitLanding(page, target);
const top = await waitActive(page, `typeof window.__child === 'function'`);
const name = await page.evaluate(() => window.controller.config.names.client);

// with the parts: what reaches the browser is counted
{
	const from = downloads.length;
	const answer = await top.evaluate(
		(calls) => window.__child(calls),
		[
			'getSettings',
			'xmlDocument',
			'identity',
			'disconnect',
			'download',
			'notFunction',
			'estimate',
			'worker',
			'blankCopy',
			'xmlLoad',
			'protocolHandler',
			'webSocket',
			'webSocketStream',
			'fetchLater',
			'windowArray',
			'originFrom',
			'cacheMatch',
			'cacheAdd',
			'taintVideoFrame',
			'taintTexture',
			'taintExport',
			'taintClone',
			'loginStatus',
			'execCommand',
			'contextualFragment',
			'blankSetHTML',
			'open',
			// (before the policed calls: their policy refuses frames)
			'cspOpaque',
			...POLICED,
		],
	);
	const opaque = await opaqueOutcome(page, answer.out?.cspOpaque);
	const opaqueChild = await top.evaluate(
		(calls) => window.__child(calls, 'allow-scripts'),
		POLICED,
	);
	const documents = await top.evaluate(
		(calls) => window.__child(calls),
		DOCUMENTS,
	);
	const object = await top.evaluate((calls) => window.__child(calls), OBJECT);
	ok(
		'with the parts, the counting stand-ins see the calls that reach the browser',
		answer.out?.getSettings?.returned === 'object' &&
			answer.out?.xmlDocument?.document === '[object XMLDocument]' &&
			answer.reached?.includes('getSettings') &&
			answer.reached?.includes('xhrDocument'),
		JSON.stringify(answer),
	);
	ok(
		'with the parts, an image in a frame no service worker controls loads its copy',
		answer.out?.blankCopy?.loaded === true,
		JSON.stringify(answer.out?.blankCopy),
	);
	for (const call of ['srcdoc', 'javascriptDocument'])
		ok(
			`with the parts, a document the page makes (${call}) runs in its shell`,
			documents.out?.[call]?.ran === 'injected' &&
				Array.isArray(documents.reached) &&
				documents.reached.length === 0,
			JSON.stringify({
				out: documents.out?.[call],
				reached: documents.reached,
			}),
		);
	ok(
		'with the parts, an XML document a frame loads lands its tree',
		answer.out?.xmlLoad?.root === 'svg' && answer.out.xmlLoad.landed === true,
		JSON.stringify(answer.out?.xmlLoad),
	);
	ok(
		'with the parts, a protocol handler is accepted, without the browser',
		answer.out?.protocolHandler?.returned === 'undefined' &&
			!answer.reached?.includes('registerProtocolHandler'),
		JSON.stringify({
			out: answer.out?.protocolHandler,
			reached: answer.reached,
		}),
	);
	ok(
		'with the parts, a data: frame shows its document',
		documents.out?.dataFrame?.ran === 'data',
		JSON.stringify(documents.out?.dataFrame),
	);
	ok(
		'with the parts, a refresh meta a script inserts refreshes its frame',
		documents.out?.refresh?.refreshed === true,
		JSON.stringify(documents.out?.refresh),
	);
	ok(
		'with the parts, a frame of this origin sent to another lands there, in a fresh context',
		documents.out?.freshFrame?.landed?.join() === '?first,?fresh' &&
			documents.out.freshFrame.threw === null,
		JSON.stringify(documents.out?.freshFrame),
	);
	const based = await top.evaluate(() => window.__baseIn());
	ok(
		'with the parts, a base a report-only base-uri refuses applies and is reported once',
		based.baseURI === 'https://base.example/based/' &&
			based.events?.length === 1 &&
			based.events[0] === 'base-uri https://base.example/based/ report',
		JSON.stringify(based),
	);
	ok(
		'with the parts, a worker starts, through the browser',
		answer.out?.worker?.returned === 'object' &&
			answer.reached?.includes('Worker'),
		JSON.stringify({ out: answer.out?.worker, reached: answer.reached }),
	);
	// a URL the browser refuses (a fragment): its own SyntaxError, from its
	// own constructor, through the stand-in's part
	ok(
		"with the parts, a WebSocket and a WebSocketStream to a URL the browser refuses get the browser's error, from its constructor",
		/SyntaxError|is invalid|fragment/i.test(
			answer.out?.webSocket?.threw ?? '',
		) &&
			/SyntaxError|is invalid|fragment/i.test(
				answer.out?.webSocketStream?.threw ?? '',
			) &&
			answer.reached?.filter((name) => name === 'WebSocket').length === 2 &&
			!answer.reached?.includes('WebSocketStream'),
		JSON.stringify({
			ws: answer.out?.webSocket,
			stream: answer.out?.webSocketStream,
			reached: answer.reached,
		}),
	);
	// a URL fetchLater cannot defer (no http(s)): the browser's own refusal
	ok(
		"with the parts, fetchLater of a data: URL is the browser's own call",
		typeof answer.out?.fetchLater?.threw === 'string' &&
			answer.out.fetchLater.threw !== 'no parts' &&
			answer.reached?.includes('fetchLater'),
		JSON.stringify({ out: answer.out?.fetchLater, reached: answer.reached }),
	);
	ok(
		"with the parts, an array method called with a window as its receiver is the browser's, reading the window's children",
		typeof answer.out?.windowArray?.returned === 'string' &&
			answer.reached?.includes('arrayAt'),
		JSON.stringify({ out: answer.out?.windowArray, reached: answer.reached }),
	);
	ok(
		"with the parts, Origin.from() of a window answers, through the browser's",
		answer.out?.originFrom?.returned === 'object' &&
			answer.reached?.includes('originFrom'),
		JSON.stringify({ out: answer.out?.originFrom, reached: answer.reached }),
	);
	ok(
		"with the parts, caches.match() and a cache's add() answer, through the browser's caches",
		answer.out?.cacheMatch?.promise === 'resolved' &&
			answer.out?.cacheAdd?.promise === 'resolved' &&
			answer.reached?.includes('cacheKeys') &&
			answer.reached?.includes('cachePut'),
		JSON.stringify({
			match: answer.out?.cacheMatch,
			add: answer.out?.cacheAdd,
			reached: answer.reached,
		}),
	);
	// (as natively: Chrome's own words, and no call reaches the browser's
	// constructor or texture)
	for (const [call, words] of [
		['taintVideoFrame', "VideoFrames can't be created from tainted sources"],
		['taintTexture', 'contains cross-origin data, and may not be loaded'],
		['taintExport', 'OffscreenCanvas may not be exported'],
		['taintClone', 'Non-origin-clean ImageBitmap cannot be cloned'],
	])
		ok(
			`with the parts, a tainted source is refused as natively (${call})`,
			(answer.out?.[call]?.promise ?? '').includes(words) ||
				(call === 'taintTexture' &&
					answer.out?.[call]?.promise === 'rejected: no webgl'),
			JSON.stringify(answer.out?.[call]),
		);
	ok(
		"with the parts, a tainted source reaches no VideoFrame or texture of the browser's",
		!answer.reached?.some((name) =>
			['VideoFrame', 'texImage2D'].includes(name),
		),
		JSON.stringify(answer.reached),
	);
	ok(
		'with the parts, navigator.login.setStatus() answers, without the browser',
		answer.out?.loginStatus?.promise === 'resolved' &&
			!answer.reached?.includes('setStatus'),
		JSON.stringify({ out: answer.out?.loginStatus, reached: answer.reached }),
	);
	ok(
		"with the parts, execCommand's insertHTML and createContextualFragment reach the browser",
		answer.out?.execCommand?.returned === 'boolean' &&
			answer.out?.contextualFragment?.returned === 'object' &&
			answer.reached?.includes('execCommand') &&
			answer.reached?.includes('createContextualFragment'),
		JSON.stringify({
			execCommand: answer.out?.execCommand,
			contextualFragment: answer.out?.contextualFragment,
			reached: answer.reached,
		}),
	);
	// (the default sanitizer leaves the <b>; setHTMLUnsafe the <b> and the
	// <img>. The frame's initial about:blank gets no counting stand-ins: the
	// parsed nodes are what reached the browser's parser)
	ok(
		'with the parts, setHTML, setHTMLUnsafe and getHTML on an element of a frame on its initial about:blank parse and serialize',
		answer.out?.blankSetHTML?.setHTML?.returned === true &&
			answer.out.blankSetHTML.setHTMLUnsafe?.returned === true &&
			answer.out.blankSetHTML.getHTML?.returned === 'string' &&
			answer.out.blankSetHTML.parsed === 2,
		JSON.stringify(answer.out?.blankSetHTML),
	);
	// as natively: its script runs, one load, the document shown
	for (const [call, landed] of [
		['objectDocument', '?object'],
		['typedObjectDocument', '?typed-object'],
	])
		ok(
			`with the parts, an <object>'s HTML document loads in its shell, as natively (${call})`,
			object.out?.[call]?.landed === landed &&
				object.out[call].events?.join() === 'load' &&
				object.out[call].shown === 'deferred refusals landed' &&
				Array.isArray(object.reached) &&
				object.reached.length === 0,
			JSON.stringify(object),
		);
	ok(
		'with the parts, window.open() reaches the browser',
		answer.out?.open?.returned === 'object' && answer.reached?.includes('open'),
		JSON.stringify({ out: answer.out?.open, reached: answer.reached }),
	);
	ok(
		'with the parts, an estimate answers, through the browser',
		answer.out?.estimate?.promise === 'resolved' &&
			answer.reached?.includes('estimate'),
		JSON.stringify({ out: answer.out?.estimate, reached: answer.reached }),
	);
	ok(
		"with the parts, a call of no function names the page's expression",
		answer.out?.notFunction?.threw === 'o[k] is not a function',
		JSON.stringify(answer.out?.notFunction),
	);
	ok(
		"with the parts, what the page's own policy allows runs and applies, and the frame it refuses loads nothing",
		policedAsAllowed(answer.out),
		JSON.stringify(POLICED.map((call) => answer.out?.[call])),
	);
	ok(
		'with the parts, a frame sandboxed to an opaque origin runs and applies what its own header policy allows, and nothing else',
		opaqueAsAllowed(opaque),
		JSON.stringify(opaque),
	);
	ok(
		"with the parts, in a frame sandboxed to an opaque origin, what the page's own policy allows runs and applies",
		policedAsAllowed(opaqueChild.out),
		JSON.stringify(opaqueChild),
	);
	const navigated = await top.evaluate(
		(calls) => window.__child(calls),
		['navigateOther'],
	);
	ok(
		'with the parts, a frame navigates a window of its own',
		navigated.out?.navigateOther?.at === '?moved',
		JSON.stringify(navigated.out?.navigateOther),
	);
	// (each navigates the child: the page it lands on answers)
	for (const [call, landed, what] of [
		['formAimed', '?x=1', 'a form a frame aims at its parent'],
		['submitAimed', '?y=2', 'a form a frame aims at its parent, by submit(),'],
		['linkAimed', '?link', 'a link a frame aims at its parent'],
	]) {
		const aimed = await top.evaluate((calls) => window.__child(calls), [call]);
		ok(
			`with the parts, ${what} lands there`,
			aimed.landed === landed,
			JSON.stringify(aimed),
		);
	}
	const blank = await top.evaluate(
		(calls) => window.__child(calls),
		['blankLink', 'blankSubmit', 'sandboxedHash'],
	);
	ok(
		'with the parts, a link and a form aimed by name at a frame on its initial about:blank land there',
		blank.out?.blankLink?.inFrame === '?blank' &&
			blank.out?.blankSubmit?.inFrame === '?z=3' &&
			blank.out.blankSubmit.threw === null,
		JSON.stringify(blank.out),
	);
	ok(
		"with the parts, a sandboxed frame's write of its parent's location hash throws the SecurityError and navigates nothing",
		/^SecurityError: Failed to set a named property 'hash' on 'Location': The current window does not have permission to navigate the target frame/.test(
			blank.out?.sandboxedHash?.threw ?? '',
		) && blank.out.sandboxedHash.moved === false,
		JSON.stringify(blank.out?.sandboxedHash),
	);
	// FedCM's protocol answers (the browser's get is never asked for an
	// identity, with the parts or without)
	const answered = (call) =>
		/^rejected: (?!no parts|pending)/.test(answer.out?.[call]?.promise ?? '');
	ok(
		"with the parts, FedCM's protocol answers an identity get and a disconnect",
		answered('identity') &&
			answered('disconnect') &&
			!answer.reached?.includes('credentialsGet') &&
			!answer.reached?.includes('disconnect'),
		JSON.stringify(answer.out),
	);
	const saved = await downloadsSince(from);
	ok(
		'with the parts, a download link saves its copy',
		saved.length === 1 && saved[0] === 'refusals.html',
		JSON.stringify(saved),
	);
}

// without them: every call refuses, and nothing reaches the browser
{
	const from = downloads.length;
	const without = (calls, sandbox) =>
		top.evaluate(
			async ({ name, calls, sandbox }) => {
				const client = window[name];
				Reflect.defineProperty(client, 'deferredPartsText', {
					configurable: true,
					value: () =>
						'__stompDeferred=function(){throw new Error("no parts")};',
				});
				try {
					return await window.__child(calls, sandbox);
				} finally {
					Reflect.deleteProperty(client, 'deferredPartsText');
				}
			},
			{ name, calls, sandbox },
		);
	// (the frame loads with the parts, its base is given without them)
	const based = await top.evaluate(
		(name) =>
			window
				.__baseIn(() =>
					Reflect.defineProperty(window[name], 'deferredPartsText', {
						configurable: true,
						value: () =>
							'__stompDeferred=function(){throw new Error("no parts")};',
					}),
				)
				.finally(() =>
					Reflect.deleteProperty(window[name], 'deferredPartsText'),
				),
		name,
	);
	const answer = await without([
		...REFUSING,
		'foreignStats',
		'notFunction',
		'blankCopy',
		'xmlLoad',
		'blankSetHTML',
		'cspOpaque',
		...POLICED,
	]);
	const opaque = await opaqueOutcome(page, answer.out?.cspOpaque);
	const opaqueChild = await without(POLICED, 'allow-scripts');
	const documents = await without(DOCUMENTS);
	// an object's own load is a navigation of its context, which no
	// service worker sees: one to an http(s) URL reached a server (the
	// copy's fetch, the page's load of the resource, goes as the page's).
	// The object's context is the child's frame: the demo's, the proxied
	// top's, the child's, then its own
	const objectNavigations = [];
	const objectNavigation = (request) => {
		try {
			let depth = 0;
			for (let frame = request.frame(); frame.parentFrame(); depth++)
				frame = frame.parentFrame();
			if (
				depth === 3 &&
				request.isNavigationRequest() &&
				/^https?:/.test(request.url())
			)
				objectNavigations.push(request.url());
		} catch (error) {
			// a frame already gone
		}
	};
	page.on('request', objectNavigation);
	const object = await without(OBJECT);
	page.off('request', objectNavigation);
	const out = { ...answer.out, ...documents.out, ...object.out };
	// (a child that was navigated answers with the page it landed on)
	for (const call of AIMED) {
		const aimed = await without([call]);
		out[call] = aimed.out?.[call] ?? aimed;
	}
	// the parts' own error; an identity get with STomp's passkey provider
	// in place goes to it, whose part is missing too: it ends as one the
	// user declined (Credentials DECLINED), never at the browser's get
	const refusedPromise = (call) =>
		/^rejected: no parts/.test(out[call]?.promise ?? '') ||
		// (a browser without WebGL has no texture to refuse)
		(call === 'taintTexture' && out[call]?.promise === 'rejected: no webgl') ||
		(call === 'identity' &&
			/^rejected: The operation either timed out or was not allowed/.test(
				out[call]?.promise ?? '',
			));
	// the parts' own error, not one of the browser's after a fall-through
	const refused = (call) =>
		out[call]?.threw === 'no parts' || refusedPromise(call);
	for (const call of REFUSING.filter(
		(call) =>
			![
				'xmlDocument',
				'download',
				'blankLink',
				'blankSubmit',
				'sandboxedHash',
				'navigateOther',
			].includes(call),
	))
		ok(
			`without the parts, ${call} refuses${
				PROMISED.includes(call) ? ' with a rejected promise' : ''
			}`,
			PROMISED.includes(call)
				? refusedPromise(call)
				: refused(call) || (call === 'webkitPeer' && out[call]?.absent),
			JSON.stringify(out[call]),
		);
	ok(
		'without the parts, an XHR document response refuses, with no document',
		out.xmlDocument?.threw === 'no parts' ||
			(out.xmlDocument?.document === 'null' &&
				out.xmlDocument.events.join() === 'error,loadend'),
		JSON.stringify(out.xmlDocument),
	);
	ok(
		'without the parts, a WebRTC member on an object no connection made answers as the browser does',
		/^rejected: .*Illegal invocation|^rejected: .*not of type/.test(
			out.foreignStats?.promise ?? '',
		) || /Illegal invocation/.test(out.foreignStats?.threw ?? ''),
		JSON.stringify(out.foreignStats),
	);
	// the frame gets no document of the markup: an srcdoc is not set, a
	// javascript: URL throws in the frame (its document stays)
	ok(
		'without the parts, an srcdoc is refused: the frame gets no srcdoc',
		out.srcdoc?.ran === false && out.srcdoc.srcdoc === false,
		JSON.stringify(out.srcdoc),
	);
	ok(
		"without the parts, a javascript: URL's markup is refused: the frame keeps its document",
		out.javascriptDocument?.ran === false,
		JSON.stringify(out.javascriptDocument),
	);
	ok(
		'without the parts, a data: frame is refused: it is not navigated',
		out.dataFrame?.ran === false,
		JSON.stringify(out.dataFrame),
	);
	// as a failed fetch natively: an error, no document, nothing of the
	// page's markup run (never the markup as written, never one without
	// its shell), and nothing more asked of any server
	for (const call of ['objectDocument', 'typedObjectDocument'])
		ok(
			`without the parts, an <object>'s HTML document is refused: an error and no document, as a failed fetch (${call})`,
			out[call]?.landed === null &&
				out[call].events?.join() === 'error' &&
				out[call].shown === null,
			JSON.stringify(out[call]),
		);
	ok(
		"without the parts, an <object>'s context loads nothing of a server's",
		objectNavigations.length === 0,
		JSON.stringify(objectNavigations),
	);
	ok(
		'without the parts, setHTML, setHTMLUnsafe and getHTML on an element of a frame on its initial about:blank throw, and nothing is parsed',
		out.blankSetHTML?.setHTML?.threw === 'no parts' &&
			out.blankSetHTML.setHTMLUnsafe?.threw === 'no parts' &&
			out.blankSetHTML.getHTML?.threw === 'no parts' &&
			out.blankSetHTML.parsed === 0,
		JSON.stringify(out.blankSetHTML),
	);
	ok(
		'without the parts, a refresh meta is refused: its frame stays',
		out.refresh?.stayed === true,
		JSON.stringify(out.refresh),
	);
	ok(
		'without the parts, a frame of this origin sent to another is refused: it is not navigated',
		out.freshFrame?.landed?.join() === '?first' &&
			out.freshFrame.threw === null,
		JSON.stringify(out.freshFrame),
	);
	// as an enforced base-uri refuses it: the browser refuses its refusal
	// URL, and nothing reports the page's own base
	// it applies to nothing: the document's base URL is its own
	ok(
		'without the parts, a base a report-only base-uri refuses is refused and not reported',
		Array.isArray(based.events) &&
			!based.events.some((event) => event.includes('base.example')) &&
			based.baseURI === based.documentURL,
		JSON.stringify(based),
	);
	ok(
		'without the parts, a form a frame aims at its parent navigates nothing, neither the copy nor the browser',
		out.formAimed?.stayed === true,
		JSON.stringify(out.formAimed),
	);
	ok(
		"without the parts, a frame's submit() of a form aimed at its parent throws and navigates nothing",
		out.submitAimed?.stayed === true && out.submitAimed.threw === 'no parts',
		JSON.stringify(out.submitAimed),
	);
	ok(
		'without the parts, a link a frame aims at its parent navigates nothing, neither the window nor the browser',
		out.linkAimed?.stayed === true,
		JSON.stringify(out.linkAimed),
	);
	ok(
		'without the parts, a link aimed by name at a frame on its initial about:blank navigates nothing',
		out.blankLink?.stayed === true && out.blankLink.at === 'about:blank',
		JSON.stringify(out.blankLink),
	);
	ok(
		'without the parts, a submit() aimed by name at a frame on its initial about:blank throws and navigates nothing',
		out.blankSubmit?.stayed === true &&
			out.blankSubmit.threw === 'no parts' &&
			out.blankSubmit.at === 'about:blank',
		JSON.stringify(out.blankSubmit),
	);
	ok(
		"without the parts, a sandboxed frame's write of its parent's location hash throws and navigates nothing",
		out.sandboxedHash?.threw === 'Error: no parts' &&
			out.sandboxedHash.moved === false,
		JSON.stringify(out.sandboxedHash),
	);
	ok(
		'without the parts, a navigation of another window throws and navigates nothing',
		out.navigateOther?.threw === 'no parts' && out.navigateOther?.at === '',
		JSON.stringify(out.navigateOther),
	);
	// no copy: the image keeps its route, which fails from the proxy
	// origin's own server, as a failed copy does, and nothing is thrown
	ok(
		'without the parts, an image in a frame no service worker controls loads nothing',
		out.blankCopy?.loaded === false,
		JSON.stringify(out.blankCopy),
	);
	// the shell's call throws: none of the document's tree lands
	ok(
		'without the parts, an XML document a frame loads lands nothing',
		out.xmlLoad?.root === 'svg' && out.xmlLoad.landed === false,
		JSON.stringify(out.xmlLoad),
	);
	// the part only words the error: without it, the error the call threw
	ok(
		'without the parts, a call of no function throws the TypeError of the call',
		typeof out.notFunction?.threw === 'string' &&
			out.notFunction.threw !== 'no parts' &&
			/not a function|was called on/.test(out.notFunction.threw),
		JSON.stringify(out.notFunction),
	);
	// the page's own policy's checks: each refuses (an eval throws, an
	// inline script and style run and apply nothing, and the refused frame
	// still loads nothing), never lets the code through
	ok(
		"without the parts, an eval under the page's own policy throws",
		out.cspEval?.threw === 'no parts',
		JSON.stringify(out.cspEval),
	);
	ok(
		"without the parts, an inline script under the page's own policy runs nothing",
		out.cspScript?.ran === false,
		JSON.stringify(out.cspScript),
	);
	ok(
		"without the parts, an inline style under the page's own policy applies nothing",
		typeof out.cspStyle?.color === 'string' &&
			out.cspStyle.color !== 'rgb(1, 2, 3)',
		JSON.stringify(out.cspStyle),
	);
	ok(
		"without the parts, a frame the page's own policy refuses loads nothing",
		out.cspFrame?.title === null,
		JSON.stringify(out.cspFrame),
	);
	// a frame sandboxed to an opaque origin takes its parts from its top as
	// text too, and refuses alike
	ok(
		'without the parts, a frame sandboxed to an opaque origin under a header policy that governs code runs none of its scripts and applies none of its styles',
		opaqueRefused(opaque),
		JSON.stringify(opaque),
	);
	ok(
		"without the parts, in a frame sandboxed to an opaque origin, an eval under the page's own policy throws, and an inline script and style run and apply nothing",
		policedRefused(opaqueChild.out, 'no parts'),
		JSON.stringify(opaqueChild),
	);
	const saved = await downloadsSince(from);
	ok(
		'without the parts, a download link saves nothing, neither the copy nor the route',
		saved.length === 0,
		JSON.stringify(saved),
	);
	ok(
		'without the parts, no call reaches the browser',
		Array.isArray(answer.reached) &&
			answer.reached.length === 0 &&
			Array.isArray(documents.reached) &&
			documents.reached.length === 0 &&
			Array.isArray(object.reached) &&
			object.reached.length === 0,
		JSON.stringify([answer.reached, documents.reached, object.reached]),
	);
}

// a frame whose top has no text to give (one of another build, as
// deferred-parts has it) reads the rewriter library's file itself: an
// opaque frame under a code policy reads it at its first script, and with
// the file answered as gone (the test's own route, no page reaches it) its
// checks refuse as without the parts
{
	const LIBRARY = /\/rewriterLib\.js(\?|$)/;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.enable');
	const asked = [];
	cdp.on('Network.requestWillBeSent', ({ request }) => {
		if (LIBRARY.test(request.url)) asked.push(request.url);
	});
	const unshared = (calls, sandbox) =>
		top.evaluate(
			async ({ name, calls, sandbox }) => {
				const client = window[name];
				Reflect.defineProperty(client, 'deferredPartsText', {
					configurable: true,
					value: () => null,
				});
				try {
					return await window.__child(calls, sandbox);
				} finally {
					Reflect.deleteProperty(client, 'deferredPartsText');
				}
			},
			{ name, calls, sandbox },
		);
	const read = await unshared(['cspOpaque']);
	const opaque = await opaqueOutcome(page, read.out?.cspOpaque);
	const opaqueChild = await unshared(POLICED, 'allow-scripts');
	ok(
		'under a top with no parts to give, the frames read the file, and one sandboxed to an opaque origin runs what its policy allows',
		asked.length > 0 &&
			opaqueAsAllowed(opaque) &&
			policedAsAllowed(opaqueChild.out),
		JSON.stringify({ asked: asked.length, opaque, opaqueChild }),
	);
	await page
		.context()
		.route(LIBRARY, (route) => route.fulfill({ status: 404, body: '' }));
	const gone = await unshared(['cspOpaque']);
	const goneOpaque = await opaqueOutcome(page, gone.out?.cspOpaque);
	const goneChild = await unshared(POLICED, 'allow-scripts');
	await page.context().unroute(LIBRARY);
	await cdp.detach().catch(() => {});
	ok(
		'under a top with no parts to give, where the file cannot be had, a frame sandboxed to an opaque origin under a header policy that governs code runs none of its scripts and applies none of its styles',
		opaqueRefused(goneOpaque),
		JSON.stringify(goneOpaque),
	);
	ok(
		"under a top with no parts to give, where the file cannot be had, in a frame sandboxed to an opaque origin, an eval under the page's own policy throws, and an inline script and style run and apply nothing",
		policedRefused(
			goneChild.out,
			'Stomp: the rewriter library did not load (HTTP 404)',
		),
		JSON.stringify(goneChild),
	);
}

await done(browser);
