"use strict";

const $ = (selector) => document.querySelector(selector);
const bridge = window.studio;
const canvas = $("#preview");
const ctx = canvas.getContext("2d", { alpha: false });
const resources = new Map();
const sourceIcons = {
  screen: "▣",
  camera: "◉",
  "phone-camera": "▯",
  image: "▧",
  video: "▷",
  text: "T",
  color: "◼",
  browser: "◎",
  "guest-board": "🎁",
};
let project;
let selectedSourceId = null;
let recordings = [];
let recording = null;
let saveTimer;
let toastTimer;
let sceneAction = "add";
let editTarget = null;
let captureTarget = null;
let drawingTimer;
let audioContext;
let audioDestination;
let micStream;
let micInput;
let micGain;
let micAnalyser;
let mediaAnalyser;
let mediaGain;
let busy = false;
let pointerDrag;
let internetEnabled = true;
let webSync = Promise.resolve();
let accountState = { user: null, available: true };
let accountMode = "login";
let accountBusy = false;

function notify(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.style.borderColor = error ? "#b75368" : "#4d8c81";
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast.hidden = true;
    },
    error ? 8500 : 4000,
  );
}

function report(error) {
  console.error(error);
  notify(error.message || String(error), true);
}

function run(action) {
  return (...args) =>
    Promise.resolve()
      .then(() => action(...args))
      .catch(report);
}

function layer(type, name, values = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    name,
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
    opacity: 1,
    visible: true,
    locked: false,
    ...values,
  };
}

function titleScene(name, title, subtitle, color) {
  return {
    id: crypto.randomUUID(),
    name,
    sources: [
      layer("color", "Background", { color }),
      layer("color", "Accent panel", {
        x: 1070,
        y: 60,
        width: 120,
        height: 600,
        color: "#38d5ce",
        opacity: 0.75,
      }),
      layer("text", "Title", {
        text: title,
        color: "#eff9f7",
        fontSize: 82,
        x: 82,
        y: 205,
        width: 900,
        height: 230,
      }),
      layer("text", "Subtitle", {
        text: subtitle,
        color: "#a0b9b8",
        fontSize: 26,
        x: 85,
        y: 460,
        width: 900,
        height: 100,
      }),
    ],
  };
}

function defaultProject() {
  const scenes = [
    titleScene(
      "Main scene",
      "Your story.\nYour studio.",
      "Add a display, camera, or media source to begin.",
      "#142829",
    ),
    titleScene(
      "Starting soon",
      "Starting soon.",
      "Get comfortable. We will begin shortly.",
      "#172637",
    ),
    titleScene(
      "Be right back",
      "Be right back.",
      "A short break. Stay with us.",
      "#2c2232",
    ),
  ];
  return {
    version: 1,
    activeSceneId: scenes[0].id,
    scenes,
    settings: { width: 1280, height: 720, fps: 30, bitrate: 3000000 },
    notes: "",
  };
}

function currentScene() {
  return (
    project.scenes.find((scene) => scene.id === project.activeSceneId) ||
    project.scenes[0]
  );
}

function selectedSource() {
  return currentScene().sources.find(
    (source) => source.id === selectedSourceId,
  );
}

function queueSave() {
  $("#save-indicator").textContent = "Saving workspace…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(
    run(async () => {
      if (!(await bridge.saveProject(project))) {
        $("#save-indicator").textContent = "Workspace save failed";
        throw new Error(
          "Could not save your workspace. Check available disk space and export a project copy.",
        );
      }
      $("#save-indicator").textContent = "Workspace saved";
    }),
    450,
  );
}

function textButton(label, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.addEventListener("click", run(action));
  return button;
}

function renderScenes() {
  const list = $("#scene-list");
  list.replaceChildren();
  for (const scene of project.scenes) {
    const button = textButton(
      "",
      async () => {
        project.activeSceneId = scene.id;
        selectedSourceId = null;
        renderWorkspace();
        await resumeActiveMedia();
        queueSave();
      },
      "scene-row",
    );
    button.setAttribute("aria-current", String(scene.id === currentScene().id));
    const thumbnail = document.createElement("span");
    thumbnail.className = "scene-thumbnail";
    thumbnail.textContent = "▣";
    thumbnail.style.background =
      scene.sources.find((source) => source.type === "color")?.color ||
      "#142829";
    const description = document.createElement("span");
    description.textContent = scene.name;
    const count = document.createElement("small");
    count.textContent =
      scene.sources.length +
      (scene.sources.length === 1 ? " source" : " sources");
    description.append(count);
    button.append(thumbnail, description);
    list.append(button);
  }
  $("#remove-scene").disabled = project.scenes.length <= 1;
  $("#scene-heading").textContent = currentScene().name;
}

function renderSources() {
  const list = $("#source-list");
  list.replaceChildren();
  for (const source of [...currentScene().sources].reverse()) {
    const row = document.createElement("div");
    row.className =
      "source-row" +
      (source.id === selectedSourceId ? " selected" : "") +
      (source.visible ? "" : " hidden-source");
    const choose = textButton(
      "",
      () => {
        selectedSourceId = source.id;
        renderSources();
        renderProperties();
      },
      "source-select",
    );
    choose.setAttribute("aria-label", "Select " + source.name);
    const icon = document.createElement("span");
    icon.className = "source-symbol";
    icon.textContent = sourceIcons[source.type] || "▣";
    const name = document.createElement("span");
    name.textContent = source.name;
    choose.append(icon, name);
    const visible = textButton(source.visible ? "◉" : "○", () => {
      source.visible = !source.visible;
      renderSources();
      renderProperties();
      updateAudioGains();
      resumeActiveMedia().catch(report);
      queueSave();
    });
    visible.setAttribute(
      "aria-label",
      (source.visible ? "Hide " : "Show ") + source.name,
    );
    const lock = textButton(source.locked ? "▣" : "◇", () => {
      source.locked = !source.locked;
      renderSources();
      renderProperties();
      queueSave();
    });
    lock.setAttribute(
      "aria-label",
      (source.locked ? "Unlock " : "Lock ") + source.name,
    );
    row.append(choose, visible, lock);
    list.append(row);
  }
  const source = selectedSource();
  for (const selector of ["#source-up", "#source-down", "#remove-source"])
    $(selector).disabled = !source;
}

