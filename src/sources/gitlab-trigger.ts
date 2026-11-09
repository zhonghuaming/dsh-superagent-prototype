/** Normalizes GitLab merge requests, Issues, notes (comments), and pipeline transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** Thread kinds map to GitLab discussion surfaces; an MR and an Issue with the same IID never collide (separate kinds). */
export type GitLabItemKind = 'mr' | 'issue'
/** GitLab reply address: the MR or Issue discussion a note reply goes under. */
export const gitlabChannel = (project: string, kind: GitLabItemKind, iid: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: threadKey(project, kind, iid),
    address: { project, kind, iid: String(iid), ...(url ? { url } : {}) } })
export const threadKey = (project: string, kind: GitLabItemKind | 'pipeline', iidOrBranch: number | string): string =>
  `gitlab:${project}:${kind}${iidOrBranch}`
export const gitlabPage = (project: string, kind: GitLabItemKind, iid: number, url?: string): string =>
  url ?? `https://gitlab.com/${project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`

export const GitLabUserSchema = z.looseObject({ username: z.string() })
/** A note (comment) on an MR or Issue; `system` notes are GitLab-generated activity entries without a human body. */
export const GitLabNoteSchema = z.looseObject({ id: z.number(), body: z.string().nullish(), author: GitLabUserSchema,
  system: z.boolean().nullish(), created_at: z.string(), updated_at: z.string().nullish() })
export type GitLabNote = z.infer<typeof GitLabNoteSchema>
/** A merge request as the list endpoint returns it. */
export const GitLabMrSchema = z.looseObject({ iid: z.number(), title: z.string(), description: z.string().nullish(),
  state: z.string(), source_branch: z.string().nullish(), target_branch: z.string().nullish(), author: GitLabUserSchema,
  created_at: z.string(), updated_at: z.string(), web_url: z.string().nullish(), draft: z.boolean().nullish() })
export type GitLabMr = z.infer<typeof GitLabMrSchema>
/** An Issue as the list endpoint returns it. */
export const GitLabIssueSchema = z.looseObject({ iid: z.number(), title: z.string(), description: z.string().nullish(),
  state: z.string(), author: GitLabUserSchema, created_at: z.string(), updated_at: z.string(), web_url: z.string().nullish() })
export type GitLabIssue = z.infer<typeof GitLabIssueSchema>

type MrFields = Pick<GitLabMr, 'iid' | 'title' | 'description' | 'author' | 'created_at' | 'updated_at'> &
  Partial<Pick<GitLabMr, 'web_url' | 'source_branch' | 'target_branch'>>
type IssueFields = Pick<GitLabIssue, 'iid' | 'title' | 'description' | 'author' | 'created_at' | 'updated_at'> &
  Partial<Pick<GitLabIssue, 'web_url'>>
export interface GitLabItemRef { project: string; kind: GitLabItemKind; iid: number; url?: string }

export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(username)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { username: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: !sameName(user.username, agent) })
const itemText = (fields: { title: string; description?: string | null }): string =>
  [fields.title, fields.description ?? ''].filter(Boolean).join('\n\n')
const itemTrigger = (fields: MrFields | IssueFields, project: string, kind: GitLabItemKind, agent: string): Trigger => {
  const text = itemText(fields)
  const url = 'web_url' in fields ? fields.web_url : undefined
  return { id: key('gitlab-item', project, kind, String(fields.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadKey(project, kind, fields.iid) }], ...author(fields.author, agent),
    at: fields.created_at, text,
    ...(mentions(text, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(project, kind, fields.iid, url ?? undefined), ...(url ? { url } : {}),
    meta: { project, kind, iid: fields.iid, isPr: kind === 'mr',
      ...kind === 'mr' && 'source_branch' in fields && fields.source_branch ? { sourceBranch: fields.source_branch } : {},
      ...kind === 'mr' && 'target_branch' in fields && fields.target_branch ? { targetBranch: fields.target_branch } : {} } }
}
/** Builds the trigger for a newly opened merge request's title and description. */
export const mrTrigger = (mr: MrFields, project: string, agent: string): Trigger =>
  itemTrigger(mr, project, 'mr', agent)
/** Builds the trigger for a newly opened Issue's title and description. */
export const issueTrigger = (issue: IssueFields, project: string, agent: string): Trigger =>
  itemTrigger(issue, project, 'issue', agent)
/** Builds a trigger for a note (comment); the body is the text, system notes never reach here. */
export function noteTrigger(note: GitLabNote, ref: GitLabItemRef, agent: string): Trigger {
  const at = note.updated_at ?? note.created_at
  const version = note.updated_at ?? ''
  const id = key('gitlab-note', ref.project, ref.kind, String(ref.iid), String(note.id), version)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: threadKey(ref.project, ref.kind, ref.iid) }],
    ...author(note.author, agent), at, text: note.body ?? '',
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref.project, ref.kind, ref.iid), meta: { project: ref.project, kind: ref.kind, iid: ref.iid,
      isPr: ref.kind === 'mr', noteId: note.id } }
}
/** Builds a trigger for a default-branch pipeline transition; pipelines have no person to reply to, so no `channel`. */
export function pipelineTrigger(project: string, branch: string, sha: string, status: string, revision: number, url: string): Trigger {
  return { id: key('gitlab-pipeline', project, branch, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadKey(project, 'pipeline', branch) }], actor: { source: SOURCE, id: '' }, human: false,
    at: new Date().toISOString(), text: `Pipeline on ${branch} is ${status} (commit ${sha.slice(0, 8)})`, url,
    meta: { pipeline: true, project, branch, sha, status, revision } }
}
