/**
 * @file vfsdriver-localfs/src/fs/fs-ops.ts
 *
 * IFsOps — abstraction over filesystem operations.
 *
 * Two implementations:
 *   NodeFsOps   — node:fs  (Node.js / Electron)
 *   TauriFsOps  — @tauri-apps/plugin-fs  (Tauri WebView, lives in apps/tauri-app)
 *
 * All methods use forward-slash paths. On Windows, callers are responsible
 * for converting separators before passing them in.
 */

export interface StatResult {
    size:        number;
    mtimeMs:     number;
    birthtimeMs: number;
    isDirectory: boolean;
}

export interface DirEntry {
    name:        string;
    isDirectory: boolean;
}

export interface IFsOps {
    /** Read a file, returns null if it does not exist. */
    readFile(path: string): Promise<ArrayBuffer | null>;

    /**
     * Write data to a file.
     * Implementations should be as atomic as possible (temp-rename on POSIX).
     * Parent directories are created automatically.
     */
    writeFile(path: string, data: ArrayBuffer): Promise<void>;

    /** Append data to a file (non-atomic). */
    appendFile(path: string, data: ArrayBuffer): Promise<void>;

    /** Returns null when the path does not exist. */
    stat(path: string): Promise<StatResult | null>;

    /** Returns an empty array when the directory does not exist. */
    readDir(path: string): Promise<DirEntry[]>;

    /** Create a directory, recursively creating parents. No-op if it exists. */
    mkdir(path: string): Promise<void>;

    /** Rename / move a path. Parent of dest must already exist. */
    rename(from: string, to: string): Promise<void>;

    /** Remove a file. No-op on ENOENT. */
    unlink(path: string): Promise<void>;

    /** Remove an empty directory. No-op on failure (non-empty or missing). */
    rmdir(path: string): Promise<void>;

    /** Returns true if the path exists (file or directory). */
    exists(path: string): Promise<boolean>;
}