function renderProperties() {
  const source = selectedSource();
  $("#selected-title").textContent = source?.name || "Select a source";
  const connected = source && resources.has(source.id);
  $("#source-status").textContent = source
    ? source.locked
      ? "Position locked"
      : ["camera", "screen", "phone-camera"].includes(source.type) && !connected
        ? "Capture is disconnected"
        : source.type.charAt(0).toUpperCase() + source.type.slice(1) + " source"
    : "Adjust its position and appearance here.";
  if (source?.type === "browser") {
    $("#source-status").textContent = internetEnabled
      ? resources.get(source.id)?.message || "Web source is idle"
      : "Internet access is disabled";
  }
  if (source?.type === "guest-board")
    $("#source-status").textContent =
      "Local guest cards & animated studio gifts";
  $("#source-properties").hidden = !source;
  if (!source) {
    updateSelection();
    return;
  }
  for (const key of ["x", "y", "width", "height", "opacity"]) {
    $("#prop-" + key).value = source[key];
    $("#prop-" + key).disabled = source.locked;
  }
  $("#fit-source").disabled = source.locked;
  $("#reconnect-source").hidden =
    !["camera", "screen", "phone-camera", "browser"].includes(source.type) ||
    (connected && source.type !== "browser");
  $("#reconnect-source").textContent =
    source.type === "browser" ? "Reload website" : "Reconnect";
  $("#reconnect-source").disabled =
    source.type === "browser" && !internetEnabled;
  updateSelection();
}

function fitPreview() {
  if (!project) return;
  const stage = $("#stage");
  const scale = Math.min(
    (stage.clientWidth - 36) / canvas.width,
    (stage.clientHeight - 36) / canvas.height,
  );
  const container = $(".canvas-container");
  container.style.width = Math.max(1, canvas.width * scale) + "px";
  container.style.height = Math.max(1, canvas.height * scale) + "px";
  updateSelection();
}

function updateSelection() {
  const source = project && selectedSource();
  const box = $("#selection-box");
  box.hidden = !source || !source.visible || source.locked;
  if (box.hidden) return;
  box.style.left = (source.x / canvas.width) * 100 + "%";
  box.style.top = (source.y / canvas.height) * 100 + "%";
  box.style.width = (source.width / canvas.width) * 100 + "%";
  box.style.height = (source.height / canvas.height) * 100 + "%";
}

function renderWorkspace() {
  renderScenes();
  renderSources();
  renderProperties();
  updateAudioGains();
}

function wrapText(text, fontSize, width) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const proposed = line ? line + " " + word : word;
      if (line && ctx.measureText(proposed).width > width) {
        lines.push(line);
        line = word;
      } else line = proposed;
    }
    lines.push(line);
  }
  return lines;
}

function draw() {
  if (!project) return;
  ctx.fillStyle = "#101319";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const source of currentScene().sources) {
    if (!source.visible) continue;
    ctx.save();
    ctx.globalAlpha = source.opacity;
    ctx.beginPath();
    ctx.rect(source.x, source.y, source.width, source.height);
    ctx.clip();
    if (source.type === "color") {
      ctx.fillStyle = source.color;
      ctx.fillRect(source.x, source.y, source.width, source.height);
    } else if (source.type === "text") {
      ctx.fillStyle = source.color;
      ctx.textBaseline = "top";
      ctx.font = "600 " + source.fontSize + "px 'Segoe UI', sans-serif";
      wrapText(source.text, source.fontSize, source.width).forEach(
        (line, index) =>
          ctx.fillText(
            line,
            source.x,
            source.y + index * source.fontSize * 1.2,
          ),
      );
    } else if (source.type === "guest-board") {
      window.giftBoard?.draw(ctx, source);
    } else {
      const resource = resources.get(source.id);
      const element = resource?.element;
      const width = element?.videoWidth || element?.naturalWidth;
      const height = element?.videoHeight || element?.naturalHeight;
      if (width && height) {
        const scale = Math.min(source.width / width, source.height / height);
        const w = width * scale;
        const h = height * scale;
        ctx.drawImage(
          element,
          source.x + (source.width - w) / 2,
          source.y + (source.height - h) / 2,
          w,
          h,
        );
      } else {
        ctx.fillStyle = "#202933";
        ctx.fillRect(source.x, source.y, source.width, source.height);
        ctx.fillStyle = "#aebdcb";
        ctx.font = "22px 'Segoe UI', sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(
          source.name +
            (source.type === "browser"
              ? internetEnabled
                ? " · Loading website"
                : " · Internet access is disabled"
              : " · Reconnect source"),
          source.x + 24,
          source.y + source.height / 2,
          Math.max(1, source.width - 48),
        );
      }
    }
    ctx.restore();
  }
}

function configureCanvas() {
  canvas.width = project.settings.width;
  canvas.height = project.settings.height;
  $("#canvas-preset").value = canvas.width + "x" + canvas.height;
  $("#fps-setting").value = project.settings.fps;
  $("#bitrate-setting").value = project.settings.bitrate;
  $("#bitrate-label").textContent =
    project.settings.bitrate / 1000000 + " Mbps";
  $("#format-status").textContent =
    canvas.width +
    " × " +
    canvas.height +
    " · " +
    project.settings.fps +
    " fps";
  clearInterval(drawingTimer);
  draw();
  drawingTimer = setInterval(draw, 1000 / project.settings.fps);
  fitPreview();
}

async function ensureAudio() {
  if (!audioContext) {
    audioContext = new AudioContext();
    audioDestination = audioContext.createMediaStreamDestination();
    mediaGain = audioContext.createGain();
    mediaAnalyser = audioContext.createAnalyser();
    mediaAnalyser.fftSize = 256;
    mediaGain.connect(mediaAnalyser);
    mediaAnalyser.connect(audioDestination);
    mediaGain.gain.value = Number($("#media-volume").value);
  }
  if (audioContext.state === "suspended") await audioContext.resume();
}

