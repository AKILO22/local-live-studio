"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector),
    api = window.studio;
  let state = {
    status: "setup-required",
    configured: false,
    hasSavedLink: false,
    connected: false,
    internetEnabled: true,
    busy: false,
    brokerURL: "",
  };
  let working = false;
  let lastBrokerURL;
  function render() {
    const busy = working || state.busy,
      saved = state.hasSavedLink;
    const labels = {
      "setup-required": "Setup required",
      ready: "Not connected",
      authorizing: "Awaiting approval",
      working: "Working…",
      connected: "Connected",
      saved: "Saved link",
      expired: "Reconnect needed",
    };
    $("#tiktok-state").textContent = labels[state.status] || "Not connected";
    $("#tiktok-state").classList.toggle(
      "is-connected",
      state.status === "connected",
    );
    $("#tiktok-summary").textContent = !state.configured
      ? "Set up your Login Kit connection server to get started."
      : !state.internetEnabled
        ? "Offline mode. Saved account access will resume when you reconnect."
        : state.status === "saved"
          ? "A saved profile is available. Refresh to verify the connection."
          : state.status === "authorizing"
            ? "Finish sign-in on TikTok’s own website."
            : state.connected
              ? "Your TikTok profile is linked to this studio."
              : "Connect to display your TikTok profile in the studio.";
    $("#tiktok-profile").hidden = !state.profile;
    $("#tiktok-profile").textContent = state.profile?.displayName || "";
    $("#tiktok-connect").hidden = saved || busy;
    $("#tiktok-connect").disabled =
      !state.configured || !state.internetEnabled || busy;
    $("#tiktok-refresh").hidden = !saved;
    $("#tiktok-disconnect").hidden = !saved;
    for (const id of ["#tiktok-refresh", "#tiktok-disconnect"])
      $(id).disabled = busy || !state.internetEnabled;
    $("#tiktok-cancel").hidden = !state.busy;
    $("#tiktok-cancel").disabled = working;
    $("#tiktok-forget").hidden =
      !saved && !state.message?.includes("could not be read");
    $("#tiktok-forget").disabled = busy;
    $("#tiktok-save-settings").disabled = busy || saved;
    $("#tiktok-broker-url").disabled = busy || saved;
    if (
      state.brokerURL !== lastBrokerURL &&
      document.activeElement !== $("#tiktok-broker-url")
    ) {
      $("#tiktok-broker-url").value = state.brokerURL || "";
      lastBrokerURL = state.brokerURL;
    }
    $("#tiktok-status").textContent = state.message || "";
  }
  function apply(next) {
    state = next;
    render();
  }
  async function act(action) {
    if (working) return;
    working = true;
    render();
    try {
      apply(await action());
    } catch (error) {
      state.message =
        error.message || "The TikTok connection could not be completed.";
    } finally {
      working = false;
      render();
    }
  }
  $("#tiktok-setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const url = $("#tiktok-broker-url").value;
    return act(() => api.saveTikTokSettings(url));
  });
  $("#tiktok-connect").addEventListener("click", () =>
    act(() => api.connectTikTok()),
  );
  $("#tiktok-refresh").addEventListener("click", () =>
    act(() => api.refreshTikTok()),
  );
  $("#tiktok-disconnect").addEventListener("click", () =>
    act(() => api.disconnectTikTok()),
  );
  $("#tiktok-cancel").addEventListener("click", () =>
    act(() => api.cancelTikTok()),
  );
  $("#tiktok-forget").addEventListener("click", () =>
    act(() => api.forgetTikTok()),
  );
  api?.onTikTokStatus(apply);
  window.tiktokConnection = Object.freeze({
    initialize(next) {
      apply(next || state);
      $("#tiktok-connection-details").open = !state.configured;
    },
    setInternetEnabled(enabled) {
      state.internetEnabled = enabled;
      if (!enabled && state.status === "connected") state.status = "saved";
      render();
    },
  });
})();
