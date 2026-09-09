#!/bin/node
/** CI audit 门禁：支持豁免清单（仅限「无修复可用且调用路径不可达」的传递依赖）。
 *  豁免登记在 WAIVERS 内并须同步 docs/dependencies.md 说明。 */
import { execSync } from 'node:child_process';

const WAIVED = new Set([
  // GHSA-xcpc-8h2w-3j85 / GHSA-vwc7-r8mq-g2x9：adm-zip 经 onnxruntime-node 传递引入，
  // 上游无修复；本系统仅使用 onnxruntime 推理 API，不触达其 zip 解包工具路径。
  'GHSA-xcpc-8h2w-3j85',
  'GHSA-vwc7-r8mq-g2x9',
]);

const raw = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const report = JSON.parse(raw);
const advisories = Object.values(report.vulnerabilities ?? {});
const real = advisories.filter((v) =>
  v.severity === 'high' || v.severity === 'critical'
    ? !v.via.every((x) => typeof x === 'string' ? !WAIVED.has(x) : true) || v.via.some((x) => typeof x === 'object' ? !WAIVED.has(x.id) : false)
    : false,
);
// via 元素：字符串=advisory id
const unwaived = [];
for (const v of advisories) {
  if (v.severity !== 'high' && v.severity !== 'critical') continue;
  const ids = v.via.filter((x) => typeof x === 'object').flatMap((x) => [x.id]);
  const source = typeof v.via[0] === 'object' ? v.via[0].id : v.via[0];
  if ([...ids, source].some((id) => WAIVED.has(id))) continue;
  unwaived.push(v);
}
if (unwaived.length > 0) {
  console.error('AUDIT GATE: unwaived high/critical vulnerabilities:');
  for (const v of unwaived) console.error(' -', JSON.stringify(v));
  process.exit(1);
}
console.log(`audit gate OK: ${advisories.length} findings, all waived or below threshold`);
