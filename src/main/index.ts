import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
  createAppConfigStore,
  createDynamicPiSessionStore,
  createHomeSettings,
  createLauncherLocator,
  createNodeProcessSpawner,
  createSetupService,
  readGitBranch,
} from "./adapters";
import { createLocalPiDevelopment } from "./adapters/localPiDevelopment";
import { boundedStop } from "./domain/lifecycle/boundedStop";
import { WorkspaceHostRegistry } from "./domain/session/WorkspaceHostRegistry";
import {
  WorkspaceHostRouter,
  registerHandlers,
  validateWorkspaceDirectory,
  type WorkspaceRegistryPort,
} from "./ipc/registerHandlers";

// `import.meta.dirname` directly (not a manually computed
// `path.dirname(fileURLToPath(import.meta.url))` `__dirname`), and under
// its own name instead of shadowing `__dirname`: electron-vite's built
// ESM output auto-injects its own top-level `const __dirname =
// import.meta.dirname;` "CommonJS shim" (for whatever dependency still
// expects `require`/`__dirname`), so a second same-named top-level
// declaration in this file collided with it — "Identifier '__dirname'
// has already been declared" — and crashed the packaged app on load
// (T6's Electron smoke check caught this; electron-vite dev never hits
// the built bundle, only `pnpm build`/`pnpm package` do).
const moduleDir = import.meta.dirname;

const STOP_ON_QUIT_TIMEOUT_MS = 4000;

// scripts/smoke-electron.mjs (T6) sets this to a throwaway temp dir before
// launching the real built app through Playwright, so the smoke run never
// reads or writes this developer's actual config.json under the real
// userData path. Must run before the first app.getPath("userData") call
// below (configStore's own path) — Electron only honors setPath for a
// given name before anything has already read it.
const smokeUserData = process.env.GENTLE_SHELL_SMOKE_USERDATA;
if (smokeUserData) app.setPath("userData", smokeUserData);

// Electron's own console, prefixed so pi's stderr output (diagnostics,
// warnings — not by itself evidence of a failure, see PiSession's
// handleStderrLine) is distinguishable from this app's own logging.
function logPiLine(line: string): void {
  process.stderr.write(`[pi] ${line}\n`);
}

// One launch/home contract drives child flags, session listing and setup.
// A managed supervisor fixes the home; legacy/source launchers retain the
// persisted first-run choice and resolveHomeArgs/homeDirFor defaults.
const configStore = createAppConfigStore(path.join(app.getPath("userData"), "config.json"));
const localDevelopment = process.env.GENTLE_SHELL_DESKTOP_LOCAL_PI === "1"
  ? createLocalPiDevelopment()
  : undefined;
const locator = localDevelopment?.locator ?? createLauncherLocator();
const homeSettings = localDevelopment?.homeSettings ?? createHomeSettings(configStore, process.env, locator);
const setupService = localDevelopment?.setupService ?? createSetupService(
  configStore, process.env, undefined,
  createHomeSettings(configStore, process.env, locator).managedHome,
);

// The SessionStore re-resolves the current home on every call (instead of
// once at startup) so it reflects a home choice made mid-session, exactly
// like homeSettings.homeArgs() above — see createDynamicPiSessionStore's
// doc comment.
//
// T5a: hosts are created through the WorkspaceHostRegistry instead of
// constructed directly, so the main process can hold more than one live
// workspace host (each with its own `gentle-shell --mode rpc` child). The
// registry mints the opaque host id. The deps factory runs once per host
// creation, so every host gets its own adapters and its own home-dependent
// session store — nothing is shared between hosts except this closure's own
// configuration reads.
//
// T5b: the window's IPC handlers no longer bind one host — they route
// through WorkspaceHostRouter by host identity. openChat/newChat mint or
// reuse hosts through the registry and answer the routed host's id; every
// other request (send, abort, dialog answer, helper stop) carries a host
// id and is delivered to that host's child only, with an unknown or
// stopped id rejected before any child is touched. The router is created
// once per app and shared across windows — hosts outlive windows.
const hostRegistry = new WorkspaceHostRegistry({
  createHostDeps: () => ({
    spawner: createNodeProcessSpawner(),
    locator,
    sessionStore: createDynamicPiSessionStore(homeSettings.homeDir),
    env: process.env,
    homeSettings,
    log: logPiLine,
  }),
});
// T1 (S1/S2): the persisted workspace registry over the app config — the
// same config.json that holds `home`. The port is wired into
// registerHandlers' ports object exactly like appInfo/windowControls/
// chooseFile, so the workspace.list/add/remove channels are backed by
// real persistence in this build (add persists most-recently-added first
// and deduplicated; remove deletes only the persisted entry).
const workspaceRegistry: WorkspaceRegistryPort = {
  list: () => configStore.listWorkspaces(),
  add: (directory) => configStore.addWorkspace(directory).workspaces ?? [],
  remove: (directory) => configStore.removeWorkspace(directory).workspaces ?? [],
};

