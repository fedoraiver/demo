import { identity, status } from './workspace.mjs';
import { currentEvent, sessionDocuments, comparisonBase } from './session.mjs';
import { currentMechanical } from './check.mjs';
import { effectiveReviews } from './records.mjs';

export function report(root, session) {
  const allDocuments = sessionDocuments(root, session.baseline);
  const current = allDocuments.filter(d => d.inScope), reviews = effectiveReviews(root, session);
  const mechanicalEvent = session.events.findLast(e => e.type === 'mechanical');
  const mechanical = !mechanicalEvent ? { status: 'not_run' } : { status: currentMechanical(root, session.baseline, mechanicalEvent) ? mechanicalEvent.result.status : 'stale', eventId: mechanicalEvent.id, result: mechanicalEvent.result };
  const findings = [], coverage = current.map(doc => {
    const relevant = reviews.filter(e => e.scope.includes(doc.path));
    const latest = new Map();
    for (const event of relevant) {
      const kind = event.type === 'return' ? ({ reviewer: 'content_review', independent_reviewer: 'independent_review' }[event.role] || 'return') : event.type;
      latest.set(`${kind}:${event.actor}`, event);
    }
    const content = [...latest.values()].filter(e => e.type === 'content_review' || (e.type === 'return' && e.role === 'reviewer'));
    const independent = [...latest.values()].filter(e => e.type === 'independent_review' || (e.type === 'return' && e.role === 'independent_reviewer'));
    for (const event of latest.values()) for (const finding of event.findings) findings.push({ path: doc.path, actor: event.actor, eventId: event.id, ...finding });
    const exclusion = session.events.findLast(e => e.type === 'exclusion' && e.scope.includes(doc.path) && currentEvent(root, session, e));
    const delegations = session.events.filter(e => e.type === 'delegation' && e.scope.includes(doc.path));
    const pending = delegations.some(d => !reviews.some(e => e.type === 'return' && e.actor === d.actor && e.seq > d.seq && e.scope.includes(doc.path)) && !session.events.some(e => e.type === 'exclusion' && e.seq > d.seq && e.scope.includes(doc.path) && currentEvent(root, session, e)));
    let coverageStatus = 'pending';
    if (exclusion) coverageStatus = 'excluded';
    else if (pending) coverageStatus = 'delegated_pending';
    else if (content.some(e => e.result !== 'unverified')) coverageStatus = 'content_reviewed';
    else if (mechanical.status === 'pass') coverageStatus = 'links_only';
    const independentForDecision = independent.filter(e => !exclusion || (e.seq > exclusion.seq && e.actor !== exclusion.actor));
    return { path: doc.path, classification: doc.kind, status: coverageStatus, independentReview: independentForDecision.some(e => e.result !== 'unverified'),
      reviewEvents: content.map(e => e.id), independentEvents: independent.map(e => e.id), exclusion: exclusion ? { actor: exclusion.actor, reason: exclusion.reason, eventId: exclusion.id } : undefined,
      unverified: (exclusion ? independentForDecision : [...latest.values()]).some(e => e.result === 'unverified') };
  });
  const incomplete = coverage.filter(d => !['content_reviewed', 'excluded'].includes(d.status));
  const independentMissing = coverage.filter(d => !d.independentReview);
  const constraints = findings.filter(f => f.severity === 'constraint' && !f.resolved);
  const unresolvedUnverified = findings.filter(f => f.severity === 'unverified' && !f.resolved);
  const unverified = coverage.filter(d => d.unverified || ['pending', 'links_only', 'delegated_pending'].includes(d.status));
  const contentStatus = findings.some(f => !f.resolved && f.severity !== 'unverified') ? 'findings' : (unverified.length || findings.some(f => f.severity === 'unverified' && !f.resolved) ? 'unverified' : 'no_findings');
  const baselineDocs = new Map(session.baseline.documents.map(d => [d.path, d.hash]));
  const changesSinceInit = allDocuments.filter(d => d.hash !== baselineDocs.get(d.path)).map(d => ({ path: d.path, before: baselineDocs.get(d.path) ?? null, after: d.hash }));
  return { mechanical, coverage, content: { status: contentStatus, findings },
    exclusions: allDocuments.filter(d => d.selected && d.requiredReview === false).map(d => ({ path: d.path, classification: d.kind, rule: d.rule, reason: d.exclusionReason, owner: d.owner, evidence: d.evidence })),
    complete: current.length > 0 && mechanical.status === 'pass' && incomplete.length === 0 && independentMissing.length === 0 && constraints.length === 0 && unresolvedUnverified.length === 0 && unverified.length === 0,
    incomplete: incomplete.map(d => d.path), independentMissing: independentMissing.map(d => d.path), unresolvedConstraints: constraints, unresolvedUnverified,
    baseline: { head: session.baseline.head, branch: session.baseline.branch, base: session.baseline.base, initialStatus: session.baseline.initialStatus }, comparisonBase: comparisonBase(root, session.baseline),
    current: { head: identity(root).head, status: status(root) }, changesSinceInit,
    interpretation: '机械检查只验证可解析性；内容、身份、模型调用、阅读完成情况由具名记录申报，工具不提供执行证明。未声明的隐含依据影响无法自动判定，依据变化后须具名重新确认。',
    historyEvents: session.events.length };
}