async function attachAudio(resource) {
  await ensureAudio();
  if (resource.stream?.getAudioTracks().length)
    resource.audioNode = audioContext.createMediaStreamSource(resource.stream);
  else if (resource.kind === "video")
    resource.audioNode = audioContext.createMediaElementSource(
      resource.element,
    );
  if (resource.audioNode) {
    resource.gain = audioContext.createGain();
    resource.audioNode.connect(resource.gain);
    resource.gain.connect(mediaGain);
    updateAudioGains();
  }
}

function updateAudioGains() {
  if (!project) return;
  const visibleIds = new Set(
    currentScene()
      .sources.filter((source) => source.visible)
      .map((source) => source.id),
  );
  for (const [id, resource] of resources)
    if (resource.gain) resource.gain.gain.value = visibleIds.has(id) ? 1 : 0;
  const desktopAudio = [...resources.values()].some(
    (resource) =>
      resource.kind === "screen" &&
      resource.stream
        ?.getAudioTracks()
        .some((track) => track.readyState === "live"),
  );
  $("#desktop-status").textContent = desktopAudio
    ? "Desktop audio connected"
    : "Add a display source to capture sound.";
}

function releaseResource(id) {
  const resource = resources.get(id);
  if (!resource) return;
  resources.delete(id);
  resource.stream?.getTracks().forEach((track) => track.stop());
  resource.element?.pause?.();
  resource.audioNode?.disconnect();
  resource.gain?.disconnect();
  if (resource.element?.src) resource.element.removeAttribute("src");
  if (resource.kind === "browser") return bridge.stopWebSource(id);
}

async function resumeActiveMedia() {
  const active = new Set(
    currentScene()
      .sources.filter((source) => source.visible)
      .map((source) => source.id),
  );
  for (const [id, resource] of resources) {
    if (resource.kind !== "video") continue;
    if (active.has(id)) await resource.element.play().catch(() => {});
    else resource.element.pause();
  }
  await syncWebSources();
}

function renderNetworkState() {
  window.tiktokConnection?.setInternetEnabled(internetEnabled);
  window.liveOutput?.setInternetEnabled(internetEnabled);
  window.phoneStudio?.setInternetEnabled(internetEnabled);
  $("#network-label").textContent = internetEnabled
    ? "Internet enabled"
    : "Offline mode";
  $("#network-badge").classList.toggle("is-offline", !internetEnabled);
  $("#internet-enabled").checked = internetEnabled;
  $("#check-connection").disabled = !internetEnabled;
  $("#network-status").textContent = internetEnabled
    ? "Internet access enabled. Use Check connection to verify connectivity."
    : "Internet access disabled. Prepare your scenes offline; LIVE output is stopped.";
  for (const kind of ["browser", "online-media"])
    $("[data-add='" + kind + "']").disabled = !internetEnabled;
}

function renderAccount() {
  const user = accountState.user;
  window.giftBoard?.setCreator(user?.name || "Creator");
  $("#account-button-label").textContent = user
    ? user.name
    : "Sign in / Account";
  $("#account-button").title = user
    ? "Account · " + user.name
    : "Sign in or manage accounts";
  $("#account-signed-out").hidden = !!user;
  $("#account-signed-in").hidden = !user;
  if (user) {
    $("#account-avatar").textContent = user.name.slice(0, 1).toUpperCase();
    $("#account-display-name").textContent = user.name;
    $("#account-display-email").textContent = user.email;
  }
  $("#account-submit").disabled = accountBusy || !accountState.available;
  $("#account-status").textContent = accountState.available
    ? ""
    : accountState.message;
}

function setAccountMode(mode) {
  if (accountBusy) return;
  accountMode = mode;
  const create = mode === "create";
  $("#account-form").reset();
  $("#account-confirm-password").setCustomValidity("");
  $("#account-name-label").hidden = !create;
  $("#account-name").required = create;
  $("#account-confirm-label").hidden = !create;
  $("#account-confirm-password").required = create;
  $("#account-password-hint").hidden = !create;
  $("#account-password").autocomplete = create
    ? "new-password"
    : "current-password";
  $("#account-form-title").textContent = create
    ? "Create your studio account"
    : "Welcome back";
  $("#account-form-description").textContent = create
    ? "Set up a local profile. No Internet connection needed."
    : "Sign in to your studio profile on this computer.";
  $("#account-submit").textContent = create ? "Create account" : "Sign in";
  $("#account-login-mode").setAttribute("aria-pressed", String(!create));
  $("#account-create-mode").setAttribute("aria-pressed", String(create));
  renderAccount();
}

$("#account-button").addEventListener("click", () => {
  if (!accountBusy) setAccountMode("login");
  $("#account-dialog").showModal();
});
$("#account-login-mode").addEventListener("click", () =>
  setAccountMode("login"),
);
$("#account-create-mode").addEventListener("click", () =>
  setAccountMode("create"),
);
$("#account-confirm-password").addEventListener("input", () =>
  $("#account-confirm-password").setCustomValidity(""),
);
$("#account-password").addEventListener("input", () =>
  $("#account-confirm-password").setCustomValidity(""),
);
$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (accountBusy || !accountState.available) return;
  if (
    accountMode === "create" &&
    $("#account-password").value !== $("#account-confirm-password").value
  ) {
    $("#account-confirm-password").setCustomValidity("Passwords do not match.");
    $("#account-confirm-password").reportValidity();
    return;
  }
  accountBusy = true;
  for (const control of $("#account-form").elements) control.disabled = true;
  $("#account-status").textContent =
    accountMode === "create" ? "Creating your local account…" : "Signing in…";
  try {
    const credentials = {
      name: $("#account-name").value,
      email: $("#account-email").value,
      password: $("#account-password").value,
    };
    const user = await (accountMode === "create"
      ? bridge.createAccount(credentials)
      : bridge.signIn(credentials));
    accountState = { user, available: true };
    $("#account-form").reset();
    renderAccount();
    notify("Signed in as " + user.name + ".");
  } catch (error) {
    $("#account-status").textContent =
      error.message || "Unable to sign in. Try again.";
  } finally {
    $("#account-password").value = "";
    $("#account-confirm-password").value = "";
    accountBusy = false;
    for (const control of $("#account-form").elements) control.disabled = false;
  }
});
$("#account-sign-out").addEventListener("click", async () => {
  if (accountBusy) return;
  accountBusy = true;
  $("#account-sign-out").disabled = true;
  $("#account-sign-out-status").textContent = "";
  try {
    await bridge.signOut();
    accountState.user = null;
    accountBusy = false;
    setAccountMode("login");
    notify("Signed out. Your workspace is ready to use.");
  } catch (error) {
    $("#account-sign-out-status").textContent = error.message;
  } finally {
    accountBusy = false;
    $("#account-sign-out").disabled = false;
  }
});
$("#account-dialog").addEventListener("close", () => {
  if (!accountBusy) $("#account-form").reset();
});

