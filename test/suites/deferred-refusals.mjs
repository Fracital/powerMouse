// A call whose code is a deferred part of the document bundle
// (src/inject/dom/deferredParts.ts) refuses when the parts cannot be had,
// and never reaches the browser's own API in their place: getUserMedia, a
// position request, Notification.requestPermission, a track's settings and
// constraints, setSinkId, an AudioContext's sinkId, RTCPeerConnection, an
// XHR's misuse and its response document, an identity credential's get and
// disconnect (FedCM), a same-origin download link's click, a form a
// frame submits to its proxied parent, a frame's navigation of another
// window (`w.location = url`); and a call of no function through the
// access API throws the TypeError the call threw (only its wording is a
// part, src/inject/accessFailures.ts); navigator.storage.estimate()
// rejects before the browser is asked (src/inject/storageUsage.ts); a
// Worker's construction throws before the browser's
// (src/inject/workerStart.ts), and so do a WebSocket's and a
// WebSocketStream's (src/inject/bareClient.ts socketStandIns) and a
// fetchLater() call (src/inject/dom/fetchLater.ts); an image in a frame
// no service worker controls keeps its route and loads nothing (its copy
// is a part, src/inject/dom/uncontrolledCopies.ts); an XML document a
// frame loads lands none of its tree (its load is a part,
// src/inject/dom/instructions.ts); a protocol handler's registration throws
// (its checks are a part, src/inject/dom/protocolHandlers.ts). A part is made
// synchronously within the call that needs it, so no page code runs between
// the hook and the part (a download's copy is made after the click went
// through the page, which the browser's own download had been cancelled
// for as it started); what is left to check is the part that throws
// instead.
//
// The tab's documents get, before any script of theirs (and so before the
// inject takes the browser's functions), counting stand-ins for the
// browser's functions behind those calls: the ones that would ask for a
// device, a position, a permission or a credential refuse instead of
// asking. The proxied top then hands a frame under it a parts statement
// that throws (as one of another build, deferred-parts, would hand none),
// and the frame makes the calls: each throws, or rejects where the call
// answers with a promise; an XHR with a document response refuses (its
// open() throws, since the method check is a part too, xhrChecks.ts; a
// request past it fails as on a network error: its error event, no
// document); a download link saves nothing (neither the copy nor the
// browser's download of the route); a form aimed at the frame navigates
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
	'formAimed',
	'navigateOther',
	'estimate',
	'worker',
	'protocolHandler',
	'webSocket',
	'webSocketStream',
	'fetchLater',
];
/** the calls that answer with a promise, which rejects */
const PROMISED = [
	'getUserMedia',
	'requestPermission',
	'setSinkId',
	'applyConstraints',
	'identity',
	'disconnect',
	'estimate',
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
		],
	);
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
	const navigated = await top.evaluate(
		(calls) => window.__child(calls),
		['navigateOther'],
	);
	ok(
		'with the parts, a frame navigates a window of its own',
		navigated.out?.navigateOther?.at === '?moved',
		JSON.stringify(navigated.out?.navigateOther),
	);
	const aimed = await top.evaluate(
		(calls) => window.__child(calls),
		['formAimed'],
	);
	ok(
		'with the parts, a form a frame aims at its parent lands there',
		aimed.out?.formAimed?.landed === '?x=1',
		JSON.stringify(aimed),
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
	const answer = await top.evaluate(
		async ({ name, calls }) => {
			const client = window[name];
			Reflect.defineProperty(client, 'deferredPartsText', {
				configurable: true,
				value: () => '__stompDeferred=function(){throw new Error("no parts")};',
			});
			try {
				return await window.__child(calls);
			} finally {
				Reflect.deleteProperty(client, 'deferredPartsText');
			}
		},
		{
			name,
			calls: [
				...REFUSING,
				'foreignStats',
				'notFunction',
				'blankCopy',
				'xmlLoad',
			],
		},
	);
	const out = answer.out ?? {};
	// the parts' own error; an identity get with STomp's passkey provider
	// in place goes to it, whose part is missing too: it ends as one the
	// user declined (Credentials DECLINED), never at the browser's get
	const refusedPromise = (call) =>
		/^rejected: no parts/.test(out[call]?.promise ?? '') ||
		(call === 'identity' &&
			/^rejected: The operation either timed out or was not allowed/.test(
				out[call]?.promise ?? '',
			));
	// the parts' own error, not one of the browser's after a fall-through
	const refused = (call) =>
		out[call]?.threw === 'no parts' || refusedPromise(call);
	for (const call of REFUSING.filter(
		(call) =>
			!['xmlDocument', 'download', 'formAimed', 'navigateOther'].includes(call),
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
	ok(
		'without the parts, a form a frame aims at its parent navigates nothing, neither the copy nor the browser',
		out.formAimed?.stayed === true,
		JSON.stringify(out.formAimed),
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
	const saved = await downloadsSince(from);
	ok(
		'without the parts, a download link saves nothing, neither the copy nor the route',
		saved.length === 0,
		JSON.stringify(saved),
	);
	ok(
		'without the parts, no call reaches the browser',
		Array.isArray(answer.reached) && answer.reached.length === 0,
		JSON.stringify(answer.reached),
	);
}

await done(browser);
