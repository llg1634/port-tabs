const portInput = document.getElementById("port");
const profileNameInput = document.getElementById("profileName");
const profileNoteInput = document.getElementById("profileNote");
const saveButton = document.getElementById("save");
const reconnectButton = document.getElementById("reconnect");
const statusEl = document.getElementById("status");
const urlEl = document.getElementById("url");
const connectionEl = document.getElementById("connection");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#9f1d1d" : "#1e5f46";
}

function send(message) {
  return chrome.runtime.sendMessage({
    target: "port-tabs",
    ...message
  });
}

function render(data) {
  if (!data || !data.ok) {
    setStatus(data && data.error ? data.error : "Unknown error", true);
    return;
  }

  portInput.value = data.port;
  profileNameInput.value = data.profileName || "";
  profileNoteInput.value = data.profileNote || "";
  urlEl.textContent = `${data.apiBaseUrl}/help`;
  connectionEl.textContent = data.connected
    ? `Native host connected: ${data.displayName || data.profileName || data.port}`
    : "Native host not connected";
}

async function refresh() {
  try {
    render(await send({ type: "getStatus" }));
  } catch (error) {
    setStatus(error.message, true);
  }
}

saveButton.addEventListener("click", async () => {
  try {
    const result = await send({
      type: "setProfile",
      port: Number(portInput.value),
      profileName: profileNameInput.value,
      profileNote: profileNoteInput.value
    });
    render(result);
    setStatus(`Saved ${result.displayName || result.port} on ${result.apiBaseUrl}`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

reconnectButton.addEventListener("click", async () => {
  try {
    const result = await send({ type: "reconnect" });
    render(result);
    setStatus("Reconnect requested.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

refresh();

