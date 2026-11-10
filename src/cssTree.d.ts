// css-tree's parser, walker and generator on their own (its package exports
// them; @types/css-tree declares only the whole syntax). The whole syntax
// builds the lexer too, from the grammar of every property, type and
// at-rule, which the CSS rewriter never asks for.
declare module 'css-tree/parser' {
	const parse: typeof import('css-tree').parse;
	export default parse;
}
declare module 'css-tree/walker' {
	const walk: typeof import('css-tree').walk;
	export default walk;
}
declare module 'css-tree/generator' {
	const generate: typeof import('css-tree').generate;
	export default generate;
}
