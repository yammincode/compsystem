'use strict';

/**
 * 姓名匿名化
 *  - 三個字：中間換成 X（王小明 → 王X明）
 *  - 兩個字：第二個字換成 X（王明 → 王X）
 *  - 四個字以上：保留頭尾，中間全部換成 X（歐陽小明 → 歐XX明）
 *  - 一個字：原樣顯示
 * 以 Unicode 字元（code point）計算長度，避免罕用字被拆成兩半。
 */
function anonymizeName(name) {
  const chars = Array.from(String(name ?? '').trim());
  const n = chars.length;
  if (n <= 1) return chars.join('');
  if (n === 2) return chars[0] + 'X';
  return chars[0] + 'X'.repeat(n - 2) + chars[n - 1];
}

module.exports = { anonymizeName };