function syncWebSources() {
  webSync = webSync
    .catch(() => {})
    .then(async () => {
      const desired = new Map(
        (internetEnabled ? currentScene().sources : [])
          .filter((source) => source.type === "browser" && source.visible)
          .map((source) => [source.id, source]),
      );
      for (const [id, resource] of resources) {
        if (
          resource.kind === "browser" &&
          (!desired.has(id) || desired.get(id).url !== resource.url)
        )
          await releaseResource(id);
      }
      for (const source of desired.values()) {
        if (resources.has(source.id)) continue;
        const resource = {
          element: new Image(),
          kind: "browser",
          url: source.url,
          busy: false,
          message: "Loading website…",
        };
        resources.set(source.id, resource);
        try {
          await bridge.startWebSource({
            id: source.id,
            url: source.url,
            width: Math.round(source.width),
            height: Math.round(source.height),
          });
          if (resources.get(source.id) === resource)
            resource.message = "Website connected · Visual source";
        } catch (error) {
          resource.message =
            error.message || "Website could not load. Try Reload website.";
          notify(resource.message, true);
        }
      }
      renderProperties();
    });
  return webSync;
}

bridge?.onWebFrame(({ id, png }) => {
  const resource = resources.get(id);
  if (!resource || resource.kind !== "browser" || resource.busy) return;
  resource.busy = true;
  const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
  const image = new Image();
  image.onload = () => {
    if (resources.get(id) === resource) resource.element = image;
    resource.busy = false;
    URL.revokeObjectURL(url);
  };
  image.onerror = () => {
    resource.busy = false;
    URL.revokeObjectURL(url);
  };
  image.src = url;
});

bridge?.onWebStatus(({ id, status, message }) => {
  const resource = resources.get(id);
  if (!resource || resource.kind !== "browser") return;
  resource.message =
    message || (status === "ready" ? "Website connected" : "Loading website…");
  if (selectedSourceId === id) renderProperties();
});

async function loadMedia(source, selected) {
  const file = selected || (await bridge.registerMedia(source.path));
  if (!file)
    throw new Error(
      "The file for “" +
        source.name +
        "” is unavailable. Remove this source and add the file again.",
    );
  source.path = file.path;
  const element =
    source.type === "image" ? new Image() : document.createElement("video");
  element.crossOrigin = "anonymous";
  if (source.type === "video") {
    element.loop = source.loop !== false;
    element.playsInline = true;
  }
  await new Promise((resolve, reject) => {
    element.addEventListener(
      source.type === "image" ? "load" : "loadeddata",
      resolve,
      { once: true },
    );
    element.addEventListener(
      "error",
      () =>
        reject(
          new Error(
            "Could not open “" +
              file.name +
              "”. Try a PNG, JPEG, WebM, or H.264 MP4 file.",
          ),
        ),
      { once: true },
    );
    element.src = file.url;
    if (source.type === "video") element.load();
  });
  const resource = { element, kind: source.type };
  resources.set(source.id, resource);
  if (source.type === "video") {
    await attachAudio(resource);
    await resumeActiveMedia();
  }
}

async function activateCapture(source, stream) {
  releaseResource(source.id);
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.srcObject = stream;
  await element.play();
  const resource = { element, stream, kind: source.type };
  resources.set(source.id, resource);
  await attachAudio(resource);
  const videoTrack = stream.getVideoTracks()[0];
  videoTrack.addEventListener("ended", () => {
    if (resources.get(source.id) !== resource) return;
    releaseResource(source.id);
    renderProperties();
    updateAudioGains();
    notify(source.name + " disconnected. Select it and choose Reconnect.");
  });
}

function newSource(type, name, values) {
  return layer(type, name, {
    width: canvas.width,
    height: canvas.height,
    ...values,
  });
}

function commitSource(source) {
  if (!currentScene().sources.some((item) => item.id === source.id))
    currentScene().sources.push(source);
  selectedSourceId = source.id;
  renderWorkspace();
  resumeActiveMedia().catch(report);
  queueSave();
}

async function cameraSource(existing) {
  const source =
    existing ||
    newSource("camera", "Camera", {
      x: canvas.width * 0.65,
      y: canvas.height * 0.58,
      width: Math.round(canvas.width * 0.3),
      height: Math.round(canvas.height * 0.3),
    });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  try {
    await activateCapture(source, stream);
    commitSource(source);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

async function chooseScreen(existing) {
  captureTarget = existing || null;
  const list = $("#capture-options");
  list.textContent = "Finding available displays and windows…";
  $("#capture-dialog").showModal();
  const sources = await bridge.listSources();
  list.replaceChildren();
  if (!sources.length) {
    list.textContent =
      "No capture sources were found. Try opening a window and choose Add source again.";
    return;
  }
  for (const target of sources) {
    const button = textButton("", async () => {
      button.disabled = true;
      try {
        const source = captureTarget || newSource("screen", target.name);
        await bridge.selectCapture({
          id: target.id,
          systemAudio: $("#system-audio").checked,
        });
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: project.settings.fps },
          audio: $("#system-audio").checked,
        });
        try {
          await activateCapture(source, stream);
          commitSource(source);
        } catch (error) {
          stream.getTracks().forEach((track) => track.stop());
          throw error;
        }
        $("#capture-dialog").close();
      } finally {
        button.disabled = false;
      }
    });
    const thumb = new Image();
    thumb.src = target.thumbnail;
    thumb.alt = "";
    button.append(thumb, document.createTextNode(target.name));
    list.append(button);
  }
}

