// Every TLS server native Chrome reaches, STomp reaches; every one Chrome
// refuses, STomp refuses. Epoxy's TLS is rustls, which has no RSA key
// exchange and no CBC record protection, while Chrome 157 still offers
// TLS_RSA_WITH_AES_{128,256}_{GCM,CBC} and ECDHE_RSA_WITH_AES_{128,256}_CBC_SHA
// in its ClientHello: epoxy's Chrome-shaped hello offered them too, and a
// server that picked one failed with SelectedUnofferedCipherSuite (the site
// sweep, 2026-11-17: pro.ip-api.com, geoguessr's geolocation, and ad hosts).
//
// Each row is a server of the suite's own on loopback that offers one thing:
// one cipher suite, one protocol version, one signature algorithm, one key
// exchange group, a certificate with one key usage, or a session cache. A TCP
// front before it reads every ClientHello (the cipher suites, groups, key
// shares, signature algorithms and versions offered, and a second hello on
// the same connection, a HelloRetryRequest's answer) and the server notes the
// version and suite each handshake settled on and whether it resumed. Native
// Chrome loads each row (it takes the certificates by their keys,
// --ignore-certificate-errors-spki-list), then a proxied page does (epoxy
// trusts the test CA through pem_files), and each row's outcome must be
// native Chrome's: loaded or refused, resumed or not. STomp's ClientHello must
// offer what Chrome's offers. 3DES has no server in Node's OpenSSL, so those
// rows answer the hello with handshake_failure, as a 3DES-only server does to
// a client that offers none.
//
// Some rows are decided by Chrome's certificate verifier, which the key list
// overlooks: the SHA-1-signed leaf, and RSA key sizes. Chrome 157 refuses an
// RSA key under 1024 bits anywhere in the verified chain, the trust anchor
// included (ERR_CERT_WEAK_KEY), and BoringSSL parses none over 16384 bits
// (a decode_error), whatever the root. Those rows' native answer comes from a
// Chrome that trusts the test CAs in its own trust store (the profile's
// ServerCertificate database, as a user's added certificate is kept), so its
// real verifier answers with no system tool needed. The leaves of 8192 to
// 16392 bits are made per run with several primes each, which is quick, and
// only the suite's own server below uses them; a client sees just n and e.
//
// The hello-* rows are a TLS 1.2 server of the suite's own, written on
// node:crypto, whose ServerHello breaks one rule a client may check: a
// renegotiation_info that is not empty or not well formed, a server random
// that ends in a downgrade sentinel, no renegotiation_info or no extended
// master secret. Its control row must load natively, which shows the server
// is right.
//
// Last, the TLS session cache: a page's own EpoxyTransport makes requests to
// 5000 closed ports, and its wasm memory must grow no more than for as many
// to one port (an entry per port kept forever is unbounded memory); and after
// 1100 TLS 1.3 servers visited in order, revisits resume exactly where native
// Chrome's resume (its cache keeps 1024 entries, least recently used out).
import { execFileSync } from 'node:child_process';
import {
	constants,
	createCipheriv,
	createDecipheriv,
	createECDH,
	createHash,
	createHmac,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	generatePrime,
	privateDecrypt,
	randomBytes,
	sign,
	X509Certificate,
} from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer as createNet, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, done, launch, ok, OUT, PROXY } from '../lib.mjs';

const NATIVE_MS = 10000;
const PROXIED_MS = 15000;

// --- certificates: a test CA and leaves for 127.0.0.1 ------------------------
const work = mkdtempSync(join(tmpdir(), 'stomp-legacy-tls-'));
const openssl = (...args) =>
	execFileSync('openssl', args, { cwd: work, stdio: 'pipe' });

function caCert(name, keyArgs) {
	openssl(
		'req',
		'-x509',
		'-newkey',
		...keyArgs,
		'-nodes',
		'-keyout',
		`${name}.key`,
		'-out',
		`${name}.pem`,
		'-days',
		'2',
		'-subj',
		`/CN=STomp legacy TLS test ${name}`,
		'-addext',
		'basicConstraints=critical,CA:true',
		'-addext',
		'keyUsage=critical,keyCertSign,cRLSign',
	);
}

function leaf(name, ca, keyArgs, keyUsage, extensions = null) {
	openssl(
		'req',
		'-newkey',
		...keyArgs,
		'-nodes',
		'-keyout',
		`${name}.key`,
		'-out',
		`${name}.csr`,
		'-subj',
		`/CN=${name}`,
	);
	writeFileSync(
		join(work, `${name}.ext`),
		(
			extensions ?? [
				'subjectAltName=IP:127.0.0.1',
				'basicConstraints=CA:false',
				'extendedKeyUsage=serverAuth',
				...(keyUsage ? [`keyUsage=critical,${keyUsage}`] : []),
			]
		).join('\n'),
	);
	openssl(
		'x509',
		'-req',
		'-in',
		`${name}.csr`,
		'-CA',
		`${ca}.pem`,
		'-CAkey',
		`${ca}.key`,
		'-CAcreateserial',
		'-out',
		`${name}.pem`,
		'-days',
		'2',
		'-sha256',
		'-extfile',
		`${name}.ext`,
	);
	return {
		key: readFileSync(join(work, `${name}.key`)),
		cert: readFileSync(join(work, `${name}.pem`), 'utf8'),
	};
}

const RSA = ['rsa:2048'];
const P256 = ['ec', '-pkeyopt', 'ec_paramgen_curve:P-256'];
caCert('ca', P256);
caCert('rsaca', RSA);
const CA = readFileSync(join(work, 'ca.pem'), 'utf8');
const RSA_CA = readFileSync(join(work, 'rsaca.pem'), 'utf8');
const certs = {
	rsa: leaf('rsa', 'ca', RSA, 'digitalSignature,keyEncipherment'),
	rsaSign: leaf('rsaSign', 'ca', RSA, 'digitalSignature'),
	rsaEncipher: leaf('rsaEncipher', 'ca', RSA, 'keyEncipherment'),
	rsaAgree: leaf('rsaAgree', 'ca', RSA, 'keyAgreement'),
	ecdsa: leaf('ecdsa', 'ca', P256, 'digitalSignature'),
	ecdsaEncipher: leaf('ecdsaEncipher', 'ca', P256, 'keyEncipherment'),
	ecdsaAgree: leaf('ecdsaAgree', 'ca', P256, 'keyAgreement'),
	sha1: sha1Signed(leaf('sha1', 'rsaca', RSA, 'digitalSignature')),
};
// RSA leaves either side of 1024 bits, of 2048, and of 2048 rounded down to
// whole bytes (2041): one for RSA key exchange, one for ECDHE
const RSA_BITS = [1023, 1024, 2040, 2041, 2047, 2048];
for (const bits of RSA_BITS) {
	const size = [`rsa:${bits}`];
	certs[`rsa${bits}Encipher`] = leaf(
		`rsa${bits}Encipher`,
		'ca',
		size,
		'keyEncipherment',
	);
	certs[`rsa${bits}Sign`] = leaf(
		`rsa${bits}Sign`,
		'ca',
		size,
		'digitalSignature',
	);
}

// Chains around Chrome's 1024-bit floor, which holds for every key in the
// chain: an RSA intermediate of 1023 or 1024 bits under the P-256 CA, and an
// RSA root of 1023 or 1024 bits (trusted itself), each over a 2048-bit leaf
const CA_EXTENSIONS = [
	'basicConstraints=critical,CA:true',
	'keyUsage=critical,keyCertSign,cRLSign',
];
const CHAIN_BITS = [1023, 1024];
const ROOTS = {};
for (const bits of CHAIN_BITS) {
	const inter = leaf(`int${bits}`, 'ca', [`rsa:${bits}`], null, CA_EXTENSIONS);
	const leafUnder = leaf(
		`int${bits}Leaf`,
		`int${bits}`,
		RSA,
		'digitalSignature',
	);
	certs[`int${bits}Leaf`] = {
		key: leafUnder.key,
		cert: leafUnder.cert + inter.cert,
	};
	caCert(`root${bits}`, [`rsa:${bits}`]);
	ROOTS[bits] = readFileSync(join(work, `root${bits}.pem`), 'utf8');
	certs[`root${bits}Leaf`] = leaf(
		`root${bits}Leaf`,
		`root${bits}`,
		RSA,
		'digitalSignature',
	);
}

