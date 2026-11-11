//! What tldts does to its input before it looks anything up, step for step
//! (`tldts-core/src/extract-hostname.ts`, `is-valid.ts`, `is-ip.ts`, as of
//! tldts-core 7.4.20), over UTF-16 code units as tldts reads a string: the
//! callers hand it a URL's host, but also a cookie's Domain attribute and a
//! page's `document.domain`, which are whatever a page wrote, and the
//! answer for those has to be tldts's too. Lengths and offsets are in code
//! units for that reason (a label of 63 units is valid, of 64 not).
//!
//! Two things tldts does with the string itself are left to the host, which
//! has the string: lower-casing (ECMAScript's `toLowerCase`, which is more
//! than ASCII) and dropping tabs and newlines to parse again.

/// what a code unit past the end reads as: equal to nothing, in no range
const NONE: u32 = u32::MAX;

/// the host `extract` found in its input
pub struct Extracted {
	pub start: usize,
	pub end: usize,
	/// tldts lower-cases what it returns
	pub lower: bool,
	/// the scan already found the host valid (tldts does not look again)
	pub validated: bool,
}

pub enum Extract {
	/// no host in this input
	None,
	/// a tab or a newline is in the way: tldts drops them all and starts over
	Strip,
	Host(Extracted),
}

/// is-valid.ts `isValidAscii`
fn valid_ascii(code: u32) -> bool {
	(97..=122).contains(&code) || (48..=57).contains(&code) || (code > 127 && code != NONE)
}

/// extract-hostname.ts `isValidHostnameChar`
fn valid_char(code: u32) -> bool {
	valid_ascii(code) || (65..=90).contains(&code) || code == 45 || code == 95
}

/// is-valid.ts: whether `host` has the structure of a host name
pub fn is_valid(host: &[u16]) -> bool {
	let len = host.len();
	if len > 255 || len == 0 {
		return false;
	}
	let first = host[0] as u32;
	if !valid_ascii(first) && first != 46 && first != 95 {
		return false;
	}
	let mut last_dot: isize = -1;
	let mut last_code = NONE;
	for (at, &unit) in host.iter().enumerate() {
		let code = unit as u32;
		if code == 46 {
			if at as isize - last_dot > 64 || last_code == 46 || last_code == 45 {
				return false;
			}
			last_dot = at as isize;
		} else if !(valid_ascii(code) || code == 45 || code == 95) || (code == 45 && last_code == 46)
		{
			return false;
		}
		last_code = code;
	}
	len as isize - last_dot - 1 <= 63 && last_code != 45
}

/// is-ip.ts: whether a valid host is probably an IP address
pub fn is_ip(host: &[u16]) -> bool {
	probably_ipv6(host) || probably_ipv4(host)
}

fn probably_ipv4(host: &[u16]) -> bool {
	if host.len() < 7 || host.len() > 15 {
		return false;
	}
	let mut dots = 0;
	for &unit in host {
		if unit == 46 {
			dots += 1;
		} else if !(48..=57).contains(&unit) {
			return false;
		}
	}
	dots == 3 && host[0] != 46 && host[host.len() - 1] != 46
}

fn probably_ipv6(host: &[u16]) -> bool {
	if host.len() < 3 {
		return host == [58, 58];
	}
	let start = (host[0] == 91) as usize;
	let mut end = host.len();
	if host[end - 1] == 93 {
		end -= 1;
	}
	if end - start > 39 {
		return false;
	}
	let mut colon = false;
	for &unit in &host[start..end] {
		if unit == 58 {
			colon = true;
		} else if !((48..=57).contains(&unit) || (97..=102).contains(&unit) || (65..=70).contains(&unit))
		{
			return false;
		}
	}
	colon
}

/// 0 not a special scheme, 1 special, 2 `file`: `url[start..colon]`, any case
fn special_scheme(url: &[u16], start: usize, colon: usize) -> u8 {
	let scheme = &url[start..colon];
	let is = |name: &[u8]| {
		scheme.len() == name.len()
			&& scheme.iter().zip(name).all(|(&unit, &byte)| unit as u32 | 32 == byte as u32)
	};
	if is(b"ws") || is(b"wss") || is(b"ftp") || is(b"http") || is(b"https") {
		1
	} else if is(b"file") {
		2
	} else {
		0
	}
}

/// `/`, `\`, `?` or `#`: where an authority ends on the path with no `://`
fn delimiter(code: u32) -> bool {
	code == 47 || code == 92 || code == 63 || code == 35
}

