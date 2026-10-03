import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CatalogFeature, Feature } from './models'
import { reconcileCase, similarity } from './reconcile'

const stamp = '2026-10-03T00:00:00.000Z'

function catalog(overrides: Array<Partial<CatalogFeature> & { id: string }>): CatalogFeature[] {
  return overrides.map(item => ({
    code: item.code || item.id, label: item.label || item.id,
    definition: item.definition || '', category: 'x', status: item.status || 'active',
    version: item.version || 1, createdAt: stamp, updatedAt: stamp, ...item
  }))
}

function feature(overrides: Partial<Feature> & { id: string }): Feature {
  return {
    claimId: 'c1', label: 'F · ' + overrides.id, text: '', parentId: null, referenceIds: [],
    supportIds: ['para-1'], ownerRole: 'author',
    catalogFeatureId: null, linkStatus: 'local', pending: null, linkedCatalogVersion: null, ...overrides
  }
}

const linkedFeature = (id: string, catId: string, text: string) => feature({
  id, label: id, text, catalogFeatureId: catId, linkStatus: 'linked', linkedCatalogVersion: 1
})

describe('similarity', () => {
  it('相同文本相似度为 1', () => {
    assert.equal(similarity('多个温湿度传感器沿柜体对角线布置', '多个温湿度传感器沿柜体对角线布置'), 1)
  })
  it('无关文本相似度很低', () => {
    assert.ok(similarity('多个温湿度传感器沿柜体对角线布置', '无线通信周期传输数据') < 0.2)
  })
})

