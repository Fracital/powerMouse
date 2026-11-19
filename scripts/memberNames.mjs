// The names of the inject's own members that the bundles carry short
// (build.js `common`, esbuild's mangleProps): methods and getters of the
// clients (src/inject/Client.ts, src/inject/dom/Client.ts,
// src/inject/worker/Client.ts), of the modules and of the DOM hooks'
// CustomElement, which no page reaches and nothing reads by a string. The
// document bundle wrote `.wrapFunction(` some 350 times and `.getModule(`
// some 140, and these names took about 14 KB of it.
//
// Every bundle and deferred part of one build gives each the same short
// name (memberCache), so a part handed the bundle's client, a frame that
// reads its parent's client and the controller that reads a frame's agree.
// A name is listed only when it is a member of those classes alone and
// never data (no object literal's or class field's value: an instance's
// own fields are what a structured clone or a stored record keeps, and a
// page's or a host's options are read by their names), in no browser
// interface (TypeScript's lib files), in no string of the sources (a read
// by a computed name would miss it) and in no test, demo or bench file (a
// test that reads a client's member by its name would read nothing). A
// production build fails on a listed name left in a bundle (checkMembers,
// build.js): that is a read by the name, and the name comes off the list.
//
// Most used first: the first 64 have names of two characters.
export const MEMBERS = [
	'wrapFunction',
	'getModule',
	'baseHref',
	'useAttributes',
	'getAttributeOG',
	'sandboxedOpaque',
	'setAttributeOG',
	'restoreAttributesOG',
	'encodingParse',
	'newRestricted',
	'trustedValue',
	'nestedRoute',
	'originKey',
	'hasAttributeOG',
	'removeAttributeOG',
	'updateAttributeHooks',
	'routedClient',
	'pagePolicies',
	'scriptNonce',
	'slotMark',
	'trustedTypesRequired',
	'pageRefusals',
	'attributeTab',
	'standInClass',
	'namedBase',
	'codeEval',
	'jsonAPI',
	'onServiceWorkerMessage',
	'controlledClient',
	'styleElement',
	'ownCallback',
	'mirrorClass',
	'postToHost',
	'prepareStyleText',
	'restrictOpaque',
	'hooksAttribute',
	'reportRefusal',
	'giveCodeNonce',
	'parentClient',
	'refusalURL',
	'tryJsonAPI',
	'styleKind',
	'requestTransportPort',
	'credentiallessNonce',
	'reportTrustedTypes',
	'reportTrustedSink',
	'heldCanvasTaints',
	'scriptPrepared',
	'codeEnforced',
	'mirrorSource',
	'holdModules',
	'refusedURI',
	'onType',
	'hideSharedArrayBuffer',
	'reportTrustedPolicy',
	'activationGatesPart',
	'nativeFrameElement',
	'refuseInlineScript',
	'dispatchLoadError',
	'prepareScriptText',
	'prewrittenScript',
	'restrictFunction',
	'mirrorAttributes',
	'transportClient',
	'restrictContext',
	'isolationFacts',
	'noteImportMap',
	'legacyEncoder',
	'abortRequest',
	'canvasTaints',
	'cookieAverse',
	'targetAllows',
	'pageLocation',
	'hookContext',
	'hopPolicies',
	'styleOfText',
	'pageCookies',
	'opaqueLoads',
	'syncBridge',
	'orderLike',
	'runHook',
	'refuseExternalScript',
	'emulatesFingerprint',
	'refuseInlineStyle',
	'trustedScriptText',
	'reportHookError',
	'browserPolicies',
	'notifyResponse',
	'noteCodeSample',
	'refreshSandbox',
	'pagePolicyText',
	'restrictObject',
	'attributeHooks',
	'releaseScript',
	'childRouteFor',
	'hasFrameNamed',
	'openerClient',
	'laterModules',
	'moduleHolder',
	'guardScripts',
	'codeBaseURL',
	'groupClient',
	'scriptsHeld',
	'baseRefused',
	'scriptValue',
	'readbackURL',
	'loadSource',
	'referrerOf',
	'frameNamed',
	'openInHost',
	'hookGetter',
	'runsHooks',
	'siteKeyed',
	'makeBare',
	'hookJSON',
	'callIn',
	'atBase',
	'provisionWorkerTransport',
	'provisionPortTransport',
	'noteSynchronousRequest',
	'prewrittenStyleSource',
	'onServiceWorkerEvent',
	'refuseStyleAttribute',
	'rewriteInlineScripts',
	'refuseExternalStyle',
	'updatePropertyHooks',
	'applyMeasuredMemory',
	'connectInheritance',
	'rewriterLightText',
	'scriptAwaits',
	'applyScriptSource',
	'applyErrorReports',
	'ownTransportPort',
	'activationPartOf',
	'applyPerformance',
	'applyErrorStacks',
	'applyAttributes',
	'requestModules',
	'connectRefusal',
	'visitedContext',
	'deliveryOrigin',
	'serializeStyle',
	'noteReportSite',
	'noteChildLoad',
	'expectModules',
	'workerModules',
	'refuseHandler',
	'hookResponses',
	'recordWrites',
	'applyReports',
	'innerHTMLOf',
	'exposeNames',
	'bindNatives',
	'codeSample',
	'metaPolicy',
	'holdScript',
	'scriptHeld',
	'invalidate',
	'userMedia',
	'applyURLs',
	'importIn',
	'getAttributeNamesOG',
	'setDocumentDomain',
	'socketRefusal',
	'parsedScripts',
	'takeWrites',
	'callerSite',
	'connectVerdict',
	'releaseHeld',
	'emulate',
	'pendingForeign',
	'bundleOrigin',
];

const CHARACTERS =
	'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$';

/**
 * esbuild's mangleCache for MEMBERS: each name's short one, `$` and one
 * character, then `$` and two (no source of a bundle has a property named
 * so: shortNamesTaken)
 */
export function memberCache() {
	const cache = {};
	const count = CHARACTERS.length;
	MEMBERS.forEach((name, index) => {
		cache[name] =
			index < count
				? `$${CHARACTERS[index]}`
				: `$${CHARACTERS[Math.floor(index / count) - 1]}${CHARACTERS[index % count]}`;
	});
	return cache;
}

/** esbuild's mangleProps for MEMBERS: exactly those names */
export const memberPattern = new RegExp(`^(?:${MEMBERS.join('|')})$`);

/**
 * The listed names a built bundle's text still holds: in a string or as a
 * quoted key, something reads the member by its name
 */
export const namesLeft = (text) =>
	MEMBERS.filter((name) =>
		new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(text),
	);

/**
 * The short names (memberCache) a source a bundle is built from has as a
 * property or a key of its own, which would be two members' name
 */
export function shortNamesTaken(text) {
	const short = new Set(Object.values(memberCache()));
	const taken = new Set();
	for (const [, name] of text.matchAll(
		/(?:(?<!\.)\.|[{,]\s*)(\$[\w$]{1,2})(?![\w${])/g,
	))
		if (short.has(name)) taken.add(name);
	return [...taken];
}
