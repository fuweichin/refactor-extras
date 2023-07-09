const path = require('node:path');
const htmlparser2 = require('htmlparser2');

const vscode = require('vscode');
const { commands, window, workspace, Uri, Position, Range } = vscode;
let encoder = new TextEncoder();
let decoder = new TextDecoder();

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	context.subscriptions.push(commands.registerTextEditorCommand('refactor-extras.moveToFile',
		async function (textEditor, edit, currentUri) {
			let { selection, document } = textEditor;
			if (selection.isEmpty)
				return;
			let range = new Range(selection.start, selection.end);
			let selectionText = document.getText(range);
			let eol = document.eol == vscode.EndOfLine.LF ? '\n' : '\r\n';
			let { languageId } = document;
			let content = selectionText;
			let replaced = false;
			let name = path.basename(document.fileName); // current file name
			let ext = path.extname(name).toLowerCase(); // ext name
			let newExt;
			let filters = {};
			let parsedElement = null;
			if (languageId === 'html') {
				if (selectionText.startsWith('<script') && selectionText.endsWith('</script>') ||
					selectionText.startsWith('<style') && selectionText.endsWith('</style>')) {
					let nodeList = [];
					let node = null;
					const parser = new htmlparser2.Parser({
						onopentag(name, attributes) {
							node = { nodeName: name, attributes, textContent: '' };
						},
						ontext(text) {
							if (node === null) {
								node = { nodeName: '#text', text };
							} else {
								node.textContent = text;
							}
						},
						onclosetag() {
							nodeList.push(node);
							node = null;
						},
					});
					parser.write(selectionText);
					if (nodeList.length === 1) {
						parsedElement = nodeList[0];
						content = parsedElement.textContent;
						if (parsedElement.nodeName === 'script' && parsedElement.textContent) {
							replaced = true;
							switch (parsedElement.attributes.type) {
								case 'importmap':
									newExt = '.importmap';
									filters['JSON'] = ['importmap'];
									break;
								case 'speculationrules':
									newExt = '.json';
									filters['JSON'] = ['json'];
									break;
								case 'text/javascript':
								case 'module':
								default:
									newExt = '.js';
									filters['JavaScript'] = ['js'];
									break;
							}
						} else if (parsedElement.nodeName === 'style') {
							replaced = true;
							newExt = '.css';
							filters['CSS'] = ['css'];
						}
						filters['HTML'] = ['html'];
					} else {
						newExt = '.html';
						filters['HTML'] = ['html'];
					}
				} else {
					newExt = '.html';
					filters['HTML'] = ['html'];
					filters['JavaScript'] = ['js'];
					filters['CSS'] = ['css'];
				}
				content = smartIndent(content, eol);
			} else if (languageId === 'xml' || languageId === 'xsl') {
				if (selectionText.startsWith('<script') && selectionText.endsWith('</script>') ||
					selectionText.startsWith('<style') && selectionText.endsWith('</style>')) {
					let nodeList = [];
					let node = null;
					const parser = new htmlparser2.Parser({
						onopentag(name, attributes) {
							let newNode = { nodeName: name, attributes, textContent: '', childNodes: [] };
							if (node) {
								node.childNodes.push(newNode);
							} else {
								nodeList.push(node);
							}
							node = newNode;
						},
						ontext(text) {
							let newNode = { nodeName: '#text', text };
							if (node === null) {
								let lastNode = nodeList[nodeList.length - 1];
								if (lastNode && lastNode.childNodes) {
									lastNode.childNodes.push(newNode);
								} else {
									nodeList.push(newNode);
								}
							} else {
								node.textContent = text;
								node.childNodes.push(newNode);
							}
						},
						onclosetag(name) {
							if (node && name === node.nodeName) {
								node = null;
							}
						},
					});
					parser.write(selectionText);
					if (nodeList.length === 1) {
						parsedElement = nodeList[0];
						content = parsedElement.textContent;
						if (parsedElement.nodeName === 'script' && parsedElement.textContent) {
							replaced = true;
							newExt = '.js';
							filters['JavaScript'] = ['js'];
						} else if (parsedElement.nodeName === 'style') {
							replaced = true;
							newExt = '.css';
							filters['CSS'] = ['css'];
						}
						filters[ext.slice(1).toUpperCase()] = [ext.slice(1)];
					} else {
						filters[ext.slice(1).toUpperCase()] = [ext.slice(1)];
					}
				} else {
					filters[ext.slice(1).toUpperCase()] = [ext.slice(1)];
					filters['JavaScript'] = ['js'];
					filters['CSS'] = ['css'];
				}
				content = stripCDATA(content);
				content = smartIndent(content, eol);
			}else{
        filters[ext.slice(1).toUpperCase()] = [ext.slice(1)];
        filters['All files'] = ['*'];
      }
			let targetUri = await window.showSaveDialog({
				filters,
				title: 'Save selection as'
			});
			if (!targetUri)
				return;
			if (targetUri.fsPath === currentUri.fsPath) {
				window.showInformationMessage(`Please save selection as another file`);
				return;
			}
			if (replaced) {
				if (path.extname(targetUri.fsPath) !== newExt) {
					content = selectionText;
					replaced = false;
				}
			}
			await workspace.fs.writeFile(targetUri, encoder.encode(content));
			textEditor.edit((editBuilder) => {
				if (replaced) {
					let relativePath = getRelativePath(path.dirname(currentUri.fsPath), targetUri.fsPath);
					if (languageId === 'html') {
						let replacedContent = '';
						if (parsedElement.nodeName === 'script') {
							let script = { nodeName: 'script', attributes: { ...parsedElement.attributes, src: relativePath } };
							replacedContent = serializeToString(script);
						} else if (parsedElement.nodeName === 'style') {
							let link = { nodeName: 'link', attributes: { rel: "stylesheet", ...parsedElement.attributes, href: relativePath } };
							replacedContent = serializeToString(link);
						}
						editBuilder.replace(range, replacedContent);
					} else if (languageId === 'xml' || languageId === 'xsl') {
						let replacedContent = '';
						if (ext === '.svg') {
							if (parsedElement.nodeName === 'script') {
								replacedContent = `<script type="text/javascript" xlink:href="${relativePath}" />`;
							} else if (parsedElement.nodeName === 'style') {
								replacedContent = `<link xmlns="http://www.w3.org/1999/xhtml" rel="stylesheet" type="text/css" href="${relativePath}" />`;
							}
							editBuilder.replace(range, replacedContent);
						} else if (ext === '.xslt') {
							if (parsedElement.nodeName === 'script') {
								replacedContent = `<script type="text/javascript" src="${relativePath}" />`;
							} else if (parsedElement.nodeName === 'style') {
								replacedContent = `<link rel="stylesheet" type="text/css" href="${relativePath}" />`;
							}
							editBuilder.replace(range, replacedContent);
						} else {
							if (parsedElement.nodeName === 'script') {
								replacedContent = `<script type="text/javascript" src="${relativePath}" />`;
								editBuilder.replace(range, replacedContent);
							} else if (parsedElement.nodeName === 'style') {
								let text = document.getText(new Range(new Position(0, 0), new Position(1, 0)));
								let m = text.match(/^<\?xml [^?>]+\?>\r?\n?/);
								let pos;
								if (m) {
									let firstLine = m[0];
									pos = firstLine.endsWith('\n') ? new Position(1, 0) : new Position(0, firstLine.length);
								} else {
									pos = new Position(0, 0);
								}
								replacedContent = `<?xml-stylesheet type="text/css" href="${relativePath}"?>`;
								editBuilder.delete(range);
								editBuilder.insert(pos, replacedContent);
							}
						}
					}
				} else {
					editBuilder.delete(range);
				}
			});
			workspace.openTextDocument(targetUri).then((doc) => {
				return window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Two });
			});
		}));

	context.subscriptions.push(commands.registerTextEditorCommand('refactor-extras.insertFromFile',
		async function (textEditor, edit, currentUri) {
			window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				title: 'Choose file',
			}).then(async ([targetUri]) => {
				if (!targetUri)
					return;
				if (currentUri.fsPath === targetUri.fsPath) {
					window.showInformationMessage(`Please choose another file`);
					return;
				}
				let stat = await workspace.fs.stat(targetUri);
				if (stat.size > 2 * 1024 * 1024) {
					let answer = await window.showInformationMessage(
						`The file is quite big (${formatBytes(stat.size)}), are you sure you want to insert it?`, "Yes", "No");
					if (answer !== 'Yes') {
						return;
					}
				}
				let array = await workspace.fs.readFile(targetUri);
				let text = decoder.decode(array);
				textEditor.edit((editBuilder) => {
					editBuilder.insert(textEditor.selection.active, text);
				});
			})
		}));

	context.subscriptions.push(commands.registerTextEditorCommand('refactor-extras.insertRelativeFilePath',
		async function (textEditor, edit, currentUri) {
			window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				title: 'Chooose file'
			}).then(async ([targetUri]) => {
				if (!targetUri)
					return;
				let relativePath = getRelativePath(path.dirname(currentUri.fsPath), targetUri.fsPath);
				textEditor.edit((editBuilder) => {
					editBuilder.insert(textEditor.selection.active, relativePath);
				});
			})
		}));
}

