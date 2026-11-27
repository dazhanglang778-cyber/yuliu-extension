const keyInput = document.querySelector("#apiKey");
const status = document.querySelector("#status");
const toggleKey = document.querySelector("#toggleKey");
const saveButton = document.querySelector("#save");
const diagnosticsToggle = document.querySelector("#diagnosticsEnabled");
const openDiagnostics = document.querySelector("#openDiagnostics");
const providerSelect = document.querySelector('#provider');
const openaiModelSelect = document.querySelector('#openaiModel');
const testOpenAI = document.querySelector('#testOpenAI');
const testStatus = document.querySelector('#testStatus');
function keyName() { return providerSelect.value === 'openai' ? 'openaiApiKey' : 'bigmodelApiKey'; }
let keyLoadSequence = 0;

if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.runtime?.getManifest) {
  status.textContent = "打开方式不对：请关闭这个标签页，点击 Chrome 工具栏中的“语”图标打开设置。";
  status.style.color = "#b13d35";
  keyInput.disabled = true;
  saveButton.disabled = true;
  toggleKey.disabled = true;
  diagnosticsToggle.disabled = true;
  openDiagnostics.disabled = true;
  providerSelect.disabled = true;
  testOpenAI.disabled = true;
} else {
  document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;
  chrome.storage.local.get(['modelProvider','openaiModel']).then(saved => {
    providerSelect.value = saved.modelProvider === 'openai' ? 'openai' : 'bigmodel';
    openaiModelSelect.value = YuliuOpenAI.MODELS.includes(saved.openaiModel) ? saved.openaiModel : YuliuOpenAI.DEFAULT_MODEL;
    loadSavedKey();
  });
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
  const sequence = ++keyLoadSequence;
  const name = keyName();
  keyInput.value = '';
  keyInput.type = 'password';
  toggleKey.textContent = '显示';
  document.querySelector('#keyLabel').textContent = providerSelect.value === 'openai' ? 'OpenAI API Key' : '智谱 API Key';
  document.querySelector('#openaiOptions').hidden = providerSelect.value !== 'openai';
  testOpenAI.hidden = providerSelect.value !== 'openai';
  testStatus.textContent = '';
  saveButton.disabled = true;
  try {
    const savedKey = await chrome.storage.local.get(name);
    if (sequence !== keyLoadSequence) return;
    const bigmodelApiKey = savedKey[name] || '';
    keyInput.value = bigmodelApiKey;
    if (bigmodelApiKey) {
      status.textContent = "此平台已有密钥。切换服务商或模型后，请点击保存使其生效。";
      document.querySelector("#save").textContent = "更新已保存的 API Key";
    } else {
      status.textContent = "尚未保存 API Key。";
      status.style.color = "#8a7760";
    }
  } catch (_) {
    status.textContent = "没有读取到保存状态，请重新加载插件后再试。";
    status.style.color = "#b13d35";
  } finally { if (sequence === keyLoadSequence) saveButton.disabled = false; }
}
providerSelect.addEventListener('change', loadSavedKey);
openaiModelSelect.addEventListener('change', () => { testStatus.textContent = '模型已更改，请先保存再测试。'; });
testOpenAI.addEventListener('click', async () => {
  testOpenAI.disabled = true;
  testStatus.textContent = '正在测试已保存的模型，仅发送“连接成功”测试句……';
  try {
    const saved = await chrome.storage.local.get(['openaiModel','modelProvider']);
    if (saved.modelProvider !== 'openai' || (saved.openaiModel || YuliuOpenAI.DEFAULT_MODEL) !== openaiModelSelect.value) {
      testStatus.textContent = '服务商或模型尚未保存，请先点击保存，再测试当前选择的模型。'; return;
    }
    const result = await chrome.runtime.sendMessage({type:'OPENAI_CONNECTION_TEST'});
    testStatus.textContent = result?.ok ? `连接成功：${result.model}。输入 ${result.usage?.input_tokens ?? '?'}、输出 ${result.usage?.output_tokens ?? '?'} token（其中推理 ${result.usage?.output_tokens_details?.reasoning_tokens ?? 0}）。这里只验证接口可用，不代表解释质量已通过。`
      : result?.error || '未收到响应，请重新加载扩展。';
  } catch (_) { testStatus.textContent = '连接测试未完成，请重新加载扩展后再试。'; }
  finally { testOpenAI.disabled = false; }
});

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
    if ((providerSelect.value === 'openai') !== value.startsWith('sk-')) {
      status.textContent = '密钥与所选平台不符：OpenAI 密钥应以 sk- 开头，请核对。'; return;
    }
    const name = keyName();
    await chrome.storage.local.set({ [name]: value, modelProvider:providerSelect.value,openaiModel:openaiModelSelect.value });
    const saved = await chrome.storage.local.get(name);
    if (saved[name] !== value) throw new Error("save verification failed");
    status.textContent = "保存成功。以后无需再次打开这里，直接在网页中使用。";
    status.style.color = "#357a46";
    document.querySelector("#save").textContent = "更新已保存的 API Key";
  } catch (_) {
    status.textContent = "保存没有成功，请重新加载插件后再试。";
    status.style.color = "#b13d35";
  }
});
