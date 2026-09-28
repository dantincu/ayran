/** The Dev Tools → Logs page's own backend calls (`logging.rs`, admin-only). What actually gets logged, and
 * when, is decided entirely in Rust — this page only ever asks for the current level, the log file's own
 * size and location, its recent content, or to export it; see CLAUDE.md's "Dev Tools and file logging". */
import { invoke } from '@tauri-apps/api/core'
import { exportPathToDevice } from './platform'

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

export const LOG_LEVELS: LogLevel[] = ['off', 'error', 'warn', 'info', 'debug', 'trace']

export function getLogLevel(): Promise<LogLevel> {
  return invoke<LogLevel>('get_log_level')
}

export async function setLogLevel(level: LogLevel): Promise<void> {
  await invoke('set_log_level', { level })
}

export interface LogFileInfo {
  path: string
  sizeBytes: number
}

export function getLogFileInfo(): Promise<LogFileInfo> {
  return invoke<LogFileInfo>('get_log_file_info')
}

/** The end of the current log file (at most `maxBytes`, default 200 KiB — the backend's own cap). */
export function readLogTail(maxBytes?: number): Promise<string> {
  return invoke<string>('read_log_tail', { maxBytes })
}

/** Saves the current log file to the device (the same "save as"/Downloads flow every other export uses). */
export function exportLogFile(): Promise<string | null> {
  return exportPathToDevice('csdrive.log', (token) => invoke<string>('export_log_file', { token }))
}