// --- RSA keys of 8192 to 16392 bits, quickly ---------------------------------
// openssl takes minutes for a 16384-bit key (and gives 16384 bits when asked
// for 16385), so these are products of 1024-bit primes and a last one that
// makes the size exact. Only the suite's own server holds them, doing its
// RSA operations by the Chinese remainder theorem on BigInts.
const bitLength = (x) => x.toString(2).length;
const modPow = (base, exponent, modulus) => {
	let result = 1n;
	for (base %= modulus; exponent > 0n; exponent >>= 1n) {
		if (exponent & 1n) result = (result * base) % modulus;
		base = (base * base) % modulus;
	}
	return result;
};
const modInverse = (a, m) => {
	let [r0, r1, s0, s1] = [a % m, m, 1n, 0n];
	while (r1) {
		const q = r0 / r1;
		[r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
	}
	return ((s0 % m) + m) % m;
};
const toBytes = (x, length) =>
	Buffer.from(x.toString(16).padStart(length * 2, '0'), 'hex');
const toBig = (bytes) => BigInt(`0x${Buffer.from(bytes).toString('hex') || 0}`);
const prime = (bits) =>
	new Promise((resolve, reject) =>
		generatePrime(bits, { bigint: true }, (error, p) =>
			error ? reject(error) : resolve(p),
		),
	);

async function bigRsaKey(bits) {
	const e = 65537n;
	for (;;) {
		const count = Math.floor(bits / 1024) - 1;
		const primes = await Promise.all(
			Array.from({ length: count }, () => prime(1024)),
		);
		const product = primes.reduce((a, b) => a * b, 1n);
		primes.push(await prime(bits - bitLength(product) + 1));
		const n = product * primes.at(-1);
		if (
			bitLength(n) !== bits ||
			new Set(primes).size !== primes.length ||
			primes.some((p) => (p - 1n) % e === 0n)
		)
			continue;
		const parts = primes.map((p) => ({
			p,
			d: modInverse(e, p - 1n),
			c: (n / p) * modInverse((n / p) % p, p),
		}));
		const length = Math.ceil(bits / 8);
		return {
			bits,
			length,
			n,
			e,
			/** x^d mod n */
			private: (x) =>
				parts.reduce((m, { p, d, c }) => (m + modPow(x % p, d, p) * c) % n, 0n),
			publicPem: createPublicKey({
				key: {
					kty: 'RSA',
					n: toBytes(n, length).toString('base64url'),
					e: toBytes(e, 3).toString('base64url'),
				},
				format: 'jwk',
			}).export({ type: 'spki', format: 'pem' }),
		};
	}
}

/** a leaf under the P-256 CA for `key`, with no CSR (OpenSSL checks none over 16384 bits) */
function bigLeaf(name, key, keyUsage) {
	writeFileSync(join(work, `${name}.pub`), key.publicPem);
	writeFileSync(
		join(work, `${name}.ext`),
		[
			'subjectAltName=IP:127.0.0.1',
			'basicConstraints=CA:false',
			'extendedKeyUsage=serverAuth',
			`keyUsage=critical,${keyUsage}`,
		].join('\n'),
	);
	openssl(
		'x509',
		'-new',
		'-force_pubkey',
		`${name}.pub`,
		'-subj',
		`/CN=${name}`,
		'-CA',
		'ca.pem',
		'-CAkey',
		'ca.key',
		'-out',
		`${name}.pem`,
		'-days',
		'2',
		'-sha256',
		'-extfile',
		`${name}.ext`,
	);
	return { key, cert: readFileSync(join(work, `${name}.pem`), 'utf8') };
}

// either side of Chrome's 16384-bit ceiling, and 8192 and 8200 bits
const BIG_BITS = [8192, 8200, 16384, 16385, 16392];
const bigStarted = performance.now();
for (const key of await Promise.all(BIG_BITS.map(bigRsaKey))) {
	certs[`big${key.bits}Encipher`] = bigLeaf(
		`big${key.bits}Encipher`,
		key,
		'keyEncipherment',
	);
	certs[`big${key.bits}Sign`] = bigLeaf(
		`big${key.bits}Sign`,
		key,
		'digitalSignature',
	);
}
console.log(
	`RSA keys of ${BIG_BITS.join(', ')} bits made in ${Math.round(performance.now() - bigStarted)} ms`,
);

/**
 * The same leaf signed by the RSA CA with SHA-1: the openssl CLI of some
 * systems refuses to make one, so its sha256WithRSAEncryption OID (twice,
 * in the TBS and outside it) becomes sha1WithRSAEncryption, the same length,
 * and the TBS is signed again with Node's OpenSSL.
 */
function sha1Signed({ key, cert }) {
	const der = Buffer.from(new X509Certificate(cert).raw);
	const sha256 = Buffer.from('06092a864886f70d01010b', 'hex');
	const sha1 = Buffer.from('06092a864886f70d010105', 'hex');
	for (let i = der.indexOf(sha256); i >= 0; i = der.indexOf(sha256, i + 1))
		sha1.copy(der, i);
	// the outer SEQUENCE's header, then the TBS SEQUENCE: its length in DER
	const tbsStart = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
	const lenBytes = der[tbsStart + 1] & 0x80 ? der[tbsStart + 1] & 0x7f : 0;
	const tbsLen = lenBytes
		? der.readUIntBE(tbsStart + 2, lenBytes)
		: der[tbsStart + 1];
	const tbs = der.subarray(tbsStart, tbsStart + 2 + lenBytes + tbsLen);
	const signature = sign(
		'sha1',
		tbs,
		readFileSync(join(work, 'rsaca.key'), 'utf8'),
	);
	signature.copy(der, der.length - signature.length);
	const pem = `-----BEGIN CERTIFICATE-----\n${der
		.toString('base64')
		.replace(/.{64}/g, '$&\n')}\n-----END CERTIFICATE-----\n`;
	return { key, cert: pem.replace('\n\n', '\n') };
}

const spki = (pem) =>
	createHash('sha256')
		.update(
			new X509Certificate(pem).publicKey.export({
				type: 'spki',
				format: 'der',
			}),
		)
		.digest('base64');

// --- the rows ----------------------------------------------------------------
const TLS12 = { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' };
const TLS13 = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' };
const suite12 = (ciphers, cert = 'rsa', extra = {}) => ({
	cert,
	options: { ...TLS12, ciphers, ...extra },
});
const group13 = (ecdhCurve) => ({
	cert: 'ecdsa',
	options: { ...TLS13, ecdhCurve },
});
const NO_TICKET = { secureOptions: constants.SSL_OP_NO_TICKET };

/** id: { cert, options } (a Node TLS server), or { raw } (an alert) */
const ROWS = {
	// Chrome's TLS 1.2 suites
	'ecdhe-rsa-aes128-gcm': suite12('ECDHE-RSA-AES128-GCM-SHA256'),
	'ecdhe-ecdsa-aes128-gcm': suite12('ECDHE-ECDSA-AES128-GCM-SHA256', 'ecdsa'),
	'ecdhe-ecdsa-chacha20': suite12('ECDHE-ECDSA-CHACHA20-POLY1305', 'ecdsa'),
	'rsa-aes128-gcm': suite12('AES128-GCM-SHA256'),
	'rsa-aes256-gcm': suite12('AES256-GCM-SHA384'),
	'rsa-aes128-cbc': suite12('AES128-SHA'),
	'rsa-aes256-cbc': suite12('AES256-SHA'),
	'ecdhe-rsa-aes128-cbc': suite12('ECDHE-RSA-AES128-SHA'),
	'ecdhe-rsa-aes256-cbc': suite12('ECDHE-RSA-AES256-SHA'),
	// suites Chrome does not offer
	'rsa-aes128-cbc-sha256': suite12('AES128-SHA256'),
	'ecdhe-ecdsa-aes128-cbc': suite12('ECDHE-ECDSA-AES128-SHA', 'ecdsa'),
	'ecdhe-ecdsa-aes256-cbc': suite12('ECDHE-ECDSA-AES256-SHA', 'ecdsa'),
	'ecdhe-rsa-aes128-cbc-sha256': suite12('ECDHE-RSA-AES128-SHA256'),
	'dhe-rsa-aes128-gcm': suite12('DHE-RSA-AES128-GCM-SHA256', 'rsa', {
		dhparam: 'auto',
	}),
	'rsa-3des': { raw: 0x000a },
	'ecdhe-rsa-3des': { raw: 0xc012 },
	// protocol versions
	'tls1.0-only': {
		cert: 'rsa',
		options: {
			minVersion: 'TLSv1',
			maxVersion: 'TLSv1',
			ciphers: 'ECDHE-RSA-AES128-SHA:@SECLEVEL=0',
		},
	},
	'tls1.1-only': {
		cert: 'rsa',
		options: {
			minVersion: 'TLSv1.1',
			maxVersion: 'TLSv1.1',
			ciphers: 'ECDHE-RSA-AES128-SHA:@SECLEVEL=0',
		},
	},
	// the server's handshake signature
	'sig-rsa-sha1': suite12('ECDHE-RSA-AES128-GCM-SHA256:@SECLEVEL=0', 'rsa', {
		sigalgs: 'RSA+SHA1',
	}),
	'sig-ecdsa-sha1': suite12(
		'ECDHE-ECDSA-AES128-GCM-SHA256:@SECLEVEL=0',
		'ecdsa',
		{ sigalgs: 'ECDSA+SHA1' },
	),
	'sig-rsa-pss': suite12('ECDHE-RSA-AES128-GCM-SHA256', 'rsa', {
		sigalgs: 'rsa_pss_rsae_sha256',
	}),
	'sig-rsa-pkcs1': suite12('ECDHE-RSA-AES128-GCM-SHA256', 'rsa', {
		sigalgs: 'RSA+SHA256',
	}),
	'sig13-rsa-pss': { cert: 'rsa', options: { ...TLS13 } },
	// a leaf signed with SHA-1
	'cert-sha1': {
		cert: 'sha1',
		options: { ciphers: 'DEFAULT:@SECLEVEL=0' },
		verified: true,
	},
	// RSA leaf key sizes, for RSA key exchange (009c, keyEncipherment) and for
	// ECDHE_RSA (c02f, digitalSignature); the server takes any size
	...Object.fromEntries(
		RSA_BITS.flatMap((bits) => [
			[
				`rsa${bits}-rsa-kx`,
				{
					...suite12('AES128-GCM-SHA256:@SECLEVEL=0', `rsa${bits}Encipher`),
					verified: true,
				},
			],
			[
				`rsa${bits}-ecdhe`,
				{
					...suite12(
						'ECDHE-RSA-AES128-GCM-SHA256:@SECLEVEL=0',
						`rsa${bits}Sign`,
					),
					verified: true,
				},
			],
		]),
	),
	// RSA leaves at Chrome's ceiling, on the suite's own server (Node's takes
	// no ClientKeyExchange over 2048 bytes, a 16384-bit RSA key exchange's)
	...Object.fromEntries(
		BIG_BITS.flatMap((bits) => [
			[
				`rsa${bits}-rsa-kx`,
				{
					cert: `big${bits}Encipher`,
					hello: 'control',
					kx: 'rsa',
					verified: true,
				},
			],
			[
				`rsa${bits}-ecdhe`,
				{ cert: `big${bits}Sign`, hello: 'control', verified: true },
			],
		]),
	),
	// a 1023- or 1024-bit RSA intermediate, or root, over a 2048-bit leaf
	...Object.fromEntries(
		CHAIN_BITS.flatMap((bits) =>
			['int', 'root'].map((at) => [
				`chain-${at}${bits}`,
				{
					...suite12(
						'ECDHE-RSA-AES128-GCM-SHA256:@SECLEVEL=0',
						`${at}${bits}Leaf`,
					),
					verified: true,
				},
			]),
		),
	),
	// the suite's own TLS 1.2 server, its ServerHello varied
	'hello-control': { cert: 'rsa', hello: 'control' },
	'hello-ri-not-empty': { cert: 'rsa', hello: 'ri-not-empty' },
	'hello-ri-malformed': { cert: 'rsa', hello: 'ri-malformed' },
	'hello-no-ri': { cert: 'rsa', hello: 'no-ri' },
	'hello-downgrade-tls11': { cert: 'rsa', hello: 'downgrade-tls11' },
	'hello-downgrade-tls12': { cert: 'rsa', hello: 'downgrade-tls12' },
	'hello-downgrade-jdk11': { cert: 'rsa', hello: 'downgrade-jdk11' },
	'hello-no-ems': { cert: 'rsa', hello: 'no-ems' },
	// TLS 1.3 key exchange groups
	'group-p521': group13('P-521'),
	'group-x25519': group13('X25519'),
	'group-p256': group13('P-256'),
	'group-p384': group13('P-384'),
	'group-x25519mlkem768': group13('X25519MLKEM768'),
	// RSA key usage: encipherment for RSA key exchange, signature for ECDHE
	'ku-sign-rsa-kx': suite12('AES128-GCM-SHA256', 'rsaSign'),
	'ku-sign-ecdhe': suite12('ECDHE-RSA-AES128-GCM-SHA256', 'rsaSign'),
	'ku-encipher-rsa-kx': suite12('AES128-GCM-SHA256', 'rsaEncipher'),
	'ku-encipher-ecdhe': suite12('ECDHE-RSA-AES128-GCM-SHA256', 'rsaEncipher'),
	'ku-encipher-tls13': { cert: 'rsaEncipher', options: { ...TLS13 } },
	'ku-agree-tls13': { cert: 'rsaAgree', options: { ...TLS13 } },
	'ku-ecdsa-encipher-tls13': { cert: 'ecdsaEncipher', options: { ...TLS13 } },
	'ku-ecdsa-agree-tls13': { cert: 'ecdsaAgree', options: { ...TLS13 } },
	'ku-ecdsa-agree-ecdhe': suite12(
		'ECDHE-ECDSA-AES128-GCM-SHA256',
		'ecdsaAgree',
	),
	// session resumption: a second connection resumes the first's session
	'resume12-id-gcm': {
		...suite12('ECDHE-RSA-AES128-GCM-SHA256', 'rsa', NO_TICKET),
		resume: true,
	},
	'resume12-ticket-gcm': {
		...suite12('ECDHE-RSA-AES128-GCM-SHA256'),
		resume: true,
	},
	'resume12-id-rsa-cbc': {
		...suite12('AES128-SHA', 'rsa', NO_TICKET),
		resume: true,
	},
	'resume12-ticket-rsa-cbc': { ...suite12('AES128-SHA'), resume: true },
	'resume12-ticket-ecdhe-cbc': {
		...suite12('ECDHE-RSA-AES256-SHA'),
		resume: true,
	},
	'resume13-ticket': {
		cert: 'ecdsa',
		options: { ...TLS13 },
		resume: true,
	},
};

// The rows of the suites STomp adds: a 300 KB download and a 100 KB upload
// each cross many full-size records (a CBC record's padding and MAC differ
// with its length), and both must arrive byte for byte.
const BULK = [
	'rsa-aes128-gcm',
	'rsa-aes256-gcm',
	'rsa-aes128-cbc',
	'rsa-aes256-cbc',
	'ecdhe-rsa-aes128-cbc',
	'ecdhe-rsa-aes256-cbc',
];
const BIG = Buffer.alloc(300001);
for (let i = 0, x = 1; i < BIG.length; i++) {
	x = (x * 1103515245 + 12345) >>> 0;
	BIG[i] = x >>> 24;
}
const UPLOAD_LEN = 100003;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const BIG_HASH = sha256(BIG);
const UPLOAD_HASH = sha256(BIG.subarray(0, UPLOAD_LEN));

// --- ClientHello parsing -----------------------------------------------------
const grease = (v) =>
	(v & 0x0f0f) === 0x0a0a && v >> 8 === (v & 0xff) ? 'GREASE' : v;
const hex = (v) =>
	typeof v === 'number' ? v.toString(16).padStart(4, '0') : v;
const u16s = (buf, from, to) => {
	const out = [];
	for (let i = from; i + 1 < to; i += 2)
		out.push(hex(grease(buf.readUInt16BE(i))));
	return out;
};

/** a ClientHello handshake message's body (after its 4-byte header) */
function parseHello(body) {
	let p = 2 + 32;
	p += 1 + body[p];
	const suitesLen = body.readUInt16BE(p);
	const ciphers = u16s(body, p + 2, p + 2 + suitesLen);
	p += 2 + suitesLen;
	p += 1 + body[p];
	const hello = {
		legacyVersion: hex(body.readUInt16BE(0)),
		ciphers,
		groups: [],
		sigalgs: [],
		versions: [],
		keyShares: [],
		extensions: [],
	};
	if (p + 2 > body.length) return hello;
	const end = p + 2 + body.readUInt16BE(p);
	p += 2;
	while (p + 4 <= end) {
		const type = body.readUInt16BE(p);
		const len = body.readUInt16BE(p + 2);
		const data = body.subarray(p + 4, p + 4 + len);
		hello.extensions.push(hex(grease(type)));
		if (type === 0x000a) hello.groups = u16s(data, 2, 2 + data.readUInt16BE(0));
		if (type === 0x000d)
			hello.sigalgs = u16s(data, 2, 2 + data.readUInt16BE(0));
		if (type === 0x002b) hello.versions = u16s(data, 1, 1 + data[0]);
		if (type === 0x0033) {
			for (let q = 2; q + 4 <= data.length; q += 4 + data.readUInt16BE(q + 2))
				hello.keyShares.push(hex(grease(data.readUInt16BE(q))));
		}
		if (type === 0x0023) hello.ticket = len > 0 ? 'ticket' : 'empty';
		if (type === 0x0029) hello.psk = true;
		p += 4 + len;
	}
	hello.ems = hello.extensions.includes('0017');
	hello.etm = hello.extensions.includes('0016');
	return hello;
}

/**
 * Reads the client's plaintext handshake records off `chunks` as they come
 * and calls `onHello` for each ClientHello; stops at the first record that is
 * neither a handshake record holding a ClientHello nor ChangeCipherSpec.
 */
function helloReader(onHello) {
	let buf = Buffer.alloc(0);
	let reading = true;
	return (chunk) => {
		if (!reading) return;
		buf = Buffer.concat([buf, chunk]);
		while (reading && buf.length >= 5) {
			const len = buf.readUInt16BE(3);
			if (buf.length < 5 + len) return;
			const record = buf.subarray(5, 5 + len);
			const type = buf[0];
			buf = buf.subarray(5 + len);
			if (type === 20) continue;
			if (type !== 22 || record[0] !== 1) {
				reading = false;
				return;
			}
			try {
				onHello(parseHello(record.subarray(4)));
			} catch (error) {
				onHello({ error: String(error) });
			}
		}
	};
}

// --- a TLS 1.2 server of the suite's own ---------------------------------------
// ECDHE_RSA_WITH_AES_128_GCM_SHA256 over x25519 (P-256 for a client without
// it), the key exchange signed with rsa_pss_rsae_sha256, the extended master
// secret, AES-GCM records with an explicit nonce, and one HTTP/1.1 request
// answered. Its ServerHello is the variant's.
const u16 = (n) => Buffer.from([n >> 8, n & 0xff]);
const u24 = (n) => Buffer.from([n >> 16, (n >> 8) & 0xff, n & 0xff]);
const handshakeMessage = (type, body) =>
	Buffer.concat([Buffer.from([type]), u24(body.length), body]);
const extension = (type, data) =>
	Buffer.concat([u16(type), u16(data.length), data]);
const sha256Of = (parts) =>
	createHash('sha256').update(Buffer.concat(parts)).digest();

/** TLS 1.2's PRF over HMAC-SHA256 */
function prf(secret, label, seed, length) {
	const labelSeed = Buffer.concat([Buffer.from(label), seed]);
	const blocks = [];
	for (let a = labelSeed, size = 0; size < length;) {
		a = createHmac('sha256', secret).update(a).digest();
		blocks.push(
			createHmac('sha256', secret).update(a).update(labelSeed).digest(),
		);
		size += 32;
	}
	return Buffer.concat(blocks).subarray(0, length);
}

// the last 8 bytes of a server random: RFC 8446's TLS 1.1 and TLS 1.2
// sentinels, and the value JDK 11 sent by mistake, which BoringSSL refuses too
const SENTINELS = {
	'downgrade-tls11': '444f574e47524400',
	'downgrade-tls12': '444f574e47524401',
	'downgrade-jdk11': 'edbfb4a8c24710ff',
};

/** MGF1 over SHA-256 (RFC 8017) */
function mgf1(seed, length) {
	const blocks = [];
	for (let i = 0; i * 32 < length; i++) {
		const counter = Buffer.alloc(4);
		counter.writeUInt32BE(i);
		blocks.push(sha256Of([seed, counter]));
	}
	return Buffer.concat(blocks).subarray(0, length);
}

/** an rsa_pss_rsae_sha256 signature by a PEM key or one of the big keys */
function signPss(key, data) {
	if (!key.private)
		return sign('sha256', data, {
			key,
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		});
	// EMSA-PSS (RFC 8017 9.1.1), emBits = modBits - 1, a 32-byte salt
	const emBits = key.bits - 1;
	const emLength = Math.ceil(emBits / 8);
	const salt = randomBytes(32);
	const h = sha256Of([Buffer.alloc(8), sha256Of([data]), salt]);
	const db = Buffer.concat([
		Buffer.alloc(emLength - 32 - 32 - 2),
		Buffer.from([1]),
		salt,
	]);
	const mask = mgf1(h, db.length);
	for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
	db[0] &= 0xff >> (8 * emLength - emBits);
	const encoded = Buffer.concat([db, h, Buffer.from([0xbc])]);
	return toBytes(key.private(toBig(encoded)), key.length);
}

/** an RSA decryption with no padding removed, by a PEM key or a big key */
const rsaRaw = (key, data) =>
	key.private
		? toBytes(key.private(toBig(data)), key.length)
		: privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, data);

/**
 * One connection. `report` gets one entry: the handshake's (when the
 * client's Finished checks out) or { error } (the client's alert, or what
 * went wrong). `kx: 'rsa'` makes it TLS_RSA_WITH_AES_128_GCM_SHA256 instead:
 * Node's OpenSSL server takes no ClientKeyExchange over 2048 bytes, so a
 * 16384-bit RSA key exchange needs this one.
 */
function serveTls12(
	socket,
	{ key, cert, variant, kx = 'ecdhe', body, report },
) {
	const rsaKx = kx === 'rsa';
	const certDer = Buffer.from(new X509Certificate(cert).raw);
	let reported = false;
	const once = (entry) => {
		if (!reported) report(entry);
		reported = true;
	};
	let records = Buffer.alloc(0);
	let messages = Buffer.alloc(0);
	const transcript = [];
	let clientRandom = null;
	let serverRandom = null;
	let ems = false;
	let agree = null;
	let master = null;
	let keys = null;
	let readSeq = 0n;
	let writeSeq = 0n;
	let decrypting = false;
	let finished = false;
	let request = '';

	const record = (type, data) =>
		Buffer.concat([Buffer.from([type, 3, 3]), u16(data.length), data]);
	const seqBytes = (seq) => {
		const bytes = Buffer.alloc(8);
		bytes.writeBigUInt64BE(seq);
		return bytes;
	};
	const aad = (seq, type, length) =>
		Buffer.concat([seqBytes(seq), Buffer.from([type, 3, 3]), u16(length)]);
	const encrypt = (type, data) => {
		const explicit = seqBytes(writeSeq);
		const cipher = createCipheriv(
			'aes-128-gcm',
			keys.serverKey,
			Buffer.concat([keys.serverIv, explicit]),
		);
		cipher.setAAD(aad(writeSeq++, type, data.length));
		const sealed = Buffer.concat([cipher.update(data), cipher.final()]);
		return record(type, Buffer.concat([explicit, sealed, cipher.getAuthTag()]));
	};
	const decrypt = (type, payload) => {
		const sealed = payload.subarray(8, payload.length - 16);
		const decipher = createDecipheriv(
			'aes-128-gcm',
			keys.clientKey,
			Buffer.concat([keys.clientIv, payload.subarray(0, 8)]),
		);
		decipher.setAAD(aad(readSeq++, type, sealed.length));
		decipher.setAuthTag(payload.subarray(payload.length - 16));
		return Buffer.concat([decipher.update(sealed), decipher.final()]);
	};

	function onClientHello(message) {
		const hello = message.subarray(4);
		clientRandom = Buffer.from(hello.subarray(2, 34));
		let p = 34;
		p += 1 + hello[p];
		p += 2 + hello.readUInt16BE(p);
		p += 1 + hello[p];
		const groups = [];
		const end = p + 2 + hello.readUInt16BE(p);
		for (p += 2; p + 4 <= end; p += 4 + hello.readUInt16BE(p + 2)) {
			const type = hello.readUInt16BE(p);
			const data = hello.subarray(p + 4, p + 4 + hello.readUInt16BE(p + 2));
			if (type === 0x0017) ems = variant !== 'no-ems';
			if (type === 0x000a)
				for (let q = 2; q + 1 < 2 + data.readUInt16BE(0); q += 2)
					groups.push(data.readUInt16BE(q));
		}
		serverRandom = randomBytes(32);
		if (SENTINELS[variant])
			Buffer.from(SENTINELS[variant], 'hex').copy(serverRandom, 24);
		const extensions = [];
		if (variant === 'ri-not-empty')
			extensions.push(
				extension(0xff01, Buffer.concat([Buffer.from([12]), randomBytes(12)])),
			);
		// renegotiated_connection's length says 5, and 2 bytes follow
		else if (variant === 'ri-malformed')
			extensions.push(extension(0xff01, Buffer.from([5, 0, 0])));
		else if (variant !== 'no-ri')
			extensions.push(extension(0xff01, Buffer.from([0])));
		if (ems) extensions.push(extension(0x0017, Buffer.alloc(0)));
		const block = Buffer.concat(extensions);
		const serverHello = handshakeMessage(
			2,
			Buffer.concat([
				Buffer.from([3, 3]),
				serverRandom,
				Buffer.from([0]),
				u16(rsaKx ? 0x009c : 0xc02f),
				Buffer.from([0]),
				u16(block.length),
				block,
			]),
		);
		const certificate = handshakeMessage(
			11,
			Buffer.concat([u24(certDer.length + 3), u24(certDer.length), certDer]),
		);
		const helloDone = handshakeMessage(14, Buffer.alloc(0));
		if (rsaKx) {
			transcript.push(serverHello, certificate, helloDone);
			socket.write(
				record(22, Buffer.concat([serverHello, certificate, helloDone])),
			);
			return;
		}
		let group = 0x0017;
		let share;
		if (groups.includes(0x001d)) {
			group = 0x001d;
			const pair = generateKeyPairSync('x25519');
			share = Buffer.from(
				pair.publicKey.export({ format: 'jwk' }).x,
				'base64url',
			);
			agree = (peer) =>
				diffieHellman({
					privateKey: pair.privateKey,
					publicKey: createPublicKey({
						key: { kty: 'OKP', crv: 'X25519', x: peer.toString('base64url') },
						format: 'jwk',
					}),
				});
		} else {
			const ecdh = createECDH('prime256v1');
			share = ecdh.generateKeys();
			agree = (peer) => ecdh.computeSecret(peer);
		}
		const params = Buffer.concat([
			Buffer.from([3]),
			u16(group),
			Buffer.from([share.length]),
			share,
		]);
		const signature = signPss(
			key,
			Buffer.concat([clientRandom, serverRandom, params]),
		);
		const flight = [
			serverHello,
			certificate,
			handshakeMessage(
				12,
				Buffer.concat([params, u16(0x0804), u16(signature.length), signature]),
			),
			helloDone,
		];
		transcript.push(...flight);
		socket.write(record(22, Buffer.concat(flight)));
	}

	function onClientKeyExchange(message) {
		const exchange = message.subarray(4);
		let premaster;
		if (rsaKx) {
			// PKCS #1 v1.5 unpadded by hand, whatever Node's rules for
			// RSA_PKCS1_PADDING decryption: 00 02, nonzero bytes, 00, the premaster
			const encoded = rsaRaw(
				key,
				exchange.subarray(2, 2 + exchange.readUInt16BE(0)),
			);
			const at = encoded.length - 49;
			premaster =
				encoded[0] === 0 && encoded[1] === 2 && encoded[at] === 0
					? encoded.subarray(at + 1)
					: randomBytes(48);
		} else premaster = agree(exchange.subarray(1, 1 + exchange[0]));
		master = ems
			? prf(premaster, 'extended master secret', sha256Of(transcript), 48)
			: prf(
					premaster,
					'master secret',
					Buffer.concat([clientRandom, serverRandom]),
					48,
				);
		const block = prf(
			master,
			'key expansion',
			Buffer.concat([serverRandom, clientRandom]),
			40,
		);
		keys = {
			clientKey: block.subarray(0, 16),
			serverKey: block.subarray(16, 32),
			clientIv: block.subarray(32, 36),
			serverIv: block.subarray(36, 40),
		};
	}

	function onFinished(message) {
		const expected = prf(master, 'client finished', sha256Of(transcript), 12);
		if (!expected.equals(message.subarray(4)))
			throw new Error("the client's Finished does not check out");
		transcript.push(message);
		const verify = prf(master, 'server finished', sha256Of(transcript), 12);
		finished = true;
		once({
			version: 'TLSv1.2',
			cipher: rsaKx
				? 'TLS_RSA_WITH_AES_128_GCM_SHA256'
				: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
			reused: false,
			ems,
		});
		socket.write(
			Buffer.concat([
				record(20, Buffer.from([1])),
				encrypt(22, handshakeMessage(20, verify)),
			]),
		);
	}

	function onHandshake(data) {
		messages = Buffer.concat([messages, data]);
		while (messages.length >= 4) {
			const length = messages.readUIntBE(1, 3);
			if (messages.length < 4 + length) return;
			const message = Buffer.from(messages.subarray(0, 4 + length));
			messages = messages.subarray(4 + length);
			if (message[0] === 1 && !clientRandom) {
				transcript.push(message);
				onClientHello(message);
			} else if (message[0] === 16 && clientRandom && !keys) {
				transcript.push(message);
				onClientKeyExchange(message);
			} else if (message[0] === 20 && decrypting && !finished)
				onFinished(message);
			else throw new Error(`handshake message ${message[0]} out of order`);
		}
	}

	function onRecord(type, payload) {
		const data = decrypting ? decrypt(type, payload) : payload;
		if (type === 21) {
			once({ error: `alert ${data[1]}` });
			socket.destroy();
		} else if (type === 20 && keys) decrypting = true;
		else if (type === 22) onHandshake(data);
		else if (type === 23 && finished) {
			request += data.toString('latin1');
			if (!request.includes('\r\n\r\n')) return;
			socket.write(
				encrypt(
					23,
					Buffer.from(
						'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n' +
							`content-length: ${Buffer.byteLength(body)}\r\n` +
							`connection: close\r\n\r\n${body}`,
					),
				),
			);
			// close_notify
			socket.end(encrypt(21, Buffer.from([1, 0])));
			records = Buffer.alloc(0);
		} else throw new Error(`record ${type} out of order`);
	}

	socket.on('error', () => {});
	socket.on('close', () => once({ error: 'closed' }));
	socket.on('data', (chunk) => {
		records = Buffer.concat([records, chunk]);
		try {
			while (records.length >= 5 && !socket.destroyed) {
				const length = records.readUInt16BE(3);
				if (records.length < 5 + length) return;
				const type = records[0];
				const payload = Buffer.from(records.subarray(5, 5 + length));
				records = records.subarray(5 + length);
				onRecord(type, payload);
			}
		} catch (error) {
			once({ error: String(error.message).slice(0, 80) });
			socket.destroy();
		}
	});
}

// --- servers -----------------------------------------------------------------
let phase = 'native';
const logs = {};
const servers = [];
const listen = (server) =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server.address().port));
	});

