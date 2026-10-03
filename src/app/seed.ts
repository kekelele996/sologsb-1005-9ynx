import type {
  Annotation, CaseFile, Claim, Feature, FeatureTable, MasterFeature,
  Paragraph, WorkbenchState
} from './models'

const now = '2026-10-03T01:00:00.000Z'

/**
 * 所级技术特征表（统一维护）。
 * revision 1：A 柜体 / B 环境传感模块 / C 控制模块通信 / D 调节微环境 / E 对角线布置 / F 分级调节
 * revision 2 的变更：
 *   - B（环境传感模块）拆成 B1（温湿度采集）与 B2（柜内布置）两条
 *   - D（调节微环境）改定义，由 D1（基于偏差的闭环调节）唯一替代
 *   - A / C / E / F 保持不变
 */
const masterRevision2: MasterFeature[] = [
  {
    id: 'mf-a', code: 'A', label: '柜体', definition: '形成用于陈列的封闭空间的柜体。',
    status: 'active', revision: 1, splitFromId: null, supersedesId: null, replacedByIds: [], updatedAt: now
  },
  {
    id: 'mf-b', code: 'B', label: '环境传感模块', definition: '设置于柜体内，用于采集温湿度数据（旧定义，已拆分退役）。',
    status: 'retired', revision: 1, splitFromId: null, supersedesId: null, replacedByIds: ['mf-b1', 'mf-b2'], updatedAt: now
  },
  {
    id: 'mf-b1', code: 'B1', label: '温湿度采集', definition: '环境传感模块采集温度与相对湿度数据。',
    status: 'active', revision: 2, splitFromId: 'mf-b', supersedesId: null, replacedByIds: [], updatedAt: now
  },
  {
    id: 'mf-b2', code: 'B2', label: '传感模块柜内布置', definition: '环境传感模块设置于柜体内部，安装位置沿柜体对角线分布。',
    status: 'active', revision: 2, splitFromId: 'mf-b', supersedesId: null, replacedByIds: [], updatedAt: now
  },
  {
    id: 'mf-c', code: 'C', label: '控制模块通信', definition: '控制模块与环境传感模块之间建立通信链路。',
    status: 'active', revision: 1, splitFromId: null, supersedesId: null, replacedByIds: [], updatedAt: now
  },
  {
    id: 'mf-d', code: 'D', label: '调节微环境', definition: '根据温湿度数据调节柜体微环境（旧定义，已重定义退役）。',
    status: 'retired', revision: 1, splitFromId: null, supersedesId: null, replacedByIds: ['mf-d1'], updatedAt: now
  },
  {
    id: 'mf-d1', code: 'D1', label: '基于偏差的闭环调节', definition: '控制模块比较温湿度数据与预设区间的偏差，闭环调节柜体微环境。',
    status: 'active', revision: 2, splitFromId: null, supersedesId: 'mf-d', replacedByIds: [], updatedAt: now
  },
  {
    id: 'mf-e', code: 'E', label: '对角线布置', definition: '多个温湿度传感器沿柜体对角线布置。',
    status: 'active', revision: 1, splitFromId: null, supersedesId: null, replacedByIds: [], updatedAt: now
  },
  {
    id: 'mf-f', code: 'F', label: '分级调节', definition: '基于历史数据与当前数据之间的偏差分级调节除湿单元。',
    status: 'active', revision: 1, splitFromId: null, supersedesId: null, replacedByIds: [], updatedAt: now
  }
]

const tableRevision2: FeatureTable = { revision: 2, features: masterRevision2 }

/** 特征表 revision 1 的精简快照，供升级后的演示案件初始对齐演示 */
export function tableRevision1(): FeatureTable {
  const features: MasterFeature[] = ['mf-a', 'mf-b', 'mf-c', 'mf-d', 'mf-e', 'mf-f'].map(id => {
    const source = masterRevision2.find(item => item.id === id)!
    return { ...source, definition: legacyDefinition(id), status: 'active', replacedByIds: [] }
  })
  return { revision: 1, features }
}

function legacyDefinition(id: string): string {
  const map: Record<string, string> = {
    'mf-a': '柜体。',
    'mf-b': '设置于柜体内，用于采集温湿度数据。',
    'mf-c': '与环境传感模块通信。',
    'mf-d': '根据温湿度数据调节柜体微环境。',
    'mf-e': '多个温湿度传感器沿柜体对角线布置。',
    'mf-f': '基于历史数据与当前数据的偏差分级调节除湿单元。'
  }
  return map[id]
}