function editSource(source) {
  editTarget = source;
  $("#edit-dialog-title").textContent = currentScene().sources.includes(source)
    ? "Edit source"
    : "Add " + source.type + " source";
  $("#edit-name").value = source.name;
  $("#edit-text").value = source.text || "";
  $("#edit-color").value = source.color || "#ffffff";
  $("#edit-size").value = source.fontSize || 52;
  $("#edit-loop").checked = source.loop !== false;
  $("#edit-url").value = source.url || "";
  $("#web-editor-label").hidden = source.type !== "browser";
  $("#edit-url").required = source.type === "browser";
  $("#text-editor-label").hidden = source.type !== "text";
  $("#color-editor-label").hidden = !["text", "color"].includes(source.type);
  $("#size-editor-label").hidden = source.type !== "text";
  $("#loop-editor-label").hidden = source.type !== "video";
  $("#edit-dialog").showModal();
}

async function addSource(type) {
  $("#source-dialog").close();
  if (type === "guest-board") {
    const existing = currentScene().sources.find(
      (source) => source.type === "guest-board",
    );
    if (existing) {
      selectedSourceId = existing.id;
      renderWorkspace();
      return;
    }
    return commitSource(newSource("guest-board", "Guest boxes & gifts"));
  }
  if (type === "screen") return chooseScreen();
  if (type === "camera") return cameraSource();
  if (type === "phone-camera") return window.phoneStudio.open();
  if (type === "browser")
    return editSource(
      newSource("browser", "Web overlay", { url: "https://example.com" }),
    );
  if (type === "online-media") {
    $("#online-media-status").textContent = "";
    $("#online-media-dialog").showModal();
    return;
  }
  if (["image", "video"].includes(type)) {
    const file = await bridge.pickMedia(type);
    if (!file) return;
    const source = newSource(type, file.name, { path: file.path, loop: true });
    await loadMedia(source, file);
    commitSource(source);
    return;
  }
  const source =
    type === "text"
      ? newSource("text", "Text", {
          text: "Your title here",
          fontSize: 52,
          color: "#ffffff",
          x: 64,
          y: canvas.height - 140,
          width: canvas.width - 128,
          height: 100,
        })
      : newSource("color", "Color panel", { color: "#183c40" });
  editSource(source);
}

async function toggleMicrophone() {
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    micInput?.disconnect();
    micGain?.disconnect();
    micAnalyser = null;
    $("#mic-toggle").textContent = "Enable microphone";
    $("#mic-meter").style.width = "0%";
    return;
  }
  await ensureAudio();
  const deviceId = $("#mic-device").value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId === "default" ? undefined : { exact: deviceId },
      echoCancellation: true,
      noiseSuppression: true,
    },
    video: false,
  });
  micStream = stream;
  micInput = audioContext.createMediaStreamSource(stream);
  micGain = audioContext.createGain();
  micGain.gain.value = Number($("#mic-volume").value);
  micAnalyser = audioContext.createAnalyser();
  micAnalyser.fftSize = 256;
  micInput.connect(micGain);
  micGain.connect(micAnalyser);
  micAnalyser.connect(audioDestination);
  $("#mic-toggle").textContent = "Mute microphone";
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "audioinput",
  );
  const select = $("#mic-device");
  select.replaceChildren(new Option("Default microphone", "default"));
  for (const device of devices)
    if (device.deviceId !== "default")
      select.add(new Option(device.label || "Microphone", device.deviceId));
  select.value = deviceId;
}

function formatDuration(ms) {
  return new Date(Math.max(0, ms)).toISOString().slice(11, 19);
}

function elapsed() {
  if (!recording) return 0;
  return (
    (recording.pauseStarted || Date.now()) -
    recording.started -
    recording.pausedMs
  );
}

function updateRecordingUI() {
  if (!recording) { window.liveOutput?.render(); return; }
  const active = Boolean(recording);
  $("#record-label").textContent = active
    ? "Stop & save recording"
    : "Start recording";
  $("#record-button").classList.toggle("active", active);
  $("#pause-button").hidden = !active;
  $("#pause-button").textContent = recording?.pauseStarted
    ? "Resume recording"
    : "Pause recording";
  $("#record-state").textContent = recording?.pauseStarted
    ? "PAUSED"
    : active
      ? "RECORDING"
      : "READY";
  $("#record-state").classList.toggle("recording", active);
  $("#preview-mode").textContent = active
    ? "Recording to disk"
    : "Ready to record";
  $("#record-hint").textContent = active
    ? "Recording is saved directly to this computer."
    : "Record your scene to a local video file.";
  for (const selector of [
    "#canvas-preset",
    "#fps-setting",
    "#bitrate-setting",
    "#import-project",
  ])
    $(selector).disabled = active;
  $("#record-button").disabled = busy;
}