// a ServerHello with this random is a HelloRetryRequest (RFC 8446 4.1.3)
const HRR_RANDOM = Buffer.from(
	'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c',
	'hex',
);

const ALERT_HANDSHAKE_FAILURE = Buffer.from([
	0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28,
]);

async function startRow(id, row) {
	const log = (logs[id] = {
		native: { connections: [], handshakes: [] },
		spki: { connections: [], handshakes: [] },
		stomp: { connections: [], handshakes: [] },
	});
	let backendPort = null;
	if (row.hello) {
		const server = createNet((socket) =>
			serveTls12(socket, {
				...certs[row.cert],
				variant: row.hello,
				kx: row.kx,
				body: `<!doctype html><title>LT ${id}</title><p>${id}</p>`,
				report: (entry) => log[phase].handshakes.push(entry),
			}),
		);
		backendPort = await listen(server);
		servers.push(server);
	} else if (!row.raw) {
		const pair = certs[row.cert];
		const sessions = new Map();
		const server = createHttps(
			{ key: pair.key, cert: pair.cert, ...row.options },
			(req, res) => {
				const head = (type) =>
					res.writeHead(200, { 'content-type': type, connection: 'close' });
				if (req.method === 'POST') {
					// an upload: answer with its hash
					const hash = createHash('sha256');
					req.on('data', (chunk) => hash.update(chunk));
					req.on('end', () => {
						head('text/plain');
						res.end(hash.digest('hex'));
					});
					return;
				}
				if (req.url.includes('big=1')) {
					head('application/octet-stream');
					res.end(BIG);
					return;
				}
				head('text/html');
				res.end(`<!doctype html><title>LT ${id}</title><p>${id}</p>`);
			},
		);
		server.on('newSession', (sid, data, callback) => {
			sessions.set(sid.toString('hex'), data);
			callback();
		});
		server.on('resumeSession', (sid, callback) =>
			callback(null, sessions.get(sid.toString('hex')) ?? null),
		);
		server.on('secureConnection', (socket) =>
			log[phase].handshakes.push({
				version: socket.getProtocol(),
				cipher: socket.getCipher()?.standardName,
				reused: socket.isSessionReused(),
			}),
		);
		server.on('tlsClientError', (error) =>
			log[phase].handshakes.push({
				error: String(error.code ?? error.message).slice(0, 80),
			}),
		);
		backendPort = await listen(server);
		servers.push(server);
	}
	const front = createNet((socket) => {
		const connection = { hellos: [] };
		log[phase].connections.push(connection);
		socket.on('error', () => {});
		const read = helloReader((hello) => {
			connection.hellos.push(hello);
			if (row.raw && connection.hellos.length === 1) {
				connection.offered = hello.ciphers?.includes(hex(row.raw));
				socket.end(ALERT_HANDSHAKE_FAILURE);
			}
		});
		if (row.raw) {
			socket.on('data', read);
			return;
		}
		const backend = netConnect(backendPort, '127.0.0.1');
		backend.on('error', () => socket.destroy());
		socket.on('close', () => backend.destroy());
		backend.on('close', () => socket.destroy());
		socket.on('data', (chunk) => {
			read(chunk);
			backend.write(chunk);
		});
		// the server's first record says whether it asked for a second hello
		let first = Buffer.alloc(0);
		backend.on('data', (chunk) => {
			if (!first) return;
			first = Buffer.concat([first, chunk]);
			if (first.length < 43) return;
			connection.hrr =
				first[0] === 22 &&
				first[5] === 2 &&
				first.subarray(11, 43).equals(HRR_RANDOM);
			first = null;
		});
		backend.pipe(socket);
	});
	const port = await listen(front);
	servers.push(front);
	return `https://127.0.0.1:${port}/${id}`;
}

