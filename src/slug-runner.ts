import { mkdirSync } from "node:fs"
import { INHERITED_AGENT_SOCKET_VARIABLES } from "./fx-environment.ts"
import { slugFromAnswer } from "./slug-text.ts"

/**
 * Running one metadata completion through fx itself.
 *
 * `fx ask` is the whole reason naming needs no credentials of its own: it is
 * the same binary fmx already resolved, so it answers on whatever provider the
 * human is signed in to, with whatever subscription or key that provider uses,
 * and fmx never sees any of it. `--no-save` keeps these completions out of the
 * session store they would otherwise litter, and `--json` puts the answer in
 * one field instead of a rendered transcript.
 *
 * Two attempts, and the second drops the model override. A configured model
 * that the active provider does not offer is the one failure fmx can recover
 * from by itself: asking again at the session's own model costs more and
 * answers anyway.
 */

export type SlugCompletionOptions = {
  fxPath: string
  /** The empty workspace completions run in. */
  workspace: string
  env: NodeJS.ProcessEnv
  /** Model to ask at, or null to accept whatever fx is configured for. */
  model: string | null
  timeoutMs: number
}

export async function runSlugCompletion(
  instruction: string,
  options: SlugCompletionOptions,
): Promise<string | null> {
  try {
    mkdirSync(options.workspace, { recursive: true })
  } catch {
    return null
  }

  const models = options.model === null ? [null] : [options.model, null]
  for (const model of models) {
    const answer = await ask(instruction, options, model)
    if (answer === null) continue
    const slug = slugFromAnswer(answer)
    if (slug !== null) return slug
  }
  return null
}

async function ask(
  instruction: string,
  options: SlugCompletionOptions,
  model: string | null,
): Promise<string | null> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([options.fxPath, "ask", "--no-save", "--no-color", "--json", instruction], {
      cwd: options.workspace,
      stdin: "ignore",
      stdout: "pipe",
      // fx writes progress and diagnostics to stderr; only the JSON matters.
      stderr: "ignore",
      env: completionEnvironment(options.env, model),
    })
  } catch {
    return null
  }

  const timer = setTimeout(() => child.kill(), options.timeoutMs)
  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      child.exited,
    ])
    if (exitCode !== 0) return null
    return answerOf(stdout)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** `--json` answers one object; the assistant's reply is its `output`. */
function answerOf(stdout: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const output = (parsed as Record<string, unknown>).output
  return typeof output === "string" && output.trim() !== "" ? output : null
}

function completionEnvironment(
  parent: NodeJS.ProcessEnv,
  model: string | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent }
  for (const variable of INHERITED_AGENT_SOCKET_VARIABLES) delete env[variable]
  if (model !== null) env.FX_MODEL = model
  else delete env.FX_MODEL
  return env
}