async function startRecording() {
  await ensureAudio();
  const mimeType = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((value) => MediaRecorder.isTypeSupported(value));
  if (!mimeType) throw new Error("This system cannot encode WebM video.");
  const session = await bridge.recordingStart({ mimeType });
  const stream = canvas.captureStream(project.settings.fps);
  audioDestination.stream
    .getAudioTracks()
    .forEach((track) => stream.addTrack(track));
  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: project.settings.bitrate,
      audioBitsPerSecond: 128000,
    });
  } catch (error) {
    stream.getVideoTracks().forEach((track) => track.stop());
    await bridge.recordingCancel({ id: session.id });
    throw error;
  }
  const result = {
    id: session.id,
    recorder,
    stream,
    started: Date.now(),
    pausedMs: 0,
    pauseStarted: null,
    bytes: 0,
    writes: Promise.resolve(),
    error: null,
  };
  result.finished = new Promise((resolve) => {
    result.complete = resolve;
  });
  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data.size) return;
    result.writes = result.writes
      .then(async () => {
        const bytes = await event.data.arrayBuffer();
        await bridge.recordingWrite({ id: result.id, bytes });
        result.bytes += bytes.byteLength;
      })
      .catch((error) => {
        result.error = error;
        if (recorder.state !== "inactive") recorder.stop();
      });
  });
  recorder.addEventListener("error", (event) => {
    result.error = event.error || new Error("Video encoding failed.");
  });
  recorder.addEventListener(
    "stop",
    run(async () => {
      busy = true;
      $("#record-button").disabled = true;
      $("#record-label").textContent = "Saving recording…";
      await result.writes;
      try {
        if (result.error) {
          await bridge.recordingCancel({ id: result.id });
          throw result.error;
        }
        const saved = await bridge.recordingFinish({ id: result.id });
        recordings.unshift(saved);
        renderRecordings();
        notify("Recording saved · " + saved.name);
      } finally {
        result.stream.getVideoTracks().forEach((track) => track.stop());
        recording = null;
        busy = false;
        updateRecordingUI();
        result.complete();
      }
    }),
  );
  recording = result;
  try {
    recorder.start(1000);
  } catch (error) {
    recording = null;
    stream.getVideoTracks().forEach((track) => track.stop());
    await bridge.recordingCancel({ id: result.id });
    throw error;
  }
  updateRecordingUI();
}

async function recordAction() {
  if (busy) return;
  if (recording) {
    if (recording.recorder.state !== "inactive") recording.recorder.stop();
    return;
  }
  busy = true;
  $("#record-button").disabled = true;
  try {
    await startRecording();
  } finally {
    busy = false;
    updateRecordingUI();
  }
}

function renderRecordings() {
  const list = $("#recordings-list");
  list.replaceChildren();
  if (!recordings.length) {
    const empty = document.createElement("div");
    empty.className = "empty-recordings";
    const icon = document.createElement("span");
    icon.textContent = "▷";
    empty.append(
      icon,
      document.createTextNode(
        "Your recordings will appear here. Start a take when you’re ready.",
      ),
    );
    list.append(empty);
  }
  for (const file of recordings) {
    const item = document.createElement("div");
    item.className = "recording-item";
    const title = document.createElement("strong");
    title.textContent = file.name;
    title.title = file.name;
    const details = document.createElement("small");
    details.textContent =
      (file.size / 1048576).toFixed(1) +
      " MB · " +
      new Date(file.modified).toLocaleDateString();
    const reveal = textButton("Show in folder", () =>
      bridge.revealFile(file.path),
    );
    item.append(title, details, reveal);
    list.append(item);
  }
}

async function loadProject(incoming) {
  for (const id of resources.keys()) releaseResource(id);
  project = incoming || defaultProject();
  selectedSourceId = null;
  $("#session-notes").value = project.notes || "";
  configureCanvas();
  renderWorkspace();
  for (const scene of project.scenes)
    for (const source of scene.sources) {
      if (["image", "video"].includes(source.type))
        await loadMedia(source).catch(report);
    }
  await resumeActiveMedia();
  queueSave();
}

function showSceneEditor(action) {
  sceneAction = action;
  $("#scene-dialog-title").textContent =
    action === "rename" ? "Rename scene" : "Add scene";
  $("#scene-name").value =
    action === "rename" ? currentScene().name : "New scene";
  $("#scene-dialog").showModal();
}

$("#add-scene").addEventListener("click", () => showSceneEditor("add"));
$("#rename-scene").addEventListener("click", () => showSceneEditor("rename"));
$("#scene-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#scene-name").value.trim();
  if (!name) return;
  if (sceneAction === "rename") currentScene().name = name;
  else {
    const scene = {
      id: crypto.randomUUID(),
      name,
      sources: [newSource("color", "Background", { color: "#142829" })],
    };
    project.scenes.push(scene);
    project.activeSceneId = scene.id;
    selectedSourceId = null;
  }
  $("#scene-dialog").close();
  renderWorkspace();
  queueSave();
});

$("#duplicate-scene").addEventListener(
  "click",
  run(async () => {
    const scene = structuredClone(currentScene());
    scene.id = crypto.randomUUID();
    scene.name += " copy";
    scene.sources.forEach((source) => {
      source.id = crypto.randomUUID();
    });
    project.scenes.push(scene);
    project.activeSceneId = scene.id;
    for (const source of scene.sources)
      if (["image", "video"].includes(source.type))
        await loadMedia(source).catch(report);
    selectedSourceId = null;
    renderWorkspace();
    queueSave();
  }),
);

$("#remove-scene").addEventListener("click", () => {
  if (project.scenes.length <= 1) return;
  const scene = currentScene();
  if (
    !confirm("Delete “" + scene.name + "” and its sources from this project?")
  )
    return;
  scene.sources.forEach((source) => releaseResource(source.id));
  project.scenes = project.scenes.filter((item) => item.id !== scene.id);
  project.activeSceneId = project.scenes[0].id;
  selectedSourceId = null;
  renderWorkspace();
  queueSave();
});

for (const id of ["#add-source", "#add-source-wide"])
  $(id).addEventListener("click", () => $("#source-dialog").showModal());
document.querySelectorAll("[data-add]").forEach((button) =>
  button.addEventListener(
    "click",
    run(() => addSource(button.dataset.add)),
  ),
);
document
  .querySelectorAll("[data-close-dialog]")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
