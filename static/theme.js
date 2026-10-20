/* SPDX-License-Identifier: MIT · Copyright (c) 2026 EasonShu */
/* Kay-cftunnle 面板 · 明暗偏好：在样式表加载前同步应用，避免闪白 */
(function () {
  var KEY = "kay-cftunnle-theme";
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  var theme = saved;
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
  window.__kayCftunnleTheme = {
    get: function () { return document.documentElement.getAttribute("data-theme"); },
    set: function (t) {
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem(KEY, t); } catch (e) {}
    },
    toggle: function () {
      var next = this.get() === "dark" ? "light" : "dark";
      this.set(next);
      return next;
    },
  };
})();
