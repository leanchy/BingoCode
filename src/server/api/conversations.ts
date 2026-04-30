/**
 * Conversation API Routes
 *
 * 提供对话交互的 REST 端点。实际的流式对话通过 WebSocket 处理，
 * 此处的 REST API 用于非流式操作与状态查询。
 *
 * Routes:
 *   POST /api/sessions/:id/chat        — 发送消息（入队）
 *   GET  /api/sessions/:id/chat/status  — 查询对话状态
 *   POST /api/sessions/:id/chat/stop    — 停止生成
 */

//@C:ID=M.CA.conversationAPI;K=M;V=1.0;P=Import dependencies;D=API;M=Conversations;S=REST
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { sessionService } from '../services/sessionService.js'

//@C:ID=D.CA.SessionState;K=D;V=1.0;P=In-memory conversation state storage;D=API;M=Conversations;S=StateManagement
// In-memory conversation state per session
const sessionStates = new Map<string, 'idle' | 'thinking' | 'tool_executing'>()

//@C:ID=E.CA.handleConversationsApi;K=E;V=1.0;P=Main API handler for conversation endpoints;D=API;M=Conversations;S=REST;Provider=ConversationsAPI;Consumer=Frontend;In=Request;Out=Response
export async function handleConversationsApi(
  req: Request,
  url: URL,
  segments: string[]
): Promise<Response> {
  console.log("E.CA.handleConversationsApi");
  
  try {
    ///@C:CA.ParseRoute
    // segments: ['api', 'sessions', ':id', 'chat', ...rest]
    // or:       ['api', 'conversations', ...]
    //
    // When routed through the sessions handler:
    //   segments = ['api', 'sessions', sessionId, 'chat', subAction?]
    // When routed directly via /api/conversations:
    //   segments = ['api', 'conversations', sessionId, subAction?]

    let sessionId: string | undefined
    let subAction: string | undefined

    if (segments[1] === 'sessions') {
      // /api/sessions/:id/chat[/status|/stop]
      sessionId = segments[2]
      // segments[3] === 'chat'
      subAction = segments[4]
    } else {
      // /api/conversations/:id[/status|/stop]
      sessionId = segments[2]
      subAction = segments[3]
    }

    if (!sessionId) {
      throw ApiError.badRequest('Session ID is required')
    }

    ///@C:CA.RouteToAction
    // -----------------------------------------------------------------------
    // GET /chat/status
    // -----------------------------------------------------------------------
    if (subAction === 'status' && req.method === 'GET') {
      return getChatStatus(sessionId)
    }

    // -----------------------------------------------------------------------
    // POST /chat/stop
    // -----------------------------------------------------------------------
    if (subAction === 'stop' && req.method === 'POST') {
      return stopChat(sessionId)
    }

    // -----------------------------------------------------------------------
    // POST /chat (send message)
    // -----------------------------------------------------------------------
    if (!subAction) {
      if (req.method !== 'POST') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await sendMessage(req, sessionId)
    }

    return Response.json(
      { error: 'NOT_FOUND', message: `Unknown chat sub-resource: ${subAction}` },
      { status: 404 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}

//@C:ID=F.CA.sendMessage;K=F;V=1.0;P=Handle sending a message;D=API;M=Conversations;S=MessageProcessing;In=Request,string;Out=Promise<Response>
// ============================================================================
// Handler implementations
// ============================================================================
async function sendMessage(req: Request, sessionId: string): Promise<Response> {
  console.log("F.CA.sendMessage");
  
  ///@C:CA.ValidateSession
  // Validate session exists
  const session = await sessionService.getSession(sessionId)
  if (!session) {
    throw ApiError.notFound(`Session not found: ${sessionId}`)
  }

  ///@C:CA.ParseRequestBody
  let body: { content?: string }
  try {
    body = (await req.json()) as { content?: string }
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  if (!body.content || typeof body.content !== 'string') {
    throw ApiError.badRequest('content (string) is required in request body')
  }

  ///@C:CA.QueueMessage
  const messageId = crypto.randomUUID()

  // Mark session as thinking — actual processing happens through WebSocket
  sessionStates.set(sessionId, 'thinking')

  return Response.json(
    { messageId, status: 'queued' as const },
    { status: 202 }
  )
}

//@C:ID=F.CA.getChatStatus;K=F;V=1.0;P=Get current chat processing status;D=API;M=Conversations;S=StateManagement;In=string;Out=Response
function getChatStatus(sessionId: string): Response {
  console.log("F.CA.getChatStatus");
  
  const state = sessionStates.get(sessionId) || 'idle'
  return Response.json({ state })
}

//@C:ID=F.CA.stopChat;K=F;V=1.0;P=Stop ongoing chat generation;D=API;M=Conversations;S=Control;In=string;Out=Response
function stopChat(sessionId: string): Response {
  console.log("F.CA.stopChat");
  
  // Reset to idle — in a full implementation this would signal the
  // WebSocket handler / subprocess to abort the current generation.
  sessionStates.set(sessionId, 'idle')
  return Response.json({ ok: true })
}

//@C:ID=F.CA.setSessionChatState;K=F;V=1.0;P=Update session chat state;D=API;M=Conversations;S=StateManagement;In=string,string;Out=void
// ============================================================================
// Helpers for WebSocket integration (exported for use by ws/handler)
// ============================================================================
export function setSessionChatState(
  sessionId: string,
  state: 'idle' | 'thinking' | 'tool_executing'
): void {
  console.log("F.CA.setSessionChatState");
  
  sessionStates.set(sessionId, state)
}

//@C:ID=F.CA.getSessionChatState;K=F;V=1.0;P=Get current session chat state;D=API;M=Conversations;S=StateManagement;In=string;Out=string
export function getSessionChatState(
  sessionId: string
): 'idle' | 'thinking' | 'tool_executing' {
  console.log("F.CA.getSessionChatState");
  
  return sessionStates.get(sessionId) || 'idle'
}