import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const outFile = resolve(rootDir, 'dist/auto-coupon.user.js');

const USERSCRIPT_BANNER = `// ==UserScript==
// @name         Auto_Coupon — 熊貓 & Uber Eats 自動領優惠券
// @namespace    https://github.com/Muranecodes/Auto_Coupon
// @version      1.0.0
// @description  在台灣 foodpanda 與 Uber Eats 網頁版自動批次歸戶優惠碼、一鍵複製結帳限定碼、智慧解析文字優惠碼（支援 iOS Safari Stay/Userscripts 與 Android/電腦 Tampermonkey）
// @author       Muranecodes
// @match        https://www.foodpanda.com.tw/*
// @match        https://foodpanda.com.tw/*
// @match        https://www.ubereats.com/*
// @match        https://ubereats.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/dist/auto-coupon.user.js
// @downloadURL  https://raw.githubusercontent.com/Muranecodes/Auto_Coupon/main/dist/auto-coupon.user.js
// ==/UserScript==
`;

const visited = new Set();
const orderedChunks = [];

function resolveTsPath(fromDir, spec) {
  const base = resolve(fromDir, spec);
  if (existsSync(base) && base.endsWith('.ts')) return base;
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  throw new Error(`Cannot resolve import "${spec}" from ${fromDir}`);
}

function collectModule(filePath) {
  const abs = resolve(filePath);
  if (visited.has(abs)) return;
  visited.add(abs);

  const rawTs = readFileSync(abs, 'utf8');
  const dir = dirname(abs);

  const importRegex =
    /^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"];?\s*$/gm;
  let match;
  while ((match = importRegex.exec(rawTs)) !== null) {
    const line = match[0];
    if (/^\s*import\s+type\s+/.test(line)) continue;
    const depPath = resolveTsPath(dir, match[1]);
    collectModule(depPath);
  }

  let js = stripTypeScriptTypes(rawTs, { mode: 'strip' });
  js = js
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+)?function|const|let|var|class)/gm, '');

  orderedChunks.push(`// --- ${abs.slice(rootDir.length + 1).replace(/\\/g, '/')} ---\n${js.trim()}`);
}

collectModule(resolve(rootDir, 'src/userscript/index.ts'));

mkdirSync(dirname(outFile), { recursive: true });
const bundle = `${USERSCRIPT_BANNER}\n(() => {\n  'use strict';\n\n${orderedChunks.join('\n\n')}\n})();\n`;
writeFileSync(outFile, bundle, 'utf8');
console.log(`Built Userscript: ${outFile}`);
