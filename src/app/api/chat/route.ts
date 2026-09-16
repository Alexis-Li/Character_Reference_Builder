import { NextRequest } from 'next/server';
import { streamText, convertToModelMessages, UIMessage, stepCountIs } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createChatTools, buildEditSystemPrompt } from '@/lib/chat/tools';
import { buildWorkflowContext } from '@/lib/chat/contextBuilder';
import { extractSubgraph } from '@/lib/chat/subgraphExtractor';
import { WorkflowNode } from '@/types';
import { WorkflowEdge } from '@/types/workflow';
import { withPrivilegedApi } from '@/lib/security/requestGuard.server';
import { redactSecretsDeep, redactSecretsInText } from '@/lib/security/secretRedaction';

export const maxDuration = 60; // 1 minute timeout

/**
 * Bills a server-held Gemini credential; caller-supplied message parts are
 * forwarded to the model, so image bytes can leave the process from here too.
 */
export const POST = withPrivilegedApi(
  ['cloud-request', 'design-reference-upload'],
  async (request: NextRequest) => {
  try {
    const { messages, workflowState, selectedNodeIds } = await request.json() as {
      messages: UIMessage[];
      workflowState?: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
      selectedNodeIds?: string[];
    };

    // Get API key from environment
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response('GEMINI_API_KEY not configured', { status: 500 });
    }

    // Extract subgraph if nodes are selected, otherwise use full workflow
    const subgraph = extractSubgraph(
      workflowState?.nodes || [],
      workflowState?.edges || [],
      selectedNodeIds || []
    );

    // Build workflow context from selected subgraph
    const context = buildWorkflowContext(
      subgraph.selectedNodes,
      subgraph.selectedEdges
    );

    // Build context-aware system prompt with optional rest summary
    const systemPrompt = buildEditSystemPrompt(context, subgraph.restSummary);

    // Extract node IDs for tool validation
    const nodeIds = (workflowState?.nodes || []).map(n => n.id);

    // Create chat tools with current workflow context
    const tools = createChatTools(nodeIds);

    // Create Google provider with API key
    const google = createGoogleGenerativeAI({ apiKey });

    // Convert UI messages to model messages format
    const modelMessages = await convertToModelMessages(messages);

    // Create streaming response with tool calling
    const result = streamText({
      model: google('gemini-3-flash-preview'),
      system: systemPrompt,
      messages: modelMessages,
      tools: tools,
      toolChoice: 'auto', // Let LLM decide which tool to use
      stopWhen: stepCountIs(3), // Allow multi-step reasoning for complex requests
    });

    // Return the UI message stream response for useChat compatibility
    return result.toUIMessageStreamResponse();
  } catch (error) {
    // Console output can leave the machine (log shippers, scrollback), and AI
    // SDK errors carry the request URL and body: redact before printing.
    console.error(
      '[Chat API Error]',
      redactSecretsDeep(
        error instanceof Error
          ? { ...error, name: error.name, message: error.message, stack: error.stack }
          : error
      )
    );

    if (error instanceof Error && error.message.includes('429')) {
      return new Response('Rate limit reached. Please wait and try again.', { status: 429 });
    }

    // Check for token/size errors and return 413
    if (error instanceof Error) {
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes('too large') || errorMsg.includes('token limit') || errorMsg.includes('payload') || errorMsg.includes('request entity too large')) {
        return new Response('This workflow is too large for the AI to process. Try selecting fewer nodes.', { status: 413 });
      }
    }

    return new Response(
      error instanceof Error ? redactSecretsInText(error.message) : 'Chat request failed',
      { status: 500 }
    );
  }
});
