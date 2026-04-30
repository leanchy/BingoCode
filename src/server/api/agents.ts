/**
 * Agents REST API
 *
 * GET    /api/agents        — 获取 Agent 列表
 * GET    /api/agents/:name  — 获取 Agent 详情
 * POST   /api/agents        — 创建 Agent
 * PUT    /api/agents/:name  — 更新 Agent
 * DELETE /api/agents/:name  — 删除 Agent
 *
 * GET    /api/tasks         — 获取后台任务列表
 * GET    /api/tasks/:id     — 获取任务详情
 */

//@C:ID=M.AR.agentsRestAPI;K=M;V=1.0;P=Import dependencies;D=API;M=Agents;S=RESTEndpoints
import { AgentService } from '../services/agentService.js'
import { taskService } from '../services/taskService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  resolveAgentModelDisplay,
  resolveAgentOverrides,
  type ResolvedAgent,
} from '../../tools/AgentTool/agentDisplay.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
  type AgentDefinition as SharedAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'

const agentService = new AgentService()

//@C:ID=T.AR.AgentTypes;K=T;V=1.0;P=Define API data types;D=API;M=Agents;S=DataModels
type ApiAgentDefinition = {
  agentType: string
  description?: string
  model?: string
  modelDisplay?: string
  tools?: string[]
  systemPrompt?: string
  color?: string
  source: SharedAgentDefinition['source']
  baseDir?: string
  isActive: boolean
}

type ApiResolvedAgentDefinition = ApiAgentDefinition & {
  overriddenBy?: SharedAgentDefinition['source']
}

//@C:ID=E.AR.handleAgentsApi;K=E;V=1.0;P=Main API entry point for agents and tasks;D=API;M=Agents;S=RESTEndpoints;Provider=AgentsAPI;Consumer=Frontend;In=Request;Out=Response
export async function handleAgentsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  console.log("E.AR.handleAgentsApi");
  
  try {
    const resource = segments[1] // 'agents' | 'tasks'

    ///@C:AR.RouteRequest
    if (resource === 'tasks') {
      return await handleTasksApi(req, segments)
    }

    return await handleAgents(req, url, segments)
  } catch (error) {
    return errorResponse(error)
  }
}

//@C:ID=F.AR.handleAgents;K=F;V=1.0;P=Handle agent CRUD operations;D=API;M=Agents;S=RESTEndpoints;In=Request,URL,string[];Out=Response
// ─── Agent CRUD ─────────────────────────────────────────────────────────────
async function handleAgents(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  console.log("F.AR.handleAgents");
  
  const method = req.method
  const agentName = segments[2] ? decodeURIComponent(segments[2]) : undefined

  ///@C:AR.GetAllAgents
  // ── GET /api/agents ──────────────────────────────────────────────────
  if (method === 'GET' && !agentName) {
    const cwd = url.searchParams.get('cwd') || getCwd()
    const { activeAgents, allAgents } = await getAgentDefinitionsWithOverrides(cwd)
    const resolvedAgents = resolveAgentOverrides(allAgents, activeAgents)

    return Response.json({
      activeAgents: activeAgents.map(agent => serializeActiveAgent(agent, true)),
      allAgents: resolvedAgents.map(serializeResolvedAgent),
    })
  }

  ///@C:AR.GetAgentDetail
  // ── GET /api/agents/:name ────────────────────────────────────────────
  if (method === 'GET' && agentName) {
    const agent = await agentService.getAgent(agentName)
    if (!agent) {
      throw ApiError.notFound(`Agent not found: ${agentName}`)
    }
    return Response.json({ agent })
  }

  ///@C:AR.CreateAgent
  // ── POST /api/agents ─────────────────────────────────────────────────
  if (method === 'POST' && !agentName) {
    const body = await parseJsonBody(req)
    if (!body.name || typeof body.name !== 'string') {
      throw ApiError.badRequest('Missing or invalid "name" in request body')
    }
    await agentService.createAgent({
      name: body.name as string,
      description: body.description as string | undefined,
      model: body.model as string | undefined,
      tools: body.tools as string[] | undefined,
      systemPrompt: body.systemPrompt as string | undefined,
      color: body.color as string | undefined,
    })
    clearAgentDefinitionsCache()
    return Response.json({ ok: true }, { status: 201 })
  }

  ///@C:AR.UpdateAgent
  // ── PUT /api/agents/:name ────────────────────────────────────────────
  if (method === 'PUT' && agentName) {
    const body = await parseJsonBody(req)
    await agentService.updateAgent(agentName, body as Record<string, unknown>)
    clearAgentDefinitionsCache()
    const updated = await agentService.getAgent(agentName)
    return Response.json({ agent: updated })
  }

  ///@C:AR.DeleteAgent
  // ── DELETE /api/agents/:name ─────────────────────────────────────────
  if (method === 'DELETE' && agentName) {
    await agentService.deleteAgent(agentName)
    clearAgentDefinitionsCache()
    return Response.json({ ok: true })
  }

  throw new ApiError(
    405,
    `Method ${method} not allowed on /api/agents${agentName ? `/${agentName}` : ''}`,
    'METHOD_NOT_ALLOWED',
  )
}

