'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { posix: path } = require('node:path');
const { parse } = require('acorn');
const { fullAncestor } = require('acorn-walk');
const reviewed = require('./reviewed-plugin-files.json');

const safeModules = new Set(['assert', 'buffer', 'crypto', 'events', 'path', 'querystring', 'string_decoder', 'url', 'util']);
const networkNames = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']);
const runtimeNames = new Set(['global', 'globalThis', 'process', 'WebAssembly']);
const execNames = new Set(['eval', 'Function', 'executeJavaScript', 'executeJavaScriptInIsolatedWorld']);
const privateFiles = /(?:^|[\\/\s])(?:accounts\.json|settings\.json|Cookies(?:-journal)?|Login Data|Local State|key4\.db|logins\.json|\.ssh|\.env(?:\.[\w-]+)?)(?:$|[\\/\s])/i;
const url = /(?:https?|wss?):\/\//i;

function scan(source, filename, files) {
  const rules = new Map();
  const flag = (rule, node) => { if (!rules.has(rule)) rules.set(rule, node.loc.start.line); };
  const literal = node => node?.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : node?.type === 'TemplateLiteral' && node.expressions.length === 0
      ? node.quasis[0].value.cooked
      : null;
  const importModule = (node, name) => {
    if (!name) return flag('dynamic-module', node);
    if (name.startsWith('./') || name.startsWith('../')) {
      const target = path.normalize(path.join(path.dirname(filename), name));
      const candidates = [target, ...['.js', '.cjs', '.mjs', '.json'].map(ext => target + ext), target + '/index.js'];
      if (!candidates.some(file => files.has(file))) flag('module-outside-package', node);
    } else if (!safeModules.has(name.replace(/^node:/, ''))) {
      flag('privileged-module', node);
    }
  };

  fullAncestor(parse(source, {
    ecmaVersion: 'latest',
    sourceType: /\.mjs$/i.test(filename) ? 'module' : 'commonjs',
    locations: true,
  }), (node, state, ancestors) => {
    if (node.type === 'Identifier' || node.type === 'MemberExpression') {
      const name = node.type === 'Identifier' ? node.name
        : node.computed ? literal(node.property) : node.property.name;
      if (networkNames.has(name)) flag('external-network', node);
      if (runtimeNames.has(name)) flag('runtime-access', node);
      if (execNames.has(name) || (node.type === 'MemberExpression' && name === 'constructor')) {
        flag('dynamic-code', node);
      }
      const parent = ancestors.at(-2);
      if (name === 'require' && (node.type === 'MemberExpression' || parent?.callee !== node)) {
        flag('dynamic-module', node);
      }
    }
    if (node.type === 'ImportExpression') flag('dynamic-module', node);
    if (node.source && ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
      importModule(node, literal(node.source));
    }
    if (node.type === 'CallExpression') {
      if (node.callee.name === 'require') importModule(node, literal(node.arguments[0]));
      if (['setTimeout', 'setInterval'].includes(node.callee.name) && literal(node.arguments[0]) !== null) {
        flag('dynamic-code', node);
      }
    }
    const text = literal(node) ?? (node.type === 'TemplateElement' ? node.value.cooked : null);
    if (text && url.test(text)) flag('external-url', node);
    if (text && privateFiles.test(text)) flag('credential-path', node);
  });
  return rules;
}

function checkArchive({ id, files }) {
  const paths = new Set(Object.keys(files));
  const findings = [];
  const exceptions = [];
  for (const [file, source] of Object.entries(files)) {
    if (!/\.[cm]?js$/i.test(file)) {
      if (!/(?:^LICENSE$|\.(?:md|txt|json|svg|png|jpe?g|webp|gif)$)/i.test(file)) {
        findings.push(`${file}: unreviewed file type`);
      }
      continue;
    }
    const rules = scan(source, file, paths);
    const entry = reviewed[`${id}/${file}`];
    const sameSource = entry?.sha256 === createHash('sha256').update(source).digest('hex');
    for (const [rule, line] of rules) {
      if (sameSource && entry.rules.includes(rule)) exceptions.push(`${file}:${line} ${rule}`);
      else findings.push(`${file}:${line} ${rule}`);
    }
  }
  return { findings, exceptions };
}

if (require.main === module) {
  try {
    const archive = JSON.parse(fs.readFileSync(0, 'utf8'));
    const { findings, exceptions } = checkArchive(archive);
    for (const exception of exceptions) console.log(`${archive.id}: reviewed ${exception}`);
    for (const finding of findings) console.error(`${archive.id}: ${finding}`);
    if (findings.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Plugin scan failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkArchive };
