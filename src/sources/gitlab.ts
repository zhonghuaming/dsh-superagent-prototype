/** GitLab source kind definition, project polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sameName } from '../infra/text.ts'
import { GitLabError, ProjectSchema, gitlabGet, setLiveGitLabConfig, type GitLabApiConfig } from './gitlab-api.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { GitLabIssueSchema, GitLabMrSchema, issueTrigger, mrTrigger, noteTrigger, pipelineTrigger, SOURCE }
  from './gitlab-trigger.ts'
import type { GitLabItemKind } from './gitlab-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'

const threadId = (project: string, kind: GitLabItemKind, iid: number): string => `gitlab:${project}:${kind}${iid}`
const GitLabProjectRow = z.object({ path: z.string().regex(/^[\w.\-/]+\/[\w.\-]+$/) }).strict()
const GitLabConfigSchema = z.object({ url: z.string().url().default('https://gitlab.com'), tokenEnv: z.string().default('GITLAB_TOKEN'),
  projects: z.array(GitLabProjectRow).default([]),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeMrs: z.boolean().default(false), observeIssues: z.boolean().default(false),
  observePipelines: z.boolean().default(false) }).strict()
export type GitLabConfig = z.infer<typeof GitLabConfigSchema>
const OBSERVED = { mrs: 'observeMrs', issues: 'observeIssues', pipelines: 'observePipelines' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.pipeline === true) return typeof meta.branch === 'string' ? 'pipelines' : undefined
  return meta.kind === 'mr' ? 'mrs' : meta.kind === 'issue' ? 'issues' : undefined
}
export const gitlabKind: SourceKind<GitLabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收所配项目的合并请求、Issue、评论与默认分支流水线状态。', en: 'The agent\'s GitLab account; receives merge requests, Issues, comments, and default-branch pipeline status of the configured projects.' },
  schema: GitLabConfigSchema,
  fields: [
    { key: 'url', type: 'text', label: { zh: 'GitLab 地址', en: 'GitLab URL' },
      hint: { zh: '自建实例写作完整地址，例如 https://gitlab.example.com。', en: 'The full URL of a self-hosted instance, for example https://gitlab.example.com.' } },
    { key: 'tokenEnv', type: 'text', label: { zh: '令牌的环境变量名', en: 'Token environment variable' },
      hint: { zh: '把个人访问令牌（api 权限）放进这个环境变量；配置只存变量名，不存令牌本身。', en: 'Put a personal access token (api scope) in this environment variable; the configuration holds the variable name, never the token.' } },
    { key: 'projects', type: 'rows', label: { zh: '监听的项目', en: 'Projects' },
      columns: [{ key: 'path', type: 'text', label: { zh: '项目路径', en: 'Project path' }, pattern: '[\\w.\\-/]+/[\\w.-]+' }] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeMrs', type: 'switch', label: { zh: '接收新的合并请求', en: 'Receive new merge requests' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收新的 Issue', en: 'Receive new Issues' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收默认分支流水线状态', en: 'Receive default-branch pipeline status' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/-\/(merge_requests|issues)\/(\d+)/i.exec(query.trim())
    if (url) {
      const kind: GitLabItemKind = url[2]!.toLowerCase() === 'merge_requests' ? 'mr' : 'issue'
      return { threads: [threadId(url[1]!, kind, Number(url[3]!))], terms: [] }
    }
    const bare = /^([#!])(\d+)$/.exec(query.trim())
    if (!bare) return { threads: [], terms: [] }
    const kind: GitLabItemKind = bare[1] === '#' ? 'issue' : 'mr'
    return { threads: gitlabProjects().flatMap(project => [threadId(project, kind, Number(bare[2]))]), terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[\w.\-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[\w.\-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 用户名', en: 'GitLab usernames that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' }, pattern: '[\\w.-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '可成为候选的机器人账号', en: 'Bot accounts whose events may become candidates' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[\\w.-]+' }] }],
    explicit: { zh: '名单内的账号在 Issue、合并请求或评论里 @ 机器人的 GitLab 用户名。', en: 'An account on the list mentions the bot\'s GitLab username in an Issue, merge request, or comment.' },
    rows(stored) {
      const config = GitLabConfigSchema.partial().parse(stored)
      const on = (flag: boolean | undefined) => flag ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: on(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('mrs', { zh: '合并请求', en: 'Merge requests' }), row('issues', { zh: 'Issue', en: 'Issues' }),
        { id: 'pipelines', label: { zh: '默认分支流水线', en: 'Default-branch pipelines' },
          note: config.observePipelines ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observePipelines } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_URL', description: { zh: 'GitLab 实例地址；API 调用以它为基底。', en: 'The GitLab instance URL; API calls are based on it.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '接下工单的 Issue 或合并请求所在项目路径。', en: 'The project path of the Issue or merge request that started the ticket.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或合并请求编号。', en: 'The IID of the Issue or merge request that started the ticket.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_SOURCE_BRANCH', description: { zh: '接下工单的合并请求的源分支；不是合并请求时为空。', en: 'The source branch of the merge request that started the ticket; empty when it is not one.' } },
    ],
    values: ({ trigger }) => {
      const meta = trigger?.threads[0]?.source === SOURCE ? trigger.meta : undefined
      const iid = Number(meta?.iid) || 0
      return { DSH_SUPERAGENT_GITLAB_URL: '', DSH_SUPERAGENT_GITLAB_PROJECT: String(meta?.project ?? ''),
        DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_SOURCE_BRANCH: String(meta?.sourceBranch ?? '') }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment ? {} : {},
}
const gitlabProjects = (): string[] => {
  const config = GitLabConfigSchema.partial().parse(currentConfigRaw())
  return (config.projects ?? []).map(row => row.path)
}
let cachedConfigRaw: Record<string, unknown> | undefined
const currentConfigRaw = (): Record<string, unknown> => cachedConfigRaw ?? {}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitLabConfig>(SOURCE)
    try {
      if (config) {
        cachedConfigRaw = config
        setLiveGitLabConfig({ url: config.url, tokenEnv: config.tokenEnv })
        interval = await pollRound(ctx, config, signal)
      } else { setLiveGitLabConfig(undefined); ctx.report('gitlab', health('paused', 'sourceOff')) }
      failures = 0
    } catch (error) {
      failures += 1
      const failed = failures >= (config?.failuresBeforeError ?? 1)
        ? health('error', 'pollFailures', { count: String(failures), error: String(error) })
        : undefined
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitLabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round { started: string; signal?: AbortSignal | undefined; failures: string[] }
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, failures: [] })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
interface StreamState { since: string }
interface PipelineState { fingerprint: string; revision: number; defaultBranch?: string }
export async function pollRound(ctx: SourceContext, config: GitLabConfig, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  for (const project of config.projects.map(row => row.path)) {
    if (stopped(ctx, round)) return config.pollSeconds
    try { await pollMrIssues(ctx, round, config, project, 'mr') }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project} MRs: ${String(error)}`) }
    try { await pollMrIssues(ctx, round, config, project, 'issue') }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project} issues: ${String(error)}`) }
    try { await pollPipelines(ctx, round, config, project) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project} pipelines: ${String(error)}`) }
  }
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => { await pollThread(ctx, round, config, thread) })
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  ctx.report('gitlab', { state: 'ready', detail: `${config.projects.length} projects polled`, at: round.started })
  return config.pollSeconds
}
/** Polls one project's merge-request or Issue stream: newly opened items become Triggers, updated items intake their notes. */
async function pollMrIssues(ctx: SourceContext, round: Round, config: GitLabConfig, project: string, kind: GitLabItemKind): Promise<void> {
  const stream = KV.gitlab.stream(project, kind)
  const stored: StreamState | undefined = ctx.state.get(stream)
  const since = stored?.since ?? round.started
  const api = { url: config.url, tokenEnv: config.tokenEnv }
  const path = kind === 'mr'
    ? `projects/${encodeURIComponent(project)}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=50`
    : `projects/${encodeURIComponent(project)}/issues?state=all&order_by=updated_at&sort=desc&per_page=50`
  const agent = await agentUsername(ctx, round, config)
  const listed = kind === 'mr'
    ? GitLabMrSchema.array().parse(await gitlabGet(api, path, round.signal))
    : GitLabIssueSchema.array().parse(await gitlabGet(api, path, round.signal))
  const ascending = listed.filter(item => Date.parse(item.updated_at) > Date.parse(since)).reverse()
  for (const item of ascending) {
    if (stopped(ctx, round)) return
    if (sameName(item.author.username, agent)) continue
    const opened = Date.parse(item.created_at) >= Date.parse(since)
    const ref = { project, kind, iid: item.iid, url: item.web_url ?? undefined }
    if (opened) await ctx.receive(kind === 'mr' ? mrTrigger(item, project, agent) : issueTrigger(item, project, agent))
    await intakeNotes(ctx, round, config, ref, since, agent)
    describeItem(ctx, project, kind, item.iid, item.title, item.web_url ?? undefined)
  }
  const newest = listed[0]?.updated_at
  ctx.state.set(stream, { since: newest ? cursorAt(newest) : since })
}
/** Reads the notes of an MR or Issue created since `since` and receives each non-system note as a comment trigger. */
async function intakeNotes(ctx: SourceContext, round: Round, config: GitLabConfig, ref: { project: string; kind: GitLabItemKind; iid: number; url?: string },
  since: string, agent: string): Promise<void> {
  const checkpoint = KV.gitlab.itemCursor(ref.project, `${ref.kind}${ref.iid}`)
  const from = ctx.state.get(checkpoint) ?? since
  const api = { url: config.url, tokenEnv: config.tokenEnv }
  const notes = GitLabNoteArray.parse(await gitlabGet(api, notesPath(ref.project, ref.kind, ref.iid), round.signal))
  for (const note of notes) {
    if (stopped(ctx, round)) return
    if (note.system || Date.parse(note.created_at) < Date.parse(from) || sameName(note.author.username, agent)) continue
    await ctx.receive(noteTrigger(note, ref, agent))
  }
  const newest = notes.map(note => note.created_at).sort().at(-1)
  ctx.state.set(checkpoint, newest ? cursorAt(newest) : from)
}
const GitLabNoteArray = z.array(z.looseObject({ id: z.number(), body: z.string().nullish(), author: z.object({ username: z.string() }).loose(),
  system: z.boolean().nullish(), created_at: z.string(), updated_at: z.string().nullish() }))
