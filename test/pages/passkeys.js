// The passkeys suite's page (test/passkeys-rp.mjs serves it on each of its
// names). The same script runs natively, where Chrome's virtual
// authenticator answers, and through the proxy, where STomp's own does:
// every function here returns plain data the suite compares.
//
//   __pk.shapes()            the WebAuthn interfaces as a page reads them
//   __pk.statics()           what the capability statics answer
//   __pk.cases(group)        every malformed or refused request of a group:
//                            how it failed (class, name, message) and when
//   __pk.order(kind)         the members Chrome reads of each dictionary
//   __pk.register(params)    a whole registration against the server
//   __pk.login(params)       a whole sign-in against the server
//   __pk.start(name, params) the same, not waited for: __pk.read(id) has it
//   __pk.arm(name, params)   run it from the click of #go (user activation)
//
// `?id=` names this document for the suite; `?frame=<url>&allow=<list>`
// puts a frame of that URL in it.
(() => {
	const query = new URLSearchParams(location.search);
	const bytesOf = (value) =>
		value instanceof ArrayBuffer
			? new Uint8Array(value)
			: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	const b64url = (value) =>
		value === null || value === undefined
			? value
			: btoa(String.fromCharCode(...bytesOf(value)))
					.replace(/\+/g, '-')
					.replace(/\//g, '_')
					.replace(/=+$/, '');
	const unb64url = (text) =>
		Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
			c.charCodeAt(0),
		);
	const tag = (value) => Object.prototype.toString.call(value);
	const chain = (value) => {
		const names = [];
		for (
			let proto = Object.getPrototypeOf(value);
			proto;
			proto = Object.getPrototypeOf(proto)
		)
			names.push(
				Object.prototype.hasOwnProperty.call(proto, 'constructor')
					? proto.constructor.name
					: '?',
			);
		return names;
	};
	const describeError = (error) => {
		if (error === null || typeof error !== 'object')
			return `thrown ${typeof error}: ${String(error)}`;
		return `${tag(error).slice(8, -1)}/${error.constructor?.name}/${error.name}: ${error.message}`;
	};
	const attempt = (call) => {
		try {
			return call();
		} catch (error) {
			return `threw ${describeError(error)}`;
		}
	};

	/**
	 * How a call ends: `threw` (synchronously), or the promise's outcome with
	 * `phase`: `microtask` when it settled before a zero timer set at the
	 * call (the page's own process answered), `task` when after it
	 */
	async function settle(call, guard = 8000) {
		let timerFired = false;
		setTimeout(() => {
			timerFired = true;
		}, 0);
		const started = performance.now();
		let promise;
		try {
			promise = call();
		} catch (error) {
			return { threw: describeError(error) };
		}
		if (!(promise instanceof Promise))
			return { returned: tag(promise), value: promise };
		const outcome = await Promise.race([
			promise.then(
				(value) => ({ resolved: tag(value), value }),
				(error) => ({ rejected: describeError(error), error }),
			),
			new Promise((resolve) =>
				setTimeout(() => resolve({ pending: true }), guard),
			),
		]);
		return {
			...outcome,
			phase: timerFired ? 'task' : 'microtask',
			ms: Math.round(performance.now() - started),
		};
	}

	// --- what a page reads of the interfaces ---

	const describeFunction = (fn) =>
		typeof fn === 'function'
			? {
					name: fn.name,
					length: fn.length,
					source: Function.prototype.toString.call(fn),
					hasPrototype: Object.prototype.hasOwnProperty.call(fn, 'prototype'),
					proto:
						Object.getPrototypeOf(fn) === Function.prototype
							? 'Function.prototype'
							: (Object.getPrototypeOf(fn)?.name ?? 'other'),
				}
			: typeof fn;
	const describeMembers = (holder) =>
		Reflect.ownKeys(holder).map((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(holder, key);
			return [
				String(key),
				{
					configurable: descriptor.configurable,
					enumerable: descriptor.enumerable,
					...('value' in descriptor
						? {
								writable: descriptor.writable,
								value:
									typeof descriptor.value === 'function'
										? describeFunction(descriptor.value)
										: typeof descriptor.value === 'object'
											? tag(descriptor.value)
											: descriptor.value,
							}
						: {
								get: describeFunction(descriptor.get),
								set: describeFunction(descriptor.set),
							}),
				},
			];
		});
	const INTERFACES = [
		'PublicKeyCredential',
		'AuthenticatorResponse',
		'AuthenticatorAttestationResponse',
		'AuthenticatorAssertionResponse',
		'Credential',
		'CredentialsContainer',
	];
	const shapes = () => {
		const out = {};
		for (const name of INTERFACES) {
			const ctor = window[name];
			const global = Object.getOwnPropertyDescriptor(window, name);
			out[name] = {
				global: global
					? {
							configurable: global.configurable,
							enumerable: global.enumerable,
							writable: global.writable,
							data: 'value' in global,
						}
					: null,
				self: describeFunction(ctor),
				statics: describeMembers(ctor),
				prototype: describeMembers(ctor.prototype),
				parent: Object.getPrototypeOf(ctor.prototype)?.constructor?.name,
				construct: attempt(() => tag(new ctor())),
				call: attempt(() => tag(ctor())),
				illegal: describeMembers(ctor.prototype)
					.filter(([, member]) => member.get || member.value?.source)
					.map(([key]) => [
						key,
						attempt(() => {
							const descriptor = Object.getOwnPropertyDescriptor(
								ctor.prototype,
								key === 'Symbol(Symbol.toStringTag)' ? Symbol.toStringTag : key,
							);
							if (key === 'constructor') return 'skipped';
							const fn = descriptor.get ?? descriptor.value;
							const result = fn.call({});
							// a promise's rejection is the page's to catch
							if (result instanceof Promise) result.catch(() => {});
							return tag(result);
						}),
					]),
			};
		}
		out.windowOrder = (() => {
			const keys = Object.getOwnPropertyNames(window);
			return INTERFACES.map((name) => keys[keys.indexOf(name) - 1]);
		})();
		out.credentials = {
			tag: tag(navigator.credentials),
			same: navigator.credentials === navigator.credentials,
			members: describeMembers(CredentialsContainer.prototype),
		};
		return out;
	};

	// --- the capability statics ---

	const plain = async (call) => {
		const outcome = await settle(call);
		delete outcome.ms;
		delete outcome.error;
		if (outcome.value && typeof outcome.value === 'object')
			outcome.value = Object.fromEntries(Object.entries(outcome.value));
		return outcome;
	};
	const statics = async () => ({
		uvpaa: await plain(() =>
			PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
		),
		conditional: await plain(() =>
			PublicKeyCredential.isConditionalMediationAvailable(),
		),
		capabilities: await plain(() =>
			PublicKeyCredential.getClientCapabilities(),
		),
		detached: {
			uvpaa: await plain(() =>
				(0,
				PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable)(),
			),
			capabilities: await plain(() =>
				PublicKeyCredential.getClientCapabilities.call({}),
			),
		},
	});

	// --- requests ---

	// the other names of the relying party (test/passkeys-rp.mjs), from this one
	const site = /pk\d+-/.exec(location.hostname)?.[0] ?? 'pk0-';
	const HOSTS = {
		a: `${site}a.co.uk`,
		sub: `www.${site}a.co.uk`,
		b: `${site}b.co.uk`,
		ga: `${site}a.github.io`,
		gb: `${site}b.github.io`,
	};
	const challenge = () => crypto.getRandomValues(new Uint8Array(32));
	const creation = (change = {}) => ({
		rp: { name: 'Fixture', ...(change.rp ?? {}) },
		user: {
			id: new Uint8Array([1, 2, 3, 4]),
			name: 'case@fixture',
			displayName: 'Case',
			...(change.user ?? {}),
		},
		challenge: challenge(),
		pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
		timeout: 4000,
		...(change.top ?? {}),
	});
	const request = (change = {}) => ({
		challenge: challenge(),
		timeout: 4000,
		...change,
	});
	const without = (object, key) => {
		const copy = { ...object };
		delete copy[key];
		return copy;
	};
	const create = (publicKey, more = {}) =>
		navigator.credentials.create({ publicKey, ...more });
	const get = (publicKey, more = {}) =>
		navigator.credentials.get({ publicKey, ...more });
	const aborted = (reason) => {
		const controller = new AbortController();
		if (reason === undefined) controller.abort();
		else controller.abort(reason);
		return controller.signal;
	};
	const abortSoon = (ms, reason) => {
		const controller = new AbortController();
		setTimeout(
			() =>
				reason === undefined ? controller.abort() : controller.abort(reason),
			ms,
		);
		return controller.signal;
	};
	const detached = () => {
		const buffer = new ArrayBuffer(16);
		structuredClone(buffer, { transfer: [buffer] });
		return buffer;
	};

	/**
	 * The requests that end without an authenticator's answer, by group. Each
	 * is a function that makes the call; none can leave a request waiting,
	 * so they run one after another.
	 */
	const CASES = {
		// what the bindings refuse: the dictionaries
		createShape: {
			noOptions: () => navigator.credentials.create(),
			emptyOptions: () => navigator.credentials.create({}),
			optionsNull: () => navigator.credentials.create(null),
			optionsNumber: () => navigator.credentials.create(5),
			publicKeyNull: () => navigator.credentials.create({ publicKey: null }),
			publicKeyUndefined: () =>
				navigator.credentials.create({ publicKey: undefined }),
			publicKeyNumber: () => navigator.credentials.create({ publicKey: 5 }),
			publicKeyString: () => navigator.credentials.create({ publicKey: 'x' }),
			publicKeyEmpty: () => create({}),
			publicKeyFunction: () => create(() => {}),
			noRp: () => create(without(creation(), 'rp')),
			noUser: () => create(without(creation(), 'user')),
			noChallenge: () => create(without(creation(), 'challenge')),
			noParams: () => create(without(creation(), 'pubKeyCredParams')),
			rpNumber: () => create({ ...creation(), rp: 5 }),
			rpNull: () => create({ ...creation(), rp: null }),
			rpNoName: () => create({ ...creation(), rp: {} }),
			rpNameNumber: () => create({ ...creation(), rp: { name: 5 } }),
			rpIdNumber: () => create({ ...creation(), rp: { name: 'x', id: 5 } }),
			userNull: () => create({ ...creation(), user: null }),
			userNoId: () =>
				create({ ...creation(), user: { name: 'n', displayName: 'd' } }),
			userNoName: () =>
				create({
					...creation(),
					user: { id: new Uint8Array(4), displayName: 'd' },
				}),
			userNoDisplayName: () =>
				create({ ...creation(), user: { id: new Uint8Array(4), name: 'n' } }),
			userIdString: () => create(creation({ user: { id: 'abcd' } })),
			userIdArray: () => create(creation({ user: { id: [1, 2, 3] } })),
			userIdEmpty: () => create(creation({ user: { id: new Uint8Array(0) } })),
			userId64: () => create(creation({ user: { id: new Uint8Array(64) } })),
			userId65: () => create(creation({ user: { id: new Uint8Array(65) } })),
			userIdDetached: () => create(creation({ user: { id: detached() } })),
			challengeString: () => create({ ...creation(), challenge: 'abc' }),
			challengeArray: () => create({ ...creation(), challenge: [1, 2, 3] }),
			challengeNull: () => create({ ...creation(), challenge: null }),
			challengeDetached: () => create({ ...creation(), challenge: detached() }),
			paramsNumber: () => create({ ...creation(), pubKeyCredParams: 5 }),
			paramsObject: () => create({ ...creation(), pubKeyCredParams: {} }),
			paramNull: () => create({ ...creation(), pubKeyCredParams: [null] }),
			paramNoType: () =>
				create({ ...creation(), pubKeyCredParams: [{ alg: -7 }] }),
			paramNoAlg: () =>
				create({ ...creation(), pubKeyCredParams: [{ type: 'public-key' }] }),
			paramAlgObject: () =>
				create({
					...creation(),
					pubKeyCredParams: [{ type: 'public-key', alg: {} }],
				}),
			paramAlgSymbol: () =>
				create({
					...creation(),
					pubKeyCredParams: [{ type: 'public-key', alg: Symbol('x') }],
				}),
			paramAlgBigInt: () =>
				create({
					...creation(),
					pubKeyCredParams: [{ type: 'public-key', alg: 7n }],
				}),
			timeoutSymbol: () => create({ ...creation(), timeout: Symbol('x') }),
			excludeNumber: () => create({ ...creation(), excludeCredentials: 5 }),
			excludeNoId: () =>
				create({
					...creation(),
					excludeCredentials: [{ type: 'public-key' }],
				}),
			excludeNoType: () =>
				create({
					...creation(),
					excludeCredentials: [{ id: new Uint8Array(16) }],
				}),
			excludeIdString: () =>
				create({
					...creation(),
					excludeCredentials: [{ type: 'public-key', id: 'abc' }],
				}),
			excludeTransportsNumber: () =>
				create({
					...creation(),
					excludeCredentials: [
						{ type: 'public-key', id: new Uint8Array(16), transports: 5 },
					],
				}),
			selectionNumber: () =>
				create({ ...creation(), authenticatorSelection: 5 }),
			selectionNull: () =>
				create({ ...creation(), authenticatorSelection: null }),
			hintsNumber: () => create({ ...creation(), hints: 5 }),
			extensionsNumber: () => create({ ...creation(), extensions: 5 }),
			attestationFormatsNumber: () =>
				create({ ...creation(), attestationFormats: 5 }),
			signalNumber: () => create(creation(), { signal: 5 }),
			signalObject: () => create(creation(), { signal: {} }),
			mediationUnknown: () => create(creation(), { mediation: 'sometimes' }),
			getterThrows: () =>
				create({
					...creation(),
					get rp() {
						throw new RangeError('the page threw');
					},
				}),
			passwordToo: () =>
				navigator.credentials.create({
					publicKey: creation(),
					password: { id: 'a', password: 'b' },
				}),
		},
		getShape: {
			noOptions: () => navigator.credentials.get(),
			emptyOptions: () => navigator.credentials.get({}),
			publicKeyNull: () => navigator.credentials.get({ publicKey: null }),
			publicKeyNumber: () => navigator.credentials.get({ publicKey: 5 }),
			publicKeyEmpty: () => get({}),
			challengeString: () => get({ challenge: 'abc' }),
			challengeDetached: () => get({ challenge: detached() }),
			rpIdNumber: () => get(request({ rpId: 5, timeout: 300 })),
			allowNumber: () => get(request({ allowCredentials: 5 })),
			allowNoId: () =>
				get(request({ allowCredentials: [{ type: 'public-key' }] })),
			allowNoType: () =>
				get(request({ allowCredentials: [{ id: new Uint8Array(16) }] })),
			allowIdString: () =>
				get(request({ allowCredentials: [{ type: 'public-key', id: 'abc' }] })),
			hintsNumber: () => get(request({ hints: 5 })),
			extensionsNumber: () => get(request({ extensions: 5 })),
			signalNumber: () => get(request(), { signal: 5 }),
			mediationUnknown: () => get(request(), { mediation: 'sometimes' }),
			timeoutSymbol: () => get(request({ timeout: Symbol('x') })),
			identityToo: () =>
				navigator.credentials.get({
					publicKey: request(),
					identity: { providers: [] },
				}),
			passwordToo: () =>
				navigator.credentials.get({ publicKey: request(), password: true }),
		},
		// what the client refuses before any authenticator is asked
		createRefused: {
			aborted: () => create(creation(), { signal: aborted() }),
			abortedReason: () =>
				create(creation(), { signal: aborted(new RangeError('mine')) }),
			abortedString: () => create(creation(), { signal: aborted('why') }),
			abortedBeforeShape: () => create({}, { signal: aborted() }),
			rpIdOther: () => create(creation({ rp: { id: HOSTS.gb } })),
			rpIdSuffix: () => create(creation({ rp: { id: 'co.uk' } })),
			rpIdTld: () => create(creation({ rp: { id: 'uk' } })),
			rpIdEmpty: () => create(creation({ rp: { id: '' } })),
			rpIdChild: () =>
				create(creation({ rp: { id: `x.${location.hostname}` } })),
			rpIdPort: () =>
				create(
					creation({ rp: { id: `${location.hostname}:${location.port}` } }),
				),
			rpIdURL: () => create(creation({ rp: { id: location.origin } })),
			rpIdDot: () => create(creation({ rp: { id: `${location.hostname}.` } })),
			rpIdSpace: () => create(creation({ rp: { id: ' ' } })),
			rpIdAbortedToo: () =>
				create(creation({ rp: { id: HOSTS.gb } }), { signal: aborted() }),
			paramsUnknownType: () =>
				create({
					...creation(),
					pubKeyCredParams: [{ type: 'made-up', alg: -7 }],
				}),
			paramsUnknownAlg: () =>
				create({
					...creation(),
					pubKeyCredParams: [{ type: 'public-key', alg: -9999 }],
				}),
			crossPlatform: () =>
				create({
					...creation(),
					timeout: 600,
					authenticatorSelection: {
						authenticatorAttachment: 'cross-platform',
					},
				}),
			conditional: () =>
				create({ ...creation(), timeout: 600 }, { mediation: 'conditional' }),
			silent: () => create(creation(), { mediation: 'silent' }),
			required: () => create(creation(), { mediation: 'required' }),
			unknownEnums: () =>
				create({
					...creation(),
					attestation: 'made-up',
					hints: ['made-up'],
					authenticatorSelection: {
						authenticatorAttachment: 'made-up',
						residentKey: 'made-up',
						userVerification: 'made-up',
					},
					excludeCredentials: [
						{
							type: 'made-up',
							id: new Uint8Array(16),
							transports: ['made-up'],
						},
					],
				}),
			excludeLongId: () =>
				create({
					...creation(),
					excludeCredentials: [
						{ type: 'public-key', id: new Uint8Array(2000) },
					],
				}),
			prfByCredential: () =>
				create({
					...creation(),
					timeout: 600,
					extensions: { prf: { evalByCredential: {} } },
				}),
			prfEvalNoFirst: () =>
				create({
					...creation(),
					timeout: 600,
					extensions: { prf: { eval: {} } },
				}),
			largeBlobRead: () =>
				create({
					...creation(),
					timeout: 600,
					extensions: { largeBlob: { read: true } },
				}),
			largeBlobBadSupport: () =>
				create({
					...creation(),
					extensions: { largeBlob: { support: 'made-up' } },
				}),
			largeBlobRequired: () =>
				create({
					...creation(),
					timeout: 600,
					extensions: { largeBlob: { support: 'required' } },
				}),
			appidExclude: () =>
				create({
					...creation(),
					timeout: 600,
					extensions: { appidExclude: 'https://other.example/app.json' },
				}),
			timeoutNegative: () => create({ ...creation(), timeout: -5 }),
			timeoutString: () => create({ ...creation(), timeout: 'soon' }),
			timeoutHuge: () =>
				create({ ...creation(), timeout: 2 ** 40 }, { signal: abortSoon(300) }),
			twoAtOnce: async () => {
				const controller = new AbortController();
				// a first request no authenticator here answers (a security key
				// asked for by name), so it is still open when the second comes:
				// Chrome's virtual authenticator otherwise may finish it first
				const first = create(
					{
						...creation(),
						timeout: 60000,
						authenticatorSelection: {
							authenticatorAttachment: 'cross-platform',
						},
					},
					{ signal: controller.signal },
				);
				first.catch(() => {});
				try {
					return await create(creation());
				} finally {
					controller.abort();
					await first.catch(() => {});
				}
			},
		},
		getRefused: {
			aborted: () => get(request(), { signal: aborted() }),
			abortedReason: () =>
				get(request(), { signal: aborted(new RangeError('mine')) }),
			rpIdOther: () => get(request({ rpId: HOSTS.gb })),
			rpIdSuffix: () => get(request({ rpId: 'co.uk' })),
			rpIdEmpty: () => get(request({ rpId: '' })),
			rpIdChild: () => get(request({ rpId: `x.${location.hostname}` })),
			silent: () => get(request({ timeout: 600 }), { mediation: 'silent' }),
			required: () => get(request({ timeout: 600 }), { mediation: 'required' }),
			mediationImmediate: () =>
				get(request({ timeout: 600 }), { mediation: 'immediate' }),
			unknownEnums: () =>
				get(
					request({
						timeout: 600,
						userVerification: 'made-up',
						hints: ['made-up'],
						allowCredentials: [
							{
								type: 'made-up',
								id: new Uint8Array(16),
								transports: ['made-up'],
							},
						],
					}),
				),
			unknownCredential: () =>
				get(
					request({
						timeout: 600,
						allowCredentials: [{ type: 'public-key', id: new Uint8Array(32) }],
					}),
				),
			prfByCredentialNoAllow: () =>
				get(
					request({
						timeout: 600,
						extensions: {
							prf: { evalByCredential: { AAAA: { first: new Uint8Array(4) } } },
						},
					}),
				),
			prfByCredentialBadKey: () =>
				get(
					request({
						timeout: 600,
						allowCredentials: [{ type: 'public-key', id: new Uint8Array(32) }],
						extensions: {
							prf: { evalByCredential: { '!!': { first: new Uint8Array(4) } } },
						},
					}),
				),
			prfByCredentialNotAllowed: () =>
				get(
					request({
						timeout: 600,
						allowCredentials: [{ type: 'public-key', id: new Uint8Array(32) }],
						extensions: {
							prf: { evalByCredential: { AAAA: { first: new Uint8Array(4) } } },
						},
					}),
				),
			largeBlobSupport: () =>
				get(
					request({
						timeout: 600,
						extensions: { largeBlob: { support: 'preferred' } },
					}),
				),
			largeBlobReadWrite: () =>
				get(
					request({
						timeout: 600,
						extensions: { largeBlob: { read: true, write: new Uint8Array(4) } },
					}),
				),
			conditionalAllowAborted: () =>
				get(request(), { mediation: 'conditional', signal: abortSoon(300) }),
			conditionalAbortReason: () =>
				get(request(), {
					mediation: 'conditional',
					signal: abortSoon(300, new RangeError('later')),
				}),
		},
		// the signal API (PublicKeyCredential.signal*)
		signals: {
			unknownOk: () =>
				PublicKeyCredential.signalUnknownCredential({
					rpId: location.hostname,
					credentialId: 'AAAA',
				}),
			unknownNoArgs: () => PublicKeyCredential.signalUnknownCredential(),
			unknownEmpty: () => PublicKeyCredential.signalUnknownCredential({}),
			unknownNoId: () =>
				PublicKeyCredential.signalUnknownCredential({
					rpId: location.hostname,
				}),
			unknownBadId: () =>
				PublicKeyCredential.signalUnknownCredential({
					rpId: location.hostname,
					credentialId: 'not base64url!',
				}),
			unknownPaddedId: () =>
				PublicKeyCredential.signalUnknownCredential({
					rpId: location.hostname,
					credentialId: 'AAAA==',
				}),
			unknownOtherRp: () =>
				PublicKeyCredential.signalUnknownCredential({
					rpId: HOSTS.gb,
					credentialId: 'AAAA',
				}),
			unknownSuffixRp: () =>
				PublicKeyCredential.signalUnknownCredential({
					rpId: 'co.uk',
					credentialId: 'AAAA',
				}),
			acceptedOk: () =>
				PublicKeyCredential.signalAllAcceptedCredentials({
					rpId: location.hostname,
					userId: 'AQIDBA',
					allAcceptedCredentialIds: ['AAAA'],
				}),
			acceptedNoUser: () =>
				PublicKeyCredential.signalAllAcceptedCredentials({
					rpId: location.hostname,
					allAcceptedCredentialIds: [],
				}),
			acceptedBadUser: () =>
				PublicKeyCredential.signalAllAcceptedCredentials({
					rpId: location.hostname,
					userId: '!!',
					allAcceptedCredentialIds: [],
				}),
			acceptedBadId: () =>
				PublicKeyCredential.signalAllAcceptedCredentials({
					rpId: location.hostname,
					userId: 'AQIDBA',
					allAcceptedCredentialIds: ['!!'],
				}),
			acceptedNotList: () =>
				PublicKeyCredential.signalAllAcceptedCredentials({
					rpId: location.hostname,
					userId: 'AQIDBA',
					allAcceptedCredentialIds: 5,
				}),
			acceptedOtherRp: () =>
				PublicKeyCredential.signalAllAcceptedCredentials({
					rpId: HOSTS.gb,
					userId: 'AQIDBA',
					allAcceptedCredentialIds: [],
				}),
			detailsOk: () =>
				PublicKeyCredential.signalCurrentUserDetails({
					rpId: location.hostname,
					userId: 'AQIDBA',
					name: 'n',
					displayName: 'd',
				}),
			detailsNoName: () =>
				PublicKeyCredential.signalCurrentUserDetails({
					rpId: location.hostname,
					userId: 'AQIDBA',
					displayName: 'd',
				}),
			detailsBadUser: () =>
				PublicKeyCredential.signalCurrentUserDetails({
					rpId: location.hostname,
					userId: '!!',
					name: 'n',
					displayName: 'd',
				}),
			detailsOtherRp: () =>
				PublicKeyCredential.signalCurrentUserDetails({
					rpId: HOSTS.gb,
					userId: 'AQIDBA',
					name: 'n',
					displayName: 'd',
				}),
		},
		// the JSON parsers, which ask nobody
		parsers: {
			creation: async () => {
				const parsed = PublicKeyCredential.parseCreationOptionsFromJSON({
					rp: { name: 'x', id: 'example.test' },
					user: { id: 'AQIDBA', name: 'n', displayName: 'd' },
					challenge: 'AAAA',
					pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
					excludeCredentials: [{ type: 'public-key', id: 'AAAA' }],
				});
				return JSON.stringify({
					challenge: tag(parsed.challenge),
					user: tag(parsed.user.id),
					exclude: tag(parsed.excludeCredentials[0].id),
					keys: Object.keys(parsed),
				});
			},
			request: async () => {
				const parsed = PublicKeyCredential.parseRequestOptionsFromJSON({
					challenge: 'AAAA',
					allowCredentials: [{ type: 'public-key', id: 'AAAA' }],
				});
				return JSON.stringify({
					challenge: tag(parsed.challenge),
					allow: tag(parsed.allowCredentials[0].id),
					keys: Object.keys(parsed),
				});
			},
			creationBad: async () =>
				PublicKeyCredential.parseCreationOptionsFromJSON({ challenge: '!!' }),
		},
	};

	const cases = async (group, only) => {
		const out = {};
		for (const [name, call] of Object.entries(CASES[group])) {
			if (only && !only.includes(name)) continue;
			const outcome = await settle(call);
			out[name] = outcome.threw
				? { threw: outcome.threw }
				: outcome.pending
					? { pending: true }
					: outcome.rejected
						? { rejected: outcome.rejected, phase: outcome.phase }
						: {
								resolved: outcome.resolved,
								phase: outcome.phase,
								...(typeof outcome.value === 'string'
									? { value: outcome.value }
									: {}),
							};
			out[name].ms = outcome.ms;
		}
		return out;
	};

	// --- the order Chrome reads a request's members in ---

	const spy = (target, path, log) =>
		new Proxy(target, {
			get(object, key, receiver) {
				if (typeof key === 'string') log.push(`${path}.${key}`);
				const value = Reflect.get(object, key, receiver);
				// arrays are read through their iterator: leave them be
				return value !== null &&
					typeof value === 'object' &&
					!ArrayBuffer.isView(value) &&
					!(value instanceof ArrayBuffer) &&
					!(value instanceof AbortSignal)
					? spy(value, `${path}.${key}`, log)
					: value;
			},
			has(object, key) {
				if (typeof key === 'string') log.push(`has ${path}.${key}`);
				return Reflect.has(object, key);
			},
		});
	const order = async (kind) => {
		const log = [];
		const id = new Uint8Array(16);
		const options =
			kind === 'create'
				? {
						signal: aborted(),
						mediation: 'optional',
						publicKey: {
							...creation(),
							excludeCredentials: [
								{ type: 'public-key', id, transports: ['internal'] },
							],
							authenticatorSelection: {
								authenticatorAttachment: 'platform',
								residentKey: 'required',
								requireResidentKey: true,
								userVerification: 'preferred',
							},
							hints: ['client-device'],
							attestation: 'none',
							attestationFormats: [],
							extensions: {
								credProps: true,
								prf: { eval: { first: new Uint8Array(4) } },
								largeBlob: { support: 'preferred' },
							},
						},
					}
				: {
						signal: aborted(),
						mediation: 'optional',
						publicKey: {
							...request(),
							rpId: location.hostname,
							allowCredentials: [
								{ type: 'public-key', id, transports: ['internal'] },
							],
							userVerification: 'preferred',
							hints: ['client-device'],
							extensions: {
								prf: { eval: { first: new Uint8Array(4) } },
								largeBlob: { read: true },
							},
						},
					};
		const outcome = await settle(() =>
			navigator.credentials[kind](spy(options, kind, log)),
		);
		return { log, rejected: outcome.rejected ?? null };
	};

	// --- what a credential reads as ---

	const brand = (holder, key, value) =>
		attempt(() => {
			const descriptor = Object.getOwnPropertyDescriptor(holder, key);
			return tag((descriptor.get ?? descriptor.value).call(value));
		});
	const dump = (credential) => {
		if (credential === null) return null;
		const response = credential.response;
		const attestation =
			typeof AuthenticatorAttestationResponse === 'function' &&
			response instanceof AuthenticatorAttestationResponse;
		const json = attempt(() => credential.toJSON());
		return {
			tag: tag(credential),
			chain: chain(credential),
			instance:
				credential instanceof PublicKeyCredential &&
				credential instanceof Credential,
			ownKeys: Reflect.ownKeys(credential).map(String),
			forIn: (() => {
				const keys = [];
				for (const key in credential) keys.push(key);
				return keys;
			})(),
			id: credential.id,
			type: credential.type,
			rawId: b64url(credential.rawId),
			rawIdTag: tag(credential.rawId),
			rawIdSame: credential.rawId === credential.rawId,
			attachment: credential.authenticatorAttachment,
			responseSame: credential.response === credential.response,
			responseTag: tag(response),
			responseChain: chain(response),
			responseInstance: response instanceof AuthenticatorResponse,
			responseOwnKeys: Reflect.ownKeys(response).map(String),
			responseForIn: (() => {
				const keys = [];
				for (const key in response) keys.push(key);
				return keys;
			})(),
			clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
			clientDataTag: tag(response.clientDataJSON),
			clientDataSame: response.clientDataJSON === response.clientDataJSON,
			...(attestation
				? {
						attestationObject: b64url(response.attestationObject),
						attestationSame:
							response.attestationObject === response.attestationObject,
						authenticatorData: b64url(response.getAuthenticatorData()),
						authenticatorDataFresh:
							response.getAuthenticatorData() !==
							response.getAuthenticatorData(),
						publicKey: b64url(response.getPublicKey()),
						publicKeyTag: tag(response.getPublicKey()),
						publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
						transports: response.getTransports(),
						transportsFresh:
							response.getTransports() !== response.getTransports(),
					}
				: {
						authenticatorData: b64url(response.authenticatorData),
						authenticatorDataSame:
							response.authenticatorData === response.authenticatorData,
						signature: b64url(response.signature),
						signatureSame: response.signature === response.signature,
						userHandle: b64url(response.userHandle),
						userHandleTag: tag(response.userHandle),
					}),
			extensions: JSON.stringify(credential.getClientExtensionResults()),
			extensionsTag: tag(credential.getClientExtensionResults()),
			extensionsFresh:
				credential.getClientExtensionResults() !==
				credential.getClientExtensionResults(),
			json: typeof json === 'string' ? json : JSON.stringify(json),
			jsonTag: tag(json),
			stringify: attempt(() => JSON.stringify(credential)),
			brands: {
				rawId: brand(PublicKeyCredential.prototype, 'rawId', credential),
				id: brand(Credential.prototype, 'id', credential),
				type: brand(Credential.prototype, 'type', credential),
				response: brand(PublicKeyCredential.prototype, 'response', credential),
				clientDataJSON: brand(
					AuthenticatorResponse.prototype,
					'clientDataJSON',
					response,
				),
				rawIdOfPlain: brand(PublicKeyCredential.prototype, 'rawId', {}),
				rawIdOfResponse: brand(
					PublicKeyCredential.prototype,
					'rawId',
					response,
				),
				toJSONOfPlain: brand(PublicKeyCredential.prototype, 'toJSON', {}),
				tokenOfCredential:
					typeof IdentityCredential === 'function'
						? brand(IdentityCredential.prototype, 'token', credential)
						: 'no FedCM',
				clone: attempt(() => tag(structuredClone(credential))),
				setRawId: attempt(() => {
					'use strict';
					credential.rawId = 1;
					return 'assigned';
				}),
				frozen: Object.isFrozen(credential),
				extensible: Object.isExtensible(credential),
			},
		};
	};

	// --- whole ceremonies against the relying party ---

	const post = async (path, body) => {
		const response = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		return response.json();
	};
	let ceremony = 0;
	const key = (label) =>
		`${query.get('id') ?? 'page'}-${label}-${++ceremony}-${Date.now()}`;
	const top = () => (window === window.top ? {} : { top: query.get('top') });

	// A page that asks as it loads (`?auto=`) tells the relying party once
	// the call is made: the suite waits for that before it looks at the
	// page, since looking at a page gives it a user activation
	const asked = (promise) => {
		if (query.has('auto'))
			fetch(`/pk/mark?k=${encodeURIComponent(pk.id)}`).catch(() => {});
		return promise;
	};

	/** a registration: options from the server, create(), the server's verdict */
	const register = async (params = {}) => {
		const k = key('create');
		const json = await post('/pk/register/options', {
			k,
			...top(),
			...params.server,
		});
		const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(json);
		if (params.patch) Object.assign(publicKey, params.patch);
		const signal = params.abortAfter ? abortSoon(params.abortAfter) : undefined;
		const outcome = await settle(
			() =>
				asked(
					navigator.credentials.create({
						publicKey,
						...(signal ? { signal } : {}),
						...(params.mediation ? { mediation: params.mediation } : {}),
					}),
				),
			params.guard ?? 30000,
		);
		if (!outcome.resolved)
			return {
				rejected: outcome.rejected ?? null,
				pending: outcome.pending ?? false,
				phase: outcome.phase,
				ms: outcome.ms,
			};
		const credential = outcome.value;
		pk.last = credential;
		return {
			dump: dump(credential),
			verdict: await post('/pk/register/verify', {
				k,
				credential: credential.toJSON(),
			}),
			exclude: json.excludeCredentials.length,
		};
	};

	/** a sign-in: options from the server, get(), the server's verdict */
	const login = async (params = {}) => {
		const k = key('get');
		const json = await post('/pk/login/options', {
			k,
			...top(),
			...params.server,
		});
		const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(json);
		if (params.patch) Object.assign(publicKey, params.patch);
		// ask by these ids (base64url), whatever the server lists
		if (params.allowIds)
			publicKey.allowCredentials = params.allowIds.map((id) => ({
				type: 'public-key',
				id: unb64url(id),
			}));
		const signal = params.abortAfter ? abortSoon(params.abortAfter) : undefined;
		const outcome = await settle(
			() =>
				asked(
					navigator.credentials.get({
						publicKey,
						...(signal ? { signal } : {}),
						...(params.mediation ? { mediation: params.mediation } : {}),
					}),
				),
			params.guard ?? 30000,
		);
		if (!outcome.resolved)
			return {
				rejected: outcome.rejected ?? null,
				pending: outcome.pending ?? false,
				phase: outcome.phase,
				ms: outcome.ms,
				allow: json.allowCredentials.length,
			};
		const credential = outcome.value;
		pk.last = credential;
		return {
			dump: dump(credential),
			verdict: await post('/pk/login/verify', {
				k,
				credential: credential.toJSON(),
			}),
			allow: json.allowCredentials.length,
		};
	};

	const api = { shapes, statics, cases, order, register, login };
	const runs = new Map();
	let run = 0;
	const pk = (window.__pk = {
		id: query.get('id') ?? 'page',
		origin: location.origin,
		...api,
		/** start `name`, not waited for: its id */
		start(name, ...args) {
			const id = ++run;
			runs.set(id, { done: false });
			Promise.resolve()
				.then(() => api[name](...args))
				.then(
					(value) => runs.set(id, { done: true, value }),
					(error) =>
						runs.set(id, { done: true, value: { harness: String(error) } }),
				);
			return id;
		},
		read: (id) => runs.get(id),
		/** run `name` from the next click of #go: its id */
		arm(name, ...args) {
			const id = ++run;
			runs.set(id, { done: false });
			pk.armed = () => {
				pk.armed = null;
				Promise.resolve()
					.then(() => api[name](...args))
					.then(
						(value) => runs.set(id, { done: true, value }),
						(error) =>
							runs.set(id, { done: true, value: { harness: String(error) } }),
					);
			};
			return id;
		},
		armed: null,
		focus: () => ({
			hasFocus: document.hasFocus(),
			active: navigator.userActivation?.isActive,
		}),
	});

	const button = document.createElement('button');
	button.id = 'go';
	button.textContent = 'go';
	button.addEventListener('click', () => pk.armed?.());
	document.body.append(button);
	// the WebAuthn autofill anchor conditional mediation asks for
	const input = document.createElement('input');
	input.id = 'user';
	input.autocomplete = 'username webauthn';
	document.body.append(input);

	if (query.has('frame')) {
		const frame = document.createElement('iframe');
		frame.id = 'child';
		if (query.has('allow')) frame.allow = query.get('allow');
		frame.src = query.get('frame');
		frame.width = 400;
		frame.height = 200;
		document.body.append(frame);
	}
	// `?auto=<name>&autoArgs=<json>`: run at load, before anything gave this
	// document a user activation; __pk.auto has the outcome
	if (query.has('auto'))
		pk.auto = pk.start(
			query.get('auto'),
			...JSON.parse(query.get('autoArgs') ?? '[]'),
		);
	pk.ready = true;
})();
