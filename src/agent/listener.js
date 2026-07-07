// src/agent/listener.js
// Listens to Firestore for commands from dashboard and executes them

const { executeCommand } = require("./brain");

const POLL_INTERVAL = 3000; // Check every 3 seconds

// ── Listen for commands ───────────────────────────────────
function startCommandListener(workspaceId, firebaseConfig) {
  const BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  const API_KEY = firebaseConfig.apiKey;

  console.log(`Listening for commands on workspace: ${workspaceId}`);

  const poll = setInterval(async () => {
    try {
      // Get pending commands
      const url = `${BASE}/agent_connections/${workspaceId}/commands?key=${API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.documents) return;

      for (const docSnap of data.documents) {
        const fields = docSnap.fields;
        const status = fields?.status?.stringValue;
        const command = fields?.command?.stringValue;
        const chatId = fields?.chatId?.stringValue;
        const messageId = fields?.messageId?.stringValue;
        const docId = docSnap.name.split("/").pop();

        if (status !== "pending" || !command) continue;

        console.log(`\nNew command received: "${command}"`);

        // Mark as processing
        await updateCommandStatus(workspaceId, docId, "processing", firebaseConfig);

        // Execute the command
        try {
          const result = await executeCommand(command);

          // Update the thinking message with result
          if (chatId && messageId) {
            await updateMessage(
              workspaceId, chatId, messageId,
              result.message || "Done!",
              result.success ? "done" : "error",
              result.screenshot,
              firebaseConfig
            );
          }

          // Mark command as done
          await updateCommandStatus(workspaceId, docId, "completed", firebaseConfig);

          // Save screenshot to Firestore for live view
          if (result.screenshot) {
            await saveScreenshot(workspaceId, result.screenshot, firebaseConfig);
          }

        } catch (err) {
          console.error("Command execution error:", err);
          if (chatId && messageId) {
            await updateMessage(
              workspaceId, chatId, messageId,
              `Error: ${err.message}`,
              "error",
              null,
              firebaseConfig
            );
          }
          await updateCommandStatus(workspaceId, docId, "failed", firebaseConfig);
        }
      }
    } catch (err) {
      // Silent fail — network issue, try again next poll
    }
  }, POLL_INTERVAL);

  return poll;
}

// ── Update command status ─────────────────────────────────
async function updateCommandStatus(workspaceId, docId, status, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/commands/${docId}?key=${firebaseConfig.apiKey}&updateMask.fieldPaths=status`;

  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: { status: { stringValue: status } },
    }),
  });
}

// ── Update message in chat ────────────────────────────────
async function updateMessage(workspaceId, chatId, messageId, content, status, screenshot, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/chats/${chatId}/messages/${messageId}?key=${firebaseConfig.apiKey}`;

  const fields = {
    content: { stringValue: content },
    status: { stringValue: status },
  };

  if (screenshot) {
    fields.screenshot = { stringValue: screenshot };
  }

  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
}

// ── Save latest screenshot for live view ─────────────────
async function saveScreenshot(workspaceId, screenshot, firebaseConfig) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/agent_connections/${workspaceId}/screenshots/latest?key=${firebaseConfig.apiKey}`;

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
}

module.exports = { startCommandListener };