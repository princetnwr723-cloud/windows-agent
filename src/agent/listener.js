// src/agent/listener.js
const { executeCommand } = require("./brain");

const POLL_INTERVAL = 3000;

function startCommandListener(workspaceId, firebaseConfig) {
  const BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const API_KEY = firebaseConfig.apiKey;

  console.log(`\n✅ Command listener started`);
  console.log(`   Workspace: ${workspaceId}`);
  console.log(`   Project: ${firebaseConfig.projectId}`);
  console.log(`   Polling every ${POLL_INTERVAL / 1000}s...\n`);

  const poll = setInterval(async () => {
    try {
      const url = `${BASE}/agent_connections/${workspaceId}/commands?key=${API_KEY}`;
      const res = await fetch(url);

      if (!res.ok) {
        console.error(`❌ Firestore fetch failed: ${res.status} ${res.statusText}`);
        return;
      }

      const data = await res.json();
      if (!data.documents || data.documents.length === 0) return;

      console.log(`📋 Found ${data.documents.length} command(s)`);

      for (const docSnap of data.documents) {
        const fields = docSnap.fields;
        const status = fields?.status?.stringValue;
        const command = fields?.command?.stringValue;
        const chatId = fields?.chatId?.stringValue;
        const messageId = fields?.messageId?.stringValue;
        const docId = docSnap.name.split("/").pop();

        console.log(`   → Doc: ${docId}, Status: ${status}, Command: "${command}"`);

        // Only process pending commands
        if (status !== "pending" || !command) {
          console.log(`   ⏭️  Skipping — status is ${status}`);
          continue;
        }

        console.log(`\n🎯 Executing: "${command}"`);

        // Mark as processing immediately
        await updateCommandStatus(workspaceId, docId, "processing", firebaseConfig);

        try {
          const result = await executeCommand(command);

          console.log(`✅ Result: ${result.message}`);
          console.log(`   Success: ${result.success}`);

          // Update chat message
          if (chatId && messageId) {
            await updateMessage(
              workspaceId, chatId, messageId,
              result.message || "Task completed!",
              result.success ? "done" : "error",
              result.screenshot,
              firebaseConfig
            );
          }

          // Mark command done
          await updateCommandStatus(workspaceId, docId, "completed", firebaseConfig);

          // Save screenshot for live view
          if (result.screenshot) {
            await saveScreenshot(workspaceId, result.screenshot, firebaseConfig);
            console.log(`📸 Screenshot saved for live view`);
          }

        } catch (err) {
          console.error(`❌ Execution error: ${err.message}`);

          if (chatId && messageId) {
            await updateMessage(
              workspaceId, chatId, messageId,
              `Failed: ${err.message}`,
              "error", null, firebaseConfig
            );
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
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { status: { stringValue: status } } }),
    });
    if (!res.ok) console.error(`❌ Status update failed: ${res.status}`);
    else console.log(`   Status → ${status}`);
  } catch (err) {
    console.error(`❌ Status update error: ${err.message}`);
  }
}

async function updateMessage(workspaceId, chatId, messageId, content, status, screenshot, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/chats/${chatId}/messages/${messageId}?key=${firebaseConfig.apiKey}`;
  try {
    const fields = {
      content: { stringValue: content },
      status: { stringValue: status },
    };
    if (screenshot) fields.screenshot = { stringValue: screenshot };

    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) console.error(`❌ Message update failed: ${res.status}`);
    else console.log(`   💬 Chat message updated: "${content.slice(0, 50)}..."`);
  } catch (err) {
    console.error(`❌ Message update error: ${err.message}`);
  }
}

async function saveScreenshot(workspaceId, screenshot, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/screenshots/latest?key=${firebaseConfig.apiKey}`;
  try {
    await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          data: { stringValue: screenshot },
          takenAt: { stringValue: new Date().toISOString() },
        },
      }),
    });
  } catch (err) {
    console.error(`❌ Screenshot save error: ${err.message}`);
  }
}

module.exports = { startCommandListener };