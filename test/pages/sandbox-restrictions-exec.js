// an external script of sandbox-restrictions-noscript.html: its beacon names
// the document's run and case through the document's base URL
fetch('beacon/' + new URL(document.currentScript.src).searchParams.get('b'));
