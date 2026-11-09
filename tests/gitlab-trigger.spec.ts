import { describe, expect, it } from 'vitest'
import { gitlabChannel, issueTrigger, mentions, mrTrigger, noteTrigger, pipelineTrigger, SOURCE, threadKey }
  from '../src/sources/gitlab-trigger.ts'

const author = { username: 'alice' }
const project = 'team/pqis'

describe('gitlab thread keys', () => {
  it('derives stable thread ids per project, kind, and iid', () => {
    expect(threadKey('team/pqis', 'mr', 12)).toBe('gitlab:team/pqis:mr12')
    expect(threadKey('team/pqis', 'issue', 7)).toBe('gitlab:team/pqis:issue7')
    expect(threadKey('team/pqis', 'pipeline', 'main')).toBe('gitlab:team/pqis:pipelinemain')
  })
})

describe('gitlabChannel', () => {
  it('addresses the MR discussion of the project', () => {
    expect(gitlabChannel(project, 'mr', 12, 'https://gitlab.example.com/team/pqis/-/merge_requests/12')).toEqual({
      source: SOURCE, thread: 'gitlab:team/pqis:mr12',
      address: { project, kind: 'mr', iid: '12', url: 'https://gitlab.example.com/team/pqis/-/merge_requests/12' } })
  })
})

describe('mrTrigger', () => {
  const mr = { iid: 12, title: 'Fix KDJ seeding', description: 'Use deterministic seeds.', author,
    created_at: '2026-11-08T01:00:00Z', updated_at: '2026-11-08T01:05:00Z', web_url: 'https://gitlab.example.com/team/pqis/-/merge_requests/12',
    source_branch: 'agent/x', target_branch: 'main' }
  const trigger = mrTrigger(mr, project, 'sa-bot')
  it('threads under the MR and carries the description text', () => {
    expect(trigger.threads).toEqual([{ source: SOURCE, id: 'gitlab:team/pqis:mr12' }])
    expect(trigger.text).toContain('Fix KDJ seeding')
    expect(trigger.text).toContain('Use deterministic seeds.')
  })
  it('addresses the agent when mentioned', () => {
    const mentioned = mrTrigger({ ...mr, title: 'Fix @sa-bot reported seeding' }, project, 'sa-bot')
    expect(mentioned.addressed).toBe('mention')
  })
  it('marks another author as human and the agent account as its own', () => {
    expect(trigger.human).toBe(true)
    expect(trigger.actor).toEqual({ source: SOURCE, id: 'alice' })
  })
})

describe('issueTrigger', () => {
  it('uses the issue thread and never marks isPr', () => {
    const trigger = issueTrigger({ iid: 7, title: 'Timeout on sync', description: null, author,
      created_at: '2026-11-08T02:00:00Z', updated_at: '2026-11-08T02:00:00Z', web_url: 'https://gitlab.example.com/team/pqis/-/issues/7' },
      project, 'sa-bot')
    expect(trigger.threads).toEqual([{ source: SOURCE, id: 'gitlab:team/pqis:issue7' }])
    expect(trigger.meta).toMatchObject({ project, kind: 'issue', iid: 7, isPr: false })
  })
})

describe('noteTrigger', () => {
  const note = { id: 99, body: '这个接口超时了', author, system: false, created_at: '2026-11-08T03:00:00Z', updated_at: null }
  it('versions the id by updated_at so edits arrive again', () => {
    const first = noteTrigger(note, { project, kind: 'issue', iid: 7 }, 'sa-bot')
    const edited = noteTrigger({ ...note, body: '这个接口还是超时', updated_at: '2026-11-08T03:30:00Z' }, { project, kind: 'issue', iid: 7 }, 'sa-bot')
    expect(first.id).not.toBe(edited.id)
  })
  it('addresses the agent on mention', () => {
    const trigger = noteTrigger({ ...note, body: '@sa-bot 看一下' }, { project, kind: 'mr', iid: 12 }, 'sa-bot')
    expect(trigger.addressed).toBe('mention')
    expect(trigger.meta).toMatchObject({ kind: 'mr', noteId: 99 })
  })
})

describe('pipelineTrigger', () => {
  it('has no channel and no human actor', () => {
    const trigger = pipelineTrigger(project, 'main', 'abcdef123456', 'failed', 3, 'https://gitlab.example.com/team/pqis/-/pipelines/55')
    expect(trigger.actor).toEqual({ source: SOURCE, id: '' })
    expect(trigger.human).toBe(false)
    expect(trigger.threads).toEqual([{ source: SOURCE, id: 'gitlab:team/pqis:pipelinemain' }])
    expect(trigger.text).toContain('failed')
  })
})

describe('mentions', () => {
  it('matches whole-word mentions only', () => {
    expect(mentions('@sa-bot 请处理', 'sa-bot')).toBe(true)
    expect(mentions('邮件是 sa-bot@example.com', 'sa-bot')).toBe(false)
    expect(mentions('不是 @sa-botx', 'sa-bot')).toBe(false)
  })
})
