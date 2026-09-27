(function mountWorkbenchPanel() {
  const contentScriptVersion = "0.9.7";
  if (document.getElementById("xhs-intelligence-panel")) return;
  const panel = document.createElement("aside");
  panel.id = "xhs-intelligence-panel";
  panel.innerHTML = `
    <div class="xiw-head"><strong>小红书采集工作台</strong><button data-action="collapse" title="收起">－</button></div>
    <div class="xiw-body">
      <div class="xiw-status"><span class="xiw-dot"></span><span data-role="status">检查本地服务…</span></div>
      <div class="xiw-page-line"><span>当前页面</span><strong data-role="page">正在识别</strong></div>
      <section class="xiw-unified-card" aria-label="实时采集工作台">
        <div class="xiw-card-title">实时控制卡 <small>v${contentScriptVersion}</small></div>
        <div class="xiw-run" data-role="run" hidden>本轮采集：等待开始</div>
        <dl class="xiw-facts">
          <div><dt>阶段</dt><dd data-role="collection-stage">等待开始</dd></div>
          <div><dt>当前词</dt><dd data-role="collection-current-keyword">尚未开始</dd></div>
          <div><dt>种子</dt><dd data-role="collection-seed-progress">0/0</dd></div>
          <div><dt>本词联想</dt><dd data-role="collection-related-count">0</dd></div>
          <div><dt>入台目标</dt><dd><span data-role="collection-keyword-count">0/0</span> · 已收录 <span data-role="collection-total-note-count">0</span></dd></div>
          <div><dt>层数</dt><dd data-role="collection-depth">0</dd></div>
          <div><dt>状态</dt><dd><span class="xiw-badge" data-role="collection-status">待开始</span></dd></div>
        </dl>
        <div class="xiw-progress-track" data-role="progress-track" role="progressbar" aria-label="采集任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-role="progress-fill"></i></div>
        <div class="xiw-progress-copy" data-role="progress-copy">输入目标并开始采集</div>
        <div class="xiw-run-actions"><button data-action="pause" data-role="pause" type="button">暂停</button><button data-action="resume" data-role="resume" type="button">继续</button><details class="xiw-export"><summary>导出</summary><div><a data-role="export-json" target="_blank" rel="noopener">JSON</a><a data-role="export-csv" target="_blank" rel="noopener">表格</a><a data-role="export-md" target="_blank" rel="noopener">摘要</a></div></details></div>
        <details class="xiw-more"><summary>任务明细</summary><div class="xiw-mini-stats"><span>有效入台 <b data-role="collection-saved-count">0</b></span><span>缺口 <b data-role="collection-gap-count">0</b></span></div><div data-role="collection-keyword-list">尚无关键词进度</div><button data-action="cancel" data-role="cancel" type="button">结束任务</button></details>
        <details class="xiw-more"><summary>自动采集设置</summary><div class="xiw-limit">
          <label for="xiw-search-limit"><small>有效入台目标</small><span>由你决定，1–10000 条</span></label>
          <div class="xiw-limit-row"><input id="xiw-search-limit" data-role="search-limit" type="number" min="1" max="10000" step="1" value="1500" inputmode="numeric"><button data-action="save-limit" type="button">保存并应用</button></div>
          <div class="xiw-presets" aria-label="常用采集目标"><button data-limit="200" type="button">200</button><button data-limit="500" type="button">500</button><button data-limit="1000" type="button">1000</button><button data-limit="1500" type="button">1500</button><button data-limit="3000" type="button">3000</button></div>
        </div><div class="xiw-counts" data-role="counts">候选 0 · 有效入台 0</div><div class="xiw-task" data-role="task" hidden>任务：尚未领取</div><div class="xiw-auto" data-role="auto">自动更新：已停止</div><div class="xiw-actions"><button data-action="auto-start">开始自动更新</button><button data-action="auto-stop">暂停更新</button></div></details>
      </section>
      <div class="xiw-message" data-role="message">切换应用或截图后会尝试继续；若浏览器关闭、登录失效或出现验证，请按提示处理。</div>
    </div>`;
  document.documentElement.appendChild(panel);

  const role = (name) => panel.querySelector(`[data-role='${name}']`);
  const setStatus = (message, ok = false) => {
    role("status").textContent = message;
    panel.classList.toggle("xiw-online", ok);
  };
  let activeTask = null;
  let runSyncSucceeded = false;
  let latestCollectionProgress = null;
  let cachedAutoState = null;
  let collectionSettings = { searchLimit: 1500 };
  let sessionSearchLimitOverride = null;
  let searchAccumulator = { taskId: null, cards: [], suggestions: [] };
  let detailAccumulator = { taskId: null, comments: [] };
  const boundedSearchLimit = (value, fallback = 1500) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10000 ? parsed : fallback;
  };
  const effectiveSearchLimit = (task = activeTask) => boundedSearchLimit(sessionSearchLimitOverride, boundedSearchLimit(task?.context?.searchLimit, boundedSearchLimit(collectionSettings.searchLimit)));
  const qualifiedSearchCard = (card) => Boolean(card?.noteId && card?.sourceUrl && String(card.title || "").trim())
    && !/(?:抽奖|送礼|福利赠送|免费领取|评论区抽|转发抽)/u.test(String(card.title));
  const admittedSearchCards = (target = effectiveSearchLimit()) => searchAccumulator.cards.filter(qualifiedSearchCard).slice(0, target)
    .map((card, index) => ({ ...card, ordinal: index + 1 }));
  const renderCollectionSettings = () => {
    role("search-limit").value = String(effectiveSearchLimit());
  };
  const resetSearchAccumulator = (task = activeTask) => {
    searchAccumulator = { taskId: task?.taskId || null, cards: [], suggestions: [] };
  };
  const resetDetailAccumulator = (task = activeTask) => {
    detailAccumulator = { taskId: task?.taskId || null, comments: [] };
  };
  const pageLabels = { SEARCH: "搜索结果页", NOTE_DETAIL: "笔记详情页", UNKNOWN: "当前页不支持" };
  const statusLabels = { VISIBLE: "可采集", HUMAN_REQUIRED: "需要人工处理", UNKNOWN_STRUCTURE: "结构未识别" };
  const runStatusLabels = { QUEUED: "排队中", RUNNING: "采集中", PAUSED: "已暂停", SUCCEEDED: "已完成", PARTIAL: "部分完成", FAILED: "失败", CANCELLED: "已停止" };
  const inspect = () => {
    let snapshot = globalThis.XhsVisibleExtractor.capture({ expectedNoteId: activeTask?.context?.noteId });
    if (activeTask?.expectedPageType === "SEARCH" && snapshot.pageType === "SEARCH") {
      if (searchAccumulator.taskId !== activeTask.taskId) resetSearchAccumulator(activeTask);
      const searchLimit = effectiveSearchLimit(activeTask);
      searchAccumulator.cards = globalThis.XhsVisibleExtractor.mergeSearchCards(searchAccumulator.cards, snapshot.cards, 10000);
      searchAccumulator.suggestions = [...new Set([...(searchAccumulator.suggestions || []), ...(snapshot.suggestions || [])])].slice(0, 300);
      snapshot = { ...snapshot, cards: admittedSearchCards(searchLimit), candidateCount: searchAccumulator.cards.length, suggestions: searchAccumulator.suggestions };
    }
    if (activeTask?.expectedPageType === "NOTE_DETAIL" && snapshot.pageType === "NOTE_DETAIL") {
      if (detailAccumulator.taskId !== activeTask.taskId) resetDetailAccumulator(activeTask);
      const detailScope = globalThis.XhsVisibleExtractor.detailScopeForCapture(location.href, document);
      const currentComments = globalThis.XhsVisibleExtractor.observedComments(detailScope);
      detailAccumulator.comments = globalThis.XhsVisibleExtractor.mergeObservedComments(detailAccumulator.comments, currentComments, 500);
      const retained = globalThis.XhsVisibleExtractor.selectUsefulComments(detailAccumulator.comments);
      snapshot = {
        ...snapshot,
        visibleComments: retained,
        commentTraversal: {
          ...(snapshot.commentTraversal || {}),
          visibleCommentCount: detailAccumulator.comments.length,
          fetchedTotal: detailAccumulator.comments.length,
          retainedTotal: retained.length,
          filteredOutTotal: detailAccumulator.comments.length - retained.length
        }
      };
    }
    role("page").textContent = `${pageLabels[snapshot.pageType] || snapshot.pageType} · ${statusLabels[snapshot.status] || snapshot.status}`;
    role("counts").textContent = snapshot.pageType === "SEARCH"
      ? `累计候选 ${snapshot.candidateCount || 0} · 有效入台 ${snapshot.cards?.length || 0}/${effectiveSearchLimit()}`
      : "详情可见指标已识别 · 不读取视频或评论";
    return snapshot;
  };
  const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage({ ...message, contentScriptVersion }, resolve));
  let driveRunning = false;
  let driveTimer = null;
  const driveWaiters = new Set();
  const waitForDriveStep = (delayMs) => new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      driveWaiters.delete(done);
      resolve();
    };
    driveWaiters.add(done);
    timer = setTimeout(done, delayMs);
  });
  const wakeDrive = () => {
    for (const wake of [...driveWaiters]) wake();
    if (!driveRunning) driveAutoRun();
  };
  const showTask = (task) => {
    if (task?.taskId !== activeTask?.taskId) {
      sessionSearchLimitOverride = null;
      resetSearchAccumulator(task);
      resetDetailAccumulator(task);
    }
    activeTask = task;
    const context = task?.context;
    role("task").textContent = task ? `任务：${task.expectedPageType} · ${context?.keyword || task.taskId}${context?.keywordOrdinal ? ` · ${context.keywordOrdinal}/${context.keywordTotal} · 深度${context.depth}` : ""}` : "任务：队列为空或尚未领取";
    role("task").title = task?.targetUrl || "";
  };
  const refreshRun = async () => {
    const result = await send({ kind: "GET_COLLECTION_PROGRESS" });
    if (!result?.ok) {
      runSyncSucceeded = false;
      latestCollectionProgress = null;
      role("progress-copy").textContent = `状态暂未同步：${result?.error || "本地服务无响应"}`;
      return null;
    }
    runSyncSucceeded = true;
    latestCollectionProgress = result.value;
    const run = result.value?.run;
    const target = Number(result.value?.target || 0);
    if (result.value?.active && document.activeElement !== role("search-limit")) role("search-limit").value = String(target);
    const discovered = Number(result.value?.discovered || 0);
    const ingested = Number(result.value?.admitted || 0);
    const percent = Number(result.value?.percent || 0);
    const completed = Number(result.value?.completed || 0);
    const total = Number(result.value?.total || 0);
    const kind = result.value?.runKind === "RANKING" ? "榜单更新" : "关键词采集";
    const shortfall = run?.status === "SUCCEEDED" && target > 0 && ingested < target;
    const stage = result.value?.runKind === "RANKING" ? "榜单更新" : run?.phase || kind;
    const currentWord = String(run?.currentKeyword || ({ SUCCEEDED: "全部完成", PARTIAL: "部分完成", FAILED: "本轮采集未完成", CANCELLED: "本轮已停止" }[run?.status] || "等待搜索"));
    const statusLabel = shortfall ? "已结束·未达目标" : runStatusLabels[run?.status] || run?.status || "待开始";
    const queue = run?.queue || run?.keywords || [];
    const current = queue.find((item) => item.keywordId === run?.currentKeywordId) || queue.find((item) => item.status === "RUNNING");
    const relatedCount = current ? queue.filter((item) => item.parentKeywordId === current.keywordId || item.parentId === current.keywordId).length : 0;
    const active = ["QUEUED", "RUNNING", "PAUSED"].includes(run?.status);
    role("run").innerHTML = run ? `<small>本轮采集 · ${runStatusLabels[run.status] || run.status}</small><strong>${stage}</strong><span>当前词 ${currentWord.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])} · 任务 ${completed}/${total}</span><span>候选 ${discovered} · 有效入台 ${ingested}/${target}</span>` : `<small>本轮采集</small><strong>等待开始</strong><span>尚无运行任务</span>`;
    role("collection-stage").textContent = run ? stage : "等待开始";
    role("collection-current-keyword").textContent = run ? currentWord : "尚未开始";
    role("collection-seed-progress").textContent = `${completed}/${total}`;
    role("collection-related-count").textContent = String(relatedCount);
    role("collection-keyword-count").textContent = `${ingested}/${target}`;
    role("collection-total-note-count").textContent = String(ingested);
    role("collection-depth").textContent = String(current?.depth ?? run?.settings?.maxDepth ?? 0);
    role("collection-status").textContent = statusLabel;
    role("collection-status").className = `xiw-badge ${run?.status === "SUCCEEDED" && !shortfall ? "good" : ["FAILED", "CANCELLED"].includes(run?.status) ? "block" : "warn"}`;
    role("progress-fill").style.width = `${percent}%`;
    role("progress-track").setAttribute("aria-valuenow", String(percent));
    role("progress-copy").textContent = run ? run.status === "SUCCEEDED" ? `搜索结束：候选 ${ingested}/${target} 条 · 完整资料 ${Number(run.counters?.savedNotes || 0)} 条${shortfall ? " · 未达目标" : ""}` : `${percent}% · 已入台 ${ingested}/${target} 条 · ${statusLabel}` : "输入目标并开始采集";
    role("collection-saved-count").textContent = String(ingested);
    role("collection-gap-count").textContent = String(Number(run?.counters?.rejectedNotes ?? run?.counters?.failed ?? run?.counters?.blocked ?? 0));
    role("collection-keyword-list").textContent = queue.length ? queue.slice(-8).map((item) => `${item.value || item.keyword || "关键词"} · ${runStatusLabels[item.status] || item.status || "待处理"}`).join("\n") : "尚无关键词进度";
    role("pause").disabled = !active || run?.status === "PAUSED";
    role("resume").disabled = run?.status !== "PAUSED";
    role("cancel").disabled = !active;
    for (const format of ["json", "csv", "md"]) role(`export-${format}`).href = `http://127.0.0.1:4173/api/research-export?format=${format}${run ? `&runId=${encodeURIComponent(run.runId)}` : ""}`;
    if (cachedAutoState) showAuto(cachedAutoState);
    return result.value?.active ? run : null;
  };
  const showAuto = (state) => {
    cachedAutoState = state;
    const awaitingRun = runSyncSucceeded && !latestCollectionProgress?.active;
    const label = state?.status === "RETRYING" ? "自动重试中" : state?.enabled && awaitingRun ? "已开启·待命" : state?.enabled && latestCollectionProgress?.run?.status === "PAUSED" ? "任务已暂停" : state?.enabled ? "运行中" : state?.status === "HALTED" ? "等待恢复" : "已暂停";
    const friendlyError = String(state?.lastError || "").replace(/COMMENT_TRAVERSAL_STALLED/g, "评论补证停滞（不影响候选）").replace(/UNKNOWN_STRUCTURE/g, "页面结构暂未识别");
    role("auto").innerHTML = `<small>自动更新</small><strong>${label}</strong>${friendlyError ? `<span>${friendlyError}</span>` : `<span>${awaitingRun ? "当前无进行中的采集任务" : "只采搜索候选，不逐条打开详情"}</span>`}`;
    panel.querySelector("[data-action='auto-start']").disabled = state?.enabled === true;
    panel.querySelector("[data-action='auto-stop']").disabled = state?.enabled !== true;
  };
  const scheduleDrive = (delayMs) => {
    clearTimeout(driveTimer);
    const deadline = Date.now() + delayMs;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining > 0) {
        role("message").textContent = runSyncSucceeded && !latestCollectionProgress?.active ? "当前没有进行中的采集任务；自动更新待命。" : `采集间隔：剩余 ${Math.ceil(remaining / 1000)} 秒`;
        driveTimer = setTimeout(tick, Math.min(1000, remaining));
      } else driveAutoRun();
    };
    tick();
  };
  const retryAutoRun = async (reason, delayMs = 3000) => {
    clearTimeout(driveTimer);
    const result = await send({ kind: "SET_BROWSER_AUTORUN", enabled: true, lastError: reason, userInitiated: false });
    showAuto(result?.value || { enabled: true, status: "RETRYING", lastError: reason });
    role("message").textContent = `遇到临时状态，${Math.ceil(delayMs / 1000)} 秒后自动重试：${reason}`;
    scheduleDrive(delayMs);
  };
  const submitDiagnosticSnapshot = async (snapshot) => {
    const result = await send({ kind: "SUBMIT_DIAGNOSTIC_SNAPSHOT", snapshot });
    if (!result?.ok) throw new Error(result?.error || "诊断快照提交失败");
    return result.value;
  };
  const failCurrentTask = async (snapshot, reason) => {
    await submitDiagnosticSnapshot(snapshot);
    // Diagnostics alone do not release the lease. Record a task-bound failure
    // and never silently repeat an external read after an unclassified failure.
    const result = await send({ kind: "FAIL_BROWSER_TASK", category: reason === "HUMAN_REQUIRED" ? "NEEDS_HUMAN" : "PERMANENT", code: reason, message: `Visible page collection failed: ${reason}` });
    if (!result?.ok) throw new Error(result?.error || "无法登记采集异常");
    showTask(null);
    await refreshRun();
    role("message").textContent = reason === "HUMAN_REQUIRED" ? "需要处理登录或验证；任务已等待人工处理。" : `当前条目采集失败，已记录原因：${reason}`;
    scheduleDrive(3000);
  };
  const submitSnapshot = async (snapshot) => {
    const result = await send({ kind: "SUBMIT_VISIBLE_SNAPSHOT", snapshot });
    if (!result?.ok) throw new Error(result?.error || "快照提交失败");
    if (result.value.task && ["SUCCEEDED", "BLOCKED", "FAILED"].includes(result.value.task.status)) showTask(null);
    return result.value;
  };
  const skipCurrentTask = async (reason, message) => {
    const requestIntervalMs = activeTask?.context?.requestIntervalMs ?? 500;
    const result = await send({ kind: "SKIP_BROWSER_TASK", code: reason, message });
    if (!result?.ok) throw new Error(result?.error || "无法登记跳过任务");
    showTask(null);
    role("message").textContent = `已跳过失效目标：${reason}`;
    await refreshRun();
    scheduleDrive(requestIntervalMs);
    return result.value;
  };
  const openTargetCard = async (decision, options = {}) => {
    const attempts = Math.max(1, Number(options.attempts) || 24);
    const skipIfMissing = options.skipIfMissing !== false;
    let opened = null;
    let rewound = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      opened = globalThis.XhsVisibleExtractor.openSearchCard(decision.noteId);
      if (opened?.opened) break;
      if (attempt < attempts) {
        const advanced = globalThis.XhsVisibleExtractor.advanceSearchResults();
        if (!advanced?.advanced && !rewound) {
          const scrollRoot = globalThis.XhsVisibleExtractor.searchScrollableRoot();
          if (scrollRoot) {
            if (typeof scrollRoot.scrollTo === "function") scrollRoot.scrollTo({ top: 0, behavior: "auto" });
            else scrollRoot.scrollTop = 0;
            rewound = true;
          }
        }
        role("message").textContent = `正在定位目标卡片：${attempt}/${attempts}`;
        await waitForDriveStep(450);
      }
    }
    if (!opened?.opened) {
      if (skipIfMissing) await skipCurrentTask("SEARCH_CARD_CLICK_TARGET_UNAVAILABLE", `The visible search card for ${decision.noteId} could not be opened after DOM settlement (${opened?.reason || "UNKNOWN"}).`);
      return false;
    }
    role("message").textContent = "正在从搜索结果打开真实笔记卡片…";
    scheduleDrive(1500);
    return true;
  };

  async function driveAutoRun() {
    if (driveRunning) return;
    driveRunning = true;
    try {
      const auto = await send({ kind: "GET_BROWSER_AUTORUN" });
      showAuto(auto?.value);
      if (!auto?.ok || !auto.value.enabled) return;
      const activeRun = await refreshRun();
      if (runSyncSucceeded && !activeRun) {
        role("message").textContent = "当前没有进行中的采集任务；自动更新待命。";
        scheduleDrive(5000);
        return;
      }
      if (runSyncSucceeded && auto.value.status === "RETRYING") {
        const recovered = await send({ kind: "SET_BROWSER_AUTORUN", enabled: true, userInitiated: false });
        if (recovered?.ok) showAuto(recovered.value);
      }
      if (activeRun?.status === "PAUSED") { role("message").textContent = "爆款采集已暂停；2 秒后检查。"; scheduleDrive(2000); return; }
      if (["CANCEL_REQUESTED", "CANCELLED", "BLOCKED", "FAILED"].includes(activeRun?.status)) { await retryAutoRun(`COLLECTION_RUN_${activeRun.status}`, 5000); return; }
      let taskResult = await send({ kind: "GET_ACTIVE_BROWSER_TASK" });
      if (!taskResult?.ok) throw new Error(taskResult?.error || "无法读取当前任务");
      let task = taskResult.value;
      if (!task) {
        taskResult = await send({ kind: "LEASE_BROWSER_TASK" });
        if (!taskResult?.ok) throw new Error(taskResult?.error || "无法领取任务");
        task = taskResult.value;
        showTask(task);
      }
      if (!task) {
        role("message").textContent = "队列为空；5 秒后再次检查。";
        scheduleDrive(5000);
        return;
      }
      const initial = inspect();
      const firstDecision = globalThis.XhsAutoRunController.decide({ enabled: true, task, currentUrl: location.href, snapshot: initial });
      if (firstDecision.action === "NAVIGATE") {
        role("message").textContent = `正在打开：${task.expectedPageType} · ${task.taskId}`;
        location.assign(firstDecision.targetUrl);
        return;
      }
      if (firstDecision.action === "OPEN_SEARCH_CARD") {
        await openTargetCard(firstDecision);
        return;
      }
      if (firstDecision.action === "SKIP_AND_CONTINUE") {
        await skipCurrentTask(firstDecision.reason, `The note ${firstDecision.noteId || ""} is no longer visible in its parent search result.`);
        return;
      }
      if (firstDecision.action === "SUBMIT_AND_RETRY") {
        await failCurrentTask(initial, firstDecision.reason);
        return;
      }
      const maxWaitMs = task.context?.slowNetworkMaxWaitMs || 12_000;
      const tracker = new globalThis.XhsAutoRunController.StabilityTracker({ requiredMatches: 2, maxWaitMs });
      let commentActionsTaken = 0;
      let searchActionsTaken = 0;
      let searchStagnantRounds = 0;
      let previousSearchCount = -1;
      let lastProgressSubmittedCount = 0;
      let lastProgressSubmittedAt = 0;
      let commentTraversalSkipped = task.context?.commentTraversal !== true;
      while (true) {
        const snapshot = inspect();
        if (task.expectedPageType === "SEARCH" && snapshot.pageType === "SEARCH" && snapshot.status === "VISIBLE") {
          const targetCount = effectiveSearchLimit(task);
          const maxSearchActions = Math.min(2500, Math.max(40, Math.ceil(targetCount / 3)));
          const currentCount = snapshot.cards?.length || 0;
          const candidateCount = snapshot.candidateCount || 0;
          searchStagnantRounds = previousSearchCount >= 0 && candidateCount <= previousSearchCount ? searchStagnantRounds + 1 : 0;
          previousSearchCount = candidateCount;
          const progressNow = Date.now();
          const progressAdvanced = currentCount > lastProgressSubmittedCount;
          const progressBatchReady = currentCount >= 20 && currentCount - lastProgressSubmittedCount >= 25;
          const progressTimeReady = currentCount >= 20 && progressAdvanced && progressNow - lastProgressSubmittedAt >= 2000;
          if (progressBatchReady || progressTimeReady) {
            const progressResult = await send({
              kind: "SUBMIT_SEARCH_PROGRESS",
              snapshot: { ...snapshot, collectionProgress: { partial: true, candidateCount, capturedCount: currentCount, targetCount } },
            });
            if (progressResult?.ok) {
              lastProgressSubmittedCount = currentCount;
              lastProgressSubmittedAt = progressNow;
            }
          }
          if (currentCount < targetCount && searchActionsTaken < maxSearchActions && searchStagnantRounds < 6) {
            const advanced = globalThis.XhsVisibleExtractor.advanceSearchResults();
            searchActionsTaken += 1;
            tracker.reset(Date.now());
            role("message").textContent = `有效入台 ${currentCount}/${targetCount} · 候选 ${candidateCount} · 第 ${searchActionsTaken} 次翻屏${advanced?.advanced ? "" : " · 等待加载"}`;
            await waitForDriveStep(searchStagnantRounds ? 650 : 400);
            continue;
          }
          snapshot.searchTraversal = {
            targetCount,
            capturedCount: currentCount,
            candidateCount,
            actionCount: searchActionsTaken,
            stagnantRounds: searchStagnantRounds,
            batchCount: Math.ceil(currentCount / 100),
            exhausted: currentCount < targetCount,
            stopReason: currentCount >= targetCount ? "TARGET_REACHED" : searchStagnantRounds >= 6 ? "NO_GROWTH" : "ACTION_BUDGET_REACHED"
          };
        }
        let traversal = commentTraversalSkipped ? { action: "COMPLETE" } : globalThis.XhsCommentTraversalController.decide(snapshot, commentActionsTaken, 24);
        if (traversal.action === "ADVANCE") {
          const advanced = globalThis.XhsVisibleExtractor.advanceVisibleComments();
          if (!advanced.advanced) {
            commentTraversalSkipped = true;
            snapshot.commentTraversal = { ...(snapshot.commentTraversal || {}), complete: false, commentFetchSucceeded: false, stopReason: "COMMENT_TRAVERSAL_STALLED" };
            role("message").textContent = "评论补证停滞，点赞/收藏/转发仍会正常入台";
            traversal = { action: "COMPLETE" };
          } else {
            commentActionsTaken += 1;
            tracker.reset(Date.now());
            role("message").textContent = `补全评论：${advanced.action} · ${commentActionsTaken}/24`;
            await waitForDriveStep(550);
            continue;
          }
        }
        if (traversal.action === "HALT") {
          commentTraversalSkipped = true;
          snapshot.commentTraversal = { ...(snapshot.commentTraversal || {}), complete: false, commentFetchSucceeded: false, stopReason: traversal.reason || "COMMENT_TRAVERSAL_INCOMPLETE" };
          role("message").textContent = "评论补证已到预算，详情指标继续入台";
        }
        const stability = tracker.observe(snapshot, Date.now());
        const decision = globalThis.XhsAutoRunController.decide({ enabled: true, task, currentUrl: location.href, snapshot, ...stability });
        if (decision.action === "NAVIGATE") {
          role("message").textContent = "正在返回来源搜索结果…";
          location.assign(decision.targetUrl);
          return;
        }
        if (decision.action === "OPEN_SEARCH_CARD") {
          await openTargetCard(decision);
          return;
        }
        if (decision.action === "SKIP_AND_CONTINUE") {
          await skipCurrentTask(decision.reason, `The note ${decision.noteId || ""} is no longer visible in its parent search result.`);
          return;
        }
        if (decision.action === "SUBMIT_AND_RETRY") {
          await failCurrentTask(snapshot, decision.reason);
          return;
        }
        if (decision.action === "FAIL_AND_RETRY") {
          await failCurrentTask(snapshot, decision.reason);
          return;
        }
        if (decision.action === "SUBMIT") {
          const value = await submitSnapshot(snapshot);
          role("message").textContent = `已保存：${value.receiptId} · 任务${value.task?.status || "未绑定"}`;
          if (value.task?.status !== "SUCCEEDED") {
            await retryAutoRun(`${value.task?.error?.code || "TASK_NOT_SUCCEEDED"} · ${value.task?.status || "UNKNOWN"}`);
            return;
          }
          // A Xiaohongshu search grid can be reshuffled shortly after hydration.
          // When the saved search creates its detail follow-up, lease and click it
          // in the same execution chain so the exact evidenced card cannot vanish
          // while UI counters are being refreshed.
          if (task.expectedPageType === "SEARCH" && task.context?.autoCollectNotes === true) {
            // Only open the task actually leased by the server. A suggested
            // enrichment target may be a video or belong to another task.
            const nextResult = await send({ kind: "LEASE_BROWSER_TASK" });
            if (!nextResult?.ok) throw new Error(nextResult?.error || "无法领取详情任务");
            const nextTask = nextResult.value;
            if (nextTask) {
              showTask(nextTask);
              const nextSnapshot = inspect();
              const nextDecision = globalThis.XhsAutoRunController.decide({ enabled: true, task: nextTask, currentUrl: location.href, snapshot: nextSnapshot });
              if (nextDecision.action === "OPEN_SEARCH_CARD") {
                void refreshRun();
                await openTargetCard(nextDecision);
                return;
              }
              scheduleDrive(150);
              void refreshRun();
              return;
            }
          }
          void refreshRun();
          scheduleDrive(task.context?.requestIntervalMs ?? 500);
          return;
        }
        role("message").textContent = `等待页面稳定：${stability.consecutive}/2`;
        await waitForDriveStep(450);
      }
    } catch (error) {
      await retryAutoRun(error instanceof Error ? error.message : "连续执行异常");
    } finally {
      driveRunning = false;
    }
  }

  panel.addEventListener("click", async (event) => {
    const preset = event.target?.dataset?.limit;
    if (preset) {
      role("search-limit").value = preset;
      event.target.closest(".xiw-presets")?.querySelectorAll("button").forEach((button) => button.classList.toggle("active", button === event.target));
      return;
    }
    const action = event.target?.dataset?.action;
    if (!action) return;
    if (action === "collapse") {
      panel.classList.toggle("xiw-collapsed");
      event.target.textContent = panel.classList.contains("xiw-collapsed") ? "+" : "－";
      return;
    }
    role("message").textContent = "处理中…";
    if (action === "save-limit") {
      const requested = Number(role("search-limit").value);
      if (!Number.isInteger(requested) || requested < 1 || requested > 10000) {
        role("message").textContent = "请输入 1–10000 之间的整数。";
        role("search-limit").focus();
        return;
      }
      const result = await send({ kind: "SET_COLLECTION_SETTINGS", searchLimit: requested });
      if (!result?.ok) {
        role("message").textContent = `目标保存失败：${result?.error || "扩展无响应"}`;
        return;
      }
      collectionSettings = result.value;
      sessionSearchLimitOverride = requested;
      renderCollectionSettings();
      const currentCount = searchAccumulator.cards.length;
      role("message").textContent = result.value.workbenchSynced
        ? `目标已同步到工作台${result.value.activeCollectionRun ? "及本轮任务" : "，下一轮生效"}；本页候选 ${currentCount} 条。`
        : `仅保存到浏览器，尚未同步工作台：${result.value.syncWarning || "本地服务未连接"}`;
      await refreshRun();
      wakeDrive();
      return;
    }
    if (action === "lease") {
      const result = await send({ kind: "LEASE_BROWSER_TASK" });
      showTask(result?.ok ? result.value : null);
      role("message").textContent = result?.ok ? (result.value ? "已领取任务；请打开目标页面后采集。" : "当前没有待领取任务。") : `领取失败：${result?.error || "本地服务无响应"}`;
      return;
    }
    if (action === "open") {
      if (!activeTask) { role("message").textContent = "请先领取任务。"; return; }
      role("message").textContent = "正在打开任务目标…";
      location.assign(activeTask.targetUrl);
      return;
    }
    if (action === "capture") {
      const snapshot = inspect();
      const result = await send({ kind: "SUBMIT_VISIBLE_SNAPSHOT", snapshot });
      role("message").textContent = result?.ok ? `已保存：${result.value.receiptId}${result.value.task ? ` · 任务${result.value.task.status}` : ""}` : `未保存：${result?.error || "本地服务无响应"}`;
      if (result?.ok && result.value.task) showTask(null);
      return;
    }
    if (action === "auto-start") {
      const result = await send({ kind: "SET_BROWSER_AUTORUN", enabled: true, userInitiated: true });
      showAuto(result?.value);
      role("message").textContent = result?.ok ? "自动更新已启动；切到其他应用后会在浏览器允许的范围内继续采集。" : `启动失败：${result?.error || "本地服务无响应"}`;
      if (result?.ok) driveAutoRun();
      return;
    }
    if (action === "auto-stop") {
      clearTimeout(driveTimer);
      const result = await send({ kind: "SET_BROWSER_AUTORUN", enabled: false, userInitiated: true });
      showAuto(result?.value);
      role("message").textContent = result?.ok ? "自动更新已暂停。" : `停止失败：${result?.error || "扩展无响应"}`;
      return;
    }
    const controlAction = action === "pause" ? "PAUSE" : action === "resume" ? "RESUME" : "CANCEL";
    const progress = latestCollectionProgress;
    const result = await send({ kind: "COLLECTION_RUN_CONTROL", action: controlAction, runKind: progress?.runKind, runId: progress?.run?.runId });
    role("message").textContent = result?.ok ? `运行状态：${result.value.run.status}` : `控制未生效：${result?.error || "没有活动任务"}`;
    if (result?.ok && controlAction === "RESUME") driveAutoRun();
    if (result?.ok && controlAction === "CANCEL") clearTimeout(driveTimer);
    await refreshRun();
  });

  role("search-limit").addEventListener("keydown", (event) => {
    if (event.key === "Enter") panel.querySelector("[data-action='save-limit']").click();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind !== "BACKGROUND_COLLECTION_TICK") return false;
    wakeDrive();
    return false;
  });

  inspect();
  const heartbeat = () => {
    const snapshot = inspect();
    send({ kind: "EXTENSION_HEARTBEAT", pageUrl: location.href, pageType: snapshot.pageType })
      .then((result) => { if (result?.value?.reloadRequired) setStatus("扩展已更新，请刷新当前小红书页面", false); else if (!result?.ok) setStatus("本地服务未连接", false); });
    void refreshRun();
  };
  heartbeat();
  setInterval(heartbeat, 15_000);
  send({ kind: "WORKBENCH_STATUS" }).then((result) => setStatus(result?.ok ? "本地服务已连接" : "本地服务未连接", result?.ok));
  send({ kind: "GET_ACTIVE_BROWSER_TASK" }).then((result) => showTask(result?.ok ? result.value : null));
  send({ kind: "GET_COLLECTION_SETTINGS" }).then((result) => {
    if (!result?.ok) return;
    collectionSettings = result.value;
    renderCollectionSettings();
    inspect();
  });
  send({ kind: "GET_BROWSER_AUTORUN" }).then(async (result) => {
    if (result?.ok && globalThis.XhsAutoRunController.shouldAutoStart(result.value)) {
      result = await send({ kind: "SET_BROWSER_AUTORUN", enabled: true, userInitiated: false });
    }
    showAuto(result?.value);
    if (result?.ok && result.value.enabled) driveAutoRun();
  });
  refreshRun();
})();
