import path from 'node:path';
import { readHash, safePath, fail, inScope, unix, stable } from './workspace.mjs';
import { append, dependenciesFor, currentEvent, sessionDocuments, comparisonBase } from './session.mjs';

const types = ['assignment', 'content_review', 'independent_review', 'exclusion', 'delegation', 'return', 'reconfirmation'];
const roles = ['editor', 'reviewer', 'independent_reviewer', 'links'];
const models = ['gpt-6.1-sol', 'gpt-6.1-terra'];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const reviewTypes = ['content_review', 'independent_review', 'return'];
function nonempty(value, field) { if (typeof value !== 'string' || !value.trim()) fail(`${field} 必须为非空字符串`); }
function overlap(a, b) { return a.some(x => b.some(y => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`))); }
export function record(root, session, input) {
  if (comparisonBase(root, session.baseline).status !== 'current') fail('显式比较基点已迁移；必须创建新会话，不得沿用旧审查记录');
  if (input.schemaVersion !== 1 || !types.includes(input.type)) fail('record schemaVersion/type 无效');
  nonempty(input.actor, 'actor');
  if (!Array.isArray(input.scope) || !input.scope.length) fail('scope 必须为非空文件数组');
  input.scope = [...new Set(input.scope)];
  const documents = sessionDocuments(root, session.baseline).filter(d => d.inScope);
  for (const p of input.scope) {
    safePath(root, p);
    if (!documents.some(d => d.path === p) || !inScope(p, session.baseline.scope)) fail(`scope 必须为会话范围中的具体文档: ${p}`);
  }
  if (!Array.isArray(input.evidence) || !input.evidence.length) fail('evidence 必须包含依据文件与引用');
  const evidence = input.evidence.map(item => {
    nonempty(item.path, 'evidence.path'); nonempty(item.reference, 'evidence.reference');
    const relative = unix(path.relative(root, safePath(root, item.path)));
    if (/^(tmp|target|node_modules)\//.test(relative)) fail('临时会话或缓存不能充当内容依据');
    const digest = readHash(root, relative);
    if (digest === null) fail(`依据文件不存在: ${item.path}`);
    if (item.hash !== undefined && item.hash !== digest) fail(`依据哈希已变动: ${item.path}`);
    return { path: relative, hash: digest, reference: item.reference };
  });
  if (['assignment', 'delegation'].includes(input.type)) {
    if (!roles.includes(input.role)) fail('assignment/delegation role 无效');
    const execution = input.execution;
    if (!execution || execution.forkTurns !== 'none') fail('execution 必须申报 actual model/effort/forkTurns:none');
    const availableModels = execution.availableModels || models, availableEfforts = execution.availableEfforts || efforts;
    if (!Array.isArray(availableModels) || !availableModels.includes(execution.model) || !Array.isArray(availableEfforts) || !availableEfforts.includes(execution.effort)) fail('actual model/effort 不在申报能力范围');
    for (const [requested, actual] of [['requestedModel', 'model'], ['requestedEffort', 'effort']]) if (execution[requested] && execution[requested] !== execution[actual]) fail(`${requested} 与实际调用参数不一致`);
    if (input.role === 'editor') {
      const conflict = session.events.find(e => ['assignment', 'delegation'].includes(e.type) && e.role === 'editor' && e.actor !== input.actor && overlap(e.scope, input.scope));
      if (conflict) fail(`同一文件只能有一个编辑者: ${conflict.actor}`);
    }
    if (input.role === 'independent_reviewer' && session.events.some(e => ['assignment', 'delegation'].includes(e.type) && e.role === 'editor' && e.actor === input.actor)) fail('独立终审者不能为历史编辑者');
    if (input.role === 'editor' && session.events.some(e => (e.type === 'independent_review' || (e.type === 'return' && e.role === 'independent_reviewer')) && e.actor === input.actor)) fail('历史独立终审者不能再登记为编辑者');
  }
  if (reviewTypes.includes(input.type)) {
    if (!['no_findings', 'findings', 'unverified'].includes(input.result)) fail('内容审查 result 无效');
    if (!Array.isArray(input.findings)) fail('内容审查必须提供 findings 数组');
    if (input.result === 'findings' && !input.findings.length) fail('findings 结果需要具体发现');
    if (input.result === 'no_findings' && input.findings.length) fail('no_findings 与非空发现冲突');
    for (const finding of input.findings) {
      if (!['constraint', 'suggestion', 'unverified'].includes(finding.severity)) fail('finding severity 无效');
      nonempty(finding.message, 'finding.message');
      if (finding.resolved !== undefined && typeof finding.resolved !== 'boolean') fail('finding.resolved 必须为布尔值');
    }
    const returnedDelegation = input.type === 'return' ? session.events.findLast(e => e.type === 'delegation' && e.actor === input.actor && input.scope.every(p => e.scope.includes(p))) : null;
    if (input.type === 'return' && !returnedDelegation) fail('return 缺少对应委派');
    const role = input.type === 'return' ? returnedDelegation.role : input.type === 'independent_review' ? 'independent_reviewer' : 'reviewer';
    const assignment = session.events.find(e => ['assignment', 'delegation'].includes(e.type) && e.actor === input.actor && e.role === role && input.scope.every(p => e.scope.includes(p)));
    if (!assignment) fail(`审查缺少 ${role} assignment/delegation`);
    if ((input.type === 'independent_review' || (input.type === 'return' && role === 'independent_reviewer')) && session.events.some(e => ['assignment', 'delegation'].includes(e.type) && e.role === 'editor' && e.actor === input.actor)) fail('独立终审者参与过编辑');
    if (input.type === 'return') input.role = role;
  }
  if (input.type === 'exclusion') nonempty(input.reason, 'reason');
  if (input.type === 'reconfirmation') {
    nonempty(input.reason, 'reason'); nonempty(input.eventId, 'eventId');
    const target = session.events.find(e => e.id === input.eventId);
    if (!target || !reviewTypes.includes(target.type) || target.actor !== input.actor || !target.scope.every(p => input.scope.includes(p))) fail('reconfirmation 必须由原审查者具名确认原事件完整范围');
  }
  const payload = { schemaVersion: 1, type: input.type, actor: input.actor, scope: input.scope, evidence };
  for (const field of ['role', 'execution', 'result', 'findings', 'reason', 'eventId']) if (input[field] !== undefined) payload[field] = input[field];
  // 职责声明不随内容字节变动消失；审查证明单独绑定实际依据。
  if (!['assignment', 'delegation'].includes(input.type)) {
    payload.dependencies = dependenciesFor(root, session.baseline, input.scope, evidence);
    if (evidence.some(item => payload.dependencies.files[item.path] !== item.hash) || stable(payload.dependencies) !== stable(dependenciesFor(root, session.baseline, input.scope, evidence))) fail('record 期间依据输入变动；不能绑定混合版本');
  }
  return append(session, payload);
}
export function effectiveReviews(root, session) {
  const reconfirmations = session.events.filter(e => e.type === 'reconfirmation' && currentEvent(root, session, e));
  return session.events.filter(e => reviewTypes.includes(e.type) && (currentEvent(root, session, e) || reconfirmations.some(r => r.eventId === e.id)));
}