//@C:ID=F.AR.handleTasksApi;K=F;V=1.0;P=Handle tasks API operations;D=API;M=Tasks;S=RESTEndpoints;In=Request,string[];Out=Response
// ─── Tasks API ─────────────────────────────────────────────────────────────
//
// GET /api/tasks                         → list all tasks (across all task lists)
// GET /api/tasks/lists                   → list all task lists with summaries
// GET /api/tasks/lists/:taskListId       → get all tasks for a specific task list
// GET /api/tasks/lists/:taskListId/:id   → get a single task
async function handleTasksApi(
  req: Request,
  segments: string[],
): Promise<Response> {
  console.log("F.AR.handleTasksApi");
  
  if (req.method !== 'GET') {
    throw new ApiError(
      405,
      `Method ${req.method} not allowed on /api/tasks`,
      'METHOD_NOT_ALLOWED',
    )
  }

  const sub = segments[2] // 'lists' or undefined

  ///@C:AR.TaskLists
  // GET /api/tasks/lists — list all task lists
  if (sub === 'lists') {
    const taskListId = segments[3]
    const taskId = segments[4]

    ///@C:AR.GetSpecificTask
    if (taskListId && taskId) {
      // GET /api/tasks/lists/:taskListId/:taskId
      const task = await taskService.getTask(taskListId, taskId)
      if (!task) throw ApiError.notFound(`Task not found: ${taskListId}/${taskId}`)
      return Response.json({ task })
    }

    ///@C:AR.GetTasksForList
    if (taskListId) {
      // GET /api/tasks/lists/:taskListId
      const tasks = await taskService.getTasksForList(taskListId)
      return Response.json({ tasks })
    }

    ///@C:AR.GetAllTaskLists
    // GET /api/tasks/lists
    const lists = await taskService.listTaskLists()
    return Response.json({ lists })
  }

  ///@C:AR.GetAllTasks
  // GET /api/tasks — list all tasks
  const tasks = await taskService.listTasks()
  return Response.json({ tasks })
}

//@C:ID=F.AR.parseJsonBody;K=F;V=1.0;P=Parse and validate JSON request body;D=API;M=Utils;S=RequestParsing;In=Request;Out=Record<string,unknown>
// ─── Helpers ────────────────────────────────────────────────────────────────
async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  console.log("F.AR.parseJsonBody");
  
  ///@C:AR.ParseAndValidate
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

//@C:ID=F.AR.serializeActiveAgent;K=F;V=1.0;P=Convert internal agent to API format;D=API;M=Agents;S=DataSerialization;In=SharedAgentDefinition,boolean;Out=ApiAgentDefinition
function serializeActiveAgent(
  agent: SharedAgentDefinition,
  isActive: boolean,
): ApiAgentDefinition {
  console.log("F.AR.serializeActiveAgent");
  
  return {
    agentType: agent.agentType,
    description: agent.whenToUse,
    model: agent.model,
    modelDisplay: resolveAgentModelDisplay(agent),
    tools: agent.tools,
    systemPrompt: agent.getSystemPrompt.length === 0 ? agent.getSystemPrompt() : undefined,
    color: agent.color,
    source: agent.source,
    baseDir: agent.baseDir,
    isActive,
  }
}

//@C:ID=F.AR.serializeResolvedAgent;K=F;V=1.0;P=Convert resolved agent to API format;D=API;M=Agents;S=DataSerialization;In=ResolvedAgent;Out=ApiResolvedAgentDefinition
function serializeResolvedAgent(agent: ResolvedAgent): ApiResolvedAgentDefinition {
  console.log("F.AR.serializeResolvedAgent");
  
  return {
    ...serializeActiveAgent(agent, !agent.overriddenBy),
    overriddenBy: agent.overriddenBy,
  }
}