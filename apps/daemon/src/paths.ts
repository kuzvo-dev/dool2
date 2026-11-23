import { homedir } from 'node:os'
import { join } from 'node:path'

/** Doori data folder. Conversation history, the work folder and Codex settings all live here and never leave this PC. */
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
    /** Agent work folder. Not where the user's files are */
    workspace: join(dataDir, 'workspace'),
    codexHome: join(dataDir, 'codex-home'),
    /** Codex downloaded on first use */
    codex: join(dataDir, 'codex'),
    /** Pay-as-you-go runner (OpenCode) install and its data */
    opencode: join(dataDir, 'opencode'),
  }
}