describe('reconcileCase', () => {
  it('改定义后仍然吻合：自动换版本，依据保留', () => {
    const cat = catalog([{ id: 'a', label: '传感', definition: '设置于柜体内，用于采集温度与湿度数据', version: 2 }])
    const changes = [{
      id: 'chg-1', releasedAt: stamp, releasedBy: 'author' as const, note: '',
      obsolete: [], addedFeatureIds: [],
      modified: [{ featureId: 'a', fromVersion: 1, toVersion: 2 }]
    }]
    const result = reconcileCase({
      caseId: 'c', catalog: cat, changes, changeIds: ['chg-1'], detectedAt: stamp,
      features: [linkedFeature('f1', 'a', '设置于柜体内，用于采集温湿度数据')]
    })
    assert.equal(result.autoLinked.length, 1)
    assert.equal(result.suspended.length, 0)
    assert.equal(result.features[0].linkStatus, 'linked')
    assert.equal(result.features[0].catalogFeatureId, 'a')
    assert.equal(result.features[0].linkedCatalogVersion, 2)
    assert.deepEqual(result.features[0].supportIds, ['para-1'])
  })

  it('改定义后差异过大：挂起并保留旧引用与依据', () => {
    const cat = catalog([{ id: 'a', label: '传感', definition: '基于卫星遥感链路获取地表植被覆盖度的云平台', version: 2 }])
    const changes = [{
      id: 'chg-1', releasedAt: stamp, releasedBy: 'author' as const, note: '',
      obsolete: [], addedFeatureIds: [],
      modified: [{ featureId: 'a', fromVersion: 1, toVersion: 2 }]
    }]
    const result = reconcileCase({
      caseId: 'c', catalog: cat, changes, changeIds: ['chg-1'], detectedAt: stamp,
      features: [linkedFeature('f1', 'a', '设置于柜体内，用于采集温湿度数据')]
    })
    assert.equal(result.autoLinked.length, 0)
    assert.equal(result.suspended.length, 1)
    const f = result.features[0]
    assert.equal(f.linkStatus, 'pending')
    assert.deepEqual(f.pending?.candidateIds, ['a'])
    assert.deepEqual(f.supportIds, ['para-1'])
  })

  it('拆分出两条且只能唯一对上一条：自动换过去', () => {
    const cat = catalog([
      { id: 'old', label: '传感模块', definition: '采集温湿度数据', status: 'obsolete' },
      { id: 'p1', label: '温度传感器', definition: '采集温度数据' },
      { id: 'p2', label: '湿度传感器', definition: '采集湿度数据' }
    ])
    const changes = [{
      id: 'chg-1', releasedAt: stamp, releasedBy: 'author' as const, note: '', modified: [], addedFeatureIds: ['p1', 'p2'],
      obsolete: [{ featureId: 'old', label: '传感模块', kind: 'split' as const, replacementIds: ['p1', 'p2'] }]
    }]
    const result = reconcileCase({
      caseId: 'c', catalog: cat, changes, changeIds: ['chg-1'], detectedAt: stamp,
      features: [linkedFeature('f1', 'old', '采集温度数据的传感器')]
    })
    assert.equal(result.autoLinked.length, 1)
    assert.equal(result.autoLinked[0].toCatalogId, 'p1')
    assert.equal(result.features[0].catalogFeatureId, 'p1')
  })

  it('拆分后两条都沾边（不唯一）：挂起并给出候选', () => {
    const cat = catalog([
      { id: 'old', label: '传感模块', definition: '采集温湿度数据', status: 'obsolete' },
      { id: 'p1', label: '温湿度传感（通道一）', definition: '采集温湿度数据的传感器' },
      { id: 'p2', label: '温湿度传感（通道二）', definition: '采集温湿度数据的传感器' }
    ])
    const changes = [{
      id: 'chg-1', releasedAt: stamp, releasedBy: 'author' as const, note: '', modified: [], addedFeatureIds: ['p1', 'p2'],
      obsolete: [{ featureId: 'old', label: '传感模块', kind: 'split' as const, replacementIds: ['p1', 'p2'] }]
    }]
    const result = reconcileCase({
      caseId: 'c', catalog: cat, changes, changeIds: ['chg-1'], detectedAt: stamp,
      features: [linkedFeature('f1', 'old', '采集温湿度数据')]
    })
    assert.equal(result.autoLinked.length, 0)
    assert.equal(result.suspended.length, 1)
    assert.deepEqual(result.suspended[0].candidateIds.sort(), ['p1', 'p2'])
    assert.deepEqual(result.features[0].supportIds, ['para-1'])
  })

  it('停用且无后继：挂起、候选为空', () => {
    const cat = catalog([{ id: 'a', label: '旧', definition: 'x', status: 'obsolete' }])
    const changes = [{
      id: 'chg-1', releasedAt: stamp, releasedBy: 'author' as const, note: '', modified: [], addedFeatureIds: [],
      obsolete: [{ featureId: 'a', label: '旧', kind: 'remove' as const, replacementIds: [] }]
    }]
    const result = reconcileCase({
      caseId: 'c', catalog: cat, changes, changeIds: ['chg-1'], detectedAt: stamp,
      features: [linkedFeature('f1', 'a', '随便写的特征文字')]
    })
    assert.equal(result.suspended.length, 1)
    assert.deepEqual(result.suspended[0].candidateIds, [])
  })

  it('本案件自定义特征不参与对应', () => {
    const cat = catalog([{ id: 'a', label: 'a', definition: 'a' }])
    const result = reconcileCase({
      caseId: 'c', catalog: cat, changes: [], detectedAt: stamp,
      features: [feature({ id: 'f-local', text: '案件特有结构' })]
    })
    assert.equal(result.autoLinked.length, 0)
    assert.equal(result.suspended.length, 0)
  })

  it('重试：代理人把特征文字改到与唯一候选吻合后自动对上', () => {
    const cat = catalog([
      { id: 'old', label: '传感模块', definition: '采集温湿度', status: 'obsolete' },
      { id: 'p1', label: '温度传感器', definition: '采集温度数据' },
      { id: 'p2', label: '湿度传感器', definition: '采集湿度数据' }
    ])
    const changes = [{
      id: 'chg-1', releasedAt: stamp, releasedBy: 'author' as const, note: '', modified: [], addedFeatureIds: ['p1', 'p2'],
      obsolete: [{ featureId: 'old', label: '传感模块', kind: 'split' as const, replacementIds: ['p1', 'p2'] }]
    }]
    const first = reconcileCase({
      caseId: 'c', catalog: cat, changes, changeIds: ['chg-1'], detectedAt: stamp,
      features: [linkedFeature('f1', 'old', '采集温湿度数据')]
    })
    assert.equal(first.suspended.length, 1)
    const edited = first.features.map(f => ({ ...f, text: '采集温度数据' }))
    const retry = reconcileCase({ caseId: 'c', catalog: cat, changes, detectedAt: stamp, features: edited })
    assert.equal(retry.autoLinked.length, 1)
    assert.equal(retry.autoLinked[0].toCatalogId, 'p1')
    assert.equal(retry.features[0].linkStatus, 'linked')
  })

  it('注入故障时抛错，由调用方回滚（纯引擎不吞故障）', () => {
    assert.throws(() => reconcileCase({
      caseId: 'c', catalog: catalog([{ id: 'a', definition: 'a' }]), changes: [], detectedAt: stamp,
      features: [linkedFeature('f1', 'a', 'a')], fault: new Error('boom')
    }), /boom/)
  })
})
