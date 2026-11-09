/** GitLab thread context for assessments: the MR/Issue description plus its notes, read through the GitLab API. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { gitlabGet, type GitLabApiConfig } from './gitlab-api.ts'
import type { GitLabItemKind } from './gitlab-trigger.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'

const itemPath = (project: string, kind: GitLabItemKind, iid: number): string =>
  `projects/${encodeURIComponent(project)}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
const notesPath = (project: string, kind: GitLabItemKind, iid: number, page: number): string =>
  `${itemPath(project, kind, iid)}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`
const ItemSchema = z.looseObject({ title: z.string(), description: z.string().nullish(),
  author: z.object({ username: z.string() }).loose(), created_at: z.string() }).loose()
const NotesSchema = z.array(z.looseObject({ id: z.number(), body: z.string().nullish(), system: z.boolean().nullish(),
  author: z.object({ username: z.string() }).loose(), created_at: z.string() }))

const contextOf = (trigger: Trigger): { project: string; kind: GitLabItemKind; iid: number } => {
  const project = String(trigger.meta.project ?? '')
  const kind: GitLabItemKind = trigger.meta.kind === 'issue' ? 'issue' : 'mr'
  const iid = Number(trigger.meta.iid)
  if (!project || !iid) throw new Error('The GitLab trigger has no project or IID')
  return { project, kind, iid }
}

export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => String(trigger.meta.noteId ?? trigger.url ?? trigger.id),
  read: async (_commands: Commands, trigger: Trigger, part: 'thread' | 'root' | 'parent', cursor: string | undefined,
    config: unknown): Promise<ContextPart> => {
    const api = config as GitLabApiConfig
    const { project, kind, iid } = contextOf(trigger)
    if (part === 'root' || part === 'parent') {
      // The root and the replied-to message of a GitLab discussion are the MR/Issue description itself.
      const item = ItemSchema.parse(await gitlabGet(api, itemPath(project, kind, iid)))
      const message: ContextMessage = { id: 'description', from: `@${item.author.username}`, at: item.created_at,
        text: [item.title, item.description ?? ''].filter(Boolean).join('\n\n') }
      return { messages: [message], body: { status: 'item_description', messages: [message] }, status: 'item_description' }
    }
    const page = Math.max(1, Number(cursor ?? '1') || 1)
    const notes = NotesSchema.parse(await gitlabGet(api, notesPath(project, kind, iid, page)))
    const messages: ContextMessage[] = notes.filter(note => !note.system)
      .map(note => ({ id: String(note.id), from: `@${note.author.username}`, at: note.created_at, text: note.body ?? '' }))
    return { messages, ...(notes.length >= 100 ? { next: String(page + 1) } : {}), body: { notes: messages } }
  },
}
