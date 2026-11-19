import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literal } from '@/i18n'
import { requestLeaveDocument } from '@/lib/closeGuard'
import { currentProjectId, setCurrentProjectId } from '@/lib/session'
import { emptyProject } from '@/types/document'
import { useDocumentStore } from './documentStore'
import { useProjectStore } from './projectStore'

vi.mock('@/lib/closeGuard', () => ({ requestLeaveDocument: vi.fn(async () => true) }))

const leave = vi.mocked(requestLeaveDocument)
const current = { open: true, id: 'p0', name: 'Current', figures_dir: '/current' }
const target = { open: true, id: 'p1', name: 'Target', figures_dir: '/target' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let pending: { path: string; resolve: (response: Response) => void }[] = []
let requests: string[] = []
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

beforeEach(async () => {
  localStorage.clear()
  pending = []
  requests = []
  leave.mockReset().mockResolvedValue(true)
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url), 'http://local').pathname
    requests.push(path)
    if (path === '/api/projects/open') {
      return new Promise<Response>((resolve) => {
        pending.push({ path: JSON.parse(String(init?.body)).path, resolve })
      })
    }
    if (path === '/api/project') return json(current)
    if (path === '/api/projects/recent') return json({ recent: [], pinned: [] })
    if (path === '/api/projects') return json({ projects: [], default: null })
    if (path === '/api/panels') return json({ panels: [], figures_dir: '/target' })
    if (path.startsWith('/api/autosave/')) {
      return init?.method === 'PUT' ? json({ ok: true, saved_at: 1, revision: 'r1' }) : json({}, 404)
    }
    return json({})
  }) as typeof fetch
  setCurrentProjectId('p0')
  useProjectStore.setState({ project: current, phase: 'open', switching: false, lastDocumentIssue: null })
  await useDocumentStore.getState().switchDocument(emptyProject(), 'guard-document')
  await tick()
  requests = []
})

afterEach(async () => {
  for (const request of pending) request.resolve(json({}, 500))
  await tick()
  setCurrentProjectId(null)
  vi.restoreAllMocks()
})

describe('项目离开保护', () => {
  it('取消先于打开请求和任何认领，保留原文档且退出 switching', async () => {
    leave.mockResolvedValue(false)
    const before = useDocumentStore.getState()
    expect(await useProjectStore.getState().open('/target')).toBeNull()
    expect(leave).toHaveBeenCalledWith({ kind: 'project', name: 'target' })
    expect(requests).not.toContain('/api/projects/open')
    expect(currentProjectId()).toBe('p0')
    expect(useDocumentStore.getState().doc).toBe(before.doc)
    expect(useDocumentStore.getState().documentId).toBe(before.documentId)
    expect(useProjectStore.getState().switching).toBe(false)
  })

  it('询问尚未答复时不发请求；取消首项后队列可以继续', async () => {
    let answer!: (ok: boolean) => void
    leave.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const first = useProjectStore.getState().open('/cancelled')
    const second = useProjectStore.getState().open('/target')
    await tick()
    expect(leave).toHaveBeenCalledTimes(1)
    expect(requests).not.toContain('/api/projects/open')
    expect(useProjectStore.getState().switching).toBe(true)
    answer(false)
    expect(await first).toBeNull()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].path).toBe('/target')
    pending.shift()!.resolve(json(target))
    expect(await second).toEqual(target)
    expect(leave).toHaveBeenCalledTimes(2)
    expect(useProjectStore.getState().switching).toBe(false)
  })

  it('第二次保护在轮到自己时观察已经换好的项目，不在入队时预先批准', async () => {
    const seen: (string | null)[] = []
    leave.mockImplementation(async () => { seen.push(currentProjectId()); return true })
    const first = useProjectStore.getState().open('/target')
    const second = useProjectStore.getState().open('/next')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(seen).toEqual(['p0'])
    pending.shift()!.resolve(json(target))
    await first
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(seen).toEqual(['p0', 'p1'])
    pending.shift()!.resolve(json({ ...target, id: 'p2' }))
    await second
  })

  it('请求在途期间又编辑，旧回包不认领项目、不覆盖新内容', async () => {
    const result = useProjectStore.getState().open('/target')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    useDocumentStore.getState().commit(literal('edit while opening'), (doc) => {
      doc.guides.push({ axis: 'x', pos: 13 })
    })
    pending.shift()!.resolve(json(target))
    expect(await result).toBeNull()
    expect(currentProjectId()).toBe('p0')
    expect(useDocumentStore.getState().doc.guides).toEqual([{ axis: 'x', pos: 13 }])
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('请求在途期间换了文档，即使内容相同也不认领', async () => {
    const result = useProjectStore.getState().open('/target')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await useDocumentStore.getState().switchDocument(emptyProject(), 'new-document')
    pending.shift()!.resolve(json(target))
    expect(await result).toBeNull()
    expect(useDocumentStore.getState().documentId).toBe('new-document')
    expect(currentProjectId()).toBe('p0')
  })

  it('直接认领和教程事务都服从保护，事务内 adopt 不重复询问', async () => {
    leave.mockResolvedValue(false)
    const callback = vi.fn(async () => 'unexpected')
    expect(await useProjectStore.getState().adoptOpenedProject(target)).toBeNull()
    expect(await useProjectStore.getState().switchTransaction(callback)).toBeNull()
    expect(callback).not.toHaveBeenCalled()
    expect(currentProjectId()).toBe('p0')
    leave.mockClear().mockResolvedValue(true)
    const result = await useProjectStore.getState().switchTransaction(async (adopt, stillCurrent) => {
      expect(stillCurrent()).toBe(true)
      return adopt(target)
    })
    expect(result).toEqual(target)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('启动探测不弹离开提示', async () => {
    leave.mockResolvedValue(false)
    useProjectStore.setState({ phase: 'loading', project: null })
    await useProjectStore.getState().init()
    expect(leave).not.toHaveBeenCalled()
    expect(useProjectStore.getState().phase).toBe('open')
  })
})
