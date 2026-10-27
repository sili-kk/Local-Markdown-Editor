const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({ state: { limits: null } });
for (const file of ['memory.js', 'document-format.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'), context);
}
const prepare = markdown => context.prepareDocumentMarkdown(markdown);
const header = '| ID | 花名 | 花语主题 | 稀有度 | 候选 T/天 | 季节意象 | 系列 | 建议分期 |\n|---|---|---|---|---:|---|---|---|';
const original = '| daisy | 小雏菊 | 天真的期待 | 普通 | 2 | 全季 | 晨光 | 一期·样例 |';
const tulip = '| tulip | 郁金香 | 把喜欢轻轻捧住 | 普通 | 3 | 春 | 晨光 | 一期·扩充 |';
const clivia = '| clivia | 君子兰 | 谦和的守候 | 稀有 | 5 | 春 | 晨光 | 一期·扩充 |';
const smallHeader = '| 名称 | 说明 |\n|:---|---:|';

test('空行分开的花卉续行恢复为一张表，保留所有单元格和对齐', () => {
  const input = `${header}\n${original}\n\n${tulip}\n\n \t\n${clivia}\n\n后续正文\n`;
  const expected = `${header}\n${original}\n${tulip}\n${clivia}\n\n后续正文\n`;
  assert.equal(prepare(input), expected);
  assert.equal(prepare(expected), expected, '重复处理不能继续改变内容');
  assert.equal(prepare(input.replace(/\n/g, '\r\n')), expected, '兼容 Windows 换行');
});

test('独立表格、不同列数、正文和无表头的数据保持原样', () => {
  for (const input of [
    `${header}\n${original}\n\n${header}\n${clivia}`,
    `${header}\n${original}\n\n| a | b |`,
    `${header}\n${original}\n\n说明文字\n\n${tulip}`,
    `${header}\n${original}\n\n## 新章节\n\n${tulip}`,
    `${tulip}\n\n${clivia}`,
    `${smallHeader}\n| a | b |\n\n可能是 | 普通文本`,
  ]) assert.equal(prepare(input), input);
});

test('转义竖线和行内代码不破坏列数判断', () => {
  const input = `${smallHeader}\n| a | b |\n\n| c | x\\|y |\n\n| d | \`x\\|y\` |`;
  assert.equal(prepare(input), input.replace(/\n\n/g, '\n'));
  const escapedEnd = `${smallHeader}\n| a | b |\n\n| c | tail\\|`;
  assert.equal(prepare(escapedEnd), escapedEnd);
});

test('保留 fenced code、缩进代码、HTML 注释和前置元数据', () => {
  const table = `${smallHeader}\n| a | b |\n\n| c | d |`;
  for (const input of [
    '```md\n' + table + '\n```',
    '~~~markdown\n' + table + '\n~~~',
    '```md\n' + table,
    table.split('\n').map(line => '    ' + line).join('\n'),
    '<!--\n' + table + '\n-->',
    '<pre>\n' + table + '\n</pre>',
    '---\nexample: |\n' + table + '\n---\n正文',
  ]) assert.equal(prepare(input), input);
});

test('保留引用和列表中嵌套的 Markdown', () => {
  for (const prefix of ['> ', '    ', '\t']) {
    const input = `${smallHeader}\n| a | b |\n\n| c | d |`.split('\n').map(line => prefix + line).join('\n');
    assert.equal(prepare(input), input);
  }
});

test('无外侧竖线的合法表头仍可接回显式续行', () => {
  const input = '名称 | 说明\n--- | ---\na | b\n\n| c | d |';
  assert.equal(prepare(input), input.replace(/\n\n/g, '\n'));
});
