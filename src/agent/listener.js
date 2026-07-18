// src/agent/listener.js
const { executeCommand } = require("./brain");

const POLL_INTERVAL = 3000;

function startCommandListener(workspaceId, firebaseConfig, modelConfig) {
  const BASE    = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const API_KEY = firebaseConfig.apiKey;

  console.log(`\n✅ Command listener started`);
  console.log(`   Workspace : ${workspaceId}`);
  console.log(`   Model     : ${modelConfig.ollamaId}`);
  console.log(`   Vision    : ${modelConfig.visionEnabled ? "ON - " + modelConfig.visionOllamaId : "OFF"}`);
  console.log(`   Polling every ${POLL_INTERVAL / 1000}s...\n`);

  const poll = setInterval(async () => {
    try {
      const url = `${BASE}/agent_connections/${workspaceId}/commands?key=${API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return;

      const data = await res.json();
      if (!data.documents?.length) return;

      for (const docSnap of data.documents) {
        const fields    = docSnap.fields;
        const status    = fields?.status?.stringValue;
        const command   = fields?.command?.stringValue;
        const chatId    = fields?.chatId?.stringValue;
        const messageId = fields?.messageId?.stringValue;
        const docId     = docSnap.name.split("/").pop();

        if (status !== "pending" || !command) continue;

        console.log(`\n🎯 Executing: "${command}"`);
        await updateCommandStatus(workspaceId, docId, "processing", firebaseConfig);

        try {
          const result = await executeCommand(command, modelConfig);

          if (chatId && messageId) {
            await updateMessage(workspaceId, chatId, messageId,
              result.message || "Done!", result.success ? "done" : "error",
              result.screenshot, firebaseConfig);
          }

          await updateCommandStatus(workspaceId, docId, "completed", firebaseConfig);

          if (result.screenshot) {
            await saveScreenshot(workspaceId, result.screenshot, firebaseConfig);
          }
        } catch (err) {
          console.error(`❌ Error: ${err.message}`);
          if (chatId && messageId) {
            await updateMessage(workspaceId, chatId, messageId,
              `Failed: ${err.message}`, "error", null, firebaseConfig);
          }
          await updateCommandStatus(workspaceId, docId, "failed", firebaseConfig);
        }
      }
    } catch (err) {
      console.error(`❌ Listener error: ${err.message}`);
    }
  }, POLL_INTERVAL);

  return poll;
}

async function updateCommandStatus(workspaceId, docId, status, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/commands/${docId}?key=${firebaseConfig.apiKey}&updateMask.fieldPaths=status`;
  try {
    await fetch(url, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { status: { stringValue: status } } }),
    });
  } catch {}
}

async function updateMessage(workspaceId, chatId, messageId, content, status, screenshot, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/chats/${chatId}/messages/${messageId}?key=${firebaseConfig.apiKey}`;
  try {
    const fields = {
      content: { stringValue: content },
      status:  { stringValue: status },
    };
    if (screenshot) fields.screenshot = { stringValue: screenshot };
    await fetch(url, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
  } catch {}
}

async function saveScreenshot(workspaceId, screenshot, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/screenshots/latest?key=${firebaseConfig.apiKey}`;
  try {
    await fetch(url, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          data:    { stringValue: screenshot },
          takenAt: { stringValue: new Date().toISOString() },
        },
      }),
    });
  } catch {}
}

module.exports = { startCommandListener };