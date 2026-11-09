/** GitLab REST client: PRIVATE-TOKEN authenticated fetches against a self-hosted or gitlab.com instance. */
import { z } from 'zod'

/** Error carrying the HTTP status so callers can tell permanent (404/410) from retryable (5xx/429/network) failures. */
export class GitLabError extends Error {
  constructor(message: string, readonly code?: number) { super(message) }
}

export interface GitLabApiConfig { url: string; tokenEnv: string }

/** The GitLab Source's poll loop refreshes this each round so the Channel and thread context can reach the live config. */
let liveConfig: GitLabApiConfig | undefined
export const setLiveGitLabConfig = (config: GitLabApiConfig | undefined): void => { liveConfig = config }
export function currentGitLabConfig(): GitLabApiConfig {
  if (!liveConfig) throw new GitLabError('The GitLab Source is not configured', -1)
  return liveConfig
}

/** Reads the PAT from the environment variable named by `tokenEnv`; a missing variable fails the poll with a clear message. */
export function gitlabToken(config: GitLabApiConfig): string {
  const token = process.env[config.tokenEnv]
  if (!token) throw new GitLabError(`The GitLab token environment variable ${config.tokenEnv} is not set`, -1)
  return token
}

const base = (config: GitLabApiConfig): string => config.url.replace(/\/+$/, '') + '/api/v4'

/** One GET returning parsed JSON; 404/410 surface as GitLabError with their status so callers can drop the Thread. */
export async function gitlabGet<T>(config: GitLabApiConfig, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base(config)}/${path.replace(/^\//, '')}`, {
    headers: { 'PRIVATE-TOKEN': gitlabToken(config) }, signal,
  }).catch((error: unknown) => { throw new GitLabError(`GitLab request failed: ${String(error)}`, -1) })
  const body = await response.text().catch(() => '')
  if (!response.ok) {
    let detail = body.slice(0, 300)
    try { detail = (JSON.parse(body) as { message?: string; error?: string }).message ?? (JSON.parse(body) as { error?: string }).error ?? detail } catch { /* keep raw text */ }
    throw new GitLabError(`GitLab ${response.status}: ${detail}`, response.status)
  }
  return JSON.parse(body || 'null') as T
}

/** One POST with a JSON body; returns the created resource parsed as JSON. */
export async function gitlabPost<T>(config: GitLabApiConfig, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base(config)}/${path.replace(/^\//, '')}`, {
    method: 'POST', headers: { 'PRIVATE-TOKEN': gitlabToken(config), 'content-type': 'application/json' },
    body: JSON.stringify(body), signal,
  }).catch((error: unknown) => { throw new GitLabError(`GitLab request failed: ${String(error)}`, -1) })
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new GitLabError(`GitLab ${response.status}: ${text.slice(0, 300)}`, response.status)
  return JSON.parse(text || 'null') as T
}

/** True when the error is a permanent 404/410 (deleted project, MR, or Issue); everything else is retried. */
export const gone = (error: unknown): boolean => error instanceof GitLabError && (error.code === 404 || error.code === 410)
/** True for errors that must not retry a read forever: the project or Thread is permanently unreachable. */
export const unreachable = gone

export const ProjectSchema = z.looseObject({ id: z.number(), path_with_namespace: z.string(), web_url: z.string(),
  default_branch: z.string().nullish() })
export type GitLabProject = z.infer<typeof ProjectSchema>