const urls = {};
for (const [id, row] of Object.entries(ROWS))
	urls[id] = await startRow(id, row);

// --- native Chrome -----------------------------------------------------------
const netError = (error) =>
	/net::(ERR_\w+)/.exec(String(error))?.[1] ?? String(error).slice(0, 80);

/** `profile`: a user data directory to launch with (Chrome's trust store) */
async function nativeRun(ids, args, profile = null, phaseOf = () => 'native') {
	const browser = profile ? null : await launch(args);
	const context = profile
		? await chromium.launchPersistentContext(profile, {
				executablePath: CHROME,
				headless: true,
				args: [
					'--no-sandbox',
					'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
					...args,
				],
			})
		: await browser.newContext();
	const out = {};
	// a page of its own for each row: a navigation that follows a refused
	// one in the same page was interrupted by the error page's
	for (const id of ids) {
		phase = phaseOf(id);
		const loads = [];
		for (let n = 0; n < (ROWS[id].resume ? 2 : 1); n++) {
			const page = await context.newPage();
			loads.push(
				await page
					.goto(`${urls[id]}?n=${n}`, { timeout: NATIVE_MS })
					.then(async () =>
						(await page.title()) === `LT ${id}` ? 'ok' : 'other',
					)
					.catch(netError),
			);
			await page.close();
		}
		out[id] = loads;
	}
	await (browser ?? context).close();
	return out;
}

