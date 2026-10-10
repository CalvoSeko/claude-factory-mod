import { expect } from 'claude-code/testing'
import { test } from './kit'

import { ApiError, createApi, createSend, multipart, type Fetch } from '../hooks/cloud/api'

function recorder(reply: { status?: number; text?: string } = {}) {
  const calls: Array<{ url: string; init: Parameters<Fetch>[1] }> = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    const status = reply.status ?? 200
    return { status, ok: status < 400, text: reply.text ?? '{"id":"x","version":1,"data":[],"next_page":null}' }
  }
  return { calls, fetch }
}

test('multipart bodies carry each part with its filename', async () => {
  const body = multipart([{ name: 'files[]', filename: 'skill/SKILL.md', value: 'hi' }, { name: 'purpose', value: 'agent' }], 'B')
  expect(body).toBe(
    '--B\r\nContent-Disposition: form-data; name="files[]"; filename="skill/SKILL.md"\r\nContent-Type: text/plain\r\n\r\nhi\r\n' +
    '--B\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nagent\r\n--B--\r\n',
  )
})

test('an API key goes in x-api-key with the beta header on Managed Agents calls', async () => {
  const { calls, fetch } = recorder()
  const api = createApi(createSend(fetch, { kind: 'api-key', key: 'sk-test' }))
  await api.createAgent({ name: 'A', model: 'claude-opus-5-5' })
  const call = calls[0]!
  expect(call.url).toBe('https://api.anthropic.com/v1/agents')
  expect(call.init.method).toBe('POST')
  expect(call.init.headers['x-api-key']).toBe('sk-test')
  expect(call.init.headers['anthropic-version']).toBe('2023-06-01')
  expect(call.init.headers['anthropic-beta']).toBe('managed-agents-2026-04-01')
  expect(JSON.parse(call.init.body ?? '')).toEqual({ name: 'A', model: 'claude-opus-5-5' })
})

test('a session credential rides as an auth handle, with the OAuth beta for bearer tokens', async () => {
  const { calls, fetch } = recorder()
  const api = createApi(createSend(fetch, { kind: 'session', handle: 'h1', isBearer: true }))
  await api.uploadFile('notes.md', 'text')
  const call = calls[0]!
  expect(call.init.auth).toBe('h1')
  expect(call.init.headers['x-api-key']).toBeUndefined()
  expect(call.init.headers['anthropic-beta']).toBe('oauth-2025-04-20')
  expect(call.init.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
  expect(call.init.body).toContain('filename="notes.md"')
})

test('listing events follows next_page', async () => {
  const pages = ['{"data":[{"id":"1","type":"a"}],"next_page":"p2"}', '{"data":[{"id":"2","type":"b"}],"next_page":null}']
  const urls: string[] = []
  const fetch: Fetch = async url => { urls.push(url); return { status: 200, ok: true, text: pages.shift()! } }
  const events = await createApi(createSend(fetch, { kind: 'api-key', key: 'k' })).listEvents('sesn_1')
  expect(events.map(e => e.id)).toEqual(['1', '2'])
  expect(urls[1]).toBe('https://api.anthropic.com/v1/sessions/sesn_1/events?limit=1000&page=p2')
})

test('a repeating next_page ends the listing', async () => {
  const urls: string[] = []
  const fetch: Fetch = async url => { urls.push(url); return { status: 200, ok: true, text: '{"data":[{"id":"1","type":"a"}],"next_page":"same"}' } }
  const api = createApi(createSend(fetch, { kind: 'api-key', key: 'k' }))
  expect((await api.listEvents('s')).length).toBe(2)
  expect((await api.listSessionFiles('s')).length).toBe(2)
  expect(urls.length).toBe(4)
})

test('errors carry the status, type and message', async () => {
  const { fetch } = recorder({ status: 401, text: '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}' })
  const api = createApi(createSend(fetch, { kind: 'api-key', key: 'k' }))
  let caught: unknown
  try { await api.createEnvironment('e') } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(ApiError)
  expect((caught as ApiError).status).toBe(401)
  expect((caught as ApiError).message).toBe('authentication_error (401): bad key')
})

test('an ok response that is not JSON is an error, unless the call is raw', async () => {
  const { fetch } = recorder({ text: '<html>gateway</html>' })
  const api = createApi(createSend(fetch, { kind: 'api-key', key: 'k' }))
  let caught: unknown
  try { await api.createEnvironment('e') } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(ApiError)
  expect((caught as ApiError).status).toBe(200)
  expect((caught as ApiError).type).toBe('invalid_json')
  expect(await api.downloadFile('file_1')).toBe('<html>gateway</html>')
  const empty = recorder({ text: '' })
  expect(await createApi(createSend(empty.fetch, { kind: 'api-key', key: 'k' })).sendEvents('s', [])).toBeUndefined()
})

test('listing session files follows next_page', async () => {
  const pages = ['{"data":[{"id":"f1","filename":"a.md"}],"next_page":"p2"}', '{"data":[{"id":"f2","filename":"b.md"}],"next_page":null}']
  const urls: string[] = []
  const fetch: Fetch = async url => { urls.push(url); return { status: 200, ok: true, text: pages.shift()! } }
  const files = await createApi(createSend(fetch, { kind: 'api-key', key: 'k' })).listSessionFiles('sesn_1')
  expect(files.map(f => f.id)).toEqual(['f1', 'f2'])
  expect(urls).toEqual(['https://api.anthropic.com/v1/files?scope_id=sesn_1', 'https://api.anthropic.com/v1/files?scope_id=sesn_1&page=p2'])
})

test('multipart names have quotes escaped and line breaks dropped', async () => {
  const body = multipart([{ name: 'a"b\r\nc', filename: 'x"y\r\n.md', value: 'v' }], 'B')
  expect(body).toBe('--B\r\nContent-Disposition: form-data; name="a%22bc"; filename="x%22y.md"\r\nContent-Type: text/plain\r\n\r\nv\r\n--B--\r\n')
})

test('listing a thread\'s events is a GET on the thread, follows next_page and never archives', async () => {
  const pages = ['{"data":[{"id":"1","type":"a"}],"next_page":"p2"}', '{"data":[{"id":"2","type":"b"}],"next_page":null}']
  const calls: Array<{ url: string; method: string }> = []
  const fetch: Fetch = async (url, init) => { calls.push({ url, method: init.method }); return { status: 200, ok: true, text: pages.shift()! } }
  const api = createApi(createSend(fetch, { kind: 'api-key', key: 'k' }))
  const events = await api.listThreadEvents('sesn_1', 'sthr_2')
  expect(events.map(e => e.id)).toEqual(['1', '2'])
  expect(calls).toEqual([
    { url: 'https://api.anthropic.com/v1/sessions/sesn_1/threads/sthr_2/events?limit=1000', method: 'GET' },
    { url: 'https://api.anthropic.com/v1/sessions/sesn_1/threads/sthr_2/events?limit=1000&page=p2', method: 'GET' },
  ])
  expect(Object.keys(api).filter(k => /archive|delete/i.test(k))).toEqual([])
})

test('a repeating next_page ends a thread listing', async () => {
  const fetch: Fetch = async () => ({ status: 200, ok: true, text: '{"data":[{"id":"1","type":"a"}],"next_page":"same"}' })
  const events = await createApi(createSend(fetch, { kind: 'api-key', key: 'k' })).listThreadEvents('s', 't')
  expect(events.length).toBe(2)
})
