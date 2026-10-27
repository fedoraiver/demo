// 页面只消费结果；排版失败、取消或超时均不改变上一次已展示的图。
import { filterScheduleGraph, scheduleFilterTerms, scheduleFilterNames, scheduleGraphInput, scheduleSystemCount } from './schedule-graph.mjs';
import { SCHEDULE_THEME } from './schedule-theme.mjs';
import { normalizeScheduleSvg } from './schedule-svg.mjs';

function aborted() {
  const error = new Error('Schedule rendering cancelled');
  error.name = 'AbortError';
  return error;
}

export function createScheduleRenderer({ workerSource, timeoutMs = 15000, WorkerClass = globalThis.Worker,
  urls = globalThis.URL, BlobClass = globalThis.Blob, dom = globalThis } = {}) {
  let worker = null, workerUrl = null, pending = null, sequence = 0, disposed = false;
  const stop = () => {
    worker?.terminate(); worker = null;
    if (workerUrl) urls.revokeObjectURL(workerUrl);
    workerUrl = null;
  };
  const fail = error => {
    const task = pending; pending = null;
    if (task) { clearTimeout(task.timer); task.reject(error); }
    stop();
  };
  const cancel = () => { sequence++; if (pending) fail(aborted()); };
  const ensureWorker = () => {
    if (worker) return;
    if (typeof WorkerClass !== 'function' || typeof workerSource !== 'string') throw new Error('Schedule filtering requires WebAssembly and Web Workers');
    workerUrl = urls.createObjectURL(new BlobClass([workerSource], { type: 'text/javascript' }));
    try { worker = new WorkerClass(workerUrl); } catch (error) { stop(); throw error; }
    const currentWorker = worker;
    worker.onmessage = event => {
      if (worker !== currentWorker) return;
      const task = pending, message = event.data;
      if (!task || message?.id !== task.id) return;
      if (typeof message.error === 'string') { fail(new Error(message.error)); return; }
      try {
        const geometry = normalizeScheduleSvg(message.svg, task.viewId, dom);
        clearTimeout(task.timer); pending = null;
        task.resolve({ ...geometry, ...task.counts, filtered: true });
      } catch (error) { fail(error); }
    };
    worker.onerror = event => { if (worker === currentWorker) fail(new Error(event.message || 'Schedule worker failed')); };
    worker.onmessageerror = () => { if (worker === currentWorker) fail(new Error('Invalid Schedule worker response')); };
  };
  return {
    async render(view, { includePlugins = [], excludePlugins = [], includeNames = [], excludeNames = [], include = '', exclude = '' } = {}) {
      if (disposed) throw new Error('Schedule renderer has been disposed');
      cancel();
      const includes = scheduleFilterTerms(include), excludes = scheduleFilterTerms(exclude);
      const pluginIncludes = new Set(scheduleFilterNames(includePlugins)), pluginExcludes = new Set(scheduleFilterNames(excludePlugins));
      const groupNames = ids => (view.schedulePluginGroups || []).filter(group => ids.has(group.id)).flatMap(group => group.systemNames);
      const exactIncludes = scheduleFilterNames([...scheduleFilterNames(includeNames), ...groupNames(pluginIncludes)]);
      const exactExcludes = scheduleFilterNames([...scheduleFilterNames(excludeNames), ...groupNames(pluginExcludes)]);
      if (!includes.length && !excludes.length && !exactIncludes.length && !exactExcludes.length && !pluginIncludes.size && !pluginExcludes.size) return { svg: view.svg, width: view.width, height: view.height,
        systemCount: view.systemCount, totalSystemCount: view.systemCount, filtered: false };
      // 已选来源在当前 Schedule 没有成员时，包含应为空结果，不能退化成未筛选。
      const filtered = filterScheduleGraph(view.scheduleGraph, { includeNames: exactIncludes, excludeNames: exactExcludes, include, exclude, includeRestricted: pluginIncludes.size > 0 });
      const counts = { systemCount: scheduleSystemCount(filtered), totalSystemCount: scheduleSystemCount(view.scheduleGraph) };
      if (!counts.systemCount) return { svg: null, width: 0, height: 0, ...counts, filtered: true };
      ensureWorker();
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (pending?.id === id) fail(new Error('Schedule rendering timed out')); }, timeoutMs);
        pending = { id, viewId: view.id, resolve, reject, timer, counts };
        try { worker.postMessage({ id, graph: scheduleGraphInput(filtered, SCHEDULE_THEME) }); }
        catch (error) { fail(error); }
      });
    },
    cancel,
    dispose() { disposed = true; cancel(); stop(); },
  };
}