// Chrome taking every certificate but the SHA-1 one by its key: the answer
// of the rows a certificate error does not decide, and, for information
// (logged as `spki`), that of the rows it does
const SPKI_LIST = `--ignore-certificate-errors-spki-list=${[
	...new Set(
		Object.entries(certs)
			.filter(([name]) => name !== 'sha1')
			.map(([, pair]) => spki(pair.cert)),
	),
].join(',')}`;
const keyed = Object.keys(ROWS).filter((id) => ROWS[id].cert !== 'sha1');
const native = {};
const nativeSpki = {};
for (const [id, loads] of Object.entries(
	await nativeRun(keyed, [SPKI_LIST], null, (id) =>
		ROWS[id].verified ? 'spki' : 'native',
	),
))
	(ROWS[id].verified ? nativeSpki : native)[id] = loads;
phase = 'native';

// The rows a certificate error decides: Chrome with the test CAs trusted in
// its own trust store, the profile's ServerCertificate database (sqlite), as
// Chrome keeps a certificate a user adds. Its trust_settings are a
// CertificateMetadata protobuf whose trust (field 1) holds trust_type (field
// 1) 3, which Chrome 152 and 157 take as a trust anchor (measured 2026-11-17).
// A row of its own checks that they do.
const TRUSTED_CAS = [CA, RSA_CA, ...Object.values(ROOTS)];
const verifiedIds = Object.keys(ROWS).filter((id) => ROWS[id].verified);
const sqlite = await import('node:sqlite').catch(() => null);
if (sqlite) {
	const profile = join(work, 'profile');
	mkdirSync(join(profile, 'Default'), { recursive: true });
	const db = new sqlite.DatabaseSync(
		join(profile, 'Default', 'ServerCertificate'),
	);
	db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
		INSERT INTO meta VALUES ('mmap_status', '-1'), ('version', '1'), ('last_compatible_version', '1');
		CREATE TABLE certificates(sha256hash_hex TEXT PRIMARY KEY, der_cert BLOB NOT NULL, trust_settings BLOB NOT NULL);`);
	const insert = db.prepare('INSERT INTO certificates VALUES (?, ?, ?)');
	for (const pem of TRUSTED_CAS) {
		const der = Buffer.from(new X509Certificate(pem).raw);
		insert.run(
			createHash('sha256').update(der).digest('hex'),
			der,
			Buffer.from([0x0a, 0x02, 0x08, 0x03]),
		);
	}
	db.close();
	Object.assign(native, await nativeRun(verifiedIds, [], profile));
} else
	console.log(
		`SKIP ${verifiedIds.join(' ')}: this Node has no node:sqlite to write Chrome's trust store, so they have no native answer`,
	);

