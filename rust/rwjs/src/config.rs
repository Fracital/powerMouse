//! What a rewrite depends on besides the script, handed over once per change
//! (`c` in the ABI) as lines of `key<TAB>value`: every value is an
//! identifier, a URL or a flag, so no JSON parser rides in the artifact. The
//! host (src/wasm/rewriter.ts) writes it from the config it has; the keys
//! are the helper names of src/helperNames.ts under the same names, plus
//! what modifyJS takes as arguments.

/// The helper names a rewritten script calls (src/helperNames.ts): a
/// deployment chooses its own, and the client's is minted per controller,
/// so none is compiled in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Names {
	/// the access API on every global (`$s$j`)
	pub access: String,
	/// the client on the window (`$P$s`, or a minted name)
	pub client: String,
	/// the stand-in marker on `location` and `eval` (`$s$L`)
	pub global_proxy: String,
	/// the stand-in's name marker (`$s$N`)
	pub global_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
	pub names: Names,
	/// the script's real URL, for `import()` of a classic script and routing
	pub url: String,
	/// the names a read of must go through the access API: the unforgeables
	/// (`eval`, `location`, `top`) and the client's name
	pub routed: Vec<String>,
	/// the temporaries the rewriter declares (`t$t`, `t$p`, `t$v` by
	/// default; a host that renames the rest renames these)
	pub temps: [String; 3],
}

impl Default for Config {
	fn default() -> Self {
		Self {
			names: Names {
				access: "$s$j".into(),
				client: "$P$s".into(),
				global_proxy: "$s$L".into(),
				global_name: "$s$N".into(),
			},
			url: String::new(),
			routed: vec!["eval".into(), "location".into(), "top".into(), "$P$s".into()],
			temps: ["t$t".into(), "t$p".into(), "t$v".into()],
		}
	}
}

impl Config {
	/// the config the lines describe, over the defaults; an unknown key is
	/// ignored (a newer host may send more), a malformed line is an error
	pub fn parse(text: &str) -> Result<Self, String> {
		let mut config = Self::default();
		let mut client_named = false;
		for line in text.lines() {
			if line.is_empty() {
				continue;
			}
			let Some((key, value)) = line.split_once('\t') else {
				return Err(format!("config line without a tab: {line:?}"));
			};
			match key {
				"access" => config.names.access = value.to_owned(),
				"client" => {
					config.names.client = value.to_owned();
					client_named = true;
				}
				"globalProxy" => config.names.global_proxy = value.to_owned(),
				"globalName" => config.names.global_name = value.to_owned(),
				"url" => config.url = value.to_owned(),
				"tempTarget" => config.temps[0] = value.to_owned(),
				"tempProp" => config.temps[1] = value.to_owned(),
				"tempValue" => config.temps[2] = value.to_owned(),
				_ => {}
			}
		}
		if client_named {
			config.routed = vec![
				"eval".into(),
				"location".into(),
				"top".into(),
				config.names.client.clone(),
			];
		}
		Ok(config)
	}

	/// whether a name is routed through the access API
	pub fn routes(&self, name: &str) -> bool {
		self.routed.iter().any(|routed| routed == name)
	}

	/// the keys `in` must ask the access API about when literal: the helpers
	/// live on the window, where natively nothing has their names
	pub fn is_helper_key(&self, key: &str) -> bool {
		key == self.names.access
			|| key == self.names.client
			|| key == self.names.global_proxy
			|| key == self.names.global_name
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn defaults_match_the_typescript() {
		let config = Config::default();
		assert_eq!(config.names.access, "$s$j");
		assert!(config.routes("location") && config.routes("$P$s"));
		assert!(!config.routes("parent"));
	}

	#[test]
	fn lines_set_names_and_the_routed_client() {
		let config = Config::parse(
			"access\tqz\nclient\t$Abc123\nurl\thttps://a.example/x.js\nignored\t1\n",
		)
		.unwrap();
		assert_eq!(config.names.access, "qz");
		assert_eq!(config.names.client, "$Abc123");
		assert!(config.routes("$Abc123") && !config.routes("$P$s"));
		assert_eq!(config.url, "https://a.example/x.js");
		assert!(config.is_helper_key("qz") && !config.is_helper_key("$P$s"));
	}

	#[test]
	fn a_line_without_a_tab_is_refused() {
		assert!(Config::parse("access qz").is_err());
	}
}
