//! `serverCertificateHashes`: the server's certificate is trusted by its
//! hash instead of a chain to a root, as Chrome does it (quiche's
//! WebTransportFingerprintProofVerifier, W3C WebTransport "verify a
//! certificate hash"): the SHA-256 of the leaf's DER is one of the hashes,
//! the leaf's validity period is at most 14 days long and holds now, and its
//! key is one Chrome allows there. No name and no chain are checked; the
//! handshake signature still is.

use rustls::{
	client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
	crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms},
	pki_types::{CertificateDer, ServerName, UnixTime},
	DigitallySignedStruct, Error, SignatureScheme,
};

/// Chrome's limit on a hashed certificate's validity period
const MAX_VALIDITY_SECS: u64 = 14 * 86400;

#[derive(Debug)]
pub struct HashVerifier {
	hashes: Vec<Vec<u8>>,
	algorithms: WebPkiSupportedAlgorithms,
}

impl HashVerifier {
	pub fn new(hashes: Vec<Vec<u8>>, algorithms: WebPkiSupportedAlgorithms) -> Self {
		Self { hashes, algorithms }
	}
}

fn refuse(why: &str) -> Error {
	Error::General(format!("certificate hash: {why}"))
}

impl ServerCertVerifier for HashVerifier {
	fn verify_server_cert(
		&self,
		end_entity: &CertificateDer<'_>,
		_intermediates: &[CertificateDer<'_>],
		_server_name: &ServerName<'_>,
		_ocsp_response: &[u8],
		now: UnixTime,
	) -> Result<ServerCertVerified, Error> {
		let digest = ring::digest::digest(&ring::digest::SHA256, end_entity.as_ref());
		if !self.hashes.iter().any(|h| h.as_slice() == digest.as_ref()) {
			return Err(refuse("no hash matches"));
		}
		let leaf = Leaf::parse(end_entity.as_ref()).ok_or_else(|| refuse("unparsable certificate"))?;
		if leaf.not_before >= leaf.not_after || leaf.not_after - leaf.not_before > MAX_VALIDITY_SECS {
			return Err(refuse("validity period longer than 14 days"));
		}
		let now = now.as_secs();
		if now < leaf.not_before || now > leaf.not_after {
			return Err(refuse("expired or not yet valid"));
		}
		if !leaf.key_allowed {
			return Err(refuse("key type not allowed"));
		}
		Ok(ServerCertVerified::assertion())
	}

	fn verify_tls12_signature(
		&self,
		message: &[u8],
		cert: &CertificateDer<'_>,
		dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, Error> {
		verify_tls12_signature(message, cert, dss, &self.algorithms)
	}

	fn verify_tls13_signature(
		&self,
		message: &[u8],
		cert: &CertificateDer<'_>,
		dss: &DigitallySignedStruct,
	) -> Result<HandshakeSignatureValid, Error> {
		verify_tls13_signature(message, cert, dss, &self.algorithms)
	}

	// the WebPKI verifier's list, so the ClientHello is the same either way
	fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
		self.algorithms.supported_schemes()
	}
}

/// What the checks need from a leaf certificate
struct Leaf {
	not_before: u64,
	not_after: u64,
	key_allowed: bool,
}

/// One DER element: (tag, contents, what follows)
fn der(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
	let (&tag, rest) = input.split_first()?;
	let (&first, mut rest) = rest.split_first()?;
	let len = if first < 0x80 {
		first as usize
	} else {
		let n = (first & 0x7f) as usize;
		if n == 0 || n > 4 {
			return None;
		}
		let (bytes, after) = rest.split_at_checked(n)?;
		rest = after;
		bytes.iter().fold(0usize, |a, &b| (a << 8) | b as usize)
	};
	let (contents, rest) = rest.split_at_checked(len)?;
	Some((tag, contents, rest))
}

const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_ED25519: &[u8] = &[0x2b, 0x65, 0x70];

impl Leaf {
	fn parse(cert: &[u8]) -> Option<Self> {
		let (0x30, cert, _) = der(cert)? else { return None };
		let (0x30, tbs, _) = der(cert)? else { return None };
		let mut rest = tbs;
		let (tag, _, after) = der(rest)?;
		if tag == 0xa0 {
			rest = after; // version
		}
		let (_, _, rest) = der(rest)?; // serialNumber
		let (_, _, rest) = der(rest)?; // signature
		let (_, _, rest) = der(rest)?; // issuer
		let (0x30, validity, rest) = der(rest)? else { return None };
		let (_, _, rest) = der(rest)?; // subject
		let (0x30, spki, _) = der(rest)? else { return None };

		let (t1, before, after) = der(validity)?;
		let (t2, not_after, _) = der(after)?;
		let not_before = time(t1, before)?;
		let not_after = time(t2, not_after)?;

		let (0x30, algorithm, _) = der(spki)? else { return None };
		let (0x06, oid, params) = der(algorithm)? else { return None };
		// quiche's IsKeyTypeAllowedByPolicy: P-256 (the one the W3C spec
		// requires), P-384, Ed25519, and RSA (allowed for now there)
		let key_allowed = if oid == OID_EC_PUBLIC_KEY {
			matches!(der(params), Some((0x06, curve, _)) if curve == OID_P256 || curve == OID_P384)
		} else {
			oid == OID_RSA || oid == OID_ED25519
		};
		Some(Self {
			not_before,
			not_after,
			key_allowed,
		})
	}
}

/// UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ) as Unix seconds
fn time(tag: u8, value: &[u8]) -> Option<u64> {
	let digits = |s: &[u8]| -> Option<u64> {
		s.iter().try_fold(0u64, |a, &c| c.is_ascii_digit().then(|| a * 10 + (c - b'0') as u64))
	};
	let (year, rest) = match tag {
		0x17 if value.len() == 13 => {
			let yy = digits(&value[..2])?;
			(if yy < 50 { 2000 + yy } else { 1900 + yy }, &value[2..])
		}
		0x18 if value.len() == 15 => (digits(&value[..4])?, &value[4..]),
		_ => return None,
	};
	if rest.last() != Some(&b'Z') {
		return None;
	}
	let month = digits(&rest[0..2])?;
	let day = digits(&rest[2..4])?;
	let hour = digits(&rest[4..6])?;
	let minute = digits(&rest[6..8])?;
	let second = digits(&rest[8..10])?;
	if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
		return None;
	}
	// days from 1970-01-01 (Howard Hinnant's days_from_civil)
	let (y, m) = if month <= 2 { (year as i64 - 1, month + 9) } else { (year as i64, month - 3) };
	let era = y.div_euclid(400);
	let yoe = y - era * 400;
	let doy = (153 * m as i64 + 2) / 5 + day as i64 - 1;
	let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	let days = era * 146097 + doe - 719468;
	let secs = days * 86400 + (hour * 3600 + minute * 60 + second) as i64;
	u64::try_from(secs).ok()
}