// --- the TLS session cache: native Chrome's ------------------------------------
// TLS 1.3 servers on ports of their own, one request a connection, fetched in
// order from one page (one network partition), then some again: the server
// says which revisit resumed. Chrome 157 keeps the newest 1024 sessions
// (measured 2026-11-17), so the revisits are either side of that: the 1024th
// newest and the 1025th (its lookup comes after the 1024th's moved to the
// front), the newest five and the oldest five.
const CACHE_SERVERS = 1100;
const cachePorts = [];
const cacheLog = new Map();
for (let i = 0; i < CACHE_SERVERS; i++) {
	const server = createHttps({ ...certs.ecdsa, ...TLS13 }, (req, res) => {
		res.writeHead(200, {
			'access-control-allow-origin': '*',
			'content-type': 'text/plain',
			connection: 'close',
		});
		res.end('cached');
	});
	const port = await listen(server);
	servers.push(server);
	cacheLog.set(port, { native: [], stomp: [] });
	cachePorts.push(port);
	server.on('secureConnection', (socket) =>
		cacheLog.get(port)[phase].push(socket.isSessionReused()),
	);
}
const cacheUrls = cachePorts.map((port) => `https://127.0.0.1:${port}/`);
const CACHE_PROBES = [
	CACHE_SERVERS - 1024,
	CACHE_SERVERS - 1025,
	...[5, 4, 3, 2, 1].map((back) => CACHE_SERVERS - back),
	0,
	1,
	2,
	3,
	4,
];
/** each probe's revisit: resumed or not (null: no second connection) */
const resumedPattern = (side) =>
	CACHE_PROBES.map((i) => cacheLog.get(cachePorts[i])[side][1] ?? null);
