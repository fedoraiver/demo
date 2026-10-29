// 为 Issue #11 的顶层任务维护可见序号，不重新序列化 Markdown 正文。
const ISSUE_NUMBER = 11;
const MAX_ATTEMPTS = 3;

function renumberTasks(body) {
  let number = 0;
  let fence = null;

  return body.split(/(\r\n|\n|\r)/).map((line, index) => {
    if (index % 2 === 1) return line;

    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (boundary && boundary[1][0] === fence.character
        && boundary[1].length >= fence.length && /^[ \t]*$/.test(boundary[2])) {
        fence = null;
      }
      return line;
    }
    if (boundary && !(boundary[1][0] === '`' && boundary[2].includes('`'))) {
      fence = { character: boundary[1][0], length: boundary[1].length };
      return line;
    }

    // #11 的顶层任务从列首开始；保留缩进内容，避免给子任务或代码编号。
    const task = /^((?:\d{1,9}[.)]|[-+*])[ \t]+\[[ xX]\])([ \t]+|$)(.*)$/.exec(line);
    if (!task) return line;

    number += 1;
    const prefix = `**${number}.**`;
    const content = /^\*\*\d+\.\*\*(?=[ \t]|$)/.test(task[3])
      ? task[3].replace(/^\*\*\d+\.\*\*/, prefix)
      : `${prefix}${task[3] ? ` ${task[3]}` : ''}`;
    return `${task[1]}${task[2] || ' '}${content}`;
  }).join('');
}

async function synchronizeIssue({ github, context, core }) {
  const { owner, repo } = context.repo;
  const isBodyEdit = context.eventName === 'issues'
    && context.payload.action === 'edited'
    && context.payload.issue?.number === ISSUE_NUMBER
    && context.payload.changes?.body !== undefined;
  if (owner !== 'fedoraiver' || repo !== 'demo'
    || !(isBodyEdit || context.eventName === 'workflow_dispatch')) {
    core.info('Skipped: event does not target issue #11 body.');
    return { changed: false, skipped: true };
  }

  const target = { owner, repo, issue_number: ISSUE_NUMBER };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // 排队事件的正文可能已过期，始终重新读取 Issue。
    const { data: issue } = await github.rest.issues.get(target);
    const body = issue.body ?? '';
    const numbered = renumberTasks(body);
    if (numbered === body) {
      core.info('Issue #11 task numbers are already current.');
      return { changed: false };
    }

    const { data: latest } = await github.rest.issues.get(target);
    if ((latest.body ?? '') !== body) {
      core.info(`Issue #11 changed before update; recomputing (attempt ${attempt}).`);
      continue;
    }

    // REST 不提供正文版本锁；复查只能缩小人工编辑与写回之间的竞态窗口。
    await github.rest.issues.update({ ...target, body: numbered });
    core.info('Updated issue #11 task numbers.');
    return { changed: true };
  }
  throw new Error(`Issue #11 kept changing during all ${MAX_ATTEMPTS} attempts; no update was written.`);
}

module.exports = { renumberTasks, synchronizeIssue };