function deactivate() {
}

function stripCDATA(text) {
	let tests = [
		{ start: /^(\s*)\/\/\s*<!\[CDATA\[/m, end: /\/\/\s*\]\]>(\s*)$/m },
		{ start: /^(\s*)\/\*\s*<!\[CDATA\[\s*\*\//m, end: /\/\*\s*\]\]>\s*\*\/(\s*)$/m },
		{ start: /^(\s*)<!\[CDATA\[/m, end: /\]\]>(\s*)$/m },
	];
	let replacer = ($0, $1) => { return $1 || '' };
	for (let { start, end } of tests) {
		if (start.test(text)) {
			return text.replace(start, replacer).replace(end, replacer);
		}
	}
	return text;
}

function smartIndent(selectionText, eol = '\n') {
	let text = selectionText.replace(new RegExp(`^${(eol === '\n' ? '\n+' : '[\r\n]+')}`, 'm'), '');
	if (text.startsWith('  ')) {
		let lines = text.split(eol);
		let indents = lines.map((line) => {
			if (line.length === 0) {
				return 256;
			} else {
				let m = line.match(/^(?:  )+/);
				return m ? m[0].length : 0;
			}
		});
		let minIndent = Math.min(...indents);
		return (minIndent === 0 || minIndent === 256) ? text : lines.map((line) => {
			return line.length === 0 ? '' : line.slice(minIndent);
		}).join(eol);
	} else if (text.startsWith('\t')) {
		let lines = text.split(eol);
		let indents = lines.map((line) => {
			if (line.length === 0) {
				return 256;
			} else {
				let m = line.match(/^\t+/);
				return m ? m[0].length : 0;
			}
		});
		let minIndent = Math.min(...indents);
		return (minIndent === 0 || minIndent === 256) ? text : lines.map((line) => {
			return line.length === 0 ? '' : line.slice(minIndent);
		}).join(eol);
	} else {
		return text;
	}
}

const globalBoolAttrs = {
	autofocus: true,
	hidden: true,
	inert: true
};
const boolAttrsByTag = {
	script: {
		defer: true,
		async: true,
		nomodule: true,
	},
	link: {
		disabled: true,
	},
};
const voidTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
function serializeToString(el) {
	let { nodeName, attributes } = el;
	let boolAttrs = boolAttrsByTag[nodeName];
	let html = '<' + nodeName;
	for (let k in attributes) {
		let v = attributes[k];
		if (!v && (boolAttrs[k] || globalBoolAttrs[k])) {
			html += ' ' + k;
		} else {
			html += ` ${k}="${encodeAttrValue(v)}"`;
		}
	}
	if (voidTags.includes(el.nodeName)) {
		html += ' />';
		return html;
	} else {
		html += '>';
		if (el.textContent)
			html += el.textContent;
		html += `</${nodeName}>`;
	}
	return html;
}
function encodeAttrValue(text) {
	return text.replace(/[<>&'"]/g, (c) => {
		switch (c) {
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '&': return '&amp;';
			case '"': return '&quot;';
			case '\'': return '&apos;';
			default: return '';
		}
	});
}

function toTruncated(n, f = 0) {
	let s = 1;
	switch (f) {
		case 1: s = 10; break;
		case 2: s = 100; break;
		case 3: s = 1000; break;
		case 0: s = 1; break;
		default: throw new Error('Invalid argument f: ' + f);
	}
	return Math.trunc(n * s) / s;
}
function formatBytes(n, f = 1) {
	if (n < 1024) {
		return n + ' B';
	} else if (n < 1048576) {
		return toTruncated(n / 1024, f) + ' KiB';
	} else if (n < 1073741824) {
		return toTruncated(n / 1048576, f) + ' MiB';
	} else {
		return toTruncated(n / 1073741824, f) + ' GiB';
	}
}

function getRelativePath(from, to) {
  let s =  path.relative(from, to).replace(/\\/g, '/');
  if(!s.startsWith('../') && !s.startsWith('/')){
    s='./'+s;
  }
  return s;
}

module.exports = {
	activate,
	deactivate
}
