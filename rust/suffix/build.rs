//! Builds the table `src/table.rs` searches, from the public suffix list
//! vendored in `src/` (`public_suffix_list.dat`, pinned in `pins.env`
//! beside it: the build stops when the file is not the pinned one). They
//! are in `src/` because they are sources: deploy/rust/inputs.sh counts a
//! crate's `build.rs` and everything under its `src/` into the artifact's
//! provenance.
//!
//! The rules become two tries by label from the right, one of the rules and
//! one of the exception rules (`!www.ck`), as tldts keeps them, each rule
//! marked with its section (ICANN or private). A label that is not ASCII
//! goes in as its punycode form alone (`xn--`): the lookup converts a
//! host's label the same way, so the table is ASCII. Equal subtrees are
//! kept once, so the ten thousand rules are a few hundred nodes.
//!
//! What is written, each part a file of its own in `OUT_DIR`:
//!
//! - `starts`: nodes + 1 u16, little endian: where each node's edges start
//!   (the last is the edge count); a node's edges are sorted by label;
//! - `flags`: a byte per node: its sections (1 ICANN, 2 private, 0 when no
//!   rule ends there). Node 0 is the ICANN rule nothing stands under, node
//!   1 the private one: almost every edge leads to one of the two;
//! - `text`: the label of every edge, in order. Every byte but a label's
//!   last has its high bit set; the last is `kind * 40 + symbol`, the
//!   symbol the character's place in `a-z0-9-*_` and the kind where the
//!   edge leads: 0 to node 0, 1 to node 1, 2 to the node `children` names.
//!   So a label needs no length and most edges no node, and no name of the
//!   list stands in the artifact as text, where a host that substitutes
//!   tokens in what it ships would rewrite it;
//! - `children`: a u16 per edge of kind 2, in edge order: its node;
//! - `sizes.rs`: the counts, as constants.
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::{env, fs};

const ICANN: u8 = 1;
const PRIVATE: u8 = 2;
/// what a label is made of, by the number its last character is written as
const SYMBOLS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789-*_";

#[derive(Default)]
struct Node {
	flags: u8,
	children: BTreeMap<Vec<u8>, usize>,
}

/// a node with its subtree named: its sections and its edges to named nodes
type Shape = (u8, Vec<(Vec<u8>, usize)>);

