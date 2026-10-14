'use strict';

const stringify = require('./lib/stringify');
const compile = require('./lib/compile');
const expand = require('./lib/expand');
const parse = require('./lib/parse');

// 保留上游3.0.3的模式展开和正则编译接口；本地修复位于lib中的深度边界。

const braces = (input, options = {}) => {
  let output = [];

  if (Array.isArray(input)) {
    for (const pattern of input) {
      const result = braces.create(pattern, options);
      if (Array.isArray(result)) {
        output.push(...result);
      } else {
        output.push(result);
      }
    }
  } else {
    output = [].concat(braces.create(input, options));
  }

  if (options && options.expand === true && options.nodupes === true) {
    output = [...new Set(output)];
  }
  return output;
};

// 将模式解析为语法树。

braces.parse = (input, options = {}) => parse(input, options);

// 从模式或语法树还原字符串。

braces.stringify = (input, options = {}) => {
  if (typeof input === 'string') {
    return stringify(braces.parse(input, options), options);
  }
  return stringify(input, options);
};

// 将模式或语法树编译为与正则表达式兼容的字符串。

braces.compile = (input, options = {}) => {
  if (typeof input === 'string') {
    input = braces.parse(input, options);
  }
  return compile(input, options);
};

// 展开模式，继续沿用上游的范围、空值和去重规则。

braces.expand = (input, options = {}) => {
  if (typeof input === 'string') {
    input = braces.parse(input, options);
  }

  let result = expand(input, options);

  // 按选项移除空字符串。
  if (options.noempty === true) {
    result = result.filter(Boolean);
  }

  // 按选项移除重复项。
  if (options.nodupes === true) {
    result = [...new Set(result)];
  }

  return result;
};

// 默认使用编译模式，expand选项开启时返回完整展开结果。

braces.create = (input, options = {}) => {
  if (input === '' || input.length < 3) {
    return [input];
  }

  return options.expand !== true
    ? braces.compile(input, options)
    : braces.expand(input, options);
};

// 导出兼容上游的全部公共接口。

module.exports = braces;