const notesPath = (project: string, kind: GitLabItemKind, iid: number): string =>
  `projects/${encodeURIComponent(project)}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes?per_page=100&sort=asc&order_by=created_at`
const describeItem = (ctx: SourceContext, project: string, kind: GitLabItemKind, iid: number, title: string, url?: string): void => {
  const thread = threadId(project, kind, iid)
  ctx.threads.patch(thread, { title })
  ctx.threads.describe(thread, { label: `${kind === 'mr' ? '!' : '#'}${iid} ${title}`, ...(url ? { url } : {}),
    facts: { project: { value: project } } })
}
let agentName: string | undefined
/** Resolves the PAT owner's GitLab username once per process; it identifies the agent's own items, which are never Triggers. */
async function agentUsername(ctx: SourceContext, round: Round, config: GitLabConfig): Promise<string> {
  if (agentName) return agentName
  const stored = ctx.state.get(KV.gitlab.username)
  if (stored) { agentName = stored; return agentName }
  const user = z.object({ username: z.string() }).loose().parse(await gitlabGet({ url: config.url, tokenEnv: config.tokenEnv }, 'user', round.signal))
  ctx.state.set(KV.gitlab.username, user.username)
  agentName = user.username
  return agentName
}
/** Polls each project's default-branch pipeline; only changes after the first baseline observation become Triggers. */
async function pollPipelines(ctx: SourceContext, round: Round, config: GitLabConfig, project: string): Promise<void> {
  if (!config.observePipelines) { ctx.state.set(KV.gitlab.pipeline(project), undefined); return }
  const api = { url: config.url, tokenEnv: config.tokenEnv }
  const state = ctx.state.get(KV.gitlab.pipeline(project)) as PipelineState | undefined
  const defaultBranch = state?.defaultBranch
    ?? (ProjectSchema.parse(await gitlabGet(api, `projects/${encodeURIComponent(project)}`, round.signal)).default_branch ?? 'main')
  const pipelines = z.array(z.looseObject({ id: z.number(), sha: z.string(), ref: z.string(), status: z.string(), web_url: z.string() }))
    .parse(await gitlabGet(api, `projects/${encodeURIComponent(project)}/pipelines?ref=${encodeURIComponent(defaultBranch)}&per_page=5`, round.signal))
  const latest = pipelines[0]
  if (!latest) return
  const fingerprint = `${latest.id}:${latest.status}`
  if (!state?.fingerprint) { ctx.state.set(KV.gitlab.pipeline(project), { fingerprint, revision: 0, defaultBranch }); return }
  if (fingerprint !== state.fingerprint) {
    const revision = (state.revision ?? 0) + 1
    await ctx.receive(pipelineTrigger(project, defaultBranch, latest.sha, latest.status, revision, latest.web_url))
    ctx.state.set(KV.gitlab.pipeline(project), { fingerprint, revision, defaultBranch })
    return
  }
  ctx.state.set(KV.gitlab.pipeline(project), { fingerprint, revision: state.revision ?? 0, defaultBranch })
}
/** Polls subscribed MR/Issue threads not already read in this round, intaking notes created since each checkpoint. */
async function pollThread(ctx: SourceContext, round: Round, config: GitLabConfig, thread: { key: string; ref: { id: string }; meta: Record<string, unknown>; createdAt: string }): Promise<void> {
  const parsed = /gitlab:(.+):(mr|issue)(\d+)$/.exec(thread.key)
  if (!parsed) return
  const ref = { project: parsed[1]!, kind: parsed[2]! as GitLabItemKind, iid: Number(parsed[3]) }
  const checkpoint = KV.gitlab.itemCursor(ref.project, `${ref.kind}${ref.iid}`)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  await intakeNotes(ctx, round, config, { ...ref, url: typeof thread.meta.url === 'string' ? thread.meta.url : undefined }, since,
    await agentUsername(ctx, round, config))
  ctx.state.set(checkpoint, cursorAt(round.started))
}
