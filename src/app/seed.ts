import type {
  CaseRecord,
  CatalogFeature,
  Feature,
  Role,
  WorkbenchState
} from './models'

const now = () => new Date().toISOString()

const catalogSeed: Array<Omit<CatalogFeature, 'status' | 'version' | 'createdAt' | 'updatedAt'>> = [
  { id: 'cat-cabinet', code: 'JT-A', label: '柜体', definition: '柜体形成用于陈列文物的封闭空间。', category: '结构部件' },
  { id: 'cat-sensor', code: 'JT-B', label: '环境传感模块', definition: '环境传感模块设置于柜体内，用于采集温度、湿度等环境数据。', category: '检测部件' },
  { id: 'cat-control-comm', code: 'JT-C', label: '控制模块通信', definition: '控制模块与环境传感模块通信连接，接收传感数据。', category: '控制连接' },
  { id: 'cat-regulation', code: 'JT-D', label: '调节微环境', definition: '控制模块根据温湿度数据调节柜体的微环境。', category: '控制策略' },
  { id: 'cat-diagonal', code: 'JT-E', label: '对角线布置', definition: '多个温湿度传感器沿柜体对角线布置。', category: '结构布置' },
  { id: 'cat-graded', code: 'JT-F', label: '分级调节', definition: '控制模块基于历史数据与当前数据的偏差分级调节除湿单元。', category: '控制策略' }
]

function seedCatalog(): CatalogFeature[] {
  const stamp = '2026-09-20T02:00:00.000Z'
  return catalogSeed.map(item => ({ ...item, status: 'active', version: 1, createdAt: stamp, updatedAt: stamp }))
}

function link(feature: Omit<Feature, 'linkStatus' | 'pending' | 'linkedCatalogVersion' | 'catalogFeatureId'>, catalogId: string): Feature {
  return { ...feature, catalogFeatureId: catalogId, linkStatus: 'linked', pending: null, linkedCatalogVersion: 1 }
}
function local(feature: Omit<Feature, 'linkStatus' | 'pending' | 'linkedCatalogVersion' | 'catalogFeatureId'>): Feature {
  return { ...feature, catalogFeatureId: null, linkStatus: 'local', pending: null, linkedCatalogVersion: null }
}

