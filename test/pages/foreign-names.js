// Elements named like an HTML template or style that are not one: an SVG
// element made with the name TEMPLATE or STYLE (createElementNS keeps the
// case; an XML document's parser does too), and an XHTML document's
// template, named in lowercase, whose children live in its content. The page
// records what each way returns and what throws (foreign-names suite).
const SVG = 'http://www.w3.org/2000/svg';
const errors = {};
const results = {};
const attempt = (name, run) => {
	try {
		results[name] = run();
	} catch (error) {
		errors[name] = String(error).slice(0, 80);
	}
};
const connectedSVG = () => {
	const svg = document.createElementNS(SVG, 'svg');
	document.body.append(svg);
	return svg;
};

// parsed: an HTML template (in XHTML, named `template`), and in XHTML an
// SVG element named TEMPLATE
attempt('parsed-template', () => {
	const template = document.getElementById('tpl');
	return [
		template.childNodes.length,
		template.content.childNodes.length,
		template.content.textContent,
	];
});
attempt('parsed-foreign-template', () => {
	const element = document.getElementById('ftpl');
	return element && [element.nodeName, element.childNodes.length];
});
// made by a script
attempt('foreign-template-inner-html', () => {
	const element = document.createElementNS(SVG, 'TEMPLATE');
	connectedSVG().append(element);
	element.innerHTML = 'y';
	return [element.innerHTML, element.childNodes.length];
});
attempt('foreign-template-serialized', () => {
	const svg = connectedSVG();
	svg.append(document.createElementNS(SVG, 'TEMPLATE'));
	return svg.innerHTML;
});
attempt('foreign-style-inserted', () => {
	const element = document.createElementNS(SVG, 'STYLE');
	element.textContent = 'rect { fill: red; }';
	connectedSVG().appendChild(element);
	return element.textContent;
});
attempt('foreign-style-in-element', () => {
	const group = document.createElementNS(SVG, 'g');
	const element = document.createElementNS(SVG, 'STYLE');
	element.textContent = 'rect { fill: red; }';
	group.appendChild(element);
	connectedSVG().appendChild(group);
	return element.textContent;
});
window.__foreign = { done: true, errors, results };