const firstVisitsResumed = (side) =>
	cachePorts.filter((port) => cacheLog.get(port)[side][0]).length;

/** in a page: every URL in order, then the probes; through the page's own transport when it has one */
const visitInOrder = async ({ urls, probes }) => {
	const transport = globalThis.legacyTls?.transport;
	const get = (url) =>
		(transport
			? transport
					.request(new URL(url), 'GET', null, [], undefined)
					.then((response) => new Response(response.body).text())
			: fetch(url).then((response) => response.text())
		).then(
			() => 'ok',
			(error) => String(error?.message ?? error).slice(0, 80),
		);
	const failed = [];
	const t0 = performance.now();
	for (const url of urls) {
		const outcome = await get(url);
		if (outcome !== 'ok') failed.push(outcome);
	}
	for (const i of probes) {
		const outcome = await get(urls[i]);
		if (outcome !== 'ok') failed.push(`probe ${i}: ${outcome}`);
	}
	return {
		failures: failed.length,
		failed: failed.slice(0, 4),
		ms: Math.round(performance.now() - t0),
	};
};

const cachePage = createHttp((req, res) =>
	res.end('<!doctype html><title>cache</title>'),
);
const cachePageUrl = `http://127.0.0.1:${await listen(cachePage)}/`;
servers.push(cachePage);
phase = 'native';
const nativeCache = await (async () => {
	const browser = await launch([SPKI_LIST]);
	const page = await (await browser.newContext()).newPage();
	await page.goto(cachePageUrl);
	const visits = await page.evaluate(visitInOrder, {
		urls: cacheUrls,
		probes: CACHE_PROBES,
	});
	await browser.close();
	return visits;
})();

// --- STomp -------------------------------------------------------------------
phase = 'stomp';
const browser = await launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
const proxied = await page.evaluate(
	async ({ cas, rows, timeoutMs, uploadLen }) => {
		const { StompController } = await import('/stomp/controller.mjs');
		const registration = await StompController.register('/stomp/');
		const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
		const controller = new StompController({
			serviceworker: registration,
			transport: {
				module: '/epoxy/index.mjs',
				options: [{ wisp, pem_files: cas }],
			},
			directory: '/stomp/',
			codec: 'xor',
		});
		await controller.wait();
		const timeout = () =>
			new Promise((resolve) => setTimeout(() => resolve('HUNG'), timeoutMs));
		const out = {};
		const hexOf = (buffer) =>
			[...new Uint8Array(buffer)]
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
		for (const [id, url, resume, bulk] of rows) {
			const element = document.createElement('iframe');
			document.body.append(element);
			const frame = controller.createFrame(element);
			const page = await Promise.race([
				frame
					.go(`${url}?n=0`)
					.then(() =>
						element.contentDocument?.title === `LT ${id}`
							? 'ok'
							: `title ${element.contentDocument?.title}`,
					),
				timeout(),
			]).catch((error) => String(error).slice(0, 160));
			const raw = [];
			for (let n = 1; n <= (resume ? 2 : 1); n++) {
				raw.push(
					await Promise.race([
						controller.transport
							.request(new URL(`${url}?n=${n}`), 'GET', null, [], undefined)
							.then(async (response) => {
								const text = await new Response(response.body).text();
								return text.includes(`<title>LT ${id}</title>`)
									? 'ok'
									: `status ${response.status}`;
							}),
						timeout(),
					]).catch((error) => String(error?.message ?? error).slice(0, 160)),
				);
			}
			element.remove();
			out[id] = { page, raw };
			if (!bulk) continue;
			out[id].bulk = await Promise.race([
				(async () => {
					const big = await controller.transport.request(
						new URL(`${url}?big=1`),
						'GET',
						null,
						[],
						undefined,
					);
					const bytes = await new Response(big.body).arrayBuffer();
					const up = await controller.transport.request(
						new URL(`${url}?up=1`),
						'POST',
						bytes.slice(0, uploadLen),
						[['content-type', 'application/octet-stream']],
						undefined,
					);
					return {
						down: hexOf(await crypto.subtle.digest('SHA-256', bytes)),
						up: await new Response(up.body).text(),
					};
				})(),
				timeout(),
			]).catch((error) => String(error?.message ?? error).slice(0, 160));
		}
		return out;
	},
	{
		cas: TRUSTED_CAS,
		rows: Object.keys(ROWS).map((id) => [
			id,
			urls[id],
			!!ROWS[id].resume,
			BULK.includes(id),
		]),
		timeoutMs: PROXIED_MS,
		uploadLen: UPLOAD_LEN,
	},
);

// --- the TLS session cache: STomp's ----------------------------------------------
// A page's own EpoxyTransport, with the controller's options; its wasm
// memory is caught as the module is instantiated.
const ownContext = await browser.newContext();
async function ownTransport() {
	const page = await ownContext.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	await page.evaluate(
		async (cas) => {
			const memories = [];
			const keep = (result) => {
				for (const value of Object.values((result.instance ?? result).exports))
					if (value instanceof WebAssembly.Memory) memories.push(value);
				return result;
			};
			const { instantiate, instantiateStreaming } = WebAssembly;
			WebAssembly.instantiate = (...args) =>
				instantiate.apply(WebAssembly, args).then(keep);
			WebAssembly.instantiateStreaming = (...args) =>
				instantiateStreaming.apply(WebAssembly, args).then(keep);
			const { default: EpoxyTransport } = await import('/epoxy/index.mjs');
			const wisp = `${location.origin.replace(/^http/, 'ws')}/wisp/`;
			const transport = new EpoxyTransport({ wisp, pem_files: cas });
			await transport.init();
			// the transport logs every refused request
			console.error = () => {};
			globalThis.legacyTls = { transport, memories };
		},
		[CA, RSA_CA],
	);
	return page;
}

// Memory: 5000 requests to as many closed ports, 32 at a time, against 5000
// to one closed port (after a warm-up to it). The transport keeps nothing for
// a connection that never opened, natively nothing either; an entry per port
// kept forever is unbounded memory.
const CLOSED_COUNT = 5000;
const refused = (port) =>
	new Promise((resolve) => {
		const socket = netConnect(port, '127.0.0.1');
		socket.on('connect', () => {
			socket.destroy();
			resolve(false);
		});
		socket.on('error', (error) => resolve(error.code === 'ECONNREFUSED'));
	});
const closedPorts = [];
for (let base = 20000; closedPorts.length <= CLOSED_COUNT; base += 500) {
	const batch = Array.from({ length: 500 }, (_, i) => base + i);
	const answers = await Promise.all(batch.map(refused));
	closedPorts.push(...batch.filter((_, i) => answers[i]));
}
const memoryStarted = performance.now();
const memory = await (
	await ownTransport()
).evaluate(
	async ({ distinct, one }) => {
		const { transport, memories } = globalThis.legacyTls;
		const bytes = () =>
			memories.reduce((sum, memory) => sum + memory.buffer.byteLength, 0);
		const pool = async (ports) => {
			const outcomes = {};
			let next = 0;
			await Promise.all(
				Array.from({ length: 32 }, async () => {
					while (next < ports.length) {
						const port = ports[next++];
						const outcome = await transport
							.request(
								new URL(`https://127.0.0.1:${port}/`),
								'GET',
								null,
								[],
								undefined,
							)
							.then(
								(response) => `status ${response.status}`,
								(error) => String(error?.message ?? error).slice(0, 40),
							);
						outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
					}
				}),
			);
			return outcomes;
		};
		await pool(Array(64).fill(one));
		const warm = bytes();
		const oneOutcomes = await pool(Array(distinct.length).fill(one));
		const afterOne = bytes();
		const distinctOutcomes = await pool(distinct);
		const afterDistinct = bytes();
		return {
			memories: memories.length,
			warm,
			oneGrowth: afterOne - warm,
			distinctGrowth: afterDistinct - afterOne,
			oneOutcomes,
			distinctOutcomes,
		};
	},
	{
		distinct: closedPorts.slice(0, CLOSED_COUNT),
		one: closedPorts[CLOSED_COUNT],
	},
);
memory.ms = Math.round(performance.now() - memoryStarted);
console.log(`MEMORY ${JSON.stringify(memory)}`);