function caseOne(): CaseRecord {
  const claims = [
    { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
    { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
    { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
  ]
  const paragraphs = [
    { id: 'para-0012', section: '说明书 [0012]', text: '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。' },
    { id: 'para-0018', section: '说明书 [0018]', text: '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。' },
    { id: 'para-0024', section: '说明书 [0024]', text: '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。' },
    { id: 'para-0031', section: '说明书 [0031]', text: '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。' },
    { id: 'para-0040', section: '说明书 [0040]', text: '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。' }
  ]
  const features: Feature[] = [
    link({ id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], supportIds: ['para-0012'], ownerRole: 'author' }, 'cat-cabinet'),
    link({ id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], supportIds: ['para-0012', 'para-0018'], ownerRole: 'author' }, 'cat-sensor'),
    link({ id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], supportIds: ['para-0012', 'para-0031'], ownerRole: 'author' }, 'cat-control-comm'),
    link({ id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], supportIds: ['para-0024', 'para-0040'], ownerRole: 'author' }, 'cat-regulation'),
    link({ id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], supportIds: ['para-0018'], ownerRole: 'author' }, 'cat-diagonal'),
    link({ id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], supportIds: ['para-0024'], ownerRole: 'author' }, 'cat-graded')
  ]
  return {
    id: 'case-0917',
    name: '自适应展柜环境控制装置',
    applicationNo: 'CN-2026-0917',
    agentName: '陈昊',
    claims, paragraphs, features,
    annotations: [
      { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
      { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
    ],
    orphanMappings: [], versions: [],
    selectedClaimId: 'claim-1', selectedFeatureId: 'feature-b',
    lastReconcileAt: null, lastReconcileStatus: 'never', lastReconcileError: null
  }
}

function caseTwo(): CaseRecord {
  const claims = [
    { id: 'c2-claim-1', number: 1, title: '一种展柜恒湿调节系统', independent: true, text: '一种展柜恒湿调节系统，包括：柜体；传感模组，设置于所述柜体内并采集环境参数；以及恒湿控制单元，与所述传感模组通信，并依据所述环境参数调节所述柜体内湿度。' },
    { id: 'c2-claim-2', number: 2, title: '传感器分布', independent: false, text: '根据权利要求1所述的系统，其特征在于，所述传感模组包括沿所述柜体对角方向分布的多个温湿度传感器。' }
  ]
  const paragraphs = [
    { id: 'c2-para-1', section: '说明书 [0007]', text: '柜体用于形成相对封闭的陈列空间，传感模组安装于柜内各位置，采集温度与相对湿度等环境参数。' },
    { id: 'c2-para-2', section: '说明书 [0011]', text: '恒湿控制单元与传感模组之间通过总线或无线网络通信连接，周期性接收环境参数。' },
    { id: 'c2-para-3', section: '说明书 [0015]', text: '多个温湿度传感器沿柜体对角方向分布，以降低局部气流造成的测量偏差。' },
    { id: 'c2-para-4', section: '说明书 [0019]', text: '恒湿控制单元将柜内相对湿度维持在预设区间内，例如45%至55%。' }
  ]
  const features: Feature[] = [
    link({ id: 'c2-f-1', claimId: 'c2-claim-1', label: 'G · 封闭柜体', text: '柜体形成封闭的陈列空间', parentId: null, referenceIds: [], supportIds: ['c2-para-1'], ownerRole: 'author' }, 'cat-cabinet'),
    link({ id: 'c2-f-2', claimId: 'c2-claim-1', label: 'H · 柜内传感模组', text: '传感模组设置于柜体内，采集温度与相对湿度等环境参数', parentId: null, referenceIds: [], supportIds: ['c2-para-1'], ownerRole: 'author' }, 'cat-sensor'),
    link({ id: 'c2-f-3', claimId: 'c2-claim-1', label: 'I · 通信链路', text: '恒湿控制单元与传感模组通信连接，接收环境参数', parentId: null, referenceIds: ['c2-f-2'], supportIds: ['c2-para-2'], ownerRole: 'author' }, 'cat-control-comm'),
    link({ id: 'c2-f-4', claimId: 'c2-claim-2', label: 'J · 对角分布', text: '多个温湿度传感器沿柜体对角方向分布', parentId: null, referenceIds: [], supportIds: ['c2-para-3'], ownerRole: 'author' }, 'cat-diagonal'),
    local({ id: 'c2-f-5', claimId: 'c2-claim-1', label: 'K · 湿度区间', text: '恒湿控制单元将柜内相对湿度维持在45%至55%区间', parentId: null, referenceIds: [], supportIds: ['c2-para-4'], ownerRole: 'author' })
  ]
  return {
    id: 'case-1042',
    name: '展柜恒湿调节系统',
    applicationNo: 'CN-2026-1042',
    agentName: '周宁',
    claims, paragraphs, features,
    annotations: [], orphanMappings: [], versions: [],
    selectedClaimId: 'c2-claim-1', selectedFeatureId: 'c2-f-2',
    lastReconcileAt: null, lastReconcileStatus: 'never', lastReconcileError: null
  }
}

export function demoStateV2(role: Role = 'author'): WorkbenchState {
  return {
    version: 2,
    catalog: seedCatalog(),
    catalogChanges: [],
    catalogDrafts: [],
    cases: [caseOne(), caseTwo()],
    activeCaseId: 'case-0917',
    activeTab: 'mapping',
    role,
    currentUserRole: role,
    lastSyncReport: [],
    failNextCaseId: null
  }
}

/**
 * 旧版（v1，单一案件）本地数据升级为引用特征表的结构：
 * 为每条已存在的案件特征在特征表中生成稳定条目，案件特征改为引用该条目，
 * 然后整体作为一个案件工作区并入多案件结构。
 */
export function migrateV1(raw: Record<string, unknown>, role: Role): WorkbenchState {
  const oldFeatures = Array.isArray(raw['features']) ? raw['features'] as Array<Record<string, unknown>> : []
  const catalog: CatalogFeature[] = []
  const idByKey = new Map<string, string>()
  const stamp = now()
  let seq = 0
  const catalogIdFor = (label: string, text: string): string => {
    const key = `${label}::${text}`
    const existing = idByKey.get(key)
    if (existing) return existing
    seq += 1
    const id = `cat-mig-${seq}`
    catalog.push({
      id,
      code: `JG-${String(seq).padStart(2, '0')}`,
      label,
      definition: text,
      category: '升级自旧工作台数据',
      status: 'active',
      version: 1,
      createdAt: stamp,
      updatedAt: stamp
    })
    idByKey.set(key, id)
    return id
  }

  const features: Feature[] = oldFeatures.map(item => {
    const label = String(item['label'] ?? '未命名特征')
    const text = String(item['text'] ?? '')
    const catalogId = catalogIdFor(label, text)
    return {
      id: String(item['id'] ?? `feature-${seq}-${Math.random().toString(36).slice(2, 7)}`),
      claimId: String(item['claimId'] ?? ''),
      label, text,
      parentId: (item['parentId'] as string | null) ?? null,
      referenceIds: Array.isArray(item['referenceIds']) ? item['referenceIds'] as string[] : [],
      supportIds: Array.isArray(item['supportIds']) ? item['supportIds'] as string[] : [],
      ownerRole: (['author', 'examiner', 'viewer'].includes(item['ownerRole'] as string) ? item['ownerRole'] : 'author') as Role,
      catalogFeatureId: catalogId,
      linkStatus: 'linked',
      pending: null,
      linkedCatalogVersion: 1
    }
  })

  const asArray = <T,>(key: string): T[] => Array.isArray(raw[key]) ? raw[key] as T[] : []
  const migratedCase: CaseRecord = {
    id: `case-mig-${Date.now()}`,
    name: '升级案件（原工作台数据）',
    applicationNo: 'CN-LEGACY',
    agentName: role === 'examiner' ? '审查员' : '代理人',
    claims: asArray('claims'),
    paragraphs: asArray('paragraphs'),
    features,
    annotations: asArray('annotations'),
    orphanMappings: asArray('orphanMappings'),
    versions: asArray('versions'),
    selectedClaimId: String(raw['selectedClaimId'] ?? ''),
    selectedFeatureId: (raw['selectedFeatureId'] as string | null) ?? null,
    lastReconcileAt: stamp,
    lastReconcileStatus: 'ok',
    lastReconcileError: null
  }
  if (!migratedCase.selectedClaimId) migratedCase.selectedClaimId = migratedCase.claims[0]?.id || ''
  if (!migratedCase.features.some(item => item.id === migratedCase.selectedFeatureId)) migratedCase.selectedFeatureId = null

  return {
    version: 2,
    catalog,
    catalogChanges: [],
    catalogDrafts: [],
    cases: [migratedCase],
    activeCaseId: migratedCase.id,
    activeTab: typeof raw['activeTab'] === 'string' ? raw['activeTab'] as string : 'mapping',
    role,
    currentUserRole: role,
    lastSyncReport: [],
    failNextCaseId: null
  }
}