$("#edit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (editTarget.type === "browser") {
    try {
      const url = new URL($("#edit-url").value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(
          "Use an HTTP or HTTPS website URL without a username or password.",
        );
      editTarget.url = url.href;
    } catch (error) {
      notify(error.message || "Enter a valid website URL.", true);
      return;
    }
  }
  editTarget.name = $("#edit-name").value.trim() || "Untitled source";
  editTarget.text = $("#edit-text").value;
  editTarget.color = $("#edit-color").value;
  editTarget.fontSize = Number($("#edit-size").value);
  editTarget.loop = $("#edit-loop").checked;
  const resource = resources.get(editTarget.id);
  if (resource?.kind === "video") resource.element.loop = editTarget.loop;
  commitSource(editTarget);
  $("#edit-dialog").close();
});
$("#edit-source").addEventListener("click", () => {
  const source = selectedSource();
  if (source) editSource(source);
});
$("#reconnect-source").addEventListener(
  "click",
  run(async () => {
    const source = selectedSource();
    if (source?.type === "screen") await chooseScreen(source);
    if (source?.type === "camera") await cameraSource(source);
    if (source?.type === "phone-camera") window.phoneStudio.open();
    if (source?.type === "browser") {
      await releaseResource(source.id);
      await syncWebSources();
    }
  }),
);
$("#remove-source").addEventListener("click", () => {
  const source = selectedSource();
  if (!source) return;
  releaseResource(source.id);
  currentScene().sources = currentScene().sources.filter(
    (item) => item.id !== source.id,
  );
  selectedSourceId = null;
  renderWorkspace();
  queueSave();
});
for (const [selector, direction] of [
  ["#source-up", 1],
  ["#source-down", -1],
]) {
  $(selector).addEventListener("click", () => {
    const sources = currentScene().sources;
    const index = sources.findIndex((source) => source.id === selectedSourceId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= sources.length) return;
    [sources[index], sources[next]] = [sources[next], sources[index]];
    renderSources();
    queueSave();
  });
}
for (const key of ["x", "y", "width", "height", "opacity"]) {
  $("#prop-" + key).addEventListener("change", () => {
    const source = selectedSource();
    const value = Number($("#prop-" + key).value);
    if (!source || source.locked || !Number.isFinite(value)) return;
    source[key] =
      key === "opacity"
        ? Math.min(1, Math.max(0, value))
        : ["width", "height"].includes(key)
          ? Math.min(10000, Math.max(1, value))
          : Math.min(10000, Math.max(-10000, value));
    renderProperties();
    queueSave();
  });
}
$("#fit-source").addEventListener("click", () => {
  const source = selectedSource();
  if (!source || source.locked) return;
  Object.assign(source, {
    x: 0,
    y: 0,
    width: canvas.width,
    height: canvas.height,
  });
  renderProperties();
  queueSave();
});
canvas.addEventListener("pointerdown", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
  const y = ((event.clientY - rect.top) * canvas.height) / rect.height;
  const source = [...currentScene().sources]
    .reverse()
    .find(
      (item) =>
        item.visible &&
        !item.locked &&
        x >= item.x &&
        y >= item.y &&
        x <= item.x + item.width &&
        y <= item.y + item.height,
    );
  selectedSourceId = source?.id || null;
  renderSources();
  renderProperties();
  if (source) {
    pointerDrag = { source, x, y, sourceX: source.x, sourceY: source.y };
    canvas.setPointerCapture(event.pointerId);
  }
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointerDrag) return;
  const rect = canvas.getBoundingClientRect();
  pointerDrag.source.x = Math.round(
    pointerDrag.sourceX +
      ((event.clientX - rect.left) * canvas.width) / rect.width -
      pointerDrag.x,
  );
  pointerDrag.source.y = Math.round(
    pointerDrag.sourceY +
      ((event.clientY - rect.top) * canvas.height) / rect.height -
      pointerDrag.y,
  );
  renderProperties();
});
canvas.addEventListener("pointerup", () => {
  if (pointerDrag) queueSave();
  pointerDrag = null;
});
canvas.addEventListener("pointercancel", () => {
  pointerDrag = null;
});

$("#canvas-preset").addEventListener("change", () => {
  if (recording || window.liveOutput?.isActive()) return;
  const [width, height] = $("#canvas-preset").value.split("x").map(Number);
  const xScale = width / project.settings.width;
  const yScale = height / project.settings.height;
  for (const scene of project.scenes)
    for (const source of scene.sources) {
      source.x = Math.round(source.x * xScale);
      source.y = Math.round(source.y * yScale);
      source.width = Math.round(source.width * xScale);
      source.height = Math.round(source.height * yScale);
      if (source.fontSize)
        source.fontSize = Math.max(
          8,
          Math.round(source.fontSize * Math.min(xScale, yScale)),
        );
    }
  Object.assign(project.settings, { width, height });
  configureCanvas();
  renderProperties();
  queueSave();
});
$("#settings-button").addEventListener("click", () =>
  $("#settings-dialog").showModal(),
);
$("#internet-enabled").addEventListener(
  "change",
  run(async () => {
    const control = $("#internet-enabled");
    control.disabled = true;
    try {
      const result = await bridge.setInternetEnabled(control.checked);
      internetEnabled = result.enabled;
      renderNetworkState();
      await syncWebSources();
    } finally {
      control.disabled = false;
      control.checked = internetEnabled;
    }
  }),
);
$("#check-connection").addEventListener(
  "click",
  run(async () => {
    const button = $("#check-connection");
    button.disabled = true;
    $("#network-status").textContent = "Checking Internet connectivity…";
    try {
      const result = await bridge.checkConnection();
      $("#network-status").textContent = result.message;
    } finally {
      button.disabled = !internetEnabled;
    }
  }),
);
$("#online-media-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const button = $("#import-media-button");
    button.disabled = true;
    $("#online-media-status").textContent =
      "Downloading media to this computer…";
    try {
      const file = await bridge.importOnlineMedia({
        url: $("#online-media-url").value,
        kind: $("#online-media-kind").value,
      });
      const source = newSource(file.type, file.name, {
        path: file.path,
        loop: true,
      });
      await loadMedia(source, file);
      commitSource(source);
      $("#online-media-dialog").close();
      notify("Media imported and saved locally.");
    } catch (error) {
      $("#online-media-status").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  })();
});
for (const [selector, key] of [
  ["#fps-setting", "fps"],
  ["#bitrate-setting", "bitrate"],
])
  $(selector).addEventListener("change", () => {
    project.settings[key] = Number($(selector).value);
    configureCanvas();
    queueSave();
  });
for (const selector of ["#open-recordings", "#settings-folder"])
  $(selector).addEventListener(
    "click",
    run(() => bridge.openRecordings()),
  );
