const { nanoid } = require('nanoid');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const { Callback, ToolEndHandler, formatAgentMessages } = require('@librechat/agents');
const {
  EModelEndpoint,
  ResourceType,
  PermissionBits,
  hasPermissions,
} = require('librechat-data-provider');
const {
  createRun,
  buildToolSet,
  createSafeUser,
  initializeAgent,
  getBalanceConfig,
  recordCollectedUsage,
  getTransactionsConfig,
  createToolExecuteHandler,
  discoverConnectedAgents,
  getRemoteAgentPermissions,
  writeDone,
  buildResponse,
  generateResponseId,
  isValidationFailure,
  emitResponseCreated,
  createResponseContext,
  createResponseTracker,
  setupStreamingResponse,
  emitResponseInProgress,
  convertInputToMessages,
  validateResponseRequest,
  buildAggregatedResponse,
  createResponseAggregator,
  sendResponsesErrorResponse,
  createResponsesEventHandlers,
  createAggregatorEventHandlers,
} = require('@librechat/api');

const {
  createResponsesToolEndCallback,
  buildSummarizationHandlers,
  markSummarizationUsage,
  createToolEndCallback,
  agentLogHandlerObj,
} = require('~/server/controllers/agents/callbacks');

const {
  loadAgentTools,
  loadToolsForExecution,
} = require('~/server/services/ToolService');

const {
  findAccessibleResources,
  getEffectivePermissions,
} = require('~/server/services/PermissionService');

const { getModelsConfig } = require('~/server/controllers/ModelController');
const { logViolation } = require('~/cache');
const db = require('~/models');

/* ============================
   🔥 ARTIFACT INTEGRATION LAYER
   ============================ */

const { generateArtifact } = require('../../services/Artifacts/artifactService');

/**
 * Extract text safely from response
 */
function extractText(response) {
  let text = '';

  try {
    if (response?.output) {
      for (const item of response.output) {
        if (item?.type === 'message' && item?.content) {
          for (const part of item.content) {
            if (part?.type === 'output_text') {
              text += part.text || '';
            }
          }
        }
      }
    }
  } catch (e) {}

  return text;
}

/**
 * Attach artifact (PPT/DOC/PDF) to response
 */
async function attachArtifact(response, conversationId) {
  try {
    const text = extractText(response);

    if (!text || text.trim().length < 10) {
      return response;
    }

    const artifact = await generateArtifact({
      text,
      conversationId,
    });

    if (artifact) {
      response.artifact = artifact;
    }
  } catch (err) {
    logger.warn('[Artifacts] generation failed', err);
  }

  return response;
}

/* ============================
   TOOL LOADER
   ============================ */

function createToolLoader(signal, definitionsOnly = true) {
  return async function loadTools({
    req,
    res,
    tools,
    model,
    agentId,
    provider,
    tool_options,
    tool_resources,
  }) {
    const agent = { id: agentId, tools, provider, model, tool_options };
    try {
      return await loadAgentTools({
        req,
        res,
        agent,
        signal,
        tool_resources,
        definitionsOnly,
        streamId: null,
      });
    } catch (error) {
      logger.error('Error loading tools', error);
    }
  };
}

/* ============================
   MESSAGE HELPERS
   ============================ */

function convertToInternalMessages(input) {
  return convertInputToMessages(input);
}

async function loadPreviousMessages(conversationId, userId) {
  try {
    const messages = await db.getMessages({ conversationId, user: userId });
    if (!messages?.length) return [];

    return messages.map((msg) => ({
      role: msg.isCreatedByUser ? 'user' : 'assistant',
      content: msg.text || '',
      messageId: msg.messageId,
    }));
  } catch (error) {
    logger.error('[Responses API] load error:', error);
    return [];
  }
}

/* ============================
   SAVE HELPERS
   ============================ */

async function saveInputMessages(req, conversationId, inputMessages, agentId) {
  for (const msg of inputMessages) {
    if (msg.role === 'user') {
      await db.saveMessage(req, {
        messageId: msg.messageId || nanoid(),
        conversationId,
        isCreatedByUser: true,
        text: msg.content,
        sender: 'User',
        endpoint: EModelEndpoint.agents,
        model: agentId,
      });
    }
  }
}

async function saveResponseOutput(req, conversationId, responseId, response, agentId) {
  let text = extractText(response);

  await db.saveMessage(req, {
    messageId: responseId,
    conversationId,
    isCreatedByUser: false,
    text,
    sender: 'Agent',
    endpoint: EModelEndpoint.agents,
    model: agentId,
  });
}

/* ============================
   MAIN CONTROLLER
   ============================ */

const createResponse = async (req, res) => {
  const validation = validateResponseRequest(req.body);
  if (isValidationFailure(validation)) {
    return sendResponsesErrorResponse(res, 400, validation.error);
  }

  const request = validation.request;
  const agentId = request.model;
  const isStreaming = request.stream === true;

  const agent = await db.getAgent({ id: agentId });
  if (!agent) {
    return sendResponsesErrorResponse(res, 404, 'Agent not found');
  }

  const responseId = generateResponseId();
  const conversationId = request.previous_response_id ?? uuidv4();

  const abortController = new AbortController();

  try {
    const previousMessages = request.previous_response_id
      ? await loadPreviousMessages(request.previous_response_id, req.user.id)
      : [];

    const inputMessages = convertToInternalMessages(request.input);
    const allMessages = [...previousMessages, ...inputMessages];

    const toolSet = buildToolSet({ tools: agent.tools || [] });

    const { messages: formattedMessages, indexTokenCountMap } =
      formatAgentMessages(allMessages, {}, toolSet);

    const run = await createRun({
      agents: [{ ...agent }],
      messages: formattedMessages,
      indexTokenCountMap,
      runId: responseId,
      signal: abortController.signal,
    });

    if (!run) throw new Error('Run failed');

    /* ============================
       STREAMING MODE
       ============================ */

    if (isStreaming) {
      setupStreamingResponse(res);
      emitResponseCreated({ res });
      emitResponseInProgress({ res });

      const tracker = createResponseTracker();

      const handlers = createResponsesEventHandlers({
        res,
        tracker,
        context: {},
      });

      await run.processStream({ messages: formattedMessages }, {}, {
        callbacks: {
          on_message_delta: handlers.on_message_delta,
          on_chat_model_end: handlers.on_chat_model_end,
        },
      });

      let finalResponse = buildResponse({}, tracker, 'completed');

      // 🔥 ARTIFACT HOOK
      finalResponse = await attachArtifact(finalResponse, conversationId);

      res.write(JSON.stringify(finalResponse));
      res.end();
    }

    /* ============================
       NON-STREAMING MODE
       ============================ */

    else {
      const aggregator = createResponseAggregator();

      const handlers = createAggregatorEventHandlers(aggregator);

      await run.processStream({ messages: formattedMessages }, {}, {
        callbacks: {
          on_message_delta: handlers.on_message_delta,
          on_chat_model_end: handlers.on_chat_model_end,
        },
      });

      let response = buildAggregatedResponse({}, aggregator);

      // 🔥 ARTIFACT HOOK
      response = await attachArtifact(response, conversationId);

      if (request.store) {
        await saveInputMessages(req, conversationId, inputMessages, agentId);
        await saveResponseOutput(req, conversationId, responseId, response, agentId);
      }

      res.json(response);
    }
  } catch (error) {
    logger.error(error);
    return sendResponsesErrorResponse(res, 500, error.message);
  }
};

/* ============================
   EXPORTS
   ============================ */

module.exports = {
  createResponse,
};
