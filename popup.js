const keyInput = document.querySelector("#apiKey");
const status = document.querySelector("#status");
const toggleKey = document.querySelector("#toggleKey");
const saveButton = document.querySelector("#save");
const diagnosticsToggle = document.querySelector("#diagnosticsEnabled");
const openDiagnostics = document.querySelector("#openDiagnostics");

if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.runtime?.getManifest) {
  status.textContent = "打开方式不对：请关闭这个标签页，点击 Chrome 工具栏中的“语”图标打开设置。";
  status.style.color = "#b13d35";
  keyInput.disabled = true;
  saveButton.disabled = true;
  toggleKey.disabled = true;
  diagnosticsToggle.disabled = true;
  openDiagnostics.disabled = true;
} else {
  document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;
  loadSavedKey();
  loadDiagnosticsSetting();
}

async function loadDiagnosticsSetting() {
  const { diagnosticsEnabled = false } = await chrome.storage.local.get("diagnosticsEnabled");
  diagnosticsToggle.checked = diagnosticsEnabled === true;
}

diagnosticsToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ diagnosticsEnabled: diagnosticsToggle.checked });
});

openDiagnostics.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("diagnostics.html") });
});

async function loadSavedKey() {
  try {
    const { bigmodelApiKey = "" } = await chrome.storage.local.get("bigmodelApiKey");
    keyInput.value = bigmodelApiKey;
    if (bigmodelApiKey) {
      status.textContent = "已保存。以后直接选中文字使用，无需再次填写。";
      document.querySelector("#save").textContent = "更新已保存的 API Key";
    } else {
      status.textContent = "尚未保存 API Key。";
      status.style.color = "#8a7760";
    }
  } catch (_) {
    status.textContent = "没有读取到保存状态，请重新加载插件后再试。";
    status.style.color = "#b13d35";
  }
}

toggleKey.addEventListener("click", () => {
  const showing = keyInput.type === "text";
  keyInput.type = showing ? "password" : "text";
  toggleKey.textContent = showing ? "显示" : "隐藏";
});

saveButton.addEventListener("click", async () => {
  const value = keyInput.value.trim();
  if (!value) {
    status.textContent = "请先粘贴 API Key。";
    status.style.color = "#b13d35";
    return;
  }
  try {
    await chrome.storage.local.set({ bigmodelApiKey: value });
    const saved = await chrome.storage.local.get("bigmodelApiKey");
    if (saved.bigmodelApiKey !== value) throw new Error("save verification failed");
    status.textContent = "保存成功。以后无需再次打开这里，直接在网页中使用。";
    status.style.color = "#357a46";
    document.querySelector("#save").textContent = "更新已保存的 API Key";
  } catch (_) {
    status.textContent = "保存没有成功，请重新加载插件后再试。";
    status.style.color = "#b13d35";
  }
});
