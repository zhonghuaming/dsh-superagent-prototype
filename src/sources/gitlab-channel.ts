/** GitLab outbound channel: posts notes on merge requests and Issues under the agent's token, deduplicated by an HTML marker. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { currentGitLabConfig, gitlabGet, gitlabPost, type GitLabApiConfig } from './gitlab-api.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

const NotesSchema = z.array(z.looseObject({ id: z.number(), body: z.string().nullish() }))
const notesPath = (address: Record<string, string>): string => {
  const kind = address.kind === 'issue' ? 'issues' : 'merge_requests'
  return `projects/${encodeURIComponent(address.project ?? '')}/${kind}/${address.iid}/notes`
}
/** Posts the message as a note; a trailing HTML marker lets retries recognize their own earlier delivery. */
export async function sendGitlab(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const config: GitLabApiConfig = currentGitLabConfig()
  const iid = Number(message.channel.address.iid)
  if (!message.channel.address.project || !iid) throw new Error('Missing GitLab reply target')
  const marker = `<!-- dsh-superagent-gitlab:${message.id} -->`
  const existing = NotesSchema.parse(await gitlabGet(config, notesPath(message.channel.address)))
  if (existing.some(note => (note.body ?? '').includes(marker))) return 'sent'
  await gitlabPost(config, notesPath(message.channel.address),
    { body: `${message.text}\n\n${marker}` })
  return 'sent'
}
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const iid = address.iid ?? ''
  const kind = address.kind === 'issue' ? 'issue' : 'merge request'
  const mark = kind === 'issue' ? `#${iid}` : `!${iid}`
  return { url: address.url ?? '', label: { zh: `GitLab ${mark}（${address.project ?? ''}）`, en: `GitLab ${mark} on ${address.project ?? ''}` } }
}
