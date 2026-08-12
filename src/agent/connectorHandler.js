// src/agent/connectorHandler.js
// Handles connector actions from RTDB
// test, save, remove — all handled here

const {
  testConnector,
  saveConnector,
  removeConnector,
  getConnectorStatus,
  CONNECTOR_DEFS,
} = require("./connectors");

// Handle connector action from RTDB
async function handleConnectorAction(action, workspaceId, rtdbSet, rtdbPatch) {
  const { action: type, provider, apiKey, model, sentAt } = action;

  // Ignore old actions (older than 30s)
  if (Date.now() - (sentAt || 0) > 30000) return;

  console.log(`🔌 Connector action: ${type} → ${provider}`);

  if (type === "test") {
    const result = await testConnector(provider, apiKey);
    await rtdbSet(`workspaces/${workspaceId}/connectorTestResult`, {
      provider,
      success:  result.success,
      model:    result.model || CONNECTOR_DEFS[provider]?.defaultModel,
      error:    result.error || null,
      testedAt: Date.now(),
    });
    console.log(`🔌 Test ${provider}: ${result.success ? "✅" : "❌ " + result.error}`);
    return;
  }

  if (type === "save") {
    const saved = await saveConnector(provider, apiKey, model);
    if (saved) {
      // Sync updated status to RTDB
      const status = await getConnectorStatus();
      await rtdbSet(`workspaces/${workspaceId}/connectors`, status);
      console.log(`✅ Connector saved + synced: ${provider}`);
    }
    return;
  }

  if (type === "remove") {
    await removeConnector(provider);
    const status = await getConnectorStatus();
    await rtdbSet(`workspaces/${workspaceId}/connectors`, status);
    console.log(`🗑️ Connector removed: ${provider}`);
    return;
  }
}

// Sync all connector status to RTDB on startup
async function syncConnectorsToRTDB(workspaceId, rtdbSet) {
  try {
    const status = await getConnectorStatus();
    if (Object.keys(status).length > 0) {
      await rtdbSet(`workspaces/${workspaceId}/connectors`, status);
      console.log(`🔌 Connectors synced: ${Object.keys(status).length} connected`);
    }
  } catch (err) {
    console.error("Connector sync error:", err.message);
  }
}

module.exports = { handleConnectorAction, syncConnectorsToRTDB };