fn main() {
	let dir = env::var("CARGO_MANIFEST_DIR").unwrap();
	let dir = Path::new(&dir);
	for file in ["build.rs", "src/pins.env", "src/public_suffix_list.dat"] {
		println!("cargo:rerun-if-changed={file}");
	}
	let pins = fs::read_to_string(dir.join("src/pins.env")).unwrap();
	let pin = |key: &str| -> String {
		pins.lines()
			.find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
			.unwrap_or_else(|| panic!("pins.env has no {key}"))
			.trim()
			.to_string()
	};
	let list = fs::read(dir.join("src/public_suffix_list.dat")).unwrap();
	let digest: String = sha256(&list).iter().map(|byte| format!("{byte:02x}")).collect();
	assert!(
		digest == pin("PSL_SHA256"),
		"public_suffix_list.dat is not the list pins.env pins: sha256 {digest}"
	);
	let text = String::from_utf8(list).expect("the list is UTF-8");

	// nodes[0] is the root of the rules, nodes[1] of the exceptions
	let mut nodes = vec![Node::default(), Node::default()];
	let mut section = 0;
	for line in text.lines() {
		let line = line.trim();
		if line.starts_with("//") {
			if line.contains("===BEGIN ICANN DOMAINS===") {
				section = ICANN;
			} else if line.contains("===BEGIN PRIVATE DOMAINS===") {
				section = PRIVATE;
			} else if line.contains("===END ") {
				section = 0;
			}
			continue;
		}
		let Some(rule) = line.split_whitespace().next() else {
			continue;
		};
		assert!(section != 0, "a rule outside the list's sections: {rule}");
		assert!(rule == rule.to_lowercase(), "a rule that is not lower case: {rule}");
		let (root, body) = match rule.strip_prefix('!') {
			Some(rest) => (1, rest),
			None => (0, rule),
		};
		// a label the list spelled as punycode itself would be told from
		// one this build converted only by the list's form, which the
		// lookup does not know
		assert!(
			body.split('.').all(|label| !label.starts_with("xn--")),
			"a rule with a punycode label: {rule}"
		);
		let ascii = body.split('.').map(to_ascii).collect::<Vec<_>>().join(".");
		insert(&mut nodes, root, &ascii, section);
	}

	// equal subtrees once; the two rules with nothing under them first
	let mut seen = HashMap::new();
	let mut shapes: Vec<Shape> = vec![(ICANN, Vec::new()), (PRIVATE, Vec::new())];
	seen.insert(shapes[0].clone(), 0);
	seen.insert(shapes[1].clone(), 1);
	let rules = name(&nodes, 0, &mut seen, &mut shapes);
	let exceptions = name(&nodes, 1, &mut seen, &mut shapes);

	let mut starts = Vec::new();
	let mut flags = Vec::new();
	let mut children = Vec::new();
	let mut text = Vec::new();
	let mut edge = 0usize;
	for (sections, edges) in &shapes {
		starts.extend_from_slice(&(edge as u16).to_le_bytes());
		flags.push(*sections);
		for (at, (label, to)) in edges.iter().enumerate() {
			// the lookup takes a node's wildcard to be its first edge
			assert!(label != b"*" || at == 0, "a label sorts before the wildcard");
			let (last, rest) = label.split_last().unwrap();
			text.extend(rest.iter().map(|byte| byte | 0x80));
			let symbol = SYMBOLS.iter().position(|symbol| symbol == last).unwrap();
			let kind = (*to).min(2);
			text.push((kind * 40 + symbol) as u8);
			if kind == 2 {
				children.extend_from_slice(&(*to as u16).to_le_bytes());
			}
			edge += 1;
		}
	}
	starts.extend_from_slice(&(edge as u16).to_le_bytes());
	assert!(shapes.len() < 0xFFFF && edge < 0xFFFF, "the table's u16 fields are too small");

	let out = env::var("OUT_DIR").unwrap();
	let out = Path::new(&out);
	fs::write(out.join("starts"), starts).unwrap();
	fs::write(out.join("flags"), flags).unwrap();
	fs::write(out.join("children"), children).unwrap();
	fs::write(out.join("text"), text).unwrap();
	fs::write(
		out.join("sizes.rs"),
		format!(
			"pub const EDGES: usize = {edge};\npub const RULES: usize = {rules};\npub const EXCEPTIONS: usize = {exceptions};\n"
		),
	)
	.unwrap();
	// what the module answers when asked which list it holds
	println!("cargo:rustc-env=PSL_PIN={} {}", pin("PSL_COMMIT"), pin("PSL_DATE"));
}

/// the rule `body` (labels, dots between) ends at a node of the trie under `root`
fn insert(nodes: &mut Vec<Node>, root: usize, body: &str, section: u8) {
	let mut at = root;
	for label in body.rsplit('.') {
		assert!(!label.is_empty(), "an empty label in {body}");
		assert!(
			label.bytes().all(|byte| SYMBOLS.contains(&byte)),
			"a label the table cannot spell in {body}"
		);
		at = match nodes[at].children.get(label.as_bytes()) {
			Some(&next) => next,
			None => {
				nodes.push(Node::default());
				let next = nodes.len() - 1;
				nodes[at].children.insert(label.as_bytes().to_vec(), next);
				next
			}
		};
	}
	nodes[at].flags |= section;
}

/// the number of the shape of `at`'s subtree, every equal subtree the same
fn name(
	nodes: &[Node],
	at: usize,
	seen: &mut HashMap<Shape, usize>,
	shapes: &mut Vec<Shape>,
) -> usize {
	let edges = nodes[at]
		.children
		.iter()
		.map(|(label, &child)| (label.clone(), name(nodes, child, seen, shapes)))
		.collect();
	let shape = (nodes[at].flags, edges);
	if let Some(&id) = seen.get(&shape) {
		return id;
	}
	shapes.push(shape.clone());
	seen.insert(shape, shapes.len() - 1);
	shapes.len() - 1
}

