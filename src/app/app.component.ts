import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ButtonModule } from 'primeng/button'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectModule } from 'primeng/select'
import { CardModule } from 'primeng/card'
import { BadgeModule } from 'primeng/badge'
import { DialogModule } from 'primeng/dialog'
import { TooltipModule } from 'primeng/tooltip'
import { Subscription } from 'rxjs'
import type {
  Annotation, CaseFile, Claim, Feature, MasterFeature, PendingLink,
  Role, ValidationIssue, WorkbenchState
} from './models'
import { WorkbenchService, type SyncRunReport } from './workbench.service'
import { caseNeedsSync, caseStaleFeatures } from './sync-engine'

type TableDialogMode = 'add' | 'redefine' | 'split'

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TextareaModule, SelectModule, CardModule, BadgeModule, DialogModule, TooltipModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  state: WorkbenchState
  issues: ValidationIssue[] = []
  history = { past: 0, future: 0 }
  compareA = ''
  compareB = ''
  annotationDraft = ''
  versionDialog = false
  versionName = ''
  activeIssue: ValidationIssue | null = null
  lastReport: SyncRunReport | null = null
  /** 挂起确认页每条挂起的选择：候选条目 id 或 __detach */
  pendingChoices: Record<string, string> = {}
  roleOptions: Array<{ label: string; value: Role }> = [
    { label: '代理人（可编辑主数据与本人批注）', value: 'author' },
    { label: '审查员（可编辑本人批注）', value: 'examiner' },
    { label: '观察者（只读）', value: 'viewer' }
  ]

  tableDialogMode: TableDialogMode = 'add'
  tableDialogVisible = false
  tableDialogMasterId: string | null = null
  tableForm = {
    code: '', label: '', definition: '',
    code2: '', label2: '', definition2: ''
  }
  private subscriptions = new Subscription()

  constructor(readonly service: WorkbenchService) {
    this.state = service.snapshot
  }

  ngOnInit(): void {
    this.subscriptions.add(this.service.state$.subscribe(state => {
      this.state = structuredClone(state)
      this.syncVersions()
    }))
    this.subscriptions.add(this.service.issues$.subscribe(issues => this.issues = issues))
    this.subscriptions.add(this.service.history$.subscribe(history => this.history = history))
    window.addEventListener('keydown', this.handleKeyboard)
  }

  ngAfterViewInit(): void {
    this.service.restorePosition()
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe()
    window.removeEventListener('keydown', this.handleKeyboard)
  }

  // ---------- 活动案件派生数据 ----------

  get activeCase(): CaseFile { return this.state.cases.find(item => item.id === this.state.activeCaseId) || this.state.cases[0] }
  get selectedClaim(): Claim | undefined { return this.activeCase?.claims.find(item => item.id === this.activeCase.selectedClaimId) }
  get selectedFeature(): Feature | undefined { return this.activeCase?.features.find(item => item.id === this.activeCase.selectedFeatureId) }
  get claimFeatures(): Feature[] { return this.activeCase ? this.activeCase.features.filter(item => item.claimId === this.activeCase.selectedClaimId) : [] }
  get featureAnnotations(): Annotation[] { return this.selectedFeature ? this.activeCase.annotations.filter(item => item.featureId === this.selectedFeature?.id) : [] }
  get currentRoleLabel(): string { return this.roleOptions.find(item => item.value === this.state.role)?.label || '' }
  get errorCount(): number { return this.issues.filter(item => item.severity === 'error').length }
  get warningCount(): number { return this.issues.filter(item => item.severity === 'warning').length }
  get canEditMainData(): boolean { return this.state.role !== 'viewer' }
  get mappedFeatureCount(): number { return this.claimFeatures.filter(feature => feature.supportIds.length > 0).length }
  get activeMasters(): MasterFeature[] { return this.state.table.features.filter(item => item.status === 'active') }
  get retiredMasters(): MasterFeature[] { return this.state.table.features.filter(item => item.status === 'retired') }

  get pendingLinks(): PendingLink[] { return this.activeCase?.pendingLinks || [] }
  isFeaturePending(featureId: string): boolean { return this.activeCase?.pendingLinks.some(link => link.featureId === featureId) || false }
  selectedFeatureLink(): PendingLink | undefined {
    if (!this.selectedFeature) return undefined
    return this.activeCase.pendingLinks.find(link => link.featureId === this.selectedFeature?.id)
  }

  claimLabel(id: string): string { return this.activeCase?.claims.find(item => item.id === id)?.title || '未命名权利要求' }
  featureLabel(id: string): string { return this.activeCase?.features.find(item => item.id === id)?.label || id }
  paragraphLabel(id: string): string { return this.activeCase?.paragraphs.find(item => item.id === id)?.section || id }
  master(id: string | null): MasterFeature | undefined { return id ? this.state.table.features.find(item => item.id === id) : undefined }
  masterLabel(id: string | null): string { const master = this.master(id); return master ? `${master.code} · ${master.label}` : '案件本地特征（未挂特征表）' }
  isMapped(feature: Feature, paragraphId: string): boolean { return feature.supportIds.includes(paragraphId) }
  isOwnAnnotation(annotation: Annotation): boolean { return annotation.authorRole === this.state.role }
  ownerLabel(role: Role): string { return ({ author: '代理人', examiner: '审查员', viewer: '观察者' })[role] }

  // ---------- 案件 / 特征表状态 ----------

  caseStaleCount(caseFile: CaseFile): number { return caseStaleFeatures(caseFile, this.state.table).length }
  caseNeedsSync(caseFile: CaseFile): boolean { return caseNeedsSync(caseFile, this.state.table) }
  caseStatus(caseFile: CaseFile): { label: string; cls: string } {
    if (caseFile.sync.status === 'failed') return { label: '处理失败 · 可重试', cls: 'failed' }
    if (caseFile.pendingLinks.length) return { label: `${caseFile.pendingLinks.length} 条挂起待确认`, cls: 'pending' }
    if (this.caseStaleCount(caseFile)) return { label: '待按新特征表对齐', cls: 'stale' }
    return { label: `已对齐 r${caseFile.sync.alignedRevision}`, cls: 'synced' }
  }
  willFail(caseId: string): boolean { return this.state.failNextSyncCaseIds.includes(caseId) }

  // ---------- 同步操作 ----------

  syncCase(caseId: string): void {
    this.lastReport = this.service.syncCase(caseId)
  }
  syncAll(): void {
    this.lastReport = this.service.syncAll()
  }
  reportCaseName(caseId: string): string { return this.state.cases.find(item => item.id === caseId)?.name || caseId }

  resolveLink(link: PendingLink): void {
    const choice = this.pendingChoices[link.id]
    if (!choice) return
    if (choice === '__detach') this.service.resolvePending(link.id, { type: 'detach' })
    else this.service.resolvePending(link.id, { type: 'pick', tableFeatureId: choice })
    delete this.pendingChoices[link.id]
  }
  otherMasters(link: PendingLink): MasterFeature[] {
    const scoped = new Set(link.candidates.map(candidate => candidate.tableFeatureId))
    return this.activeMasters.filter(master => !scoped.has(master.id))
  }

  bindFeature(event: Event): void {
    if (!this.selectedFeature) return
    const value = (event.target as HTMLSelectElement).value
    this.service.updateFeature(this.selectedFeature.id, {
      tableFeatureId: value || null,
      alignedRevision: value ? this.state.table.revision : null
    })
  }

  // ---------- 特征表维护 ----------

  openTableDialog(mode: TableDialogMode, master?: MasterFeature): void {
    this.tableDialogMode = mode
    this.tableDialogMasterId = master?.id || null
    this.tableForm = {
      code: mode === 'redefine' && master ? `${master.code}1` : '',
      label: mode === 'redefine' && master ? master.label : '',
      definition: '',
      code2: '', label2: '', definition2: ''
    }
    this.tableDialogVisible = true
  }

  get tableDialogHeader(): string {
    if (this.tableDialogMode === 'add') return '新增特征表条目'
    if (this.tableDialogMode === 'redefine') return '改掉定义（旧定义退役，唯一生效）'
    return '把特征拆成两条（旧条目退役，案件需重新对上）'
  }

  submitTableDialog(): void {
    const form = this.tableForm
    if (this.tableDialogMode === 'add') {
      this.service.addMasterFeature(form.code, form.label, form.definition)
    } else if (this.tableDialogMode === 'redefine' && this.tableDialogMasterId) {
      this.service.redefineMaster(this.tableDialogMasterId, form.code, form.label, form.definition)
    } else if (this.tableDialogMode === 'split' && this.tableDialogMasterId) {
      this.service.splitMaster(this.tableDialogMasterId, [
        { code: form.code, label: form.label, definition: form.definition },
        { code: form.code2, label: form.label2, definition: form.definition2 }
      ])
    }
    this.tableDialogVisible = false
  }

  // ---------- 原有编辑操作 ----------

  updateClaimField(field: 'title' | 'text' | 'number' | 'independent', event: Event): void {
    const element = event.target as HTMLInputElement
    const value = field === 'number' ? Number(element.value) : field === 'independent' ? element.checked : element.value
    this.service.updateClaim({ [field]: value })
  }

  updateFeatureField(field: 'label' | 'text', event: Event): void {
    if (!this.selectedFeature) return
    this.service.updateFeature(this.selectedFeature.id, { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
  }

  updateFeatureParent(event: Event): void {
    if (!this.selectedFeature) return
    this.service.updateFeature(this.selectedFeature.id, { parentId: (event.target as HTMLSelectElement).value || null })
  }

  toggleReference(featureId: string, checked: boolean): void {
    if (!this.selectedFeature) return
    const ids = checked
      ? Array.from(new Set([...this.selectedFeature.referenceIds, featureId]))
      : this.selectedFeature.referenceIds.filter(id => id !== featureId)
    this.service.updateFeature(this.selectedFeature.id, { referenceIds: ids })
  }

  addAnnotation(): void {
    if (!this.selectedFeature) return
    this.service.addAnnotation(this.selectedFeature.id, this.annotationDraft)
    this.annotationDraft = ''
  }

  updateAnnotation(annotation: Annotation, event: Event): void {
    this.service.updateAnnotation(annotation.id, (event.target as HTMLTextAreaElement).value)
  }

  createVersion(): void {
    this.service.createVersion(this.versionName)
    this.versionName = ''
    this.versionDialog = false
  }

  restoreVersion(id: string): void { this.service.restoreVersion(id) }
  getVersion(id: string) { return this.activeCase?.versions.find(item => item.id === id) }
  compareRows(): Array<{ label: string; before: string; after: string; changed: boolean }> {
    const a = this.getVersion(this.compareA)
    const b = this.getVersion(this.compareB)
    if (!a || !b) return []
    const ids = Array.from(new Set([...a.claims.map(item => item.id), ...b.claims.map(item => item.id)]))
    return ids.map(id => {
      const before = a.claims.find(item => item.id === id)?.text || ''
      const after = b.claims.find(item => item.id === id)?.text || ''
      return { label: `权利要求 ${a.claims.find(item => item.id === id)?.number || b.claims.find(item => item.id === id)?.number || '?'}`, before, after, changed: before !== after }
    })
  }

  exportFile(type: 'json' | 'csv'): void {
    const content = type === 'json' ? this.service.exportJson() : this.service.exportCsv()
    const mime = type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `patent-claim-check-${new Date().toISOString().slice(0, 10)}.${type}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  locateIssue(issue: ValidationIssue): void {
    this.activeIssue = issue
    if (issue.type === 'pending-link') {
      this.service.setTab('pending')
      if (issue.featureId) this.service.selectFeature(issue.featureId)
    } else {
      if (issue.featureId) this.service.selectFeature(issue.featureId)
      this.service.setTab('mapping')
    }
  }

  closeIssue(): void { this.activeIssue = null }

  private syncVersions(): void {
    const versions = this.activeCase?.versions || []
    if (!versions.some(item => item.id === this.compareA)) this.compareA = versions[1]?.id || versions[0]?.id || ''
    if (!versions.some(item => item.id === this.compareB)) this.compareB = versions[0]?.id || ''
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? this.service.redo() : this.service.undo()
    } else if (event.key.toLowerCase() === 'y') {
      event.preventDefault()
      this.service.redo()
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      this.versionDialog = true
    }
  }
}
