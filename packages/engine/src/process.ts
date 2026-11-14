import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const IS_WIN = process.platform === 'win32'

/**
 * 실행 파일을 찾는다. GUI 앱은 셸의 PATH를 물려받지 못할 때가 많아서(특히 맥),
 * PATH 말고도 공식 설치 위치를 함께 본다.
 */
export async function findExecutable(name: string, extraDirs: string[] = []): Promise<string | undefined> {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = [
    ...extraDirs,
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    ...(IS_WIN ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ].filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext)
      try {
        await access(p, IS_WIN ? constants.F_OK : constants.X_OK)
        return p
      } catch {}
    }
  }
  return undefined
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 짧게 끝나는 명령 실행 (버전 확인, 로그인 상태 확인 등) */
export function runOnce(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d
    })
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export interface LineProcess {
  lines: AsyncIterable<string>
  /** 프로세스가 끝나면 종료 코드와 stderr 마지막 부분 */
  exit: Promise<{ code: number | null; stderrTail: string }>
  kill(): void
}

/**
 * 오래 도는 프로세스를 띄우고 stdout을 줄 단위로 읽는다 (NDJSON 스트림용).
 * stdin에 넣을 글이 있으면 써 주고 닫는다.
 */
export function spawnLines(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; signal?: AbortSignal },
): LineProcess {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderrTail = ''
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderrTail = (stderrTail + d).slice(-4000)
  })
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin, 'utf8')
  else child.stdin.end()

  const onAbort = () => child.kill()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const exit = new Promise<{ code: number | null; stderrTail: string }>((resolve) => {
    child.on('error', (err) => {
      stderrTail += `\n${err.message}`
      resolve({ code: -1, stderrTail })
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stderrTail })
    })
  })

  async function* lines() {
    let buf = ''
    child.stdout.setEncoding('utf8')
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) yield line
        nl = buf.indexOf('\n')
      }
    }
    if (buf.trim()) yield buf
  }

  return { lines: lines(), exit, kill: () => child.kill() }
}
