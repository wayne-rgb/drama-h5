import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/web-pc/package.json', import.meta.url));
const braces = require('braces');

test('所有构建依赖使用仓库内锁定的braces补丁', () => {
  const metadata = require('braces/package.json');
  assert.equal(metadata.name, '@drama-h5/braces');
  assert.equal(metadata.version, '3.0.3-h5.1');
  assert.equal(metadata.upstream.version, '3.0.3');
  for (const dependency of ['micromatch', 'chokidar']) {
    assert.equal(createRequire(require.resolve(dependency))('braces'), braces);
  }
});

test('文件扫描、嵌套选择、范围与去重保留上游行为', () => {
  assert.deepEqual(braces.expand('./src/**/*.{ts,tsx}'), ['./src/**/*.ts', './src/**/*.tsx']);
  assert.deepEqual(braces.expand('foo/{a,{b,c}}'), ['foo/a', 'foo/b', 'foo/c']);
  assert.equal(braces.compile('foo/{a,{b,c}}'), 'foo/(a|(b|c))');
  assert.deepEqual(braces.expand('episode-{01..03}'), ['episode-01', 'episode-02', 'episode-03']);
  assert.deepEqual(braces.expand('{a,a,b}', { nodupes: true }), ['a', 'b']);
  assert.throws(() => braces.expand('{1..1001}'), /range limit/);
  const matches = require('micromatch')(['src/App.tsx', 'src/i18n.ts', 'src/pages/我的.tsx', 'media/01.mp4'], 'src/**/*.{ts,tsx}');
  assert.deepEqual(matches, ['src/App.tsx', 'src/i18n.ts', 'src/pages/我的.tsx']);
});

test('引号、转义与字符类中的字面括号不会误触发深度限制', () => {
  const literal = '{'.repeat(70) + '剧集' + '}'.repeat(70);
  assert.equal(braces.compile(`"${literal}"`), literal);
  assert.equal(braces.stringify('[{{{{]'), '[{{{{]');
  assert.equal(braces.stringify('\\{a,b\\}'), '{a,b}');
});

test('边界附近的模式返回可控错误且正常处理仍可继续', () => {
  // 只构造略超过64层的有限单元夹具，不向业务服务发送异常请求。
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    const pattern = open.repeat(65) + 'a' + close.repeat(65);
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](pattern), error => error instanceof SyntaxError && /安全深度限制/.test(error.message));
    }
  }
  assert.deepEqual(braces.expand('{免费,会员}'), ['免费', '会员']);
});

test('直接传入语法树不能绕过递归边界，修复不靠输入字符串长度', () => {
  const tree = () => {
    let node = { type: 'text', value: '剧集' };
    for (let index = 0; index < 66; index++) node = { type: 'paren', nodes: [node] };
    return { type: 'root', nodes: [node] };
  };
  for (const method of ['compile', 'expand', 'stringify']) {
    assert.throws(() => braces[method](tree()), error => error instanceof SyntaxError && /安全深度限制/.test(error.message));
  }
  assert.equal(braces.compile(braces.parse('目录/{剧集,封面}')), '目录/(剧集|封面)');
});
