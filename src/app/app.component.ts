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
  Annotation,
  CaseRecord,
  CatalogDraft,
  CatalogFeature,
  Claim,
  Feature,
  Role,
  SyncReportEntry,
  ValidationIssue,
  WorkbenchState
} from './models'
import { WorkbenchService } from './workbench.service'

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TextareaModule, SelectModule, CardModule, BadgeModule, DialogModule, TooltipModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  state!: WorkbenchState
  issues: ValidationIssue[] = []
  history = { past: 0, future: 0 }
  compareA = ''
  compareB = ''
  annotationDraft = ''
  versionDialog = false
  versionName = ''
  activeIssue: ValidationIssue | null = null
  publishDialog = false
  publishNote = ''
  caseDraft = { name: '', applicationNo: '' }
  roleOptions: Array<{ label: string; value: Role }> = [
    { label: '代理人（可编辑主数据、特征表与本人批注）', value: 'author' },
    { label: '审查员（可编辑本人批注）', value: 'examiner' },
    { label: '观察者（只读）', value: 'viewer' }
  ]
  private subscriptions = new Subscription()

  constructor(readonly service: WorkbenchService) {
    this.state = service.snapshot
  }

  ngOnInit(): void {
    this.subscriptions.add(this.service.state$.subscribe(state => {
      this.state = state
      this.syncVersions()
    }))
    this.subscriptions.add(this.service.issues$.subscribe(issues => this.issues = issues))
    this.subscriptions.add(this.service.history$.subscribe(history => this.history = history))
    window.addEventListener('keydown', this.handleKeyboard)
  }

  ngAfterViewInit(): void {
    setTimeout(() => window.scrollTo({ top: this.service.readPosition(), behavior: 'instant' as ScrollBehavior }), 0)
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe()
    window.removeEventListener('keydown', this.handleKeyboard)
  }

  get activeCase(): CaseRecord {
    return this.state.cases.find(item => item.id === this.state.activeCaseId) || this.state.cases[0]
  }
  get selectedClaim(): Claim | undefined { return this.activeCase.claims.find(item => item.id === this.activeCase.selectedClaimId) }
  get selectedFeature(): Feature | undefined { return this.activeCase.features.find(item => item.id === this.activeCase.selectedFeatureId) }
  get claimFeatures(): Feature[] { return this.activeCase.features.filter(item => item.claimId === this.activeCase.selectedClaimId) }
  get featureAnnotations(): Annotation[] { return this.selectedFeature ? this.activeCase.annotations.filter(item => item.featureId === this.selectedFeature?.id) : [] }
  get currentRoleLabel(): string { return this.roleOptions.find(item => item.value === this.state.role)?.label || '' }
  get errorCount(): number { return this.issues.filter(item => item.severity === 'error').length }
  get warningCount(): number { return this.issues.filter(item => item.severity === 'warning').length }
  get canEditMainData(): boolean { return this.state.role !== 'viewer' }
  get canAdminCatalog(): boolean { return this.state.role === 'author' }
  get mappedFeatureCount(): number { return this.claimFeatures.filter(feature => feature.supportIds.length > 0).length }
  get activeCatalog(): CatalogFeature[] { return this.state.catalog.filter(item => item.status === 'active') }
  get drafts(): CatalogDraft[] { return this.state.catalogDrafts }
  get syncReport(): SyncReportEntry[] { return this.state.lastSyncReport }
  get pendingCount(): number { return this.activeCase.features.filter(feature => feature.pending).length }

  // 挂起确认弹窗
  pendingResolveTarget: Feature | null = null
  pendingChoice = ''
  pendingCustom = false

  claimLabel(id: string): string { return this.activeCase.claims.find(item => item.id === id)?.title || '未命名权利要求' }
  featureLabel(id: string): string { return this.activeCase.features.find(item => item.id === id)?.label || id }
  paragraphLabel(id: string): string { return this.activeCase.paragraphs.find(item => item.id === id)?.section || id }
  isMapped(feature: Feature, paragraphId: string): boolean { return feature.supportIds.includes(paragraphId) }
  isOwnAnnotation(annotation: Annotation): boolean { return annotation.authorRole === this.state.role }
  ownerLabel(role: Role): string { return ({ author: '代理人', examiner: '审查员', viewer: '观察者' })[role] }

  catalogEntry(id: string | null): CatalogFeature | undefined { return id ? this.state.catalog.find(item => item.id === id) : undefined }
  catalogLabel(id: string): string { return this.state.catalog.find(item => item.id === id)?.label || '?' }
  get casesNeedingRetry(): CaseRecord[] { return this.state.cases.filter(item => item.lastReconcileStatus === 'failed' || item.lastReconcileStatus === 'has-pending') }
  catalogCode(id: string | null): string { return this.catalogEntry(id)?.code || '—' }
  linkBadge(feature: Feature): { text: string; tone: 'linked' | 'pending' | 'local' } {
    if (feature.linkStatus === 'pending') return { text: '待确认', tone: 'pending' }
    if (feature.linkStatus === 'linked') return { text: this.catalogEntry(feature.catalogFeatureId)?.code || '已引用', tone: 'linked' }
    return { text: '本案件', tone: 'local' }
  }
  pendingCandidates(feature: Feature): CatalogFeature[] {
    const ids = feature.pending?.candidateIds || []
    return ids.map(id => this.state.catalog.find(item => item.id === id)).filter((item): item is CatalogFeature => !!item && item.status === 'active')
  }
  scorePercent(score: number): string { return `${Math.round(score * 100)}%` }

  draftFeature(draft: CatalogDraft): CatalogFeature | undefined { return this.state.catalog.find(item => item.id === draft.featureId) }
  hasDraft(featureId: string): boolean { return this.drafts.some(draft => draft.featureId === featureId) }
  replacementLabels(ids: string[]): string { return ids.map(id => this.state.catalog.find(item => item.id === id)?.label || '?').join('、') }
  caseSyncTone(status: CaseRecord['lastReconcileStatus']): string {
    return ({ never: 'neutral', ok: 'ok', 'has-pending': 'pending', failed: 'failed' })[status]
  }
  caseSyncLabel(status: CaseRecord['lastReconcileStatus']): string {
    return ({ never: '未同步', ok: '已对齐', 'has-pending': '有待确认', failed: '上次失败' })[status]
  }
  draftKindLabel(kind: CatalogDraft['kind']): string {
    return ({ redefine: '改定义', split: '拆分为多条', remove: '停用' })[kind]
  }

  updateClaimField(field: 'title' | 'text' | 'number' | 'independent', event: Event): void {
    const element = event.target as HTMLInputElement
    const value = field === 'number' ? Number(element.value) : field === 'independent' ? element.checked : element.value
    this.service.updateClaim({ [field]: value })
  }

  updateCaseField(field: 'name' | 'applicationNo', event: Event): void {
    this.service.updateActiveCase({ [field]: (event.target as HTMLInputElement).value })
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

  restoreVersion(id: string): void {
    this.service.restoreVersion(id)
  }

  getVersion(id: string) { return this.activeCase.versions.find(item => item.id === id) }
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
    anchor.download = `${this.activeCase.applicationNo || 'case'}-${new Date().toISOString().slice(0, 10)}.${type}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  locateIssue(issue: ValidationIssue): void {
    this.activeIssue = issue
    if (issue.featureId) {
      const feature = this.activeCase.features.find(item => item.id === issue.featureId)
      if (feature) {
        this.service.selectClaim(feature.claimId)
        this.service.selectFeature(feature.id)
      }
    }
    this.service.setTab('mapping')
  }

  closeIssue(): void { this.activeIssue = null }

  // ── 特征表暂存 / 发布 ──

  addDraft(kind: CatalogDraft['kind'], featureId: string): void { this.service.addDraft(kind, featureId) }
  updateDraftNote(draft: CatalogDraft, field: 'newLabel' | 'newDefinition' | 'newCategory', event: Event): void {
    this.service.updateDraft(draft.id, { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
  }
  updateDraftPart(draft: CatalogDraft, index: number, field: 'label' | 'definition' | 'category', event: Event): void {
    this.service.updateDraftPart(draft.id, index, { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
  }
  removeDraft(id: string): void { this.service.removeDraft(id) }
  openPublish(): void {
    if (!this.drafts.length) return
    this.publishNote = ''
    this.publishDialog = true
  }
  publishCatalog(): void {
    this.service.publishCatalog(this.publishNote)
    this.publishDialog = false
    this.service.setTab('catalog')
  }

  armFaultForCase(caseId: string | null): void { this.service.armFaultForCase(caseId) }

  retryCase(caseId: string): void { this.service.retryCase(caseId) }

  // ── 挂起确认 ──

  openPending(feature: Feature): void {
    this.pendingResolveTarget = feature
    const candidates = this.pendingCandidates(feature)
    this.pendingChoice = candidates.length === 1 ? candidates[0].id : candidates[0]?.id || ''
    this.pendingCustom = false
  }
  closePending(): void { this.pendingResolveTarget = null }
  confirmPending(): void {
    if (!this.pendingResolveTarget) return
    this.service.resolvePending(this.pendingResolveTarget.id, this.pendingCustom ? null : this.pendingChoice)
    this.pendingResolveTarget = null
  }

  private syncVersions(): void {
    if (!this.activeCase.versions.some(item => item.id === this.compareA)) this.compareA = this.activeCase.versions[1]?.id || this.activeCase.versions[0]?.id || ''
    if (!this.activeCase.versions.some(item => item.id === this.compareB)) this.compareB = this.activeCase.versions[0]?.id || ''
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
