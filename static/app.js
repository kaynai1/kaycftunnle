/* SPDX-License-Identifier: MIT · Copyright (c) 2026 EasonShu */
/* Kay-cftunnle 面板 · 前端逻辑
   顶部一级标签路由：overview / tunnels / dns(域名与 DNS) / connector / settings。
   交互一律在页内完成：新建走 .form-panel，行内展开走 .row-detail（令牌、编辑、删除确认）。
   约定：/api 业务错误一律 HTTP 200 + {ok:false,...}，协议/鉴权错误才用 4xx/5xx。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // 顶部一级标签：route → 标题，同时充当合法路由表
  var TAB_TITLES = {
    overview: "总览", tunnels: "隧道", dns: "域名与 DNS",
    connector: "连接器", settings: "设置",
  };

  // 是否已进入面板：区分「从未登录」与「会话过期」，避免未登录时被登出逻辑刷循环
  var panelEntered = false;
  // 顶栏状态灯轮询句柄
  var liveChipTimer = 0;
  // 连接器页轮询句柄与并发保护
  var connectorTimer = 0;
  var connectorFetching = false;
  var connectorActionBusy = false;

  // DNS / Ingress 缓存
  var zonesCache = [];
  var currentPrimaryZone = "";
  var dnsAllRecords = [];
  var dnsManagedCount = 0;
  var dnsTotal = 0;
  var dnsFilter = { q: "", type: "", source: "all", proxy: "all" };
  var DNS_RENDER_LIMIT = 200;
  var ingressProbeResults = {};
  var pendingRuleFocus = "";

  // 总览三步进度：每一步完成状态由各自接口回填
  var setupState = {
    cf: false,
    tunnel: null,
    pendingTunnel: "",
    rules: 0,
  };

  /* ------------------------------------------------------------ API 封装 */

  function api(method, path, body, options) {
    options = options || {};
    var opts = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var req = fetch("/api" + path, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          // 激活失效/被吊销：服务端已锁定，直接回激活页，避免在面板里反复报错
          if (res.status === 403 && data && data.code === "unlicensed") {
            window.location.replace("/activate.html");
          }
          var msg = (data && data.error) || ("请求失败 (" + res.status + ")");
          throw new Error(msg);
        }
        return data;
      });
    });
    // 读接口要等 Cloudflare 的并行检查；写接口的云端同步已放到后台，
    // 但建 DNS 记录仍在请求里，留足余量，避免「服务端成功、前端先超时」。
    var timeoutMs = options.timeoutMs || (method === "GET" ? 20000 : 45000);
    return Promise.race([req, new Promise(function (_, reject) {
      setTimeout(function () {
        var err = new Error("请求超时（" + Math.round(timeoutMs / 1000) + " 秒），服务器可能仍在处理");
        err.timeout = true;
        reject(err);
      }, timeoutMs);
    })]);
  }

  /* ------------------------------------------------------------ 工具 */

  var _ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return _ESC_MAP[c]; });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2600);
  }

  function svgIcon(name, fill) {
    return '<svg class="ico' + (fill ? " ico-fill" : "") + '" aria-hidden="true" focusable="false">' +
      '<use href="#i-' + name + '"></use></svg>';
  }

  // 会改文案的按钮统一走这里，避免 textContent 把图标冲掉
  function setBtn(btn, icon, text, fill) {
    if (!btn) return;
    btn.innerHTML = (icon ? svgIcon(icon, fill) : "") + "<span>" + esc(text) + "</span>";
  }

  // cloudflared 支持的回源协议，与后端 SERVICE_SCHEMES 保持一致
  var SERVICE_RE = /^(https?|tls|tcp|ssh|rdp|smb|smtp|mysql|postgresql|clickhouse|kafka|udp):\/\/|^unix:/;
  function serviceOk(s) { return SERVICE_RE.test(String(s || "").trim()); }

  // 规则写进本地库之后还要下发到隧道；下发失败时流量是不通的，必须让用户看见
  function notifySync(r, doneText, okText) {
    if (r && r.sync_queued) {
      toast(doneText + "，隧道路由正在后台同步");
      return;
    }
    if (r && r.synced === false) {
      toast(doneText + "，但隧道路由下发失败：" + (r.sync_error || "未知原因"));
      return;
    }
    toast(okText || (doneText + "，隧道路由已生效"));
  }

  // 超时不等于失败：服务端可能已经处理完，直接报「删除失败」会误导用户重试
  function actionFailed(label, err, reconcile) {
    if (err && err.timeout) {
      toast(label + "结果待确认：请求超时，正在核对…");
      if (reconcile) setTimeout(reconcile, 1200);
      return;
    }
    toast(label + "失败：" + err.message);
  }

  /* ------------------------------------------------------------ 页内表单 / 行内展开 */

  function openPanel(id, focusId) {
    var el = $(id);
    if (!el) return;
    el.hidden = false;
    var focus = focusId && $(focusId);
    if (focus) focus.focus();
  }

  function closePanel(id) {
    var el = $(id);
    if (el) el.hidden = true;
  }

  // 一次只展开一处：行内表单有固定 id，必须先清掉其他行里开着的展开区
  function toggleDetail(item, kind, html) {
    var old = item.querySelector(".row-detail");
    if (old && old.getAttribute("data-kind") === kind) {
      collapseDetail(item);
      return null;
    }
    collapseAll();
    var box = document.createElement("div");
    box.className = "row-detail";
    box.setAttribute("data-kind", kind);
    box.innerHTML = html;
    item.appendChild(box);
    item.classList.toggle("is-deleting", kind === "del");
    return box;
  }

  function collapseDetail(item) {
    var old = item.querySelector(".row-detail");
    if (old) old.remove();
    item.classList.remove("is-deleting");
  }

  function collapseAll() {
    document.querySelectorAll(".row-detail").forEach(function (el) { el.remove(); });
    document.querySelectorAll(".tunnel-item,.ingress-item").forEach(function (el) {
      el.classList.remove("is-deleting");
    });
    // 访问规则表单是卡片内的常驻区域，不能跟着切页/展开行一起收起，
    // 否则隧道列表还在、添加按钮却消失，直到下一次 /tunnels 回来
    ["tunnelForm", "importConfirm", "clearLogsConfirm"].forEach(closePanel);
  }

  function copyText(text) {
    if (!text) { toast("无可复制内容"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("已复制到剪贴板"); },
        function () { fallbackCopy(text); }
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast("已复制到剪贴板");
    } catch (e) {
      toast("复制失败，请手动选择复制");
    }
    document.body.removeChild(ta);
  }

  /* ------------------------------------------------------------ 登录 / 登出 */

  function showLoginError(msg) {
    var el = $("loginError");
    el.textContent = msg;
    el.classList.add("show");
  }
  function clearLoginError() { $("loginError").classList.remove("show"); }

  function onLoginSubmit(ev) {
    ev.preventDefault();
    clearLoginError();
    var btn = $("loginBtn");
    var username = $("loginUser").value.trim();
    var password = $("loginPass").value;
    if (!username || !password) { showLoginError("用户名和密码不能为空"); return; }
    btn.disabled = true;
    btn.textContent = "登录中…";
    api("POST", "/auth/login", { username: username, password: password })
      .then(function () {
        $("loginPass").value = "";
        enterPanel();
      })
      .catch(function (err) { showLoginError(err.message || "登录失败"); })
      .finally(function () { btn.disabled = false; btn.textContent = "登 录"; });
  }

  function logout() {
    if (liveChipTimer) { clearInterval(liveChipTimer); liveChipTimer = 0; }
    stopConnectorPolling();
    panelEntered = false;
    api("POST", "/auth/logout").catch(function () {}).then(function () {
      collapseAll();
      $("shellView").hidden = true;
      $("loginView").style.display = "";
      location.hash = "";
    });
  }

  /* ------------------------------------------------------------ 面板框架 */

  function currentRoute() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    return TAB_TITLES[h] ? h : "overview";
  }

  function applyRoute() {
    var route = currentRoute();
    collapseAll();
    document.querySelectorAll(".tab-link").forEach(function (a) {
      var on = a.getAttribute("data-route") === route;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + route);
    });
    if (route === "connector") startConnectorPolling();
    else stopConnectorPolling();

    // 切回总览时先按已知隧道恢复规则表单，避免等 /tunnels 云端往返期间按钮消失
    if (route === "overview" && overviewTunnel) updateIngressGate(overviewTunnel);
    if (route === "overview") { refreshOverview(); loadCfStatus(); refreshTunnels(true); refreshIngresses(true); }
    else if (route === "dns") { refreshZones(); refreshDnsRecords(); }
    else if (route === "connector") { refreshConnector(); loadSystemSettings(); }
    else if (route === "settings") { loadSystemInfo(); loadSystemSettings(); loadLicenseStatus(); refreshLogs(); }
  }
  function enterPanel() {
    panelEntered = true;
    $("loginView").style.display = "none";
    $("shellView").hidden = false;
    refreshLiveChip();
    if (!liveChipTimer) liveChipTimer = setInterval(refreshLiveChip, 20000);
    applyRoute();
  }

  // 顶栏常驻状态灯：不进连接器页也能看出流量是否通
  function setLive(state, text) {
    var dot = $("liveDot");
    if (!dot) return;
    dot.className = "dot is-" + state;
    $("liveText").textContent = text;
  }

  function dotHtml(state) {
    return '<span class="dot is-' + state + '"></span>';
  }

  // 状态灯独立刷新：落在哪个标签页都要亮，不能只在总览页拉一次。
  // 这里只反映本机连接器进程，云端是否确认由总览页的隧道列表负责，避免过度承诺。
  function refreshLiveChip() {
    api("GET", "/connector/status").then(function (c) {
      setLive(c.running ? "ok" : (c.binary_exists ? "idle" : "bad"),
        c.running ? "连接器运行中" : (c.binary_exists ? "连接器未运行" : "cloudflared 未安装"));
      ovStats.conn = (c && !c.error)
        ? { running: !!c.running, binary: !!c.binary_exists, uptime: c.uptime || 0 }
        : { error: true };
      updateOverviewStats();
      syncGateFromConnector(c);
    }).catch(function () {
      setLive("bad", "状态获取失败");
      ovStats.conn = { error: true };
      updateOverviewStats();
    });
  }

  /* ------------------------------------------------------------ 总览 · 三步进度 */

  function setSetupStep(id, stateId, done, current, text) {
    var step = $(id);
    if (!step) return;
    var state = $(stateId);
    var no = step.querySelector(".setup-step-no");
    step.classList.toggle("is-done", !!done);
    step.classList.toggle("is-current", !done && !!current);
    if (no) {
      no.innerHTML = done ? svgIcon("check") : (no.getAttribute("data-no") || "");
    }
    if (state) state.textContent = text;
  }

  function renderSetupProgress() {
    var cfDone = !!setupState.cf;
    var tunnelDone = !!setupState.tunnel;
    var rulesDone = setupState.rules > 0;
    var current = !cfDone ? "cf" : (!tunnelDone ? "tunnel" : "rules");
    var doneCount = (cfDone ? 1 : 0) + (tunnelDone ? 1 : 0) + (rulesDone ? 1 : 0);
    var countEl = $("setupCount");
    if (countEl) countEl.textContent = doneCount + " / 3";
    var nav = $("setupProgress");
    if (nav) {
      nav.style.setProperty("--setup-fill",
        doneCount >= 3 ? "66.666%" : (doneCount === 2 ? "33.333%" : "0%"));
    }

    setSetupStep("setupCf", "setupCfState", cfDone, current === "cf",
      cfDone ? "已配置" : "待配置");

    var tunnelText = tunnelDone
      ? "已连接 · " + setupState.tunnel.name
      : (setupState.pendingTunnel ? "连接中 · " + setupState.pendingTunnel : "未连接");
    setSetupStep("setupTunnel", "setupTunnelState", tunnelDone, current === "tunnel", tunnelText);

    setSetupStep("setupRules", "setupRulesState", rulesDone, current === "rules",
      rulesDone ? setupState.rules + " 条规则" : "待添加");
  }

  function gotoSetupStep(step) {
    var card = $(step.getAttribute("data-goto"));
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    var focus = $(step.getAttribute("data-focus"));
    if (focus) setTimeout(function () { try { focus.focus({ preventScroll: true }); } catch (e) { focus.focus(); } }, 320);
  }

  /* ------------------------------------------------------------ 总览 */

  function renderLogs(logs) {
    var el = $("logList");
    if (!logs || !logs.length) {
      el.innerHTML = '<li class="log-empty">暂无操作记录</li>';
      return;
    }
    el.innerHTML = logs.map(function (l) {
      return '<li class="log-item">' +
        '<span class="log-time">' + esc(l.time) + '</span>' +
        '<span class="log-dot log-' + esc(l.level || "info") + '"></span>' +
        '<span class="log-action">' + esc(l.action) + '</span>' +
        (l.detail ? '<span class="log-detail">' + esc(l.detail) + '</span>' : '') +
        '</li>';
    }).join("");
  }

  function refreshOverview() {
    api("GET", "/auth/me").then(function (me) {
      $("userName").textContent = me.user.username;
      $("userAvatar").textContent = (me.user.username || "A").charAt(0).toUpperCase();
    }).catch(function () { if (panelEntered) logout(); });
  }

  function refreshLogs() {
    api("GET", "/logs?limit=10")
      .then(function (d) { renderLogs((d && d.logs) || []); })
      .catch(function () {});
  }
  /* ------------------------------------------------------------ 连接器（M4） */

  function formatDuration(seconds) {
    if (!seconds || seconds < 0) return "0 秒";
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h) return h + " 小时 " + m + " 分 " + s + " 秒";
    if (m) return m + " 分 " + s + " 秒";
    return s + " 秒";
  }

  function formatShortDuration(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (d) return d + " 天 " + h + " 小时";
    if (h) return h + " 小时 " + m + " 分";
    if (m) return m + " 分 " + (seconds % 60) + " 秒";
    return seconds + " 秒";
  }

  var connectorTunnelsCache = [];
  var overviewTunnel = null;
  var ovStats = { conn: null, tunnels: null, rules: null };

  function setStat(tileId, value, unit, meta, state) {
    var tile = $(tileId);
    if (!tile) return;
    tile.className = "stat-tile" + (state ? " is-" + state : "");
    var v = tile.querySelector(".stat-value");
    if (v) {
      v.innerHTML = esc(String(value)) +
        (unit ? '<span class="stat-unit">' + esc(unit) + "</span>" : "");
    }
    var m = tile.querySelector(".stat-meta");
    if (m) m.textContent = meta || "";
  }

  function updateOverviewStats() {
    var c = ovStats.conn;
    if (!c) {
      setStat("ovStatConn", "—", "", "检测中", "");
    } else if (c.error) {
      setStat("ovStatConn", "—", "", "状态获取失败", "bad");
    } else if (c.running) {
      setStat("ovStatConn", "运行中", "", "已运行 " + formatShortDuration(c.uptime), "ok");
    } else if (c.binary) {
      setStat("ovStatConn", "已停止", "", "cloudflared 已就绪", "warn");
    } else {
      setStat("ovStatConn", "未安装", "", "需安装 cloudflared", "bad");
    }

    var t = ovStats.tunnels;
    if (!t) {
      setStat("ovStatTunnels", "—", "", "加载中", "");
    } else if (t.error) {
      setStat("ovStatTunnels", "—", "", "获取失败", "bad");
    } else if (!t.configured) {
      setStat("ovStatTunnels", "—", "", "未配置凭据", "");
    } else if (!t.total) {
      setStat("ovStatTunnels", "0", "条", "尚未创建隧道", "");
    } else {
      setStat("ovStatTunnels", t.total, "条",
        t.local ? t.local + " 条本地已连接" : "暂无本地连接",
        t.local ? "ok" : "");
    }

    var r = ovStats.rules;
    if (!r) {
      setStat("ovStatRules", "—", "", "加载中", "");
    } else if (r.error) {
      setStat("ovStatRules", "—", "", "获取失败", "bad");
    } else if (!r.configured) {
      setStat("ovStatRules", "—", "", "未配置凭据", "");
    } else if (!r.total) {
      setStat("ovStatRules", "0", "条", "尚未添加规则", "");
    } else if (r.bad) {
      setStat("ovStatRules", r.total, "条", r.bad + " 条待修复", "warn");
    } else {
      setStat("ovStatRules", r.total, "条", "全部已生效", "ok");
    }
  }
  var connectorOptionsHtml = "";
  var connectorSelectDirty = false;
  var connectorLogRaw = "";
  var connectorLogShown = "";
  var connectorLogLines = [];
  var connectorLogRunning = false;

  function logLineClass(line) {
    // 先认行首的级别标记：WRN 行里带 error="..." 时不能算成错误
    var token = (/^\S+\s+(TRC|DBG|INF|WRN|ERR|FTL)\b/i.exec(line) || [])[1];
    if (token) {
      token = token.toUpperCase();
      if (token === "ERR" || token === "FTL") return "log-err";
      if (token === "WRN") return "log-warn";
      return "";
    }
    if (/\b(FATAL|PANIC|ERROR|ERR|FTL)\b/i.test(line)) return "log-err";
    if (/\b(WARN|WARNING|WRN|RETRY|TIMEOUT)\b/i.test(line)) return "log-warn";
    return "";
  }

  function logLevelOf(line) {
    var cls = logLineClass(line);
    return cls === "log-err" ? "error" : (cls === "log-warn" ? "warn" : "normal");
  }

  function highlightLogLine(line, q) {
    if (!q) return esc(line) || "&nbsp;";
    var low = line.toLowerCase(), ql = q.toLowerCase();
    var out = "", pos = 0, idx;
    while ((idx = low.indexOf(ql, pos)) !== -1) {
      out += esc(line.slice(pos, idx)) + '<mark class="log-hit">' + esc(line.slice(idx, idx + q.length)) + "</mark>";
      pos = idx + q.length;
    }
    return (out + esc(line.slice(pos))) || "&nbsp;";
  }

  function renderConnectorLogView(force) {
    var logsEl = $("connectorLogs");
    if (!logsEl) return;
    var q = (($("connLogSearch") || {}).value || "").trim();
    var level = (($("connLogLevel") || {}).value) || "all";
    var sig = connectorLogRaw + "\u0000" + q.toLowerCase() + "\u0000" + level;
    var countEl = $("connLogCount");
    if (!force && sig === connectorLogShown) return;
    connectorLogShown = sig;

    var errCount = 0, warnCount = 0;
    connectorLogLines.forEach(function (line) {
      var lv = logLevelOf(line);
      if (lv === "error") errCount++;
      else if (lv === "warn") warnCount++;
    });

    if (!connectorLogLines.length) {
      logsEl.textContent = connectorLogRunning ? "（暂无日志输出）" : "（进程未运行）";
      if (countEl) countEl.textContent = "";
      return;
    }

    var filtered = connectorLogLines.filter(function (line) {
      var lv = logLevelOf(line);
      if (level !== "all" && lv !== level) return false;
      if (q && line.toLowerCase().indexOf(q.toLowerCase()) === -1) return false;
      return true;
    });
    if (countEl) {
      countEl.textContent = "错误 " + errCount + " · 警告 " + warnCount +
        " · 显示 " + filtered.length + " / " + connectorLogLines.length + " 行";
    }
    if (!filtered.length) {
      logsEl.innerHTML = '<span class="log-line log-no-match">没有匹配的日志行，换个关键词或级别试试。</span>';
      return;
    }
    var keepTop = logsEl.scrollTop;
    var auto = $("connAutoScroll") && $("connAutoScroll").checked;
    logsEl.innerHTML = filtered.map(function (line) {
      var cls = logLineClass(line);
      return '<span class="log-line' + (cls ? " " + cls : "") + '">' + highlightLogLine(line, q) + '</span>';
    }).join("");
    if (auto && logsEl.scrollHeight > logsEl.clientHeight) {
      logsEl.scrollTop = logsEl.scrollHeight;
    } else {
      logsEl.scrollTop = keepTop;
    }
  }

  function renderConnectorLogs(lines, running) {
    var runningChanged = !!running !== connectorLogRunning;
    connectorLogLines = lines || [];
    connectorLogRunning = !!running;
    var raw = connectorLogLines.join("\n");
    var rawChanged = raw !== connectorLogRaw;
    connectorLogRaw = raw;
    renderConnectorLogView(rawChanged || runningChanged);
  }

  function jumpToRecentError() {
    var logsEl = $("connectorLogs");
    var hits = logsEl.querySelectorAll(".log-err");
    if (!hits.length) {
      toast("当前筛选下没有错误行，可把级别切到「错误」再试");
      return;
    }
    var last = hits[hits.length - 1];
    var lr = last.getBoundingClientRect(), pr = logsEl.getBoundingClientRect();
    var top = logsEl.scrollTop + (lr.top - pr.top) - logsEl.clientHeight / 2 + lr.height / 2;
    if (logsEl.scrollTo) logsEl.scrollTo({ top: top, behavior: "smooth" });
    else logsEl.scrollTop = top;
    last.classList.add("log-flash");
    setTimeout(function () { last.classList.remove("log-flash"); }, 1600);
  }

  var TIMELINE_META = {
    start: { label: "已启动", cls: "is-ok" },
    exit: { label: "意外退出", cls: "is-bad" },
    start_fail: { label: "启动失败", cls: "is-bad" },
    retry: { label: "自动拉起", cls: "is-warn" },
    give_up: { label: "停止拉起", cls: "is-warn" },
    stop: { label: "手动停止", cls: "is-idle" },
    restart: { label: "手动重启", cls: "is-idle" },
  };

  function renderTimeline(data) {
    var el = $("connTimeline");
    if (!el || !data) return;
    var events = data.events || [];
    var counts = data.counts || {};
    var sum = $("connTimelineSummary");
    if (sum) {
      sum.textContent = events.length
        ? "启动 " + (counts.start || 0) + " · 退出 " + (counts.exit || 0) + " · 拉起 " + (counts.retry || 0)
        : "";
    }
    if (!events.length) {
      el.innerHTML = '<div class="tl-empty">最近 24 小时没有启动或退出记录。</div>';
      return;
    }
    el.innerHTML = events.map(function (e) {
      var meta = TIMELINE_META[e.kind] || { label: e.kind || "事件", cls: "is-idle" };
      return '<div class="tl-item ' + meta.cls + '">' +
        '<span class="tl-dot" aria-hidden="true"></span>' +
        '<div class="tl-body">' +
          '<div class="tl-head"><span class="tl-kind">' + esc(meta.label) + '</span>' +
          '<span class="tl-time">' + esc(e.time) + '</span></div>' +
          (e.detail ? '<div class="tl-detail">' + esc(e.detail) + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join("");
  }

  function refreshConnector(silent) {
    silent = !!silent;
    if (connectorFetching) return;
    connectorFetching = true;
    var statusEl = $("connStatus");
    var binaryEl = $("connBinary");
    var protoEl = $("connProto");
    var pidEl = $("connPidUptime");
    var logsEl = $("connectorLogs");
    var select = $("connDefaultTunnel");

    // 状态每轮都拉；隧道列表只在首次或手动刷新时拉，避免静默轮询反复打 Cloudflare API
    var tunnelsReq = (silent && connectorTunnelsCache.length)
      ? Promise.resolve({ configured: true, tunnels: connectorTunnelsCache })
      : api("GET", "/tunnels").catch(function () { return { configured: false, tunnels: [] }; });

    Promise.all([
      api("GET", "/connector/status").catch(function (err) { return { error: err.message }; }),
      tunnelsReq,
      api("GET", "/connector/events?hours=24&limit=40").catch(function () { return null; }),
    ]).then(function (results) {
      var c = results[0] || {};
      var t = results[1] || {};
      if (c.error) {
        statusEl.textContent = "获取失败";
        statusEl.className = "connector-value is-bad";
        logsEl.textContent = c.error;
        connectorLogRaw = "";
        connectorLogShown = "";
        setLive("bad", "状态获取失败");
        return;
      }
      connectorTunnelsCache = (t.tunnels || []).filter(function (tu) { return tu.id && tu.name; });
      var options = '<option value="">自动选择第一条隧道</option>' +
        connectorTunnelsCache.map(function (tu) {
          return '<option value="' + esc(tu.id) + '">' + esc(tu.name + "（" + tu.id.slice(0, 8) + "…）") + '</option>';
        }).join("");
      // 轮询时不重绘用户正在操作的下拉框
      if (options !== connectorOptionsHtml && document.activeElement !== select) {
        var keep = select.value;
        connectorOptionsHtml = options;
        select.innerHTML = options;
        var keepOk = Array.prototype.some.call(select.options, function (o) { return o.value === keep; });
        if (keep && keepOk) select.value = keep;
      }
      if (c.default_tunnel_id && !connectorSelectDirty && document.activeElement !== select) {
        select.value = c.default_tunnel_id;
      }

      // 状态
      if (c.running) {
        statusEl.textContent = "运行中";
        statusEl.className = "connector-value is-ok";
      } else {
        statusEl.textContent = c.binary_exists ? "已停止" : "未安装";
        statusEl.className = "connector-value" + (c.binary_exists ? "" : " is-bad");
      }
      setLive(c.running ? "ok" : (c.binary_exists ? "idle" : "bad"),
        c.running ? "连接器运行中" : (c.binary_exists ? "连接器未运行" : "cloudflared 未安装"));
      binaryEl.textContent = c.binary_exists ? (c.binary_path || "已安装") : "未找到";
      var protoMap = { http2: "HTTP/2", quic: "QUIC" };
      var ipMap = { ipv4: "IPv4", ipv6: "IPv6" };
      protoEl.textContent = (protoMap[c.protocol] || (c.protocol || "").toUpperCase()) + " / " +
        (ipMap[c.ip_version] || (c.ip_version || "").toUpperCase());
      pidEl.textContent = (c.pid || "–") + " / " + formatDuration(c.uptime || 0);

      renderConnectorLogs(c.logs || [], !!c.running);

      // 按钮可用性
      $("startConnectorBtn").disabled = c.running;
      $("stopConnectorBtn").disabled = !c.running;
      $("restartConnectorBtn").disabled = !c.binary_exists;

      renderWatchdog(c.watchdog || {});
      renderTimeline(results[2]);
    }).catch(function (err) {
      if (!silent) {
        statusEl.textContent = "获取失败";
        statusEl.className = "connector-value is-bad";
      }
    }).finally(function () {
      connectorFetching = false;
    });
  }

  // 只在连接器页、页面可见且用户勾选自动刷新时轮询
  function startConnectorPolling() {
    stopConnectorPolling();
    connectorTimer = setInterval(function () {
      if (document.hidden || connectorActionBusy) return;
      var auto = $("connAutoRefresh");
      if (auto && !auto.checked) return;
      refreshConnector(true);
    }, 5000);
  }

  function stopConnectorPolling() {
    if (connectorTimer) {
      clearInterval(connectorTimer);
      connectorTimer = 0;
    }
  }

  function formatClock(ts) {
    if (!ts) return "–";
    var d = new Date(ts * 1000);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function renderWatchdog(w) {
    var el = $("connWatchdog");
    if (!el) return;
    var exit = w.exit || {};
    var rows = [];
    rows.push('<div class="wd-row"><span class="wd-k">看门狗</span><span class="wd-v">' +
      (w.enabled ? "已启用" : "已关闭") + '</span></div>');
    if (w.retry_count) {
      rows.push('<div class="wd-row"><span class="wd-k">连续重试</span><span class="wd-v wd-warn">' +
        w.retry_count + " / " + (w.max_retry || 5) + ' 次</span></div>');
    }
    if (exit.exit_at) {
      var giveUp = exit.give_up ? ' <b class="wd-bad">（已停止拉起）</b>' : "";
      rows.push('<div class="wd-row"><span class="wd-k">最近异常退出</span><span class="wd-v wd-bad">' +
        formatClock(exit.exit_at) + " · 退出码 " + esc(exit.exit_code) +
        " · 运行 " + formatDuration(exit.uptime || 0) + giveUp + '</span></div>');
    }
    if (exit.reason) {
      rows.push('<div class="wd-row"><span class="wd-k">退出原因</span>' +
        '<span class="wd-v wd-bad">' + esc(exit.reason) + '</span></div>');
    }
    if (w.last_restart_at) {
      rows.push('<div class="wd-row"><span class="wd-k">最近自动拉起</span><span class="wd-v">' +
        formatClock(w.last_restart_at) + '</span></div>');
    }
    el.innerHTML = rows.join("");
    el.hidden = false;
  }

  function startConnector() {
    var btn = $("startConnectorBtn");
    connectorActionBusy = true;
    btn.disabled = true;
    setBtn(btn, "play", "启动中…", true);
    api("POST", "/connector/start", {}).then(function (res) {
      toast("连接器已启动，PID " + (res.pid || "–"));
      refreshConnector(true);
    }).catch(function (err) {
      toast("启动失败：" + err.message);
    }).finally(function () {
      connectorActionBusy = false;
      btn.disabled = false;
      setBtn(btn, "play", "启动", true);
    });
  }

  function stopConnector() {
    var btn = $("stopConnectorBtn");
    connectorActionBusy = true;
    btn.disabled = true;
    setBtn(btn, "stop", "停止中…", true);
    api("POST", "/connector/stop", {}).then(function () {
      toast("连接器已停止");
      refreshConnector(true);
    }).catch(function (err) {
      toast("停止失败：" + err.message);
    }).finally(function () {
      connectorActionBusy = false;
      btn.disabled = false;
      setBtn(btn, "stop", "停止", true);
    });
  }

  function restartConnector() {
    var btn = $("restartConnectorBtn");
    connectorActionBusy = true;
    btn.disabled = true;
    setBtn(btn, "restart", "重启中…");
    api("POST", "/connector/restart", {}).then(function () {
      toast("连接器已重启");
      refreshConnector(true);
    }).catch(function (err) {
      toast("重启失败：" + err.message);
    }).finally(function () {
      connectorActionBusy = false;
      btn.disabled = false;
      setBtn(btn, "restart", "重启");
    });
  }

  function saveDefaultTunnel() {
    var btn = $("saveDefaultTunnelBtn");
    var tunnelId = $("connDefaultTunnel").value;
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("POST", "/connector/default", { tunnel_id: tunnelId }).then(function () {
      connectorSelectDirty = false;
      toast("默认隧道已保存");
      refreshConnector(true);
    }).catch(function (err) {
      toast("保存失败：" + err.message);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "保存默认隧道";
    });
  }

  function clearConnectorLogs() {
    openPanel("clearLogsConfirm", "mClearLogsOk");
  }

  function confirmClearConnectorLogs() {
    var btn = $("mClearLogsOk");
    connectorActionBusy = true;
    btn.disabled = true;
    btn.textContent = "清空中…";
    api("POST", "/connector/clear-logs", {}).then(function () {
      toast("日志已清空");
      connectorLogRaw = "";
      connectorLogShown = "";
      connectorLogLines = [];
      $("connectorLogs").textContent = "（日志已清空）";
      if ($("connLogCount")) $("connLogCount").textContent = "";
      closePanel("clearLogsConfirm");
    }).catch(function (err) {
      toast("清空失败：" + err.message);
    }).finally(function () {
      connectorActionBusy = false;
      btn.disabled = false;
      btn.textContent = "确认清空";
    });
  }

  function downloadConnectorLogs() {
    if (!connectorLogRaw) { toast("暂无可下载的日志"); return; }
    var blob = new Blob([connectorLogRaw], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0") + "-" + String(d.getHours()).padStart(2, "0") +
      String(d.getMinutes()).padStart(2, "0");
    a.href = url;
    a.download = "cloudflared-" + stamp + ".log";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("日志已下载");
  }

  /* ------------------------------------------------------------ 设置页 */

  function setCfState(kind, text) {
    var el = $("cfState");
    if (!el) return;
    el.className = "cred-state is-" + kind;
    el.textContent = text;
  }

  function applyCfStatus(s) {
    $("cfToken").value = "";
    $("cfToken").placeholder = s.configured
      ? "已保存（" + s.token_masked + "）"
      : "粘贴 API Token";
    $("cfTokenMasked").textContent = s.configured ? "留空表示不修改" : "";
    if (s.account_id) $("cfAccount").value = s.account_id;
    setCfState(s.configured ? "ok" : "idle", s.configured ? "已配置" : "未配置");
    setupState.cf = !!s.configured;
    renderSetupProgress();
  }

  function loadCfStatus() {
    api("GET", "/cloudflare/status").then(function (s) {
      applyCfStatus(s);
    }).catch(function () { /* 保持表单原状 */ });
  }
  function applyNoAuthUi(noAuth) {
    var out = $("logoutBtn");
    if (out) out.hidden = !!noAuth;
    var box = $("sysNoAuth");
    if (box) box.checked = !!noAuth;
    var hint = $("accessHint");
    if (hint) {
      hint.textContent = noAuth
        ? "当前为免密模式：打开面板即管理员视图，请勿把面板地址暴露到公网。"
        : "当前已开启密码保护：打开面板需要登录。";
    }
  }

  function loadSystemSettings() {
    api("GET", "/system/settings").then(function (s) {
      var c = s.connector || {};
      $("sysAutoConnect").checked = !!c.auto_connect;
      $("sysProtocol").value = c.protocol || "http2";
      $("sysIPVersion").value = c.ip_version || "ipv4";
      $("sysWatchdog").checked = c.watchdog !== false;
      applyNoAuthUi(!!(s.panel && s.panel.no_auth_run));
    }).catch(function () { /* 保留下拉默认项 */ });
  }

  function saveAccessSetting() {
    var btn = $("saveAccessBtn");
    var enabled = $("sysNoAuth").checked;
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("POST", "/system/settings", { no_auth_run: enabled }).then(function (s) {
      applyNoAuthUi(!!(s.panel && s.panel.no_auth_run));
      toast(enabled ? "已开启免密访问，打开面板无需登录" : "已开启密码保护，下次打开需要登录");
    }).catch(function (err) { toast("保存失败：" + err.message); })
      .finally(function () { btn.disabled = false; btn.textContent = "保存"; });
  }

  function loadSystemInfo() {
    function setText(id, v) { var el = $(id); if (el) el.textContent = v; }
    api("GET", "/system/info").then(function (s) {
      var version = s.version || "–";
      var uptime = formatDuration(s.uptime_seconds || 0);
      var dataDir = s.data_dir || "–";
      var cfVersion = s.cloudflared_version || "未安装";
      var conn = s.connector || {};
      var tunnelText;
      if (conn.running && conn.current_tunnel_name) {
        tunnelText = dotHtml("ok") + esc(conn.current_tunnel_name);
      } else if (conn.running && conn.current_tunnel_id) {
        tunnelText = dotHtml("ok") + esc(conn.current_tunnel_id.slice(0, 8) + "…");
      } else {
        tunnelText = dotHtml("idle") + "未运行";
      }
      setText("sysPidSettings", (s.pid || "–") + " / Python " + (s.python_version || "–"));
      setText("sysVersionSettings", version);
      setText("sysUptimeSettings", uptime);
      setText("sysDataDirSettings", dataDir);
      setText("sysCfVersionSettings", cfVersion);
      var cur = $("sysCurrentTunnelSettings");
      if (cur) cur.innerHTML = tunnelText;
    }).catch(function () { /* 保持默认占位符 */ });
  }
  var licenseStatus = null;

  function formatExpiry(ts) {
    if (!ts) return "永久有效";
    var d = new Date(ts * 1000);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    var day = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    var days = Math.ceil((ts - Math.floor(Date.now() / 1000)) / 86400);
    if (days <= 0) return day + "（已到期）";
    return days <= 60 ? day + "（剩余 " + days + " 天）" : day;
  }

  function licenseVerifyText() {
    return licenseStatus && licenseStatus.mode === "offline" ? "上报授权" : "立即校验";
  }

  function renderLicenseStatus(s) {
    if (!s) return;
    licenseStatus = s;
    var offline = s.mode === "offline";
    var badge = $("licenseBadge");
    if (!badge) return;
    var badgeMap = {
      active: ["badge-ok", "已授权"],
      grace: ["badge-warn", "离线宽限"],
      revoked: ["badge-bad", "已吊销"],
      expired: [offline ? "badge-bad" : "badge-warn", offline ? "已到期" : "宽限已过"],
      invalid: ["badge-warn", "需处理"],
      pending: ["badge-muted", "校验中"],
      unactivated: ["badge-muted", "未激活"]
    };
    var meta = badgeMap[s.state] || ["badge-muted", "未知"];
    badge.className = "badge " + meta[0];
    badge.textContent = meta[1];
    $("licenseState").textContent = s.message || "–";
    $("licenseMode").textContent = offline ? "离线授权码（本地验签）" : "在线卡密";
    $("licenseCode").textContent = s.code_masked || "–";
    $("licenseMachine").textContent = s.machine_code || "–";
    $("licenseSerial").textContent = offline ? (s.serial ? "#" + s.serial : "–") : "–";
    $("licenseExpires").textContent = offline ? formatExpiry(s.expires_at) : "长期有效";
    $("licenseActivatedAt").textContent = formatClock(offline ? (s.bound_at || s.activated_at) : s.activated_at);
    $("licenseLastVerified").textContent = offline
      ? (s.last_verified_at ? formatClock(s.last_verified_at) + "（本机验签）" : "–")
      : formatClock(s.last_verified_at);
    $("licenseServer").textContent = s.server_configured ? "已配置（地址不在页面展示）" : "未配置";

    var hint = $("licenseHint");
    if (offline) {
      if (s.state === "revoked") {
        hint.textContent = "这份离线授权已被卖家吊销，面板已锁定。请联系卖家重新签发一份授权码。";
      } else if (s.state === "expired") {
        hint.textContent = "离线授权已到期。把机器码发给卖家续签一份，再回到激活页粘贴新的授权码。";
      } else if (s.server_configured) {
        hint.textContent = "离线授权在本机验签生效，每 6 小时向授权服务报到一次；报到失败不影响使用，被卖家吊销后会立即锁定。";
      } else {
        hint.textContent = "离线授权在本机验签生效，无需联网即可使用。当前未配置授权服务，卖家无法远程吊销，到期后需重新签发。";
      }
    } else if (s.last_error) {
      hint.textContent = "最近一次校验失败：" + s.last_error +
        (s.state === "grace" ? "；当前处于离线宽限，剩余约 " + Math.ceil((s.grace_left_seconds || 0) / 86400) + " 天。" : "");
    } else if (s.state === "grace") {
      hint.textContent = "暂时无法连接授权服务，离线宽限剩余约 " +
        Math.ceil((s.grace_left_seconds || 0) / 86400) + " 天；恢复联网后会自动校验。";
    } else if (s.state === "revoked") {
      hint.textContent = "卡密已被吊销，连接器已停止。请联系管理员解绑或更换卡密后重新激活。";
    } else if (s.state === "expired") {
      hint.textContent = "离线宽限期已过。恢复联网后点击「立即校验」，或输入新卡密重新激活。";
    } else {
      hint.textContent = "每 6 小时在线校验一次；断网时进入离线宽限，被吊销后立即锁定。";
    }
    var verifyBtn = $("licenseVerifyBtn");
    if (verifyBtn) {
      verifyBtn.hidden = !s.activated || s.state === "revoked" || (offline && !s.server_configured);
      setBtn(verifyBtn, "refresh", licenseVerifyText());
    }
  }

  function loadLicenseStatus() {
    return api("GET", "/license/status").then(function (s) {
      renderLicenseStatus(s);
      return s;
    }).catch(function () { return null; });
  }

  function verifyLicenseNow() {
    var btn = $("licenseVerifyBtn");
    if (!btn) return;
    btn.disabled = true;
    setBtn(btn, "refresh", "校验中…");
    api("POST", "/license/verify", {}).then(function (r) {
      if (r.status) renderLicenseStatus(r.status);
      if (r.ok) {
        toast(r.message && r.message !== "校验通过" ? r.message : "授权校验通过");
        return;
      }
      toast("校验未通过：" + (r.error || "未知原因"));
      if (r.status && r.status.activated && !r.status.valid) {
        setTimeout(function () { window.location.replace("/activate.html"); }, 1600);
      }
    }).catch(function (err) {
      toast("校验失败：" + err.message);
      loadLicenseStatus();
    }).finally(function () {
      btn.disabled = false;
      setBtn(btn, "refresh", licenseVerifyText());
    });
  }

  function copyLicenseMachine() {
    if (licenseStatus && licenseStatus.machine_code) {
      copyText(licenseStatus.machine_code);
      return;
    }
    loadLicenseStatus().then(function (s) {
      if (s && s.machine_code) copyText(s.machine_code);
      else toast("暂时无法读取机器码");
    });
  }

  function saveSystemSettings() {
    var btn = $("saveSysBtn");
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("POST", "/system/settings", {
      auto_connect: $("sysAutoConnect").checked,
      protocol: $("sysProtocol").value,
      ip_version: $("sysIPVersion").value,
      watchdog: $("sysWatchdog").checked,
    }).then(function () {
      toast("系统设置已保存");
    }).catch(function (err) { toast("保存失败：" + err.message); })
      .finally(function () { btn.disabled = false; btn.textContent = "保存设置"; });
  }

  function saveCfSettings() {
    var btn = $("saveCfBtn");
    var token = $("cfToken").value.trim();
    var account = $("cfAccount").value.trim();
    btn.disabled = true;
    btn.textContent = "验证中…";
    api("POST", "/cloudflare/verify", { api_token: token, account_id: account }, { timeoutMs: 90000 }).then(function (res) {
      var r = res.report || {};
      renderReport(r);
      if (!res.ok) {
        setCfState("bad", "验证未通过");
        toast("验证未通过，请查看下方报告");
        return null;
      }
      if (r.account_id) $("cfAccount").value = r.account_id;
      return api("POST", "/cloudflare/settings", {
        api_token: token,
        account_id: r.account_id || account,
      }).then(function (st) {
        applyCfStatus(st);
        setCfState("ok", "已验证");
        zonesCache = [];
        currentPrimaryZone = "";
        toast("凭据已验证并保存");
        refreshTunnels();
        refreshIngresses();
      });
    }).catch(function (err) {
      setCfState("bad", "保存失败");
      toast("保存失败：" + err.message);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "保存并验证";
    });
  }
  function savePassword() {
    var btn = $("savePwBtn");
    var oldPass = $("pwOld").value;
    var newPass = $("pwNew").value;
    if (!oldPass || !newPass) { toast("当前密码和新密码都不能为空"); return; }
    if (newPass.length < 8) { toast("新密码至少 8 位"); return; }
    if (newPass !== $("pwNew2").value) { toast("两次输入的新密码不一致"); return; }
    btn.disabled = true;
    btn.textContent = "修改中…";
    api("POST", "/auth/password", { old_password: oldPass, new_password: newPass }).then(function () {
      $("pwOld").value = ""; $("pwNew").value = ""; $("pwNew2").value = "";
      toast("密码已修改，请用新密码重新登录");
      // 服务端已吊销全部会话，直接走登出流程
      logout();
    }).catch(function (err) { toast("修改失败：" + err.message); })
      .finally(function () { btn.disabled = false; btn.textContent = "修改密码"; });
  }

  function reportRow(type, text) {
    var cls = type === true ? "ok" : type === false ? "bad" : "warn";
    var ico = type === true ? "check" : type === false ? "x" : "warn";
    return '<div class="report-row ' + cls + '">' +
      '<span class="report-ico">' + svgIcon(ico) + '</span><span>' + esc(text) + '</span></div>';
  }

  function renderReport(r) {
    var rows = [];
    rows.push(reportRow(r.token_valid,
      "Token 有效" + (r.token_status ? ("（状态：" + r.token_status + "）") : "")));
    if (r.account_id) {
      var acc = (r.accounts || []).filter(function (a) { return a.id === r.account_id; })[0];
      rows.push(reportRow(true, "账号：" + (acc ? (acc.name + "（" + acc.id + "）") : r.account_id)));
    } else if (r.token_valid) {
      rows.push(reportRow("warn", "未确定 Account ID，请手动填写"));
    }
    if (r.zones && r.zones.length) {
      var names = r.zones.slice(0, 3).map(function (z) { return z.name; }).join("、");
      rows.push(reportRow(true, "域名 " + r.zones.length + " 个：" + names + (r.zones.length > 3 ? " 等" : "")));
    }
    if (r.tunnels_readable) {
      rows.push(reportRow(true, "Cloudflare Tunnel 读取权限正常（当前 " + (r.tunnel_count || 0) + " 条隧道）"));
    }
    (r.warnings || []).forEach(function (w) { rows.push(reportRow("warn", w)); });
    (r.errors || []).forEach(function (e) { rows.push(reportRow(false, e)); });
    var el = $("cfReport");
    el.innerHTML = rows.join("");
    el.hidden = false;
  }

  /* ------------------------------------------------------------ 配置备份 */

  function exportConfig() {
    var btn = $("exportConfigBtn");
    btn.disabled = true;
    setBtn(btn, "download", "导出中…");
    api("GET", "/system/backup").then(function (r) {
      var json = JSON.stringify(r.backup, null, 2);
      var blob = new Blob([json], { type: "application/json;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      var d = new Date();
      var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") +
        String(d.getDate()).padStart(2, "0") + "-" + String(d.getHours()).padStart(2, "0") +
        String(d.getMinutes()).padStart(2, "0");
      a.href = url;
      a.download = "kay-cftunnle-config-" + stamp + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      $("backupHint").textContent = "已导出 " + a.download + "（含 API Token，请妥善保管）";
      toast("配置已导出");
    }).catch(function (err) {
      toast("导出失败：" + err.message);
    }).finally(function () {
      btn.disabled = false;
      setBtn(btn, "download", "导出配置");
    });
  }

  function sysRow(k, v) {
    return '<div class="sys-row"><span class="sys-k">' + esc(k) + '</span><span class="sys-v">' + esc(v) + '</span></div>';
  }

  function importConfigFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result || ""));
      } catch (e) {
        toast("文件不是合法的 JSON");
        return;
      }
      var cf = parsed.cloudflare || {};
      var conn = parsed.connector || {};
      $("importSummary").innerHTML =
        sysRow("文件", file.name || "–") +
        sysRow("Account ID", cf.account_id || "未填写") +
        sysRow("API Token", cf.api_token ? "已包含，导入后立即生效" : "未包含") +
        sysRow("默认隧道", conn.default_tunnel_id || "未设置");
      openPanel("importConfirm");
      $("mImportOk").onclick = function () {
        var ok = this;
        ok.disabled = true;
        ok.textContent = "导入中…";
        api("POST", "/system/backup", { backup: parsed }).then(function () {
          closePanel("importConfirm");
          toast("配置已导入");
          $("backupHint").textContent = "导入完成，配置已生效";
          loadCfStatus();
          loadSystemSettings();
        }).catch(function (err) {
          toast("导入失败：" + err.message);
          ok.disabled = false;
          ok.textContent = "确认导入";
        });
      };
    };
    reader.readAsText(file, "utf-8");
  }

  /* ------------------------------------------------------------ 总览 · 隧道 */

  function setEmptyState(id, title, sub, actionHtml) {
    var el = $(id);
    el.hidden = false;
    el.innerHTML =
      '<div class="empty-art" aria-hidden="true">' +
        '<svg viewBox="0 0 180 96" fill="none">' +
          '<path class="art-base" d="M8 84h164"/>' +
          '<path class="art-arch" d="M44 84V55c0-18 14-32 32-32h28c18 0 32 14 32 32v29"/>' +
          '<path class="art-inner" d="M62 84V57c0-10 8-18 18-18h20c10 0 18 8 18 18v27"/>' +
          '<path class="art-route" d="M10 68h48M122 68h48"/>' +
          '<path class="art-dash" d="M58 68h64"/>' +
          '<circle class="art-ring" cx="90" cy="68" r="9"/>' +
          '<circle class="art-dot" cx="90" cy="68" r="3.4"/>' +
        '</svg>' +
      '</div>' +
      '<div class="empty-t">' + esc(title) + '</div>' +
      '<div class="empty-s">' + esc(sub) + '</div>' +
      (actionHtml || "");
  }

  function skeletonList(rows) {
    var items = "";
    for (var i = 0; i < (rows || 3); i++) {
      items += '<div class="skeleton-row" aria-hidden="true">' +
        '<div class="skeleton-main"><span class="sk-line sk-title"></span><span class="sk-line sk-sub"></span></div>' +
        '<span class="sk-pill"></span></div>';
    }
    return '<div class="skeleton-list" role="status" aria-label="加载中">' + items + '</div>';
  }

  function refreshTunnels(silent) {
    var list = $("tunnelsList"), notice = $("tunnelsNotice");
    notice.hidden = true;
    $("tunnelsEmpty").hidden = true;
    if (!silent || !list.children.length) list.innerHTML = skeletonList(3);
    api("GET", "/tunnels").then(function (t) {
      list.innerHTML = "";
      setupState.cf = !!t.configured;
      renderSetupProgress();
      if (!t.configured) {
        ovStats.tunnels = { total: 0, local: 0, configured: false };
        updateOverviewStats();
        updateIngressGate(null);
        setEmptyState("tunnelsEmpty", "尚未配置 Cloudflare 凭据",
          "先在上方「01 Cloudflare 凭据」填入 Account ID 与 API Token。");
        return;
      }
      if (!t.ok) {
        ovStats.tunnels = { error: true };
        updateOverviewStats();
        // 云端列表偶发失败时不要把还能用的连接器状态一起清掉
        if (!overviewTunnel) updateIngressGate(null);
        notice.hidden = false;
        notice.innerHTML = '<span class="notice-ico">!</span><span>获取隧道列表失败：' + esc(t.error || "未知错误") +
          '。请检查 Token 权限后重新保存凭据。</span>';
        return;
      }
      renderTunnels(t.tunnels || []);
    }).catch(function (err) {
      if (!silent) list.innerHTML = "";
      ovStats.tunnels = { error: true };
      updateOverviewStats();
      if (!overviewTunnel) updateIngressGate(null);
      notice.hidden = false;
      notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(err.message || "加载失败") + '</span>';
    });
  }
  function renderTunnels(tunnels) {
    var list = $("tunnelsList");
    ovStats.tunnels = {
      total: tunnels.length,
      local: tunnels.filter(function (t) { return t.local_running; }).length,
      configured: true,
    };
    updateOverviewStats();
    if (!tunnels.length) {
      list.innerHTML = "";
      updateIngressGate(null);
      setEmptyState("tunnelsEmpty", "还没有隧道",
        "在上方输入名称创建第一条命名隧道。");
      return;
    }
    $("tunnelsEmpty").hidden = true;
    var running = null, pendingName = "";
    list.innerHTML = tunnels.map(function (t) {
      var cloudActive = t.status === "active";
      var localRunning = !!t.local_running;
      var conns = Array.isArray(t.connections) ? t.connections.length : (t.connections || 0);
      if (localRunning && cloudActive) running = t;
      else if (localRunning && !pendingName) pendingName = t.name;
      var date = (t.created_at || "").slice(0, 10) || "—";
      var statusLabel, statusCls;
      if (localRunning && cloudActive) { statusLabel = "已连接"; statusCls = "badge-ok"; }
      else if (localRunning) { statusLabel = "连接中 · 云端未确认"; statusCls = "badge-warn"; }
      else if (cloudActive) { statusLabel = "云端在线 · 本地未运行"; statusCls = "badge-muted"; }
      else { statusLabel = "未连接"; statusCls = "badge-muted"; }
      return '<div class="tunnel-item' + (localRunning ? " is-connected" : "") +
          '" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">' +
        '<div class="tunnel-main">' +
          '<div class="tunnel-name">' + esc(t.name) +
            ' <span class="badge ' + statusCls + '">' + statusLabel + '</span></div>' +
          '<div class="tunnel-meta"><code class="kv">' + esc(t.id) + '</code>' +
            '<span>创建于 ' + esc(date) + '</span>' +
            (conns ? '<span>活跃连接 ' + conns + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="tunnel-actions">' +
          (localRunning
            ? '<button class="btn btn-danger-ghost btn-sm" type="button" data-act="disconnect">断开</button>'
            : '<button class="btn btn-connect btn-sm" type="button" data-act="connect">连接</button>') +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="token">令牌</button>' +
          '<button class="btn btn-danger-ghost btn-sm" type="button" data-act="del">删除</button>' +
        '</div>' +
      '</div>';
    }).join("");
    updateIngressGate(running, pendingName);
  }
  function connectTunnel(id, name, btn) {
    btn.disabled = true;
    btn.textContent = "连接中…";
    updateIngressGate(null, name);
    api("POST", "/connector/start", { tunnel_id: id }).then(function () {
      var tries = 0;
      (function poll() {
        tries++;
        api("GET", "/tunnels").then(function (r) {
          var t = (r.tunnels || []).filter(function (x) { return x.id === id; })[0];
          var conns = t ? (Array.isArray(t.connections) ? t.connections.length : (Number(t.connections) || 0)) : 0;
          if (t && t.local_running && conns > 0) {
            toast("隧道「" + name + "」已连接");
            refreshTunnels(true);
            refreshLiveChip();
            refreshIngresses(true);
            return;
          }
          if (tries >= 12) {
            toast(t && t.local_running
              ? "连接器已启动，云端还在确认，请稍后刷新"
              : "连接器已启动，但未检测到云端连接");
            refreshTunnels(true);
            refreshLiveChip();
            return;
          }
          setTimeout(poll, 1000);
        }).catch(function () {
          if (tries >= 12) {
            toast("连接器已启动，状态确认超时，请稍后刷新");
            refreshTunnels(true);
            return;
          }
          setTimeout(poll, 1000);
        });
      })();
    }).catch(function (err) {
      toast("连接失败：" + err.message);
      refreshTunnels(true);
    });
  }
  function disconnectTunnel(btn) {
    btn.disabled = true;
    btn.textContent = "断开中…";
    api("POST", "/connector/stop", {}).then(function () {
      toast("已断开连接");
      refreshTunnels(true);
      refreshLiveChip();
      refreshIngresses(true);
    }).catch(function (err) {
      toast("断开失败：" + err.message);
      btn.disabled = false;
      btn.textContent = "断开";
    });
  }
  function openTokenDetail(item, id) {
    var box = toggleDetail(item, "token",
      '<div class="row-detail-note">这是 cloudflared 连接该隧道的凭据，相当于密码。其他机器上用 ' +
        '<code class="kv">cloudflared tunnel run --token &lt;令牌&gt;</code> 即可接入，请勿提交到公开仓库。</div>' +
      '<div class="token-box">读取中…</div>' +
      '<div class="btn-row" style="margin-top:var(--space-4)">' +
        '<button class="btn btn-primary btn-sm btn-auto" type="button" data-act="copy-token">复制令牌</button>' +
        '<button class="btn btn-ghost btn-sm btn-auto" type="button" data-act="detail-close">收起</button>' +
      '</div>');
    if (!box) return;
    api("GET", "/tunnels/" + encodeURIComponent(id) + "/token").then(function (res) {
      var token = res.token || "";
      item.setAttribute("data-token", token);
      box.querySelector(".token-box").textContent = token || "（云端没有返回令牌）";
    }).catch(function (err) {
      box.querySelector(".token-box").textContent = "读取失败：" + err.message;
    });
  }

  function openDeleteDetail(item, id, name) {
    var box = toggleDetail(item, "del",
      '<p class="row-detail-note">确定删除隧道 <b>' + esc(name) + '</b> 吗？此操作不可恢复；' +
        '若该隧道仍有活跃连接（cloudflared 正在运行），Cloudflare 会拒绝删除，请先停止连接器。</p>' +
      '<div class="btn-row">' +
        '<button class="btn btn-danger btn-sm btn-auto" type="button" data-act="del-yes">确认删除</button>' +
        '<button class="btn btn-ghost btn-sm btn-auto" type="button" data-act="detail-close">取消</button>' +
      '</div>');
    if (!box) return;
    box.querySelector('[data-act="del-yes"]').onclick = function () {
      var ok = this;
      ok.disabled = true;
      ok.textContent = "删除中…";
      api("DELETE", "/tunnels/" + encodeURIComponent(id)).then(function () {
        toast("隧道「" + name + "」已删除");
        item.remove();
        if (!$("tunnelsList").children.length) renderTunnels([]);
        refreshTunnels(true);
      }).catch(function (err) {
        actionFailed("删除", err, function () { refreshTunnels(true); });
        ok.disabled = false;
        ok.textContent = "确认删除";
      });
    };
  }

  function onTunnelsClick(ev) {
    var btn = ev.target.closest("[data-act]");
    if (!btn) return;
    var item = btn.closest(".tunnel-item");
    if (!item) return;
    var id = item.getAttribute("data-id");
    var name = item.getAttribute("data-name");
    var act = btn.getAttribute("data-act");
    if (act === "token") openTokenDetail(item, id);
    else if (act === "del") openDeleteDetail(item, id, name);
    else if (act === "detail-close") collapseDetail(item);
    else if (act === "copy-token") copyText(item.getAttribute("data-token") || "");
    else if (act === "connect") connectTunnel(id, name, btn);
    else if (act === "disconnect") disconnectTunnel(btn);
  }

  function newTunnel() {
    var name = $("mTunnelName").value.trim().toLowerCase();
    if (!name) { toast("请先填写隧道名称"); $("mTunnelName").focus(); return; }
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
      toast("名称需为小写字母 / 数字 / 连字符，1-63 位");
      return;
    }
    var btn = $("mTunnelOk");
    btn.disabled = true;
    btn.textContent = "创建中…";
    api("POST", "/tunnels", { name: name }).then(function () {
      $("mTunnelName").value = "";
      toast("隧道「" + name + "」已创建，点「连接」启动它");
      refreshTunnels(true);
    }).catch(function (err) {
      actionFailed("创建", err, function () { refreshTunnels(true); });
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "创建隧道";
    });
  }
  /* ------------------------------------------------------------ DNS 页 */

  function fillDnsZoneSelect(zones, primaryZone) {
    var sel = $("dnsZoneSelect");
    if (!sel) return;
    if (!zones.length) {
      sel.innerHTML = '<option value="">暂无 Zone</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    var hasPrimary = zones.some(function (z) { return z.id === primaryZone; });
    sel.innerHTML = zones.map(function (z) {
      return '<option value="' + esc(z.id) + '">' + esc(z.name) + '</option>';
    }).join("");
    if (hasPrimary) sel.value = primaryZone;
  }

  function renderZones(zones, primaryZone) {
    var list = $("zonesList");
    fillDnsZoneSelect(zones, primaryZone);
    if (!zones.length) {
      list.innerHTML = "";
      setEmptyState("zonesEmpty", "未找到域名", "当前 Token 可见的账号下没有 Zone。");
      return;
    }
    $("zonesEmpty").hidden = true;
    list.innerHTML = zones.map(function (z) {
      var isPrimary = z.id === primaryZone;
      return '<div class="zone-item' + (isPrimary ? " zone-primary" : "") + '" data-id="' + esc(z.id) + '" data-name="' + esc(z.name) + '">' +
        '<div class="zone-main">' +
          '<div class="zone-name">' + esc(z.name) + (isPrimary ? ' <span class="zone-badge">当前 Zone</span>' : "") + '</div>' +
          '<div class="zone-meta">' +
            '<span class="badge ' + (z.status === "active" ? "badge-ok" : "badge-muted") + '">' +
              (z.status === "active" ? "已激活" : esc(z.status || "未激活")) + '</span>' +
            '<span>' + (z.type === "partial" ? "部分 Zone" : "完整 Zone") + '</span>' +
          '</div>' +
        '</div>' +
        '<button class="btn btn-ghost btn-sm zone-set-btn" type="button" ' + (isPrimary ? 'disabled' : "") + '>' +
          (isPrimary ? "已选择" : "设为当前") + '</button>' +
      '</div>';
    }).join("");
  }

  function refreshZones() {
    var list = $("zonesList"), notice = $("zonesNotice");
    notice.hidden = true;
    $("zonesEmpty").hidden = true;
    // 已经有缓存就先渲染，切到 DNS 页时不再先闪一行「加载中…」
    if (zonesCache.length) renderZones(zonesCache, currentPrimaryZone);
    else list.innerHTML = '<div class="list-loading">加载中…</div>';
    api("GET", "/cloudflare/zones").then(function (z) {
      list.innerHTML = "";
      if (!z.configured) {
        fillDnsZoneSelect([], "");
        setEmptyState("zonesEmpty", "尚未配置 Cloudflare 凭据",
          "请先到「总览」页填写 API Token 并保存");
        return;
      }
      if (!z.ok) {
        notice.hidden = false;
        notice.innerHTML = '<span class="notice-ico">!</span><span>获取域名列表失败：' + esc(z.error || "未知错误") +
          '。请检查 Token 是否包含「区域 → 区域 读取」权限。</span>';
        $("zonesEmpty").hidden = false;
        return;
      }
      zonesCache = z.zones || [];
      currentPrimaryZone = z.primary_zone || "";
      renderZones(zonesCache, currentPrimaryZone);
    }).catch(function (err) {
      list.innerHTML = "";
      notice.hidden = false;
      notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(err.message || "加载失败") + '</span>';
    });
  }

  // Zone 切换是全局动作：同步更新 Zone 卡片、下拉框，并刷新 DNS 记录
  function setPrimaryZone(zoneId, name) {
    var prev = currentPrimaryZone;
    currentPrimaryZone = zoneId;
    renderZones(zonesCache, zoneId);
    return api("POST", "/cloudflare/zones/primary", { zone_id: zoneId, name: name })
      .then(function () {
        toast("当前 Zone 已切换：" + name + "，正在刷新记录");
        dnsAllRecords = [];
        dnsManagedCount = 0;
        dnsTotal = 0;
        resetDnsFilters();
        refreshDnsRecords();
      })
      .catch(function (err) {
        currentPrimaryZone = prev;
        renderZones(zonesCache, prev);
        throw err;
      });
  }

  function onZonesClick(ev) {
    var btn = ev.target.closest(".zone-set-btn");
    if (!btn || btn.disabled) return;
    var item = btn.closest(".zone-item");
    var zoneId = item.getAttribute("data-id");
    var name = item.getAttribute("data-name");
    btn.disabled = true;
    btn.textContent = "保存中…";
    setPrimaryZone(zoneId, name)
      .catch(function (err) { toast("设置失败：" + err.message); })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "设为当前";
        if (zoneId === currentPrimaryZone) btn.textContent = "已选择";
      });
  }

  /* ------------------------------------------------------------ Ingress 规则 */

  function renderIngresses(ingresses) {
    var list = $("ingressList");
    if (!ingresses.length) {
      list.innerHTML = "";
      setEmptyState("ingressEmpty", "还没有 Ingress 规则",
        "点击上方「添加规则」，把子域名映射到 NAS 本地服务。");
      return;
    }
    $("ingressEmpty").hidden = true;
    list.innerHTML = ingresses.map(function (r) {
      var fullName = r.full_name || (r.subdomain + "." + r.zone_name);
      var flags = "";
      if (r.dns_missing) flags += '<span class="badge badge-warn">DNS 已缺失</span>';
      if (r.route_missing) flags += '<span class="badge badge-warn">路由未下发</span>';
      if (!r.dns_missing && !r.route_missing) flags += '<span class="badge badge-ok">已生效</span>';
      var cached = ingressProbeResults[r.id];
      var outcome = cached ? probeOutcome(cached, r.service) : null;
      return '<div class="ingress-item" data-id="' + esc(r.id) + '" data-sub="' + esc(r.subdomain) +
          '" data-zone="' + esc(r.zone_name) + '" data-full="' + esc(fullName) +
          '" data-tunnel="' + esc(r.tunnel_id) + '" data-tunnelname="' + esc(r.tunnel_name) +
          '" data-service="' + esc(r.service) + '">' +
        '<div class="ingress-main">' +
          '<div class="ingress-head">' +
            '<span class="ingress-host">' + esc(fullName) + '</span>' +
            '<span class="ingress-health">' + flags + '</span>' +
          '</div>' +
          '<div class="ingress-route">' +
            '<span class="ingress-arrow">→</span>' +
            '<code class="ingress-service">' + esc(r.service) + '</code>' +
          '</div>' +
          '<div class="ingress-meta">' +
            (r.tunnel_name ? '<span>隧道 <b>' + esc(r.tunnel_name) + '</b></span>' : '') +
            '<span>CNAME → <code>' + esc(r.cname_target) + '</code></span>' +
            (!r.route_missing && r.remote_service ? '<span>云端生效中 → <code>' + esc(r.remote_service) + '</code></span>' : '') +
          '</div>' +
          '<div class="probe-result ingress-probe' + (outcome ? " " + outcome.state : "") + '" data-probe' +
            (outcome ? '' : ' hidden') + '>' + (outcome ? outcome.html : '') + '</div>' +
        '</div>' +
        '<div class="ingress-actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="test">测试</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="edit">编辑</button>' +
          '<button class="btn btn-danger-ghost btn-sm" type="button" data-act="del">删除</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  var lastHealthSync = 0;

  function refreshIngresses(silent) {
    var list = $("ingressList"), notice = $("ingressNotice");
    lastHealthSync = Date.now();
    notice.hidden = true;
    $("ingressEmpty").hidden = true;
    if (!silent) {
      ingressProbeResults = {};
      $("ingressDiagnose").hidden = true;
    }
    if (!silent || !list.children.length) list.innerHTML = skeletonList(3);
    return api("GET", "/ingresses").then(function (r) {
      list.innerHTML = "";
      var ings = r.ingresses || [];
      setupState.rules = r.configured ? ings.length : 0;
      ovStats.rules = {
        total: r.configured ? ings.length : 0,
        bad: r.configured ? ings.filter(function (x) { return x.dns_missing || x.route_missing; }).length : 0,
        configured: !!r.configured,
      };
      updateOverviewStats();
      renderSetupProgress();
      if (!r.configured) {
        setEmptyState("ingressEmpty", "尚未配置 Cloudflare 凭据",
          "先在上方完成「01 Cloudflare 凭据」。");
        return r;
      }
      renderIngresses(ings);
      if (ings.length) focusPendingRule();
      return r;
    }).catch(function (err) {
      if (silent) return null;
      list.innerHTML = "";
      ovStats.rules = { error: true };
      updateOverviewStats();
      notice.hidden = false;
      notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(err.message || "加载失败") + '</span>';
      return null;
    });
  }

  function updateIngressProbeRow(id, result) {
    var target = null;
    document.querySelectorAll("#ingressList .ingress-item").forEach(function (el) {
      if (!target && el.getAttribute("data-id") === String(id)) target = el;
    });
    if (!target) return;
    paintProbe(target.querySelector("[data-probe]"), result, target.getAttribute("data-service"), "ingress-probe");
  }

  function renderDiagnoseSummary(results) {
    var el = $("ingressDiagnose");
    var ok = 0, bad = 0, skipped = 0;
    results.forEach(function (r) {
      if (r.reachable === true) ok++;
      else if (r.reachable === null || r.skipped) skipped++;
      else bad++;
    });
    el.innerHTML = '<span class="diag-lead">本地服务</span>' +
      '<span class="diag-pill is-ok">可达 ' + ok + '</span>' +
      (bad ? '<span class="diag-pill is-bad">不可达 ' + bad + '</span>' : '') +
      (skipped ? '<span class="diag-pill is-muted">跳过 ' + skipped + '</span>' : '') +
      '<span class="diag-note">DNS 与隧道路由状态见行内徽标</span>';
    el.hidden = false;
  }

  function diagnoseIngresses() {
    var btn = $("diagIngressBtn");
    btn.disabled = true;
    setBtn(btn, "pulse", "检查中…");
    refreshIngresses().then(function (data) {
      if (!data || !data.configured) { toast("尚未配置 Cloudflare 凭据"); return null; }
      if (!(data.ingresses || []).length) { toast("还没有访问规则可检查"); return null; }
      return api("POST", "/ingresses/probe-batch", {}).then(function (r) {
        var results = (r && r.results) || [];
        if (!results.length) { toast("没有可检查的规则"); return; }
        ingressProbeResults = {};
        results.forEach(function (item) {
          if (!item || item.id == null) return;
          ingressProbeResults[item.id] = item;
          updateIngressProbeRow(item.id, item);
        });
        renderDiagnoseSummary(results);
        var bad = results.filter(function (x) { return x.reachable !== true && !x.skipped; }).length;
        toast(bad ? "检查完成：" + bad + " 条本地服务不可达" : "检查完成：本地服务全部可达");
      });
    }).catch(function (err) {
      toast("检查失败：" + err.message);
    }).finally(function () {
      btn.disabled = false;
      setBtn(btn, "pulse", "全部检查");
    });
  }

  function probeIngressRow(item, btn) {
    var id = item.getAttribute("data-id");
    probeService(item.getAttribute("data-service"), btn, item.querySelector("[data-probe]"), "ingress-probe")
      .then(function (r) {
        if (r && id) ingressProbeResults[id] = r;
      });
  }

  function focusPendingRule() {
    if (!pendingRuleFocus) return;
    var target = null;
    document.querySelectorAll("#ingressList .ingress-item").forEach(function (el) {
      if (!target && el.getAttribute("data-id") === pendingRuleFocus) target = el;
    });
    pendingRuleFocus = "";
    if (!target) { toast("对应规则可能已被删除，请刷新列表"); return; }
    collapseDetail(target);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("is-highlight");
    setTimeout(function () { target.classList.remove("is-highlight"); }, 2400);
  }

  function refreshRuleHealth() {
    if (document.hidden || currentRoute() !== "overview") return;
    if (Date.now() - lastHealthSync < 30000) return;
    refreshIngresses(true);
  }

  function syncIngresses() {
    var btn = $("syncIngressBtn");
    btn.disabled = true;
    setBtn(btn, "refresh", "下发中…");
    api("POST", "/ingresses/sync", {}).then(function (r) {
      var bad = (r.results || []).filter(function (x) { return !x.ok; });
      if (!r.results || !r.results.length) {
        toast(r.message || "没有需要下发的规则");
      } else if (bad.length) {
        toast("有 " + bad.length + " 条隧道路由下发失败：" + bad[0].error);
      } else {
        toast("已把 " + r.results.length + " 条隧道的路由下发完成");
      }
      refreshIngresses(true);
    }).catch(function (err) {
      toast("下发失败：" + err.message);
    }).then(function () {
      btn.disabled = false;
      setBtn(btn, "refresh", "重新下发路由");
    });
  }

  function ingressZoneOptions() {
    return zonesCache.map(function (z) {
      return '<option value="' + esc(z.id) + '" data-name="' + esc(z.name) + '"' +
        (z.id === currentPrimaryZone ? ' selected' : '') + '>' + esc(z.name) + '</option>';
    }).join("");
  }

  function ingressTunnelOptions(tunnels, selectedId) {
    return tunnels.map(function (tu) {
      return '<option value="' + esc(tu.id) + '"' + (tu.id === selectedId ? ' selected' : '') + '>' +
        esc(tu.name) + '</option>';
    }).join("");
  }

  // 快速操作可能直接跳到「添加规则」，此时 Zone 还没拉过，先补一次
  function ensureZones() {
    if (zonesCache.length) return Promise.resolve(true);
    return api("GET", "/cloudflare/zones").then(function (z) {
      if (z.configured && z.ok) {
        zonesCache = z.zones || [];
        currentPrimaryZone = z.primary_zone || "";
        renderZones(zonesCache, currentPrimaryZone);
      }
      return zonesCache.length > 0;
    }).catch(function () { return false; });
  }

  function normalizeServiceInput(raw) {
    var v = String(raw || "").trim();
    if (/^[1-9][0-9]{0,4}$/.test(v)) return "http://127.0.0.1:" + v;
    if (/^[A-Za-z0-9._-]+:[0-9]{1,5}$/.test(v)) return "http://" + v;
    return v;
  }

  function probeOutcome(r, service) {
    if (!r || !r.ok) {
      return { state: "is-bad", html: svgIcon("x") + '<span>' + esc((r && r.error) || "检测失败") + '</span>' };
    }
    if (r.reachable === true) {
      return { state: "is-ok", html: svgIcon("check") + '<span>可连接 · ' + esc(r.target) +
        (r.latency_ms != null ? ' · ' + esc(r.latency_ms) + ' ms' : '') + '</span>' };
    }
    if (r.reachable === null || r.skipped) {
      return { state: "is-muted", html: svgIcon("warn") + '<span>已跳过 · ' + esc(r.error || "该地址无法用 TCP 探测") + '</span>' };
    }
    return { state: "is-bad", html: svgIcon("x") + '<span>连接失败 · ' + esc(r.target || service) +
      ' · ' + esc(r.error || "未知原因") + '</span>' };
  }

  function paintProbe(el, r, service, extraClass) {
    if (!el) return;
    var out = probeOutcome(r, service);
    el.hidden = false;
    el.className = "probe-result " + out.state + (extraClass ? " " + extraClass : "");
    el.innerHTML = out.html;
  }

  function probeService(raw, btn, resultEl, extraClass) {
    var service = normalizeServiceInput(raw);
    if (!serviceOk(service)) {
      toast("本地服务地址协议不受支持（http/https/tcp/tls/ssh/rdp/unix 等）");
      return Promise.resolve(null);
    }
    if (btn) { btn.disabled = true; setBtn(btn, null, "检测中…"); }
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.className = "probe-result is-pending" + (extraClass ? " " + extraClass : "");
      resultEl.textContent = "正在连接 " + service + " …";
    }
    return api("POST", "/ingresses/probe", { service: service }).then(function (r) {
      paintProbe(resultEl, r, service, extraClass);
      return r;
    }).catch(function (err) {
      if (resultEl) {
        resultEl.hidden = false;
        resultEl.className = "probe-result is-bad" + (extraClass ? " " + extraClass : "");
        resultEl.innerHTML = svgIcon("x") + '<span>检测失败：' + esc(err.message) + '</span>';
      }
      return null;
    }).finally(function () {
      if (btn) { btn.disabled = false; setBtn(btn, null, "测试"); }
    });
  }

  function fillIngressZones() {
    var sel = $("mIngZone");
    if (!sel) return;
    sel.innerHTML = ingressZoneOptions();
    if (!sel.innerHTML) {
      sel.innerHTML = '<option value="">账号下没有可用域名</option>';
    }
  }

  // 未连接隧道时规则区只展示锁定提示，连接成功后自动展开并拉取域名
  function updateIngressGate(tunnel, pendingName) {
    overviewTunnel = tunnel && tunnel.id ? { id: tunnel.id, name: tunnel.name } : null;
    var connected = !!overviewTunnel;
    var pill = $("ovConnState");
    if (pill) {
      pill.className = "conn-pill " + (connected ? "is-ok" : (pendingName ? "is-pending" : "is-idle"));
      pill.textContent = connected
        ? "已连接 · " + overviewTunnel.name
        : (pendingName ? "连接中 · " + pendingName : "未连接");
    }
    setupState.tunnel = overviewTunnel ? { id: overviewTunnel.id, name: overviewTunnel.name } : null;
    setupState.pendingTunnel = connected ? "" : (pendingName || "");
    renderSetupProgress();
    $("ingressLock").hidden = connected;
    $("ingressForm").hidden = !connected;
    if (connected) {
      $("ovRuleTunnel").textContent = overviewTunnel.name + "（" + overviewTunnel.id.slice(0, 8) + "…）";
      ensureZones().then(function (ok) { if (ok) fillIngressZones(); });
    }
  }

  // 连接器状态是本机接口，比 /tunnels 的云端往返快得多。
  // 开机时先用它把规则表单解锁，避免用户盯着「先连接隧道」以为连不上。
  function syncGateFromConnector(c) {
    if (!c || c.error) return;
    // 正在等云端确认时以 /tunnels 的口径为准，别让快速轮询把「连接中」改成「已连接」
    if (setupState.pendingTunnel) return;
    if (c.running && c.current_tunnel_id) {
      if (!overviewTunnel || overviewTunnel.id !== c.current_tunnel_id) {
        updateIngressGate({
          id: c.current_tunnel_id,
          name: c.current_tunnel_name || "当前隧道",
        });
      }
    } else if (!c.running && !setupState.pendingTunnel) {
      updateIngressGate(null);
    }
  }

  function addIngress() {
    if (!overviewTunnel) { toast("请先连接隧道"); return; }
    var subdomain = $("mIngSubdomain").value.trim().toLowerCase();
    // 留空表示根域名，与显式填写 @ 等价
    if (!subdomain) subdomain = "@";
    var service = normalizeServiceInput($("mIngService").value);
    var zoneSel = $("mIngZone");
    if (subdomain !== "@" && subdomain !== "*" && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
      toast("子域名格式不正确");
      return;
    }
    if (!zoneSel.value) { toast("请先选择目标域名"); return; }
    if (!serviceOk(service)) {
      toast("本地服务地址协议不受支持（http/https/tcp/tls/ssh/rdp/unix 等）");
      return;
    }
    var ok = $("mIngOk");
    ok.disabled = true;
    ok.textContent = "创建中…";
    api("POST", "/ingresses", {
      subdomain: subdomain,
      zone_id: zoneSel.value,
      zone_name: zoneSel.options[zoneSel.selectedIndex].getAttribute("data-name") || zoneSel.value,
      tunnel_id: overviewTunnel.id,
      tunnel_name: overviewTunnel.name,
      service: service,
    }).then(function (r) {
      $("mIngSubdomain").value = "";
      $("mIngService").value = "";
      $("mIngProbe").hidden = true;
      notifySync(r, "规则已创建");
      refreshIngresses(true);
    }).catch(function (err) {
      actionFailed("创建", err, function () { refreshIngresses(true); });
    }).finally(function () {
      ok.disabled = false;
      ok.textContent = "添加规则";
    });
  }
  function editIngress(item) {
    var id = item.getAttribute("data-id");
    var fullName = item.getAttribute("data-full");
    var currentTunnel = item.getAttribute("data-tunnel");
    var currentService = item.getAttribute("data-service");

    var box = toggleDetail(item, "edit",
      '<div class="form-grid">' +
        '<div class="field">' +
          '<label class="field-label">域名</label>' +
          '<input class="field-input" type="text" value="' + esc(fullName) + '" disabled>' +
          '<div class="form-hint">域名不可修改；如需更换请删除后重建。</div>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-label" for="mEditTunnel">目标隧道</label>' +
          '<select class="field-input" id="mEditTunnel"><option value="">读取隧道列表中…</option></select>' +
          '<div class="form-hint">更换隧道会同步更新 Cloudflare 的 CNAME 记录。</div>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-label" for="mEditService">本地服务地址</label>' +
          '<div class="input-probe">' +
            '<input class="field-input" id="mEditService" type="text" value="' + esc(currentService) + '" autocomplete="off">' +
            '<button class="btn btn-ghost btn-sm btn-auto" id="mEditProbe" type="button">测试</button>' +
          '</div>' +
          '<div class="form-hint">例如 http://127.0.0.1:8080 或 unix:/var/run/app.sock</div>' +
          '<div class="probe-result" id="mEditProbeResult" role="status" aria-live="polite" hidden></div>' +
        '</div>' +
      '</div>' +
      '<div class="btn-row">' +
        '<button class="btn btn-primary btn-sm btn-auto" type="button" id="mEditOk">保存</button>' +
        '<button class="btn btn-ghost btn-sm btn-auto" type="button" data-act="detail-close">取消</button>' +
      '</div>');
    if (!box) return;

    api("GET", "/tunnels").then(function (t) {
      var sel = $("mEditTunnel");
      if (!sel) return;
      sel.innerHTML = ingressTunnelOptions(t.tunnels || [], currentTunnel);
      sel.value = currentTunnel;
    }).catch(function (err) { toast("获取隧道列表失败：" + err.message); });

    $("mEditProbe").onclick = function () {
      probeService($("mEditService").value, this, $("mEditProbeResult"));
    };
    $("mEditService").addEventListener("input", function () { $("mEditProbeResult").hidden = true; });
    $("mEditService").focus();
    $("mEditOk").onclick = function () {
      var sel = $("mEditTunnel");
      var service = normalizeServiceInput($("mEditService").value);
      if (!serviceOk(service)) {
        toast("本地服务地址协议不受支持（http/https/tcp/tls/ssh/rdp/unix 等）");
        return;
      }
      var ok = this;
      ok.disabled = true;
      ok.textContent = "保存中…";
      api("POST", "/ingresses/" + encodeURIComponent(id), {
        service: service,
        tunnel_id: sel.value,
        tunnel_name: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "",
      }).then(function (r) {
        collapseDetail(item);
        notifySync(r, "规则已更新");
        refreshIngresses(true);
      }).catch(function (err) {
        actionFailed("更新", err, function () { refreshIngresses(true); });
        ok.disabled = false;
        ok.textContent = "保存";
      });
    };
  }

  function deleteIngress(item, id, fullName) {
    var box = toggleDetail(item, "del",
      '<p class="row-detail-note">确定删除 <b>' + esc(fullName) + '</b> 吗？' +
        '本地规则与 Cloudflare DNS 记录会一起删除，不可恢复；删除后会重新下发一次隧道路由。</p>' +
      '<div class="btn-row">' +
        '<button class="btn btn-danger btn-sm btn-auto" type="button" data-act="del-yes">确认删除</button>' +
        '<button class="btn btn-ghost btn-sm btn-auto" type="button" data-act="detail-close">取消</button>' +
      '</div>');
    if (!box) return;
    box.querySelector('[data-act="del-yes"]').onclick = function () {
      var ok = this;
      ok.disabled = true;
      ok.textContent = "删除中…";
      api("DELETE", "/ingresses/" + encodeURIComponent(id)).then(function (r) {
        collapseDetail(item);
        // 本地已经删掉，先把行拿掉再静默核对，别让「删除中…」陪着等云端
        item.remove();
        if (!$("ingressList").children.length) renderIngresses([]);
        notifySync(r, "已删除", "已删除，隧道路由已删除");
        refreshIngresses(true);
      }).catch(function (err) {
        actionFailed("删除", err, function () { refreshIngresses(true); });
        ok.disabled = false;
        ok.textContent = "确认删除";
      });
    };
  }

  function onIngressClick(ev) {
    var btn = ev.target.closest("[data-act]");
    if (!btn) return;
    var item = btn.closest(".ingress-item");
    if (!item) return;
    var act = btn.getAttribute("data-act");
    if (act === "detail-close") { collapseDetail(item); return; }
    var id = item.getAttribute("data-id");
    var fullName = item.getAttribute("data-full");
    if (act === "del") deleteIngress(item, id, fullName);
    else if (act === "edit") editIngress(item);
    else if (act === "test") probeIngressRow(item, btn);
  }

  /* ------------------------------------------------------------ Cloudflare DNS 记录 */

  function refreshDnsRecords() {
    var list = $("dnsRecordsList"), notice = $("dnsRecordsNotice");
    notice.hidden = true;
    $("dnsRecordsEmpty").hidden = true;
    // 已有数据时保留旧行，避免刷新/切 Zone 时整块闪空
    if (!dnsAllRecords.length) list.innerHTML = skeletonList(4);
    api("GET", "/cloudflare/dns-records").then(function (r) {
      if (!r.configured) {
        dnsAllRecords = [];
        dnsManagedCount = 0;
        dnsTotal = 0;
        list.innerHTML = "";
        $("dnsRecordsSummary").textContent = "请先在「总览」页配置 Token，并在上方选择一个 Zone";
        $("dnsRecordsEmpty").hidden = false;
        return;
      }
      if (!r.ok) {
        notice.hidden = false;
        notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(r.error || "获取失败") + '</span>';
        return;
      }
      renderDnsRecords(r.records || [], r.managed_count || 0, r.total || 0);
    }).catch(function (err) {
      notice.hidden = false;
      notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(err.message || "加载失败") + '</span>';
      // 「接口不存在」多半是容器还在跑旧代码，直接指向设置页的自检入口
      if (/接口不存在/.test(err.message || "")) {
        notice.innerHTML += '<span style="margin-left:auto;flex:none">容器可能还在跑旧代码，到「设置 → 诊断」跑一次版本自检。</span>';
      }
    });
  }

  /* 版本自检：确认服务端代码里是否真的注册了这些接口 */
  function runSelfCheck() {
    var btn = $("selfCheckBtn");
    btn.disabled = true;
    setBtn(btn, "check", "自检中…");
    var el = $("selfCheckReport");
    api("GET", "/system/selfcheck").then(function (r) {
      var rows = Object.keys(r.routes_present || {}).map(function (k) {
        return reportRow(!!r.routes_present[k], "接口 " + k);
      }).join("");
      var dt = new Date(r.server_mtime * 1000);
      el.innerHTML =
        reportRow(true, "代码指纹 " + r.code_sha + "（v" + r.version + "）") +
        reportRow(true, "server.py 修改时间 " + dt.toLocaleString()) +
        reportRow(true, "进程 PID " + r.pid) +
        rows +
        '<div class="report-row ' + (r.all_routes_ok ? "ok" : "bad") + '">' +
          '<span class="report-ico">' + svgIcon(r.all_routes_ok ? "check" : "x") + '</span><span>' +
          (r.all_routes_ok
            ? "代码是新的。若仍报「接口不存在」，请强制刷新浏览器缓存（Ctrl+Shift+R）。"
            : "代码缺少对应路由。请在安装目录执行 docker compose up -d --build --force-recreate。") +
          '</span></div>';
      el.hidden = false;
    }).catch(function (err) {
      toast("自检失败：" + err.message);
    }).finally(function () {
      btn.disabled = false;
      setBtn(btn, "check", "版本自检");
    });
  }

  function populateDnsTypeFilter() {
    var sel = $("dnsTypeFilter");
    if (!sel) return;
    var seen = {};
    dnsAllRecords.forEach(function (r) {
      if (r.type) seen[String(r.type).toUpperCase()] = true;
    });
    var types = Object.keys(seen).sort();
    if (dnsFilter.type && types.indexOf(dnsFilter.type) === -1) dnsFilter.type = "";
    sel.innerHTML = '<option value="">全部类型</option>' + types.map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
    }).join("");
    sel.value = dnsFilter.type;
  }

  function resetDnsFilters() {
    dnsFilter = { q: "", type: "", source: "all", proxy: "all" };
    if ($("dnsSearch")) $("dnsSearch").value = "";
    if ($("dnsTypeFilter")) $("dnsTypeFilter").value = "";
    if ($("dnsSourceFilter")) $("dnsSourceFilter").value = "all";
    if ($("dnsProxyFilter")) $("dnsProxyFilter").value = "all";
    renderDnsList();
  }

  function renderDnsList() {
    var list = $("dnsRecordsList");
    var q = dnsFilter.q.trim().toLowerCase();
    var filtered = dnsAllRecords.filter(function (r) {
      if (dnsFilter.source === "managed" && !r.managed) return false;
      if (dnsFilter.source === "manual" && r.managed) return false;
      if (dnsFilter.proxy === "proxied" && !r.proxied) return false;
      if (dnsFilter.proxy === "dns" && r.proxied) return false;
      if (dnsFilter.type && String(r.type).toUpperCase() !== dnsFilter.type) return false;
      if (q) {
        var hay = (r.name + " " + r.content + " " + r.type).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    var summary = "共 " + dnsTotal + " 条记录";
    if (dnsAllRecords.length) {
      summary += " · 显示 " + filtered.length + " 条";
      if (q || dnsFilter.type || dnsFilter.source !== "all" || dnsFilter.proxy !== "all") summary += "（已筛选）";
      summary += " · " + dnsManagedCount + " 条由面板维护";
    }
    $("dnsRecordsSummary").textContent = summary;

    if (!dnsAllRecords.length) {
      list.innerHTML = "";
      setEmptyState("dnsRecordsEmpty", "当前 Zone 还没有 DNS 记录",
        "添加访问规则后，面板会在这里生成对应的 CNAME 记录。");
      return;
    }

    if (!filtered.length) {
      list.innerHTML = "";
      setEmptyState("dnsRecordsEmpty", "没有匹配的记录",
        "换个关键词，或清空类型与来源筛选。",
        '<button class="btn btn-ghost btn-sm btn-auto" type="button" data-dns-reset>清空筛选</button>');
      var reset = $("dnsRecordsEmpty").querySelector("[data-dns-reset]");
      if (reset) reset.onclick = resetDnsFilters;
      return;
    }

    $("dnsRecordsEmpty").hidden = true;
    var shown = filtered.slice(0, DNS_RENDER_LIMIT);
    list.innerHTML = shown.map(function (r) {
      var tag = r.managed
        ? '<span class="badge badge-ok">面板维护</span>'
        : '<span class="badge badge-muted">手工记录</span>';
      return '<div class="dns-record' + (r.managed ? " dns-managed" : "") + '">' +
        '<div class="dns-main">' +
          '<div class="dns-name">' + esc(r.name) + ' ' + tag + '</div>' +
          '<div class="dns-meta"><code class="kv">' + esc(r.type) + '</code> → ' + esc(r.content) +
            (r.proxied ? " · 已代理" : " · 仅 DNS") + '</div>' +
        '</div>' +
        '<div class="dns-acts">' +
          (r.managed && r.rule_id
            ? '<button class="btn btn-ghost btn-sm btn-auto" type="button" data-rule="' + esc(r.rule_id) + '">查看规则</button>'
            : '') +
          '<button class="btn btn-ghost btn-sm btn-icon" type="button" data-copy="' + esc(r.content) +
            '" title="复制记录内容" aria-label="复制记录内容">' + svgIcon("copy") + '</button>' +
        '</div>' +
      '</div>';
    }).join("") + (filtered.length > DNS_RENDER_LIMIT
      ? '<div class="list-more">共 ' + filtered.length + ' 条匹配，仅显示前 ' + DNS_RENDER_LIMIT + ' 条；用搜索或筛选缩小范围。</div>'
      : "");
  }

  function renderDnsRecords(records, managedCount, total) {
    dnsAllRecords = records.slice();
    dnsManagedCount = managedCount;
    dnsTotal = total;
    populateDnsTypeFilter();
    renderDnsList();
  }

  function gotoRule(id) {
    pendingRuleFocus = String(id || "");
    if (!pendingRuleFocus) return;
    if (currentRoute() === "overview") {
      refreshIngresses().then(function () { focusPendingRule(); });
    } else {
      location.hash = "#/overview";
    }
  }

  function onDnsRecordsClick(ev) {
    var copyBtn = ev.target.closest("[data-copy]");
    if (copyBtn) { copyText(copyBtn.getAttribute("data-copy")); return; }
    var ruleBtn = ev.target.closest("[data-rule]");
    if (ruleBtn) gotoRule(ruleBtn.getAttribute("data-rule"));
  }

  /* ------------------------------------------------------------ 启动引导 */

  function boot() {
    $("loginForm").addEventListener("submit", onLoginSubmit);
    $("logoutBtn").addEventListener("click", logout);
    $("themeBtn").addEventListener("click", function () {
      var next = window.__kayCftunnleTheme.toggle();
      toast(next === "dark" ? "已切换到深色模式" : "已切换到浅色模式");
    });
    window.addEventListener("hashchange", applyRoute);

    // 总览：三步进度条跳转
    document.querySelectorAll(".setup-step").forEach(function (step) {
      step.addEventListener("click", function (ev) {
        ev.preventDefault();
        gotoSetupStep(step);
      });
    });
    renderSetupProgress();

    // 总览：凭据 / 隧道 / 规则
    $("saveCfBtn").addEventListener("click", saveCfSettings);
    $("cfTokenEye").addEventListener("click", function () {
      var inp = $("cfToken");
      var show = inp.type === "password";
      inp.type = show ? "text" : "password";
      var icons = this.querySelectorAll(".ico");
      if (icons.length === 2) {
        icons[0].hidden = show;
        icons[1].hidden = !show;
      }
      this.setAttribute("aria-label", show ? "隐藏令牌" : "显示令牌");
    });
    $("mTunnelOk").addEventListener("click", newTunnel);
    $("refreshTunnelsBtn").addEventListener("click", refreshTunnels);
    $("tunnelsList").addEventListener("click", onTunnelsClick);
    $("mIngOk").addEventListener("click", addIngress);
    $("mIngTest").addEventListener("click", function () {
      probeService($("mIngService").value, this, $("mIngProbe"));
    });
    $("mIngService").addEventListener("input", function () { $("mIngProbe").hidden = true; });
    $("syncIngressBtn").addEventListener("click", syncIngresses);
    $("diagIngressBtn").addEventListener("click", diagnoseIngresses);
    $("ingressList").addEventListener("click", onIngressClick);

    // 域名与 DNS 页
    $("fetchZonesBtn").addEventListener("click", refreshZones);
    $("zonesList").addEventListener("click", onZonesClick);
    $("refreshDnsRecordsBtn").addEventListener("click", refreshDnsRecords);
    $("selfCheckBtn").addEventListener("click", runSelfCheck);
    $("dnsSearch").addEventListener("input", function () {
      dnsFilter.q = this.value;
      renderDnsList();
    });
    $("dnsTypeFilter").addEventListener("change", function () {
      dnsFilter.type = this.value;
      renderDnsList();
    });
    $("dnsSourceFilter").addEventListener("change", function () {
      dnsFilter.source = this.value;
      renderDnsList();
    });
    $("dnsProxyFilter").addEventListener("change", function () {
      dnsFilter.proxy = this.value;
      renderDnsList();
    });
    $("dnsRecordsList").addEventListener("click", onDnsRecordsClick);
    $("dnsZoneSelect").addEventListener("change", function () {
      var sel = this;
      var zone = zonesCache.filter(function (z) { return z.id === sel.value; })[0];
      if (!zone) return;
      sel.disabled = true;
      setPrimaryZone(zone.id, zone.name)
        .catch(function (err) { toast("切换 Zone 失败：" + err.message); })
        .finally(function () { sel.disabled = false; });
    });

    // 连接器页
    $("refreshConnectorBtn").addEventListener("click", function () { refreshConnector(false); });
    $("startConnectorBtn").addEventListener("click", startConnector);
    $("stopConnectorBtn").addEventListener("click", stopConnector);
    $("restartConnectorBtn").addEventListener("click", restartConnector);
    $("saveDefaultTunnelBtn").addEventListener("click", saveDefaultTunnel);
    $("connDefaultTunnel").addEventListener("change", function () { connectorSelectDirty = true; });
    $("connAutoRefresh").addEventListener("change", function () {
      if (this.checked) refreshConnector(true);
    });
    $("clearConnectorLogsBtn").addEventListener("click", clearConnectorLogs);
    $("mClearLogsOk").addEventListener("click", confirmClearConnectorLogs);
    $("copyConnectorLogsBtn").addEventListener("click", function () { copyText(connectorLogRaw); });
    $("downloadConnectorLogsBtn").addEventListener("click", downloadConnectorLogs);
    $("refreshTimelineBtn").addEventListener("click", function () { refreshConnector(false); });
    $("connLogSearch").addEventListener("input", function () { renderConnectorLogView(true); });
    $("connLogLevel").addEventListener("change", function () { renderConnectorLogView(true); });
    $("connLogJumpBtn").addEventListener("click", jumpToRecentError);

    // 设置页
    $("licenseVerifyBtn").addEventListener("click", verifyLicenseNow);
    $("licenseCopyBtn").addEventListener("click", copyLicenseMachine);
    $("saveAccessBtn").addEventListener("click", saveAccessSetting);
    $("savePwBtn").addEventListener("click", savePassword);
    $("saveSysBtn").addEventListener("click", saveSystemSettings);
    $("exportConfigBtn").addEventListener("click", exportConfig);
    $("importConfigBtn").addEventListener("click", function () {
      $("importConfigFile").value = "";
      $("importConfigFile").click();
    });
    $("importConfigFile").addEventListener("change", function () {
      importConfigFile(this.files && this.files[0]);
    });

    // 页内表单：取消按钮收起对应面板
    document.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-form-close]");
      if (btn) closePanel(btn.getAttribute("data-form-close"));
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") collapseAll();
    });

    // 回到面板时静默复核规则健康，避免看到过期的「已生效」；30 秒内不重复拉取
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refreshRuleHealth();
    });
    window.addEventListener("focus", refreshRuleHealth);

    // 脚本出错时给可见反馈，避免“点了没反应”却无线索
    window.addEventListener("error", function (ev) {
      try { toast("页面脚本出错：" + (ev.message || "未知错误")); } catch (e) { /* 忽略 */ }
    });

    api("GET", "/auth/me").then(function (data) {
      $("userName").textContent = data.user.username;
      applyNoAuthUi(!!data.no_auth_run);
      if (data.license) renderLicenseStatus(data.license);
      enterPanel();
    }).catch(function () { /* 未登录：保持登录屏 */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
