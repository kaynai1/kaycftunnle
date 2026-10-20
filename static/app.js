/* SPDX-License-Identifier: MIT · Copyright (c) 2026 EasonShu */
/* Kay-cftunnle 面板 · 前端逻辑
   M1：登录 / 会话 / 路由 / 视图切换 / 主题
   M2：设置页（Cloudflare 凭据 + 连通性验证 + 改密）、隧道页（列表/新建/删除/令牌）、
       总览统计与最近操作日志。
   约定：/api 业务错误一律 HTTP 200 + {ok:false,...}，协议/鉴权错误才用 4xx/5xx。 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

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

  /* ------------------------------------------------------------ 弹层 */

  function openModal(title, bodyHtml, footerHtml) {
    var root = $("modalRoot");
    root.innerHTML =
      '<div class="modal-card" role="dialog" aria-modal="true">' +
        '<div class="modal-head">' +
          '<span class="modal-title">' + esc(title) + '</span>' +
          '<button class="modal-x" type="button" data-close title="关闭">✕</button>' +
        '</div>' +
        '<div class="modal-body">' + bodyHtml + '</div>' +
        (footerHtml ? '<div class="modal-foot">' + footerHtml + '</div>' : '') +
      '</div>';
    root.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    var root = $("modalRoot");
    root.hidden = true;
    root.innerHTML = "";
    document.body.style.overflow = "";
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
    api("POST", "/auth/logout").catch(function () {}).then(function () {
      closeModal();
      $("shellView").hidden = true;
      $("loginView").style.display = "";
      location.hash = "";
    });
  }

  /* ------------------------------------------------------------ 面板框架 */

  var ROUTE_TITLES = {
    overview: "总览", tunnels: "隧道", dns: "DNS",
    connector: "连接器", settings: "设置",
  };

  // 是否已进入面板：区分「从未登录」与「会话过期」，避免未登录时被登出逻辑刷循环
  var panelEntered = false;

  function currentRoute() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    return ROUTE_TITLES[h] ? h : "overview";
  }

  function applyRoute() {
    var route = currentRoute();
    document.querySelectorAll(".side-link").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === route);
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + route);
    });
    $("topbarTitle").textContent = ROUTE_TITLES[route];
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
    applyRoute();
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
          $("statConnector").textContent = c.running ? "运行中" : (c.binary_exists ? "已停止" : "未安装");
        }).catch(function () { $("statConnector").textContent = "!"; }),
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
        statusEl.className = "connector-value connector-bad";
        logsEl.textContent = c.error;
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
        statusEl.textContent = "🟢 运行中";
        statusEl.className = "connector-value connector-ok";
      } else {
        statusEl.textContent = c.binary_exists ? "⚪ 已停止" : "🔴 未安装";
        statusEl.className = "connector-value " + (c.binary_exists ? "" : "connector-bad");
      }
      binaryEl.textContent = c.binary_exists ? (c.binary_path ? esc(c.binary_path) : "已安装") : "未找到";
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
      (w.enabled ? "🟢 已启用" : "⚪ 已关闭") + '</span></div>');
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
      var tunnelText = "–";
      if (conn.running && conn.current_tunnel_name) {
        tunnelText = "🟢 " + conn.current_tunnel_name;
      } else if (conn.running && conn.current_tunnel_id) {
        tunnelText = "🟢 " + conn.current_tunnel_id.slice(0, 8) + "…";
      } else {
        tunnelText = "⚪ 未运行";
      }
      // 设置页
      $("sysPidSettings").textContent = (s.pid || "–") + " / Python " + (s.python_version || "–");
      // 总览页
      $("sysVersion").textContent = version;
      $("sysUptime").textContent = uptime;
      $("sysDataDir").textContent = dataDir;
      $("sysCfVersion").textContent = cfVersion;
      $("sysCurrentTunnel").textContent = tunnelText;
      // 设置页
      $("sysVersionSettings").textContent = version;
      $("sysUptimeSettings").textContent = uptime;
      $("sysDataDirSettings").textContent = dataDir;
      $("sysCfVersionSettings").textContent = cfVersion;
      $("sysCurrentTunnelSettings").textContent = tunnelText;
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
      .finally(function () { btn.disabled = false; btn.textContent = "保存"; });
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
      openModal("导入配置",
        '<p style="margin:0 0 var(--space-2)">将用该配置覆盖当前的 <b>Cloudflare 凭据</b> 与 <b>连接器设置</b>。</p>' +
        '<p style="margin:0;color:var(--theme-muted);font-size:var(--text-sm);line-height:var(--leading-relaxed)">' +
          '账号：' + esc((parsed.cloudflare && parsed.cloudflare.account_id) || "未填写") + '<br>' +
          'Token：' + ((parsed.cloudflare && parsed.cloudflare.api_token) ? "已包含" : "未包含") + '<br>' +
          '默认隧道：' + esc((parsed.connector && parsed.connector.default_tunnel_id) || "未设置") +
        '</p>',
        '<button class="btn btn-ghost btn-auto" type="button" data-close>取消</button>' +
        '<button class="btn btn-primary btn-auto" type="button" id="mImportOk">确认导入</button>');
      $("mImportOk").addEventListener("click", function () {
        var ok = this;
        ok.disabled = true;
        ok.textContent = "导入中…";
        api("POST", "/system/backup", { backup: parsed }).then(function () {
          closeModal();
          toast("配置已导入");
          $("backupHint").textContent = "导入完成，配置已生效";
          loadCfStatus();
          loadSystemSettings();
        }).catch(function (err) {
          toast("导入失败：" + err.message);
          ok.disabled = false;
          ok.textContent = "确认导入";
        });
      });
    };
    reader.readAsText(file, "utf-8");
  }

  /* ------------------------------------------------------------ 隧道页 */

  function setTunnelsEmpty(ico, title, sub, withSettingsLink) {
    var el = $("tunnelsEmpty");
    el.hidden = false;
    el.innerHTML =
      '<div class="empty-ico">' + ico + '</div>' +
      '<div class="empty-t">' + esc(title) + '</div>' +
      '<div class="empty-s">' + esc(sub) + '</div>' +
      (withSettingsLink
        ? '<a class="btn btn-primary btn-auto" href="#/settings" style="margin-top:var(--space-4)">去设置</a>'
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
        setTunnelsEmpty("⚙️", "尚未配置 Cloudflare 凭据",
          "请先到「设置」页填写 API Token 并验证连通性", true);
        return;
      }
      if (!t.ok) {
        notice.hidden = false;
        notice.innerHTML = '<span>⚠️</span><span>获取隧道列表失败：' + esc(t.error || "未知错误") +
          '。若刚修改凭据，请先到设置页做一次「验证连通性」。</span>';
        return;
      }
      renderTunnels(t.tunnels || []);
    }).catch(function (err) {
      list.innerHTML = "";
      notice.hidden = false;
      notice.innerHTML = '<span>⚠️</span><span>' + esc(err.message || "加载失败") + '</span>';
    });
  }

  function renderTunnels(tunnels) {
    var list = $("tunnelsList");
    if (!tunnels.length) {
      list.innerHTML = "";
      setTunnelsEmpty("🚇", "还没有隧道", "点击右上角「新建隧道」创建第一条", false);
      return;
    }
    $("tunnelsEmpty").hidden = true;
    list.innerHTML = tunnels.map(function (t) {
      var cloudActive = t.status === "active";
      var localRunning = !!t.local_running;
      var date = (t.created_at || "").slice(0, 10) || "—";
      var statusLabel, statusCls, statusMeta;
      if (cloudActive && localRunning) {
        statusLabel = "已连接";
        statusCls = "badge-ok";
        statusMeta = "云端活跃 · 本地运行中";
      } else if (cloudActive) {
        statusLabel = "云端活跃";
        statusCls = "badge-warn";
        statusMeta = "云端活跃 · 本地未运行";
      } else {
        statusLabel = "未连接";
        statusCls = "badge-muted";
        statusMeta = "云端未连接";
      }
      return '<div class="tunnel-item" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">' +
        '<div class="tunnel-main">' +
          '<div class="tunnel-name">🚇 ' + esc(t.name) +
            ' <span class="badge ' + statusCls + '">' + statusLabel + '</span>' +
          '</div>' +
          '<div class="tunnel-meta"><code class="kv">' + esc(t.id) + '</code> · 创建于 ' + esc(date) +
            ' · ' + statusMeta +
            (cloudActive && t.connections ? " · 活跃连接 " + esc(t.connections) : "") + '</div>' +
        '</div>' +
        '<div class="tunnel-actions">' +
          (localRunning
            ? '<button class="btn btn-danger-ghost btn-sm" type="button" data-act="disconnect">断开</button>'
            : '<button class="btn btn-primary btn-sm" type="button" data-act="connect">连接</button>') +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="token">获取令牌</button>' +
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

  function onTunnelsClick(ev) {
    var btn = ev.target.closest("[data-act]");
    if (!btn) return;
    var item = btn.closest(".tunnel-item");
    if (!item) return;
    var id = item.getAttribute("data-id");
    var name = item.getAttribute("data-name");
    var act = btn.getAttribute("data-act");
    if (act === "token") showTunnelToken(id);
    else if (act === "connect") connectTunnel(id, name, btn);
    else if (act === "disconnect") disconnectTunnel(btn);
    else deleteTunnel(id, name);
  }

  function newTunnel() {
    api("GET", "/cloudflare/status").then(function (s) {
      if (!s.configured) {
        toast("请先配置 Cloudflare 凭据");
        location.hash = "#/settings";
        return;
      }
      openModal("新建隧道",
        '<div class="field">' +
          '<label class="field-label" for="mTunnelName">隧道名称</label>' +
          '<input class="field-input" id="mTunnelName" type="text" maxlength="63" ' +
            'placeholder="例如 my-nas" autocomplete="off">' +
          '<div class="form-hint">小写字母、数字与连字符，1-63 位；名称在账号内唯一。</div>' +
        '</div>',
        '<button class="btn btn-ghost btn-auto" type="button" data-close>取消</button>' +
        '<button class="btn btn-primary btn-auto" type="button" id="mTunnelOk">创建</button>');
      $("mTunnelName").focus();
      $("mTunnelOk").addEventListener("click", function () {
        var name = $("mTunnelName").value.trim();
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
          toast("名称需为小写字母 / 数字 / 连字符，1-63 位");
          return;
        }
        var ok = this;
        ok.disabled = true;
        ok.textContent = "创建中…";
        api("POST", "/tunnels", { name: name }).then(function () {
          closeModal();
          toast("隧道「" + name + "」已创建");
          refreshTunnels();
        }).catch(function (err) {
          toast("创建失败：" + err.message);
          ok.disabled = false;
          ok.textContent = "创建";
        });
      });
    }).catch(function () { toast("状态获取失败"); });
  }

  function deleteTunnel(id, name) {
    openModal("删除隧道",
      '<p style="margin:0 0 var(--space-2)">确定删除隧道 <b>' + esc(name) + '</b> 吗？</p>' +
      '<p style="margin:0;color:var(--theme-muted);font-size:var(--text-sm);line-height:var(--leading-relaxed)">' +
        '此操作不可恢复。若该隧道仍有活跃连接（cloudflared 正在运行），Cloudflare 会拒绝删除，请先停止连接器。' +
      '</p>',
      '<button class="btn btn-ghost btn-auto" type="button" data-close>取消</button>' +
      '<button class="btn btn-danger btn-auto" type="button" id="mDelOk">删除</button>');
    $("mDelOk").addEventListener("click", function () {
      var ok = this;
      ok.disabled = true;
      ok.textContent = "删除中…";
      api("DELETE", "/tunnels/" + encodeURIComponent(id)).then(function () {
        closeModal();
        toast("已删除");
        refreshTunnels();
      }).catch(function (err) {
        toast("删除失败：" + err.message);
        ok.disabled = false;
        ok.textContent = "删除";
      });
    });
  }

  function showTunnelToken(id) {
    api("GET", "/tunnels/" + encodeURIComponent(id) + "/token").then(function (res) {
      var token = res.token || "";
      openModal("隧道连接令牌",
        '<p style="margin:0 0 var(--space-3);font-size:var(--text-sm);color:var(--theme-muted);line-height:var(--leading-relaxed)">' +
          '此令牌是 cloudflared 连接该隧道的凭据（相当于密码），请妥善保存，不要提交到公开仓库。' +
        '</p>' +
        '<div class="token-box">' + esc(token) + '</div>',
        '<button class="btn btn-ghost btn-auto" type="button" data-close>关闭</button>' +
        '<button class="btn btn-primary btn-auto" type="button" id="mCopyTok">复制</button>');
      $("mCopyTok").addEventListener("click", function () { copyText(token); });
    }).catch(function (err) { toast("获取令牌失败：" + err.message); });
  }

  /* ------------------------------------------------------------ DNS 页 */

  function setZonesEmpty(ico, title, sub, withSettingsLink) {
    var el = $("zonesEmpty");
    el.hidden = false;
    el.innerHTML =
      '<div class="empty-ico">' + ico + '</div>' +
      '<div class="empty-t">' + esc(title) + '</div>' +
      '<div class="empty-s">' + esc(sub) + '</div>' +
      (withSettingsLink
        ? '<a class="btn btn-primary btn-auto" href="#/settings" style="margin-top:var(--space-4)">去设置</a>'
        : "");
  }

  function renderZones(zones, primaryZone) {
    var list = $("zonesList");
    if (!zones.length) {
      list.innerHTML = "";
      setZonesEmpty("🌐", "未找到域名", "当前 Token 可见账号下没有 Zone", false);
      return;
    }
    $("zonesEmpty").hidden = true;
    list.innerHTML = zones.map(function (z) {
      var isPrimary = z.id === primaryZone;
      return '<div class="zone-item' + (isPrimary ? " zone-primary" : "") + '" data-id="' + esc(z.id) + '" data-name="' + esc(z.name) + '">' +
        '<div class="zone-main">' +
          '<div class="zone-name">' + esc(z.name) + (isPrimary ? ' <span class="zone-badge">当前</span>' : "") + '</div>' +
          '<div class="zone-meta">' + (z.status === "active" ? "🟢 已激活" : "⚪ " + esc(z.status || "未激活")) +
            ' · ' + (z.type === "partial" ? "部分 Zone" : "完整 Zone") + '</div>' +
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
        setZonesEmpty("⚙️", "尚未配置 Cloudflare 凭据",
          "请先到「设置」页填写 API Token 并保存", true);
        return;
      }
      if (!z.ok) {
        notice.hidden = false;
        notice.innerHTML = '<span>⚠️</span><span>获取域名列表失败：' + esc(z.error || "未知错误") +
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
      notice.innerHTML = '<span>⚠️</span><span>' + esc(err.message || "加载失败") + '</span>';
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

  function setIngressesEmpty(ico, title, sub) {
    var el = $("ingressEmpty");
    el.hidden = false;
    el.innerHTML =
      '<div class="empty-ico">' + ico + '</div>' +
      '<div class="empty-t">' + esc(title) + '</div>' +
      '<div class="empty-s">' + esc(sub) + '</div>';
  }

  function renderIngresses(ingresses) {
    var list = $("ingressList");
    if (!ingresses.length) {
      list.innerHTML = "";
      setIngressesEmpty("🚧", "还没有 Ingress 规则",
        "点击右上角「添加规则」把子域名映射到 NAS 本地服务");
      return;
    }
    $("ingressEmpty").hidden = true;
    list.innerHTML = ingresses.map(function (r) {
      return '<div class="ingress-item" data-id="' + esc(r.id) + '" data-sub="' + esc(r.subdomain) +
          '" data-zone="' + esc(r.zone_name) + '" data-tunnel="' + esc(r.tunnel_id) +
          '" data-tunnelname="' + esc(r.tunnel_name) + '" data-service="' + esc(r.service) + '">' +
        '<div class="ingress-main">' +
          '<div class="ingress-name">🌐 ' + esc(r.subdomain) + '.' + esc(r.zone_name) +
            ' <span class="ingress-arrow">→</span> ' + esc(r.service) +
            (r.dns_missing ? ' <span class="badge badge-warn">DNS 已缺失</span>' : '') + '</div>' +
          '<div class="ingress-meta">CNAME ' + esc(r.cname_target) +
            (r.tunnel_name ? ' · 隧道 ' + esc(r.tunnel_name) : '') + '</div>' +
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
        setIngressesEmpty("⚙️", "尚未配置 Cloudflare 凭据",
          "请先到「设置」页填写 API Token 并保存");
        return;
      }
      renderIngresses(r.ingresses || []);
    }).catch(function (err) {
      list.innerHTML = "";
      notice.hidden = false;
      notice.innerHTML = '<span>⚠️</span><span>' + esc(err.message || "加载失败") + '</span>';
    });
  }

  function newIngress() {
    if (!zonesCache.length) {
      toast("请先获取域名列表");
      refreshZones();
      return;
    }
    api("GET", "/tunnels").then(function (t) {
      if (!t.configured || !t.ok || !(t.tunnels || []).length) {
        toast("请先创建至少一条 Cloudflare 隧道");
        location.hash = "#/tunnels";
        return;
      }
      var tunnels = t.tunnels;
      var zoneOptions = zonesCache.map(function (z) {
        return '<option value="' + esc(z.id) + '" data-name="' + esc(z.name) + '"' +
          (z.id === currentPrimaryZone ? ' selected' : '') + '>' + esc(z.name) + '</option>';
      }).join("");
      var tunnelOptions = tunnels.map(function (tu) {
        return '<option value="' + esc(tu.id) + '">' + esc(tu.name) + '</option>';
      }).join("");
      openModal("添加 Ingress 规则",
        '<div class="field">' +
          '<label class="field-label" for="mIngSubdomain">子域名前缀</label>' +
          '<input class="field-input" id="mIngSubdomain" type="text" placeholder="例如 nas" autocomplete="off">' +
          '<div class="form-hint">小写字母 / 数字 / 连字符，1-63 位。</div>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-label" for="mIngZone">目标 Zone</label>' +
          '<select class="field-input" id="mIngZone">' + zoneOptions + '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-label" for="mIngTunnel">目标隧道</label>' +
          '<select class="field-input" id="mIngTunnel">' + tunnelOptions + '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-label" for="mIngService">本地服务地址</label>' +
          '<input class="field-input" id="mIngService" type="text" ' +
            'placeholder="例如 http://127.0.0.1:8080 或 unix:/var/run/app.sock" autocomplete="off">' +
          '<div class="form-hint">保存后会自动把「子域名.Zone」CNAME 指向所选隧道。</div>' +
        '</div>',
        '<button class="btn btn-ghost btn-auto" type="button" data-close>取消</button>' +
        '<button class="btn btn-primary btn-auto" type="button" id="mIngOk">创建</button>');
      $("mIngSubdomain").focus();
      $("mIngOk").addEventListener("click", function () {
        var subdomain = $("mIngSubdomain").value.trim().toLowerCase();
        var zoneSel = $("mIngZone");
        var zoneId = zoneSel.value;
        var zoneName = zoneSel.options[zoneSel.selectedIndex].getAttribute("data-name") || zoneSel.value;
        var tunnelSel = $("mIngTunnel");
        var tunnelId = tunnelSel.value;
        var tunnelName = tunnelSel.options[tunnelSel.selectedIndex].textContent;
        var service = $("mIngService").value.trim();
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
          toast("子域名格式不正确");
          return;
        }
        if (!service.startsWith("http://") && !service.startsWith("https://") && !service.startsWith("unix:")) {
          toast("本地服务地址需以 http:// / https:// / unix: 开头");
          return;
        }
        var ok = this;
        ok.disabled = true;
        ok.textContent = "创建中…";
        api("POST", "/ingresses", {
          subdomain: subdomain, zone_id: zoneId, zone_name: zoneName,
          tunnel_id: tunnelId, tunnel_name: tunnelName, service: service,
        }).then(function () {
          closeModal();
          toast("规则已创建，CNAME 同步完成");
          refreshIngresses();
          refreshDnsRecords();
        }).catch(function (err) {
          toast("创建失败：" + err.message);
          ok.disabled = false;
          ok.textContent = "创建";
        });
      });
    }).catch(function (err) { toast("获取隧道列表失败：" + err.message); });
  }

  function onIngressClick(ev) {
    var btn = ev.target.closest("[data-act]");
    if (!btn) return;
    var item = btn.closest(".ingress-item");
    if (!item) return;
    var id = item.getAttribute("data-id");
    var fullName = (item.querySelector(".ingress-name").textContent || "").replace(/^🌐\s*/, "").split(" → ")[0];
    var act = btn.getAttribute("data-act");
    if (act === "del") {
      deleteIngress(id, fullName);
    } else if (act === "edit") {
      editIngress(item);
    }
  }

  function editIngress(item) {
    var id = item.getAttribute("data-id");
    var fullName = item.getAttribute("data-sub") + "." + item.getAttribute("data-zone");
    var currentTunnel = item.getAttribute("data-tunnel");
    var currentService = item.getAttribute("data-service");

    api("GET", "/tunnels").then(function (t) {
      var tunnels = (t.tunnels || []);
      var tunnelOptions = tunnels.map(function (tu) {
        return '<option value="' + esc(tu.id) + '"' + (tu.id === currentTunnel ? ' selected' : '') +
          '>' + esc(tu.name) + '</option>';
      }).join("");

      openModal("编辑 Ingress 规则",
        '<div class="field">' +
          '<label class="field-label">域名</label>' +
          '<input class="field-input" type="text" value="' + esc(fullName) + '" disabled>' +
          '<div class="form-hint">域名不可修改；如需更换请删除后重建。</div>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-label" for="mEditTunnel">目标隧道</label>' +
          '<select class="field-input" id="mEditTunnel">' + tunnelOptions + '</select>' +
          '<div class="form-hint">更换隧道会同步更新 Cloudflare 的 CNAME 记录。</div>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-label" for="mEditService">本地服务地址</label>' +
          '<input class="field-input" id="mEditService" type="text" value="' + esc(currentService) + '" autocomplete="off">' +
          '<div class="form-hint">例如 http://127.0.0.1:8080 或 unix:/var/run/app.sock</div>' +
        '</div>',
        '<button class="btn btn-ghost btn-auto" type="button" data-close>取消</button>' +
        '<button class="btn btn-primary btn-auto" type="button" id="mEditOk">保存</button>');

      $("mEditService").focus();
      $("mEditOk").addEventListener("click", function () {
        var service = $("mEditService").value.trim();
        var sel = $("mEditTunnel");
        var tunnelId = sel.value;
        var tunnelName = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : "";
        if (!service.startsWith("http://") && !service.startsWith("https://") && !service.startsWith("unix:")) {
          toast("本地服务地址需以 http:// / https:// / unix: 开头");
          return;
        }
        var ok = this;
        ok.disabled = true;
        ok.textContent = "保存中…";
        api("POST", "/ingresses/" + encodeURIComponent(id), {
          service: service, tunnel_id: tunnelId, tunnel_name: tunnelName,
        }).then(function () {
          closeModal();
          toast("规则已更新");
          refreshIngresses();
          refreshDnsRecords();
        }).catch(function (err) {
          toast("更新失败：" + err.message);
          ok.disabled = false;
          ok.textContent = "保存";
        });
      });
    }).catch(function (err) { toast("获取隧道列表失败：" + err.message); });
  }

  function deleteIngress(id, fullName) {
    openModal("删除 Ingress 规则",
      '<p style="margin:0 0 var(--space-2)">确定删除 <b>' + esc(fullName) + '</b> 吗？</p>' +
      '<p style="margin:0;color:var(--theme-muted);font-size:var(--text-sm);line-height:var(--leading-relaxed)">' +
        '本地规则与 Cloudflare DNS 记录会一起删除，不可恢复。' +
      '</p>',
      '<button class="btn btn-ghost btn-auto" type="button" data-close>取消</button>' +
      '<button class="btn btn-danger btn-auto" type="button" id="mDelIngOk">删除</button>');
    $("mDelIngOk").addEventListener("click", function () {
      var ok = this;
      ok.disabled = true;
      ok.textContent = "删除中…";
      api("DELETE", "/ingresses/" + encodeURIComponent(id)).then(function () {
        closeModal();
        toast("已删除");
        refreshIngresses();
        refreshDnsRecords();
      }).catch(function (err) {
        toast("删除失败：" + err.message);
        ok.disabled = false;
        ok.textContent = "删除";
      });
    });
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
        $("dnsRecordsSummary").textContent = "请先在「设置」页配置 Token，并在「DNS」页选择一个 Zone";
        return;
      }
      if (!r.ok) {
        notice.hidden = false;
        notice.innerHTML = '<span>⚠️</span><span>' + esc(r.error || "获取失败") + '</span>';
        return;
      }
      renderDnsRecords(r.records || [], r.managed_count || 0, r.total || 0);
    }).catch(function (err) {
      list.innerHTML = "";
      notice.hidden = false;
      notice.innerHTML = '<span>⚠️</span><span>' + esc(err.message || "加载失败") + '</span>';
      // 「接口不存在」多半是容器还在跑旧代码，直接给出自检入口
      if (/接口不存在/.test(err.message || "")) {
        notice.innerHTML += '<button class="btn btn-ghost btn-auto" type="button" id="dnsSelfCheckBtn" ' +
          'style="margin-left:auto;flex:none;align-self:center">运行版本自检</button>';
        var scBtn = $("dnsSelfCheckBtn");
        if (scBtn) scBtn.addEventListener("click", runSelfCheck);
      }
    });
  }

  /* 版本自检：确认服务端代码里是否真的注册了这些接口 */
  function runSelfCheck() {
    api("GET", "/system/selfcheck").then(function (r) {
      var rows = Object.keys(r.routes_present || {}).map(function (k) {
        var ok = r.routes_present[k];
        return '<div class="dns-meta">' + (ok ? "✅" : "❌") + " " + esc(k) + '</div>';
      }).join("");
      var dt = new Date(r.server_mtime * 1000);
      openModal("版本自检",
        '<div style="font-size:var(--text-sm);line-height:var(--leading-relaxed)">' +
          '<p style="margin:0 0 var(--space-3)">代码指纹：<b>' + esc(r.code_sha) + '</b>（v' + esc(r.version) + '）</p>' +
          '<p style="margin:0 0 var(--space-3)">server.py 修改时间：' + esc(dt.toLocaleString()) + '</p>' +
          '<p style="margin:0 0 var(--space-3)">进程 PID：' + esc(String(r.pid)) + '</p>' +
          rows +
          '<p style="margin:var(--space-4) 0 0;color:var(--theme-muted)">' +
            (r.all_routes_ok
              ? "代码是新的。若仍报「接口不存在」，请强制刷新浏览器缓存（Ctrl+Shift+R）。"
              : "代码缺失对应路由。请在安装目录执行 docker compose up -d --build --force-recreate。") +
          '</p>' +
        '</div>',
        '<button class="btn btn-ghost btn-auto" type="button" data-close>关闭</button>');
    }).catch(function (err) {
      toast("自检失败：" + err.message);
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
      var next = window.__kay-cftunnleTheme.toggle();
      toast(next === "dark" ? "已切换到深色模式" : "已切换到浅色模式");
    });
    window.addEventListener("hashchange", applyRoute);

    // 设置页
    $("saveCfBtn").addEventListener("click", saveCfSettings);
    $("verifyCfBtn").addEventListener("click", verifyCf);
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
    $("tunnelsList").addEventListener("click", onTunnelsClick);

    // DNS 页
    $("fetchZonesBtn").addEventListener("click", refreshZones);
    $("zonesList").addEventListener("click", onZonesClick);
    $("newIngressBtn").addEventListener("click", newIngress);
    $("ingressList").addEventListener("click", onIngressClick);
    $("refreshDnsRecordsBtn").addEventListener("click", refreshDnsRecords);

    // 连接器页
    $("refreshConnectorBtn").addEventListener("click", refreshConnector);
    $("startConnectorBtn").addEventListener("click", startConnector);
    $("stopConnectorBtn").addEventListener("click", stopConnector);
    $("restartConnectorBtn").addEventListener("click", restartConnector);
    $("saveDefaultTunnelBtn").addEventListener("click", saveDefaultTunnel);
    $("clearConnectorLogsBtn").addEventListener("click", clearConnectorLogs);

    // 总览页快速操作
    $("quickActions").addEventListener("click", onQuickAction);

    // 弹层：点遮罩 / ✕ / data-close 关闭，ESC 关闭
    $("modalRoot").addEventListener("click", function (ev) {
      if (ev.target === this || ev.target.closest("[data-close]")) closeModal();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !$("modalRoot").hidden) closeModal();
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
