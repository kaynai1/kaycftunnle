/* SPDX-License-Identifier: MIT · Copyright (c) 2026 EasonShu */
/* 激活页交互：读取状态、在线卡密与离线授权码两种激活方式 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var status = null;
  var redirecting = false;
  // 买家主动点「更换授权服务地址」后才显示输入框
  var serverRevealed = false;
  // 当前激活方式；买家手动切换过标签页后不再按状态自动改
  var mode = "online";
  var modeTouched = false;

  function api(method, path, body) {
    var options = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          data.ok = false;
          if (!data.error) data.error = "请求失败（HTTP " + response.status + "）";
        }
        return data;
      });
    });
  }

  function showError(message) {
    var box = $("activateError");
    box.textContent = message || "操作失败，请重试";
    box.classList.remove("show");
    void box.offsetWidth;
    box.classList.add("show");
  }

  function hideError() {
    $("activateError").classList.remove("show");
  }

  function setBusy(busy, label) {
    var button = $("activateBtn");
    button.disabled = busy;
    button.classList.toggle("is-busy", busy);
    $("activateBtnText").textContent = busy ? (label || "正在激活…") : "激活这台设备";
  }

  function setStatusVisual(kind, text) {
    var dot = $("statusDot");
    dot.className = "keycard-dot" + (kind ? " is-" + kind : "");
    $("asideStatus").textContent = text;
  }

  function maskCode(code) {
    if (!code || code.length < 4) return "";
    return "KAY-****-****-" + code.slice(-4);
  }

  function setMode(next) {
    mode = next === "offline" ? "offline" : "online";
    var offline = mode === "offline";
    $("tabOnline").classList.toggle("is-active", !offline);
    $("tabOffline").classList.toggle("is-active", offline);
    $("tabOnline").setAttribute("aria-selected", String(!offline));
    $("tabOffline").setAttribute("aria-selected", String(offline));
    $("onlinePane").hidden = offline;
    $("offlinePane").hidden = !offline;
    hideError();
  }

  function renderStatus(data) {
    status = data;
    $("machineCode").textContent = data.machine_code || "无法读取机器码";
    if (!modeTouched && data.mode === "offline") setMode("offline");

    // 授权服务地址不下发到浏览器：已配置时隐藏输入框，只留一个「更换地址」入口
    var urlInput = $("serverUrl");
    var details = $("serverDetails");
    var serverState = $("serverState");
    var swapBtn = $("changeServerBtn");
    var hasServer = !!(data.server_configured || urlInput.value.trim());
    details.hidden = hasServer && !serverRevealed;
    swapBtn.hidden = !hasServer || serverRevealed;
    if (hasServer) {
      serverState.textContent = "已配置";
      serverState.classList.add("is-set");
    } else {
      serverState.textContent = "必填";
      serverState.classList.remove("is-set");
      details.open = true;
    }

    var notice = $("activateNotice");
    var verifyBtn = $("verifyBtn");
    if (data.activated && !data.valid) {
      notice.hidden = false;
      var offline = data.mode === "offline";
      var titles = {
        revoked: offline ? "离线授权已被吊销" : "当前卡密已被吊销",
        expired: offline ? "离线授权已到期" : "离线宽限期已过",
        invalid: "授权需要处理",
        pending: "等待首次在线校验"
      };
      $("noticeTitle").textContent = titles[data.state] || "授权需要处理";
      var extra = data.last_error && data.message.indexOf(data.last_error) === -1
        ? "（" + data.last_error + "）" : "";
      $("noticeText").textContent = data.message + extra +
        (data.code_masked ? " 当前授权：" + data.code_masked : "");
      verifyBtn.hidden = data.state === "revoked" || offline;
      setStatusVisual(data.state === "revoked" ? "bad" : "warn",
        data.state === "revoked" ? (offline ? "已锁定 · 授权被吊销" : "已锁定 · 卡密被吊销")
          : data.message);
    } else if (data.activated && data.valid) {
      notice.hidden = true;
      setStatusVisual("ok", (data.mode === "offline" ? "离线授权有效 · " : "授权正常 · ") + "正在进入面板");
      window.location.replace("/");
      return;
    } else {
      notice.hidden = true;
      setStatusVisual("", "尚未激活 · 等待卡密或授权码");
    }
  }

  function loadStatus() {
    return api("GET", "/api/license/status")
      .then(function (data) {
        if (data.ok === false) {
          throw new Error(data.error || "无法读取授权状态");
        }
        renderStatus(data);
      })
      .catch(function (error) {
        setStatusVisual("bad", "无法读取授权状态");
        showError("无法读取授权状态：" + (error.message || error));
      });
  }

  function formatCodeInput(raw) {
    var upper = String(raw || "").toUpperCase();
    var flat = upper.replace(/[^A-Z0-9]/g, "");
    var hasPrefix = flat.slice(0, 3) === "KAY" && flat.length > 3;
    if (hasPrefix) flat = flat.slice(3);
    flat = flat.slice(0, 12);
    if (!flat) return "";
    var groups = flat.match(/.{1,4}/g) || [];
    return (hasPrefix || flat.length === 12 ? "KAY-" : "") + groups.join("-");
  }

  function codeBody(value) {
    var flat = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (flat.slice(0, 3) === "KAY") flat = flat.slice(3);
    return flat;
  }

  function friendlyError(data) {
    var reasons = {
      invalid_code: "卡密格式不正确，请检查是否为 KAY-XXXX-XXXX-XXXX。",
      invalid_machine: "机器码格式异常，请刷新页面后重试。",
      not_found: "没有找到这张卡密，请核对输入或联系卖家。",
      revoked: "这张卡密已被吊销，无法继续使用。",
      device_mismatch: "这张卡密已绑定另一台设备。请联系管理员解绑后再激活。",
      already_activated: "面板已经激活过了。",
      no_server: "请先填写授权服务地址。",
      invalid_server: "授权服务地址格式不正确，公网地址必须使用 https://。",
      offline_disabled: "本机面板不支持离线授权码，请改用在线卡密激活。",
      invalid_offline: "离线授权码格式不正确，请整段粘贴（以 KAYO 开头，约 170 个字符）。",
      bad_signature: "离线授权码校验未通过：请确认粘贴完整、没有缺字或多字，且是本机对应的那一份。",
      expired: "这份离线授权已到期，请联系卖家续期。"
    };
    if (data.reason === "device_mismatch" && mode === "offline" && data.error) return data.error;
    if (reasons[data.reason]) return reasons[data.reason];
    return data.error || "激活失败，请稍后重试。";
  }

  function showServerField() {
    serverRevealed = true;
    var details = $("serverDetails");
    details.hidden = false;
    details.open = true;
    $("changeServerBtn").hidden = true;
  }

  function activationPayload() {
    if (mode === "offline") {
      var text = $("offlineCode").value.trim();
      if (text.replace(/[^0-9A-Za-z]/g, "").slice(0, 4).toUpperCase() !== "KAYO") {
        showError("请把卖家签发的离线授权码整段粘贴进来（以 KAYO 开头）。");
        $("offlineCode").focus();
        return null;
      }
      // 离线激活不需要联网；已配置过授权服务地址时沿用本机配置，便于后续远程吊销
      var optional = $("serverUrl").value.trim();
      return optional ? { code: text, server_url: optional } : { code: text };
    }
    var code = codeBody($("licenseCode").value);
    if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(code)) {
      showError("卡密格式不正确，应形如 KAY-XXXX-XXXX-XXXX。");
      $("licenseCode").focus();
      return null;
    }
    var serverUrl = $("serverUrl").value.trim();
    if (!serverUrl && !(status && status.server_configured)) {
      showServerField();
      showError("请先填写授权服务地址。");
      $("serverUrl").focus();
      return null;
    }
    return { code: code, server_url: serverUrl };
  }

  function submitActivation(event) {
    event.preventDefault();
    if (redirecting) return;
    hideError();

    var payload = activationPayload();
    if (!payload) return;

    setBusy(true, mode === "offline" ? "正在校验授权码…" : "正在激活…");
    api("POST", "/api/license/activate", payload).then(function (data) {
      if (!data.ok) {
        setBusy(false);
        showError(friendlyError(data));
        if (data.reason === "no_server" || data.reason === "invalid_server") {
          showServerField();
          $("serverUrl").focus();
        }
        return;
      }
      redirecting = true;
      $("activateForm").hidden = true;
      $("activateNotice").hidden = true;
      $("successPanel").hidden = false;
      setStatusVisual("ok", "激活成功 · 正在进入面板");
      $("activateError").classList.remove("show");
      window.setTimeout(function () { window.location.replace("/"); }, 1000);
    }).catch(function (error) {
      setBusy(false);
      showError("无法连接面板服务：" + (error.message || error));
    });
  }

  function verifyNow() {
    var button = $("verifyBtn");
    button.disabled = true;
    button.textContent = "校验中…";
    hideError();
    api("POST", "/api/license/verify", {}).then(function (data) {
      if (data.ok) {
        redirecting = true;
        setStatusVisual("ok", "校验通过 · 正在进入面板");
        window.setTimeout(function () { window.location.replace("/"); }, 700);
        return;
      }
      showError(data.error || "校验未通过");
      button.disabled = false;
      button.textContent = "立即校验";
      loadStatus();
    }).catch(function (error) {
      showError("校验失败：" + (error.message || error));
      button.disabled = false;
      button.textContent = "立即校验";
    });
  }

  function copyMachineCode() {
    var code = $("machineCode").textContent.trim();
    if (!code || code === "读取中…") return;
    var done = function () {
      var label = $("copyMachine").querySelector("span");
      var original = label.textContent;
      $("machineCode").classList.add("is-copied");
      label.textContent = "已复制";
      window.setTimeout(function () {
        label.textContent = original;
        $("machineCode").classList.remove("is-copied");
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(function () { fallbackCopy(code, done); });
    } else {
      fallbackCopy(code, done);
    }
  }

  function fallbackCopy(text, done) {
    var area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch (error) { showError("复制失败，请手动选择机器码。"); }
    document.body.removeChild(area);
  }

  function initTheme() {
    var theme = window.__kayCftunnleTheme;
    if (!theme) return;
    var button = $("themeToggle");
    var icons = button.querySelectorAll("svg.ico");
    var sun = icons[0];
    var moon = icons[1];
    function sync() {
      var dark = theme.get() === "dark";
      // SVG 元素没有 hidden IDL 属性，必须显式改 attribute
      sun.toggleAttribute("hidden", !dark);
      moon.toggleAttribute("hidden", dark);
    }
    button.addEventListener("click", function () { theme.toggle(); sync(); });
    sync();
  }

  function init() {
    initTheme();
    $("machineCode").textContent = "读取中…";
    loadStatus();

    $("licenseCode").addEventListener("input", function () {
      var formatted = formatCodeInput(this.value);
      if (formatted !== this.value) this.value = formatted;
      hideError();
    });
    $("offlineCode").addEventListener("input", hideError);
    $("tabOnline").addEventListener("click", function () {
      modeTouched = true;
      setMode("online");
      $("licenseCode").focus();
    });
    $("tabOffline").addEventListener("click", function () {
      modeTouched = true;
      setMode("offline");
      $("offlineCode").focus();
    });
    $("activateForm").addEventListener("submit", submitActivation);
    $("verifyBtn").addEventListener("click", verifyNow);
    $("copyMachine").addEventListener("click", copyMachineCode);
    $("changeServerBtn").addEventListener("click", function () {
      showServerField();
      $("serverUrl").focus();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