/// a label as a host name carries it: itself, or `xn--` and its punycode
fn to_ascii(label: &str) -> String {
	if label.is_ascii() {
		return label.to_string();
	}
	format!("xn--{}", punycode(label))
}

/// RFC 3492, the encoder
fn punycode(input: &str) -> String {
	const BASE: u32 = 36;
	const TMIN: u32 = 1;
	const TMAX: u32 = 26;
	fn digit(value: u32) -> char {
		(if value < 26 { b'a' + value as u8 } else { b'0' + (value - 26) as u8 }) as char
	}
	fn adapt(mut delta: u32, points: u32, first: bool) -> u32 {
		delta /= if first { 700 } else { 2 };
		delta += delta / points;
		let mut k = 0;
		while delta > ((BASE - TMIN) * TMAX) / 2 {
			delta /= BASE - TMIN;
			k += BASE;
		}
		k + (BASE - TMIN + 1) * delta / (delta + 38)
	}
	let points: Vec<u32> = input.chars().map(|c| c as u32).collect();
	let mut output: String = input.chars().filter(char::is_ascii).collect();
	let basic = output.len() as u32;
	if basic > 0 {
		output.push('-');
	}
	let mut handled = basic;
	let (mut n, mut delta, mut bias) = (128, 0, 72);
	while (handled as usize) < points.len() {
		let next = points.iter().copied().filter(|&point| point >= n).min().unwrap();
		delta += (next - n) * (handled + 1);
		n = next;
		for &point in &points {
			if point < n {
				delta += 1;
			}
			if point == n {
				let mut q = delta;
				let mut k = BASE;
				loop {
					let t = if k <= bias {
						TMIN
					} else if k >= bias + TMAX {
						TMAX
					} else {
						k - bias
					};
					if q < t {
						break;
					}
					output.push(digit(t + (q - t) % (BASE - t)));
					q = (q - t) / (BASE - t);
					k += BASE;
				}
				output.push(digit(q));
				bias = adapt(delta, handled + 1, handled == basic);
				delta = 0;
				handled += 1;
			}
		}
		delta += 1;
		n += 1;
	}
	output
}

/// FIPS 180-4, so the pin is checked with no dependency
fn sha256(data: &[u8]) -> [u8; 32] {
	const K: [u32; 64] = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
		0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
		0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
		0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
		0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
		0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
		0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
		0xc67178f2,
	];
	let mut state: [u32; 8] = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
		0x5be0cd19,
	];
	let mut message = data.to_vec();
	message.push(0x80);
	while message.len() % 64 != 56 {
		message.push(0);
	}
	message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
	for block in message.chunks(64) {
		let mut w = [0u32; 64];
		for (at, word) in block.chunks(4).enumerate() {
			w[at] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
		}
		for at in 16..64 {
			let s0 = w[at - 15].rotate_right(7) ^ w[at - 15].rotate_right(18) ^ (w[at - 15] >> 3);
			let s1 = w[at - 2].rotate_right(17) ^ w[at - 2].rotate_right(19) ^ (w[at - 2] >> 10);
			w[at] = w[at - 16]
				.wrapping_add(s0)
				.wrapping_add(w[at - 7])
				.wrapping_add(s1);
		}
		let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
		for at in 0..64 {
			let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
			let choice = (e & f) ^ (!e & g);
			let first = h
				.wrapping_add(s1)
				.wrapping_add(choice)
				.wrapping_add(K[at])
				.wrapping_add(w[at]);
			let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
			let majority = (a & b) ^ (a & c) ^ (b & c);
			let second = s0.wrapping_add(majority);
			h = g;
			g = f;
			f = e;
			e = d.wrapping_add(first);
			d = c;
			c = b;
			b = a;
			a = first.wrapping_add(second);
		}
		for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
			*slot = slot.wrapping_add(value);
		}
	}
	let mut out = [0u8; 32];
	for (at, word) in state.iter().enumerate() {
		out[at * 4..at * 4 + 4].copy_from_slice(&word.to_be_bytes());
	}
	out
}
