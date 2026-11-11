// What V8 says of each text without running any: reads a JSON list of
// `{ code, module }` on stdin and writes the list of verdicts, null for a
// text that compiles and the SyntaxError's message for one that does not.
// A module is compiled with vm.SourceTextModule, which node has behind a
// flag: rust/host/early-lib.mjs runs this file with it.
import vm from 'node:vm';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const verdicts = JSON.parse(input).map(({ code, module }) => {
	try {
		if (module) new vm.SourceTextModule(code);
		else new vm.Script(code);
		return null;
	} catch (error) {
		return `${error?.name}: ${error?.message}`;
	}
});
process.stdout.write(JSON.stringify(verdicts));