// Cache size: the native visits again, through a fresh transport
const stompCache = await (
	await ownTransport()
).evaluate(visitInOrder, { urls: cacheUrls, probes: CACHE_PROBES });
await ownContext.close();

// --- the table and the checks ------------------------------------------------
const firstHello = (side) =>
	side.connections.find((c) => c.hellos[0])?.hellos[0];
const settled = (side) =>
	side.handshakes.find((h) => !h.error) ?? side.handshakes[0];
const reusedLater = (side) =>
	side.handshakes.slice(1).some((handshake) => handshake.reused === true);
// From the server's side: counting second ClientHellos misread a resumed
// TLS 1.2 handshake, whose client sends no ClientKeyExchange, so its CBC
// Finished record (a random IV first) read as a ClientHello one time in 256.
const hrr = (side) => side.connections.some((c) => c.hrr);

const table = {};
for (const id of Object.keys(ROWS)) {
	const log = logs[id];
	table[id] = {
		native: native[id] ?? null,
		...(nativeSpki[id] ? { nativeSpki: nativeSpki[id] } : {}),
		stomp: proxied[id],
		nativeServer: settled(log.native) ?? null,
		stompServer: settled(log.stomp) ?? null,
		nativeHandshakes: log.native.handshakes,
		stompHandshakes: log.stomp.handshakes,
		nativeHrr: hrr(log.native),
		stompHrr: hrr(log.stomp),
		nativeOffered: log.native.connections[0]?.offered,
		stompOffered: log.stomp.connections[0]?.offered,
	};
	console.log(`ROW ${id} ${JSON.stringify(table[id])}`);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(
	join(OUT, 'legacy-tls.json'),
	JSON.stringify(
		{
			table,
			hellos: Object.fromEntries(
				Object.keys(ROWS).map((id) => [
					id,
					{
						native: firstHello(logs[id].native),
						stomp: firstHello(logs[id].stomp),
					},
				]),
			),
		},
		null,
		'\t',
	),
);

ok(
	'native Chrome loads the rows every TLS client of its kind reaches',
	['ecdhe-rsa-aes128-gcm', 'ecdhe-ecdsa-aes128-gcm', 'group-x25519'].every(
		(id) => native[id][0] === 'ok',
	),
	JSON.stringify(native),
);
for (const id of Object.keys(ROWS)) {
	const stomp = table[id].stomp;
	const stompOk = stomp.page === 'ok' && stomp.raw.every((r) => r === 'ok');
	const detail = `native ${JSON.stringify(native[id])}, STomp ${JSON.stringify(stomp)}, server ${JSON.stringify(table[id].stompServer)}`;
	// no native answer: a verified row without node:sqlite (logged above)
	if (!native[id]) continue;
	const nativeOk = native[id].every((r) => r === 'ok');
	ok(
		`${id}: STomp ${nativeOk ? 'connects' : 'refuses'} as native Chrome 157 does`,
		nativeOk === stompOk,
		detail,
	);
	if (nativeOk && stompOk)
		ok(
			`${id}: the server settles on the version and suite it gives native Chrome`,
			table[id].nativeServer?.version === table[id].stompServer?.version &&
				table[id].nativeServer?.cipher === table[id].stompServer?.cipher,
			`native ${JSON.stringify(table[id].nativeServer)}, STomp ${JSON.stringify(table[id].stompServer)}`,
		);
	if (BULK.includes(id))
		ok(
			`${id}: a 300 KB download and a 100 KB upload arrive intact`,
			stomp.bulk?.down === BIG_HASH && stomp.bulk?.up === UPLOAD_HASH,
			JSON.stringify(stomp.bulk),
		);
	if (ROWS[id].resume && nativeOk)
		ok(
			`${id}: a later connection resumes the session, as natively`,
			reusedLater(logs[id].native) === reusedLater(logs[id].stomp),
			`native ${JSON.stringify(logs[id].native.handshakes)}, STomp ${JSON.stringify(logs[id].stomp.handshakes)}`,
		);
	if (nativeOk)
		ok(
			`${id}: a HelloRetryRequest exactly when native Chrome needs one`,
			table[id].nativeHrr === table[id].stompHrr,
			`native ${table[id].nativeHrr}, STomp ${table[id].stompHrr}`,
		);
}

if (sqlite)
	ok(
		'native Chrome trusts the test CAs in its own trust store and its verifier answers: a 2048-bit leaf loads, a 1023-bit one is a weak key',
		native['rsa2048-ecdhe']?.[0] === 'ok' &&
			native['rsa1023-ecdhe']?.[0] === 'ERR_CERT_WEAK_KEY',
		JSON.stringify({
			'rsa2048-ecdhe': native['rsa2048-ecdhe'],
			'rsa1023-ecdhe': native['rsa1023-ecdhe'],
		}),
	);
ok(
	"native Chrome loads the control row of the suite's own TLS 1.2 server",
	native['hello-control']?.[0] === 'ok' &&
		logs['hello-control'].native.handshakes.some((h) => h.version),
	JSON.stringify(logs['hello-control'].native.handshakes),
);

ok(
	`a transport's memory grows for ${CLOSED_COUNT} closed ports no more than 2 MB past its growth for as many requests to one`,
	memory.distinctGrowth - memory.oneGrowth < 2 * 1024 * 1024,
	JSON.stringify(memory),
);
ok(
	`native Chrome answers ${CACHE_SERVERS} TLS 1.3 servers and resumes some revisits, not all`,
	nativeCache.failures === 0 &&
		resumedPattern('native').includes(true) &&
		resumedPattern('native').includes(false),
	`${JSON.stringify(nativeCache)}, resumed ${JSON.stringify(resumedPattern('native'))}`,
);
ok(
	`after ${CACHE_SERVERS} TLS 1.3 servers in order, STomp resumes the revisits native Chrome resumes (its cache keeps the newest 1024)`,
	stompCache.failures === 0 &&
		JSON.stringify(resumedPattern('stomp')) ===
			JSON.stringify(resumedPattern('native')) &&
		firstVisitsResumed('stomp') === firstVisitsResumed('native'),
	`revisits of ${JSON.stringify(CACHE_PROBES)}: native ${JSON.stringify(resumedPattern('native'))}, STomp ${JSON.stringify(resumedPattern('stomp'))}; first visits resumed: native ${firstVisitsResumed('native')}, STomp ${firstVisitsResumed('stomp')}; native ${JSON.stringify(nativeCache)}, STomp ${JSON.stringify(stompCache)}`,
);

const same = (key) =>
	Object.keys(ROWS).filter((id) => {
		const a = firstHello(logs[id].native);
		const b = firstHello(logs[id].stomp);
		return a && b && JSON.stringify(a[key]) !== JSON.stringify(b[key]);
	});
const reference = firstHello(logs['group-x25519'].native);
console.log(`native ClientHello ${JSON.stringify(reference)}`);
console.log(
	`STomp ClientHello ${JSON.stringify(firstHello(logs['group-x25519'].stomp))}`,
);
for (const key of [
	'ciphers',
	'groups',
	'keyShares',
	'sigalgs',
	'versions',
	'ticket',
	'psk',
])
	ok(
		`STomp's ClientHello offers native Chrome's ${key}`,
		same(key).length === 0,
		same(key).join(' '),
	);

for (const server of servers) {
	server.closeAllConnections?.();
	server.close();
}
rmSync(work, { recursive: true, force: true });
await done(browser, errors);
