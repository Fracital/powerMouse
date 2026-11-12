//! The artifact is one page of memory and never grows: the two buffers the
//! host exchanges bytes through are statics, and the stack (nothing here
//! recurses or holds an array on it) gets 4 KiB in place of the linker's
//! megabyte, which alone would be sixteen pages in every realm that
//! instantiates the module.
fn main() {
	println!("cargo:rerun-if-changed=build.rs");
	if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
		println!("cargo:rustc-link-arg-cdylib=-zstack-size=4096");
	}
}
