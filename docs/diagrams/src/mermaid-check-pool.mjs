// Node 构建共用有界检查线程；基础设施故障必须拒绝全部请求，不能伪装成布局候选失败。
import { Worker } from 'node:worker_threads';

/** 标记线程、通信或生命周期故障，禁止将它们当成可重试的 SVG 布局错误。 */
export class MermaidCheckWorkerError extends Error {
  constructor(cause) {
    super('Mermaid check worker failed: ' + cause.message, { cause });
    this.name = 'MermaidCheckWorkerError';
  }
}

/** 按编译任务预算复用工作线程；close 拒绝未完成请求并等待全部线程退出。 */
export function createMermaidCheckPool({ jobs, createWorker = () => new Worker(new URL('./mermaid-check-worker.mjs', import.meta.url)) } = {}) {
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 32) throw new Error('Mermaid check worker count must be an integer from 1 to 32');
  const workers = [], queue = [];
  let nextId = 0, state = 'open', failure, closing;
  function rejectPending(error) {
    for (const task of queue.splice(0)) task.reject(error);
    for (const slot of workers) if (slot.task) { slot.task.reject(error); slot.task = null; }
  }
  function stop() {
    return closing ??= Promise.allSettled(workers.map(slot => Promise.resolve().then(() => slot.worker.terminate()))).then(results => {
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw new MermaidCheckWorkerError(rejected.reason);
    });
  }
  function fail(cause) {
    if (state !== 'open') return;
    failure = cause instanceof MermaidCheckWorkerError ? cause : new MermaidCheckWorkerError(cause);
    state = 'failed'; rejectPending(failure);
    // 故障时立即收尾；close 仍等待同一个结束 Promise，并负责报告清理错误。
    void stop().catch(() => {});
  }
  function spawn() {
    const slot = { worker: createWorker(), task: null };
    workers.push(slot);
    slot.worker.on('message', message => {
      if (state !== 'open') return;
      const task = slot.task;
      if (!task || message?.id !== task.id || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) {
        fail(new Error('Unexpected Mermaid check worker response')); return;
      }
      if (Object.hasOwn(message, 'error') && !(message.error instanceof Error)) {
        fail(new Error('Invalid Mermaid check error')); return;
      }
      slot.task = null;
      if (Object.hasOwn(message, 'error')) task.reject(message.error);
      else task.resolve(message.result);
      dispatch();
    });
    slot.worker.on('error', fail);
    slot.worker.on('messageerror', fail);
    slot.worker.on('exit', code => { if (state === 'open') fail(new Error('Mermaid check worker exited unexpectedly: ' + code)); });
    return slot;
  }
  function dispatch() {
    while (state === 'open' && queue.length) {
      let slot = workers.find(candidate => !candidate.task);
      if (!slot && workers.length >= jobs) return;
      try {
        slot ??= spawn();
        const task = queue.shift(); slot.task = task;
        slot.worker.postMessage({ id: task.id, operation: task.operation, view: task.view });
      } catch (error) { fail(error); }
    }
  }
  function submit(operation, view) {
    if (state !== 'open') return Promise.reject(failure || new MermaidCheckWorkerError(new Error('Mermaid check pool is closed')));
    return new Promise((resolve, reject) => {
      queue.push({ id: ++nextId, operation, view, resolve, reject }); dispatch();
    });
  }
  return {
    labels: view => submit('labels', view),
    routes: view => submit('routes', view),
    geometry: view => submit('geometry', view),
    isFatalError: error => error instanceof MermaidCheckWorkerError,
    close() {
      if (state === 'open') { state = 'closed'; rejectPending(new MermaidCheckWorkerError(new Error('Mermaid check pool is closed'))); }
      return stop();
    },
  };
}
