import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NanviApiClient } from "../api";
import { CompanyFolderPicker } from "../components/ui/CompanyFolderPicker";
import {
  cancelPendingBrowserFolderPicker,
  chunkBrowserText,
  clearDesktopLocalFolder,
  clearSavedBrowserDirectoryHandle,
  connectDesktopFolderDirect,
  extractDroppedFoldersFromDataTransfer,
  extractOfficeTextFromBytes,
  extractTextFromBrowserFile,
  getAllCachedFolderNames,
  getBrowserFolderMode,
  getBrowserFolderRealPath,
  getCachedFolderFilesPreview,
  getDesktopLocalStatus,
  getLastCachedFolderName,
  inferBrowserFileMime,
  pickAndSyncBrowserFolder,
  queryDesktopLocalContext,
  readBrowserLocalFile,
  setActiveFolderStorageScope,
  setBrowserFolderRealPath,
  syncDroppedFolder,
  syncWebkitFileList,
  waitForBackgroundFolderSync,
} from "./browserFolderSync";

/** Build a valid uncompressed (STORE method=0) ZIP byte array for testing OOXML extraction without extra packages. */
function buildStoreZip(files: Array<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const dataBytes = encoder.encode(f.content);

    const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // method 0 = STORE
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.length);
    localParts.push(local);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // method 0
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += local.length;
  }

  const cdSize = cdParts.reduce((s, a) => s + a.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + eocd.length);
  let pos = 0;
  for (const part of [...localParts, ...cdParts, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

type FakeFileNode = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

type FakeDirNode = {
  kind: "directory";
  name: string;
  values: () => AsyncGenerator<FakeFileNode | FakeDirNode, void, unknown>;
  queryPermission: () => Promise<PermissionState>;
  requestPermission: () => Promise<PermissionState>;
  getDirectoryHandle: (subName: string) => Promise<FakeDirNode>;
  getFileHandle: (fileName: string) => Promise<FakeFileNode>;
};

function makeFakeFileHandle(name: string, content: string, type = "text/plain", lastModified = 1700000000000): FakeFileNode {
  const fileObj = {
    name,
    type,
    size: content.length,
    lastModified,
    text: async () => content,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  };
  return {
    kind: "file" as const,
    name,
    getFile: async () => fileObj as unknown as File,
  };
}

function makeFakeDirHandle(name: string, children: Array<FakeFileNode | FakeDirNode>): FakeDirNode {
  return {
    kind: "directory" as const,
    name,
    async *values() {
      for (const child of children) {
        yield child;
      }
    },
    async queryPermission() {
      return "granted" as PermissionState;
    },
    async requestPermission() {
      return "granted" as PermissionState;
    },
    async getDirectoryHandle(subName: string): Promise<FakeDirNode> {
      const found = children.find((c): c is FakeDirNode => c.kind === "directory" && c.name === subName);
      if (!found) throw new Error("Dir not found");
      return found;
    },
    async getFileHandle(fileName: string): Promise<FakeFileNode> {
      const found = children.find((c): c is FakeFileNode => c.kind === "file" && c.name === fileName);
      if (!found) throw new Error("File not found");
      return found;
    },
  };
}

describe("browserFolderSync", () => {
  afterEach(async () => {
    await clearDesktopLocalFolder();
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.unstubAllGlobals();
  });

  it("extracts text from plain text, HTML, and uncompressed OOXML DOCX/XLSX/PPTX files", async () => {
    const txtFile = {
      name: "summary.txt",
      size: 20,
      text: async () => "Bridge contract Q4 summary",
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;
    expect(await extractTextFromBrowserFile(txtFile)).toBe("Bridge contract Q4 summary");

    const htmlFile = {
      name: "report.html",
      size: 40,
      text: async () => "<html><body><script>bad()</script><h1>Revenue</h1><p>$1.2M</p></body></html>",
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;
    const htmlText = await extractTextFromBrowserFile(htmlFile);
    expect(htmlText).toContain("Revenue");
    expect(htmlText).toContain("$1.2M");
    expect(htmlText).not.toContain("bad()");

    const xlsxBytes = buildStoreZip([
      {
        name: "xl/sharedStrings.xml",
        content: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Bridge Steel</t></si><si><t>45000</t></si></sst>',
      },
      {
        name: "xl/worksheets/sheet1.xml",
        content: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
      },
    ]);
    const xlsxText = await extractOfficeTextFromBytes(".xlsx", xlsxBytes);
    expect(xlsxText).toContain("Bridge Steel");
    expect(xlsxText).toContain("45000");

    const docxBytes = buildStoreZip([
      {
        name: "word/document.xml",
        content: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Safety Policy Section 1</w:t></w:r></w:p></w:body></w:document>',
      },
    ]);
    expect(await extractOfficeTextFromBytes(".docx", docxBytes)).toContain("Safety Policy Section 1");
    expect(inferBrowserFileMime("report.pdf", "")).toBe("application/pdf");
    expect(chunkBrowserText("A".repeat(2200)).length).toBeGreaterThan(1);
  });

  it("picks a directory via showDirectoryPicker, ignores executables/.git, syncs chunks, and reads local files", async () => {
    const dirHandle = makeFakeDirHandle("ClientDocs", [
      makeFakeDirHandle(".git", [makeFakeFileHandle("HEAD", "ref: refs/heads/main")]),
      makeFakeDirHandle("02_Projects", [makeFakeFileHandle("bridge_notes.txt", "Bridge span is 420 meters.")]),
      makeFakeFileHandle("invoice.csv", "id,amount\nINV-1,9500"),
      makeFakeFileHandle("installer.exe", "MZ"),
    ]);

    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

    const syncCalls: any[] = [];
    const heartbeatCalls: any[] = [];
    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-tok-1" }),
      syncLocalFolderWithPairingToken: vi.fn().mockImplementation(async (tok, payload) => {
        syncCalls.push({ tok, payload });
        return { status: "ok", folder_id: payload.folder_id, chunks_synced: payload.chunks.length, files_synced: payload.files.length };
      }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockImplementation(async (tok, payload) => {
        heartbeatCalls.push({ tok, payload });
        return { status: "ok" };
      }),
    };

    const events: any[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("nanvi:company-folder-updated", handler);

    const res = await pickAndSyncBrowserFolder(mockApi as any);
    window.removeEventListener("nanvi:company-folder-updated", handler);

    expect(res).toEqual({
      folderName: "ClientDocs",
      folderId: "browser://ClientDocs",
      fileCount: 2,
      chunkCount: 2,
      reusedCachedCount: 0,
    });
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].tok).toBe("pair-tok-1");
    expect(syncCalls[0].payload.files.map((f: any) => f.filename).sort()).toEqual(["bridge_notes.txt", "invoice.csv"]);
    expect(heartbeatCalls[0].payload.agent_version).toBe("browser-fs-1.0.0");
    expect(events[0]).toMatchObject({ path: "ClientDocs", exists: true, file_count: 2 });

    const localFile = await readBrowserLocalFile("ClientDocs/02_Projects/bridge_notes.txt");
    expect(localFile).not.toBeNull();
    expect(localFile?.name).toBe("bridge_notes.txt");
  });

  it("reuses cached file extractions across re-syncs and only re-reads modified files", async () => {
    const readTextSpy1 = vi.fn().mockResolvedValue("Unchanged contract clause A");
    let modifiedContent = "Initial version B";
    let modifiedTs = 1700000000000;
    const readTextSpy2 = vi.fn().mockImplementation(async () => modifiedContent);

    const file1Node: FakeFileNode = {
      kind: "file",
      name: "unchanged.txt",
      getFile: async () =>
        ({
          name: "unchanged.txt",
          type: "text/plain",
          size: 27,
          lastModified: 1700000000000,
          text: readTextSpy1,
          arrayBuffer: async () => new ArrayBuffer(0),
        }) as unknown as File,
    };
    const file2Node: FakeFileNode = {
      kind: "file",
      name: "edited.txt",
      getFile: async () =>
        ({
          name: "edited.txt",
          type: "text/plain",
          size: modifiedContent.length,
          lastModified: modifiedTs,
          text: readTextSpy2,
          arrayBuffer: async () => new ArrayBuffer(0),
        }) as unknown as File,
    };

    const dirHandle = makeFakeDirHandle("DeltaFolder", [file1Node, file2Node]);
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

    let backendFolders: any[] = [];
    let backendChunkCount = 0;
    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-delta" }),
      getLocalAgentStatus: vi.fn().mockImplementation(async () => ({
        is_online: backendFolders.length > 0,
        connected_folders: backendFolders,
        total_files: backendFolders.reduce((s, f) => s + f.file_count, 0),
        total_chunks: backendChunkCount,
      })),
      syncLocalFolderWithPairingToken: vi.fn().mockImplementation(async (_tok, payload) => {
        backendFolders = [
          {
            folder_id: payload.folder_id,
            display_name: payload.display_name,
            file_count: payload.files.length,
          },
        ];
        backendChunkCount = payload.chunks.length;
        return { status: "ok", folder_id: payload.folder_id, chunks_synced: payload.chunks.length, files_synced: payload.files.length };
      }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    const { syncBrowserDirectory } = await import("./browserFolderSync");

    // 1. Initial sync reads both files
    const first = await syncBrowserDirectory(mockApi as any, dirHandle as any);
    expect(first.fileCount).toBe(2);
    expect(readTextSpy1).toHaveBeenCalledTimes(1);
    expect(readTextSpy2).toHaveBeenCalledTimes(1);
    expect(mockApi.syncLocalFolderWithPairingToken).toHaveBeenCalledTimes(1);

    // 2. Second sync with 0 changes & matching backend: 0 file reads and 0 /sync uploads!
    const second = await syncBrowserDirectory(mockApi as any, dirHandle as any, undefined, { skipIfBackendMatches: true });
    expect(second.reusedCachedCount).toBe(2);
    expect(readTextSpy1).toHaveBeenCalledTimes(1);
    expect(readTextSpy2).toHaveBeenCalledTimes(1);
    expect(mockApi.syncLocalFolderWithPairingToken).toHaveBeenCalledTimes(1);

    // 3. Backend restart (cold-start wiped backendFolders) -> restores cached chunks WITHOUT re-reading disk files!
    backendFolders = [];
    backendChunkCount = 0;
    const restored = await syncBrowserDirectory(mockApi as any, dirHandle as any, undefined, { skipIfBackendMatches: true });
    expect(restored.reusedCachedCount).toBe(2);
    expect(readTextSpy1).toHaveBeenCalledTimes(1);
    expect(readTextSpy2).toHaveBeenCalledTimes(1);
    expect(mockApi.syncLocalFolderWithPairingToken).toHaveBeenCalledTimes(2);

    // 4. Modify only file #2 -> ONLY file #2 is re-read, file #1 stays cached
    modifiedContent = "Updated version B with more text";
    modifiedTs = 1700000999000;
    const delta = await syncBrowserDirectory(mockApi as any, dirHandle as any);
    expect(delta.reusedCachedCount).toBe(1);
    expect(readTextSpy1).toHaveBeenCalledTimes(1);
    expect(readTextSpy2).toHaveBeenCalledTimes(2);
  });

  it("supports Firefox/Safari webkitdirectory folder lists, session previews, and cached cold-start restore", async () => {
    const f1 = {
      name: "mac_report.txt",
      type: "text/plain",
      size: 32,
      lastModified: 1700001000000,
      webkitRelativePath: "MacDocs/Finance/mac_report.txt",
      text: async () => "Mac Safari financial Q4 summary.",
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;

    const ignoredExe = {
      name: "tool.exe",
      type: "application/octet-stream",
      size: 10,
      lastModified: 1700001000000,
      webkitRelativePath: "MacDocs/tool.exe",
      text: async () => "MZ",
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;

    const syncCalls: any[] = [];
    let backendEmpty = false;
    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-webkit" }),
      getLocalAgentStatus: vi.fn().mockImplementation(async () => ({
        is_online: !backendEmpty,
        connected_folders: backendEmpty ? [] : [{ folder_id: "browser://MacDocs", display_name: "MacDocs", file_count: 1 }],
        total_files: backendEmpty ? 0 : 1,
        total_chunks: backendEmpty ? 0 : 1,
      })),
      syncLocalFolderWithPairingToken: vi.fn().mockImplementation(async (_tok, payload) => {
        syncCalls.push(payload);
        return { status: "ok", folder_id: payload.folder_id, chunks_synced: payload.chunks.length, files_synced: payload.files.length };
      }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    const { getBrowserFolderMode, restoreCachedBrowserFolder, syncWebkitFileList } = await import("./browserFolderSync");
    expect(["fs-access", "webkitdirectory", "file-picker", "unsupported"]).toContain(getBrowserFolderMode());

    const res = await syncWebkitFileList(mockApi as any, [f1, ignoredExe]);
    expect(res).toMatchObject({ folderName: "MacDocs", fileCount: 1, chunkCount: 1 });
    expect(syncCalls[0].files).toHaveLength(1);
    expect(syncCalls[0].files[0].relative_path).toBe("Finance/mac_report.txt");

    // In-memory preview works during Firefox/Safari session without DirectoryHandle
    const previewFile = await readBrowserLocalFile("MacDocs/Finance/mac_report.txt");
    expect(previewFile?.name).toBe("mac_report.txt");

    // Simulate reload after Vercel cold-start -> restores from cache without re-picking folder
    backendEmpty = true;
    const restored = await restoreCachedBrowserFolder(mockApi as any);
    expect(restored).toMatchObject({ folderName: "MacDocs", fileCount: 1, chunkCount: 1, reusedCachedCount: 1 });
    expect(syncCalls).toHaveLength(2);

    // Real Windows path override renders real C:\... path and builds clean CSV/HTML preview
    const { setBrowserFolderRealPath, getBrowserFolderRealPath, buildLocalFilePreviewBlob } = await import("./browserFolderSync");
    setBrowserFolderRealPath("MacDocs", "C:\\Users\\Demo\\Documents\\MacDocs");
    expect(getBrowserFolderRealPath("MacDocs")).toBe("C:\\Users\\Demo\\Documents\\MacDocs");
    const csvFile = {
      name: "weekly_progress.csv",
      type: "text/csv",
      size: 40,
      text: async () => "Week,Project,Planned %\nW35,PRJ-CHB-001,65",
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;
    const htmlPreview = await buildLocalFilePreviewBlob(csvFile);
    expect(htmlPreview.mimeType).toContain("text/html");
    const htmlText = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsText(htmlPreview.blob);
    });
    expect(htmlText).toContain("PRJ-CHB-001");
    setBrowserFolderRealPath("MacDocs", "");
  });

  it("splits large multi-megabyte chunk payloads into safe batches and deduplicates concurrent auto-restores", async () => {
    const bigText = "Structural bridge inspection clause. ".repeat(1500); // ~55,500 chars -> ~65 chunks per file (>1MB total)
    const children: FakeFileNode[] = [];
    for (let i = 0; i < 18; i++) {
      children.push(makeFakeFileHandle(`spec_${i}.txt`, `${bigText} File #${i}.`));
    }
    const dirHandle = makeFakeDirHandle("LargeBridgeDocs", children);
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

    const syncPayloads: any[] = [];
    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-large" }),
      getLocalAgentStatus: vi.fn().mockResolvedValue({
        is_online: false,
        connected_folders: [],
        total_files: 0,
        total_chunks: 0,
      }),
      syncLocalFolderWithPairingToken: vi.fn().mockImplementation(async (_tok, payload) => {
        syncPayloads.push(payload);
        await new Promise((r) => setTimeout(r, 10));
        return { status: "ok", folder_id: payload.folder_id, chunks_synced: payload.chunks.length, files_synced: payload.files.length };
      }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    const { autoRestoreBrowserFolderIfGranted } = await import("./browserFolderSync");

    // 1. Sync >100 chunks -> splits into multiple batches with replace_all=true ONLY on batch 0
    const initial = await pickAndSyncBrowserFolder(mockApi as any);
    expect(initial?.fileCount).toBe(18);
    expect(syncPayloads.length).toBeGreaterThan(1);
    expect(syncPayloads[0].replace_all).toBe(true);
    expect(syncPayloads[0].files).toHaveLength(18);
    for (let i = 1; i < syncPayloads.length; i++) {
      expect(syncPayloads[i].replace_all).toBe(false);
      expect(syncPayloads[i].files).toHaveLength(0);
    }

    // 2. Concurrent autoRestore calls share one in-flight promise (no racing replace_all=true streams)
    syncPayloads.length = 0;
    const [r1, r2] = await Promise.all([
      autoRestoreBrowserFolderIfGranted(mockApi as any),
      autoRestoreBrowserFolderIfGranted(mockApi as any),
    ]);
    expect(r1?.folderName).toBe("LargeBridgeDocs");
    expect(r2?.folderName).toBe("LargeBridgeDocs");
    const replaceAllCount = syncPayloads.filter((p) => p.replace_all).length;
    expect(replaceAllCount).toBe(1);
  });

  it("prioritizes localhost:8000 when configured and fails over cleanly across endpoints", async () => {
    localStorage.setItem("nanvi_custom_server_url", "http://127.0.0.1:8000/api");
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      isDesktop: true,
      platform: "win32",
      selectFolder: vi.fn(),
      showNotification: vi.fn(),
      openExternal: vi.fn(),
      onAccountBlocked: vi.fn(),
    };

    const calledUrls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (url.startsWith("http://127.0.0.1:8000/api")) {
        throw new TypeError("Failed to fetch");
      }
      if (url.includes("/document-content")) {
        return new Response("hello doc", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response(JSON.stringify({ is_online: false, connected_folders: [], total_files: 0, total_chunks: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new NanviApiClient();
    await client.getLocalAgentStatus();
    expect(calledUrls[0]).toBe("http://127.0.0.1:8000/api/local-agent/status");
    expect(calledUrls[1]).toContain("/local-agent/status");
    expect(calledUrls[1]).not.toContain("127.0.0.1:8000");

    // Subsequent calls go directly to failed-over cloud URL (including getDocumentBlob)
    calledUrls.length = 0;
    await client.getDocumentBlob("C:\\CompanyData\\note.txt");
    expect(calledUrls).toHaveLength(1);
    expect(calledUrls[0]).not.toContain("127.0.0.1:8000");
    localStorage.removeItem("nanvi_custom_server_url");
  });

  it("supports both desktop Method 1 (Explorer) and Method 2 (Manual Path) directly on-device with zero DB upload", async () => {
    const encoder = new TextEncoder();
    const readFileBytesMock = vi.fn().mockImplementation(async (p: string) => {
      if (p.endsWith("training_matrix.txt")) return encoder.encode("Training Matrix Q4 certified");
      return null;
    });
    const listFolderFilesMock = vi.fn().mockResolvedValue([
      {
        absPath: "C:\\CompanyData\\training_matrix.txt",
        relativePath: "training_matrix.txt",
        name: "training_matrix.txt",
        size: 28,
        lastModified: 1700000000000,
      },
    ]);
    const approveAndListMock = vi.fn().mockResolvedValue({
      ok: true,
      folderPath: "C:\\CompanyData",
      entries: [
        {
          absPath: "C:\\CompanyData\\training_matrix.txt",
          relativePath: "training_matrix.txt",
          name: "training_matrix.txt",
          size: 28,
          lastModified: 1700000000000,
        },
      ],
    });

    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      isDesktop: true,
      platform: "win32",
      selectFolder: vi.fn().mockResolvedValue("C:\\CompanyData"),
      listFolderFiles: listFolderFilesMock,
      approveAndListFolderFiles: approveAndListMock,
      readFileBytes: readFileBytesMock,
      showNotification: vi.fn(),
      openExternal: vi.fn(),
      onAccountBlocked: vi.fn(),
    };

    const mockApi = {
      getLocalAgentStatus: vi.fn().mockResolvedValue({
        is_online: false,
        connected_folders: [],
        total_files: 0,
        total_chunks: 0,
      }),
      addLocalFolder: vi.fn().mockResolvedValue({
        status: "ok",
        folder_path: "C:\\CompanyData",
        indexed_locally: false,
        message: "Saved path reference 'C:\\CompanyData'.",
      }),
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-desktop" }),
      syncLocalFolderWithPairingToken: vi.fn(),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn(),
      removeLocalFolder: vi.fn().mockResolvedValue({ status: "ok", message: "removed" }),
    };

    const user = userEvent.setup();
    render(createElement(CompanyFolderPicker, { api: mockApi as any }));

    // Confirm legacy .bat UI option is absent
    expect(screen.queryByText(/Nanvi_Assistant\.bat/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Method 3/i)).not.toBeInTheDocument();

    // Method 1: Click Explorer browse when cloud backend has indexed_locally=false -> Zero DB upload!
    const browseBtn = await screen.findByRole("button", { name: /Open Windows Explorer & Select Folder/i });
    await user.click(browseBtn);
    await waitFor(() => {
      expect(getDesktopLocalStatus()?.connected_folders[0]?.folder_path).toBe("C:\\CompanyData");
    });
    expect(mockApi.syncLocalFolderWithPairingToken).not.toHaveBeenCalled();

    // Local search builds transient query payload with real Windows paths (0 DB upload)
    const localCtx = await queryDesktopLocalContext("Training Matrix");
    expect(localCtx?.files[0].path).toBe("C:\\CompanyData\\training_matrix.txt");
    expect(localCtx?.chunks[0].text).toContain("Training Matrix Q4 certified");

    // Natural language search query with "find the file that contain" correctly strips filler and matches
    const localCtxPhrase = await queryDesktopLocalContext("find the file that contain Training Matrix");
    expect(localCtxPhrase?.files[0].path).toBe("C:\\CompanyData\\training_matrix.txt");
    expect(localCtxPhrase?.chunks[0].text).toContain("Training Matrix Q4 certified");

    // Electron readBrowserLocalFile reads directly from disk too
    const localFile = await readBrowserLocalFile("C:\\CompanyData\\training_matrix.txt");
    expect(localFile?.name).toBe("training_matrix.txt");

    // Method 2: Manual path input triggers approveAndListFolderFiles cleanly with zero cloud sync
    const method2Tab = screen.getByRole("button", { name: /Method 2: Manual Path Input/i });
    await user.click(method2Tab);
    const input = screen.getByPlaceholderText(/Paste or type path/i);
    await user.clear(input);
    await user.type(input, "C:\\CompanyData");
    const connectBtn = screen.getByRole("button", { name: /\+ Connect Folder Path/i });
    await user.click(connectBtn);

    await waitFor(() => {
      expect(approveAndListMock).toHaveBeenCalledWith("C:\\CompanyData");
    });
    expect(mockApi.syncLocalFolderWithPairingToken).not.toHaveBeenCalled();
    expect(await screen.findByText(/CONNECTED & ACTIVE/i)).toBeInTheDocument();
  });

  it("keeps Firefox/Safari webkitdirectory picker alive across window focus confirmation delay", async () => {
    const origDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "webkitdirectory");
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
      configurable: true,
      get() {
        return true;
      },
      set() { },
    });

    let createdInput: HTMLInputElement | null = null;
    const origAppend = document.body.appendChild.bind(document.body);
    const appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation((node: any) => {
      if (node && node.tagName === "INPUT") {
        createdInput = node as HTMLInputElement;
        vi.spyOn(createdInput, "click").mockImplementation(() => { });
      }
      return origAppend(node);
    });

    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-ff" }),
      getLocalAgentStatus: vi.fn().mockResolvedValue({ is_online: false, connected_folders: [], total_files: 0, total_chunks: 0 }),
      syncLocalFolderWithPairingToken: vi.fn().mockResolvedValue({ status: "ok", folder_id: "browser://FFDocs", chunks_synced: 1, files_synced: 1 }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    try {
      const promise = pickAndSyncBrowserFolder(mockApi as any);
      expect(createdInput).not.toBeNull();

      // Simulate Firefox returning focus to the page while waiting on the native "Upload X files?" confirmation prompt (>600ms)
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 700));

      const f1 = {
        name: "ff_doc.txt",
        type: "text/plain",
        size: 26,
        lastModified: 1700002000000,
        webkitRelativePath: "FFDocs/ff_doc.txt",
        text: async () => "Firefox folder sync works!",
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as File;

      Object.defineProperty(createdInput!, "files", {
        configurable: true,
        value: [f1],
      });
      createdInput!.dispatchEvent(new Event("change"));

      const result = await promise;
      expect(result?.folderName).toBe("FFDocs");
      expect(result?.fileCount).toBe(1);
    } finally {
      appendSpy.mockRestore();
      if (origDesc) {
        Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", origDesc);
      } else {
        delete (HTMLInputElement.prototype as any).webkitdirectory;
      }
    }
  });

  it("supports iOS/iPadOS Safari file-picker fallback and manual cancel for older Safari", async () => {
    const origDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "webkitdirectory");
    // Simulate iPhone/iPad Safari where webkitdirectory is unavailable on HTMLInputElement
    delete (HTMLInputElement.prototype as any).webkitdirectory;
    expect(getBrowserFolderMode()).toBe("file-picker");

    let createdInput: HTMLInputElement | null = null;
    const origAppend = document.body.appendChild.bind(document.body);
    const appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation((node: any) => {
      if (node && node.tagName === "INPUT") {
        createdInput = node as HTMLInputElement;
        vi.spyOn(createdInput, "click").mockImplementation(() => { });
      }
      return origAppend(node);
    });

    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-safari" }),
      getLocalAgentStatus: vi.fn().mockResolvedValue({ is_online: false, connected_folders: [], total_files: 0, total_chunks: 0 }),
      syncLocalFolderWithPairingToken: vi.fn().mockResolvedValue({ status: "ok", folder_id: "browser://Local Folder", chunks_synced: 1, files_synced: 1 }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    try {
      // 1. Multi-file pick works without webkitRelativePath on iOS/iPadOS Safari
      const p1 = pickAndSyncBrowserFolder(mockApi as any);
      expect(createdInput).not.toBeNull();
      expect(createdInput!.multiple).toBe(true);
      expect(createdInput!.hasAttribute("webkitdirectory")).toBe(false);

      const f1 = {
        name: "ios_notes.txt",
        type: "text/plain",
        size: 25,
        lastModified: 1700003000000,
        text: async () => "iPad Safari file selection.",
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as File;
      Object.defineProperty(createdInput!, "files", { configurable: true, value: [f1] });
      createdInput!.dispatchEvent(new Event("change"));
      const r1 = await p1;
      expect(r1?.fileCount).toBe(1);

      // 2. Manual cancel resolves null cleanly on older Safari lacking the cancel event
      createdInput = null;
      const p2 = pickAndSyncBrowserFolder(mockApi as any);
      expect(createdInput).not.toBeNull();
      cancelPendingBrowserFolderPicker();
      expect(await p2).toBeNull();
    } finally {
      appendSpy.mockRestore();
      if (origDesc) {
        Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", origDesc);
      }
    }
  });

  it("scales chunk caps, splits 2,000+ file metadata catalogs cleanly, and skips re-upload when backend caps at 12,000 chunks", async () => {
    const longContent = "Enterprise project specification clause line. ".repeat(120); // ~5,400 chars
    const children: FakeFileNode[] = [];
    for (let i = 0; i < 1600; i++) {
      children.push(makeFakeFileHandle(`doc_${i}.txt`, longContent));
    }
    const dirHandle = makeFakeDirHandle("HugeEnterpriseRepo", children);
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

    let backendFileCount = 0;
    let backendTotalChunks = 0;
    const syncPayloads: any[] = [];
    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-huge" }),
      getLocalAgentStatus: vi.fn().mockImplementation(async () => ({
        is_online: backendFileCount > 0,
        connected_folders: backendFileCount
          ? [{ folder_id: "browser://HugeEnterpriseRepo", display_name: "HugeEnterpriseRepo", file_count: backendFileCount }]
          : [],
        total_files: backendFileCount,
        total_chunks: backendTotalChunks,
      })),
      syncLocalFolderWithPairingToken: vi.fn().mockImplementation(async (_tok, payload) => {
        syncPayloads.push(payload);
        if (payload.replace_all) {
          backendFileCount = payload.files.length;
          backendTotalChunks = payload.chunks.length;
        } else {
          if (payload.files.length > 0) backendFileCount += payload.files.length;
          backendTotalChunks = Math.min(12000, backendTotalChunks + payload.chunks.length);
        }
        return { status: "ok", folder_id: payload.folder_id, chunks_synced: payload.chunks.length, files_synced: payload.files.length };
      }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    const { syncBrowserDirectory } = await import("./browserFolderSync");

    // Initial sync: 1600 files -> split metadata batches (1500 + 100) AND adaptive chunk cap (8 chunks/file)
    const first = await syncBrowserDirectory(mockApi as any, dirHandle as any);
    expect(first.fileCount).toBe(1600);
    expect(syncPayloads[0].replace_all).toBe(true);
    expect(syncPayloads[0].files).toHaveLength(1500);
    expect(syncPayloads[1].replace_all).toBe(false);
    expect(syncPayloads[1].files).toHaveLength(100);
    expect(first.chunkCount).toBeLessThanOrEqual(1600 * 8);

    // Simulate backend cap at 12,000 (even if >12000 were extracted) or matching uploaded count -> skip upload on reconnect
    syncPayloads.length = 0;
    const reconnect = await syncBrowserDirectory(mockApi as any, dirHandle as any, undefined, { skipIfBackendMatches: true });
    expect(reconnect.reusedCachedCount).toBe(1600);
    expect(syncPayloads).toHaveLength(0);
  });

  it("connects folder instantaneously via UI while streaming file contents quietly in background waves", async () => {
    const children: FakeFileNode[] = [];
    for (let i = 0; i < 25; i++) {
      children.push(makeFakeFileHandle(`report_${i}.csv`, `Id,Value\nR-${i},${i * 10}`));
    }
    const dirHandle = makeFakeDirHandle("InstantBridgeRepo", children);
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

    const syncPayloads: any[] = [];
    let backendFiles = 0;
    let backendChunks = 0;
    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-instant" }),
      getLocalAgentStatus: vi.fn().mockImplementation(async () => ({
        is_online: backendFiles > 0,
        connected_folders: backendFiles
          ? [
            {
              folder_id: "browser://InstantBridgeRepo",
              folder_path: "InstantBridgeRepo",
              display_name: "InstantBridgeRepo",
              file_count: backendFiles,
              chunk_count: backendChunks,
              status: "synced",
            },
          ]
          : [],
        total_files: backendFiles,
        total_chunks: backendChunks,
      })),
      syncLocalFolderWithPairingToken: vi.fn().mockImplementation(async (_tok, payload) => {
        syncPayloads.push(payload);
        if (payload.replace_all) {
          backendFiles = payload.files.length;
          backendChunks = payload.chunks.length;
        } else {
          backendChunks += payload.chunks.length;
        }
        return { status: "ok", folder_id: payload.folder_id, chunks_synced: payload.chunks.length, files_synced: payload.files.length };
      }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    const user = userEvent.setup();
    render(createElement(CompanyFolderPicker, { api: mockApi as any }));

    const connectBtn = await screen.findByRole("button", { name: /^Connect Local Folder$/i });
    await user.click(connectBtn);

    const dropzone = await screen.findByTestId("nanvi-folder-dropzone");
    const rootEntry = {
      isFile: false,
      isDirectory: true,
      name: "InstantBridgeRepo",
      createReader: () => {
        let done = false;
        return {
          readEntries: (cb: (entries: any[]) => void) => {
            if (!done) {
              done = true;
              cb(
                Array.from({ length: 25 }, (_, i) => ({
                  isFile: true,
                  isDirectory: false,
                  name: `report_${i}.csv`,
                  file: (fCb: (f: File) => void) =>
                    fCb({
                      name: `report_${i}.csv`,
                      type: "text/csv",
                      size: 32,
                      lastModified: 1700007000000 + i,
                      text: async () => `Id,Value\nR-${i},${i * 10}`,
                      arrayBuffer: async () => new TextEncoder().encode(`Id,Value\nR-${i},${i * 10}`).buffer,
                    } as unknown as File),
                })),
              );
            } else {
              cb([]);
            }
          },
        };
      },
    };
    fireEvent.drop(dropzone, {
      dataTransfer: {
        items: [{ kind: "file", webkitGetAsEntry: () => rootEntry }],
        files: [],
      },
    });

    await user.click(await screen.findByRole("button", { name: /^Connect Folder$/i }));

    // Must immediately show Connected & never show blocking Reading/Syncing progress bars
    expect(await screen.findByText(/Connected 'InstantBridgeRepo' \(25 files\) — Ready to search/i)).toBeInTheDocument();
    expect(screen.queryByText(/Reading \(/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Syncing batch/i)).not.toBeInTheDocument();
    expect(syncPayloads[0].replace_all).toBe(true);
    expect(syncPayloads[0].files).toHaveLength(25);

    // Wait for silent background extraction + micro-batch streaming to finish
    await waitForBackgroundFolderSync();
    expect(backendChunks).toBe(25);
  });

  it("renders desktop Settings immediately without agent spinner and queries local folder on demand with zero uploads", async () => {
    const connectFolderFastMock = vi.fn().mockImplementation(async (p: string) => ({
      ok: true,
      folderPath: p.includes("Documents") ? "C:\\Users\\Arjun\\Documents" : p,
      fileCount: 636,
    }));
    const searchDesktopFolderMock = vi.fn().mockResolvedValue({
      folder_path: "C:\\CompanyData",
      files: [
        {
          name: "weekly_progress.csv",
          path: "C:\\CompanyData\\Projects\\weekly_progress.csv",
          full_path: "C:\\CompanyData\\Projects\\weekly_progress.csv",
          display_path: "C:\\CompanyData\\Projects\\weekly_progress.csv",
          type: "csv",
          open_url: "C:\\CompanyData\\Projects\\weekly_progress.csv",
          source: "local",
          content_snippet: "W35,PRJ-CFL-002,49,51,-2",
        },
      ],
      chunks: [
        {
          chunk_id: "disk-0-0",
          folder_path: "C:\\CompanyData",
          relative_path: "Projects/weekly_progress.csv",
          filename: "weekly_progress.csv",
          citation: "C:\\CompanyData\\Projects\\weekly_progress.csv",
          text: "Week,Project,Physical %,Planned %,Variance\nW35,PRJ-CFL-002,49,51,-2",
        },
      ],
    });

    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      isDesktop: true,
      platform: "win32",
      selectFolder: vi.fn().mockResolvedValue("C:\\CompanyData"),
      connectFolderFast: connectFolderFastMock,
      searchDesktopFolder: searchDesktopFolderMock,
      revokeApprovedFolder: vi.fn().mockResolvedValue(true),
      showNotification: vi.fn(),
      openExternal: vi.fn(),
      onAccountBlocked: vi.fn(),
    };

    // Never resolves -> simulates slow/offline agent HTTP call; Desktop must still render immediately!
    const hangingApi = {
      getLocalAgentStatus: vi.fn().mockImplementation(() => new Promise(() => { })),
      addLocalFolder: vi.fn(),
      syncLocalFolderWithPairingToken: vi.fn(),
    };

    const user = userEvent.setup();
    render(createElement(CompanyFolderPicker, { api: hangingApi as any }));

    // Must render tabs immediately without "Connecting to company folder agent..." spinner
    expect(screen.queryByText(/Connecting to company folder agent/i)).not.toBeInTheDocument();
    const method2Tab = screen.getByRole("button", { name: /Method 2: Manual Path Input/i });

    // Method 2 Manual Path works immediately without touching addLocalFolder or uploading anything
    await user.click(method2Tab);
    const input = screen.getByPlaceholderText(/Paste or type path/i);
    await user.type(input, "C:\\CompanyData");
    await user.click(screen.getByRole("button", { name: /\+ Connect Folder Path/i }));

    expect(await screen.findByText(/CONNECTED & ACTIVE/i)).toBeInTheDocument();
    expect(connectFolderFastMock).toHaveBeenCalledWith("C:\\CompanyData");
    expect(hangingApi.addLocalFolder).not.toHaveBeenCalled();
    expect(hangingApi.syncLocalFolderWithPairingToken).not.toHaveBeenCalled();

    // Live on-demand local disk search runs when user asks a query
    const ctx = await queryDesktopLocalContext("PRJ-CFL-002");
    expect(searchDesktopFolderMock).toHaveBeenCalledWith(
      "C:\\CompanyData",
      "PRJ-CFL-002",
      8,
      10,
      expect.objectContaining({ role: "Superior" })
    );
    expect(ctx?.chunks[0].text).toContain("PRJ-CFL-002");
    expect(ctx?.files[0].path).toBe("C:\\CompanyData\\Projects\\weekly_progress.csv");

    // Email queries must NOT search the local desktop folder
    const emailCtx = await queryDesktopLocalContext("check my recent email and update me");
    expect(emailCtx).toBeNull();
    setActiveFolderStorageScope(null);
  });

  it("isolates folder state, real-path cache, and handle auto-restore across user accounts in the same browser", async () => {
    setActiveFolderStorageScope("enterprise-tenant::user-alice");

    // Alice connects a desktop folder & real path hint
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      isDesktop: true,
      platform: "win32",
    };
    connectDesktopFolderDirect("C:\\AliceDocs", 12);
    setBrowserFolderRealPath("AliceDocs", "C:\\AliceDocs");
    expect(getDesktopLocalStatus()?.connected_folders[0].folder_path).toBe("C:\\AliceDocs");
    expect(getBrowserFolderRealPath("AliceDocs")).toBe("C:\\AliceDocs");

    // Switching to Bob in the same browser must isolate Alice's state completely
    setActiveFolderStorageScope("enterprise-tenant::user-bob");
    expect(getDesktopLocalStatus()).toBeNull();
    expect(getBrowserFolderRealPath("AliceDocs")).toBe("");
    expect(await getLastCachedFolderName()).toBeNull();

    // Auto-restore in browser mode must not resurrect Alice's folder for Bob
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const mockHandle = {
      name: "AliceBrowserFolder",
      kind: "directory",
      queryPermission: vi.fn().mockResolvedValue("granted"),
      values: async function* () { },
    };
    const {
      saveBrowserDirectoryHandle,
      getSavedBrowserHandleInfo,
      autoRestoreBrowserFolderIfGranted,
    } = await import("./browserFolderSync");
    setActiveFolderStorageScope("enterprise-tenant::user-alice");
    await saveBrowserDirectoryHandle(
      mockHandle as unknown as Parameters<typeof saveBrowserDirectoryHandle>[0],
    );
    expect((await getSavedBrowserHandleInfo())?.name).toBe("AliceBrowserFolder");

    setActiveFolderStorageScope("enterprise-tenant::user-bob");
    expect(await getSavedBrowserHandleInfo()).toBeNull();
    const bobSyncApi = { syncLocalFolderWithPairingToken: vi.fn() };
    expect(
      await autoRestoreBrowserFolderIfGranted(
        bobSyncApi as unknown as Parameters<typeof autoRestoreBrowserFolderIfGranted>[0],
      ),
    ).toBeNull();
    expect(bobSyncApi.syncLocalFolderWithPairingToken).not.toHaveBeenCalled();

    // Alice's scope still retains her own state independently
    setActiveFolderStorageScope("enterprise-tenant::user-alice");
    expect(getBrowserFolderRealPath("AliceDocs")).toBe("C:\\AliceDocs");
    await clearDesktopLocalFolder();
    setActiveFolderStorageScope(null);
  });

  it("supports stacking multiple browser folders and removing them selectively over 10 iterations", async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const {
      saveBrowserDirectoryHandle,
      getAllSavedBrowserHandles,
      clearSavedBrowserDirectoryHandle,
      syncBrowserDirectory,
      setActiveFolderStorageScope,
    } = await import("./browserFolderSync");

    setActiveFolderStorageScope("test-stacking-scope");

    for (let iter = 1; iter <= 10; iter++) {
      const handle1 = {
        name: `Folder_Alpha_${iter}`,
        kind: "directory" as const,
        queryPermission: vi.fn().mockResolvedValue("granted"),
        values: async function* () {
          yield {
            name: `alpha_${iter}.txt`,
            kind: "file" as const,
            getFile: async () =>
              new File([`Alpha text content iter ${iter}`], `alpha_${iter}.txt`, {
                type: "text/plain",
                lastModified: 100000 + iter,
              }),
          };
        },
      };

      const handle2 = {
        name: `Folder_Beta_${iter}`,
        kind: "directory" as const,
        queryPermission: vi.fn().mockResolvedValue("granted"),
        values: async function* () {
          yield {
            name: `beta_${iter}.txt`,
            kind: "file" as const,
            getFile: async () =>
              new File([`Beta text content iter ${iter}`], `beta_${iter}.txt`, {
                type: "text/plain",
                lastModified: 200000 + iter,
              }),
          };
        },
      };

      const handle3 = {
        name: `Folder_Gamma_${iter}`,
        kind: "directory" as const,
        queryPermission: vi.fn().mockResolvedValue("granted"),
        values: async function* () {
          yield {
            name: `gamma_${iter}.txt`,
            kind: "file" as const,
            getFile: async () =>
              new File([`Gamma text content iter ${iter}`], `gamma_${iter}.txt`, {
                type: "text/plain",
                lastModified: 300000 + iter,
              }),
          };
        },
      };

      const syncCalls: any[] = [];
      const mockApi = {
        getLocalAgentToken: vi.fn().mockResolvedValue({ token: `tok-${iter}` }),
        getLocalAgentStatus: vi.fn().mockResolvedValue({ is_online: true, connected_folders: [] }),
        syncLocalFolderWithPairingToken: vi.fn().mockImplementation(async (tok, payload) => {
          syncCalls.push(payload);
          return { status: "ok" };
        }),
        sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
      };

      // 1. Sync Folder 1
      const res1 = await syncBrowserDirectory(mockApi as any, handle1 as any);
      expect(res1.folderName).toBe(`Folder_Alpha_${iter}`);
      expect(res1.chunkCount).toBeGreaterThan(0);

      // 2. Sync Folder 2 (must stack)
      const res2 = await syncBrowserDirectory(mockApi as any, handle2 as any);
      expect(res2.folderName).toBe(`Folder_Beta_${iter}`);
      expect(res2.chunkCount).toBeGreaterThan(0);

      // 3. Sync Folder 3 (must stack)
      const res3 = await syncBrowserDirectory(mockApi as any, handle3 as any);
      expect(res3.folderName).toBe(`Folder_Gamma_${iter}`);
      expect(res3.chunkCount).toBeGreaterThan(0);

      // Verify all 3 handles are saved
      const saved = await getAllSavedBrowserHandles();
      const savedNames = saved.map((s) => s.name);
      expect(savedNames).toContain(`Folder_Alpha_${iter}`);
      expect(savedNames).toContain(`Folder_Beta_${iter}`);
      expect(savedNames).toContain(`Folder_Gamma_${iter}`);

      // 4. Remove Folder 2 selectively -> Folder 1 and 3 must remain
      await clearSavedBrowserDirectoryHandle(`Folder_Beta_${iter}`);
      const remainingAfterBeta = await getAllSavedBrowserHandles();
      const remNames = remainingAfterBeta.map((s) => s.name);
      expect(remNames).toContain(`Folder_Alpha_${iter}`);
      expect(remNames).toContain(`Folder_Gamma_${iter}`);
      expect(remNames).not.toContain(`Folder_Beta_${iter}`);

      // 5. Clean up 1 and 3
      await clearSavedBrowserDirectoryHandle(`Folder_Alpha_${iter}`);
      await clearSavedBrowserDirectoryHandle(`Folder_Gamma_${iter}`);
      const empty = await getAllSavedBrowserHandles();
      expect(empty.length).toBe(0);
    }

    setActiveFolderStorageScope(null);
  });

  it("allows connecting and stacking multiple folders in Firefox and Safari with webkitdirectory", async () => {
    const origDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "webkitdirectory");
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
      configurable: true,
      get() {
        return true;
      },
      set() { },
    });

    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-webkit-multi" }),
      getLocalAgentStatus: vi.fn().mockResolvedValue({ is_online: false, connected_folders: [], total_files: 0, total_chunks: 0 }),
      syncLocalFolderWithPairingToken: vi.fn().mockResolvedValue({ status: "ok", chunks_synced: 1, files_synced: 1 }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
      removeLocalFolder: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    try {
      setActiveFolderStorageScope("user_firefox_safari_test");

      const fileA = {
        name: "customers.csv",
        type: "text/csv",
        size: 30,
        lastModified: 1700001000000,
        webkitRelativePath: "05_Customers_CSV/customers.csv",
        text: async () => "id,name\n1,Acme",
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as File;

      const fileB = {
        name: "finance_summary.csv",
        type: "text/csv",
        size: 35,
        lastModified: 1700002000000,
        webkitRelativePath: "Finance/finance_summary.csv",
        text: async () => "id,total\n1,5000",
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as File;

      // 1. Sync Folder 1 in webkitdirectory mode
      const res1 = await syncWebkitFileList(mockApi as any, [fileA]);
      expect(res1?.folderName).toBe("05_Customers_CSV");
      expect(res1?.fileCount).toBe(1);

      // 2. Sync Folder 2 in webkitdirectory mode (must stack, not wipe Folder 1)
      const res2 = await syncWebkitFileList(mockApi as any, [fileB]);
      expect(res2?.folderName).toBe("Finance");
      expect(res2?.fileCount).toBe(1);

      // 3. Both folders must be present in cached folder names
      const cachedNames = await getAllCachedFolderNames();
      expect(cachedNames).toContain("05_Customers_CSV");
      expect(cachedNames).toContain("Finance");

      // 4. Files from both folders must be retrievable in session
      const readA = await readBrowserLocalFile("05_Customers_CSV/customers.csv", "05_Customers_CSV");
      const readB = await readBrowserLocalFile("Finance/finance_summary.csv", "Finance");
      expect(readA).not.toBeNull();
      expect(readB).not.toBeNull();

      // 5. Remove Folder 1 -> Folder 2 must remain intact
      await clearSavedBrowserDirectoryHandle("05_Customers_CSV");
      const cachedAfterRemove = await getAllCachedFolderNames();
      expect(cachedAfterRemove).not.toContain("05_Customers_CSV");
      expect(cachedAfterRemove).toContain("Finance");

      // Clean up Folder 2
      await clearSavedBrowserDirectoryHandle("Finance");
      setActiveFolderStorageScope(null);
    } finally {
      if (origDesc) {
        Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", origDesc);
      } else {
        delete (HTMLInputElement.prototype as any).webkitdirectory;
      }
    }
  });

  it("renders '+ Connect Another Folder' button when folder is connected in Firefox/Safari", async () => {
    const origDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "webkitdirectory");
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
      configurable: true,
      get() {
        return true;
      },
      set() { },
    });

    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "test-token" }),
      getLocalAgentStatus: vi.fn().mockResolvedValue({
        is_online: true,
        connected_folders: [
          {
            folder_id: "browser://05_Customers_CSV",
            folder_path: "05_Customers_CSV",
            display_name: "05_Customers_CSV",
            file_count: 10,
            chunk_count: 40,
            status: "synced",
          },
        ],
        total_files: 10,
        total_chunks: 40,
      }),
      removeLocalFolder: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    try {
      render(createElement(CompanyFolderPicker, { api: mockApi as any }));

      // Button must show '+ Connect Another Folder' and NEVER 'Re-Select Folder to Scan New Files...'
      const button = await screen.findByRole("button", { name: /\+ Connect Another Folder/i });
      expect(button).toBeInTheDocument();
      expect(screen.queryByText(/Re-Select Folder to Scan New Files/i)).not.toBeInTheDocument();
    } finally {
      if (origDesc) {
        Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", origDesc);
      } else {
        delete (HTMLInputElement.prototype as any).webkitdirectory;
      }
    }
  });

  it("extracts OCR text via stateless backend for standalone images and hybrid/scanned PDFs with embedded images", async () => {
    const extractMock = vi.fn().mockResolvedValue({
      filename: "scan.png",
      text: "[Image OCR]\nINVOICE INV-883 Vendor: Nimbus Cloud",
    });
    const fakeApi = { extractLocalDocumentText: extractMock } as any;

    const imgBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const imgFile = {
      name: "receipt.png",
      size: imgBytes.length,
      arrayBuffer: async () => imgBytes.buffer,
    } as unknown as File;
    const imgText = await extractTextFromBrowserFile(imgFile, fakeApi);
    expect(imgText).toContain("INV-883");
    expect(extractMock).toHaveBeenCalledTimes(1);

    // PDF containing both selectable text (>40 chars) AND /Subtype /Image marker must also trigger backend OCR
    const hybridPdfRaw = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj << /Subtype /Image >> endobj\nstream\n(Quarterly Summary Document Header Line Exceeding Forty Characters Easily)\nendstream\n",
    );
    const pdfFile = {
      name: "hybrid.pdf",
      size: hybridPdfRaw.length,
      arrayBuffer: async () => hybridPdfRaw.buffer,
    } as unknown as File;
    extractMock.mockResolvedValueOnce({
      filename: "hybrid.pdf",
      text: "[Page 1]\nQuarterly Summary\n[Image OCR]\nEmbedded Receipt #991",
    });
    const pdfText = await extractTextFromBrowserFile(pdfFile, fakeApi);
    expect(pdfText).toContain("Embedded Receipt #991");
    expect(extractMock).toHaveBeenCalledTimes(2);
  });

  it("extracts dropped folders with >100 batched entries, filters ignored dirs, and syncs with zero browser upload prompt", async () => {
    const makeEntryFile = (name: string, content: string, sizeOverride?: number) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (cb: (f: File) => void) =>
        cb({
          name,
          type: "text/plain",
          size: sizeOverride ?? content.length,
          lastModified: 1700005000000,
          text: async () => content,
          arrayBuffer: async () => new TextEncoder().encode(content).buffer,
        } as unknown as File),
    });

    const batchedFiles = Array.from({ length: 105 }, (_, i) =>
      makeEntryFile(`cert_${i}.txt`, `Certificate document ${i}`),
    );
    const ignoredDir = {
      isFile: false,
      isDirectory: true,
      name: "node_modules",
      createReader: () => {
        throw new Error("Should not traverse ignored directory");
      },
    };
    const skippedExe = makeEntryFile("installer.exe", "MZ", 10);
    const subDir = {
      isFile: false,
      isDirectory: true,
      name: "2026",
      createReader: () => {
        let called = false;
        return {
          readEntries: (cb: (entries: any[]) => void) => {
            if (!called) {
              called = true;
              cb([makeEntryFile("iso_cert.md", "# ISO 27001 Certificate")]);
            } else {
              cb([]);
            }
          },
        };
      },
    };

    const rootDirEntry = {
      isFile: false,
      isDirectory: true,
      name: "certificate",
      createReader: () => {
        let step = 0;
        const allTop = [...batchedFiles, ignoredDir, skippedExe, subDir];
        return {
          readEntries: (cb: (entries: any[]) => void) => {
            // Simulate Chromium 100-entry batching
            if (step === 0) {
              step++;
              cb(allTop.slice(0, 100));
            } else if (step === 1) {
              step++;
              cb(allTop.slice(100));
            } else {
              cb([]);
            }
          },
        };
      },
    };

    const fakeDataTransfer = {
      items: [
        {
          kind: "file",
          webkitGetAsEntry: () => rootDirEntry,
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    const extracted = await extractDroppedFoldersFromDataTransfer(fakeDataTransfer);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].folderName).toBe("certificate");
    expect(extracted[0].supportedCount).toBe(106);
    expect(extracted[0].skippedCount).toBe(1);
    expect(extracted[0].files.some((f) => f.relativePath === "2026/iso_cert.md")).toBe(true);

    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-drop" }),
      getLocalAgentStatus: vi.fn().mockResolvedValue({ is_online: false, connected_folders: [] }),
      syncLocalFolderWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    setActiveFolderStorageScope("drop-unit-scope");
    const syncRes = await syncDroppedFolder(mockApi as any, extracted[0]);
    expect(syncRes?.folderName).toBe("certificate");
    expect(syncRes?.fileCount).toBe(106);
    expect(mockApi.syncLocalFolderWithPairingToken).toHaveBeenCalled();

    const cachedPreview = await getCachedFolderFilesPreview("certificate");
    expect(cachedPreview.some((m) => m.relative_path === "2026/iso_cert.md")).toBe(true);

    const localDoc = await readBrowserLocalFile("certificate/2026/iso_cert.md");
    expect(localDoc?.name).toBe("iso_cert.md");

    await clearSavedBrowserDirectoryHandle("certificate");
    setActiveFolderStorageScope(null);
  });

  it("shows Nanvi Drag & Drop modal, previews dropped files with confirmation prompt, and previews connected folders", async () => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;

    let connected = false;
    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-ui-drop" }),
      getLocalAgentStatus: vi.fn().mockImplementation(async () => ({
        is_online: connected,
        connected_folders: connected
          ? [
            {
              folder_id: "browser://certificate",
              folder_path: "certificate",
              display_name: "certificate",
              file_count: 1,
              chunk_count: 1,
              status: "synced",
            },
          ]
          : [],
        total_files: connected ? 1 : 0,
        total_chunks: connected ? 1 : 0,
      })),
      syncLocalFolderWithPairingToken: vi.fn().mockImplementation(async () => {
        connected = true;
        return { status: "ok", folder_id: "browser://certificate", chunks_synced: 1, files_synced: 1 };
      }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    setActiveFolderStorageScope("drop-ui-scope");
    const user = userEvent.setup();
    render(createElement(CompanyFolderPicker, { api: mockApi as any }));

    // 1. Clicking Connect Local Folder opens Nanvi's Drag & Drop popup (does NOT trigger webkitdirectory input)
    const connectBtn = await screen.findByRole("button", { name: /^Connect Local Folder$/i });
    await user.click(connectBtn);

    const dropzone = await screen.findByTestId("nanvi-folder-dropzone");
    expect(screen.getByText(/Please drag and drop your folder or files here/i)).toBeInTheDocument();
    expect(screen.queryByText(/No browser upload warning/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Browse with Browser Picker/i })).not.toBeInTheDocument();

    // 2. Dropping a folder switches modal to Nanvi file preview + "Would you like to connect..." confirmation
    const rootEntry = {
      isFile: false,
      isDirectory: true,
      name: "certificate",
      createReader: () => {
        let done = false;
        return {
          readEntries: (cb: (entries: any[]) => void) => {
            if (!done) {
              done = true;
              cb([
                {
                  isFile: true,
                  isDirectory: false,
                  name: "compliance_cert.txt",
                  file: (fCb: (f: File) => void) =>
                    fCb({
                      name: "compliance_cert.txt",
                      type: "text/plain",
                      size: 32,
                      lastModified: 1700006000000,
                      text: async () => "Verified enterprise certificate.",
                      arrayBuffer: async () => new ArrayBuffer(0),
                    } as unknown as File),
                },
              ]);
            } else {
              cb([]);
            }
          },
        };
      },
    };

    fireEvent.drop(dropzone, {
      dataTransfer: {
        items: [{ kind: "file", webkitGetAsEntry: () => rootEntry }],
        files: [],
      },
    });

    expect(
      await screen.findByText(/Would you like to connect "certificate" to Nanvi\?/i),
    ).toBeInTheDocument();
    expect(screen.getByText("compliance_cert.txt")).toBeInTheDocument();

    // 3. Clicking Connect Folder inside Nanvi modal connects and shows the Preview Files button
    await user.click(screen.getByRole("button", { name: /^Connect Folder$/i }));
    expect(await screen.findByText(/Connected 'certificate' \(1 files\) — Ready to search/i)).toBeInTheDocument();

    const previewBtn = await screen.findByRole("button", { name: /Preview Files/i });
    await user.click(previewBtn);
    expect(await screen.findByText(/Folder Preview — certificate/i)).toBeInTheDocument();
    expect(await screen.findByText("compliance_cert.txt")).toBeInTheDocument();

    await clearSavedBrowserDirectoryHandle("certificate");
    setActiveFolderStorageScope(null);
  });

  it("shows drag-and-drop notice when clicking inside Nanvi modal and drops loose documents without OS file dialog", async () => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;

    const mockApi = {
      getLocalAgentToken: vi.fn().mockResolvedValue({ token: "pair-files" }),
      getLocalAgentStatus: vi.fn().mockResolvedValue({
        is_online: false,
        connected_folders: [],
        total_files: 0,
        total_chunks: 0,
      }),
      syncLocalFolderWithPairingToken: vi.fn().mockResolvedValue({
        status: "ok",
        folder_id: "browser://Dropped Files",
        chunks_synced: 1,
        files_synced: 1,
      }),
      sendLocalAgentHeartbeatWithPairingToken: vi.fn().mockResolvedValue({ status: "ok" }),
    };

    setActiveFolderStorageScope("pure-drag-drop-scope");
    const user = userEvent.setup();
    render(createElement(CompanyFolderPicker, { api: mockApi as any }));

    // No OS file input or Select Files button on Method 1 card
    expect(screen.queryByTestId("nanvi-card-file-input")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Select Files/i })).not.toBeInTheDocument();

    // Clicking Connect Local Folder opens the Nanvi modal with pure drag-and-drop UI
    await user.click(screen.getByRole("button", { name: /^Connect Local Folder$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Please drag and drop your folder or files here/i),
    ).toBeInTheDocument();
    expect(within(dialog).queryByTestId("nanvi-normal-file-input")).not.toBeInTheDocument();

    // Clicking Drag & Drop Files shows the inline "Please drag and drop..." notice instead of an OS dialog
    await user.click(within(dialog).getByRole("button", { name: /Drag & Drop Files/i }));
    expect(
      await within(dialog).findByText(
        /Please drag and drop the folder or documents from Windows Explorer/i,
      ),
    ).toBeInTheDocument();

    // Dragging & dropping loose files works seamlessly
    const f1 = {
      name: "quarterly_report.txt",
      type: "text/plain",
      size: 32,
      lastModified: 1700009000000,
      text: async () => "Q4 Enterprise Summary Content",
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;

    fireEvent.drop(within(dialog).getByTestId("nanvi-folder-dropzone"), {
      dataTransfer: {
        items: [{ kind: "file", getAsFile: () => f1 }],
        files: [f1],
      },
    });

    expect(
      await within(dialog).findByText(/Would you like to connect "Dropped Files" to Nanvi\?/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("quarterly_report.txt")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /^Connect Folder$/i }));
    expect(
      await screen.findByText(/Connected 'Dropped Files' \(1 files\) — Ready to search/i),
    ).toBeInTheDocument();

    await clearSavedBrowserDirectoryHandle("Dropped Files");
    setActiveFolderStorageScope(null);
  });
});