// T11: the two workspace channels' main-side adapters, injected into the
// router so tests never open a real dialog nor touch the filesystem.
// chooseDirectory opens Electron's native directory picker
// (dialog.showOpenDialog, openDirectory) and answers the chosen absolute
// path — or null on a cancelled pick, which must change nothing;
// validateDirectory is the exists/is-a-directory/readable check that runs
// BEFORE workspace.create mints anything.
const hostRouter = new WorkspaceHostRouter(hostRegistry, {
  chooseDirectory: async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  },
  validateDirectory: validateWorkspaceDirectory,
});

// M1 T1 was just the window shell; T2 added the PiSession child process;
// T3 wires IPC handlers so the renderer can list/open/send for real; T5
// keeps registerHandlers' unsubscribe and calls it when this window
// closes, so a later window (macOS activate) can re-register cleanly, and
// adds the setup.status/chooseHome handlers for first-run.
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "gentle shell",
    backgroundColor: "#060407",
    show: false,
    // The app draws its own chrome (design/slack-gentle/01-workspace.html):
    // the top bar carries the window's minimize / maximize / close, so the
    // native frame is gone and the bar is the drag region (CSS
    // -webkit-app-region: drag). Resizing still works through the edges.
    frame: false,
    webPreferences: {
      preload: path.join(moduleDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The shell ports: the renderer never sees Electron, so everything the
  // chrome needs from this window is answered here. `chooseFile` opens the
  // native FILE picker; its null answer is a cancelled pick.
  const unregisterHandlers = registerHandlers(hostRouter, setupService, window.webContents, ipcMain, {
    appInfo: () => ({ version: app.getVersion() }),
    workspaces: workspaceRegistry,
    readWorkspaceBranch: readGitBranch,
    windowControls: {
      minimize: () => window.minimize(),
      toggleMaximize: () => {
        if (window.isMaximized()) {
          window.unmaximize();
          return false;
        }
        window.maximize();
        return true;
      },
      close: () => window.close(),
    },
    chooseFile: async () => {
      const picked = await dialog.showOpenDialog(window, { properties: ["openFile"] });
      return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]!;
    },
  });
  window.on("closed", unregisterHandlers);

  // Assistant replies now render Markdown links (Markdown.tsx forces
  // target="_blank" on every <a>), so a click reaches here instead of
  // navigating the app's own BrowserWindow. Only hand http(s) links to the
  // OS default browser; deny everything else (no new Electron windows, no
  // other schemes) since this window never needs to open one itself.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.once("ready-to-show", () => window.show());

  // No remote content: dev loads the Vite dev server on localhost, build
  // loads the bundled renderer files from disk.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(path.join(moduleDir, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Stops every registered host's child process cleanly instead of leaving
// any orphaned when the app quits (T5a: through the registry, so every
// workspace host is covered, including hosts created beyond the one the
// window is wired to), bounded to STOP_ON_QUIT_TIMEOUT_MS so a child that
// refuses to exit never hangs shutdown. `quitting` guards against the
// re-entrant app.quit() below re-triggering this handler in a loop
// (before-quit fires again for that quit() call too).
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void boundedStop(() => hostRegistry.stopAll(), STOP_ON_QUIT_TIMEOUT_MS).finally(() => app.quit());
});
