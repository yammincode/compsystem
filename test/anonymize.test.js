'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { anonymizeName } = require('../lib/anonymize');

test('三個字：中間換成 X', () => {
  assert.equal(anonymizeName('王小明'), '王X明');
});

test('兩個字：第二個字換成 X', () => {
  assert.equal(anonymizeName('王明'), '王X');
});

test('四個字以上：保留頭尾', () => {
  assert.equal(anonymizeName('歐陽小明'), '歐XX明');
});

test('一個字與空白', () => {
  assert.equal(anonymizeName('明'), '明');
  assert.equal(anonymizeName('  '), '');
  assert.equal(anonymizeName(' 王小明 '), '王X明');
});

test('罕用字（surrogate pair）不會被拆開', () => {
  assert.equal(anonymizeName('𠀋小明'), '𠀋X明');
});
