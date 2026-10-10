// Claude Managed Agents, Files and Skills over REST, through the host's fetch.

export type Part = { name: string; filename?: string; contentType?: string; value: string }

// A header parameter value: quotes escaped, line breaks dropped.
const quoted = (text: string) => text.replace(/[\r\n]/g, '').replace(/"/g, '%22')

export function multipart(parts: Part[], boundary: string): string {
  const body = parts.map(p => {
    const disposition = `Content-Disposition: form-data; name="${quoted(p.name)}"${p.filename !== undefined ? `; filename="${quoted(p.filename)}"` : ''}`
    const type = p.filename !== undefined ? `\r\nContent-Type: ${p.contentType ?? 'text/plain'}` : ''
    return `--${boundary}\r\n${disposition}${type}\r\n\r\n${p.value}\r\n`
  })
  return `${body.join('')}--${boundary}--\r\n`
}

export type Credential = { kind: 'api-key'; key: string } | { kind: 'session'; handle: string; isBearer: boolean }

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; auth?: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export type ApiRequest = {
  method: 'GET' | 'POST'
  path: string
  json?: unknown
  multipart?: Part[]
  isBeta?: boolean
  isRaw?: boolean
}

export type Send = (request: ApiRequest) => Promise<unknown>

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    detail: string,
  ) {
    super(`${type} (${status}): ${detail}`)
  }
}

const BASE = 'https://api.anthropic.com'
const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01'
const OAUTH_BETA = 'oauth-2025-04-20'

export function createSend(fetch: Fetch, credential: Credential): Send {
  return async request => {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    const betas: string[] = request.isBeta === true ? [MANAGED_AGENTS_BETA] : []
    let auth: string | undefined
    if (credential.kind === 'api-key') {
      headers['x-api-key'] = credential.key
    } else {
      auth = credential.handle
      if (credential.isBearer) betas.push(OAUTH_BETA)
    }
    if (betas.length > 0) headers['anthropic-beta'] = betas.join(',')

    let body: string | undefined
    if (request.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(request.json)
    } else if (request.multipart !== undefined) {
      const boundary = `----agentgraph${crypto.randomUUID().replace(/-/g, '')}`
      headers['content-type'] = `multipart/form-data; boundary=${boundary}`
      body = multipart(request.multipart, boundary)
    }

    const response = await fetch(`${BASE}${request.path}`, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(auth !== undefined ? { auth } : {}),
    })
    let parsed: unknown
    let isJson = true
    try {
      parsed = response.text === '' ? undefined : JSON.parse(response.text)
    } catch {
      parsed = undefined
      isJson = false
    }
    if (response.ok && !isJson && request.isRaw !== true) {
      throw new ApiError(response.status, 'invalid_json', `the response was not JSON: ${response.text.slice(0, 200)}`)
    }
    if (!response.ok) {
      const error = (parsed as { error?: { type?: string; message?: string } } | undefined)?.error
      throw new ApiError(response.status, error?.type ?? 'http_error', error?.message ?? (response.text.slice(0, 200) || 'no details'))
    }
    return request.isRaw === true ? response.text : parsed
  }
}

export type SessionEvent = { id: string; type: string; [field: string]: unknown }
export type AgentBody = Record<string, unknown> & { name: string }
export type SkillFile = { path: string; text: string }
export type Api = ReturnType<typeof createApi>

type Page<T> = { data: T[]; next_page?: string | null }

export function createApi(send: Send) {
  const skillParts = (files: SkillFile[]): Part[] =>
    files.map(f => ({ name: 'files[]', filename: f.path, value: f.text }))

  async function listPaged(path: string): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    let page: string | undefined
    const seen = new Set<string>()
    do {
      const query = `limit=1000${page !== undefined ? `&page=${encodeURIComponent(page)}` : ''}`
      const result = (await send({ method: 'GET', path: `${path}?${query}`, isBeta: true })) as Page<SessionEvent>
      events.push(...result.data)
      page = result.next_page ?? undefined
      if (page !== undefined && seen.has(page)) break
      if (page !== undefined) seen.add(page)
    } while (page !== undefined)
    return events
  }

  return {
    createEnvironment: async (name: string) =>
      (await send({
        method: 'POST',
        path: '/v1/environments',
        isBeta: true,
        json: { name, config: { type: 'cloud', networking: { type: 'limited', allow_package_managers: true, allow_mcp_servers: false } } },
      })) as { id: string },

    createAgent: async (body: AgentBody) =>
      (await send({ method: 'POST', path: '/v1/agents', isBeta: true, json: body })) as { id: string; version: number },

    updateAgent: async (id: string, body: AgentBody) =>
      (await send({ method: 'POST', path: `/v1/agents/${id}`, isBeta: true, json: body })) as { id: string; version: number },

    createSkill: async (files: SkillFile[]) =>
      (await send({ method: 'POST', path: '/v1/skills', multipart: skillParts(files) })) as { id: string },

    createSkillVersion: async (id: string, files: SkillFile[]) =>
      (await send({ method: 'POST', path: `/v1/skills/${id}/versions`, multipart: skillParts(files) })) as { id: string },

    uploadFile: async (filename: string, text: string) =>
      (await send({
        method: 'POST',
        path: '/v1/files',
        multipart: [{ name: 'file', filename, value: text }, { name: 'purpose', value: 'agent' }],
      })) as { id: string },

    createSession: async (body: Record<string, unknown>) =>
      (await send({ method: 'POST', path: '/v1/sessions', isBeta: true, json: body })) as { id: string },

    listEvents: (sessionId: string) => listPaged(`/v1/sessions/${sessionId}/events`),

    // One delegate thread's own events (its tool calls). Reading only: threads are never archived here.
    listThreadEvents: (sessionId: string, threadId: string) => listPaged(`/v1/sessions/${sessionId}/threads/${threadId}/events`),

    sendEvents: async (sessionId: string, events: unknown[]) => {
      await send({ method: 'POST', path: `/v1/sessions/${sessionId}/events`, isBeta: true, json: { events } })
    },

    async listSessionFiles(sessionId: string): Promise<Array<{ id: string; filename: string }>> {
      const files: Array<{ id: string; filename: string }> = []
      let page: string | undefined
      const seen = new Set<string>()
      do {
        const query = `scope_id=${sessionId}${page !== undefined ? `&page=${encodeURIComponent(page)}` : ''}`
        const result = (await send({ method: 'GET', path: `/v1/files?${query}`, isBeta: true })) as Page<{ id: string; filename: string }>
        files.push(...result.data)
        page = result.next_page ?? undefined
        if (page !== undefined && seen.has(page)) break
        if (page !== undefined) seen.add(page)
      } while (page !== undefined)
      return files
    },

    downloadFile: async (id: string) =>
      (await send({ method: 'GET', path: `/v1/files/${id}/content`, isRaw: true })) as string,
  }
}