const claimsAlpha: Claim[] = [
  { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
  { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
  { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
]
const paragraphsAlpha: Paragraph[] = [
  { id: 'para-0012', section: '说明书 [0012]', text: '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。' },
  { id: 'para-0018', section: '说明书 [0018]', text: '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。' },
  { id: 'para-0024', section: '说明书 [0024]', text: '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。' },
  { id: 'para-0031', section: '说明书 [0031]', text: '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。' },
  { id: 'para-0040', section: '说明书 [0040]', text: '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。' }
]
const featuresAlpha: Feature[] = [
  { id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], supportIds: ['para-0012'], ownerRole: 'author', tableFeatureId: 'mf-a', alignedRevision: 1 },
  { id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], supportIds: ['para-0012', 'para-0018'], ownerRole: 'author', tableFeatureId: 'mf-b', alignedRevision: 1 },
  { id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], supportIds: ['para-0012', 'para-0031'], ownerRole: 'author', tableFeatureId: 'mf-c', alignedRevision: 1 },
  { id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], supportIds: ['para-0024', 'para-0040'], ownerRole: 'author', tableFeatureId: 'mf-d', alignedRevision: 1 },
  { id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], supportIds: ['para-0018'], ownerRole: 'author', tableFeatureId: 'mf-e', alignedRevision: 1 },
  { id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], supportIds: ['para-0024'], ownerRole: 'author', tableFeatureId: 'mf-f', alignedRevision: 1 }
]
const annotationsAlpha: Annotation[] = [
  { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
  { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
]

/**
 * 案件甲：停留在特征表 revision 1，尚未对上 revision 2。
 * 触发同步后：D → D1 唯一自动换；B 拆成 B1/B2 无法唯一，挂起等代理人确认。
 */
export function caseAlpha(): CaseFile {
  return {
    id: 'case-alpha', name: 'CN-2026-0917 · 自适应展柜环境控制装置', agent: '代理人 · 陈昊',
    claims: structuredClone(claimsAlpha), paragraphs: structuredClone(paragraphsAlpha),
    features: structuredClone(featuresAlpha), annotations: structuredClone(annotationsAlpha),
    orphanMappings: [], versions: [], pendingLinks: [],
    sync: { status: 'out-of-sync', alignedRevision: 1, lastRunAt: null, lastError: null, attemptedRevision: null, autoSwitchLog: [] },
    selectedClaimId: 'claim-1', selectedFeatureId: 'feature-b'
  }
}

/**
 * 案件乙：已经对上 revision 2 的案件，用于演示再次发布特征表时的增量处理，
 * 以及“某个案件失败后按案件重试、其他案件不受影响”。
 */
export function caseBeta(): CaseFile {
  const features: Feature[] = [
    { id: 'b-feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体，形成封闭陈列空间', parentId: null, referenceIds: [], supportIds: ['b-para-1'], ownerRole: 'author', tableFeatureId: 'mf-a', alignedRevision: 2 },
    { id: 'b-feature-b1', claimId: 'claim-1', label: 'B1 · 温湿度采集', text: '采集温度与相对湿度数据', parentId: 'b-feature-a', referenceIds: [], supportIds: ['b-para-1'], ownerRole: 'author', tableFeatureId: 'mf-b1', alignedRevision: 2 },
    { id: 'b-feature-d1', claimId: 'claim-1', label: 'D1 · 闭环调节', text: '比较偏差并闭环调节微环境', parentId: null, referenceIds: ['b-feature-b1'], supportIds: ['b-para-2'], ownerRole: 'author', tableFeatureId: 'mf-d1', alignedRevision: 2 }
  ]
  return {
    id: 'case-beta', name: 'CN-2026-1102 · 展柜节能控制系统', agent: '代理人 · 周屿',
    claims: [
      { id: 'claim-1', number: 1, title: '一种展柜节能控制系统', independent: true, text: '一种展柜节能控制系统，包括柜体、采集温湿度的传感模块以及按偏差闭环调节的控制模块。' }
    ],
    paragraphs: [
      { id: 'b-para-1', section: '说明书 [0007]', text: '柜体形成封闭空间，传感模块采集温度与相对湿度。' },
      { id: 'b-para-2', section: '说明书 [0015]', text: '控制模块比较实测数据与预设区间的偏差，对微环境进行闭环调节。' }
    ],
    features, annotations: [], orphanMappings: [], versions: [], pendingLinks: [],
    sync: { status: 'synced', alignedRevision: 2, lastRunAt: now, lastError: null, attemptedRevision: null, autoSwitchLog: [] },
    selectedClaimId: 'claim-1', selectedFeatureId: null
  }
}

/**
 * 案件丙：以旧结构（v1：无案件容器、特征不引用特征表）构造，
 * 用于演示“工作台里已有数据先升级成引用特征表的结构”。
 */
export function legacyV1State(): Record<string, unknown> {
  return {
    claims: structuredClone(claimsAlpha),
    paragraphs: structuredClone(paragraphsAlpha),
    features: featuresAlpha.map(({ tableFeatureId: _t, alignedRevision: _r, ...rest }) => rest),
    annotations: structuredClone(annotationsAlpha),
    orphanMappings: [],
    versions: [],
    role: 'author',
    currentUserRole: 'author',
    selectedClaimId: 'claim-1',
    selectedFeatureId: 'feature-b',
    activeTab: 'mapping'
  }
}

export function seedState(): WorkbenchState {
  return {
    schemaVersion: 2,
    table: structuredClone(tableRevision2),
    cases: [caseAlpha(), caseBeta()],
    activeCaseId: 'case-alpha',
    view: 'case',
    activeTab: 'mapping',
    role: 'author',
    currentUserRole: 'author',
    failNextSyncCaseIds: []
  }
}
