### Performance

- Large inline scripts written by the HTML loader no longer keep a second copy of their rewritten text just for stack traces. Their position maps are kept by script hash instead.
