// 在实际页面存活时采样 CDP，区分页面数量与真正使用 CPU 的 renderer 进程。
export async function browserRendererProof(browser, pages) {
  const session = await browser.target().createCDPSession();
  try {
    const targets = await Promise.all(pages.map(async page => {
      const targetSession = await page.target().createCDPSession();
      try { return (await targetSession.send('Target.getTargetInfo')).targetInfo; }
      finally { await targetSession.detach(); }
    }));
    const before = await session.send('SystemInfo.getProcessInfo'), start = Date.now();
    await Promise.all(pages.map(page => page.evaluate(() => {
      const until = performance.now() + 600;
      let value = 0;
      while (performance.now() < until) value += Math.sqrt(value + 1);
      return value;
    })));
    const after = await session.send('SystemInfo.getProcessInfo'), previous = new Map(before.processInfo.map(process => [process.id, process.cpuTime]));
    return { contexts: targets.map(target => target.browserContextId), elapsedMs: Date.now() - start,
      activeRenderers: after.processInfo.filter(process => process.type === 'renderer')
        .map(process => ({ pid: process.id, cpuSeconds: process.cpuTime - (previous.get(process.id) || 0) }))
        .filter(process => process.cpuSeconds > .1) };
  } finally { await session.detach(); }
}