$("#record-button").addEventListener("click", run(recordAction));
$("#pause-button").addEventListener("click", () => {
  if (!recording || recording.recorder.state === "inactive") return;
  if (recording.pauseStarted) {
    recording.pausedMs += Date.now() - recording.pauseStarted;
    recording.pauseStarted = null;
    recording.recorder.resume();
  } else {
    recording.pauseStarted = Date.now();
    recording.recorder.pause();
  }
  updateRecordingUI();
});
$("#snapshot-button").addEventListener(
  "click",
  run(async () => {
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("Could not capture the scene.");
    const saved = await bridge.saveSnapshot(await blob.arrayBuffer());
    if (saved) notify("Snapshot saved · " + saved.name);
  }),
);
$("#mic-toggle").addEventListener("click", run(toggleMicrophone));
$("#mic-device").addEventListener(
  "change",
  run(async () => {
    if (micStream) {
      await toggleMicrophone();
      await toggleMicrophone();
    }
  }),
);
for (const [name, getGain] of [
  ["mic", () => micGain],
  ["media", () => mediaGain],
])
  $("#" + name + "-volume").addEventListener("input", () => {
    const volume = Number($("#" + name + "-volume").value);
    const gain = getGain();
    if (gain) gain.gain.value = volume;
    $("#" + name + "-level").textContent = Math.round(volume * 100) + "%";
  });
$("#session-notes").addEventListener("input", () => {
  project.notes = $("#session-notes").value;
  queueSave();
});
$("#export-project").addEventListener(
  "click",
  run(async () => {
    if (await bridge.exportProject(project)) notify("Project exported.");
  }),
);
$("#import-project").addEventListener(
  "click",
  run(async () => {
    const incoming = await bridge.importProject();
    if (incoming) await loadProject(incoming);
  }),
);
new ResizeObserver(fitPreview).observe($("#stage"));
document.addEventListener("studio:add-guest-board", () => {
  if (!project) return;
  addSource("guest-board").catch(report);
});

setInterval(() => {
  for (const [analyser, target] of [
    [micAnalyser, "#mic-meter"],
    [mediaAnalyser, "#media-meter"],
  ]) {
    if (!analyser) continue;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    const rms = Math.sqrt(
      data.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) /
        data.length,
    );
    $(target).style.width = Math.min(100, rms * 260) + "%";
  }
  if (recording) {
    $("#record-clock").textContent = formatDuration(elapsed());
    $("#record-size").textContent =
      (recording.bytes / 1048576).toFixed(1) + " MB";
  }
}, 100);
setInterval(
  run(async () => {
    const stats = await bridge.getStats();
    $("#resource-stats").textContent =
      "CPU " +
      stats.cpuPercent.toFixed(1) +
      "% · Memory " +
      Math.round(stats.memoryMB) +
      " MB · Blocked requests " +
      stats.blockedRequests;
  }),
  3000,
);

window.addEventListener("beforeunload", () => {
  window.phoneStudio?.close();
  bridge.stopPhones().catch(() => {});
  clearTimeout(saveTimer);
  if (project) bridge.saveProject(project).catch(() => {});
  for (const id of resources.keys()) releaseResource(id);
  micStream?.getTracks().forEach((track) => track.stop());
  bridge.stopLive().catch(() => {});
});

bridge?.onCloseRequested(
  run(async () => {
    clearTimeout(saveTimer);
    if (project) await bridge.saveProject(project);
    await window.liveOutput?.stop();
    const active = recording;
    if (active && active.recorder.state !== "inactive") active.recorder.stop();
    if (active) await active.finished;
    await bridge.finishClose();
  }),
);

async function init() {
  if (!bridge)
    throw new Error(
      "Open this workspace using Local LIVE Studio.exe or npm start.",
    );
  const initial = await bridge.bootstrap();
  accountState = initial.account || accountState;
  window.giftBoard?.initialize(
    initial.gifts,
    accountState.user?.name || "Creator",
  );
  renderAccount();
  recordings = initial.recordings;
  internetEnabled = initial.network?.enabled !== false;
  window.tiktokConnection?.initialize(initial.tiktok);
  renderNetworkState();
  $("#output-location").textContent = "Saved to " + initial.outputDir;
  renderRecordings();
  await loadProject(initial.project);
  window.phoneStudio?.initialize(initial.phones, {
    monitorStream: async () => {
      await ensureAudio();
      const stream = canvas.captureStream(Math.min(24, project.settings.fps));
      audioDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track.clone()));
      return stream;
    },
    addCamera: async (stream, name) => {
      let sources = project.scenes.flatMap(scene => scene.sources).filter(source => source.type === 'phone-camera');
      let added;
      if (!currentScene().sources.some(source => source.type === 'phone-camera')) {
        added = newSource('phone-camera', name + ' camera', { width: Math.round(canvas.width * 0.45), height: Math.round(canvas.height * 0.65), x: Math.round(canvas.width * 0.5), y: Math.round(canvas.height * 0.15) });
        sources.push(added);
      }
      for (const source of sources) await activateCapture(source, stream.clone());
      if (added) commitSource(added); else renderWorkspace();
      notify('Phone camera connected. Review its position in your scene.');
    },
    removeCamera: () => {
      for (const scene of project.scenes) for (const source of scene.sources) if (source.type === 'phone-camera') releaseResource(source.id);
      renderProperties();
    },
  });
  window.phoneStudio?.setInternetEnabled(internetEnabled);
  window.liveOutput?.initialize(initial.live, {
    getSettings: () => ({ fps: project.settings.fps, bitrate: project.settings.bitrate }),
    createStream: async () => {
      await ensureAudio();
      const stream = canvas.captureStream(project.settings.fps);
      audioDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
      return stream;
    },
    lockControls: active => {
      for (const selector of ['#canvas-preset', '#fps-setting', '#bitrate-setting', '#import-project']) $(selector).disabled = active;
    },
    notify,
  });
  window.liveOutput?.setInternetEnabled(internetEnabled);
}
init().catch(report);