/// extract-hostname.ts: where the host stands in `url`. `url_is_valid`: the
/// whole input is a valid host name already (only trailing dots go).
pub fn extract(url: &[u16], url_is_valid: bool) -> Extract {
	let len = url.len();
	let at = |index: usize| -> u32 { url.get(index).map_or(NONE, |&unit| unit as u32) };
	let mut start = 0;
	let mut end = len;
	let mut has_upper = false;
	let mut is_special = false;
	let mut validated = false;

	if !url_is_valid {
		if len >= 5 && url[..5].iter().zip(b"data:").all(|(&unit, &byte)| unit == byte as u16) {
			return Extract::None;
		}
		while start < len && at(start) <= 32 {
			start += 1;
		}
		while end > start + 1 && at(end - 1) <= 32 {
			end -= 1;
		}

		// file: the host is only what stands between `//` and the next slash
		let file_slashes = |start: &mut usize| -> bool {
			let mut slashes = 0;
			while (at(*start) == 47 || at(*start) == 92) && slashes < 2 {
				*start += 1;
				slashes += 1;
			}
			slashes == 2
		};

		if at(start) == 47 && at(start + 1) == 47 {
			start += 2;
		} else if let Some(protocol) =
			(start..len.saturating_sub(1)).find(|&index| url[index] == 58 && url[index + 1] == 47)
		{
			match special_scheme(url, start, protocol) {
				1 => {
					is_special = true;
					start = protocol + 2;
					while at(start) == 47 || at(start) == 92 {
						start += 1;
					}
				}
				2 => {
					is_special = true;
					start = protocol + 1;
					if !file_slashes(&mut start) {
						return Extract::None;
					}
				}
				_ => {
					for index in start..protocol {
						let code = at(index) | 32;
						if !((97..=122).contains(&code)
							|| (48..=57).contains(&code)
							|| code == 46 || code == 45
							|| code == 43)
						{
							let raw = at(index);
							if raw == 9 || raw == 10 || raw == 13 {
								return Extract::Strip;
							}
							return Extract::None;
						}
					}
					if at(protocol + 2) == 47 {
						start = protocol + 3;
					} else {
						return Extract::None;
					}
				}
			}
		} else if at(start) != 91 {
			// no `:/` and not a bracketed IPv6: a bare host, host:port,
			// user@host, a special scheme without slashes, or an opaque URI
			let mut colon = None;
			for index in start..end {
				let code = at(index);
				if code == 9 || code == 10 || code == 13 {
					return Extract::Strip;
				}
				if code == 58 {
					colon = Some(index);
					break;
				}
				if delimiter(code) {
					break;
				}
			}
			if let Some(colon) = colon {
				// an `@` before the next delimiter: the colon is userinfo's
				let mut identifier = false;
				for index in colon + 1..end {
					let code = at(index);
					if delimiter(code) {
						break;
					}
					if code == 64 {
						identifier = true;
						break;
					}
				}
				if !identifier {
					// all digits after the colon: a bare host:port
					let mut digits = true;
					let mut index = colon + 1;
					while index < end {
						let code = at(index);
						if delimiter(code) {
							break;
						}
						if !(48..=57).contains(&code) {
							digits = false;
							break;
						}
						index += 1;
					}
					if index == colon + 1 {
						digits = false;
					}
					if !digits {
						match special_scheme(url, start, colon) {
							0 => {
								// a second colon marks a bare IPv6 literal;
								// without one this is a path with no host
								let mut bare = false;
								for index in colon + 1..end {
									let code = at(index);
									if delimiter(code) {
										break;
									}
									if code == 58 {
										bare = true;
										break;
									}
								}
								if !bare {
									return Extract::None;
								}
							}
							2 => {
								is_special = true;
								start = colon + 1;
								if !file_slashes(&mut start) {
									return Extract::None;
								}
							}
							_ => {
								is_special = true;
								start = colon + 1;
								while at(start) == 47 || at(start) == 92 {
									start += 1;
								}
							}
						}
					}
				}
			}
		}

		// the host's end, the last `@`, `]` and `:`, the host's first `:`,
		// and is-valid.ts's checks over the run as it is scanned
		let mut identifier: Option<usize> = None;
		let mut closing: Option<usize> = None;
		let mut port: Option<usize> = None;
		let mut first_colon: Option<usize> = None;
		let mut control = false;
		let mut valid = true;
		let mut last_dot = start as isize - 1;
		let mut last_code = NONE;
		if start < end {
			let first = at(start);
			if !(valid_char(first) || first == 46 || first == 95) || first == 45 {
				valid = false;
			}
		}
		let mut index = start;
		while index < end {
			let code = at(index);
			if code < 64 {
				if code == 47 || code == 35 || code == 63 {
					end = index;
					break;
				} else if code == 58 {
					if first_colon.is_none() {
						first_colon = Some(index);
					}
					port = Some(index);
				} else if code == 9 || code == 10 || code == 13 {
					control = true;
				} else if code == 46 {
					if index as isize - last_dot > 64 || last_code == 46 || last_code == 45 {
						valid = false;
					}
					last_dot = index as isize;
				} else if !(48..=57).contains(&code) && (code != 45 || last_code == 46) {
					valid = false;
				}
			} else if is_special && code == 92 {
				end = index;
				break;
			} else if code == 64 {
				identifier = Some(index);
				first_colon = None;
			} else if code == 93 {
				closing = Some(index);
			} else if (65..=90).contains(&code) {
				has_upper = true;
			} else if !valid_char(code) {
				valid = false;
			}
			last_code = code;
			index += 1;
		}

		if control {
			return Extract::Strip;
		}
		if let Some(identifier) = identifier
			&& identifier >= start
			&& identifier < end
		{
			start = identifier + 1;
		}
		if at(start) == 91 {
			// what stands between the brackets, lower-cased, or nothing
			// when they do not close
			return match closing {
				Some(closing) => Extract::Host(Extracted {
					start: start + 1,
					end: closing.max(start + 1),
					lower: true,
					validated: false,
				}),
				None => Extract::None,
			};
		} else if let Some(port) = port
			&& port > start
			&& port < end
			&& first_colon == Some(port)
		{
			// one colon in the host: a port to drop (two are an IPv6)
			end = port;
		}
		if start >= end {
			return Extract::None;
		}
		// the scan's verdict stands only where the run scanned is the host
		validated = valid
			&& identifier.is_none()
			&& port.is_none()
			&& closing.is_none()
			&& at(end - 1) != 46
			&& end - start <= 255
			&& end as isize - last_dot - 1 <= 63
			&& last_code != 45;
	}

	while end > start + 1 && at(end - 1) == 46 {
		end -= 1;
	}
	Extract::Host(Extracted {
		start,
		end,
		lower: has_upper,
		validated,
	})
}
