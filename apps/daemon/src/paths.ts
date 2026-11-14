import { homedir } from 'node:os'
import { join } from 'node:path'

/** 두리 데이터 폴더. 대화 기록·작업 폴더·Codex 설정이 모두 여기에 있고, 이 PC 밖으로 나가지 않는다. */
export function defaultDataDir(env = process.env, platform = process.platform): string {
  if (env.DOOL2_DATA_DIR) return env.DOOL2_DATA_DIR
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dool2')
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dool2')
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'dool2')
}

export function dataPaths(dataDir: string) {
  return {
    dataDir,
    db: join(dataDir, 'dool2.db'),
    /** 에이전트 작업 폴더. 사용자 파일이 있는 곳이 아니다 */
    workspace: join(dataDir, 'workspace'),
    codexHome: join(dataDir, 'codex-home'),
    /** 처음 쓸 때 내려받은 Codex */
    codex: join(dataDir, 'codex'),
    /** 종량제 실행기(OpenCode) 설치와 그 데이터 */
    opencode: join(dataDir, 'opencode'),
  }
}
