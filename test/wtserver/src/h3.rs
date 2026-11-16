//! The few pieces of HTTP/3 the fixture needs: varints, frames, and a QPACK
//! that reads static-table references and literals (the server's SETTINGS
//! give the peer no dynamic table) and writes the same.

use std::{collections::HashMap, sync::OnceLock};

use crate::tables::{HUFFMAN, STATIC};

pub const FRAME_DATA: u64 = 0x00;
pub const FRAME_HEADERS: u64 = 0x01;
pub const FRAME_SETTINGS: u64 = 0x04;

pub fn put_varint(out: &mut Vec<u8>, v: u64) {
	if v < 1 << 6 {
		out.push(v as u8);
	} else if v < 1 << 14 {
		out.extend_from_slice(&((v as u16) | 0x4000).to_be_bytes());
	} else if v < 1 << 30 {
		out.extend_from_slice(&((v as u32) | 0x8000_0000).to_be_bytes());
	} else {
		out.extend_from_slice(&(v | 0xc000_0000_0000_0000).to_be_bytes());
	}
}

/// a varint at the start of `b` and its length, None when `b` is too short
pub fn get_varint(b: &[u8]) -> Option<(u64, usize)> {
	let first = *b.first()?;
	let len = 1usize << (first >> 6);
	if b.len() < len {
		return None;
	}
	let mut v = (first & 0x3f) as u64;
	for byte in &b[1..len] {
		v = (v << 8) | *byte as u64;
	}
	Some((v, len))
}

pub fn frame(ty: u64, payload: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(payload.len() + 16);
	put_varint(&mut out, ty);
	put_varint(&mut out, payload.len() as u64);
	out.extend_from_slice(payload);
	out
}

/// a QPACK prefixed integer of `n` bits whose first byte is `b[*pos]`
fn get_prefixed(b: &[u8], pos: &mut usize, n: u8) -> Option<u64> {
	let mask = ((1u16 << n) - 1) as u8;
	let mut v = (*b.get(*pos)? & mask) as u64;
	*pos += 1;
	if v < mask as u64 {
		return Some(v);
	}
	let mut shift = 0;
	loop {
		let byte = *b.get(*pos)?;
		*pos += 1;
		v = v.checked_add(((byte & 0x7f) as u64).checked_shl(shift)?)?;
		if byte & 0x80 == 0 {
			return Some(v);
		}
		shift += 7;
		if shift > 56 {
			return None;
		}
	}
}

fn put_prefixed(out: &mut Vec<u8>, flags: u8, n: u8, v: u64) {
	let mask = ((1u16 << n) - 1) as u64;
	if v < mask {
		out.push(flags | v as u8);
		return;
	}
	out.push(flags | mask as u8);
	let mut rest = v - mask;
	while rest >= 0x80 {
		out.push((rest as u8 & 0x7f) | 0x80);
		rest >>= 7;
	}
	out.push(rest as u8);
}

fn huffman_lookup() -> &'static HashMap<(u8, u32), u8> {
	static TABLE: OnceLock<HashMap<(u8, u32), u8>> = OnceLock::new();
	TABLE.get_or_init(|| {
		HUFFMAN
			.iter()
			.enumerate()
			.map(|(sym, &(code, len))| ((len, code), sym as u8))
			.collect()
	})
}

fn huffman_decode(b: &[u8]) -> Option<Vec<u8>> {
	let table = huffman_lookup();
	let mut out = Vec::with_capacity(b.len() * 8 / 5);
	let (mut code, mut len) = (0u32, 0u8);
	for byte in b {
		for i in (0..8).rev() {
			code = (code << 1) | ((byte >> i) & 1) as u32;
			len += 1;
			if let Some(&sym) = table.get(&(len, code)) {
				out.push(sym);
				code = 0;
				len = 0;
			} else if len >= 30 {
				// EOS or no code at all
				return None;
			}
		}
	}
	// padding: fewer than 8 bits, all ones (the start of EOS)
	if len > 7 || code != (1u32 << len) - 1 {
		return None;
	}
	Some(out)
}

/// a string literal whose length prefix (after the H bit) has `n` bits
fn get_string(b: &[u8], pos: &mut usize, n: u8) -> Option<String> {
	let huffman = *b.get(*pos)? & (1 << n) != 0;
	let len = get_prefixed(b, pos, n)? as usize;
	let raw = b.get(*pos..*pos + len)?;
	*pos += len;
	let bytes = if huffman {
		huffman_decode(raw)?
	} else {
		raw.to_vec()
	};
	String::from_utf8(bytes).ok()
}

/// The fields of a HEADERS frame's field section, in order. Fails on a
/// reference to a dynamic table (the fixture offers none).
pub fn decode_fields(b: &[u8]) -> Option<Vec<(String, String)>> {
	let mut pos = 0;
	// required insert count, then the base
	if get_prefixed(b, &mut pos, 8)? != 0 {
		return None;
	}
	get_prefixed(b, &mut pos, 7)?;
	let mut fields = Vec::new();
	while pos < b.len() {
		let first = b[pos];
		if first & 0x80 != 0 {
			// indexed field line; T (0x40) must say static
			if first & 0x40 == 0 {
				return None;
			}
			let (name, value) = STATIC.get(get_prefixed(b, &mut pos, 6)? as usize)?;
			fields.push((name.to_string(), value.to_string()));
		} else if first & 0x40 != 0 {
			// literal with a name reference
			if first & 0x10 == 0 {
				return None;
			}
			let (name, _) = STATIC.get(get_prefixed(b, &mut pos, 4)? as usize)?;
			let value = get_string(b, &mut pos, 7)?;
			fields.push((name.to_string(), value));
		} else if first & 0x20 != 0 {
			// literal with a literal name
			let name = get_string(b, &mut pos, 3)?;
			let value = get_string(b, &mut pos, 7)?;
			fields.push((name, value));
		} else {
			// post-base references: dynamic table only
			return None;
		}
	}
	Some(fields)
}

/// A field section of static references and plain literals.
pub fn encode_fields(fields: &[(&str, &str)]) -> Vec<u8> {
	let mut out = vec![0, 0];
	for &(name, value) in fields {
		if let Some(i) = STATIC.iter().position(|&(n, v)| n == name && v == value) {
			put_prefixed(&mut out, 0xc0, 6, i as u64);
		} else if let Some(i) = STATIC.iter().position(|&(n, _)| n == name) {
			put_prefixed(&mut out, 0x50, 4, i as u64);
			put_prefixed(&mut out, 0, 7, value.len() as u64);
			out.extend_from_slice(value.as_bytes());
		} else {
			put_prefixed(&mut out, 0x20, 3, name.len() as u64);
			out.extend_from_slice(name.as_bytes());
			put_prefixed(&mut out, 0, 7, value.len() as u64);
			out.extend_from_slice(value.as_bytes());
		}
	}
	out
}

/// WebTransport application error code `n` in the HTTP/3 code space
/// (draft 02, as webtransport-go maps it)
pub fn wt_to_h3(n: u32) -> u64 {
	0x52e4a40fa8db + n as u64 + (n as u64 / 0x1e)
}

/// the WebTransport code an HTTP/3 code stands for, None outside the range
/// or on a reserved (GREASE) code point
pub fn h3_to_wt(h: u64) -> Option<u32> {
	if !(0x52e4a40fa8db..=0x52e5ac983162).contains(&h) || (h - 0x21) % 0x1f == 0 {
		return None;
	}
	let shifted = h - 0x52e4a40fa8db;
	Some((shifted - shifted / 0x1f) as u32)
}
