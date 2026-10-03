import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { WorkbenchState } from './models'
import { WorkbenchService } from './workbench.service'
import { migrateV1 } from './seed'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) }
  } as Storage
}

function newService() {
  const storage = memoryStorage()
  Object.assign(globalThis, { localStorage: storage })
  return { service: new WorkbenchService(), storage }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('WorkbenchService 特征表发布与按案件对应', () => {
  it('发布拆分：唯一命中自动换；不唯一挂起且依据保留', () => {
    const { service } = newService()
    const state0 = service.snapshot
    const sensorId = state0.catalog.find(item => item.label === '环境传感模块')!.id
    service.addDraft('split', sensorId)
    const draft = service.snapshot.catalogDrafts[0]
    service.updateDraftPart(draft.id, 0, { label: '温度传感器', definition: '采集温度数据的温度传感器' })
    service.updateDraftPart(draft.id, 1, { label: '湿度传感器', definition: '采集湿度数据的湿度传感器' })
    service.publishCatalog('传感模块拆分')

    const after = service.snapshot
    const report = new Map(after.lastSyncReport.map(entry => [entry.caseId, entry]))
    // 两个案件都成功处理（含自动与挂起）
    for (const caseRecord of after.cases) {
      assert.equal(report.get(caseRecord.id)?.status, 'success')
      assert.notEqual(caseRecord.lastReconcileStatus, 'failed')
    }
    // 案件一 feature-b（温湿度）对温/湿两条，不应静默换到其中一条
    const case1 = after.cases.find(item => item.id === 'case-0917')!
    const featureB = case1.features.find(item => item.id === 'feature-b')!
    assert.equal(featureB.linkStatus, 'pending')
    assert.ok(featureB.supportIds.includes('para-0012'))
    assert.deepEqual(featureB.pending?.candidateIds.slice().sort(), [
      after.catalog.find(item => item.label === '温度传感器')!.id,
      after.catalog.find(item => item.label === '湿度传感器')!.id
    ].sort())
    // 案件二 H（柜内传感模组，正文偏温度与湿度并列）——同样挂起
    const case2 = after.cases.find(item => item.id === 'case-1042')!
    const featureH = case2.features.find(item => item.id === 'c2-f-2')!
    assert.equal(featureH.linkStatus, 'pending')
  })

  it('案件失败时整案回滚，其他案件与特征表保留；重试只补未对上的部分', () => {
    const { service, storage } = newService()
    const sensorId = service.snapshot.catalog.find(item => item.label === '环境传感模块')!.id
    const gradedId = service.snapshot.catalog.find(item => item.label === '分级调节')!.id

    // 两个暂存变更：拆分（影响两个案件）+ 改定义（仅案件一）
    service.addDraft('split', sensorId)
    const splitDraft = service.snapshot.catalogDrafts.find(item => item.kind === 'split')!
    service.updateDraftPart(splitDraft.id, 0, { label: '温度传感器', definition: '采集温度数据的温度传感器' })
    service.updateDraftPart(splitDraft.id, 1, { label: '湿度传感器', definition: '采集湿度数据的湿度传感器' })

    service.addDraft('redefine', gradedId)
    const redefineDraft = service.snapshot.catalogDrafts.find(item => item.kind === 'redefine')!
    service.updateDraft(redefineDraft.id, { newDefinition: '控制模块基于历史数据与当前数据的偏差分级调节除湿单元，并记录调节等级' })

    const beforeFeatures = JSON.stringify(service.snapshot.cases.find(item => item.id === 'case-1042')!.features)
    service.armFaultForCase('case-1042')
    service.publishCatalog('注入故障发布')

    let state = service.snapshot
    const failedCase = state.cases.find(item => item.id === 'case-1042')!
    const okCase = state.cases.find(item => item.id === 'case-0917')!
    // 失败案件：退回处理前
    assert.equal(failedCase.lastReconcileStatus, 'failed')
    assert.ok(failedCase.lastReconcileError?.includes('模拟故障'))
    assert.equal(JSON.stringify(failedCase.features), beforeFeatures)
    // 特征表照常发布
    assert.equal(state.catalog.find(item => item.id === sensorId)?.status, 'obsolete')
    assert.ok(state.catalog.some(item => item.label === '温度传感器'))
    assert.equal(state.catalog.find(item => item.id === gradedId)?.version, 2)
    // 其他案件照常对应
    assert.notEqual(okCase.lastReconcileStatus, 'failed')
    assert.ok(state.lastSyncReport.some(entry => entry.caseId === 'case-0917' && entry.status === 'success'))

    // ── 重试：这次不再注入故障 ──
    service.retryCase('case-1042')
    state = service.snapshot
    const retried = state.cases.find(item => item.id === 'case-1042')!
    assert.notEqual(retried.lastReconcileStatus, 'failed')
    const featureH = retried.features.find(item => item.id === 'c2-f-2')!
    assert.equal(featureH.linkStatus, 'pending')
    // 本案件自定义特征不受影响
    const localK = retried.features.find(item => item.id === 'c2-f-5')!
    assert.equal(localK.linkStatus, 'local')
    // 持久化可重读
    const persisted: WorkbenchState = JSON.parse(storage.getItem('patent-claim-mapping-workbench-v2')!)
    assert.equal(persisted.version, 2)
  })

  it('代理人确认挂起：选新条目则重新引用，选自定义则解除引用；校验随之更新', () => {
    const { service } = newService()
    const sensorId = service.snapshot.catalog.find(item => item.label === '环境传感模块')!.id
    service.addDraft('split', sensorId)
    const draft = service.snapshot.catalogDrafts[0]
    service.updateDraftPart(draft.id, 0, { label: '温度传感器', definition: '采集温度数据的温度传感器' })
    service.updateDraftPart(draft.id, 1, { label: '湿度传感器', definition: '采集湿度数据的湿度传感器' })
    service.publishCatalog('')

    service.selectCase('case-0917')
    const pendingFeature = service.snapshot.cases.find(item => item.id === 'case-0917')!.features.find(item => item.id === 'feature-b')!
    assert.equal(pendingFeature.linkStatus, 'pending')
    assert.ok(service.validate().some(issue => issue.type === 'pending-link'))

    const humidityId = service.snapshot.catalog.find(item => item.label === '湿度传感器')!.id
    service.resolvePending('feature-b', humidityId)
    const resolved = service.snapshot.cases.find(item => item.id === 'case-0917')!.features.find(item => item.id === 'feature-b')!
    assert.equal(resolved.catalogFeatureId, humidityId)
    assert.equal(resolved.linkStatus, 'linked')
    assert.equal(resolved.pending, null)
    assert.ok(resolved.supportIds.includes('para-0012'))
    assert.ok(!service.validate().some(issue => issue.type === 'pending-link'))

    // 撤销可回退确认动作
    service.undo()
    const undone = service.snapshot.cases.find(item => item.id === 'case-0917')!.features.find(item => item.id === 'feature-b')!
    assert.equal(undone.linkStatus, 'pending')
  })

  it('旧版 v1 本地数据升级为引用特征表结构', () => {
    const storage = memoryStorage()
    Object.assign(globalThis, { localStorage: storage })
    storage.setItem('patent-claim-mapping-workbench-v1', JSON.stringify({
      claims: [{ id: 'claim-1', number: 1, title: '旧案', independent: true, text: '旧正文' }],
      paragraphs: [{ id: 'para-1', section: '[0001]', text: '依据' }],
      features: [
        { id: 'f-1', claimId: 'claim-1', label: 'X · 旧特征', text: '旧定义', parentId: null, referenceIds: [], supportIds: ['para-1'], ownerRole: 'author' },
        { id: 'f-2', claimId: 'claim-1', label: 'Y · 另一特征', text: '旧定义', parentId: null, referenceIds: [], supportIds: [], ownerRole: 'author' }
      ],
      annotations: [], orphanMappings: [], versions: [],
      role: 'author', selectedClaimId: 'claim-1', selectedFeatureId: 'f-1', activeTab: 'mapping'
    }))
    const service = new WorkbenchService()
    const state = service.snapshot
    assert.equal(state.version, 2)
    assert.equal(state.cases.length, 1)
    const migratedCase = state.cases[0]
    assert.equal(migratedCase.features.length, 2)
    for (const feature of migratedCase.features) {
      assert.ok(feature.catalogFeatureId, `${feature.id} 应引用特征表条目`)
      assert.equal(feature.linkStatus, 'linked')
      assert.equal(feature.linkedCatalogVersion, 1)
    }
    // 不同名称生成不同特征表条目
    assert.equal(state.catalog.length, 2)
    assert.equal(state.catalog[0].category, '升级自旧工作台数据')
    // 两条案件特征引用各自条目
    assert.equal(migratedCase.features[0].catalogFeatureId, state.catalog.find(item => item.label === 'X · 旧特征')?.id)
    assert.equal(migratedCase.features[1].catalogFeatureId, state.catalog.find(item => item.label === 'Y · 另一特征')?.id)
    // 旧 key 已迁移清理
    assert.equal(storage.getItem('patent-claim-mapping-workbench-v1'), null)
  })

  it('migrateV1 对异常字段容错', () => {
    const migrated = migrateV1({ features: 'not-array' } as never, 'author')
    assert.equal(migrated.version, 2)
    assert.equal(migrated.catalog.length, 0)
    assert.equal(migrated.cases[0].features.length, 0)
  })

  it('migrateV1 按“名称+定义”去重特征表条目', () => {
    const migrated = migrateV1({
      claims: [{ id: 'c1', number: 1, title: 't', independent: true, text: 't' }],
      features: [
        { id: 'f1', claimId: 'c1', label: 'A', text: '同一文本', parentId: null, referenceIds: [], supportIds: [], ownerRole: 'author' },
        { id: 'f2', claimId: 'c1', label: 'A', text: '同一文本', parentId: null, referenceIds: [], supportIds: [], ownerRole: 'author' },
        { id: 'f3', claimId: 'c1', label: 'B', text: '另一文本', parentId: null, referenceIds: [], supportIds: [], ownerRole: 'author' }
      ]
    } as never, 'author')
    assert.equal(migrated.catalog.length, 2)
    const f1 = migrated.cases[0].features.find(f => f.id === 'f1')!
    const f2 = migrated.cases[0].features.find(f => f.id === 'f2')!
    assert.equal(f1.catalogFeatureId, f2.catalogFeatureId)
  })
})
