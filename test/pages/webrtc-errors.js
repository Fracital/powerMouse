// What the browser says to bad RTCPeerConnection calls: a bad configuration,
// a bad remote description, bad candidates, bad channel options, each as
// "ok <what it reads back>" or the error's class, name and message. The
// webrtc suite runs both tables natively and proxied and compares them case
// by case, so the wording is always the running browser's. No case here
// sets a local description with a server or a remote candidate that could
// be reached: nothing leaves the machine.
window.__rtcErrors = async (env) => {
	const out = {
		config: {},
		order: {},
		setConfig: {},
		remote: {},
		candidate: {},
		channel: {},
	};
	const show = (error) =>
		`${error?.constructor?.name} ${error?.name}: ${error?.message}`;
	const attempt = (group, name, fn) => {
		try {
			const value = fn();
			out[group][name] = `ok ${JSON.stringify(value)}`;
		} catch (error) {
			out[group][name] = show(error);
		}
	};
	const settle = async (group, name, fn) => {
		try {
			const value = await fn();
			out[group][name] = `ok ${JSON.stringify(value)}`;
		} catch (error) {
			out[group][name] = show(error);
		}
	};
	// --- configuration ---
	const construct = (name, ...args) =>
		attempt('config', name, () => {
			const pc = new RTCPeerConnection(...args);
			const config = pc.getConfiguration();
			pc.close();
			return config;
		});
	const servers = (name, ...list) => construct(name, { iceServers: list });
	construct('none');
	construct('undefined', undefined);
	construct('null', null);
	construct('empty', {});
	construct('number', 42);
	construct('string', 'x');
	construct('array', []);
	construct('function', () => {});
	construct('serversNull', { iceServers: null });
	construct('serversUndefined', { iceServers: undefined });
	construct('serversObject', { iceServers: {} });
	construct('serversString', { iceServers: 'stun:x' });
	construct('serversNumber', { iceServers: 5 });
	servers('serverNull', null);
	servers('serverUndefined', undefined);
	servers('serverNumber', 5);
	servers('serverString', 'stun:x');
	servers('serverEmpty', {});
	servers('urlsEmptyList', { urls: [] });
	servers('urlsEmptyString', { urls: '' });
	servers('urlsEmptyInList', { urls: [''] });
	servers('urlsNull', { urls: null });
	servers('urlsUndefined', { urls: undefined });
	servers('urlsNumber', { urls: 5 });
	servers('urlsObject', { urls: {} });
	servers('urlsListNumber', { urls: [5] });
	servers('http', { urls: 'http://x' });
	servers('httpInList', { urls: ['stun:a', 'http://b'] });
	servers('noScheme', { urls: 'example.com' });
	servers('relative', { urls: '/x' });
	servers('stunBare', { urls: 'stun:' });
	servers('stunHost', { urls: 'stun:host.example' });
	servers('stunUpper', { urls: 'STUN:HOST.example' });
	servers('stunPort', { urls: 'stun:h.example:3478' });
	servers('stunPortBig', { urls: 'stun:h.example:99999' });
	servers('stunPortZero', { urls: 'stun:h.example:0' });
	servers('stunPortText', { urls: 'stun:h.example:abc' });
	servers('stunPortEmpty', { urls: 'stun:h.example:' });
	servers('stunPortNegative', { urls: 'stun:h.example:-1' });
	servers('stunQuery', { urls: 'stun:h.example?transport=udp' });
	servers('stunSlashes', { urls: 'stun://h.example' });
	servers('stunPath', { urls: 'stun:h.example/path' });
	servers('stunSpace', { urls: 'stun:h exa' });
	servers('stunSpaces', { urls: ' stun:h.example ' });
	servers('stunV6', { urls: 'stun:[::1]:3478' });
	servers('stunV6NoPort', { urls: 'stun:[::1]' });
	servers('stunV6Open', { urls: 'stun:[::1' });
	servers('stunV6Bare', { urls: 'stun:::1' });
	servers('stunV4', { urls: 'stun:1.2.3.4:5' });
	servers('stunAt', { urls: 'stun:user@h.example' });
	servers('stunHash', { urls: 'stun:h.example#frag' });
	servers('stunUnicode', { urls: 'stun:hé.example' });
	servers('stunWithCredentials', {
		urls: 'stun:h.example',
		username: 'u',
		credential: 'p',
	});
	servers('stuns', { urls: 'stuns:h.example' });
	servers('legacyUrl', { url: 'stun:h.example' });
	servers('legacyBoth', { url: 'stun:a.example', urls: 'stun:b.example' });
	servers('legacyBad', { url: 'http://x' });
	servers('turnNoCredentials', { urls: 'turn:h.example' });
	servers('turnUsernameOnly', { urls: 'turn:h.example', username: 'u' });
	servers('turnCredentialOnly', { urls: 'turn:h.example', credential: 'p' });
	servers('turnEmptyBoth', {
		urls: 'turn:h.example',
		username: '',
		credential: '',
	});
	servers('turnEmptyUsername', {
		urls: 'turn:h.example',
		username: '',
		credential: 'p',
	});
	servers('turnEmptyCredential', {
		urls: 'turn:h.example',
		username: 'u',
		credential: '',
	});
	servers('turnNullCredential', {
		urls: 'turn:h.example',
		username: 'u',
		credential: null,
	});
	servers('turnNumberCredential', {
		urls: 'turn:h.example',
		username: 1,
		credential: 2,
	});
	servers('turnObjectCredential', {
		urls: 'turn:h.example',
		username: 'u',
		credential: {},
	});
	const turn = (name, urls, more = {}) =>
		servers(name, { urls, username: 'u', credential: 'p', ...more });
	turn('turn', 'turn:h.example');
	turn('turnPort', 'turn:h.example:3478');
	turn('turnTcp', 'turn:h.example?transport=tcp');
	turn('turnUdp', 'turn:h.example?transport=udp');
	turn('turnTls', 'turn:h.example?transport=tls');
	turn('turnTransportUpper', 'turn:h.example?transport=TCP');
	turn('turnTransportBad', 'turn:h.example?transport=foo');
	turn('turnTransportEmpty', 'turn:h.example?transport=');
	turn('turnQueryOther', 'turn:h.example?foo=bar');
	turn('turnQueryTwo', 'turn:h.example?transport=udp&x=y');
	turn('turnQueryBare', 'turn:h.example?');
	turn('turnQueryTwice', 'turn:h.example?transport=udp?transport=tcp');
	turn('turns', 'turns:h.example');
	turn('turnsTcp', 'turns:h.example?transport=tcp');
	turn('turnsUdp', 'turns:h.example?transport=udp');
	turn('turnAt', 'turn:user@h.example');
	turn('turnBare', 'turn:');
	turn('turnPortBig', 'turn:h.example:70000');
	turn('turnSystemPort', 'turn:h.example:22');
	turn('turnLongUsername', 'turn:h.example', { username: 'u'.repeat(600) });
	turn('turnLongCredential', 'turn:h.example', {
		credential: 'p'.repeat(100000),
	});
	turn('turnCredentialTypePassword', 'turn:h.example', {
		credentialType: 'password',
	});
	turn('turnCredentialTypeOauth', 'turn:h.example', {
		credentialType: 'oauth',
	});
	turn('turnCredentialTypeBad', 'turn:h.example', { credentialType: 'nope' });
	turn('turnMixed', ['stun:a.example', 'turn:b.example']);
	construct('manyServers', {
		iceServers: Array.from({ length: 40 }, (unused, i) => ({
			urls: `stun:h${i}.example`,
		})),
	});
	construct('manyUrls', {
		iceServers: [
			{ urls: Array.from({ length: 40 }, (unused, i) => `stun:h${i}.example`) },
		],
	});
	construct('policyRelay', { iceTransportPolicy: 'relay' });
	construct('policyAll', { iceTransportPolicy: 'all' });
	construct('policyBad', { iceTransportPolicy: 'nope' });
	construct('policyNone', { iceTransportPolicy: 'none' });
	construct('policyNull', { iceTransportPolicy: null });
	construct('policyNumber', { iceTransportPolicy: 5 });
	construct('transportsRelay', { iceTransports: 'relay' });
	construct('transportsBad', { iceTransports: 'nope' });
	construct('transportsAndPolicy', {
		iceTransports: 'relay',
		iceTransportPolicy: 'all',
	});
	construct('bundleBalanced', { bundlePolicy: 'balanced' });
	construct('bundleMaxCompat', { bundlePolicy: 'max-compat' });
	construct('bundleMaxBundle', { bundlePolicy: 'max-bundle' });
	construct('bundleBad', { bundlePolicy: 'nope' });
	construct('muxRequire', { rtcpMuxPolicy: 'require' });
	construct('muxNegotiate', { rtcpMuxPolicy: 'negotiate' });
	construct('muxBad', { rtcpMuxPolicy: 'nope' });
	for (const [name, value] of [
		['pool0', 0],
		['pool1', 1],
		['pool255', 255],
		['pool256', 256],
		['pool300', 300],
		['poolNegative', -1],
		['poolFraction', 1.5],
		['poolString', '3'],
		['poolText', 'x'],
		['poolNaN', NaN],
		['poolInfinity', Infinity],
		['poolNull', null],
		['poolObject', {}],
		['poolTrue', true],
		['poolNegativeFraction', -0.5],
		['pool255Fraction', 255.9],
	])
		construct(name, { iceCandidatePoolSize: value });
	construct('certificatesString', { certificates: 'x' });
	construct('certificatesNumberList', { certificates: [5] });
	construct('certificatesNull', { certificates: null });
	construct('certificatesEmpty', { certificates: [] });
	construct('certificatesObjectList', { certificates: [{}] });
	construct('semanticsUnified', { sdpSemantics: 'unified-plan' });
	construct('semanticsPlanB', { sdpSemantics: 'plan-b' });
	construct('semanticsBad', { sdpSemantics: 'nope' });
	construct('unknownMember', { nope: 1 });
	construct(
		'secondArgument',
		{},
		{ optional: [{ DtlsSrtpKeyAgreement: true }] },
	);
	construct('secondArgumentNumber', {}, 5);
	construct('secondArgumentMandatory', {}, { mandatory: { a: 1 } });
	construct('encodedInsertableStreams', { encodedInsertableStreams: true });
	construct('two', {
		iceServers: [{ urls: 'http://x' }],
		iceTransportPolicy: 'nope',
	});
	construct('badPoolAndServers', {
		iceServers: [{ urls: 'http://x' }],
		iceCandidatePoolSize: 300,
	});
	construct('badBundleAndPool', {
		bundlePolicy: 'nope',
		iceCandidatePoolSize: 300,
	});
	construct('badServerAndBundle', { iceServers: [{}], bundlePolicy: 'nope' });
	attempt('config', 'call', () => RTCPeerConnection());
	try {
		const certificate = await RTCPeerConnection.generateCertificate({
			name: 'ECDSA',
			namedCurve: 'P-256',
			expires: 0,
		});
		construct('certificateExpired', { certificates: [certificate] });
		const good = await RTCPeerConnection.generateCertificate({
			name: 'ECDSA',
			namedCurve: 'P-256',
		});
		attempt('config', 'certificateGood', () => {
			const pc = new RTCPeerConnection({ certificates: [good] });
			const config = pc.getConfiguration();
			pc.close();
			return [
				config.certificates.length,
				config.certificates[0] === good,
				Object.keys(config),
			];
		});
		attempt('setConfig', 'certificateChange', () => {
			const pc = new RTCPeerConnection();
			try {
				pc.setConfiguration({ certificates: [good] });
			} finally {
				pc.close();
			}
		});
		attempt('setConfig', 'certificateSame', () => {
			const pc = new RTCPeerConnection({ certificates: [good] });
			try {
				pc.setConfiguration({ certificates: [good] });
				pc.setConfiguration({});
				return pc.getConfiguration().certificates.length;
			} finally {
				pc.close();
			}
		});
	} catch (error) {
		out.config.certificate = show(error);
	}
	// the order the members are read in, and which
	{
		const read = [];
		const config = new Proxy(
			{},
			{
				get(target, key) {
					read.push(String(key));
					return undefined;
				},
				has(target, key) {
					read.push(`has ${String(key)}`);
					return false;
				},
			},
		);
		const pc = new RTCPeerConnection(config);
		pc.close();
		out.order.configuration = read;
		const serverRead = [];
		const server = new Proxy(
			{ urls: 'turn:h.example', username: 'u', credential: 'p' },
			{
				get(target, key) {
					serverRead.push(String(key));
					return target[key];
				},
			},
		);
		const pc2 = new RTCPeerConnection({ iceServers: [server] });
		pc2.close();
		out.order.server = serverRead;
	}
	// --- setConfiguration ---
	const reconfigure = (name, initial, next, before = () => {}) =>
		attempt('setConfig', name, () => {
			const pc = new RTCPeerConnection(initial);
			try {
				before(pc);
				pc.setConfiguration(...next);
				return pc.getConfiguration();
			} finally {
				pc.close();
			}
		});
	reconfigure('none', {}, []);
	reconfigure('undefined', {}, [undefined]);
	reconfigure('null', {}, [null]);
	reconfigure('number', {}, [5]);
	reconfigure(
		'empty',
		{ iceServers: [{ urls: 'stun:a.example' }], iceCandidatePoolSize: 2 },
		[{}],
	);
	reconfigure('servers', {}, [{ iceServers: [{ urls: 'stun:a.example' }] }]);
	reconfigure('badUrl', {}, [{ iceServers: [{ urls: 'stun:' }] }]);
	reconfigure('http', {}, [{ iceServers: [{ urls: 'http://x' }] }]);
	reconfigure('malformed', {}, [{ iceServers: [{}] }]);
	reconfigure('noCredential', {}, [
		{ iceServers: [{ urls: 'turn:x.example' }] },
	]);
	reconfigure('badPolicy', {}, [{ iceTransportPolicy: 'nope' }]);
	reconfigure('relay', {}, [{ iceTransportPolicy: 'relay' }]);
	reconfigure('bundle', {}, [{ bundlePolicy: 'max-bundle' }]);
	reconfigure('bundleSame', { bundlePolicy: 'max-bundle' }, [
		{ bundlePolicy: 'max-bundle' },
	]);
	reconfigure('bundleDefault', { bundlePolicy: 'max-bundle' }, [{}]);
	reconfigure('mux', {}, [{ rtcpMuxPolicy: 'negotiate' }]);
	reconfigure('pool', {}, [{ iceCandidatePoolSize: 3 }]);
	reconfigure('poolBad', {}, [{ iceCandidatePoolSize: 300 }]);
	reconfigure('semantics', {}, [{ sdpSemantics: 'plan-b' }]);
	reconfigure('closed', {}, [{}], (pc) => pc.close());
	reconfigure('closedBad', {}, [{ iceServers: [{ urls: 'http://x' }] }], (pc) =>
		pc.close(),
	);
	await settle('setConfig', 'poolAfterLocal', async () => {
		const pc = new RTCPeerConnection();
		pc.createDataChannel('x');
		await pc.setLocalDescription();
		try {
			pc.setConfiguration({ iceCandidatePoolSize: 3 });
			return pc.getConfiguration();
		} finally {
			pc.close();
		}
	});
	await settle('setConfig', 'poolSameAfterLocal', async () => {
		const pc = new RTCPeerConnection({ iceCandidatePoolSize: 3 });
		pc.createDataChannel('x');
		await pc.setLocalDescription();
		try {
			pc.setConfiguration({
				iceCandidatePoolSize: 3,
				iceServers: [{ urls: 'stun:a.example' }],
			});
			return pc.getConfiguration();
		} finally {
			pc.close();
		}
	});

	// --- remote descriptions ---
	const other = new RTCPeerConnection();
	other.createDataChannel('x');
	await other.setLocalDescription();
	const base = other.localDescription.sdp
		.split('\r\n')
		.filter((line) => !line.startsWith('a=candidate'))
		.join('\r\n');
	const remote = (name, init, prepare) =>
		settle('remote', name, async () => {
			const pc = new RTCPeerConnection();
			try {
				if (prepare) await prepare(pc);
				await pc.setRemoteDescription(...init);
				return pc.signalingState;
			} finally {
				pc.close();
			}
		});
	const offer = (name, edit) =>
		remote(name, [
			{ type: 'offer', sdp: typeof edit === 'string' ? edit : edit(base) },
		]);
	const drop = (pattern) => (sdp) =>
		sdp
			.split('\r\n')
			.filter((line) => !pattern.test(line))
			.join('\r\n');
	const swap = (pattern, text) => (sdp) =>
		sdp
			.split('\r\n')
			.map((line) => (pattern.test(line) ? text : line))
			.join('\r\n');
	await remote('none', []);
	await remote('undefined', [undefined]);
	await remote('null', [null]);
	await remote('number', [5]);
	await remote('string', ['x']);
	await remote('empty', [{}]);
	await remote('sdpOnly', [{ sdp: 'v=0' }]);
	await remote('sdpOnlyGood', [{ sdp: base }]);
	await remote('typeBad', [{ type: 'nope', sdp: base }]);
	await remote('typeNull', [{ type: null, sdp: base }]);
	await remote('typeNumber', [{ type: 5 }]);
	await remote('offerNoSdp', [{ type: 'offer' }]);
	await remote('offerNullSdp', [{ type: 'offer', sdp: null }]);
	await remote('offerNumberSdp', [{ type: 'offer', sdp: 5 }]);
	await remote('answerNoSdp', [{ type: 'answer' }]);
	await remote('pranswerNoSdp', [{ type: 'pranswer' }]);
	await remote('rollbackStable', [{ type: 'rollback' }]);
	await remote('rollbackStableSdp', [{ type: 'rollback', sdp: 'nonsense' }]);
	await remote('answerStable', [{ type: 'answer', sdp: base }]);
	await remote('answerStableShort', [{ type: 'answer', sdp: 'v=0\r\n' }]);
	await remote('answerStableGarbage', [{ type: 'answer', sdp: 'nonsense' }]);
	await remote('pranswerStable', [{ type: 'pranswer', sdp: base }]);
	await remote('good', [{ type: 'offer', sdp: base }]);
	await remote('instance', [
		new RTCSessionDescription({ type: 'offer', sdp: base }),
	]);
	await offer('emptySdp', '');
	await offer('garbage', 'nonsense');
	await offer('garbageLines', 'nonsense\r\nmore\r\n');
	await offer('versionOnly', 'v=0\r\n');
	await offer('versionOnlyNoNewline', 'v=0');
	await offer('versionBad', 'v=1\r\n');
	await offer('versionOrigin', 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n');
	await offer('originShort', 'v=0\r\no=- 1 2 IN IP4\r\ns=-\r\nt=0 0\r\n');
	await offer(
		'originLong',
		'v=0\r\no=- 1 2 IN IP4 127.0.0.1 x\r\ns=-\r\nt=0 0\r\n',
	);
	await offer(
		'originText',
		'v=0\r\no=- a b IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
	);
	await offer('noSession', 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nt=0 0\r\n');
	await offer('noTime', 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n');
	await offer('timeShort', 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0\r\n');
	await offer(
		'sessionOnly',
		'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
	);
	await offer('sessionOnlyLf', 'v=0\no=- 1 2 IN IP4 127.0.0.1\ns=-\nt=0 0\n');
	await offer('lf', (sdp) => sdp.replace(/\r\n/g, '\n'));
	await offer('noTrailingNewline', (sdp) => sdp.replace(/\r\n$/, ''));
	await offer('blankLine', (sdp) => sdp.replace('s=-\r\n', 's=-\r\n\r\n'));
	await offer('unknownLine', (sdp) =>
		sdp.replace('s=-\r\n', 's=-\r\nz=what\r\n'),
	);
	await offer('unknownAttribute', (sdp) => `${sdp}a=whatever:1\r\n`);
	await offer('lineNoEquals', (sdp) => `${sdp}whatever\r\n`);
	await offer('lineSpace', (sdp) => `${sdp}a =x\r\n`);
	await offer('upperType', (sdp) => `${sdp}A=x\r\n`);
	await offer('noFingerprint', drop(/^a=fingerprint/));
	await offer(
		'fingerprintShort',
		swap(/^a=fingerprint/, 'a=fingerprint:sha-256'),
	);
	await offer(
		'fingerprintAlgorithm',
		swap(/^a=fingerprint/, 'a=fingerprint:md2 00:11'),
	);
	await offer(
		'fingerprintOdd',
		swap(/^a=fingerprint/, 'a=fingerprint:sha-256 zz'),
	);
	await offer(
		'fingerprintTruncated',
		swap(/^a=fingerprint/, 'a=fingerprint:sha-256 00:11:22'),
	);
	await offer('noUfrag', drop(/^a=ice-ufrag/));
	await offer('noPwd', drop(/^a=ice-pwd/));
	await offer('noUfragNoPwd', drop(/^a=ice-(ufrag|pwd)/));
	await offer('ufragShort', swap(/^a=ice-ufrag/, 'a=ice-ufrag:abc'));
	await offer('ufragEmpty', swap(/^a=ice-ufrag/, 'a=ice-ufrag:'));
	await offer('pwdShort', swap(/^a=ice-pwd/, 'a=ice-pwd:short'));
	await offer(
		'ufragLong',
		swap(/^a=ice-ufrag/, `a=ice-ufrag:${'a'.repeat(257)}`),
	);
	await offer('ufragBadChars', swap(/^a=ice-ufrag/, 'a=ice-ufrag:ab cd'));
	await offer('noSetup', drop(/^a=setup/));
	await offer('setupBad', swap(/^a=setup/, 'a=setup:nope'));
	await offer('setupActive', swap(/^a=setup/, 'a=setup:active'));
	await offer('setupPassive', swap(/^a=setup/, 'a=setup:passive'));
	await offer('setupHoldconn', swap(/^a=setup/, 'a=setup:holdconn'));
	await offer('noMid', drop(/^a=mid/));
	await offer('midEmpty', swap(/^a=mid/, 'a=mid:'));
	await offer('midOther', swap(/^a=mid/, 'a=mid:data'));
	await offer('noGroup', drop(/^a=group/));
	await offer('groupUnknownMid', swap(/^a=group/, 'a=group:BUNDLE 0 9'));
	await offer('groupOther', swap(/^a=group/, 'a=group:LS 0'));
	await offer('noSctpPort', drop(/^a=sctp-port/));
	await offer('sctpPortText', swap(/^a=sctp-port/, 'a=sctp-port:abc'));
	await offer('sctpPortBig', swap(/^a=sctp-port/, 'a=sctp-port:70000'));
	await offer('noMaxMessageSize', drop(/^a=max-message-size/));
	await offer(
		'maxMessageSizeText',
		swap(/^a=max-message-size/, 'a=max-message-size:abc'),
	);
	await offer(
		'maxMessageSizeZero',
		swap(/^a=max-message-size/, 'a=max-message-size:0'),
	);
	await offer('noConnection', drop(/^c=/));
	await offer('connectionBad', swap(/^c=/, 'c=IN IP4'));
	await offer('connectionV6', swap(/^c=/, 'c=IN IP6 ::1'));
	await offer('connectionName', swap(/^c=/, 'c=IN IP4 example.com'));
	await offer('mediaShort', swap(/^m=/, 'm=application 9'));
	await offer('mediaThree', swap(/^m=/, 'm=application 9 UDP/DTLS/SCTP'));
	await offer(
		'mediaPortText',
		swap(/^m=/, 'm=application x UDP/DTLS/SCTP webrtc-datachannel'),
	);
	await offer(
		'mediaPortZero',
		swap(/^m=/, 'm=application 0 UDP/DTLS/SCTP webrtc-datachannel'),
	);
	await offer(
		'mediaPortBig',
		swap(/^m=/, 'm=application 70000 UDP/DTLS/SCTP webrtc-datachannel'),
	);
	await offer(
		'mediaProtocolRtp',
		swap(/^m=/, 'm=application 9 RTP/SAVPF webrtc-datachannel'),
	);
	await offer(
		'mediaProtocolOld',
		swap(/^m=/, 'm=application 9 DTLS/SCTP 5000'),
	);
	await offer(
		'mediaProtocolTcp',
		swap(/^m=/, 'm=application 9 TCP/DTLS/SCTP webrtc-datachannel'),
	);
	await offer(
		'mediaProtocolBad',
		swap(/^m=/, 'm=application 9 NOPE webrtc-datachannel'),
	);
	await offer(
		'mediaFormatBad',
		swap(/^m=/, 'm=application 9 UDP/DTLS/SCTP nope'),
	);
	await offer(
		'mediaKindBad',
		swap(/^m=/, 'm=nope 9 UDP/DTLS/SCTP webrtc-datachannel'),
	);
	await offer(
		'mediaAudioNoCodecs',
		swap(/^m=/, 'm=audio 9 UDP/TLS/RTP/SAVPF 111'),
	);
	await offer('twoSections', (sdp) => {
		const at = sdp.indexOf('m=');
		return (
			sdp.slice(0, at).replace('BUNDLE 0', 'BUNDLE 0 1') +
			sdp.slice(at) +
			sdp.slice(at).replace('a=mid:0', 'a=mid:1')
		);
	});
	await offer('duplicateMid', (sdp) => {
		const at = sdp.indexOf('m=');
		return sdp + sdp.slice(at);
	});
	await offer('candidateGarbage', (sdp) => `${sdp}a=candidate:garbage\r\n`);
	await offer(
		'candidateShort',
		(sdp) => `${sdp}a=candidate:1 1 udp 1 1.2.3.4\r\n`,
	);
	await offer(
		'candidateGood',
		(sdp) => `${sdp}a=candidate:1 1 udp 2122260223 1.2.3.4 5 typ host\r\n`,
	);
	await offer(
		'candidateBadType',
		(sdp) => `${sdp}a=candidate:1 1 udp 2122260223 1.2.3.4 5 typ nope\r\n`,
	);
	await offer(
		'candidateBadProtocol',
		(sdp) => `${sdp}a=candidate:1 1 xyz 2122260223 1.2.3.4 5 typ host\r\n`,
	);
	await offer(
		'candidateBadPort',
		(sdp) => `${sdp}a=candidate:1 1 udp 2122260223 1.2.3.4 99999 typ host\r\n`,
	);
	await offer(
		'candidateName',
		(sdp) => `${sdp}a=candidate:1 1 udp 2122260223 example.com 5 typ host\r\n`,
	);
	await offer('endOfCandidates', (sdp) => `${sdp}a=end-of-candidates\r\n`);
	await offer('iceLite', (sdp) =>
		sdp.replace('s=-\r\n', 's=-\r\na=ice-lite\r\n'),
	);
	await offer('iceOptionsBad', swap(/^a=ice-options/, 'a=ice-options:'));
	await offer('long', (sdp) => `${sdp}a=x:${'y'.repeat(70000)}\r\n`);
	// in other states
	const localOffer = async (pc) => {
		pc.createDataChannel('x');
		await pc.setLocalDescription();
	};
	const asAnswer = (sdp) => sdp.replace('a=setup:actpass', 'a=setup:active');
	await remote('offerOnLocalOffer', [{ type: 'offer', sdp: base }], localOffer);
	await remote(
		'answerGood',
		[{ type: 'answer', sdp: asAnswer(base) }],
		localOffer,
	);
	await remote(
		'pranswerGood',
		[{ type: 'pranswer', sdp: asAnswer(base) }],
		localOffer,
	);
	await remote('answerActpass', [{ type: 'answer', sdp: base }], localOffer);
	await remote(
		'answerGarbage',
		[{ type: 'answer', sdp: 'nonsense' }],
		localOffer,
	);
	await remote(
		'answerNoSections',
		[
			{
				type: 'answer',
				sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
			},
		],
		localOffer,
	);
	await remote(
		'answerTwoSections',
		[
			{
				type: 'answer',
				sdp: (() => {
					const sdp = asAnswer(base);
					const at = sdp.indexOf('m=');
					return (
						sdp.slice(0, at).replace('BUNDLE 0', 'BUNDLE 0 1') +
						sdp.slice(at) +
						sdp.slice(at).replace('a=mid:0', 'a=mid:1')
					);
				})(),
			},
		],
		localOffer,
	);
	await remote(
		'answerOtherMid',
		[
			{
				type: 'answer',
				sdp: asAnswer(base)
					.replace('a=mid:0', 'a=mid:9')
					.replace('BUNDLE 0', 'BUNDLE 9'),
			},
		],
		localOffer,
	);
	await remote(
		'answerAudio',
		[
			{
				type: 'answer',
				sdp: asAnswer(base).replace(/^m=.*$/m, 'm=audio 9 UDP/TLS/RTP/SAVPF 0'),
			},
		],
		localOffer,
	);
	await remote(
		'answerNoFingerprint',
		[{ type: 'answer', sdp: drop(/^a=fingerprint/)(asAnswer(base)) }],
		localOffer,
	);
	await remote(
		'answerRejected',
		[
			{
				type: 'answer',
				sdp: asAnswer(base).replace(/^m=application 9/m, 'm=application 0'),
			},
		],
		localOffer,
	);
	await remote('rollbackLocalOffer', [{ type: 'rollback' }], localOffer);
	await remote('rollbackRemoteOffer', [{ type: 'rollback' }], (pc) =>
		pc.setRemoteDescription({ type: 'offer', sdp: base }),
	);
	await remote('offerTwice', [{ type: 'offer', sdp: base }], (pc) =>
		pc.setRemoteDescription({ type: 'offer', sdp: base }),
	);
	await remote(
		'answerOnRemoteOffer',
		[{ type: 'answer', sdp: asAnswer(base) }],
		(pc) => pc.setRemoteDescription({ type: 'offer', sdp: base }),
	);
	await remote('closed', [{ type: 'offer', sdp: base }], (pc) => pc.close());
	await remote('closedGarbage', [{ type: 'offer', sdp: 'nonsense' }], (pc) =>
		pc.close(),
	);
	await remote('closedNoType', [{}], (pc) => pc.close());
	await remote('closedNone', [], (pc) => pc.close());
	await remote(
		'reofferFewerSections',
		[
			{
				type: 'offer',
				sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
			},
		],
		async (pc) => {
			await pc.setRemoteDescription({ type: 'offer', sdp: base });
			await pc.setLocalDescription();
		},
	);
	await remote(
		'reofferOtherCredentials',
		[
			{
				type: 'offer',
				sdp: base
					.replace(/a=ice-ufrag:.*/, 'a=ice-ufrag:abcd')
					.replace(/a=ice-pwd:.*/, 'a=ice-pwd:0123456789012345678901234'),
			},
		],
		async (pc) => {
			await pc.setRemoteDescription({ type: 'offer', sdp: base });
			await pc.setLocalDescription();
		},
	);
	await remote(
		'reofferOtherFingerprint',
		[
			{
				type: 'offer',
				sdp: base.replace(
					/a=fingerprint:sha-256 ../,
					'a=fingerprint:sha-256 00',
				),
			},
		],
		async (pc) => {
			await pc.setRemoteDescription({ type: 'offer', sdp: base });
			await pc.setLocalDescription();
		},
	);
	// legacy callbacks
	await settle(
		'remote',
		'legacyFailure',
		() =>
			new Promise((resolve) => {
				const pc = new RTCPeerConnection();
				let returned = 'not yet returned';
				returned = pc.setRemoteDescription(
					{ type: 'offer', sdp: 'nonsense' },
					() => resolve('success'),
					(error) => {
						const sync = returned;
						setTimeout(() => {
							resolve([show(error), String(sync), String(returned)]);
							pc.close();
						}, 50);
					},
				);
			}),
	);

	// --- candidates ---
	const line = `candidate:7 1 udp 2122260223 192.0.2.1 ${env.sink} typ host generation 0`;
	const candidate = (name, args, prepare) =>
		settle('candidate', name, async () => {
			const pc = new RTCPeerConnection();
			try {
				if (prepare !== null)
					await (
						prepare ??
						((pc) => pc.setRemoteDescription({ type: 'offer', sdp: base }))
					)(pc);
				await pc.addIceCandidate(...args);
				return pc.remoteDescription?.sdp
					.split('\r\n')
					.filter((l) => l.startsWith('a=candidate') || l.startsWith('a=end'));
			} finally {
				pc.close();
			}
		});
	await candidate('none', []);
	await candidate('undefined', [undefined]);
	await candidate('null', [null]);
	await candidate('number', [5]);
	await candidate('string', ['x']);
	await candidate('empty', [{}]);
	await candidate('emptyCandidate', [{ candidate: '' }]);
	await candidate('emptyCandidateMid', [{ candidate: '', sdpMid: '0' }]);
	await candidate('emptyCandidateBadMid', [{ candidate: '', sdpMid: '9' }]);
	await candidate('emptyCandidateBadIndex', [
		{ candidate: '', sdpMLineIndex: 9 },
	]);
	await candidate('nullCandidate', [{ candidate: null, sdpMid: '0' }]);
	await candidate('undefinedCandidate', [
		{ candidate: undefined, sdpMid: '0' },
	]);
	await candidate('midOnly', [{ sdpMid: '0' }]);
	await candidate('noSection', [{ candidate: line }]);
	await candidate('nullSection', [
		{ candidate: line, sdpMid: null, sdpMLineIndex: null },
	]);
	await candidate('mid', [{ candidate: line, sdpMid: '0' }]);
	await candidate('index', [{ candidate: line, sdpMLineIndex: 0 }]);
	await candidate('both', [{ candidate: line, sdpMid: '0', sdpMLineIndex: 0 }]);
	await candidate('midWins', [
		{ candidate: line, sdpMid: '0', sdpMLineIndex: 7 },
	]);
	await candidate('badMidGoodIndex', [
		{ candidate: line, sdpMid: '9', sdpMLineIndex: 0 },
	]);
	await candidate('wrongMid', [{ candidate: line, sdpMid: '9' }]);
	await candidate('emptyMid', [{ candidate: line, sdpMid: '' }]);
	await candidate('wrongIndex', [{ candidate: line, sdpMLineIndex: 5 }]);
	await candidate('negativeIndex', [{ candidate: line, sdpMLineIndex: -1 }]);
	await candidate('wrappedIndex', [{ candidate: line, sdpMLineIndex: 65536 }]);
	await candidate('textIndex', [{ candidate: line, sdpMLineIndex: 'x' }]);
	await candidate('numberMid', [{ candidate: line, sdpMid: 0 }]);
	await candidate('prefixed', [{ candidate: `a=${line}`, sdpMid: '0' }]);
	await candidate('prefixedCrlf', [
		{ candidate: `a=${line}\r\n`, sdpMid: '0' },
	]);
	await candidate('trailingSpace', [{ candidate: `${line} `, sdpMid: '0' }]);
	await candidate('garbage', [{ candidate: 'garbage', sdpMid: '0' }]);
	await candidate('candidateGarbage', [
		{ candidate: 'candidate:garbage', sdpMid: '0' },
	]);
	await candidate('short', [
		{ candidate: 'candidate:1 1 udp 1 1.2.3.4', sdpMid: '0' },
	]);
	await candidate('noTyp', [
		{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 host', sdpMid: '0' },
	]);
	await candidate('badType', [
		{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ nope', sdpMid: '0' },
	]);
	await candidate('badProtocol', [
		{ candidate: 'candidate:1 1 xyz 1 1.2.3.4 5 typ host', sdpMid: '0' },
	]);
	await candidate('upperProtocol', [
		{ candidate: 'candidate:1 1 UDP 1 1.2.3.4 5 typ host', sdpMid: '0' },
	]);
	await candidate('badPort', [
		{ candidate: 'candidate:1 1 udp 1 1.2.3.4 99999 typ host', sdpMid: '0' },
	]);
	await candidate('textPort', [
		{ candidate: 'candidate:1 1 udp 1 1.2.3.4 x typ host', sdpMid: '0' },
	]);
	await candidate('badPriority', [
		{ candidate: 'candidate:1 1 udp x 1.2.3.4 5 typ host', sdpMid: '0' },
	]);
	await candidate('bigPriority', [
		{
			candidate: 'candidate:1 1 udp 99999999999 1.2.3.4 5 typ host',
			sdpMid: '0',
		},
	]);
	await candidate('badComponent', [
		{ candidate: 'candidate:1 x udp 1 1.2.3.4 5 typ host', sdpMid: '0' },
	]);
	await candidate('component2', [
		{ candidate: 'candidate:1 2 udp 1 1.2.3.4 5 typ host', sdpMid: '0' },
	]);
	await candidate('component3', [
		{ candidate: 'candidate:1 3 udp 1 1.2.3.4 5 typ host', sdpMid: '0' },
	]);
	await candidate('longFoundation', [
		{
			candidate: `candidate:${'f'.repeat(40)} 1 udp 1 1.2.3.4 5 typ host`,
			sdpMid: '0',
		},
	]);
	await candidate('name', [
		{ candidate: 'candidate:1 1 udp 1 example.com 5 typ host', sdpMid: '0' },
	]);
	await candidate('tcpNoType', [
		{ candidate: 'candidate:1 1 tcp 1 1.2.3.4 5 typ host', sdpMid: '0' },
	]);
	await candidate('tcpPassive', [
		{
			candidate: 'candidate:1 1 tcp 1 1.2.3.4 5 typ host tcptype passive',
			sdpMid: '0',
		},
	]);
	await candidate('tcpActive', [
		{
			candidate: 'candidate:1 1 tcp 1 1.2.3.4 9 typ host tcptype active',
			sdpMid: '0',
		},
	]);
	await candidate('tcpBadType', [
		{
			candidate: 'candidate:1 1 tcp 1 1.2.3.4 5 typ host tcptype nope',
			sdpMid: '0',
		},
	]);
	await candidate('ssltcp', [
		{ candidate: 'candidate:1 1 ssltcp 1 1.2.3.4 5 typ host', sdpMid: '0' },
	]);
	await candidate('srflxNoRelated', [
		{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ srflx', sdpMid: '0' },
	]);
	await candidate('srflxRelated', [
		{
			candidate:
				'candidate:1 1 udp 1 1.2.3.4 5 typ srflx raddr 5.6.7.8 rport 9',
			sdpMid: '0',
		},
	]);
	await candidate('relatedHalf', [
		{
			candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ srflx raddr 5.6.7.8',
			sdpMid: '0',
		},
	]);
	await candidate('extension', [
		{
			candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host foo bar',
			sdpMid: '0',
		},
	]);
	await candidate('extensionOdd', [
		{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host foo', sdpMid: '0' },
	]);
	await candidate('generationText', [
		{
			candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host generation x',
			sdpMid: '0',
		},
	]);
	await candidate('ufragOther', [
		{ candidate: line, sdpMid: '0', usernameFragment: 'nope' },
	]);
	await candidate('ufragInLine', [
		{ candidate: `${line} ufrag nope`, sdpMid: '0' },
	]);
	await candidate('ufragNull', [
		{ candidate: line, sdpMid: '0', usernameFragment: null },
	]);
	await candidate('v6', [
		{ candidate: 'candidate:1 1 udp 1 2001:db8::1 5 typ host', sdpMid: '0' },
	]);
	await candidate('v6Bracket', [
		{ candidate: 'candidate:1 1 udp 1 [2001:db8::1] 5 typ host', sdpMid: '0' },
	]);
	await candidate('twice', [{ candidate: line, sdpMid: '0' }], async (pc) => {
		await pc.setRemoteDescription({ type: 'offer', sdp: base });
		await pc.addIceCandidate({ candidate: line, sdpMid: '0' });
	});
	await candidate('instance', [
		new RTCIceCandidate({ candidate: line, sdpMid: '0' }),
	]);
	await candidate('instanceBadMid', [
		new RTCIceCandidate({ candidate: line, sdpMid: '9' }),
	]);
	await candidate('beforeRemote', [{ candidate: line, sdpMid: '0' }], null);
	await candidate('beforeRemoteNoSection', [{ candidate: line }], null);
	await candidate(
		'beforeRemoteGarbage',
		[{ candidate: 'garbage', sdpMid: '0' }],
		null,
	);
	await candidate('beforeRemoteEnd', [{ candidate: '', sdpMid: '0' }], null);
	await candidate('beforeRemoteNone', [], null);
	await candidate('beforeRemoteNull', [null], null);
	await candidate('closed', [{ candidate: line, sdpMid: '0' }], async (pc) => {
		await pc.setRemoteDescription({ type: 'offer', sdp: base });
		pc.close();
	});
	await candidate('closedGarbage', [{ candidate: 'garbage' }], (pc) =>
		pc.close(),
	);
	await settle(
		'candidate',
		'legacyFailure',
		() =>
			new Promise((resolve) => {
				const pc = new RTCPeerConnection();
				let returned = 'not yet returned';
				returned = pc.addIceCandidate(
					{ candidate: line, sdpMid: '0' },
					() => resolve('success'),
					(error) => {
						const sync = returned;
						setTimeout(() => {
							resolve([show(error), String(sync), String(returned)]);
							pc.close();
						}, 50);
					},
				);
			}),
	);

	// --- channels ---
	const channel = (name, args, prepare) =>
		attempt('channel', name, () => {
			const pc = new RTCPeerConnection();
			try {
				prepare?.(pc);
				const made = pc.createDataChannel(...args);
				return {
					label: made.label,
					ordered: made.ordered,
					maxPacketLifeTime: made.maxPacketLifeTime,
					maxRetransmits: made.maxRetransmits,
					protocol: made.protocol,
					negotiated: made.negotiated,
					id: made.id,
					priority: made.priority,
					readyState: made.readyState,
				};
			} finally {
				pc.close();
			}
		});
	channel('none', []);
	channel('label', ['x']);
	channel('labelUndefined', [undefined]);
	channel('labelNull', [null]);
	channel('labelNumber', [5]);
	channel('labelObject', [{}]);
	channel('labelEmpty', ['']);
	channel('labelUnpaired', ['\ud800']);
	channel('label65535', ['x'.repeat(65535)]);
	channel('label65536', ['x'.repeat(65536)]);
	channel('labelUtf8', ['é'.repeat(32768)]);
	channel('labelUtf8Ok', ['é'.repeat(32767)]);
	channel('initNull', ['x', null]);
	channel('initUndefined', ['x', undefined]);
	channel('initNumber', ['x', 5]);
	channel('initString', ['x', 'y']);
	channel('initArray', ['x', []]);
	channel('orderedFalse', ['x', { ordered: false }]);
	channel('orderedString', ['x', { ordered: 'false' }]);
	channel('orderedNull', ['x', { ordered: null }]);
	channel('protocol', ['x', { protocol: 'p' }]);
	channel('protocolNull', ['x', { protocol: null }]);
	channel('protocol65535', ['x', { protocol: 'p'.repeat(65535) }]);
	channel('protocol65536', ['x', { protocol: 'p'.repeat(65536) }]);
	channel('both', ['x', { maxRetransmits: 1, maxPacketLifeTime: 1 }]);
	channel('bothNull', ['x', { maxRetransmits: null, maxPacketLifeTime: null }]);
	channel('bothOneNull', ['x', { maxRetransmits: 1, maxPacketLifeTime: null }]);
	channel('bothZero', ['x', { maxRetransmits: 0, maxPacketLifeTime: 0 }]);
	for (const key of ['maxRetransmits', 'maxPacketLifeTime', 'id'])
		for (const [name, value] of [
			['0', 0],
			['1', 1],
			['65535', 65535],
			['65536', 65536],
			['Negative', -1],
			['Fraction', 1.5],
			['String', '3'],
			['Text', 'x'],
			['NaN', NaN],
			['Null', null],
			['Undefined', undefined],
			['Object', {}],
			['1023', 1023],
			['1024', 1024],
			['65534', 65534],
		])
			channel(`${key}${name}`, [
				'x',
				key === 'id' ? { negotiated: true, id: value } : { [key]: value },
			]);
	channel('idNotNegotiated', ['x', { id: 5 }]);
	channel('idBadNotNegotiated', ['x', { id: 70000 }]);
	channel('negotiatedNoId', ['x', { negotiated: true }]);
	channel('negotiatedFalseId', ['x', { negotiated: false, id: 5 }]);
	channel('negotiatedString', ['x', { negotiated: 'no', id: 5 }]);
	channel('duplicateId', ['x', { negotiated: true, id: 5 }], (pc) =>
		pc.createDataChannel('first', { negotiated: true, id: 5 }),
	);
	channel('priorityHigh', ['x', { priority: 'high' }]);
	channel('priorityBad', ['x', { priority: 'nope' }]);
	channel('closed', ['x'], (pc) => pc.close());
	channel('closedNone', [], (pc) => pc.close());
	channel(
		'closedBad',
		['x', { maxRetransmits: 1, maxPacketLifeTime: 1 }],
		(pc) => pc.close(),
	);
	channel('closedRange', ['x', { maxRetransmits: 70000 }], (pc) => pc.close());
	attempt('channel', 'order', () => {
		const read = [];
		const init = new Proxy(
			{},
			{
				get(target, key) {
					read.push(String(key));
					return undefined;
				},
			},
		);
		const pc = new RTCPeerConnection();
		pc.createDataChannel('x', init);
		pc.close();
		return read;
	});
	// what a channel's own members refuse
	{
		const pc = new RTCPeerConnection();
		const made = pc.createDataChannel('x');
		attempt('channel', 'sendConnecting', () => made.send('x'));
		attempt('channel', 'sendNone', () => made.send());
		attempt('channel', 'binaryTypeBad', () => {
			made.binaryType = 'nope';
			return made.binaryType;
		});
		attempt('channel', 'binaryTypeBlob', () => {
			made.binaryType = 'blob';
			return made.binaryType;
		});
		attempt('channel', 'thresholdText', () => {
			made.bufferedAmountLowThreshold = 'x';
			return made.bufferedAmountLowThreshold;
		});
		attempt('channel', 'thresholdNegative', () => {
			made.bufferedAmountLowThreshold = -1;
			return made.bufferedAmountLowThreshold;
		});
		attempt('channel', 'thresholdBig', () => {
			made.bufferedAmountLowThreshold = 2 ** 32 + 5;
			return made.bufferedAmountLowThreshold;
		});
		pc.close();
		attempt('channel', 'sendClosed', () => made.send('x'));
		attempt('channel', 'closeClosed', () => made.close());
	}
	// many channels on one connection: the ids a negotiated one may take
	attempt('channel', 'many', () => {
		const pc = new RTCPeerConnection();
		const results = [];
		try {
			for (const id of [0, 1022, 1023, 1024, 2000, 65534])
				try {
					results.push([
						id,
						pc.createDataChannel('x', { negotiated: true, id }).id,
					]);
				} catch (error) {
					results.push([id, show(error)]);
				}
		} finally {
			pc.close();
		}
		return results;
	});
	other.close();
	// the other operations on a closed connection
	out.closed = {};
	for (const [name, call] of [
		['createOffer', (pc) => pc.createOffer()],
		['createAnswer', (pc) => pc.createAnswer()],
		['setLocalDescription', (pc) => pc.setLocalDescription()],
		['setLocalRollback', (pc) => pc.setLocalDescription({ type: 'rollback' })],
		['getStats', async (pc) => (await pc.getStats()).size >= 0],
	])
		await settle('closed', name, async () => {
			const pc = new RTCPeerConnection();
			pc.close();
			return call(pc);
		});
	return out;
};

// ICE server URLs, and setConfiguration where the URL is what is wrong
window.__rtcUrls = async (env) => {
	const out = {};
	const urls = [
		'stun:h:12abc',
		'stun:h:abc',
		'stun:h: 80',
		'stun:h:+80',
		'stun:h:0x50',
		'stun:h:080',
		'stun:h:1e3',
		'stun:h:65535',
		'stun:h:65536',
		'stun:h:99999999999',
		'stun:h:-0',
		'stun:h:1:2',
		'stun:h_x',
		'stun:h%41',
		'stun:h-x.',
		'stun:.',
		'stun:-',
		'stun:h..x',
		'stun:[::1]x',
		'stun:[::1]:',
		'stun:[::1]:x',
		'stun:[::1]:0',
		'stun:[]',
		'stun:[]:5',
		'stun:[x]',
		'stun:[::1]5',
		'stun:a]b',
		'stun:[a]b]:5',
		'STUN:h',
		'Stun:H',
		' stun:h ',
		'st\tun:h',
		'stun:h\n',
		'stun:h é',
		'stun:é',
		'stun:h?',
		'stun:h?x',
		'stun:h#',
		'stun:h#x',
		'stun://h',
		'stun:/h',
		'stun:h/',
		'stun:h\\',
		'stun:h:5?transport=udp',
		'stun:h@',
		'stun:@h',
		'stun:u:p@h',
		'turn:h?transport=udp',
		'turn:h?transport=tcp',
		'turn:h?transport=tls',
		'turn:h?transport=ssltcp',
		'turn:h?transport=UDP',
		'turn:h?transport=udp=x',
		'turn:h?transport',
		'turn:h?transport=udp&x=y',
		'turn:h?x=y&transport=udp',
		'turn:h?Transport=udp',
		'turn:h?transport=udp#f',
		'turn:h??transport=udp',
		'turn:h?transport=udp?',
		'turn:h?=udp',
		'turn:?transport=udp',
		'turn:h:?transport=udp',
		'turns:h?transport=udp',
		'turns:h:0',
		'turn:h?transport=%75dp',
		'turn:h ?transport=udp',
		'turn:[::1]?transport=tcp',
		'stuns:h',
		'stuns:h?transport=tcp',
		'stun:h:5:6',
		'stun:1.2.3',
		'stun:256.1.1.1',
		'stun:h:00005',
		'stun:h:5 ',
		'stun:%68',
		'stun:h%',
		'stun:h|',
		'stun:h"',
		'stun:h<',
		'stun:h`',
		'stun:h{',
		'stun:h\u007f',
		'stun:h\u0001',
		'turn:h?transport=',
		'turn:h?transport=udp=',
		'turn:h?=',
		'turn:h?transport==udp',
		'stun:h:',
		'stun::5',
		'stun:',
		'stun: ',
		'stun:h:5:',
		'data:x',
		'about:blank',
		'ws://h',
		'stun',
		':',
		'stun:h:٣',
	];
	for (const url of urls) {
		try {
			const pc = new RTCPeerConnection({
				iceServers: [{ urls: url, username: 'u', credential: 'p' }],
			});
			out[url] =
				`ok ${JSON.stringify(pc.getConfiguration().iceServers[0].urls)}`;
			pc.close();
		} catch (error) {
			out[url] =
				`${error.name}: ${error.message.replace("Failed to construct 'RTCPeerConnection': ", '')}`;
		}
	}
	const set = {};
	const attempt = (name, make, config) => {
		const pc = new RTCPeerConnection(make);
		try {
			pc.setConfiguration(config);
			set[name] = `ok ${JSON.stringify(pc.getConfiguration())}`;
		} catch (error) {
			set[name] = `${error.name}: ${error.message}`;
		}
		pc.close();
	};
	attempt(
		'emptyUsername',
		{},
		{ iceServers: [{ urls: 'turn:h', username: '', credential: 'p' }] },
	);
	attempt(
		'longUsername',
		{},
		{
			iceServers: [
				{ urls: 'turn:h', username: 'u'.repeat(600), credential: 'p' },
			],
		},
	);
	attempt('badPort', {}, { iceServers: [{ urls: 'stun:h:0' }] });
	attempt('badHost', {}, { iceServers: [{ urls: 'stun:h/' }] });
	attempt('emptyUrls', {}, { iceServers: [{ urls: [] }] });
	attempt(
		'transportBad',
		{},
		{
			iceServers: [
				{ urls: 'turn:h?transport=x', username: 'u', credential: 'p' },
			],
		},
	);
	attempt('certificatesEmpty', {}, { certificates: [] });
	attempt('certificatesUndefined', {}, { certificates: undefined });
	attempt(
		'bundleAndBadUrl',
		{},
		{ bundlePolicy: 'max-bundle', iceServers: [{ urls: 'stun:h:0' }] },
	);
	attempt(
		'bundleAndHttp',
		{},
		{ bundlePolicy: 'max-bundle', iceServers: [{ urls: 'http://x' }] },
	);
	attempt('alwaysNegotiate', {}, { alwaysNegotiateDataChannels: true });
	attempt('encoded', {}, { encodedInsertableStreams: true });
	attempt(
		'encodedSame',
		{ encodedInsertableStreams: true },
		{ encodedInsertableStreams: true },
	);
	attempt('transports', {}, { iceTransports: 'relay' });
	attempt(
		'poolOnly',
		{
			iceServers: [{ urls: 'stun:a' }],
			iceTransportPolicy: 'relay',
			iceCandidatePoolSize: 2,
		},
		{},
	);
	// lengths
	for (const n of [508, 509, 510, 511, 512, 513]) {
		try {
			new RTCPeerConnection({
				iceServers: [
					{ urls: 'turn:h', username: 'u'.repeat(n), credential: 'p' },
				],
			}).close();
			set[`username${n}`] = 'ok';
		} catch (error) {
			set[`username${n}`] = error.message;
		}
	}
	try {
		new RTCPeerConnection({
			iceServers: [
				{ urls: 'turn:h', username: 'é'.repeat(255), credential: 'p' },
			],
		}).close();
		set.usernameUtf8 = 'ok';
	} catch (error) {
		set.usernameUtf8 = error.message;
	}
	return { urls: out, set };
};

// offers Chrome takes that are not what it writes itself: the answer to
// each, the states on the way and the next offer, with what is random masked
window.__rtcAnswers = async () => {
	const out = {};
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const mask = (sdp) =>
		sdp
			.replace(/^o=- \d+ (\d+)/m, 'o=- N $1')
			.replace(/^a=candidate:.*\r\n/gm, '')
			// the default candidate's port and address, where one is shown
			.replace(/^(m=\w+) [1-9]\d*/gm, '$1 9')
			.replace(/^c=.*$/gm, 'c=IN IP4 0.0.0.0')
			.replace(/^a=ice-ufrag:.*$/gm, 'a=ice-ufrag:U')
			.replace(/^a=ice-pwd:.*$/gm, 'a=ice-pwd:P')
			.replace(/^a=fingerprint:sha-256 .*$/gm, 'a=fingerprint:sha-256 F');
	const attempt = async (name, run, gathering = true) => {
		const pc = new RTCPeerConnection();
		const entry = (out[name] = { events: [] });
		pc.ondatachannel = () => entry.events.push('datachannel');
		pc.onnegotiationneeded = () => entry.events.push('negotiationneeded');
		pc.onsignalingstatechange = () => entry.events.push(pc.signalingState);
		if (gathering)
			pc.onicegatheringstatechange = () =>
				entry.events.push(pc.iceGatheringState);
		try {
			await run(pc, entry);
		} catch (error) {
			entry.error = `${error.name}: ${error.message}`;
		}
		await wait(50);
		pc.close();
	};
	await attempt('emptyOffer', async (pc, entry) => {
		const offer = await pc.createOffer();
		entry.offer = mask(offer.sdp);
		await pc.setLocalDescription(offer);
		await wait(200);
		entry.state = [pc.signalingState, pc.iceGatheringState];
		await pc.setRemoteDescription({
			type: 'answer',
			sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
		});
		entry.after = [pc.signalingState, pc.iceGatheringState];
	});
	const maker = new RTCPeerConnection();
	maker.createDataChannel('x');
	const base = (await maker.createOffer()).sdp;
	maker.close();
	out.base = mask(base);
	const drop = (pattern) => (sdp) =>
		sdp
			.split('\r\n')
			.filter((line) => !pattern.test(line))
			.join('\r\n');
	const swap = (pattern, text) => (sdp) =>
		sdp
			.split('\r\n')
			.map((line) => (pattern.test(line) ? text : line))
			.join('\r\n');
	const variants = {
		good: (sdp) => sdp,
		lf: (sdp) => sdp.replace(/\r\n/g, '\n'),
		sessionOnly: () => 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
		originText: () => 'v=0\r\no=- a b IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
		timeShort: () => 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0\r\n',
		noMid: drop(/^a=mid/),
		midEmpty: swap(/^a=mid/, 'a=mid:'),
		noGroup: drop(/^a=group/),
		groupOther: swap(/^a=group/, 'a=group:LS 0'),
		noTrickle: drop(/^a=ice-options/),
		optionsOther: swap(/^a=ice-options/, 'a=ice-options:renomination'),
		mediaProtocolTcp: swap(
			/^m=/,
			'm=application 9 TCP/DTLS/SCTP webrtc-datachannel',
		),
	};
	for (const [name, make] of Object.entries(variants))
		await attempt(`offer.${name}`, async (pc, entry) => {
			await pc.setRemoteDescription({ type: 'offer', sdp: make(base) });
			entry.trickle = pc.canTrickleIceCandidates;
			const answer = await pc.createAnswer();
			entry.answer = mask(answer.sdp);
			await pc.setLocalDescription(answer);
			entry.state = pc.signalingState;
			const channel = pc.createDataChannel('later');
			await wait(300);
			entry.later = channel.readyState;
			entry.again = mask((await pc.createOffer()).sdp);
			entry.gathering = pc.iceGatheringState;
		});
	// an offer over the connection's own offer takes that one back
	await attempt(
		'implicitRollback',
		async (pc, entry) => {
			const channel = pc.createDataChannel('mine');
			await pc.setLocalDescription();
			entry.events.push('remote offer');
			await pc.setRemoteDescription({ type: 'offer', sdp: base });
			entry.events.push('set');
			entry.local = [
				pc.pendingLocalDescription,
				pc.currentLocalDescription,
				pc.localDescription,
			];
			const answer = await pc.createAnswer();
			entry.answer = mask(answer.sdp);
			await pc.setLocalDescription(answer);
			await wait(300);
			entry.channel = channel.readyState;
			// Chrome gathers anew for the answer (the offer's transport went with
			// the offer); the stand-in keeps what it gathered: not compared
		},
		false,
	);
	return out;
};

// Chrome keeps no more than 500 connections in a renderer, closed ones
// included until they are collected: the next one is refused
window.__rtcMany = () => {
	const held = [];
	let refusal = 'none';
	try {
		while (held.length < 600) held.push(new RTCPeerConnection());
	} catch (error) {
		refusal = `${error.name}: ${error.message} ${error instanceof DOMException}`;
	}
	for (const pc of held) pc.close();
	let closed = 'made';
	try {
		new RTCPeerConnection().close();
	} catch (error) {
		closed = error.name;
	}
	return { made: held.length, refusal, closed };
};
window.__rtcOneMore = () => {
	try {
		new RTCPeerConnection().close();
		return 'made';
	} catch (error) {
		return `${error.name}: ${error.message}`;
	}
};
