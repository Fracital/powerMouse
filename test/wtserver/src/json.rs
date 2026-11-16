//! A JSON object writer for the events and the /push report (no serde: a
//! handful of shapes, written in the order given).

pub fn string(s: &str) -> String {
	let mut out = String::with_capacity(s.len() + 2);
	out.push('"');
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			// as Go's encoding/json writes them (the /push report is what
			// the Go fixture wrote)
			'<' | '>' | '&' | '\u{2028}' | '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

/// a number JSON carries exactly, else its decimal digits as a string
pub fn number(n: u64) -> String {
	if n <= (1 << 53) {
		n.to_string()
	} else {
		string(&n.to_string())
	}
}

#[derive(Default)]
pub struct Obj(String);

impl Obj {
	pub fn new() -> Self {
		Self(String::new())
	}
	pub fn raw(mut self, key: &str, value: String) -> Self {
		self.0.push(if self.0.is_empty() { '{' } else { ',' });
		self.0.push_str(&string(key));
		self.0.push(':');
		self.0.push_str(&value);
		self
	}
	pub fn s(self, key: &str, value: &str) -> Self {
		self.raw(key, string(value))
	}
	pub fn n(self, key: &str, value: u64) -> Self {
		self.raw(key, number(value))
	}
	pub fn b(self, key: &str, value: bool) -> Self {
		self.raw(key, value.to_string())
	}
	pub fn done(mut self) -> String {
		if self.0.is_empty() {
			self.0.push('{');
		}
		self.0.push('}');
		self.0
	}
}

pub fn array(items: impl IntoIterator<Item = String>) -> String {
	let mut out = String::from("[");
	for (i, item) in items.into_iter().enumerate() {
		if i > 0 {
			out.push(',');
		}
		out.push_str(&item);
	}
	out.push(']');
	out
}
