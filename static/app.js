/* SPDX-License-Identifier: MIT · Copyright (c) 2026 EasonShu */
/* Kay-cftunnle 面板 · 前端逻辑
   顶部一级标签路由：overview / tunnels / dns(域名与规则) / connector / settings。
   交互一律在页内完成：新建走 .form-panel，行内展开走 .row-detail（令牌、编辑、删除确认）。
   约定：/api 业务错误一律 HTTP 200 + {ok:false,...}，协议/鉴权错误才用 4xx/5xx。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // 顶部一级标签：route → 标题，同时充当合法路由表
  var TAB_TITLES = {
    overview: "总览", tunnels: "隧道", dns: "域名与规则",
    connector: "连接器", settings: "设置",
  };

  // 是否已进入面板：区分「从未登录」与「会话过期」，避免未登录时被登出逻辑刷循环
  var panelEntered = false;
  // 顶栏状态灯轮询句柄
  var liveChipTimer = 0;

  // DNS / Ingress 缓存：refreshZones 拉取后供添加规则弹层使用
  var zonesCache = [];
  var currentPrimaryZone = "";

  /* ------------------------------------------------------------ API 封装 */

  function api(method, path, body) {
    var opts = { method: method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var req = fetch("/api" + path, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error) || ("请求失败 (" + res.status + ")");
          throw new Error(msg);
        }
        return data;
      });
    });
    // 15s 超时兜底：网络挂起时按钮不会永远转圈
    return Promise.race([req, new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error("请求超时（15 秒），请检查网络后重试")); }, 15000);
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

  // cloudflared 支持的回源协议，与后端 SERVICE_SCHEMES 保持一致
  var SERVICE_RE = /^(https?|tls|tcp|ssh|rdp|smb|smtp|mysql|postgresql|clickhouse|kafka|udp):\/\/|^unix:/;
  function serviceOk(s) { return SERVICE_RE.test(String(s || "").trim()); }

  // 规则写进本地库之后还要下发到隧道；下发失败时流量是不通的，必须让用户看见
  function notifySync(r, doneText) {
    if (r && r.synced === false) {
      toast(doneText + "，但隧道路由下发失败：" + (r.sync_error || "未知原因"));
      return;
    }
    toast(doneText + "，隧道路由已生效");
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
    ["tunnelForm", "ingressForm", "importConfirm"].forEach(closePanel);
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
      a.classList.toggle("active", a.getAttribute("data-route") === route);
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + route);
    });
    if (route === "overview") { refreshOverview(); loadSystemInfo(); }
    else if (route === "tunnels") refreshTunnels();
    else if (route === "dns") { refreshZones(); refreshIngresses(); refreshDnsRecords(); }
    else if (route === "connector") { refreshConnector(); loadSystemSettings(); }
    else if (route === "settings") { loadCfStatus(); loadSystemInfo(); }
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

  // 状态灯独立刷新：落在哪个标签页都要亮，不能只在总览页拉一次
  function refreshLiveChip() {
    api("GET", "/connector/status").then(function (c) {
      setLive(c.running ? "ok" : (c.binary_exists ? "idle" : "bad"),
        c.running ? "隧道已连接" : (c.binary_exists ? "连接器未运行" : "cloudflared 未安装"));
    }).catch(function () {
      setLive("bad", "状态获取失败");
    });
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
      $("cfNotice").hidden = !!me.cloudflare_configured;
      if (!me.cloudflare_configured) {
        $("statZone").textContent = "未配置";
        $("statTunnels").textContent = "–";
        $("statRules").textContent = "–";
        $("statConnector").textContent = "未启动";
        setLive("bad", "未配置凭据");
        renderLogs([]);
        return null;
      }
      $("statZone").textContent = "已配置";
      return Promise.all([
        api("GET", "/tunnels").then(function (t) {
          $("statTunnels").textContent = t.configured ? String(t.tunnels.length) : "–";
        }).catch(function () { $("statTunnels").textContent = "!"; }),
        api("GET", "/ingresses").then(function (r) {
          $("statRules").textContent = r.configured ? String((r.ingresses || []).length) : "–";
        }).catch(function () { $("statRules").textContent = "!"; }),
        api("GET", "/connector/status").then(function (c) {
          var label = c.running ? "运行中" : (c.binary_exists ? "已停止" : "未安装");
          $("statConnector").textContent = label;
          setLive(c.running ? "ok" : (c.binary_exists ? "idle" : "bad"),
            c.running ? "隧道已连接" : (c.binary_exists ? "连接器未运行" : "cloudflared 未安装"));
        }).catch(function () {
          $("statConnector").textContent = "!";
          setLive("bad", "状态获取失败");
        }),
      ]);
    })
      .then(function () {
        return api("GET", "/logs?limit=6").then(renderLogs).catch(function () {});
      })
      .catch(function () { if (panelEntered) logout(); });
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

  var connectorTunnelsCache = [];

  function refreshConnector() {
    var statusEl = $("connStatus");
    var binaryEl = $("connBinary");
    var protoEl = $("connProto");
    var pidEl = $("connPidUptime");
    var logsEl = $("connectorLogs");
    var select = $("connDefaultTunnel");

    // 并行拉取状态与隧道列表，用于默认隧道下拉
    Promise.all([
      api("GET", "/connector/status").catch(function (err) { return { error: err.message }; }),
      api("GET", "/tunnels").catch(function () { return { configured: false, tunnels: [] }; }),
    ]).then(function (results) {
      var c = results[0] || {};
      var t = results[1] || {};
      if (c.error) {
        statusEl.textContent = "获取失败";
        statusEl.className = "connector-value is-bad";
        logsEl.textContent = c.error;
        setLive("bad", "状态获取失败");
        return;
      }
      connectorTunnelsCache = (t.tunnels || []).filter(function (tu) { return tu.id && tu.name; });
      select.innerHTML = '<option value="">自动选择第一条隧道</option>' +
        connectorTunnelsCache.map(function (tu) {
          return '<option value="' + esc(tu.id) + '">' + esc(tu.name + "（" + tu.id.slice(0, 8) + "…）") + '</option>';
        }).join("");
      if (c.default_tunnel_id) select.value = c.default_tunnel_id;

      // 状态
      if (c.running) {
        statusEl.textContent = "运行中";
        statusEl.className = "connector-value is-ok";
      } else {
        statusEl.textContent = c.binary_exists ? "已停止" : "未安装";
        statusEl.className = "connector-value" + (c.binary_exists ? "" : " is-bad");
      }
      setLive(c.running ? "ok" : (c.binary_exists ? "idle" : "bad"),
        c.running ? "隧道已连接" : (c.binary_exists ? "连接器未运行" : "cloudflared 未安装"));
      binaryEl.textContent = c.binary_exists ? (c.binary_path || "已安装") : "未找到";
      var protoMap = { http2: "HTTP/2", quic: "QUIC" };
      var ipMap = { ipv4: "IPv4", ipv6: "IPv6" };
      protoEl.textContent = (protoMap[c.protocol] || (c.protocol || "").toUpperCase()) + " / " +
        (ipMap[c.ip_version] || (c.ip_version || "").toUpperCase());
      pidEl.textContent = (c.pid || "–") + " / " + formatDuration(c.uptime || 0);

      // 日志
      var hadLogs = (c.logs || []).length > 0;
      if (hadLogs) {
        logsEl.textContent = c.logs.join("\n");
      } else {
        logsEl.textContent = c.running ? "（暂无日志输出）" : "（进程未运行）";
      }
      // 自动滚动到底部
      if ($("connAutoScroll").checked && logsEl.scrollHeight > logsEl.clientHeight) {
        logsEl.scrollTop = logsEl.scrollHeight;
      }

      // 按钮可用性
      $("startConnectorBtn").disabled = c.running;
      $("stopConnectorBtn").disabled = !c.running;
      $("restartConnectorBtn").disabled = !c.binary_exists;

      renderWatchdog(c.watchdog || {});
    });
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
    btn.disabled = true;
    btn.textContent = "启动中…";
    api("POST", "/connector/start", {}).then(function (res) {
      toast("连接器已启动，PID " + (res.pid || "–"));
      refreshConnector();
    }).catch(function (err) {
      toast("启动失败：" + err.message);
      btn.disabled = false;
      btn.textContent = "▶ 启动";
    });
  }

  function stopConnector() {
    var btn = $("stopConnectorBtn");
    btn.disabled = true;
    btn.textContent = "停止中…";
    api("POST", "/connector/stop", {}).then(function () {
      toast("连接器已停止");
      refreshConnector();
    }).catch(function (err) {
      toast("停止失败：" + err.message);
    }).finally(function () { btn.disabled = false; btn.textContent = "⏹ 停止"; });
  }

  function restartConnector() {
    var btn = $("restartConnectorBtn");
    btn.disabled = true;
    btn.textContent = "重启中…";
    api("POST", "/connector/restart", {}).then(function () {
      toast("连接器已重启");
      refreshConnector();
    }).catch(function (err) {
      toast("重启失败：" + err.message);
    }).finally(function () { btn.disabled = false; btn.textContent = "↻ 重启"; });
  }

  function saveDefaultTunnel() {
    var btn = $("saveDefaultTunnelBtn");
    var tunnelId = $("connDefaultTunnel").value;
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("POST", "/connector/default", { tunnel_id: tunnelId }).then(function () {
      toast("默认隧道已保存");
      refreshConnector();
    }).catch(function (err) {
      toast("保存失败：" + err.message);
    }).finally(function () { btn.disabled = false; btn.textContent = "保存默认隧道"; });
  }

  function clearConnectorLogs() {
    var btn = $("clearConnectorLogsBtn");
    btn.disabled = true;
    btn.textContent = "清空中…";
    api("POST", "/connector/clear-logs", {}).then(function () {
      toast("日志已清空");
      $("connectorLogs").textContent = "（日志已清空）";
    }).catch(function (err) {
      toast("清空失败：" + err.message);
    }).finally(function () { btn.disabled = false; btn.textContent = "清空日志"; });
  }

  /* ------------------------------------------------------------ 设置页 */

  function loadCfStatus() {
    api("GET", "/cloudflare/status").then(function (s) {
      $("cfToken").value = "";
      $("cfToken").placeholder = s.configured
        ? "已保存（" + s.token_masked + "），留空表示不修改"
        : "粘贴 API Token";
      $("cfTokenMasked").textContent = s.configured ? ("当前 Token：" + s.token_masked) : "";
      $("cfAccount").value = s.account_id || "";
      loadSystemSettings();
    }).catch(function () { /* 保持表单原状 */ });
  }

  function loadSystemSettings() {
    api("GET", "/system/settings").then(function (s) {
      var c = s.connector || {};
      $("sysAutoConnect").checked = !!c.auto_connect;
      $("sysProtocol").value = c.protocol || "http2";
      $("sysIPVersion").value = c.ip_version || "ipv4";
      $("sysWatchdog").checked = c.watchdog !== false;
    }).catch(function () { /* 保留下拉默认项 */ });
  }

  function loadSystemInfo() {
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
      // 设置页
      $("sysPidSettings").textContent = (s.pid || "–") + " / Python " + (s.python_version || "–");
      // 总览页
      $("sysVersion").textContent = version;
      $("sysUptime").textContent = uptime;
      $("sysDataDir").textContent = dataDir;
      $("sysCfVersion").textContent = cfVersion;
      $("sysCurrentTunnel").innerHTML = tunnelText;
      // 设置页
      $("sysVersionSettings").textContent = version;
      $("sysUptimeSettings").textContent = uptime;
      $("sysDataDirSettings").textContent = dataDir;
      $("sysCfVersionSettings").textContent = cfVersion;
      $("sysCurrentTunnelSettings").innerHTML = tunnelText;
    }).catch(function () { /* 保持默认占位符 */ });
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
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("POST", "/cloudflare/settings", {
      api_token: $("cfToken").value.trim(),
      account_id: $("cfAccount").value.trim(),
    }).then(function (s) {
      toast("已保存");
      $("cfToken").value = "";
      $("cfToken").placeholder = s.configured
        ? "已保存（" + s.token_masked + "），留空表示不修改"
        : "粘贴 API Token";
      $("cfTokenMasked").textContent = s.configured ? ("当前 Token：" + s.token_masked) : "";
    }).catch(function (err) { toast("保存失败：" + err.message); })
      .finally(function () { btn.disabled = false; btn.textContent = "保存配置"; });
  }

  // 改密会吊销全部会话，成功后必须回到登录屏
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
    var ico = type === true ? "✅" : type === false ? "❌" : "⚠️";
    return '<div class="report-row ' + cls + '">' +
      '<span class="report-ico">' + ico + '</span><span>' + esc(text) + '</span></div>';
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

  function verifyCf() {
    var btn = $("verifyCfBtn");
    btn.disabled = true;
    btn.textContent = "验证中…";
    api("POST", "/cloudflare/verify", {
      api_token: $("cfToken").value.trim(),
      account_id: $("cfAccount").value.trim(),
    }).then(function (res) {
      renderReport(res.report || {});
      var r = res.report || {};
      if (r.account_id) { $("cfAccount").value = r.account_id; }
      toast(res.ok ? "测试通过" : "测试未通过，请查看下方报告");
    }).catch(function (err) { toast("测试请求失败：" + err.message); })
      .finally(function () { btn.disabled = false; btn.textContent = "测试配置"; });
  }

  /* ------------------------------------------------------------ 配置备份 */

  function exportConfig() {
    var btn = $("exportConfigBtn");
    btn.disabled = true;
    btn.textContent = "导出中…";
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
    }).finally(function () { btn.disabled = false; btn.textContent = "导出配置"; });
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

  /* ------------------------------------------------------------ 隧道页 */

  function setEmptyState(id, title, sub, withSettingsLink) {
    var el = $(id);
    el.hidden = false;
    el.innerHTML =
      '<div class="empty-ring" aria-hidden="true"></div>' +
      '<div class="empty-t">' + esc(title) + '</div>' +
      '<div class="empty-s">' + esc(sub) + '</div>' +
      (withSettingsLink
        ? '<a class="btn btn-primary btn-auto" href="#/settings" style="margin-top:var(--space-4)">去设置页配置</a>'
        : "");
  }

  function refreshTunnels() {
    var list = $("tunnelsList"), notice = $("tunnelsNotice");
    notice.hidden = true;
    $("tunnelsEmpty").hidden = true;
    list.innerHTML = '<div class="list-loading">加载中…</div>';
    api("GET", "/tunnels").then(function (t) {
      list.innerHTML = "";
      if (!t.configured) {
        setEmptyState("tunnelsEmpty", "尚未配置 Cloudflare 凭据",
          "请先到设置页填写 API Token 并测试配置", true);
        return;
      }
      if (!t.ok) {
        notice.hidden = false;
        notice.innerHTML = '<span class="notice-ico">!</span><span>获取隧道列表失败：' + esc(t.error || "未知错误") +
          '。若刚修改凭据，请先到设置页做一次「测试配置」。</span>';
        return;
      }
      renderTunnels(t.tunnels || []);
    }).catch(function (err) {
      list.innerHTML = "";
      notice.hidden = false;
      notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(err.message || "加载失败") + '</span>';
    });
  }

  function renderTunnels(tunnels) {
    var list = $("tunnelsList");
    if (!tunnels.length) {
      list.innerHTML = "";
      setEmptyState("tunnelsEmpty", "还没有隧道",
        "点击上方「新建隧道」，在 Cloudflare 账号里创建第一条命名隧道。", false);
      return;
    }
    $("tunnelsEmpty").hidden = true;
    list.innerHTML = tunnels.map(function (t) {
      var cloudActive = t.status === "active";
      var localRunning = !!t.local_running;
      var date = (t.created_at || "").slice(0, 10) || "—";
      var statusLabel, statusCls;
      if (cloudActive && localRunning) { statusLabel = "已连接"; statusCls = "badge-ok"; }
      else if (cloudActive) { statusLabel = "本地未运行"; statusCls = "badge-warn"; }
      else { statusLabel = "未连接"; statusCls = "badge-muted"; }
      return '<div class="tunnel-item' + (localRunning ? " is-connected" : "") +
          '" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">' +
        '<div class="tunnel-main">' +
          '<div class="tunnel-name">' + esc(t.name) +
            ' <span class="badge ' + statusCls + '">' + statusLabel + '</span></div>' +
          '<div class="tunnel-meta"><code class="kv">' + esc(t.id) + '</code>' +
            '<span>创建于 ' + esc(date) + '</span>' +
            (cloudActive && t.connections ? '<span>活跃连接 ' + esc(t.connections) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="tunnel-actions">' +
          (localRunning
            ? '<button class="btn btn-danger-ghost btn-sm" type="button" data-act="disconnect">断开</button>'
            : '<button class="btn btn-primary btn-sm" type="button" data-act="connect">连接</button>') +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="token">令牌</button>' +
          '<button class="btn btn-danger-ghost btn-sm" type="button" data-act="del">删除</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  function connectTunnel(id, name, btn) {
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "连接中…";
    api("POST", "/connector/start", { tunnel_id: id }).then(function () {
      toast("已连接隧道「" + name + "」");
      refreshTunnels();
    }).catch(function (err) {
      toast("连接失败：" + err.message);
      btn.disabled = false;
      btn.textContent = old;
    });
  }

  function disconnectTunnel(btn) {
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "断开中…";
    api("POST", "/connector/stop", {}).then(function () {
      toast("已断开连接");
      refreshTunnels();
    }).catch(function (err) {
      toast("断开失败：" + err.message);
      btn.disabled = false;
      btn.textContent = old;
    });
  }

  // 令牌与删除确认都在行内展开，不再另开窗口
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
        refreshTunnels();
      }).catch(function (err) {
        toast("删除失败：" + err.message);
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
    api("GET", "/cloudflare/status").then(function (s) {
      if (!s.configured) {
        toast("请先配置 Cloudflare 凭据");
        location.hash = "#/settings";
        return;
      }
      $("mTunnelName").value = "";
      openPanel("tunnelForm", "mTunnelName");
      $("mTunnelOk").onclick = function () {
        var name = $("mTunnelName").value.trim().toLowerCase();
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
          toast("名称需为小写字母 / 数字 / 连字符，1-63 位");
          return;
        }
        var ok = this;
        ok.disabled = true;
        ok.textContent = "创建中…";
        api("POST", "/tunnels", { name: name }).then(function () {
          closePanel("tunnelForm");
          toast("隧道「" + name + "」已创建");
          refreshTunnels();
        }).catch(function (err) {
          toast("创建失败：" + err.message);
          ok.disabled = false;
          ok.textContent = "创建隧道";
        });
      };
    }).catch(function () { toast("状态获取失败"); });
  }

  /* ------------------------------------------------------------ DNS 页 */

  function renderZones(zones, primaryZone) {
    var list = $("zonesList");
    if (!zones.length) {
      list.innerHTML = "";
      setEmptyState("zonesEmpty", "未找到域名", "当前 Token 可见的账号下没有 Zone。", false);
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
    list.innerHTML = '<div class="list-loading">加载中…</div>';
    api("GET", "/cloudflare/zones").then(function (z) {
      list.innerHTML = "";
      if (!z.configured) {
        setEmptyState("zonesEmpty", "尚未配置 Cloudflare 凭据",
          "请先到设置页填写 API Token 并保存", true);
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

  function onZonesClick(ev) {
    var btn = ev.target.closest(".zone-set-btn");
    if (!btn || btn.disabled) return;
    var item = btn.closest(".zone-item");
    var zoneId = item.getAttribute("data-id");
    var name = item.getAttribute("data-name");
    btn.disabled = true;
    btn.textContent = "保存中…";
    api("POST", "/cloudflare/zones/primary", { zone_id: zoneId, name: name })
      .then(function () {
        toast("已设置当前 Zone：" + name);
        refreshZones();
      })
      .catch(function (err) {
        toast("设置失败：" + err.message);
        btn.disabled = false;
        btn.textContent = "设为当前";
      });
  }

  /* ------------------------------------------------------------ Ingress 规则 */

  function renderIngresses(ingresses) {
    var list = $("ingressList");
    if (!ingresses.length) {
      list.innerHTML = "";
      setEmptyState("ingressEmpty", "还没有 Ingress 规则",
        "点击上方「添加规则」，把子域名映射到 NAS 本地服务。", false);
      return;
    }
    $("ingressEmpty").hidden = true;
    list.innerHTML = ingresses.map(function (r) {
      var flags = "";
      if (r.dns_missing) flags += ' <span class="badge badge-warn">DNS 已缺失</span>';
      if (r.route_missing) flags += ' <span class="badge badge-warn">路由未下发</span>';
      if (!r.dns_missing && !r.route_missing) flags += ' <span class="badge badge-ok">已生效</span>';
      return '<div class="ingress-item" data-id="' + esc(r.id) + '" data-sub="' + esc(r.subdomain) +
          '" data-zone="' + esc(r.zone_name) + '" data-full="' + esc(r.full_name || (r.subdomain + "." + r.zone_name)) +
          '" data-tunnel="' + esc(r.tunnel_id) + '" data-tunnelname="' + esc(r.tunnel_name) +
          '" data-service="' + esc(r.service) + '">' +
        '<div class="ingress-main">' +
          '<div class="ingress-name"><code class="kv">' + esc(r.full_name || (r.subdomain + "." + r.zone_name)) +
            '</code> <span class="ingress-arrow">→</span> ' + esc(r.service) + flags + '</div>' +
          '<div class="ingress-meta">' +
            '<span>CNAME → ' + esc(r.cname_target) + '</span>' +
            (r.tunnel_name ? '<span>隧道 ' + esc(r.tunnel_name) + '</span>' : '') +
            (!r.route_missing && r.remote_service ? '<span>云端生效中 → ' + esc(r.remote_service) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="ingress-actions">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="edit">编辑</button>' +
          '<button class="btn btn-danger-ghost btn-sm" type="button" data-act="del">删除</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  function refreshIngresses() {
    var list = $("ingressList"), notice = $("ingressNotice");
    notice.hidden = true;
    $("ingressEmpty").hidden = true;
    list.innerHTML = '<div class="list-loading">加载中…</div>';
    api("GET", "/ingresses").then(function (r) {
      list.innerHTML = "";
      if (!r.configured) {
        setEmptyState("ingressEmpty", "尚未配置 Cloudflare 凭据",
          "请先到设置页填写 API Token 并保存", true);
        return;
      }
      renderIngresses(r.ingresses || []);
    }).catch(function (err) {
      list.innerHTML = "";
      notice.hidden = false;
      notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(err.message || "加载失败") + '</span>';
    });
  }

  function syncIngresses() {
    var btn = $("syncIngressBtn");
    btn.disabled = true;
    btn.textContent = "下发中…";
    api("POST", "/ingresses/sync", {}).then(function (r) {
      var bad = (r.results || []).filter(function (x) { return !x.ok; });
      if (!r.results || !r.results.length) {
        toast(r.message || "没有需要下发的规则");
      } else if (bad.length) {
        toast("有 " + bad.length + " 条隧道路由下发失败：" + bad[0].error);
      } else {
        toast("已把 " + r.results.length + " 条隧道的路由下发完成");
      }
      refreshIngresses();
    }).catch(function (err) {
      toast("下发失败：" + err.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = "↻ 重新下发路由";
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

  function newIngress() {
    ensureZones().then(function (hasZone) {
      if (!hasZone) {
        toast("当前账号下没有可用域名，请先到设置页确认 Token 权限");
        return;
      }
      return api("GET", "/tunnels").then(function (t) {
        if (!t.configured || !t.ok || !(t.tunnels || []).length) {
          toast("请先创建至少一条 Cloudflare 隧道");
          location.hash = "#/tunnels";
          return;
        }
        $("mIngZone").innerHTML = ingressZoneOptions();
        $("mIngTunnel").innerHTML = ingressTunnelOptions(t.tunnels, "");
        $("mIngSubdomain").value = "";
        $("mIngService").value = "";
        openPanel("ingressForm", "mIngSubdomain");
        $("mIngOk").onclick = function () {
        var zoneSel = $("mIngZone");
        var tunnelSel = $("mIngTunnel");
        var subdomain = $("mIngSubdomain").value.trim().toLowerCase();
        var service = $("mIngService").value.trim();
        if (subdomain !== "@" && subdomain !== "*" && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
          toast("子域名格式不正确");
          return;
        }
        if (!serviceOk(service)) {
          toast("本地服务地址协议不受支持（http/https/tcp/tls/ssh/rdp/unix 等）");
          return;
        }
        var ok = this;
        ok.disabled = true;
        ok.textContent = "创建中…";
        api("POST", "/ingresses", {
          subdomain: subdomain,
          zone_id: zoneSel.value,
          zone_name: zoneSel.options[zoneSel.selectedIndex].getAttribute("data-name") || zoneSel.value,
          tunnel_id: tunnelSel.value,
          tunnel_name: tunnelSel.options[tunnelSel.selectedIndex].textContent,
          service: service,
        }).then(function (r) {
          closePanel("ingressForm");
          notifySync(r, "规则已创建");
          refreshIngresses();
          refreshDnsRecords();
        }).catch(function (err) {
          toast("创建失败：" + err.message);
          ok.disabled = false;
          ok.textContent = "创建规则";
        });
        };
      }).catch(function (err) { toast("获取隧道列表失败：" + err.message); });
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
          '<input class="field-input" id="mEditService" type="text" value="' + esc(currentService) + '" autocomplete="off">' +
          '<div class="form-hint">例如 http://127.0.0.1:8080 或 unix:/var/run/app.sock</div>' +
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

    $("mEditService").focus();
    $("mEditOk").onclick = function () {
      var sel = $("mEditTunnel");
      var service = $("mEditService").value.trim();
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
        refreshIngresses();
        refreshDnsRecords();
      }).catch(function (err) {
        toast("更新失败：" + err.message);
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
        notifySync(r, "已删除");
        refreshIngresses();
        refreshDnsRecords();
      }).catch(function (err) {
        toast("删除失败：" + err.message);
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
  }

  /* ------------------------------------------------------------ Cloudflare DNS 记录 */

  function refreshDnsRecords() {
    var list = $("dnsRecordsList"), notice = $("dnsRecordsNotice");
    notice.hidden = true;
    $("dnsRecordsEmpty").hidden = true;
    list.innerHTML = '<div class="list-loading">加载中…</div>';
    api("GET", "/cloudflare/dns-records").then(function (r) {
      list.innerHTML = "";
      if (!r.configured) {
        $("dnsRecordsEmpty").hidden = false;
        $("dnsRecordsSummary").textContent = "请先在设置页配置 Token，并在上方选择一个 Zone";
        return;
      }
      if (!r.ok) {
        notice.hidden = false;
        notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(r.error || "获取失败") + '</span>';
        return;
      }
      renderDnsRecords(r.records || [], r.managed_count || 0, r.total || 0);
    }).catch(function (err) {
      list.innerHTML = "";
      notice.hidden = false;
      notice.innerHTML = '<span class="notice-ico">!</span><span>' + esc(err.message || "加载失败") + '</span>';
      // 「接口不存在」多半是容器还在跑旧代码，直接指向自检入口
      if (/接口不存在/.test(err.message || "")) {
        notice.innerHTML += '<span style="margin-left:auto;flex:none">容器可能还在跑旧代码，点上方「版本自检」确认。</span>';
      }
    });
  }

  /* 版本自检：确认服务端代码里是否真的注册了这些接口 */
  function runSelfCheck() {
    var btn = $("selfCheckBtn");
    btn.disabled = true;
    btn.textContent = "自检中…";
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
          '<span class="report-ico">' + (r.all_routes_ok ? "✅" : "❌") + '</span><span>' +
          (r.all_routes_ok
            ? "代码是新的。若仍报「接口不存在」，请强制刷新浏览器缓存（Ctrl+Shift+R）。"
            : "代码缺少对应路由。请在安装目录执行 docker compose up -d --build --force-recreate。") +
          '</span></div>';
      el.hidden = false;
    }).catch(function (err) {
      toast("自检失败：" + err.message);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "版本自检";
    });
  }

  function renderDnsRecords(records, managedCount, total) {
    var list = $("dnsRecordsList");
    $("dnsRecordsSummary").textContent =
      "共 " + total + " 条记录，其中 " + managedCount + " 条由 Kay-cftunnle 维护";
    if (!records.length) {
      list.innerHTML = "";
      $("dnsRecordsEmpty").hidden = false;
      return;
    }
    $("dnsRecordsEmpty").hidden = true;
    list.innerHTML = records.map(function (r) {
      var tag = r.managed
        ? '<span class="badge badge-ok">面板维护</span>'
        : '<span class="badge badge-muted">手工记录</span>';
      return '<div class="dns-record' + (r.managed ? " dns-managed" : "") + '">' +
        '<div class="dns-main">' +
          '<div class="dns-name">' + esc(r.name) + ' ' + tag + '</div>' +
          '<div class="dns-meta"><code class="kv">' + esc(r.type) + '</code> → ' + esc(r.content) +
            (r.proxied ? " · 已代理" : " · 仅 DNS") + '</div>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  /* ------------------------------------------------------------ 快速操作（总览页） */
  function onQuickAction(ev) {
    var btn = ev.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    if (action === "settings") {
      location.hash = "#/settings";
    } else if (action === "tunnel") {
      location.hash = "#/tunnels";
      setTimeout(newTunnel, 60);
    } else if (action === "connector") {
      location.hash = "#/connector";
      setTimeout(function () { startConnector(); }, 60);
    } else if (action === "ingress") {
      location.hash = "#/dns";
      setTimeout(newIngress, 60);
    }
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

    // 设置页
    $("saveCfBtn").addEventListener("click", saveCfSettings);
    $("verifyCfBtn").addEventListener("click", verifyCf);
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
    $("cfTokenEye").addEventListener("click", function () {
      var inp = $("cfToken");
      inp.type = inp.type === "password" ? "text" : "password";
    });

    // 隧道页
    $("newTunnelBtn").addEventListener("click", newTunnel);
    $("refreshTunnelsBtn").addEventListener("click", refreshTunnels);
    $("tunnelsList").addEventListener("click", onTunnelsClick);

    // 域名与规则页
    $("fetchZonesBtn").addEventListener("click", refreshZones);
    $("zonesList").addEventListener("click", onZonesClick);
    $("newIngressBtn").addEventListener("click", newIngress);
    $("syncIngressBtn").addEventListener("click", syncIngresses);
    $("ingressList").addEventListener("click", onIngressClick);
    $("refreshDnsRecordsBtn").addEventListener("click", refreshDnsRecords);
    $("selfCheckBtn").addEventListener("click", runSelfCheck);

    // 连接器页
    $("refreshConnectorBtn").addEventListener("click", refreshConnector);
    $("startConnectorBtn").addEventListener("click", startConnector);
    $("stopConnectorBtn").addEventListener("click", stopConnector);
    $("restartConnectorBtn").addEventListener("click", restartConnector);
    $("saveDefaultTunnelBtn").addEventListener("click", saveDefaultTunnel);
    $("clearConnectorLogsBtn").addEventListener("click", clearConnectorLogs);

    // 总览页快速操作
    $("quickActions").addEventListener("click", onQuickAction);

    // 页内表单：取消按钮收起对应面板
    document.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-form-close]");
      if (btn) closePanel(btn.getAttribute("data-form-close"));
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") collapseAll();
    });

    // 脚本出错时给可见反馈，避免“点了没反应”却无线索
    window.addEventListener("error", function (ev) {
      try { toast("页面脚本出错：" + (ev.message || "未知错误")); } catch (e) { /* 忽略 */ }
    });

    api("GET", "/auth/me").then(function (data) {
      $("userName").textContent = data.user.username;
      enterPanel();
    }).catch(function () { /* 未登录：保持登录屏 */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
