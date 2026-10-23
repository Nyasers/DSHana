// dsh-sync-probe 的纯函数面：上游 tag 的语义化版本排序。
// 网络、git 与 npm 解析那三半不进单测——它们测的是上游状态，不是我们的逻辑；
// 排序是脚本里唯一会算错的地方，所以单独钉住。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareSemverDesc } from '../../scripts/dev/dsh-sync-probe.mts'

test('compareSemverDesc：先比主次修订', () => {
  const sorted = ['0.1.5-rc.3', '0.2.1-rc.3', '0.2.1-alpha.5', '0.2.0-rc.2'].sort(compareSemverDesc)
  assert.deepEqual(sorted, ['0.2.1-rc.3', '0.2.1-alpha.5', '0.2.0-rc.2', '0.1.5-rc.3'])
})

test('compareSemverDesc：同主次修订时，rc 比 alpha 新', () => {
  const sorted = ['0.2.1-alpha.5', '0.2.1-rc.3', '0.2.1-rc.1', '0.2.1-alpha.3'].sort(compareSemverDesc)
  assert.deepEqual(sorted, ['0.2.1-rc.3', '0.2.1-rc.1', '0.2.1-alpha.5', '0.2.1-alpha.3'])
})

test('compareSemverDesc：预发布段里的数字按数值比，不按字典序', () => {
  // 字典序会把 rc.10 排到 rc.9 前面
  const sorted = ['0.2.1-rc.9', '0.2.1-rc.10', '0.2.1-rc.2'].sort(compareSemverDesc)
  assert.deepEqual(sorted, ['0.2.1-rc.10', '0.2.1-rc.9', '0.2.1-rc.2'])
})

test('compareSemverDesc：正式版排在预发布版之前', () => {
  const sorted = ['0.2.1-rc.3', '0.2.1', '0.2.1-alpha.1'].sort(compareSemverDesc)
  assert.deepEqual(sorted, ['0.2.1', '0.2.1-rc.3', '0.2.1-alpha.1'])
})

test('compareSemverDesc：取的确实是最近几个，不是最旧的几个', () => {
  // 这条钉住一个真实修过的 bug：原来没排序，slice(0,5) 拿到的是最旧的五个
  const all = ['0.1.0-rc.7', '0.1.2-alpha.1', '0.2.1-rc.2', '0.2.1-alpha.5', '0.2.0-rc.2', '0.2.1-rc.3']
  const latest5 = [...all].sort(compareSemverDesc).slice(0, 5)
  assert.equal(latest5[0], '0.2.1-rc.3')
  assert.ok(!latest5.includes('0.1.0-rc.7'))
})
