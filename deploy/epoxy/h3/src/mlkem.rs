//! X25519MLKEM768 (draft-ietf-tls-ecdhe-mlkem), the key exchange Chrome
//! offers first. rustls has it only on aws-lc-rs, which does not build for
//! wasm32-unknown-unknown; this one pairs ring's X25519 with the RustCrypto
//! `ml-kem` crate (pure Rust). Shares and the secret put ML-KEM first.

use rustls::{
	crypto::{ring::kx_group::X25519, ActiveKeyExchange, SharedSecret, SupportedKxGroup},
	Error, NamedGroup, PeerMisbehaved, ProtocolVersion,
};
use ml_kem::{kem::Decapsulate, Ciphertext, EncodedSizeUser, KemCore, MlKem768};

const MLKEM768_ENCAPSULATION_KEY_LEN: usize = 1184;
const MLKEM768_CIPHERTEXT_LEN: usize = 1088;
const X25519_LEN: usize = 32;

#[derive(Debug)]
struct X25519MlKem768;

pub static X25519_MLKEM768: &dyn SupportedKxGroup = &X25519MlKem768;

impl SupportedKxGroup for X25519MlKem768 {
	fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
		let classical = X25519.start()?;
		let (decapsulation_key, encapsulation_key) = MlKem768::generate(&mut rand_core::OsRng);
		let mut combined_pub_key = encapsulation_key.as_bytes().to_vec();
		debug_assert_eq!(combined_pub_key.len(), MLKEM768_ENCAPSULATION_KEY_LEN);
		combined_pub_key.extend_from_slice(classical.pub_key());
		Ok(Box::new(Active {
			classical,
			decapsulation_key,
			combined_pub_key,
		}))
	}

	fn name(&self) -> NamedGroup {
		NamedGroup::X25519MLKEM768
	}

	fn usable_for_version(&self, version: ProtocolVersion) -> bool {
		version == ProtocolVersion::TLSv1_3
	}
}

struct Active {
	classical: Box<dyn ActiveKeyExchange>,
	decapsulation_key: <MlKem768 as KemCore>::DecapsulationKey,
	combined_pub_key: Vec<u8>,
}

fn invalid_share() -> Error {
	PeerMisbehaved::InvalidKeyShare.into()
}

impl ActiveKeyExchange for Active {
	fn complete(self: Box<Self>, peer_pub_key: &[u8]) -> Result<SharedSecret, Error> {
		if peer_pub_key.len() != MLKEM768_CIPHERTEXT_LEN + X25519_LEN {
			return Err(invalid_share());
		}
		let (ciphertext, classical_share) = peer_pub_key.split_at(MLKEM768_CIPHERTEXT_LEN);
		let ciphertext =
			Ciphertext::<MlKem768>::try_from(ciphertext).map_err(|_| invalid_share())?;
		let post_quantum = self
			.decapsulation_key
			.decapsulate(&ciphertext)
			.map_err(|()| invalid_share())?;
		let classical = self.classical.complete(classical_share)?;

		let mut secret = post_quantum.to_vec();
		secret.extend_from_slice(classical.secret_bytes());
		Ok(SharedSecret::from(secret))
	}

	/// Chrome also sends a plain X25519 share; rustls sends this one
	fn hybrid_component(&self) -> Option<(NamedGroup, &[u8])> {
		Some((self.classical.group(), self.classical.pub_key()))
	}

	fn complete_hybrid_component(
		self: Box<Self>,
		peer_pub_key: &[u8],
	) -> Result<SharedSecret, Error> {
		self.classical.complete(peer_pub_key)
	}

	fn pub_key(&self) -> &[u8] {
		&self.combined_pub_key
	}

	fn group(&self) -> NamedGroup {
		NamedGroup::X25519MLKEM768
	}
}
